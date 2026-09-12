import path from "node:path";
import { loadConfig } from "../config/load";
import { resolveScope } from "../core/scope";
import { ensureStateDirs } from "../core/state";
import { SearchSocketError } from "../errors";
import { createUpstashStore } from "../vector";
import type { ChunkHashEntry } from "../vector/upstash";
import { UpstashSearchStore } from "../vector/upstash";
import { buildChunkEmbeddingHash, buildEmbeddingText, chunkPage } from "./chunker";
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
import { normalizeMarkdown, toSnippet } from "../utils/text";
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
import {
  METADATA_BYTE_BUDGET,
  metadataByteSize,
  toStoredMeta,
  truncateToUtf8Bytes,
  utf8ByteLength
} from "../utils/structured-meta";
import { INDEX_SCHEMA_VERSION } from "../vector/ids";

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
 * Serialize a value so that two different values can never share a preimage.
 *
 * Object keys are emitted in sorted order so an insertion-order difference is
 * not mistaken for a content difference; arrays keep their order, because the
 * order of `tags` and `keywords` is what gets stored and is therefore part of
 * what a fingerprint has to notice. `undefined` is normalized to null so an
 * absent field and an explicitly-undefined one agree.
 *
 * This replaces delimiter-joining, which was genuinely ambiguous: `|` occurs
 * freely in markdown tables, tags and keywords, so `{tags: ["a|b"]}` and
 * `{tags: ["a"], description: "b"}` could produce the same joined preimage and
 * therefore the same digest.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value instanceof Date) return JSON.stringify(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    // Indexed rather than `.map`, which skips holes: `[]` and `new Array(1)` are
    // different payloads and JSON.stringify already tells them apart.
    const items: string[] = [];
    for (let i = 0; i < value.length; i += 1) items.push(canonicalJson(value[i]));
    return `[${items.join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
}

/**
 * Fingerprint of everything that decides a page's *embedding*.
 *
 * Deliberately a conservative superset: the embedded text is the generated
 * summary, and the summary is derived from title, description, keywords and
 * markdown, so hashing those sources can over-trigger but can never miss a
 * change to what is embedded. Fields that only ever reach metadata — route
 * mapping, incoming links, ordinals — belong to the metadata fingerprint
 * instead, so editing them refreshes metadata without paying to re-embed.
 */
export function buildPageContentHash(page: IndexedPage): string {
  return sha256(
    canonicalJson({
      title: page.title,
      description: page.description ?? "",
      // Not sorted, unlike tags: the summary that actually gets embedded joins
      // the keywords in order, so a reorder changes the embedding input and has
      // to change this fingerprint. Tags reach metadata only, so sorting them
      // keeps a pure reorder on the cheap metadata path.
      keywords: page.keywords ?? [],
      tags: page.tags.slice().sort(),
      markdown: page.markdown,
      outgoingLinks: page.outgoingLinks,
      publishedAt: page.publishedAt ?? null,
      incomingAnchorText: page.incomingAnchorText ?? "",
      // Provenance is persisted, so a page that changes from custom-supplied to
      // site-owned (or back) must be re-upserted even if its text is identical —
      // otherwise the stored flag stays stale and protects the wrong records.
      custom: page.custom === true,
      // Weight affects ranking and is persisted in page metadata, so it must
      // change the hash. Without it, editing searchsocket-weight="1" to "2"
      // left the hash identical, the upsert was skipped, and search kept
      // ranking with the old weight until the next forced rebuild.
      weight: page.weight ?? null,
      outgoingLinkUrls: (page.outgoingLinkUrls ?? []).slice().sort(),
      meta: page.meta ?? null
    })
  );
}

/**
 * Fields that are persisted but must never take part in a fingerprint.
 *
 * `indexedAt` is a wall clock stamped on every write; folding it in would make
 * every record differ from itself on the next run. The two fingerprints are
 * excluded from each other so that "the text changed" and "the metadata
 * changed" stay independent signals.
 */
const FINGERPRINT_EXCLUDED_KEYS = new Set(["indexedAt", "contentHash", "metadataHash"]);

/**
 * Fingerprint of the COMPLETE persisted metadata projection.
 *
 * Taking it from the object that is actually written — rather than from a
 * hand-listed subset — is the point: it is what stops a newly persisted field
 * from being invisible to the diff, which is how `tags`, `ordinal`,
 * `routeFile`, `incomingLinks` and `publishedAt` all came to be stored but
 * never refreshed.
 */
function fingerprintMetadata(metadata: Record<string, unknown>): string {
  const projection: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (FINGERPRINT_EXCLUDED_KEYS.has(key)) continue;
    projection[key] = value;
  }
  return sha256(canonicalJson(projection));
}

/**
 * Copy a structured-metadata bag one level deeper than a spread does.
 *
 * `{ ...meta }` clones the object but leaves every `string[]` value pointing at
 * the array hanging off the IndexedPage — the same array every chunk of that
 * page shares. A `transformChunk` hook doing `chunk.meta.frameworks.push(...)`
 * therefore grew a page payload that had already been measured against the byte
 * budget and fingerprinted, so the record reached the backend over the limit
 * while describing itself with the hash of something smaller. Page plans are
 * built before the chunk hooks run, which is exactly when that happens.
 */
function copyStoredMeta(
  meta: Record<string, string | number | boolean | string[]>
): Record<string, string | number | boolean | string[]> {
  const copy: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(meta)) {
    copy[key] = Array.isArray(value) ? [...value] : value;
  }
  return copy;
}

/**
 * The metadata a page record is written with, and the single definition of it.
 *
 * Both the write and the metadata fingerprint read this, so the two cannot
 * drift: any field added here is fingerprinted by construction. The store adds
 * the scope/identity fields (`projectId`, `scopeName`, `schemaVersion`,
 * `type`) on top; those are constants of the record's address, not content.
 */
function buildPageMetadata(record: PageRecord): Record<string, unknown> {
  return {
    title: record.title,
    url: record.url,
    description: record.description ?? "",
    keywords: [...(record.keywords ?? [])],
    summary: record.summary ?? "",
    // Copied, not referenced. `tags`, `keywords` and `meta` are the very arrays
    // hanging off the IndexedPage, which chunks also share: a chunk hook doing
    // `chunk.tags.push(...)` would otherwise mutate a page payload that had
    // already been fingerprinted, and the record would be written with content
    // its own hash does not describe.
    tags: [...record.tags],
    routeFile: record.routeFile,
    routeResolution: record.routeResolution,
    incomingLinks: record.incomingLinks,
    outgoingLinks: record.outgoingLinks,
    outgoingLinkUrls: [...(record.outgoingLinkUrls ?? [])],
    depth: record.depth,
    indexedAt: record.indexedAt,
    contentHash: record.contentHash ?? "",
    publishedAt: record.publishedAt ?? null,
    incomingAnchorText: record.incomingAnchorText ?? "",
    weight: record.weight ?? null,
    custom: record.custom ?? false,
    ...(record.meta && Object.keys(record.meta).length > 0 ? { meta: copyStoredMeta(record.meta) } : {})
  };
}

/**
 * The metadata a chunk record is written with, and the single definition of it.
 * See buildPageMetadata() for why the write and the fingerprint share it.
 *
 * `chunkText` is stored in full here. It used to be cut at 30,000 JavaScript
 * characters "to stay within Upstash's 48KB metadata limit", which a code-unit
 * slice cannot do: 30,000 CJK characters are ~90,000 UTF-8 bytes before the
 * rest of the record is added, and an equally valid ASCII chunk was cut long
 * before it needed to be. The real limit is enforced by byte, on the complete
 * serialized payload, in fitMetadataToBudget() below.
 */
function buildChunkMetadata(chunk: Chunk, embeddingText: string): Record<string, unknown> {
  return {
    url: chunk.url,
    path: chunk.path,
    title: chunk.title,
    sectionTitle: chunk.sectionTitle ?? "",
    headingPath: chunk.headingPath.join(" > "),
    snippet: chunk.snippet,
    chunkText: embeddingText,
    tags: [...chunk.tags],
    ordinal: chunk.ordinal,
    contentHash: chunk.contentHash,
    depth: chunk.depth,
    incomingLinks: chunk.incomingLinks,
    routeFile: chunk.routeFile,
    description: chunk.description ?? "",
    keywords: [...(chunk.keywords ?? [])],
    publishedAt: chunk.publishedAt ?? null,
    incomingAnchorText: chunk.incomingAnchorText ?? "",
    custom: chunk.custom ?? false,
    ...(chunk.meta && Object.keys(chunk.meta).length > 0 ? { meta: copyStoredMeta(chunk.meta) } : {})
  };
}

/**
 * A record this run intends to exist, with both fingerprints resolved.
 *
 * Defined here rather than in src/types.ts because it is an internal detail of
 * how the pipeline plans its writes, not part of the package's public surface.
 */
interface PlannedWrite {
  id: string;
  data: string;
  metadata: Record<string, unknown>;
  contentHash: string;
  metadataHash: string;
}

/**
 * What a record picks up after this module hands it over, and which the byte
 * budget therefore has to reserve room for.
 *
 * `UpstashSearchStore.upsertChunks`/`upsertPages` stamp the scope identity onto
 * every record, and `planWrite` appends the metadata fingerprint. None of that
 * is ours to trim. Measuring only the projection built above would declare a
 * payload safe and then have the backend reject it — mid-batch, after earlier
 * records in the same call had already landed.
 *
 * The fingerprint is a sha256 hex digest, so its length is a constant 64 and a
 * placeholder measures identically to the real thing.
 */
function storeEnvelope(kind: WriteKind, id: string, scope: Scope): Record<string, unknown> {
  return {
    ...(kind === "chunk" ? { chunkKey: id } : {}),
    projectId: scope.projectId,
    scopeName: scope.scopeName,
    schemaVersion: INDEX_SCHEMA_VERSION,
    type: kind,
    metadataHash: "0".repeat(64)
  };
}

type WriteKind = "chunk" | "page";

/**
 * The one free-text field per record kind that may be shortened to fit.
 *
 * Everything else is identity, provenance or link structure: shortening any of
 * it would quietly change what search returns and what `get_page` reports,
 * rather than merely storing less of the body.
 */
const TRIMMABLE_METADATA_FIELD: Record<WriteKind, string> = {
  chunk: "chunkText",
  page: "summary"
};

/** Context a planned write needs in order to be measured against the budget. */
interface WriteBudget {
  kind: WriteKind;
  /** The page this record belongs to; a chunk reports the page it came from. */
  url: string;
  scope: Scope;
  logger: Logger;
}

/**
 * The largest field in a metadata projection, by serialized size.
 *
 * Used only to make the rejection actionable: "this record is too big" is not
 * something a site owner can act on, whereas "its `meta` is 60 KB" is.
 */
function largestMetadataField(metadata: Record<string, unknown>): { key: string; bytes: number } {
  let key = "";
  let bytes = -1;
  for (const [entryKey, value] of Object.entries(metadata)) {
    // Ties broken by key order so the message is the same on every run.
    const size = utf8ByteLength(JSON.stringify({ [entryKey]: value }));
    if (size > bytes || (size === bytes && entryKey < key)) {
      key = entryKey;
      bytes = size;
    }
  }
  return { key, bytes: Math.max(bytes, 0) };
}

/**
 * Bring a record's metadata inside the per-vector byte budget, or refuse it.
 *
 * Measured on the FINAL object — the projection plus everything the store will
 * add — serialized exactly as it will be sent, because JSON escaping inflates
 * newlines, quotes and control characters and the key names are payload too.
 *
 * When the required fields alone do not fit there is nothing honest left to do
 * but stop. Trimming identity or link structure would store a record that lies
 * about itself, and letting it through means the backend rejects one item in
 * the middle of a batch whose earlier items are already written.
 */
function fitMetadataToBudget(
  id: string,
  metadata: Record<string, unknown>,
  budget: WriteBudget
): Record<string, unknown> {
  const envelope = storeEnvelope(budget.kind, id, budget.scope);
  const measure = (candidate: Record<string, unknown>): number =>
    metadataByteSize({ ...candidate, ...envelope });

  let size = measure(metadata);
  if (size <= METADATA_BYTE_BUDGET) return metadata;

  const field = TRIMMABLE_METADATA_FIELD[budget.kind];
  const originalBytes = utf8ByteLength(
    typeof metadata[field] === "string" ? (metadata[field] as string) : ""
  );

  // Removing N UTF-8 bytes from the field removes at least N from the
  // serialized payload — escaping only ever inflates — so one pass converges.
  // The loop is a guard against that reasoning being wrong, not an algorithm.
  let fitted = metadata;
  for (let attempt = 0; attempt < 4 && size > METADATA_BYTE_BUDGET; attempt += 1) {
    const current = typeof fitted[field] === "string" ? (fitted[field] as string) : "";
    if (current.length === 0) break;
    const target = utf8ByteLength(current) - (size - METADATA_BYTE_BUDGET);
    fitted = { ...fitted, [field]: truncateToUtf8Bytes(current, target) };
    size = measure(fitted);
  }

  if (size > METADATA_BYTE_BUDGET) {
    const { [field]: _trimmed, ...required } = fitted;
    const largest = largestMetadataField({ ...required, ...envelope });
    throw new SearchSocketError(
      "INVALID_REQUEST",
      `Cannot index ${budget.kind} "${id}" on page ${budget.url}: its required metadata is ` +
        `${size} bytes serialized, over the ${METADATA_BYTE_BUDGET}-byte per-record limit, ` +
        `even with "${field}" removed entirely. The largest field is "${largest.key}" ` +
        `(${largest.bytes} bytes). Shorten it, or drop it from the page's metadata.`
    );
  }

  const keptBytes = utf8ByteLength(fitted[field] as string);
  budget.logger.warn(
    `Trimmed "${field}" of ${budget.kind} ${id} (${budget.url}) from ${originalBytes} to ` +
      `${keptBytes} UTF-8 bytes to fit the ${METADATA_BYTE_BUDGET}-byte metadata limit.`
  );
  return fitted;
}

/**
 * Fit the metadata to the byte budget, then attach its fingerprint.
 *
 * The order is the whole point. The metadata fingerprint exists to describe
 * exactly what is stored; hashing before the trim would leave the stored
 * payload and the hash that claims to describe it disagreeing, so the next run
 * would see "unchanged" for a record whose text it never actually wrote.
 */
function planWrite(
  id: string,
  data: string,
  metadata: Record<string, unknown>,
  budget: WriteBudget
): PlannedWrite {
  const fitted = fitMetadataToBudget(id, metadata, budget);
  const metadataHash = fingerprintMetadata(fitted);
  return {
    id,
    data,
    metadata: { ...fitted, metadataHash },
    contentHash: String(fitted.contentHash ?? ""),
    metadataHash
  };
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
      // Pass the run's logger so the loader's exclusion warnings honour the
      // run's JSON and verbosity settings rather than falling back to a default.
      sourceLoad = await loadContentFilesPages(this.cwd, this.config, options.maxPages, this.logger);
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

    // Set when robots.txt was configured to be respected but could not be read.
    // The run then has no way to know which pages are excluded, so it must not
    // write anything — see the reasoning where this is assigned.
    let exclusionPolicyUnknown = false;

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
          //
          // Marking the run non-authoritative stops deletions and artifact
          // publication, but that is not enough on its own — the exposure here
          // comes from a *write*. Crawling a sitemap that still lists /private
          // while robots.txt 503s would index and serve it. There is no cached
          // ruleset to fall back on (the pipeline persists nothing), so the
          // only safe reading of an unknown policy is to write nothing at all
          // and let the next run try again.
          this.logger.warn(
            `Could not read robots.txt (${robotsFetch.reason}); treating the exclusion policy as unknown.`
          );
          exclusionPolicyUnknown = true;
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

    // Plan every page write up front, fingerprinting the metadata that will
    // actually be persisted rather than a hand-picked subset of it.
    const pageWrites = pageRecords.map((r) =>
      planWrite(r.url, r.summary ?? r.title, buildPageMetadata(r), {
        kind: "page",
        url: r.url,
        scope,
        logger: this.logger
      })
    );

    // Determine changed and stale pages.
    //
    // Two independent verdicts. A different embedding fingerprint means the
    // summary that gets embedded has changed, so the record must be re-upserted.
    // A different metadata fingerprint alone — a moved route file, a new
    // incoming-link count — only needs the stored metadata replaced, which
    // costs no embedding.
    const currentPageUrls = new Set(pageRecords.map((r) => r.url));
    const changedPageWrites: PlannedWrite[] = [];
    const metadataOnlyPageWrites: PlannedWrite[] = [];
    for (const write of pageWrites) {
      const stored = options.force ? undefined : existingPageHashes.get(write.id);
      if (!stored || stored.contentHash !== write.contentHash) {
        changedPageWrites.push(write);
      } else if (stored.metadataHash !== write.metadataHash) {
        // Records written before metadata fingerprints existed carry no
        // metadataHash at all. Treating that as a metadata change refreshes
        // them once, cheaply; treating it as a text change would re-embed an
        // index that has not changed.
        metadataOnlyPageWrites.push(write);
      }
    }
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

    /**
     * `snippet` is derived from `chunkText`, so a hook that rewrites the text
     * and leaves the snippet alone was storing a snippet describing text nobody
     * will ever read. Re-derive it — but only when the hook supplied none of its
     * own, which is an explicit override the pipeline has no business
     * second-guessing.
     */
    const refreshSnippet = (chunk: Chunk, before: { chunkText: string; snippet: string }): void => {
      if (chunk.snippet === before.snippet && chunk.chunkText !== before.chunkText) {
        chunk.snippet = toSnippet(chunk.chunkText);
      }
    };

    const maxChunks = typeof options.maxChunks === "number" ? Math.max(0, Math.floor(options.maxChunks)) : undefined;
    if (typeof maxChunks === "number") {
      chunks = chunks.slice(0, maxChunks);
    }

    if (this.hooks.transformChunk) {
      const transformed: Chunk[] = [];
      for (const chunk of chunks) {
        // Snapshot before the call: a hook is free to mutate in place, and it is
        // also free to return a chunk under a different key, so the pairing has
        // to be positional rather than by key.
        const before = { chunkText: chunk.chunkText, snippet: chunk.snippet };
        const result = await this.hooks.transformChunk(chunk);
        if (result === null) {
          this.logger.debug(`Chunk ${chunk.chunkKey} skipped by transformChunk hook`);
          continue;
        }
        refreshSnippet(result, before);
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
    // `beforeIndex` takes and returns the whole array, so a chunk can only be
    // paired with its input by key. A hook that both renames a chunk and
    // rewrites its text keeps whatever snippet it set; there is nothing left to
    // correlate it with.
    const beforeIndexInput = new Map(
      chunks.map((chunk) => [chunk.chunkKey, { chunkText: chunk.chunkText, snippet: chunk.snippet }])
    );
    if (this.hooks.beforeIndex) {
      chunks = await this.hooks.beforeIndex(chunks);
      for (const chunk of chunks) {
        const before = beforeIndexInput.get(chunk.chunkKey);
        if (before) refreshSnippet(chunk, before);
        else if (!chunk.snippet) chunk.snippet = toSnippet(chunk.chunkText);
      }
    }

    // Provenance belongs to the pipeline, not to a hook. `transformChunk` and
    // `beforeIndex` may return freshly constructed chunks, which would drop the
    // marker and leave a custom record's sections deletable by the next
    // site-only run. Reassert it from the page each chunk came from.
    const customUrls = new Set(pages.filter((page) => page.custom).map((page) => page.url));
    const knownUrls = new Set(pages.map((page) => page.url));
    const placeable: Chunk[] = [];
    const seenChunkKeys = new Set<string>();
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

      // Two chunks sharing a key are one record. Letting both through meant the
      // write array and the key-indexed map disagreed about what this run
      // intends to exist: the loser was upserted and instantly overwritten, and
      // the deletion planner saw a set the writes never matched. Keep the first
      // and treat the collision as a hook failure, which also stops this run
      // deleting anything on a plan it clearly did not mean.
      if (seenChunkKeys.has(chunk.chunkKey)) {
        this.logger.warn(
          `Chunk key ${chunk.chunkKey} was produced more than once; keeping the first and dropping the duplicate.`
        );
        runWarnings.push({
          kind: "hook-failure",
          detail: `duplicate chunk key ${chunk.chunkKey}`
        });
        continue;
      }
      seenChunkKeys.add(chunk.chunkKey);
      placeable.push(chunk);
    }
    chunks = placeable;

    stageEnd("chunk", chunkStart);
    this.logger.info(`Chunked into ${chunks.length} chunk${chunks.length === 1 ? "" : "s"} (${stageTimingsMs["chunk"]}ms)`);

    const currentChunkMap = new Map<string, Chunk>();
    for (const chunk of chunks) {
      currentChunkMap.set(chunk.chunkKey, chunk);
    }

    // Fingerprint the FINAL payload — after every hook and after provenance has
    // been re-asserted. Hashing the chunker's output instead meant a hook that
    // rewrote `chunkText` produced a hash identical to the stored one, the diff
    // filtered the chunk out, and the hook's new text never reached storage;
    // worse, the upsert re-derived its embedding text from the hooked chunk, so
    // the written payload and the hash it was matched on could disagree.
    const chunkWrites = chunks.map((chunk) => {
      chunk.contentHash = buildChunkEmbeddingHash(chunk, this.config.chunking.prependTitle);
      const embeddingText = buildEmbeddingText(chunk, this.config.chunking.prependTitle);
      return planWrite(chunk.chunkKey, embeddingText, buildChunkMetadata(chunk, embeddingText), {
        kind: "chunk",
        url: chunk.url,
        scope,
        logger: this.logger
      });
    });

    // Fetch existing hashes for the specific chunk keys we have now.
    // Uses direct fetch() by ID instead of range() scan to avoid potential
    // issues with range() returning vectors from wrong namespaces on hybrid indexes.
    const chunkHashStart = stageStart();
    const currentChunkKeys = chunks.map((c) => c.chunkKey);
    const existingHashes = options.force
      ? new Map<string, ChunkHashEntry>()
      : await this.store.fetchContentHashesForKeys(currentChunkKeys, scope);
    stageEnd("chunk_hashes", chunkHashStart);
    this.logger.debug(`Fetched ${existingHashes.size} existing chunk hashes for ${currentChunkKeys.length} current keys`);

    // Same two verdicts as pages: a changed embedding fingerprint needs a full
    // re-upsert, a changed metadata fingerprint alone needs only the stored
    // metadata replaced.
    const changedChunks: PlannedWrite[] = [];
    const metadataOnlyChunks: PlannedWrite[] = [];
    for (const write of chunkWrites) {
      const stored = options.force ? undefined : existingHashes.get(write.id);
      if (!stored || !options.changedOnly || stored.contentHash !== write.contentHash) {
        changedChunks.push(write);
      } else if (stored.metadataHash !== write.metadataHash) {
        // Includes every record written before metadata fingerprints existed:
        // one cheap metadata refresh, not a re-embed of the whole index.
        metadataOnlyChunks.push(write);
      }
    }

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

    // "Changed" counts both kinds of write. A run that only moved a route file
    // or reordered two sections really did change those records, and reporting
    // it as zero is exactly the reading that hid this whole class of staleness.
    const pagesChanged = changedPageWrites.length + metadataOnlyPageWrites.length;
    const pagesDeleted = deletedPageUrls.length;
    this.logger.info(`Page changes: ${pagesChanged} changed/new (${metadataOnlyPageWrites.length} metadata-only), ${pagesDeleted} deleted, ${pageRecords.length - pagesChanged} unchanged`);
    const chunksChanged = changedChunks.length + metadataOnlyChunks.length;
    this.logger.info(`Changes detected: ${chunksChanged} changed (${metadataOnlyChunks.length} metadata-only), ${deletes.length} deleted, ${chunks.length - chunksChanged} unchanged`);

    // Two independent reasons to write nothing: a refused deletion plan (writing
    // would dilute the ratio the next run measures) and an unknown exclusion
    // policy (writing could publish a page robots.txt meant to exclude).
    const writesBlocked = indexMutationRefused || exclusionPolicyUnknown;

    if (writesBlocked && !options.dryRun) {
      const reason = indexMutationRefused
        ? "writing them would make the refused deletion look acceptable on the next run"
        : "robots.txt could not be read, so the run cannot tell which pages are excluded";
      this.logger.warn(
        `Leaving the index untouched: ${pagesChanged} page change(s) and ` +
          `${chunksChanged} chunk change(s) were not written, because ${reason}.`
      );
    }

    // Records refreshed in place, without re-sending the text that would make
    // the backend embed them again. Counted per namespace because
    // `documentsUpserted` has always meant chunk documents.
    let pageMetadataRefreshed = 0;
    let chunkMetadataRefreshed = 0;

    if (!options.dryRun && !writesBlocked) {
      // Upsert before delete, in both force and incremental mode: a crash
      // between the two must leave the old generation searchable, never an
      // empty index. Page IDs are stable, so re-upserting overwrites in place
      // and the delete only removes records this run did not write.
      const pageUpserts = [...changedPageWrites];

      if (metadataOnlyPageWrites.length > 0) {
        this.logger.info(
          `Refreshing metadata for ${metadataOnlyPageWrites.length} page${metadataOnlyPageWrites.length === 1 ? "" : "s"} (no re-embedding)...`
        );
        // A record that disappeared between the diff and this write cannot be
        // patched, and dropping it silently would leave the page missing until
        // its text happened to change. Recreate it with a full upsert instead.
        const missing = await this.store.updatePageMetadata(
          metadataOnlyPageWrites.map((w) => ({ id: w.id, metadata: w.metadata })),
          scope
        );
        pageMetadataRefreshed += metadataOnlyPageWrites.length - missing.length;
        this.logger.debug(`Refreshed metadata for ${pageMetadataRefreshed} page record(s)`);
        for (const id of missing) {
          const write = metadataOnlyPageWrites.find((w) => w.id === id);
          if (write) pageUpserts.push(write);
        }
      }

      if (pageUpserts.length > 0 || deletedPageUrls.length > 0) {
        this.logger.info(`Upserting ${pageUpserts.length} page summar${pageUpserts.length === 1 ? "y" : "ies"}...`);
        if (pageUpserts.length > 0) {
          await this.store.upsertPages(
            pageUpserts.map((w) => ({ id: w.id, data: w.data, metadata: w.metadata })),
            scope
          );
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

    if (!options.dryRun && !writesBlocked) {
      const chunkUpserts = [...changedChunks];

      if (metadataOnlyChunks.length > 0) {
        this.logger.info(
          `Refreshing metadata for ${metadataOnlyChunks.length} chunk${metadataOnlyChunks.length === 1 ? "" : "s"} (no re-embedding)...`
        );
        const missing = await this.store.updateChunkMetadata(
          metadataOnlyChunks.map((w) => ({ id: w.id, metadata: w.metadata })),
          scope
        );
        chunkMetadataRefreshed += metadataOnlyChunks.length - missing.length;
        // Same reasoning as pages: a vanished record has to be recreated, not
        // quietly skipped.
        for (const id of missing) {
          const write = metadataOnlyChunks.find((w) => w.id === id);
          if (write) chunkUpserts.push(write);
        }
      }

      if (chunkUpserts.length > 0) {
        this.logger.info(`Upserting ${chunkUpserts.length} chunk${chunkUpserts.length === 1 ? "" : "s"} to Upstash Vector...`);

        for (const write of chunkUpserts) {
          if (write.data.length > 2000) {
            this.logger.warn(
              `Chunk ${write.id} text is ${write.data.length} chars (~${Math.round(write.data.length / 4)} tokens), which may exceed the 512-token model limit and be silently truncated.`
            );
          }
        }

        await this.store.upsertChunks(
          chunkUpserts.map((w) => ({ id: w.id, data: w.data, metadata: w.metadata })),
          scope
        );
        this.logger.event("upserted", { count: chunkUpserts.length });
      }

      documentsUpserted = chunkUpserts.length + chunkMetadataRefreshed;
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
    if (!writesBlocked) {
      if (chunksChanged > 0) {
        this.logger.info(`Wrote ${documentsUpserted} record${documentsUpserted === 1 ? "" : "s"} (${stageTimingsMs["upsert"]}ms)`);
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
      !writesBlocked &&
      !retainedCustomRecords &&
      runWarnings.every((warning) => warning.kind === "chunks-limited");

    if (this.config.llmsTxt.enable && !options.dryRun) {
      if (pageSetComplete) {
        const llmsStart = stageStart();
        await writeLlmsTxt(pages, this.config, this.cwd, this.logger);
        stageEnd("llms_txt", llmsStart);
      } else {
        // Name the cause. "May be incomplete" on its own sends people looking
        // for a bug, and the custom-record case in particular is a standing
        // condition they have to act on rather than a transient hiccup.
        const cause = writesBlocked
          ? "the run wrote nothing to the index"
          : retainedCustomRecords
            ? "the index holds custom records this run was not given, so the exported list " +
              "would drop them — pass customRecords to refresh the exports"
            : `this run's page list is incomplete (${runWarnings
                .filter((warning) => warning.kind !== "chunks-limited")
                .map((warning) => warning.kind)
                .join(", ")})`;
        this.logger.warn(`Keeping the existing llms.txt: ${cause}.`);
      }
    }

    this.logger.info("Done.");

    const stats: IndexStats = {
      pagesProcessed: pages.length,
      pagesChanged,
      pagesDeleted,
      chunksTotal: chunks.length,
      chunksChanged,
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
