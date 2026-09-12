import { QueryMode, FusionAlgorithm } from "@upstash/vector";
import type { Index } from "@upstash/vector";
import type {
  PageHit,
  PageRecord,
  Scope,
  ScopeInfo,
  VectorHit
} from "../types";
import { SearchSocketError } from "../errors";
import {
  INDEX_SCHEMA_VERSION,
  chunkId,
  filterStringLiteral,
  groupFilter,
  logicalKeyFromId,
  pageId,
  recordBelongsToScope,
  recordPrefix,
  scopeFilterClauses,
  urlFromPageId
} from "./ids";

/**
 * Records per write/delete/fetch request. Upstash bounds both request size and
 * item count, and chunk metadata can be large, so this stays conservative.
 */
const DEFAULT_BATCH_SIZE = 90;
/**
 * Kept low deliberately: the Upstash SDK already retries *network* failures up
 * to 5 times internally. This layer exists for the errors it does not retry —
 * HTTP error responses such as 429 and 5xx, which surface as UpstashError. A
 * larger value here multiplies with the SDK's own attempts.
 */
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 200;
/**
 * Metadata-only updates go one record per request — Upstash's `update` takes a
 * single vector, unlike `upsert`. Overlapping a few keeps a large refresh from
 * being one serial round trip per record without burying the endpoint.
 */
const METADATA_UPDATE_CONCURRENCY = 8;

/**
 * Characters GLOB reads as pattern syntax. Upstash documents no escape sequence
 * for them, so a path prefix containing one cannot be turned into a pattern
 * that provably means what the caller wrote — the same reason
 * `filterStringLiteral` rejects quotes instead of guessing an escape. Such a
 * prefix is simply not pushed down; the caller re-checks it locally.
 */
const GLOB_METACHARS = /[*?[\]]/;

/**
 * Caller-supplied retrieval constraints the backend can apply itself, instead
 * of the caller trimming an already-cut global candidate window.
 *
 * Deliberately a typed option rather than more text folded into `filter`:
 * ownership clauses and caller constraints stay separate expressions, so no
 * caller value can widen what a query is allowed to see.
 *
 * These narrow the candidate set; they are not a guarantee. A value the filter
 * grammar cannot express is not sent at all — `planRetrievalConstraints`
 * reports that as `complete: false` — so the caller remains responsible for
 * enforcing the constraint on the records it gets back, with
 * `matchesPathPrefix` and `matchesTags`. Ownership isolation is the store's
 * job and is never delegated this way.
 */
export interface RetrievalConstraints {
  /** Segment prefix on `url`: `/docs` selects `/docs` and `/docs/...`, not `/docsmith`. */
  pathPrefix?: string;
  /** Every tag must be present on the record — AND across tags, not OR. */
  tags?: string[];
}

/** Does `url` sit at or under `prefix`, counting whole path segments? */
export function matchesPathPrefix(url: string, prefix: string): boolean {
  if (prefix === "/") return true;
  return url === prefix || url.startsWith(`${prefix}/`);
}

/** Does a record carry every requested tag? */
export function matchesTags(recordTags: string[], tags: string[]): boolean {
  return tags.every((tag) => recordTags.includes(tag));
}

function pathPrefixClause(prefix: string): string | null {
  if (GLOB_METACHARS.test(prefix)) return null;
  try {
    // Parenthesised because it contains an OR: AND binds tighter than OR in
    // Upstash's grammar, so a bare disjunction here would escape the scope
    // clauses it is joined to and match every project.
    return (
      `(url = ${filterStringLiteral(prefix, "path prefix")}` +
      ` OR url GLOB ${filterStringLiteral(`${prefix}/*`, "path prefix")})`
    );
  } catch {
    // A quote or backslash in the prefix; not expressible, not an error.
    return null;
  }
}

/**
 * Translate retrieval constraints into backend filter clauses.
 *
 * `complete` is false when a constraint could not be expressed, which tells the
 * caller the backend result is still a superset and that recall depends on a
 * bounded overfetch. `matchesPathPrefix`/`matchesTags` above and the clauses
 * here describe exactly the same sets: a filter that means one thing in the
 * backend and another in JS would be worse than no pushdown at all.
 */
export function planRetrievalConstraints(constraints: RetrievalConstraints): {
  clauses: string[];
  complete: boolean;
} {
  const clauses: string[] = [];
  let complete = true;

  const prefix = constraints.pathPrefix;
  // "/" constrains nothing, so it needs no clause and is never incomplete.
  if (prefix !== undefined && prefix !== "/") {
    const clause = pathPrefixClause(prefix);
    if (clause) {
      clauses.push(clause);
    } else {
      complete = false;
    }
  }

  for (const tag of constraints.tags ?? []) {
    // `tags` is stored as a string[], and CONTAINS tests array membership.
    try {
      clauses.push(`tags CONTAINS ${filterStringLiteral(tag, "tag")}`);
    } catch {
      // A quote or backslash in the tag; the caller's local predicate still
      // enforces it.
      complete = false;
    }
  }

  return { clauses, complete };
}

/** Coerce an untrusted numeric option to a finite integer inside [min, max]. */
function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.floor(value), max));
}

/** Flat metadata stored alongside each chunk vector in Upstash Vector */
interface ChunkVectorMetadata {
  projectId: string;
  scopeName: string;
  custom?: boolean;
  /** Identity-layout version; see INDEX_SCHEMA_VERSION. */
  schemaVersion?: number;
  /** Logical chunk key, i.e. the record ID minus its scope prefix. */
  chunkKey?: string;
  type: string;
  url: string;
  path: string;
  title: string;
  sectionTitle: string;
  headingPath: string;
  snippet: string;
  chunkText: string;
  tags: string[];
  ordinal: number;
  contentHash: string;
  depth: number;
  incomingLinks: number;
  routeFile: string;
  description: string;
  keywords: string[];
  publishedAt?: number | null;
  incomingAnchorText: string;
  [key: string]: unknown;
}

/** Flat metadata stored alongside each page vector in Upstash Vector */
/** One entry of the page inventory returned by `getPageHashes`. */
export interface PageHashEntry {
  contentHash: string;
  /**
   * Fingerprint of the persisted metadata projection. Absent on records written
   * before the two fingerprints were split, which callers must read as "the
   * metadata needs refreshing once" rather than as "the text changed".
   */
  metadataHash?: string;
  custom: boolean;
}

/** One entry of the chunk inventory returned by `fetchContentHashesForKeys`. */
export interface ChunkHashEntry {
  contentHash: string;
  /** Absent on pre-split records; see PageHashEntry.metadataHash. */
  metadataHash?: string;
}

interface PageVectorMetadata {
  projectId: string;
  scopeName: string;
  custom?: boolean;
  incomingAnchorText?: string;
  weight?: number | null;
  /** Identity-layout version; see INDEX_SCHEMA_VERSION. */
  schemaVersion?: number;
  type: string;
  title: string;
  url: string;
  description: string;
  keywords: string[];
  summary: string;
  tags: string[];
  routeFile: string;
  routeResolution: string;
  incomingLinks: number;
  outgoingLinks: number;
  outgoingLinkUrls?: string[];
  depth: number;
  indexedAt: string;
  contentHash: string;
  publishedAt?: number | null;
  [key: string]: unknown;
}

/**
 * Reassemble an approximation of a page's markdown from its indexed chunks.
 *
 * This is deliberately not the canonical source. Chunks are stored to be
 * embedded, not to round-trip: they may include a synthetic page-summary chunk,
 * overlap text repeated between adjacent chunks, a prepended title (stripped
 * below), and text truncated at the metadata size cap. Callers must treat the
 * result as a faithful-enough reading copy, never as the exact source, and
 * nothing should promise byte-exact markdown on top of it.
 */
function reconstructMarkdownFromChunks(
  chunks: Array<{ chunkText: string; ordinal: number; sectionTitle: string; headingPath: string[] }>,
  pageTitle: string
): string {
  if (chunks.length === 0) return "";

  const parts: string[] = [];

  for (const chunk of chunks) {
    let text = chunk.chunkText;

    // Strip the prepended title prefix added by buildEmbeddingText().
    // Format is: "{pageTitle} — {sectionTitle}\n\n{content}" or "{pageTitle}\n\n{content}"
    const prefixWithSection = `${pageTitle} — ${chunk.sectionTitle}\n\n`;
    const prefixWithoutSection = `${pageTitle}\n\n`;

    if (chunk.sectionTitle && text.startsWith(prefixWithSection)) {
      text = text.slice(prefixWithSection.length);
    } else if (text.startsWith(prefixWithoutSection)) {
      text = text.slice(prefixWithoutSection.length);
    }

    parts.push(text.trim());
  }

  return parts.join("\n\n");
}

export interface UpstashSearchStoreOptions {
  index: Index;
  pagesNamespace: string;
  chunksNamespace: string;
  /** Records per request. Defaults to 90; capped at 500. */
  batchSize?: number;
  /**
   * Retries for transient failures only. Defaults to 2; 0 disables retrying.
   * The Upstash SDK separately retries network failures 5 times on its own.
   */
  maxRetries?: number;
  /** First backoff delay in ms; doubles per attempt, plus jitter. Defaults to 200. */
  retryBaseMs?: number;
}

/**
 * Distinguish "this namespace has never been written to" from every other
 * backend failure. Only the former may be treated as empty state — an auth
 * error, timeout, or rate limit reported as "no records" can drive a caller
 * into deleting a perfectly healthy index.
 *
 * In practice this rarely fires: Upstash creates namespaces implicitly on
 * first write, and a read against one that does not exist returns an empty
 * result rather than an error. It is kept as a defensive fallback so a future
 * change in that behaviour cannot break first-run indexing.
 */
export function isMissingNamespaceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /namespace .*(not found|does not exist)|no such namespace/i.test(message);
}

/**
 * The distinct backend conditions a caller may need to act on differently.
 * Collapsing all of them to an empty result — as this store previously did —
 * makes an outage indistinguishable from an empty index.
 */
export type StorageErrorCode =
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "INVALID_FILTER"
  | "NAMESPACE_MISSING"
  | "SERVICE_UNAVAILABLE"
  | "UNKNOWN";

/**
 * Classify a raw SDK/network error into an actionable category.
 *
 * Classification is message-driven because `UpstashError` carries only the
 * server's `error` string — it has no status code. The `status` check below
 * still runs for errors raised by anything else in the stack (a fetch polyfill,
 * a proxy) that does attach one.
 */
export function classifyStorageError(error: unknown): StorageErrorCode {
  if (isMissingNamespaceError(error)) return "NAMESPACE_MISSING";

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const status =
    typeof (error as { status?: unknown })?.status === "number"
      ? (error as { status: number }).status
      : undefined;

  // A status code, when present, is more reliable than message matching, so it
  // decides first. Otherwise a 502 whose body happens to mention "filter" would
  // be classified as a client error and never retried.
  if (status !== undefined) {
    if (status === 401 || status === 403) return "UNAUTHORIZED";
    if (status === 429) return "RATE_LIMITED";
    if (status === 408 || status === 504) return "TIMEOUT";
    if (status >= 500) return "SERVICE_UNAVAILABLE";
  }

  if (/\bunauthori[sz]ed\b|\bforbidden\b|invalid token|invalid credential/.test(message)) {
    return "UNAUTHORIZED";
  }
  if (/rate ?limit|too many requests|\bquota\b/.test(message)) {
    return "RATE_LIMITED";
  }
  // Deliberately excludes "abort": an aborted request is the caller cancelling,
  // and retrying a cancellation is wrong.
  if (/timed? ?out\b|\betimedout\b|\bgateway timeout\b/.test(message)) return "TIMEOUT";
  // Word-bounded: an unbounded /parse/ matched "sparseVector", turning an
  // unrelated vector error into a non-retryable filter error.
  if (/\bfilter\b|\bsyntax\b|\bparse error\b|failed to parse/.test(message)) {
    return "INVALID_FILTER";
  }
  if (
    /\bunavailable\b|\beconnrefused\b|\benotfound\b|\beconnreset\b|socket hang up|fetch failed|\bnetwork\b|internal server error|bad gateway|service unavailable|exhausted all retries/.test(
      message
    )
  ) {
    return "SERVICE_UNAVAILABLE";
  }
  return "UNKNOWN";
}

/**
 * Wrap a backend failure as a typed SearchSocketError.
 *
 * The original error is preserved as `cause` for logs; the public message
 * carries only the operation and category, never the raw SDK text, which can
 * contain a credential or an internal URL.
 */
export function toStorageError(operation: string, error: unknown): SearchSocketError {
  const code = classifyStorageError(error);
  const status = code === "UNAUTHORIZED" ? 500 : code === "RATE_LIMITED" ? 429 : 503;
  return new SearchSocketError(
    code === "RATE_LIMITED" ? "RATE_LIMITED" : "VECTOR_BACKEND_UNAVAILABLE",
    `Vector backend ${operation} failed (${code}).`,
    { status, cause: error }
  );
}


export class UpstashSearchStore {
  private readonly index: Index;
  private readonly pagesNs: ReturnType<Index["namespace"]>;
  private readonly chunksNs: ReturnType<Index["namespace"]>;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(opts: UpstashSearchStoreOptions) {
    this.index = opts.index;
    this.pagesNs = opts.index.namespace(opts.pagesNamespace);
    this.chunksNs = opts.index.namespace(opts.chunksNamespace);
    // Was a hardcoded 90 in nine separate places. Bounded to stay well within
    // Upstash's per-request limits even with large chunk metadata.
    // Clamped here as well as in the config schema: the store is exported, so
    // a direct consumer can pass anything. A NaN batch size produced an empty
    // first batch and silently wrote nothing; a negative retry count skipped
    // the operation entirely.
    this.batchSize = clampInt(opts.batchSize, DEFAULT_BATCH_SIZE, 1, 500);
    this.maxRetries = clampInt(opts.maxRetries, DEFAULT_MAX_RETRIES, 0, 10);
    this.retryBaseMs = clampInt(opts.retryBaseMs, DEFAULT_RETRY_BASE_MS, 1, 60_000);
  }

  /**
   * Retry a transient failure with exponential backoff and jitter.
   *
   * Only rate limits, timeouts, and service errors are retried. An
   * authorization or filter-syntax failure is retried zero times: it will fail
   * identically every time, and retrying only delays the error the caller needs.
   */
  private async withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    // Safe to retry: every write is an upsert keyed by a deterministic record
    // ID, and every delete names explicit IDs, so re-applying a batch that may
    // have partially succeeded converges on the same state.
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const code = classifyStorageError(error);
        const retryable =
          code === "RATE_LIMITED" || code === "TIMEOUT" || code === "SERVICE_UNAVAILABLE";
        if (!retryable || attempt === this.maxRetries) break;

        const backoff = this.retryBaseMs * 2 ** attempt;
        // Jitter so concurrent workers do not retry in lockstep.
        const delay = backoff + Math.floor(Math.random() * backoff);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw toStorageError(operation, lastError);
  }

  async upsertChunks(
    chunks: Array<{
      id: string;
      data: string;
      metadata: Record<string, unknown>;
    }>,
    scope: Scope
  ): Promise<void> {
    if (chunks.length === 0) return;

    const BATCH_SIZE = this.batchSize;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      await this.withRetry("upsert chunks", () => this.chunksNs.upsert(
        // `c.id` is the logical chunk key; the physical record ID carries the
        // project, scope, and schema version so two tenants sharing one index
        // cannot overwrite each other.
        batch.map((c) => ({
          id: chunkId(scope, c.id),
          data: c.data,
          metadata: {
            ...c.metadata,
            chunkKey: c.id,
            projectId: scope.projectId,
            scopeName: scope.scopeName,
            schemaVersion: INDEX_SCHEMA_VERSION,
            type: (c.metadata.type as string) || "chunk"
          }
        }))
      ));
    }
  }

  /**
   * Replace a record's metadata without re-sending the text it was embedded
   * from.
   *
   * The point of the separate metadata fingerprint: a tag edit, a moved route
   * file or a reordered section changes what is stored but not what should be
   * embedded, and `upsert` would re-embed all of it. `OVERWRITE` rather than
   * `PATCH` because the caller passes the complete projection, so a field that
   * has been removed must genuinely disappear rather than linger.
   *
   * Returns the logical keys of records the backend reported no update for —
   * i.e. records that no longer exist. Those cannot be patched into existence,
   * so the caller re-upserts them rather than leaving the page short a section.
   */
  async updateChunkMetadata(
    items: Array<{ id: string; metadata: Record<string, unknown> }>,
    scope: Scope
  ): Promise<string[]> {
    return this.updateMetadata(this.chunksNs, "update chunk metadata", items, (item) => ({
      recordId: chunkId(scope, item.id),
      metadata: {
        ...item.metadata,
        chunkKey: item.id,
        projectId: scope.projectId,
        scopeName: scope.scopeName,
        schemaVersion: INDEX_SCHEMA_VERSION,
        type: (item.metadata.type as string) || "chunk"
      }
    }));
  }

  /** Page-record counterpart of `updateChunkMetadata`; `id` is the page URL. */
  async updatePageMetadata(
    items: Array<{ id: string; metadata: Record<string, unknown> }>,
    scope: Scope
  ): Promise<string[]> {
    return this.updateMetadata(this.pagesNs, "update page metadata", items, (item) => ({
      recordId: pageId(scope, item.id),
      metadata: {
        ...item.metadata,
        projectId: scope.projectId,
        scopeName: scope.scopeName,
        schemaVersion: INDEX_SCHEMA_VERSION,
        type: "page"
      }
    }));
  }

  private async updateMetadata(
    ns: ReturnType<Index["namespace"]>,
    operation: string,
    items: Array<{ id: string; metadata: Record<string, unknown> }>,
    toRecord: (item: { id: string; metadata: Record<string, unknown> }) => {
      recordId: string;
      metadata: Record<string, unknown>;
    }
  ): Promise<string[]> {
    if (items.length === 0) return [];

    const missing: string[] = [];
    for (let i = 0; i < items.length; i += METADATA_UPDATE_CONCURRENCY) {
      const window = items.slice(i, i + METADATA_UPDATE_CONCURRENCY);
      const results = await Promise.all(
        window.map(async (item) => {
          const record = toRecord(item);
          const result = await this.withRetry(operation, () =>
            ns.update({
              id: record.recordId,
              metadata: record.metadata,
              metadataUpdateMode: "OVERWRITE"
            })
          );
          return result.updated > 0;
        })
      );
      results.forEach((updated, offset) => {
        if (!updated) missing.push(window[offset]!.id);
      });
    }

    return missing;
  }

  async search(
    data: string,
    opts: {
      limit: number;
      filter?: string;
    } & RetrievalConstraints,
    scope: Scope
  ): Promise<VectorHit[]> {
    const filterParts = [...scopeFilterClauses(scope)];
    filterParts.push(...planRetrievalConstraints(opts).clauses);
    if (opts.filter) {
      filterParts.push(groupFilter(opts.filter));
    }

    let results;
    try {
      results = await this.chunksNs.query<ChunkVectorMetadata>({
        data,
        topK: opts.limit,
        includeMetadata: true,
        filter: filterParts.join(" AND "),
        queryMode: QueryMode.HYBRID,
        fusionAlgorithm: FusionAlgorithm.DBSF
      });
    } catch (error) {
      if (!isMissingNamespaceError(error)) throw toStorageError("chunk query", error);
      return [];
    }

    return results
      // Defence in depth: the server-side filter should already have excluded
      // these, but a filter-syntax surprise must not leak another tenant's
      // record into results.
      .filter((doc) => recordBelongsToScope(doc.metadata, scope))
      .map((doc) => ({
      // Logical chunk key, so the value round-trips back into deleteByIds().
      id: logicalKeyFromId(String(doc.id), scope, "chunk") ?? String(doc.id),
      score: doc.score,
      metadata: {
        projectId: doc.metadata?.projectId ?? "",
        scopeName: doc.metadata?.scopeName ?? "",
        url: doc.metadata?.url ?? "",
        path: doc.metadata?.path ?? "",
        title: doc.metadata?.title ?? "",
        sectionTitle: doc.metadata?.sectionTitle ?? "",
        headingPath: doc.metadata?.headingPath
          ? String(doc.metadata.headingPath).split(" > ").filter(Boolean)
          : [],
        snippet: doc.metadata?.snippet ?? "",
        chunkText: doc.metadata?.chunkText ?? "",
        ordinal: doc.metadata?.ordinal ?? 0,
        contentHash: doc.metadata?.contentHash ?? "",
        depth: doc.metadata?.depth ?? 0,
        incomingLinks: doc.metadata?.incomingLinks ?? 0,
        routeFile: doc.metadata?.routeFile ?? "",
        tags: doc.metadata?.tags ?? [],
        description: doc.metadata?.description || undefined,
        keywords: doc.metadata?.keywords?.length
          ? doc.metadata.keywords
          : undefined,
        publishedAt: typeof doc.metadata?.publishedAt === "number" ? doc.metadata.publishedAt : undefined,
        incomingAnchorText: doc.metadata?.incomingAnchorText || undefined
      }
    }));
  }

  async searchChunksByUrl(
    data: string,
    url: string,
    opts: {
      limit: number;
      filter?: string;
      /**
       * Narrows to chunks carrying every tag. There is no `pathPrefix` here on
       * purpose: `url` already pins the page, so a prefix could only contradict
       * it, and an option a method ignores is worse than one it does not offer.
       */
      tags?: string[];
    },
    scope: Scope
  ): Promise<VectorHit[]> {
    const filterParts = [...scopeFilterClauses(scope)];

    // A URL containing a quote or backslash cannot be expressed as a filter
    // literal, because Upstash defines no escape sequence for either. Rather
    // than fail — the page is perfectly valid, e.g. /blog/it's-here — fall back
    // to over-fetching and matching the URL locally.
    let urlFilterable = true;
    try {
      filterParts.push(`url = ${filterStringLiteral(url, "url")}`);
    } catch {
      // Not a backend failure — the URL simply cannot be expressed as a literal.
      urlFilterable = false;
    }

    // A tag that cannot be expressed as a filter literal is enforced locally
    // below instead. Discarding this flag meant the query came back unfiltered
    // and was then cut to `limit` before anything checked the tags, so a
    // matching chunk sitting behind `limit` non-matching ones disappeared.
    const tagPlan = planRetrievalConstraints({ tags: opts.tags });
    filterParts.push(...tagPlan.clauses);

    if (opts.filter) {
      filterParts.push(groupFilter(opts.filter));
    }

    // Anything the backend could not be asked to exclude has to be excluded
    // here, which only works if enough candidates were fetched to survive it.
    const filteredLocally = !urlFilterable || !tagPlan.complete;

    let results;
    try {
      results = await this.chunksNs.query<ChunkVectorMetadata>({
        data,
        topK: filteredLocally ? Math.min(opts.limit * 10, 200) : opts.limit,
        includeMetadata: true,
        filter: filterParts.join(" AND "),
        queryMode: QueryMode.HYBRID,
        fusionAlgorithm: FusionAlgorithm.DBSF
      });
    } catch (error) {
      if (!isMissingNamespaceError(error)) throw toStorageError("chunk query by url", error);
      return [];
    }

    return results
      // Defence in depth: the server-side filter should already have excluded
      // these, but a filter-syntax surprise must not leak another tenant's
      // record into results. The URL is always re-checked locally so the
      // unfilterable-URL fallback above cannot return another page's chunks.
      .filter(
        (doc) =>
          recordBelongsToScope(doc.metadata, scope) &&
          doc.metadata?.url === url &&
          // Applied before the slice, so `limit` counts chunks that actually
          // match rather than chunks that merely came back.
          matchesTags(doc.metadata?.tags ?? [], opts.tags ?? [])
      )
      .slice(0, opts.limit)
      .map((doc) => ({
      // Logical chunk key, so the value round-trips back into deleteByIds().
      id: logicalKeyFromId(String(doc.id), scope, "chunk") ?? String(doc.id),
      score: doc.score,
      metadata: {
        projectId: doc.metadata?.projectId ?? "",
        scopeName: doc.metadata?.scopeName ?? "",
        url: doc.metadata?.url ?? "",
        path: doc.metadata?.path ?? "",
        title: doc.metadata?.title ?? "",
        sectionTitle: doc.metadata?.sectionTitle ?? "",
        headingPath: doc.metadata?.headingPath
          ? String(doc.metadata.headingPath).split(" > ").filter(Boolean)
          : [],
        snippet: doc.metadata?.snippet ?? "",
        chunkText: doc.metadata?.chunkText ?? "",
        ordinal: doc.metadata?.ordinal ?? 0,
        contentHash: doc.metadata?.contentHash ?? "",
        depth: doc.metadata?.depth ?? 0,
        incomingLinks: doc.metadata?.incomingLinks ?? 0,
        routeFile: doc.metadata?.routeFile ?? "",
        tags: doc.metadata?.tags ?? [],
        description: doc.metadata?.description || undefined,
        keywords: doc.metadata?.keywords?.length
          ? doc.metadata.keywords
          : undefined,
        publishedAt: typeof doc.metadata?.publishedAt === "number" ? doc.metadata.publishedAt : undefined,
        incomingAnchorText: doc.metadata?.incomingAnchorText || undefined
      }
    }));
  }

  async searchPagesByText(
    data: string,
    opts: {
      limit: number;
      filter?: string;
    } & RetrievalConstraints,
    scope: Scope
  ): Promise<PageHit[]> {
    return this.queryPages({ data }, opts, scope);
  }

  async searchPagesByVector(
    vector: number[],
    opts: {
      limit: number;
      filter?: string;
    } & RetrievalConstraints,
    scope: Scope
  ): Promise<PageHit[]> {
    return this.queryPages({ vector }, opts, scope);
  }

  private async queryPages(
    input: { data: string } | { vector: number[] },
    opts: {
      limit: number;
      filter?: string;
    } & RetrievalConstraints,
    scope: Scope
  ): Promise<PageHit[]> {
    const filterParts = [...scopeFilterClauses(scope)];
    filterParts.push(...planRetrievalConstraints(opts).clauses);
    if (opts.filter) {
      filterParts.push(groupFilter(opts.filter));
    }

    let results;
    try {
      results = await this.pagesNs.query<PageVectorMetadata>({
        ...input,
        topK: opts.limit,
        includeMetadata: true,
        filter: filterParts.join(" AND "),
        queryMode: QueryMode.HYBRID,
        fusionAlgorithm: FusionAlgorithm.DBSF
      });
    } catch (error) {
      // A query failure is not "no results". Returning [] here made an outage
      // indistinguishable from an empty index, and search silently answered
      // every query with nothing.
      if (!isMissingNamespaceError(error)) throw toStorageError("page query", error);
      return [];
    }

    return results
      .filter((doc) => recordBelongsToScope(doc.metadata, scope))
      .map((doc) => ({
      // Page URL, so the value round-trips back into deletePagesByIds().
      id: doc.metadata?.url ?? urlFromPageId(String(doc.id), scope) ?? String(doc.id),
      score: doc.score,
      title: doc.metadata?.title ?? "",
      url: doc.metadata?.url ?? "",
      description: doc.metadata?.description ?? "",
      tags: doc.metadata?.tags ?? [],
      depth: doc.metadata?.depth ?? 0,
      incomingLinks: doc.metadata?.incomingLinks ?? 0,
      routeFile: doc.metadata?.routeFile ?? "",
      publishedAt: typeof doc.metadata?.publishedAt === "number" ? doc.metadata.publishedAt : undefined,
      incomingAnchorText: doc.metadata?.incomingAnchorText || undefined,
      weight: typeof doc.metadata?.weight === "number" ? doc.metadata.weight : undefined
    }));
  }

  /** `keys` are logical chunk keys, not physical record IDs. */
  async deleteByIds(keys: string[], scope: Scope): Promise<void> {
    if (keys.length === 0) return;

    const BATCH_SIZE = this.batchSize;
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE);
      // Encoding here means a caller cannot delete outside its own scope even
      // if it passes an arbitrary key.
      await this.withRetry("delete chunks", () =>
        this.chunksNs.delete(batch.map((key) => chunkId(scope, key)))
      );
    }
  }

  async deleteScope(scope: Scope): Promise<void> {
    // Scan both namespaces for vectors matching this scope, then delete
    for (const [ns, type] of [
      [this.chunksNs, "chunk"],
      [this.pagesNs, "page"]
    ] as const) {
      const ids: string[] = [];
      let cursor = "0";
      try {
        for (;;) {
          const result = await ns.range<ChunkVectorMetadata>({
            cursor,
            prefix: recordPrefix(scope, type),
            limit: 100,
            includeMetadata: true
          });
          for (const doc of result.vectors) {
            if (
              recordBelongsToScope(doc.metadata, scope)
            ) {
              ids.push(String(doc.id));
            }
          }
          if (!result.nextCursor || result.nextCursor === "0") break;
          cursor = result.nextCursor;
        }
      } catch (error) {
        // A partial scan would delete only part of the scope while reporting
        // success, so anything other than an absent namespace must fail.
        if (!isMissingNamespaceError(error)) throw toStorageError("scan for deletion", error);
      }

      if (ids.length > 0) {
        const BATCH_SIZE = this.batchSize;
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
          const batch = ids.slice(i, i + BATCH_SIZE);
          await this.withRetry("delete scoped records", () => ns.delete(batch));
        }
      }
    }
  }

  async listScopes(projectId: string): Promise<ScopeInfo[]> {
    const scopeMap = new Map<string, number>();
    // Latest `indexedAt` actually observed on a page record for each scope.
    // Previously this method stamped `new Date()` on every scope, which made
    // every scope look freshly indexed and rendered TTL pruning meaningless.
    const lastIndexed = new Map<string, string>();

    for (const ns of [this.chunksNs, this.pagesNs]) {
      let cursor = "0";
      try {
        for (;;) {
          const result = await ns.range<ChunkVectorMetadata & { indexedAt?: string }>({
            cursor,
            limit: 100,
            includeMetadata: true
          });
          for (const doc of result.vectors) {
            if (doc.metadata?.projectId === projectId) {
              const scopeName = doc.metadata.scopeName ?? "";
              scopeMap.set(scopeName, (scopeMap.get(scopeName) ?? 0) + 1);

              const indexedAt = doc.metadata.indexedAt;
              if (typeof indexedAt === "string" && !Number.isNaN(Date.parse(indexedAt))) {
                const current = lastIndexed.get(scopeName);
                if (!current || Date.parse(indexedAt) > Date.parse(current)) {
                  lastIndexed.set(scopeName, indexedAt);
                }
              }
            }
          }
          if (!result.nextCursor || result.nextCursor === "0") break;
          cursor = result.nextCursor;
        }
      } catch (error) {
        // A namespace that has never been written to is genuinely absent and
        // contributes nothing. Any other failure means this listing is
        // incomplete, and callers such as `prune` make deletion decisions from
        // it — so surface it rather than reporting a truncated scope list.
        if (!isMissingNamespaceError(error)) {
          throw toStorageError(`list scopes for project "${projectId}"`, error);
        }
      }
    }

    return [...scopeMap.entries()].map(([scopeName, count]) => ({
      projectId,
      scopeName,
      // "unknown" is truthful: no page record in this scope carried a
      // parseable indexedAt. Callers must not treat it as "old".
      lastIndexedAt: lastIndexed.get(scopeName) ?? "unknown",
      documentCount: count
    }));
  }

  async getContentHashes(scope: Scope): Promise<Map<string, string>> {
    return this.scanHashes(this.chunksNs, scope);
  }

  /**
   * Fetch content hashes for a specific set of chunk keys using direct fetch()
   * instead of range(). This avoids potential issues with range() returning
   * vectors from the wrong namespace on hybrid indexes.
   */
  async fetchContentHashesForKeys(keys: string[], scope: Scope): Promise<Map<string, ChunkHashEntry>> {
    const map = new Map<string, ChunkHashEntry>();
    if (keys.length === 0) return map;

    const BATCH_SIZE = this.batchSize;
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE);
      try {
        const results = await this.chunksNs.fetch<ChunkVectorMetadata>(
          batch.map((key) => chunkId(scope, key)),
          { includeMetadata: true }
        );
        for (const doc of results) {
          // A direct fetch bypasses the metadata filter, so verify ownership
          // explicitly rather than trusting the ID.
          if (doc && recordBelongsToScope(doc.metadata, scope) && doc.metadata?.contentHash) {
            const key = logicalKeyFromId(String(doc.id), scope, "chunk");
            if (key !== null) {
              map.set(key, {
                contentHash: doc.metadata.contentHash,
                metadataHash:
                  typeof doc.metadata.metadataHash === "string" ? doc.metadata.metadataHash : undefined
              });
            }
          }
        }
      } catch (error) {
        if (!isMissingNamespaceError(error)) throw toStorageError("fetch chunk hashes", error);
      }
    }

    return map;
  }

  /**
   * Scan all IDs in the chunks namespace for this scope.
   * Used for deletion detection (finding stale chunk keys).
   */
  /**
   * Logical chunk keys in this scope, each with whether it belongs to a
   * caller-supplied custom record. The pipeline needs the provenance: a run
   * that supplies no custom records must leave their chunks alone, exactly as
   * it leaves their page records alone.
   */
  async scanChunkIds(scope: Scope): Promise<Map<string, boolean>> {
    const ids = new Map<string, boolean>();
    let cursor = "0";

    try {
      for (;;) {
        // Scoped by ID prefix so the scan costs what this scope holds rather
        // than what every project sharing the index holds.
        const result = await this.chunksNs.range<ChunkVectorMetadata>({
          cursor,
          prefix: recordPrefix(scope, "chunk"),
          limit: 100,
          includeMetadata: true
        });
        for (const doc of result.vectors) {
          if (!recordBelongsToScope(doc.metadata, scope)) continue;
          const key = logicalKeyFromId(String(doc.id), scope, "chunk");
          if (key !== null) ids.set(key, doc.metadata?.custom === true);
        }
        if (!result.nextCursor || result.nextCursor === "0") break;
        cursor = result.nextCursor;
      }
    } catch (error) {
      if (!isMissingNamespaceError(error)) throw toStorageError("scan chunk ids", error);
    }

    return ids;
  }

  private async scanHashes(
    ns: ReturnType<Index["namespace"]>,
    scope: Scope
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    let cursor = "0";

    try {
      for (;;) {
        const result = await ns.range<ChunkVectorMetadata>({
          cursor,
          prefix: recordPrefix(scope, "chunk"),
          limit: 100,
          includeMetadata: true
        });
        for (const doc of result.vectors) {
          if (!recordBelongsToScope(doc.metadata, scope) || !doc.metadata?.contentHash) continue;
          // Keyed by logical chunk key so the result is comparable with the
          // keys the chunker produces, rather than by physical record ID.
          const key = logicalKeyFromId(String(doc.id), scope, "chunk");
          if (key !== null) map.set(key, doc.metadata.contentHash);
        }
        if (!result.nextCursor || result.nextCursor === "0") break;
        cursor = result.nextCursor;
      }
    } catch (error) {
      if (!isMissingNamespaceError(error)) throw toStorageError("scan content hashes", error);
    }

    return map;
  }

  async listPages(
    scope: Scope,
    opts?: { cursor?: string; limit?: number; pathPrefix?: string }
  ): Promise<{
    pages: Array<{ url: string; title: string; description: string; routeFile: string }>;
    nextCursor?: string;
  }> {
    let cursor = opts?.cursor ?? "0";
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));

    const pages: Array<{ url: string; title: string; description: string; routeFile: string }> = [];
    // Bounds the work a single call can do when a path prefix matches almost
    // nothing, so an unfilterable request cannot walk the whole scope.
    const MAX_PAGES_SCANNED = 10;

    try {
      for (let scanned = 0; scanned < MAX_PAGES_SCANNED; scanned += 1) {
        // Request only what is still needed. Over-fetching would collect
        // records that the `limit` slice then discards, while the cursor
        // advanced past them — so those records would never be returned by any
        // subsequent call either. The backend cursor is opaque, so a partially
        // consumed page cannot be resumed.
        const result = await this.pagesNs.range<PageVectorMetadata>({
          cursor,
          prefix: recordPrefix(scope, "page"),
          limit: limit - pages.length,
          includeMetadata: true
        });

        for (const doc of result.vectors) {
          if (!recordBelongsToScope(doc.metadata, scope)) continue;
          const url = doc.metadata?.url ?? "";
          if (opts?.pathPrefix && !url.startsWith(opts.pathPrefix)) continue;
          pages.push({
            url,
            title: doc.metadata?.title ?? "",
            description: doc.metadata?.description ?? "",
            routeFile: doc.metadata?.routeFile ?? ""
          });
        }

        const exhausted = !result.nextCursor || result.nextCursor === "0";
        cursor = exhausted ? "" : result.nextCursor;

        // Keep reading until the page is full or the scope runs out. Returning
        // "whatever matched inside one backend page" meant a request for 50
        // pages could return 3 while thousands more matched, and the caller had
        // no way to tell that from the end of the list.
        if (exhausted || pages.length >= limit) break;
      }

      const response: {
        pages: Array<{ url: string; title: string; description: string; routeFile: string }>;
        nextCursor?: string;
      } = { pages };

      // A cursor is returned when records remain, including the case where the
      // local filter kept fewer than `limit` from a full backend page.
      if (cursor !== "" && cursor !== "0") {
        response.nextCursor = cursor;
      }

      return response;
    } catch (error) {
      if (isMissingNamespaceError(error)) return { pages: [] };
      throw toStorageError("list pages", error);
    }
  }

  /**
   * Content hash per indexed page URL, plus whether the page came from a
   * caller-supplied custom record. The pipeline needs the distinction: a run
   * that supplies no custom records must not treat previously-supplied ones as
   * removed.
   */
  async getPageHashes(scope: Scope): Promise<Map<string, PageHashEntry>> {
    const map = new Map<string, PageHashEntry>();
    let cursor = "0";

    try {
      for (;;) {
        const result = await this.pagesNs.range<PageVectorMetadata>({
          cursor,
          prefix: recordPrefix(scope, "page"),
          limit: 100,
          includeMetadata: true
        });
        for (const doc of result.vectors) {
          if (!recordBelongsToScope(doc.metadata, scope) || !doc.metadata?.contentHash) continue;
          // Keyed by URL: callers reason about pages by URL, and the physical
          // ID is an encoding detail of this store.
          const url = doc.metadata.url ?? urlFromPageId(String(doc.id), scope);
          if (url) {
            map.set(url, {
              contentHash: doc.metadata.contentHash,
              metadataHash: typeof doc.metadata.metadataHash === "string" ? doc.metadata.metadataHash : undefined,
              custom: doc.metadata.custom === true
            });
          }
        }
        if (!result.nextCursor || result.nextCursor === "0") break;
        cursor = result.nextCursor;
      }
    } catch (error) {
      // A genuinely absent namespace means no pages are indexed yet. Anything
      // else would make this look like an empty index, and the pipeline treats
      // an empty page inventory as "nothing to compare against".
      if (!isMissingNamespaceError(error)) {
        throw toStorageError(`read page hashes for scope "${scope.scopeName}"`, error);
      }
    }

    return map;
  }

  /** `urls` are page URLs, not physical record IDs. */
  async deletePagesByIds(urls: string[], scope: Scope): Promise<void> {
    if (urls.length === 0) return;

    const BATCH_SIZE = this.batchSize;
    for (let i = 0; i < urls.length; i += BATCH_SIZE) {
      const batch = urls.slice(i, i + BATCH_SIZE);
      await this.withRetry("delete pages", () =>
        this.pagesNs.delete(batch.map((url) => pageId(scope, url)))
      );
    }
  }

  async upsertPages(
    pages: Array<{
      id: string;
      data: string;
      metadata: Record<string, unknown>;
    }>,
    scope: Scope
  ): Promise<void> {
    if (pages.length === 0) return;

    const BATCH_SIZE = this.batchSize;
    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      const batch = pages.slice(i, i + BATCH_SIZE);
      await this.withRetry("upsert pages", () => this.pagesNs.upsert(
        // `p.id` is the page URL; the physical record ID carries project,
        // scope, and schema version.
        batch.map((p) => ({
          id: pageId(scope, p.id),
          data: p.data,
          metadata: {
            ...p.metadata,
            projectId: scope.projectId,
            scopeName: scope.scopeName,
            schemaVersion: INDEX_SCHEMA_VERSION,
            type: "page"
          }
        }))
      ));
    }
  }

  async getPage(url: string, scope: Scope): Promise<PageRecord | null> {
    try {
      const results = await this.pagesNs.fetch<PageVectorMetadata>([pageId(scope, url)], {
        includeMetadata: true
      });
      const doc = results[0];
      if (!doc || !doc.metadata) return null;

      // A direct fetch bypasses the metadata filter that protects queries.
      // Without this check, a record belonging to another project or scope —
      // or written under an older schema — would be returned as this scope's.
      if (!recordBelongsToScope(doc.metadata, scope)) return null;

      // Reconstruct markdown from chunks
      const chunks = await this.getChunksForPage(url, scope);
      const markdown = reconstructMarkdownFromChunks(chunks, doc.metadata.title);

      return {
        url: doc.metadata.url,
        title: doc.metadata.title,
        markdown,
        projectId: doc.metadata.projectId,
        scopeName: doc.metadata.scopeName,
        routeFile: doc.metadata.routeFile,
        routeResolution: doc.metadata.routeResolution as "exact" | "best-effort",
        incomingLinks: doc.metadata.incomingLinks,
        outgoingLinks: doc.metadata.outgoingLinks,
        outgoingLinkUrls: doc.metadata.outgoingLinkUrls ?? undefined,
        depth: doc.metadata.depth,
        tags: doc.metadata.tags ?? [],
        indexedAt: doc.metadata.indexedAt,
        summary: doc.metadata.summary || undefined,
        description: doc.metadata.description || undefined,
        keywords: doc.metadata.keywords?.length ? doc.metadata.keywords : undefined,
        publishedAt: typeof doc.metadata.publishedAt === "number" ? doc.metadata.publishedAt : undefined,
        incomingAnchorText: doc.metadata.incomingAnchorText || undefined,
        weight: typeof doc.metadata.weight === "number" ? doc.metadata.weight : undefined
      };
    } catch (error) {
      if (isMissingNamespaceError(error)) return null;
      throw toStorageError("get page", error);
    }
  }

  /**
   * Fetch all chunks belonging to a specific page URL, sorted by ordinal.
   * Used to reassemble an approximation of page markdown; see
   * reconstructMarkdownFromChunks for why it is not canonical.
   */
  async getChunksForPage(
    url: string,
    scope: Scope
  ): Promise<Array<{ chunkText: string; ordinal: number; sectionTitle: string; headingPath: string[] }>> {
    const chunks: Array<{ chunkText: string; ordinal: number; sectionTitle: string; headingPath: string[] }> = [];
    let cursor = "0";

    try {
      for (;;) {
        const result = await this.chunksNs.range<ChunkVectorMetadata>({
          cursor,
          prefix: recordPrefix(scope, "chunk"),
          limit: 100,
          includeMetadata: true
        });

        for (const doc of result.vectors) {
          if (
            recordBelongsToScope(doc.metadata, scope) &&
            doc.metadata?.url === url
          ) {
            chunks.push({
              chunkText: doc.metadata.chunkText ?? "",
              ordinal: doc.metadata.ordinal ?? 0,
              sectionTitle: doc.metadata.sectionTitle ?? "",
              headingPath: doc.metadata.headingPath
                ? String(doc.metadata.headingPath).split(" > ").filter(Boolean)
                : []
            });
          }
        }

        if (!result.nextCursor || result.nextCursor === "0") break;
        cursor = result.nextCursor;
      }
    } catch (error) {
      if (!isMissingNamespaceError(error)) throw toStorageError("scan page chunks", error);
    }

    return chunks.sort((a, b) => a.ordinal - b.ordinal);
  }

  async fetchPageWithVector(
    url: string,
    scope: Scope
  ): Promise<{ metadata: PageVectorMetadata; vector: number[] } | null> {
    try {
      const results = await this.pagesNs.fetch<PageVectorMetadata>([pageId(scope, url)], {
        includeMetadata: true,
        includeVectors: true
      });
      const doc = results[0];
      if (!doc || !doc.metadata || !doc.vector) return null;

      if (!recordBelongsToScope(doc.metadata, scope)) return null;

      return { metadata: doc.metadata, vector: doc.vector as number[] };
    } catch (error) {
      if (isMissingNamespaceError(error)) return null;
      throw toStorageError("fetch page vector", error);
    }
  }

  async fetchPagesBatch(
    urls: string[],
    scope: Scope
  ): Promise<Array<{ url: string; title: string; routeFile: string; outgoingLinkUrls: string[] }>> {
    if (urls.length === 0) return [];

    try {
      const out: Array<{ url: string; title: string; routeFile: string; outgoingLinkUrls: string[] }> = [];
      const results: Array<{ metadata?: PageVectorMetadata } | null> = [];

      // Batched: a page's outgoing-link list is uncapped, so related-page
      // retrieval could otherwise hand the backend thousands of IDs at once.
      const BATCH_SIZE = this.batchSize;
      for (let i = 0; i < urls.length; i += BATCH_SIZE) {
        const batch = urls.slice(i, i + BATCH_SIZE);
        const fetched = await this.pagesNs.fetch<PageVectorMetadata>(
          batch.map((url) => pageId(scope, url)),
          { includeMetadata: true }
        );
        results.push(...fetched);
      }

      for (const doc of results) {
        if (!doc || !doc.metadata) continue;
        if (!recordBelongsToScope(doc.metadata, scope)) continue;
        out.push({
          url: doc.metadata.url,
          title: doc.metadata.title,
          routeFile: doc.metadata.routeFile,
          outgoingLinkUrls: doc.metadata.outgoingLinkUrls ?? []
        });
      }
      return out;
    } catch (error) {
      if (isMissingNamespaceError(error)) return [];
      throw toStorageError("fetch pages", error);
    }
  }

  async deletePages(scope: Scope): Promise<void> {
    // Delete all page vectors for this scope
    const ids: string[] = [];
    let cursor = "0";
    try {
      for (;;) {
        const result = await this.pagesNs.range<PageVectorMetadata>({
          cursor,
          prefix: recordPrefix(scope, "page"),
          limit: 100,
          includeMetadata: true
        });
        for (const doc of result.vectors) {
          if (recordBelongsToScope(doc.metadata, scope)) {
            // Physical IDs, deleted directly. Routing them through
            // deletePagesByIds would re-encode an already-encoded ID and
            // delete nothing.
            ids.push(String(doc.id));
          }
        }
        if (!result.nextCursor || result.nextCursor === "0") break;
        cursor = result.nextCursor;
      }
    } catch (error) {
      if (!isMissingNamespaceError(error)) throw error;
    }

    const BATCH_SIZE = this.batchSize;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      await this.withRetry("delete pages", () => this.pagesNs.delete(batch));
    }
  }

  /**
   * Find records written under an older identity layout.
   *
   * Records lacking the current `schemaVersion` are invisible to every read
   * path, so a 0.8 index run writes a fresh generation beside them rather than
   * overwriting them. They stay put — deliberately, so a rollback is possible —
   * until `searchsocket migrate cleanup-legacy` removes them.
   */
  async scanLegacyRecords(projectId: string): Promise<{
    pages: string[];
    chunks: string[];
  }> {
    const found = { pages: [] as string[], chunks: [] as string[] };

    for (const [ns, key] of [
      [this.pagesNs, "pages"],
      [this.chunksNs, "chunks"]
    ] as const) {
      let cursor = "0";
      try {
        for (;;) {
          const result = await ns.range<ChunkVectorMetadata>({
            cursor,
            limit: 100,
            includeMetadata: true
          });
          for (const doc of result.vectors) {
            if (doc.metadata?.projectId !== projectId) continue;
            // Only missing or older versions are legacy. Treating anything
            // "!== current" as legacy would make a 0.8 cleanup delete records
            // written by a future version that shares the index.
            const version = doc.metadata?.schemaVersion;
            const isLegacy = typeof version !== "number" || version < INDEX_SCHEMA_VERSION;
            if (!isLegacy) continue;
            found[key].push(String(doc.id));
          }
          if (!result.nextCursor || result.nextCursor === "0") break;
          cursor = result.nextCursor;
        }
      } catch (error) {
        if (!isMissingNamespaceError(error)) {
          throw toStorageError("scan legacy records", error);
        }
      }
    }

    return found;
  }

  /**
   * Delete legacy records by their exact physical IDs.
   *
   * Each ID is re-fetched and confirmed to belong to `projectId` and to carry
   * an older schema immediately before deletion. The IDs come from a scan, but
   * this method is public and the scan is not atomic with the delete: a
   * concurrent 0.7.x writer could reuse a raw ID in the interim.
   */
  async deleteLegacyRecords(
    projectId: string,
    ids: { pages: string[]; chunks: string[] }
  ): Promise<{ deleted: number; skipped: number }> {
    const BATCH_SIZE = this.batchSize;
    let deleted = 0;
    let skipped = 0;

    for (const [ns, list] of [
      [this.pagesNs, ids.pages],
      [this.chunksNs, ids.chunks]
    ] as const) {
      for (let i = 0; i < list.length; i += BATCH_SIZE) {
        const batch = list.slice(i, i + BATCH_SIZE);
        const docs = await this.withRetry("fetch legacy records", () =>
          ns.fetch<ChunkVectorMetadata>(batch, { includeMetadata: true })
        );

        const confirmed: string[] = [];
        for (let j = 0; j < batch.length; j += 1) {
          const doc = docs[j];
          const version = doc?.metadata?.schemaVersion;
          const isLegacy = typeof version !== "number" || version < INDEX_SCHEMA_VERSION;
          if (doc && doc.metadata?.projectId === projectId && isLegacy) {
            confirmed.push(batch[j]!);
          } else if (doc) {
            skipped += 1;
          }
        }

        if (confirmed.length > 0) {
          await this.withRetry("delete legacy records", () => ns.delete(confirmed));
          deleted += confirmed.length;
        }
      }
    }

    return { deleted, skipped };
  }

  async health(): Promise<{ ok: boolean; details?: string }> {
    try {
      await this.index.info();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        // Categorised, not verbatim: this value is returned by the public
        // health endpoint, and the raw SDK message can contain a credential.
        details: classifyStorageError(error)
      };
    }
  }

  async dropAllIndexes(projectId: string): Promise<void> {
    // Scan both namespaces for vectors with this projectId, then delete
    for (const ns of [this.chunksNs, this.pagesNs]) {
      const ids: string[] = [];
      let cursor = "0";
      try {
        for (;;) {
          const result = await ns.range<ChunkVectorMetadata>({
            cursor,
            limit: 100,
            includeMetadata: true
          });
          for (const doc of result.vectors) {
            if (doc.metadata?.projectId === projectId) {
              ids.push(String(doc.id));
            }
          }
          if (!result.nextCursor || result.nextCursor === "0") break;
          cursor = result.nextCursor;
        }
      } catch (error) {
        // A partial scan would delete only part of the scope while reporting
        // success, so anything other than an absent namespace must fail.
        if (!isMissingNamespaceError(error)) throw toStorageError("scan for deletion", error);
      }

      if (ids.length > 0) {
        const BATCH_SIZE = this.batchSize;
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
          const batch = ids.slice(i, i + BATCH_SIZE);
          await this.withRetry("delete scoped records", () => ns.delete(batch));
        }
      }
    }
  }
}
