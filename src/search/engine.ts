import path from "node:path";
import { z } from "zod";
import { SearchSocketError } from "../errors";
import { loadConfig } from "../config/load";
import { resolveScope } from "../core/scope";
import { hrTimeMs } from "../utils/time";
import { normalizeUrlPath } from "../utils/path";
import { createUpstashStore } from "../vector/factory";
import { rankHits, rankPageHits, trimPagesByScoreGap } from "./ranking";
import type {
  PageHit,
  RankingOverrides,
  RelatedPage,
  RelatedPagesResult,
  ResolvedSearchSocketConfig,
  SearchRequest,
  SearchResponse,
  SearchResult,
  SiteStructureResult,
  SiteTreeNode,
  VectorHit
} from "../types";
import type { RetrievalConstraints } from "../vector/upstash";
import type { SearchStoreReader } from "../vector/store";
import { matchesPathPrefix, matchesTags, planRetrievalConstraints } from "../vector/upstash";
import { Logger } from "../core/logger";
import type { RankedHit, RankedPage } from "./ranking";
import { diceScore, compositeScore, dominantRelationshipType } from "./related-pages";
import { toSnippet, queryAwareExcerpt } from "../utils/text";
import { MAX_PATH_LENGTH, MAX_QUERY_LENGTH } from "./limits";
import { chunkDisplayText, pageSummaryChunkKey, stripEmbeddingPrefix } from "../indexing/chunker";
import { buildMetaFilterString, UnsafeFilterValueError } from "../utils/structured-meta";
import pLimit from "p-limit";

/**
 * How many of the top pages get their sections expanded. Beyond this a page is
 * still returned, just without sub-results — a search UI does not render
 * sections for the 40th hit.
 */
const SUBRESULT_PAGE_LIMIT = 10;

/** Simultaneous section lookups, so a large topK cannot burst the backend. */
const SUBRESULT_CONCURRENCY = 5;

/**
 * Candidate windows for the overfetch fallback, as multiples of the base
 * candidate count.
 *
 * Only reached when a path or tag constraint cannot be pushed into the backend
 * filter — a quote, backslash, or GLOB metacharacter in the value. Everything
 * else is one request, because the backend does the filtering.
 */
const FALLBACK_FETCH_STEPS = [1, 4, 16];

/** Hard ceiling on candidates for one query, however selective the filter. */
const MAX_CANDIDATE_FETCH = 500;

/**
 * Debug ranking overrides.
 *
 * Strict at every level: a request still sending a removed control such as
 * `search.pageSearchWeight` or `ranking.aggregationCap` must be told it no
 * longer exists rather than have it silently stripped, which is exactly how
 * those options went on being tuned after they stopped doing anything.
 */
const rankingOverridesSchema = z
  .object({
    ranking: z
      .object({
        enableIncomingLinkBoost: z.boolean().optional(),
        enableDepthBoost: z.boolean().optional(),
        enableFreshnessBoost: z.boolean().optional(),
        enableAnchorTextBoost: z.boolean().optional(),
        minScoreRatio: z.number().min(0).max(1).optional(),
        scoreGapThreshold: z.number().min(0).max(1).optional(),
        weights: z
          .object({
            incomingLinks: z.number().optional(),
            depth: z.number().optional(),
            titleMatch: z.number().optional(),
            freshness: z.number().optional(),
            anchorText: z.number().optional()
          })
          .strict()
          .optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .optional();

const requestSchema = z.object({
  q: z
    .string()
    .trim()
    .min(1)
    .max(MAX_QUERY_LENGTH, `Query must be at most ${MAX_QUERY_LENGTH} characters`),
  topK: z.number().int().positive().max(100).optional(),
  scope: z.string().optional(),
  pathPrefix: z.string().max(MAX_PATH_LENGTH).optional(),
  tags: z.array(z.string()).optional(),
  filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  groupBy: z.enum(["page", "chunk"]).optional(),
  maxSubResults: z.number().int().positive().max(20).optional(),
  debug: z.boolean().optional(),
  rankingOverrides: rankingOverridesSchema,
});

const MAX_SITE_STRUCTURE_PAGES = 2000;

/**
 * A result's `chunkText`: the indexed section text without the embedding
 * prefix, which describes the record to the embedder and is not part of the
 * section. The prefix is only removed when the index is configured to write
 * one — otherwise a body that opens with the page title would lose it. Unlike
 * the snippet, a page summary keeps its full text here.
 */
function storedBodyText(hit: VectorHit, config: ResolvedSearchSocketConfig): string {
  if (!config.chunking.prependTitle) return hit.metadata.chunkText;
  return stripEmbeddingPrefix(hit.metadata.chunkText, hit.metadata.title, hit.metadata.sectionTitle);
}

function makeNode(url: string, depth: number): SiteTreeNode {
  return { url, title: "", depth, routeFile: "", isIndexed: false, childCount: 0, children: [] };
}

export function buildTree(
  pages: Array<{ url: string; title: string; routeFile: string }>,
  pathPrefix?: string
): SiteTreeNode {
  const nodeMap = new Map<string, SiteTreeNode>();
  const root = makeNode("/", 0);
  nodeMap.set("/", root);

  // Ensure all intermediate nodes exist and set data for real pages
  for (const page of pages) {
    const normalized = normalizeUrlPath(page.url);
    const segments = normalized.split("/").filter(Boolean);

    if (segments.length === 0) {
      // Root page "/"
      root.title = page.title;
      root.routeFile = page.routeFile;
      root.isIndexed = true;
      continue;
    }

    // Ensure all intermediate nodes exist
    for (let i = 1; i <= segments.length; i++) {
      const partialUrl = "/" + segments.slice(0, i).join("/");
      if (!nodeMap.has(partialUrl)) {
        nodeMap.set(partialUrl, makeNode(partialUrl, i));
      }
    }

    // Set real page data on the leaf node
    const node = nodeMap.get(normalized)!;
    node.title = page.title;
    node.routeFile = page.routeFile;
    node.isIndexed = true;
  }

  // Wire parent-child relationships
  for (const [url, node] of nodeMap) {
    if (url === "/") continue;
    const segments = url.split("/").filter(Boolean);
    const parentUrl = segments.length === 1 ? "/" : "/" + segments.slice(0, -1).join("/");
    const parent = nodeMap.get(parentUrl) ?? root;
    parent.children.push(node);
  }

  // Sort children alphabetically and set childCount
  const sortAndCount = (node: SiteTreeNode): void => {
    node.children.sort((a, b) => a.url.localeCompare(b.url));
    node.childCount = node.children.length;
    for (const child of node.children) {
      sortAndCount(child);
    }
  };
  sortAndCount(root);

  // If pathPrefix is specified, return the subtree rooted at that path
  if (pathPrefix) {
    const normalizedPrefix = normalizeUrlPath(pathPrefix);
    const subtreeRoot = nodeMap.get(normalizedPrefix);
    if (subtreeRoot) {
      return subtreeRoot;
    }
    // If the prefix node doesn't exist, return an empty placeholder
    return makeNode(normalizedPrefix, normalizedPrefix.split("/").filter(Boolean).length);
  }

  return root;
}

function mergeRankingOverrides(
  base: ResolvedSearchSocketConfig,
  overrides: RankingOverrides
): ResolvedSearchSocketConfig {
  return {
    ...base,
    ranking: {
      ...base.ranking,
      ...overrides.ranking,
      weights: {
        ...base.ranking.weights,
        ...overrides.ranking?.weights,
      },
    },
  };
}

export interface SearchEngineOptions {
  cwd?: string;
  configPath?: string;
  config?: ResolvedSearchSocketConfig;
  store?: SearchStoreReader;
  /**
   * Sink for retrieval warnings. Defaults to a stderr-only logger: a truncated
   * retrieval is rare but must never pass unremarked, and stderr is the one
   * channel every host — CLI, SvelteKit handler, stdio MCP server — already
   * treats as its log.
   */
  logger?: Logger;
}

export class SearchEngine {
  private readonly cwd: string;
  private readonly config: ResolvedSearchSocketConfig;
  private readonly store: SearchStoreReader | null;
  private readonly logger: Logger;

  private constructor(options: {
    cwd: string;
    config: ResolvedSearchSocketConfig;
    store: SearchStoreReader | null;
    logger?: Logger;
  }) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.store = options.store;
    this.logger = options.logger ?? new Logger({ stderrOnly: true });
  }

  private requireStore(): SearchStoreReader {
    if (!this.store) {
      throw new SearchSocketError(
        "SEARCH_NOT_CONFIGURED",
        "Search is not configured. Set the required Upstash environment variables to enable search.",
        503
      );
    }
    return this.store;
  }

  isConfigured(): boolean {
    return this.store !== null;
  }

  static async create(options: SearchEngineOptions = {}): Promise<SearchEngine> {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const config = options.config ?? (await loadConfig({ cwd, configPath: options.configPath }));

    let store: SearchStoreReader | null;
    if (options.store !== undefined) {
      store = options.store;
    } else {
      try {
        store = await createUpstashStore(config);
      } catch (error) {
        if (error instanceof SearchSocketError && error.code === "VECTOR_BACKEND_UNAVAILABLE") {
          store = null;
        } else {
          throw error;
        }
      }
    }

    return new SearchEngine({
      cwd,
      config,
      store,
      logger: options.logger
    });
  }

  getConfig(): ResolvedSearchSocketConfig {
    return this.config;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success) {
      throw new SearchSocketError("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Invalid request", 400);
    }

    const input = parsed.data;
    const totalStart = process.hrtime.bigint();

    // Apply ranking overrides only when debug mode is enabled
    const effectiveConfig = (input.debug && input.rankingOverrides)
      ? mergeRankingOverrides(this.config, input.rankingOverrides)
      : this.config;

    const resolvedScope = resolveScope(this.config, input.scope, this.cwd);

    const topK = input.topK ?? 10;
    const maxSubResults = input.maxSubResults ?? 5;
    const groupByPage = (input.groupBy ?? "page") === "page";

    const queryText = input.q;

    // Path and tag constraints are pushed into the backend query wherever the
    // filter grammar can express them. Applying them only afterwards meant a
    // selective filter was starved by a globally-ranked candidate window: a
    // `/docs` query whose first 40 candidates were all blog pages returned
    // nothing, however good the `/docs` match ranked 41st was.
    //
    // `/docs` is a *segment* prefix: it selects `/docs` and everything under
    // it, and no longer `/docsmith`.
    const pathPrefix = input.pathPrefix ? normalizeUrlPath(input.pathPrefix) : undefined;
    const filterTags = input.tags && input.tags.length > 0 ? input.tags : undefined;
    const constraints: RetrievalConstraints = { pathPrefix, tags: filterTags };
    // False only when a value cannot be written as a filter literal or GLOB
    // pattern; then the local predicates below are the only enforcement and
    // recall depends on the bounded overfetch in `retrieveConstrained`.
    const constraintsPushedDown = planRetrievalConstraints(constraints).complete;

    // Build server-side Upstash filter for structured metadata.
    // Values containing a quote or backslash are rejected rather than escaped
    // (Upstash defines no escape sequence), and that must reach the caller as a
    // 400 rather than a 500.
    let metaFilterStr = "";
    if (input.filters && Object.keys(input.filters).length > 0) {
      try {
        metaFilterStr = buildMetaFilterString(input.filters);
      } catch (error) {
        if (error instanceof UnsafeFilterValueError) {
          throw new SearchSocketError("INVALID_REQUEST", error.message, 400);
        }
        throw error;
      }
    }
    const metaFilter = metaFilterStr || undefined;

    // Kept even when the same constraint was pushed down: it costs nothing, and
    // it is the only enforcement for a value the filter grammar cannot express.
    const applyPagePostFilters = (hits: PageHit[]): PageHit[] => {
      let filtered = hits;
      if (pathPrefix) {
        filtered = filtered.filter((h) => matchesPathPrefix(h.url, pathPrefix));
      }
      if (filterTags) {
        filtered = filtered.filter((h) => matchesTags(h.tags, filterTags));
      }
      return filtered;
    };

    /** Sub-results of a page that already matched, so only tags are re-checked. */
    const applyChunkTagFilters = (hits: VectorHit[]): VectorHit[] => {
      if (!filterTags) return hits;
      return hits.filter((h) => matchesTags(h.metadata.tags, filterTags));
    };

    const applyChunkPostFilters = (hits: VectorHit[]): VectorHit[] => {
      let filtered = applyChunkTagFilters(hits);
      if (pathPrefix) {
        filtered = filtered.filter((h) => matchesPathPrefix(h.metadata.url, pathPrefix));
      }
      return filtered;
    };

    const searchStart = process.hrtime.bigint();

    if (groupByPage) {
      // ── Page-first pipeline ──
      // 1. Search page vectors to get top pages ranked by similarity
      const pageLimit = Math.max(topK * 2, 20);

      const { items: filteredPages, boundReached, window } = await this.retrieveConstrained(
        pageLimit,
        topK,
        constraintsPushedDown,
        (limit) =>
          this.requireStore().searchPagesByText(
            queryText,
            { limit, filter: metaFilter, ...constraints },
            resolvedScope
          ),
        applyPagePostFilters
      );
      if (boundReached) this.warnPartialRetrieval(input.q, window);

      // 2. Rank pages with boosts (depth, incoming links, title match, page weights, etc.)
      let rankedPages = rankPageHits(filteredPages, effectiveConfig, input.q, input.debug);
      rankedPages = trimPagesByScoreGap(rankedPages, effectiveConfig);

      // Take top N pages
      const topPages = rankedPages.slice(0, topK);

      // 3. For each top page, find its best-matching sections.
      //
      // This is one backend request per page, so it is bounded twice: only the
      // first SUBRESULT_PAGE_LIMIT pages are expanded, and those requests run
      // through a concurrency limiter. Previously `topK: 100` fired 100
      // simultaneous requests, which is both a cost and a rate-limit hazard.
      const expandable = topPages.slice(0, SUBRESULT_PAGE_LIMIT);
      const limit = pLimit(SUBRESULT_CONCURRENCY);
      const expandedChunks = await Promise.all(
        expandable.map((page) =>
          limit(() =>
            this.requireStore()
              .searchChunksByUrl(
                queryText,
                page.url,
                { limit: maxSubResults, filter: metaFilter, tags: filterTags },
                resolvedScope
              )
              .then((chunks) => applyChunkTagFilters(chunks))
          )
        )
      );
      // Pages past the expansion limit still appear as results, just without
      // section sub-results.
      const allChunks = topPages.map((_, i) => expandedChunks[i] ?? []);

      // 4. Build results: pages with nested chunks for navigation
      const searchMs = hrTimeMs(searchStart);
      const results = this.buildPageFirstResults(topPages, allChunks, input.q, input.debug, maxSubResults);

      return {
        q: input.q,
        scope: resolvedScope.scopeName,
        results,
        meta: {
          timingsMs: {
            search: Math.round(searchMs),
            total: Math.round(hrTimeMs(totalStart))
          }
        }
      };
    } else {
      // ── Chunk-only mode (groupBy: "chunk") — legacy behavior ──
      const candidateK = Math.max(50, topK);

      const { items: filtered, boundReached, window } = await this.retrieveConstrained(
        candidateK,
        topK,
        constraintsPushedDown,
        (limit) =>
          this.requireStore().search(
            queryText,
            { limit, filter: metaFilter, ...constraints },
            resolvedScope
          ),
        applyChunkPostFilters
      );
      if (boundReached) this.warnPartialRetrieval(input.q, window);

      const ranked = rankHits(filtered, effectiveConfig, input.q, input.debug);
      const searchMs = hrTimeMs(searchStart);
      const results = this.buildResults(ranked, topK, input.q, input.debug, effectiveConfig);

      return {
        q: input.q,
        scope: resolvedScope.scopeName,
        results,
        meta: {
          timingsMs: {
            search: Math.round(searchMs),
            total: Math.round(hrTimeMs(totalStart))
          }
        }
      };
    }
  }

  /**
   * Fetch candidates for a constrained query, escalating the window only while
   * that can still help and only within a fixed work bound.
   *
   * One request when every constraint was pushed into the backend query, which
   * is the normal case. A constraint the filter grammar cannot express is
   * enforced locally instead, so the window is escalated to compensate — but
   * only through `FALLBACK_FETCH_STEPS`, and never past `MAX_CANDIDATE_FETCH`:
   * better recall must not cost an unbounded number of round trips.
   *
   * `boundReached` reports the one thing the backend lets us know for certain:
   * that retrieval stopped because it ran out of budget rather than out of
   * candidates. It is deliberately not a claim of completeness in the other
   * direction — a vector store may under-fill a selective query for its own
   * reasons — only the honest signal the audit asks for.
   */
  private async retrieveConstrained<T>(
    baseLimit: number,
    wanted: number,
    pushedDown: boolean,
    fetch: (limit: number) => Promise<T[]>,
    keep: (candidates: T[]) => T[]
  ): Promise<{ items: T[]; boundReached: boolean; window: number }> {
    let items: T[] = [];
    let limit = 0;

    for (const step of FALLBACK_FETCH_STEPS) {
      limit = Math.min(baseLimit * step, MAX_CANDIDATE_FETCH);
      const candidates = await fetch(limit);
      items = keep(candidates);

      // A short window means this query has no more candidates to give, so a
      // wider one would repeat the same work for the same answer.
      if (pushedDown || items.length >= wanted || candidates.length < limit) {
        return { items, boundReached: false, window: limit };
      }
      if (limit >= MAX_CANDIDATE_FETCH) break;
    }

    return { items, boundReached: true, window: limit };
  }

  /**
   * Report a retrieval that stopped at its work bound with the filter still
   * unsatisfied. Reported, never retried: the engine is serverless and must not
   * turn a selective filter into an open-ended scan.
   */
  private warnPartialRetrieval(query: string, window: number): void {
    this.logger.warn(
      `Search for ${JSON.stringify(query)} stopped at its candidate limit of ${window} ` +
        "with the requested path or tag filter still unsatisfied; results may be incomplete."
    );
  }

  private buildPageFirstResults(
    rankedPages: RankedPage[],
    allChunks: VectorHit[][],
    query?: string,
    debug?: boolean,
    maxSubResults: number = 5
  ): SearchResult[] {
    return rankedPages.flatMap((page, i) => {
      // A non-finite score is the sentinel `rankHits`/`rankPages` use for a hit
      // whose backend score or metadata could not be read as a number, and the
      // minScoreRatio filter cannot remove it: that filter is skipped entirely
      // when the top score is itself non-finite, so a run of malformed hits
      // passes through untouched. `JSON.stringify(-Infinity)` is `null`, which
      // the browser validators reject — one bad record would otherwise fail the
      // whole response rather than just itself.
      if (!Number.isFinite(page.finalScore)) return [];

      // Sub-result scores come straight off the backend hit rather than through
      // ranking, so they get the same finite check as the page score.
      const chunks = (allChunks[i] ?? []).filter((c) => Number.isFinite(c.score));

      // Best chunk is the first one (highest similarity to query within this page)
      const bestChunk = chunks[0];

      // Build snippet from best chunk, or fall back to page description
      const snippet = bestChunk
        ? this.excerptFor(bestChunk, query)
        : (page.description || page.title);

      const result: SearchResult = {
        url: page.url,
        title: page.title,
        sectionTitle: bestChunk?.metadata.sectionTitle || undefined,
        snippet,
        chunkText: bestChunk ? storedBodyText(bestChunk, this.config) || undefined : undefined,
        score: Number(page.finalScore.toFixed(6)),
        routeFile: page.routeFile,
        chunks: chunks.length > 0
          ? chunks.slice(0, maxSubResults).map((c) => ({
              sectionTitle: c.metadata.sectionTitle || undefined,
              snippet: this.excerptFor(c, query),
              chunkText: storedBodyText(c, this.config) || undefined,
              headingPath: c.metadata.headingPath,
              score: Number(c.score.toFixed(6))
            }))
          : undefined
      };

      if (debug && page.breakdown) {
        result.breakdown = {
          baseScore: page.breakdown.baseScore,
          incomingLinkBoost: page.breakdown.incomingLinkBoost,
          depthBoost: page.breakdown.depthBoost,
          titleMatchBoost: page.breakdown.titleMatchBoost,
          freshnessBoost: page.breakdown.freshnessBoost,
          // Was hardcoded to 0, so the playground showed no anchor boost even
          // when one had been applied.
          anchorTextMatchBoost: page.breakdown.anchorTextMatchBoost ?? 0,
          pageWeight: page.breakdown.pageWeight
        };
      }

      return result;
    });
  }

  /** A snippet from a stored chunk's readable text, never its embedding prefix. */
  private excerptFor(hit: VectorHit, query?: string): string {
    const text = chunkDisplayText(hit.metadata, {
      prependTitle: this.config.chunking.prependTitle,
      // Recognised by record identity, never by shape: a headingless body chunk
      // may begin with the page title too.
      isPageSummary: hit.id === pageSummaryChunkKey(hit.metadata.url)
    });
    return query ? queryAwareExcerpt(text, query) : toSnippet(text);
  }

  private ensureSnippet(hit: RankedHit, query?: string): string {
    const chunkText = hit.hit.metadata.chunkText;
    if (query && chunkText) return this.excerptFor(hit.hit, query);
    const snippet = hit.hit.metadata.snippet;
    if (snippet && snippet.length >= 30) return snippet;
    if (chunkText) return this.excerptFor(hit.hit);
    return snippet || "";
  }

  private buildResults(ordered: RankedHit[], topK: number, query?: string, debug?: boolean, config?: ResolvedSearchSocketConfig): SearchResult[] {
    const cfg = config ?? this.config;
    // Chunk-only mode. The page-grouping branch that used to live here was
    // unreachable — the page-first pipeline builds its own results — so its
    // config (aggregationCap, aggregationDecay, weights.aggregation,
    // minChunkScoreRatio) was tunable but inert.
      // Same finite guard as the page-first path: minScoreRatio is skipped when
      // the top score is non-finite, so malformed hits would otherwise reach the
      // wire as `null` scores and fail the browser validators for the whole
      // response rather than for themselves.
      let filtered = ordered.filter((entry) => Number.isFinite(entry.finalScore));
      const minScoreRatio = cfg.ranking.minScoreRatio;
      if (minScoreRatio > 0 && filtered.length > 0) {
        const topScore = filtered[0]!.finalScore;
        if (topScore > 0) {
          const threshold = topScore * minScoreRatio;
          filtered = filtered.filter((entry) => entry.finalScore >= threshold);
        }
      }
      return filtered.slice(0, topK).map(({ hit, finalScore, breakdown }) => {
        const result: SearchResult = {
          url: hit.metadata.url,
          title: hit.metadata.title,
          sectionTitle: hit.metadata.sectionTitle || undefined,
          snippet: this.ensureSnippet({ hit, finalScore }, query),
          chunkText: storedBodyText(hit, this.config) || undefined,
          score: Number(finalScore.toFixed(6)),
          routeFile: hit.metadata.routeFile
        };
        if (debug && breakdown) {
          result.breakdown = breakdown;
        }
        return result;
    });
  }

  async getPage(pathOrUrl: string, scope?: string): Promise<{
    url: string;
    frontmatter: Record<string, unknown>;
    markdown: string;
  }> {
    const resolvedScope = resolveScope(this.config, scope, this.cwd);
    const urlPath = this.resolveInputPath(pathOrUrl);
    const page = await this.requireStore().getPage(urlPath, resolvedScope);

    if (!page) {
      throw new SearchSocketError("INVALID_REQUEST", `Indexed page not found for ${urlPath}`, 404);
    }

    return {
      url: page.url,
      frontmatter: {
        url: page.url,
        title: page.title,
        routeFile: page.routeFile,
        routeResolution: page.routeResolution,
        incomingLinks: page.incomingLinks,
        outgoingLinks: page.outgoingLinks,
        depth: page.depth,
        tags: page.tags,
        indexedAt: page.indexedAt
      },
      markdown: page.markdown
    };
  }

  async listPages(opts?: {
    pathPrefix?: string;
    cursor?: string;
    limit?: number;
    scope?: string;
  }): Promise<{
    pages: Array<{ url: string; title: string; description: string; routeFile: string }>;
    nextCursor?: string;
  }> {
    const resolvedScope = resolveScope(this.config, opts?.scope, this.cwd);
    const pathPrefix = opts?.pathPrefix
      ? (opts.pathPrefix.startsWith("/") ? opts.pathPrefix : `/${opts.pathPrefix}`)
      : undefined;
    return this.requireStore().listPages(resolvedScope, {
      cursor: opts?.cursor,
      limit: opts?.limit,
      pathPrefix
    });
  }

  async getSiteStructure(opts?: {
    pathPrefix?: string;
    scope?: string;
    maxPages?: number;
  }): Promise<SiteStructureResult> {
    const maxPages = Math.min(opts?.maxPages ?? MAX_SITE_STRUCTURE_PAGES, MAX_SITE_STRUCTURE_PAGES);
    const allPages: Array<{ url: string; title: string; description: string; routeFile: string }> = [];
    let cursor: string | undefined;
    let truncated = false;

    do {
      const result = await this.listPages({
        pathPrefix: opts?.pathPrefix,
        scope: opts?.scope,
        cursor,
        limit: 200
      });
      allPages.push(...result.pages);
      cursor = result.nextCursor;

      if (allPages.length >= maxPages) {
        truncated = allPages.length > maxPages || !!cursor;
        allPages.length = maxPages;
        break;
      }
    } while (cursor);

    const root = buildTree(allPages, opts?.pathPrefix);

    return {
      root,
      totalPages: allPages.length,
      truncated
    };
  }

  async getRelatedPages(
    pathOrUrl: string,
    opts?: { topK?: number; scope?: string }
  ): Promise<RelatedPagesResult> {
    const resolvedScope = resolveScope(this.config, opts?.scope, this.cwd);
    const urlPath = this.resolveInputPath(pathOrUrl);
    const topK = Math.min(opts?.topK ?? 10, 25);

    // Fetch source page with its vector
    const source = await this.requireStore().fetchPageWithVector(urlPath, resolvedScope);
    if (!source) {
      throw new SearchSocketError("INVALID_REQUEST", `Indexed page not found for ${urlPath}`, 404);
    }

    const sourceOutgoing = new Set(source.metadata.outgoingLinkUrls ?? []);

    // ANN query for semantically similar pages (using stored vector)
    const semanticHits = await this.requireStore().searchPagesByVector(
      source.vector,
      { limit: 50 },
      resolvedScope
    );
    const filteredHits = semanticHits.filter((h) => h.url !== urlPath);

    // Build semantic score map
    const semanticScoreMap = new Map<string, number>();
    for (const hit of filteredHits) {
      semanticScoreMap.set(hit.url, hit.score);
    }

    // Collect candidate URLs: semantic hits + outgoing link targets
    const candidateUrls = new Set<string>();
    for (const hit of filteredHits) {
      candidateUrls.add(hit.url);
    }
    for (const url of sourceOutgoing) {
      if (url !== urlPath) candidateUrls.add(url);
    }

    // Fetch outgoing link targets that weren't in semantic results (for metadata)
    const missingUrls = [...sourceOutgoing].filter(
      (u) => u !== urlPath && !semanticScoreMap.has(u)
    );
    const fetchedPages = missingUrls.length > 0
      ? await this.requireStore().fetchPagesBatch(missingUrls, resolvedScope)
      : [];

    // Build metadata map from semantic hits + fetched pages
    const metaMap = new Map<string, { title: string; routeFile: string; outgoingLinkUrls: string[] }>();
    for (const hit of filteredHits) {
      metaMap.set(hit.url, { title: hit.title, routeFile: hit.routeFile, outgoingLinkUrls: [] });
    }
    for (const p of fetchedPages) {
      metaMap.set(p.url, { title: p.title, routeFile: p.routeFile, outgoingLinkUrls: p.outgoingLinkUrls });
    }

    // We need outgoingLinkUrls for semantic hits too (for incoming link detection)
    // Batch-fetch semantic hits to get their outgoingLinkUrls
    const semanticUrls = filteredHits.map((h) => h.url);
    if (semanticUrls.length > 0) {
      const semanticPageData = await this.requireStore().fetchPagesBatch(semanticUrls, resolvedScope);
      for (const p of semanticPageData) {
        const existing = metaMap.get(p.url);
        if (existing) {
          existing.outgoingLinkUrls = p.outgoingLinkUrls;
        }
      }
    }

    // Score each candidate
    const candidates: RelatedPage[] = [];
    for (const url of candidateUrls) {
      const meta = metaMap.get(url);
      if (!meta) continue;

      const isOutgoing = sourceOutgoing.has(url);
      const isIncoming = meta.outgoingLinkUrls.includes(urlPath);
      const isLinked = isOutgoing || isIncoming;
      const dice = diceScore(urlPath, url);
      const semantic = semanticScoreMap.get(url) ?? 0;

      const score = compositeScore(isLinked, dice, semantic);
      const relationshipType = dominantRelationshipType(isOutgoing, isIncoming, dice);

      candidates.push({
        url,
        title: meta.title,
        score: Number(score.toFixed(6)),
        relationshipType,
        routeFile: meta.routeFile
      });
    }

    // Sort by score descending and cap at topK
    candidates.sort((a, b) => b.score - a.score);
    const results = candidates.slice(0, topK);

    return {
      sourceUrl: urlPath,
      scope: resolvedScope.scopeName,
      relatedPages: results
    };
  }

  async health(): Promise<{ ok: boolean; details?: string }> {
    if (!this.store) {
      return { ok: false, details: "Search is not configured. Set the required Upstash environment variables to enable search." };
    }
    return this.store.health();
  }

  private resolveInputPath(pathOrUrl: string): string {
    if (pathOrUrl.length > MAX_PATH_LENGTH) {
      throw new SearchSocketError(
        "INVALID_REQUEST",
        `Page path must be at most ${MAX_PATH_LENGTH} characters`,
        400
      );
    }

    try {
      if (/^https?:\/\//.test(pathOrUrl)) {
        return normalizeUrlPath(new URL(pathOrUrl).pathname);
      }
    } catch {
      // fall through to plain path handling
    }

    const withoutQueryOrHash = pathOrUrl.split(/[?#]/)[0] ?? pathOrUrl;
    return normalizeUrlPath(withoutQueryOrHash);
  }
}
