import path from "node:path";
import { loadConfig } from "../config/load";
import { resolveScope } from "../core/scope";
import { ensureStateDirs } from "../core/state";
import { SearchSocketError } from "../errors";
import { createUpstashStore } from "../vector";
import { UpstashSearchStore } from "../vector/upstash";
import { buildEmbeddingText, chunkPage } from "./chunker";
import { extractFromHtmlResult, extractFromMarkdownResult } from "./extractor";
import { buildRoutePatterns, mapUrlToRoute } from "./route-mapper";
import { loadBuildPages } from "./sources/build";
import { loadContentFilesPages } from "./sources/content-files";
import { loadCrawledPages } from "./sources/crawl";
import { loadStaticOutputPages } from "./sources/static-output";
import type { SourceLoadResult } from "./sources/result";
import { detectBuildOutput } from "./sources/build/detect-output";
import { loadRobotsTxtFromDir, fetchRobotsTxt, isBlockedByRobots } from "./robots";
import { findPageWeight } from "../search/ranking";
import { matchUrlPatterns } from "../utils/pattern";
import { normalizeMarkdown } from "../utils/text";
import { hrTimeMs, nowIso } from "../utils/time";
import { getUrlDepth, normalizeUrlPath } from "../utils/path";
import { Logger } from "../core/logger";
import { sha256 } from "../utils/hash";
import { writeLlmsTxt } from "./llms-txt";
import type {
  Chunk,
  CustomRecord,
  ExtractedPage,
  IndexedPage,
  IndexingHooks,
  IndexOptions,
  IndexStats,
  RunWarning,
  PageRecord,
  ResolvedSearchSocketConfig,
  RouteMatch,
  Scope
} from "../types";
import { toStoredMeta } from "../utils/structured-meta";

/**
 * Build a plain-text summary of a page for the page search index.
 * Combines title, description, and stripped markdown body (truncated to maxChars).
 */
export function buildPageSummary(page: IndexedPage, maxChars = 3500): string {
  const parts: string[] = [page.title];

  if (page.description) {
    parts.push(page.description);
  }

  if (page.keywords && page.keywords.length > 0) {
    parts.push(page.keywords.join(", "));
  }

  // Strip markdown formatting to get plain body text
  const plainBody = page.markdown
    .replace(/```[\s\S]*?```/g, " ")   // remove code blocks
    .replace(/`([^`]+)`/g, "$1")       // inline code → text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images → text
    .replace(/^#{1,6}\s+/gm, "")       // headings → text
    .replace(/[>*_|~\-]/g, " ")        // strip formatting chars
    .replace(/\s+/g, " ")
    .trim();

  if (plainBody) {
    parts.push(plainBody);
  }

  const joined = parts.join("\n\n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars).trim();
}

/**
 * Build a deterministic content hash for a page.
 * Used to detect whether a page has changed between index runs.
 */
export function buildPageContentHash(page: IndexedPage): string {
  const parts = [
    page.title,
    page.description ?? "",
    (page.keywords ?? []).slice().sort().join(","),
    page.tags.slice().sort().join(","),
    page.markdown,
    String(page.outgoingLinks),
    String(page.publishedAt ?? ""),
    page.incomingAnchorText ?? "",
    // Provenance is persisted, so a page that changes from custom-supplied to
    // site-owned (or back) must be re-upserted even if its text is identical —
    // otherwise the stored flag stays stale and protects the wrong records.
    page.custom ? "custom" : "site",
    // Weight affects ranking and is persisted in page metadata, so it must
    // change the hash. Without it, editing searchsocket-weight="1" to "2"
    // left the hash identical, the upsert was skipped, and search kept
    // ranking with the old weight until the next forced rebuild.
    String(page.weight ?? ""),
    (page.outgoingLinkUrls ?? []).slice().sort().join(","),
    page.meta ? JSON.stringify(page.meta, Object.keys(page.meta).sort()) : ""
  ];
  return sha256(parts.join("|"));
}

interface IndexPipelineOptions {
  cwd?: string;
  configPath?: string;
  config?: ResolvedSearchSocketConfig;
  store?: UpstashSearchStore;
  logger?: Logger;
  hooks?: IndexingHooks;
}

export class IndexPipeline {
  private readonly cwd: string;
  private readonly config: ResolvedSearchSocketConfig;
  private readonly store: UpstashSearchStore;
  private readonly logger: Logger;
  private readonly hooks: IndexingHooks;

  private constructor(options: {
    cwd: string;
    config: ResolvedSearchSocketConfig;
    store: UpstashSearchStore;
    logger: Logger;
    hooks: IndexingHooks;
  }) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.store = options.store;
    this.logger = options.logger;
    this.hooks = options.hooks;
  }

  static async create(options: IndexPipelineOptions = {}): Promise<IndexPipeline> {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const config = options.config ?? (await loadConfig({ cwd, configPath: options.configPath }));
    const store = options.store ?? await createUpstashStore(config);

    return new IndexPipeline({
      cwd,
      config,
      store,
      logger: options.logger ?? new Logger(),
      hooks: options.hooks ?? {}
    });
  }

  getConfig(): ResolvedSearchSocketConfig {
    return this.config;
  }

  async run(rawOptions: IndexOptions = {}): Promise<IndexStats> {
    const options: Required<Pick<IndexOptions, "changedOnly" | "force" | "dryRun">> & IndexOptions = {
      changedOnly: rawOptions.changedOnly ?? true,
      force: rawOptions.force ?? false,
      dryRun: rawOptions.dryRun ?? false,
      ...rawOptions
    };

    const stageTimingsMs: Record<string, number> = {};
    const stageStart = (): bigint => process.hrtime.bigint();
    const stageEnd = (name: string, start: bigint): void => {
      stageTimingsMs[name] = Math.round(hrTimeMs(start));
    };

    const scope = resolveScope(this.config, options.scopeOverride, this.cwd);
    ensureStateDirs(this.cwd, this.config.state.dir, scope);

    const sourceMode = options.sourceOverride ?? this.config.source.mode;
    this.logger.info(`Indexing scope "${scope.scopeName}" (source: ${sourceMode}, backend: upstash-vector)`);

    if (options.force) {
      this.logger.info("Force mode enabled — full rebuild");
    }

    if (options.dryRun) {
      this.logger.info("Dry run — no writes will be performed");
    }

    const manifestStart = stageStart();
    // Always fetch existing hashes, even under --force. Force means "re-upsert
    // everything regardless of hash", not "forget what is already indexed" —
    // without this the stale set is empty and orphaned pages survive forever.
    const existingPageHashes = await this.store.getPageHashes(scope);
    stageEnd("manifest", manifestStart);
    this.logger.debug(`Manifest: ${existingPageHashes.size} existing page hashes loaded`);

    const sourceStart = stageStart();
    this.logger.info(`Loading pages (source: ${sourceMode})...`);
    let sourceLoad: SourceLoadResult;

    if (sourceMode === "static-output") {
      sourceLoad = await loadStaticOutputPages(this.cwd, this.config, options.maxPages);
    } else if (sourceMode === "crawl") {
      sourceLoad = await loadCrawledPages(this.config, options.maxPages);
    } else if (sourceMode === "build") {
      sourceLoad = await loadBuildPages(this.cwd, this.config, options.maxPages);
    } else {
      sourceLoad = await loadContentFilesPages(this.cwd, this.config, options.maxPages);
    }
    const sourcePages = sourceLoad.records;
    stageEnd("source", sourceStart);
    this.logger.info(`Loaded ${sourcePages.length} page${sourcePages.length === 1 ? "" : "s"} (${stageTimingsMs["source"]}ms)`);

    // --- Run completeness ---
    // Stale-record deletion diffs the current run against the remote index.
    // That is only sound when this run observed the complete source of truth;
    // otherwise every page the run failed to see looks "removed" and gets
    // deleted. Track every reason the view might be partial.
    const runWarnings: RunWarning[] = [];
    if (!sourceLoad.complete && !sourceLoad.limitedBy && sourceLoad.failures.length === 0) {
      // A loader reported an incomplete view without naming a specific cause.
      // Trust the flag: it is the loader's primary contract.
      runWarnings.push({
        kind: "source-failure",
        detail: `${sourceMode} source reported an incomplete view of the site`
      });
    }
    if (sourceLoad.limitedBy) {
      runWarnings.push({
        kind: "source-limited",
        detail: `source truncated by ${sourceLoad.limitedBy} (${sourcePages.length} of ${sourceLoad.discoveredCount} discovered)`
      });
    }
    for (const failure of sourceLoad.failures) {
      runWarnings.push({
        kind: "source-failure",
        detail: `${failure.target}: ${failure.reason}`
      });
    }
    if (typeof options.maxChunks === "number") {
      runWarnings.push({
        kind: "chunks-limited",
        detail: `--max-chunks ${options.maxChunks} truncates the chunk set`
      });
    }

    // --- Pre-extraction filtering: robots.txt + top-level exclude ---
    const filterStart = stageStart();
    let filteredSourcePages = sourcePages;

    // Apply top-level exclude patterns (works across all source modes)
    if (this.config.exclude.length > 0) {
      const beforeExclude = filteredSourcePages.length;
      filteredSourcePages = filteredSourcePages.filter((p) => {
        const url = normalizeUrlPath(p.url);
        if (matchUrlPatterns(url, this.config.exclude)) {
          this.logger.debug(`Excluding ${url} (matched exclude pattern)`);
          return false;
        }
        return true;
      });
      const excludedCount = beforeExclude - filteredSourcePages.length;
      if (excludedCount > 0) {
        this.logger.info(`Excluded ${excludedCount} page${excludedCount === 1 ? "" : "s"} by config exclude patterns`);
      }
    }

    // Apply robots.txt filtering
    if (this.config.respectRobotsTxt) {
      let robotsRules = null;
      if (sourceMode === "static-output") {
        robotsRules = await loadRobotsTxtFromDir(
          path.resolve(this.cwd, this.config.source.staticOutputDir)
        );
      } else if (sourceMode === "build" && this.config.source.build) {
        robotsRules = await loadRobotsTxtFromDir(
          path.resolve(this.cwd, this.config.source.build.outputDir)
        );
        // Non-node adapters (vercel, cloudflare, etc.) write robots.txt into
        // their own output directory — consult the detector as a fallback.
        if (!robotsRules) {
          const detected = await detectBuildOutput(this.cwd, this.config.source.staticOutputDir);
          if (detected) {
            robotsRules = await loadRobotsTxtFromDir(detected.absolutePath);
          }
        }
      } else if (sourceMode === "crawl" && this.config.source.crawl) {
        const robotsFetch = await fetchRobotsTxt(this.config.source.crawl.baseUrl);
        if (robotsFetch.status === "rules") {
          robotsRules = robotsFetch.rules;
        } else if (robotsFetch.status === "unavailable") {
          // An unreadable policy is not permission to index everything: a page
          // the last readable robots.txt excluded would quietly become public.
          // A run warning is the containment that already exists for this —
          // it makes the run non-authoritative, so nothing is deleted and no
          // artifacts are published from it.
          this.logger.warn(
            `Could not read robots.txt (${robotsFetch.reason}); treating the exclusion policy as unknown.`
          );
          runWarnings.push({
            kind: "source-failure",
            detail: `robots.txt unreadable: ${robotsFetch.reason}`
          });
        }
      }

      if (robotsRules) {
        const beforeRobots = filteredSourcePages.length;
        filteredSourcePages = filteredSourcePages.filter((p) => {
          const url = normalizeUrlPath(p.url);
          if (isBlockedByRobots(url, robotsRules!)) {
            this.logger.debug(`Excluding ${url} (blocked by robots.txt)`);
            return false;
          }
          return true;
        });
        const robotsExcluded = beforeRobots - filteredSourcePages.length;
        if (robotsExcluded > 0) {
          this.logger.info(`Excluded ${robotsExcluded} page${robotsExcluded === 1 ? "" : "s"} by robots.txt`);
        }
      }
    }
    stageEnd("filter", filterStart);

    const routeStart = stageStart();
    const routePatterns = await buildRoutePatterns(this.cwd);
    stageEnd("route_map", routeStart);
    this.logger.debug(`Route mapping: ${routePatterns.length} pattern${routePatterns.length === 1 ? "" : "s"} discovered (${stageTimingsMs["route_map"]}ms)`);

    const extractStart = stageStart();
    this.logger.info("Extracting content...");
    const extractedPages: ExtractedPage[] = [];

    for (const sourcePage of filteredSourcePages) {
      const result = sourcePage.html
        ? extractFromHtmlResult(sourcePage.url, sourcePage.html, this.config)
        : extractFromMarkdownResult(sourcePage.url, sourcePage.markdown ?? "", sourcePage.title);

      if (result.status === "excluded") {
        // An explicit noindex or zero weight is an authoritative removal
        // signal: the author asked for this page to be absent.
        this.logger.debug(`Excluding ${sourcePage.url} (${result.reason})`);
        continue;
      }

      if (result.status === "failed") {
        // Extraction failure is NOT a removal signal. Warn loudly and make the
        // run deletion-ineligible so a selector regression cannot wipe records.
        this.logger.warn(
          `Page ${sourcePage.url} produced no extractable content and was skipped (${result.error.detail}). ` +
            "Check extract.mainSelector, extract.dropTags, and extract.dropSelectors settings."
        );
        runWarnings.push({
          kind: "extraction-failure",
          detail: `${sourcePage.url}: ${result.error.detail}`
        });
        continue;
      }

      const extracted = result.page;

      // Merge source-level tags (e.g. "component") into extracted tags
      if (sourcePage.tags && sourcePage.tags.length > 0) {
        extracted.tags = [...new Set([...extracted.tags, ...sourcePage.tags])];
      }

      let accepted: ExtractedPage;
      if (this.hooks.transformPage) {
        const transformed = await this.hooks.transformPage(extracted);
        if (transformed === null) {
          this.logger.debug(`Page ${sourcePage.url} skipped by transformPage hook`);
          continue;
        }
        accepted = transformed;
      } else {
        accepted = extracted;
      }

      // Provenance belongs to the pipeline. A hook marking a site page as
      // custom would make it, and its chunks, permanently immune to deletion
      // by any ordinary indexing run.
      accepted.custom = false;

      extractedPages.push(accepted);
      this.logger.event("page_extracted", {
        url: accepted.url
      });
    }

    // Pages contributed by the configured site source, before custom records
    // are mixed in. The empty-source guard must judge this number alone —
    // custom records are caller-supplied and would otherwise disguise a total
    // source failure as a healthy run.
    const sitePageCount = extractedPages.length;

    // --- Inject custom records as ExtractedPage objects ---
    // Custom records bypass extractFromMarkdown() to avoid frontmatter parsing —
    // the caller controls title, weight, and tags via the CustomRecord interface.
    const customRecords = options.customRecords ?? [];
    if (customRecords.length > 0) {
      this.logger.info(`Processing ${customRecords.length} custom record${customRecords.length === 1 ? "" : "s"}...`);
      for (const record of customRecords) {
        const normalizedUrl = normalizeUrlPath(record.url);
        const normalized = normalizeMarkdown(record.content);
        if (!normalized.trim()) {
          // A caller-supplied record that suddenly has no content is a
          // provider bug, not a request to remove the page. Without this the
          // record's existing page and chunks were silently deleted.
          this.logger.warn(`Custom record ${normalizedUrl} has empty content and was skipped.`);
          runWarnings.push({
            kind: "extraction-failure",
            detail: `custom record ${normalizedUrl}: empty content`
          });
          continue;
        }

        const urlTags = normalizedUrl.split("/").filter(Boolean).slice(0, 1);
        const tags = record.tags
          ? [...new Set([...urlTags, ...record.tags])]
          : urlTags;

        const extracted: ExtractedPage = {
          url: normalizedUrl,
          title: record.title,
          markdown: normalized,
          outgoingLinks: [],
          noindex: false,
          tags,
          weight: record.weight,
          custom: true,
          // `CustomRecord.metadata` is documented and demonstrated, but was
          // dropped here — so a caller could set structured metadata on a
          // custom record and then never filter on it.
          meta: record.metadata && Object.keys(record.metadata).length > 0
            ? toStoredMeta(record.metadata)
            : undefined
        };

        // Apply transformPage hook to custom records too
        let accepted: ExtractedPage;
        if (this.hooks.transformPage) {
          const transformed = await this.hooks.transformPage(extracted);
          if (transformed === null) {
            this.logger.debug(`Custom record ${normalizedUrl} skipped by transformPage hook`);
            continue;
          }
          accepted = transformed;
        } else {
          accepted = extracted;
        }

        // Provenance is the pipeline's to assert, not the hook's. A hook that
        // returns a freshly constructed page would otherwise drop the marker,
        // and the record would lose the protection that keeps a site-only run
        // from deleting it.
        accepted.custom = true;

        extractedPages.push(accepted);
        this.logger.event("page_extracted", { url: accepted.url, custom: true });
      }
    }

    extractedPages.sort((a, b) => a.url.localeCompare(b.url));
    const uniquePages: ExtractedPage[] = [];
    const seenUrls = new Set<string>();
    for (const page of extractedPages) {
      if (seenUrls.has(page.url)) {
        this.logger.warn(
          `Duplicate page source for ${page.url}; keeping first extracted page and skipping the duplicate.`
        );
        continue;
      }
      seenUrls.add(page.url);
      uniquePages.push(page);
    }

    // Filter out zero-weight pages at index time.
    const indexablePages: ExtractedPage[] = [];
    for (const page of uniquePages) {
      // Same precedence as ranking: a zero from either source suppresses the
      // page, otherwise the page's own declared weight wins.
      const configWeight = findPageWeight(page.url, this.config.ranking.pageWeights);
      const effectiveWeight =
        configWeight === 0 || page.weight === 0 ? 0 : page.weight ?? configWeight;
      if (effectiveWeight === 0) {
        this.logger.debug(`Excluding ${page.url} (zero weight)`);
        continue;
      }
      indexablePages.push(page);
    }

    const zeroWeightCount = uniquePages.length - indexablePages.length;
    if (zeroWeightCount > 0) {
      this.logger.info(`Excluded ${zeroWeightCount} page${zeroWeightCount === 1 ? "" : "s"} with zero weight`);
    }

    stageEnd("extract", extractStart);
    const skippedPages = filteredSourcePages.length - indexablePages.length;
    this.logger.info(`Extracted ${indexablePages.length} page${indexablePages.length === 1 ? "" : "s"}${skippedPages > 0 ? ` (${skippedPages} skipped)` : ""} (${stageTimingsMs["extract"]}ms)`);

    const linkStart = stageStart();
    const pageSet = new Set(indexablePages.map((page) => normalizeUrlPath(page.url)));
    const incomingLinkCount = new Map<string, number>();
    const incomingAnchorTexts = new Map<string, Set<string>>();

    for (const page of indexablePages) {
      incomingLinkCount.set(page.url, incomingLinkCount.get(page.url) ?? 0);
    }

    for (const page of indexablePages) {
      const seenForCount = new Set<string>();
      const seenForAnchor = new Set<string>();
      for (const { url: outgoing, anchorText } of page.outgoingLinks) {
        if (!pageSet.has(outgoing)) {
          continue;
        }

        // Count each target URL only once per source page
        if (!seenForCount.has(outgoing)) {
          seenForCount.add(outgoing);
          incomingLinkCount.set(outgoing, (incomingLinkCount.get(outgoing) ?? 0) + 1);
        }

        // Collect anchor text: one phrase per source-page/target pair
        if (anchorText && !seenForAnchor.has(outgoing)) {
          seenForAnchor.add(outgoing);
          if (!incomingAnchorTexts.has(outgoing)) {
            incomingAnchorTexts.set(outgoing, new Set());
          }
          incomingAnchorTexts.get(outgoing)!.add(anchorText);
        }
      }
    }
    stageEnd("links", linkStart);
    this.logger.debug(`Link analysis: computed incoming links for ${incomingLinkCount.size} pages (${stageTimingsMs["links"]}ms)`);

    const pagesStart = stageStart();
    this.logger.info("Building indexed pages...");
    const pages: IndexedPage[] = [];
    let routeExact = 0;
    let routeBestEffort = 0;

    const precomputedRoutes = new Map<string, RouteMatch>();
    for (const sp of sourcePages) {
      if (sp.routeFile) {
        precomputedRoutes.set(normalizeUrlPath(sp.url), {
          routeFile: sp.routeFile,
          routeResolution: sp.routeResolution ?? "exact"
        });
      }
    }

    // Pre-register custom record URLs to bypass strict route mapping
    for (const record of customRecords) {
      const normalizedUrl = normalizeUrlPath(record.url);
      if (!precomputedRoutes.has(normalizedUrl)) {
        precomputedRoutes.set(normalizedUrl, {
          routeFile: "",
          routeResolution: "exact"
        });
      }
    }

    for (const page of indexablePages) {
      const routeMatch = precomputedRoutes.get(normalizeUrlPath(page.url)) ?? mapUrlToRoute(page.url, routePatterns);

      if (routeMatch.routeResolution === "best-effort") {
        if (this.config.source.strictRouteMapping) {
          throw new SearchSocketError(
            "ROUTE_MAPPING_FAILED",
            `Strict route mapping enabled: no exact route match for ${page.url} (resolved to ${routeMatch.routeFile}). ` +
              "Disable source.strictRouteMapping or add the missing route file.",
            400
          );
        }

        this.logger.warn(
          `No exact route match for ${page.url}, falling back to ${routeMatch.routeFile}.`
        );
        routeBestEffort += 1;
      } else {
        routeExact += 1;
      }

      // Build incoming anchor text string: deduped, space-joined, capped at 500 chars
      const anchorSet = incomingAnchorTexts.get(page.url);
      let incomingAnchorText: string | undefined;
      if (anchorSet && anchorSet.size > 0) {
        let joined = "";
        for (const phrase of anchorSet) {
          const next = joined ? `${joined} ${phrase}` : phrase;
          if (next.length > 500) break;
          joined = next;
        }
        incomingAnchorText = joined || undefined;
      }

      const indexedPage: IndexedPage = {
        url: page.url,
        title: page.title,
        scope: scope.scopeName,
        routeFile: routeMatch.routeFile,
        routeResolution: routeMatch.routeResolution,
        generatedAt: nowIso(),
        incomingLinks: incomingLinkCount.get(page.url) ?? 0,
        outgoingLinks: page.outgoingLinks.length,
        outgoingLinkUrls: page.outgoingLinks.map((l) => typeof l === "string" ? l : l.url),
        depth: getUrlDepth(page.url),
        tags: page.tags,
        markdown: page.markdown,
        description: page.description,
        keywords: page.keywords,
        publishedAt: page.publishedAt,
        incomingAnchorText,
        weight: page.weight,
        custom: page.custom,
        meta: page.meta
      };

      pages.push(indexedPage);
      this.logger.event("page_indexed", { url: page.url });
    }

    // Build page records with content hashes for incremental comparison
    const pageRecords: PageRecord[] = pages.map((p) => {
      const summary = buildPageSummary(p);
      return {
        url: p.url,
        title: p.title,
        markdown: p.markdown,
        projectId: scope.projectId,
        scopeName: scope.scopeName,
        routeFile: p.routeFile,
        routeResolution: p.routeResolution,
        incomingLinks: p.incomingLinks,
        outgoingLinks: p.outgoingLinks,
        outgoingLinkUrls: p.outgoingLinkUrls,
        depth: p.depth,
        tags: p.tags,
        indexedAt: p.generatedAt,
        summary,
        description: p.description,
        keywords: p.keywords,
        contentHash: buildPageContentHash(p),
        publishedAt: p.publishedAt,
        incomingAnchorText: p.incomingAnchorText,
        weight: p.weight,
        custom: p.custom,
        meta: p.meta
      };
    });

    // Determine changed and stale pages
    const currentPageUrls = new Set(pageRecords.map((r) => r.url));
    const changedPages = options.force
      ? pageRecords
      : pageRecords.filter((r) =>
          !existingPageHashes.has(r.url) || existingPageHashes.get(r.url)!.contentHash !== r.contentHash
        );
    const staleCandidateUrls = [...existingPageHashes.entries()]
      .filter(([url, entry]) => {
        if (currentPageUrls.has(url)) return false;
        // A run that was not told about custom records has no opinion on them.
        // Without this, indexing the site without passing `customRecords`
        // deleted every custom record as "no longer present" — and a provider
        // that merely failed to run once would take its content with it.
        // Passing `customRecords: []` explicitly asserts there are none.
        if (entry.custom && options.customRecords === undefined) return false;
        return true;
      })
      .map(([url]) => url);

    stageEnd("pages", pagesStart);
    this.logger.info(`Indexed ${pages.length} page${pages.length === 1 ? "" : "s"} (${routeExact} exact, ${routeBestEffort} best-effort) (${stageTimingsMs["pages"]}ms)`);

    const chunkStart = stageStart();
    this.logger.info("Chunking pages...");
    let chunks: Chunk[] = pages.flatMap((page) => chunkPage(page, this.config, scope));

    const maxChunks = typeof options.maxChunks === "number" ? Math.max(0, Math.floor(options.maxChunks)) : undefined;
    if (typeof maxChunks === "number") {
      chunks = chunks.slice(0, maxChunks);
    }

    if (this.hooks.transformChunk) {
      const transformed: Chunk[] = [];
      for (const chunk of chunks) {
        const result = await this.hooks.transformChunk(chunk);
        if (result === null) {
          this.logger.debug(`Chunk ${chunk.chunkKey} skipped by transformChunk hook`);
          continue;
        }
        transformed.push(result);
      }
      chunks = transformed;
    }

    for (const chunk of chunks) {
      this.logger.event("chunked", {
        url: chunk.url,
        chunkKey: chunk.chunkKey
      });
    }

    // `beforeIndex` runs here, on the full chunk array, BEFORE anything is
    // diffed. Running it after the diff meant a hook that renamed or filtered
    // chunks produced a plan that no longer matched what would be written:
    // a renamed chunk was upserted and then immediately deleted as "stale",
    // and dropped chunks left the remote copy orphaned forever. Its output is
    // now simply the set of chunks this run intends to exist.
    if (this.hooks.beforeIndex) {
      chunks = await this.hooks.beforeIndex(chunks);
    }

    // Provenance belongs to the pipeline, not to a hook. `transformChunk` and
    // `beforeIndex` may return freshly constructed chunks, which would drop the
    // marker and leave a custom record's sections deletable by the next
    // site-only run. Reassert it from the page each chunk came from.
    const customUrls = new Set(pages.filter((page) => page.custom).map((page) => page.url));
    const knownUrls = new Set(pages.map((page) => page.url));
    const placeable: Chunk[] = [];
    for (const chunk of chunks) {
      // A hook may rewrite a chunk's URL. One pointing at a page this run never
      // indexed has no determinable provenance and can never be returned by
      // getPage, so it is dropped rather than guessed at — guessing either
      // strands it or leaves it deletable by the next site-only run.
      if (!knownUrls.has(chunk.url)) {
        this.logger.warn(
          `Chunk ${chunk.chunkKey} references ${chunk.url}, which is not an indexed page in this run; skipping it.`
        );
        runWarnings.push({
          kind: "hook-failure",
          detail: `chunk ${chunk.chunkKey} references unindexed page ${chunk.url}`
        });
        continue;
      }
      chunk.custom = customUrls.has(chunk.url);
      placeable.push(chunk);
    }
    chunks = placeable;

    stageEnd("chunk", chunkStart);
    this.logger.info(`Chunked into ${chunks.length} chunk${chunks.length === 1 ? "" : "s"} (${stageTimingsMs["chunk"]}ms)`);

    const currentChunkMap = new Map<string, Chunk>();
    for (const chunk of chunks) {
      currentChunkMap.set(chunk.chunkKey, chunk);
    }

    // Fetch existing hashes for the specific chunk keys we have now.
    // Uses direct fetch() by ID instead of range() scan to avoid potential
    // issues with range() returning vectors from wrong namespaces on hybrid indexes.
    const chunkHashStart = stageStart();
    const currentChunkKeys = chunks.map((c) => c.chunkKey);
    const existingHashes = options.force
      ? new Map<string, string>()
      : await this.store.fetchContentHashesForKeys(currentChunkKeys, scope);
    stageEnd("chunk_hashes", chunkHashStart);
    this.logger.debug(`Fetched ${existingHashes.size} existing chunk hashes for ${currentChunkKeys.length} current keys`);

    const changedChunks = chunks.filter((chunk) => {
      if (options.force) {
        return true;
      }

      const existingHash = existingHashes.get(chunk.chunkKey);
      if (!existingHash) {
        return true;
      }

      if (!options.changedOnly) {
        return true;
      }

      return existingHash !== chunk.contentHash;
    });

    // Scan for stale chunk IDs that no longer exist in the current set.
    // Uses range() scan which may include extra IDs, but deletion of
    // non-existent IDs is safe and idempotent.
    const existingChunkIds = await this.store.scanChunkIds(scope);
    const staleChunkCandidates = [...existingChunkIds.entries()]
      .filter(([chunkKey, isCustom]) => {
        if (currentChunkMap.has(chunkKey)) return false;
        // Same rule as pages: a run not told about custom records has no
        // opinion on them. Protecting only the page record left the page
        // present but its chunks deleted, so `get_page` returned empty
        // markdown and the record vanished from section search.
        if (isCustom && options.customRecords === undefined) return false;
        return true;
      })
      .map(([chunkKey]) => chunkKey);

    // --- Deletion safety gate ---
    // Everything above only computed a plan. Deleting the difference between
    // that plan and the remote index is safe only if this run observed the
    // complete source of truth. Every warning collected anywhere in the run —
    // source truncation, a failed fetch, a failed extraction, a chunk limit —
    // lands here, and the gate is evaluated exactly once, before any write.
    const dangerousOperations: string[] = [];
    let deletionEligible = runWarnings.length === 0;

    if (!deletionEligible) {
      this.logger.warn(
        `Run is not authoritative (${runWarnings.length} warning${runWarnings.length === 1 ? "" : "s"}); no records will be deleted.`
      );
      for (const warning of runWarnings) {
        this.logger.warn(`  ${warning.kind}: ${warning.detail}`);
      }
    }

    // An authoritative run whose *site source* produced zero pages is almost
    // always a broken source config rather than a genuinely emptied site.
    //
    // This deliberately tests the site source rather than the combined record
    // count: custom records are supplied by the caller and would otherwise
    // mask a total source failure, letting every real page be deleted while
    // the count stayed comfortably non-zero.
    const siteSourceEmpty = sitePageCount === 0;
    if (deletionEligible && siteSourceEmpty && !options.allowEmpty) {
      deletionEligible = false;
      const detail =
        `site source produced 0 pages (${existingPageHashes.size} page(s) and ` +
        `${existingChunkIds.size} chunk(s) exist remotely); pass --allow-empty to delete them`;
      this.logger.warn(`Refusing deletion: ${detail}`);
      runWarnings.push({ kind: "source-failure", detail });
      dangerousOperations.push(`refused-empty-deletion: ${detail}`);
    }

    // Guard against a mass deletion caused by a change the completeness checks
    // cannot see — e.g. every URL silently gaining a prefix, which looks like a
    // complete run that legitimately replaced the whole site.
    //
    // Measured against pages and chunks independently: a scope may hold chunks
    // without page records (an index written by an older version), and judging
    // by pages alone would then wave through a total chunk wipe.
    // `--allow-empty` is already an explicit statement that a total removal is
    // intended, so it satisfies the ratio guard for that case on its own.
    // Requiring `--accept-large-deletion` as well would contradict its help text.
    //
    // A refusal here also stops the run's *additions*. Withholding only the
    // deletions left the replacement records written, which enlarges the
    // inventory the ratio is measured against: an identical rerun then saw the
    // same stale records as a smaller fraction and deleted them without
    // `--accept-large-deletion` ever being supplied. Refusing the whole
    // mutation is what keeps a refused plan refused however often it is
    // repeated, and leaves the index exactly as it was last accepted.
    let indexMutationRefused = false;
    const ratioGuardSatisfied =
      options.acceptLargeDeletion || (options.allowEmpty === true && siteSourceEmpty);
    if (deletionEligible && !ratioGuardSatisfied) {
      const maxRatio = this.config.indexing.maxDeletionRatio;
      const checks: Array<{ label: string; stale: number; existing: number }> = [
        { label: "pages", stale: staleCandidateUrls.length, existing: existingPageHashes.size },
        { label: "chunks", stale: staleChunkCandidates.length, existing: existingChunkIds.size }
      ];
      for (const check of checks) {
        if (check.stale === 0 || check.existing === 0) continue;
        const ratio = check.stale / check.existing;
        if (ratio > maxRatio) {
          deletionEligible = false;
          indexMutationRefused = true;
          const detail =
            `would delete ${check.stale} of ${check.existing} ${check.label} ` +
            `(${Math.round(ratio * 100)}% > ${Math.round(maxRatio * 100)}% limit); ` +
            "no records were written; pass --accept-large-deletion to proceed";
          this.logger.warn(`Refusing deletion: ${detail}`);
          runWarnings.push({ kind: "source-failure", detail });
          dangerousOperations.push(`refused-large-deletion: ${detail}`);
          break;
        }
      }
    }


    const deletedPageUrls = deletionEligible ? staleCandidateUrls : [];
    const deletes = deletionEligible ? staleChunkCandidates : [];

    if (!deletionEligible && (staleCandidateUrls.length > 0 || staleChunkCandidates.length > 0)) {
      this.logger.warn(
        `Skipping deletion of ${staleCandidateUrls.length} stale page(s) and ` +
          `${staleChunkCandidates.length} stale chunk(s) — run is not authoritative.`
      );
    }

    if (deletedPageUrls.length > 0) {
      dangerousOperations.push(
        `delete-pages: ${deletedPageUrls.length} page(s) in project ${this.config.project.id} scope ${scope.scopeName}`
      );
      this.logger.info(
        `Deletion plan: ${deletedPageUrls.length} stale page${deletedPageUrls.length === 1 ? "" : "s"} ` +
          `in project ${this.config.project.id}, scope ${scope.scopeName}`
      );
      for (const url of deletedPageUrls) this.logger.debug(`  delete ${url}`);
    }
    if (deletes.length > 0) {
      dangerousOperations.push(
        `delete-chunks: ${deletes.length} chunk(s) in project ${this.config.project.id} scope ${scope.scopeName}`
      );
    }

    const pagesChanged = changedPages.length;
    const pagesDeleted = deletedPageUrls.length;
    this.logger.info(`Page changes: ${pagesChanged} changed/new, ${pagesDeleted} deleted, ${pageRecords.length - changedPages.length} unchanged`);
    this.logger.info(`Changes detected: ${changedChunks.length} changed, ${deletes.length} deleted, ${chunks.length - changedChunks.length} unchanged`);

    if (indexMutationRefused && !options.dryRun) {
      this.logger.warn(
        `Leaving the index untouched: ${changedPages.length} page change(s) and ` +
          `${changedChunks.length} chunk change(s) were not written, because writing them ` +
          "would make the refused deletion look acceptable on the next run."
      );
    }

    if (!options.dryRun && !indexMutationRefused) {
      // Upsert before delete, in both force and incremental mode: a crash
      // between the two must leave the old generation searchable, never an
      // empty index. Page IDs are stable, so re-upserting overwrites in place
      // and the delete only removes records this run did not write.
      if (changedPages.length > 0 || deletedPageUrls.length > 0) {
        this.logger.info(`Upserting ${changedPages.length} page summar${changedPages.length === 1 ? "y" : "ies"}...`);
        const pageDocs = changedPages.map((r) => ({
          id: r.url,
          data: r.summary ?? r.title,
          metadata: {
            title: r.title,
            url: r.url,
            description: r.description ?? "",
            keywords: r.keywords ?? [],
            summary: r.summary ?? "",
            tags: r.tags,
            routeFile: r.routeFile,
            routeResolution: r.routeResolution,
            incomingLinks: r.incomingLinks,
            outgoingLinks: r.outgoingLinks,
            outgoingLinkUrls: r.outgoingLinkUrls ?? [],
            depth: r.depth,
            indexedAt: r.indexedAt,
            contentHash: r.contentHash ?? "",
            publishedAt: r.publishedAt ?? null,
            incomingAnchorText: r.incomingAnchorText ?? "",
            weight: r.weight ?? null,
            custom: r.custom ?? false,
            ...(r.meta && Object.keys(r.meta).length > 0 ? { meta: r.meta } : {})
          }
        }));
        if (pageDocs.length > 0) {
          await this.store.upsertPages(pageDocs, scope);
        }
        // Page deletion is deferred until after the chunks are written. Deleting
        // here meant a chunk-write failure left the index with fresh pages, the
        // old pages already removed, and stale chunks — a state no run produced
        // deliberately. Every upsert now precedes every delete.
      }
    }

    // Upsert changed chunks to Upstash Vector (embedding handled server-side)
    const upsertStart = stageStart();
    let documentsUpserted = 0;

    if (!options.dryRun && !indexMutationRefused && changedChunks.length > 0) {
      this.logger.info(`Upserting ${changedChunks.length} chunk${changedChunks.length === 1 ? "" : "s"} to Upstash Vector...`);

      const CHUNK_TEXT_MAX_CHARS = 30_000;

      const docs = changedChunks.map((chunk) => {
        const embeddingText = buildEmbeddingText(chunk, this.config.chunking.prependTitle);
        if (embeddingText.length > 2000) {
          this.logger.warn(
            `Chunk ${chunk.chunkKey} text is ${embeddingText.length} chars (~${Math.round(embeddingText.length / 4)} tokens), which may exceed the 512-token model limit and be silently truncated.`
          );
        }

        // Hard cap chunkText to stay within Upstash's 48KB metadata limit
        const cappedText = embeddingText.length > CHUNK_TEXT_MAX_CHARS
          ? embeddingText.slice(0, CHUNK_TEXT_MAX_CHARS)
          : embeddingText;

        return {
        id: chunk.chunkKey,
        data: embeddingText,
        metadata: {
          url: chunk.url,
          path: chunk.path,
          title: chunk.title,
          sectionTitle: chunk.sectionTitle ?? "",
          headingPath: chunk.headingPath.join(" > "),
          snippet: chunk.snippet,
          chunkText: cappedText,
          tags: chunk.tags,
          ordinal: chunk.ordinal,
          contentHash: chunk.contentHash,
          depth: chunk.depth,
          incomingLinks: chunk.incomingLinks,
          routeFile: chunk.routeFile,
          description: chunk.description ?? "",
          keywords: chunk.keywords ?? [],
          publishedAt: chunk.publishedAt ?? null,
          incomingAnchorText: chunk.incomingAnchorText ?? "",
          custom: chunk.custom ?? false,
          ...(chunk.meta && Object.keys(chunk.meta).length > 0 ? { meta: chunk.meta } : {})
        }
      };
      });

      await this.store.upsertChunks(docs, scope);
      documentsUpserted = docs.length;
      this.logger.event("upserted", { count: docs.length });
    }

    // --- Deletions, after every upsert has landed ---
    if (!options.dryRun && deletedPageUrls.length > 0) {
      await this.store.deletePagesByIds(deletedPageUrls, scope);
    }

    if (!options.dryRun && deletes.length > 0) {
      await this.store.deleteByIds(deletes, scope);
      this.logger.event("deleted", { count: deletes.length });
    }

    stageEnd("upsert", upsertStart);
    // A refused run already reported that it wrote nothing; following that with
    // an upsert count of zero would read as "nothing needed writing".
    if (!indexMutationRefused) {
      if (changedChunks.length > 0) {
        this.logger.info(`Upserted ${documentsUpserted} document${documentsUpserted === 1 ? "" : "s"} (${stageTimingsMs["upsert"]}ms)`);
      } else {
        this.logger.info("No chunks to upsert — all up to date");
      }
    }

    // Generate llms.txt if enabled.
    //
    // These are published artifacts, so they get the same protection the index
    // gets: only a run holding the complete page list may replace them. A
    // truncated crawl, a failed extraction, or a refused deletion plan would
    // otherwise overwrite a complete llms.txt with its partial page set, and
    // unlike the index there is no second copy to recover it from.
    //
    // The predicate is about the *page list*, which is not quite the question
    // the index asks. A chunk limit truncates no pages, so it must not freeze
    // the exports; conversely a retained custom record this run was never told
    // about is missing from `pages` even though it is still in the index, and
    // publishing would quietly drop it from the public list.
    const retainedCustomRecords =
      options.customRecords === undefined &&
      [...existingPageHashes.values()].some((entry) => entry.custom);
    const pageSetComplete =
      !indexMutationRefused &&
      !retainedCustomRecords &&
      runWarnings.every((warning) => warning.kind === "chunks-limited");

    if (this.config.llmsTxt.enable && !options.dryRun) {
      if (pageSetComplete) {
        const llmsStart = stageStart();
        await writeLlmsTxt(pages, this.config, this.cwd, this.logger);
        stageEnd("llms_txt", llmsStart);
      } else {
        this.logger.warn(
          "Keeping the existing llms.txt: this run's page list may be incomplete."
        );
      }
    }

    this.logger.info("Done.");

    const stats: IndexStats = {
      pagesProcessed: pages.length,
      pagesChanged,
      pagesDeleted,
      chunksTotal: chunks.length,
      chunksChanged: changedChunks.length,
      documentsUpserted,
      deletes: deletes.length,
      routeExact,
      routeBestEffort,
      stageTimingsMs,
      deletionEligible,
      warnings: runWarnings,
      dangerousOperations
    };

    if (this.hooks.afterIndex) {
      try {
        await this.hooks.afterIndex(stats);
      } catch (error) {
        // The index has already been committed. Surface the hook failure
        // without implying the write was rolled back.
        this.logger.error(
          `afterIndex hook failed after the index was successfully written: ${error instanceof Error ? error.message : String(error)}`
        );
        throw error;
      }
    }

    return stats;
  }
}
