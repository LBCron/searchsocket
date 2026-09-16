export type Awaitable<T> = T | Promise<T>;

export type ScopeMode = "fixed" | "git" | "env";
export type SourceMode = "static-output" | "crawl" | "content-files" | "build";

export interface OutgoingLink {
  url: string;
  anchorText: string;
}

export interface SearchSocketConfig {
  project?: {
    id?: string;
    baseUrl?: string;
  };
  scope?: {
    mode?: ScopeMode;
    fixed?: string;
    envVar?: string;
    sanitize?: boolean;
  };
  exclude?: string[];
  respectRobotsTxt?: boolean;
  source?: {
    mode?: SourceMode;
    staticOutputDir?: string;
    strictRouteMapping?: boolean;
    crawl?: {
      baseUrl: string;
      routes?: string[];
      sitemapUrl?: string;
    };
    contentFiles?: {
      globs: string[];
      baseDir?: string;
    };
    build?: {
      outputDir?: string;
      paramValues?: Record<string, string[]>;
      exclude?: string[];
      previewTimeout?: number;
      discover?: boolean;
      seedUrls?: string[];
      maxPages?: number;
      maxDepth?: number;
    };
  };
  extract?: {
    mainSelector?: string;
    dropTags?: string[];
    dropSelectors?: string[];
    ignoreAttr?: string;
    noindexAttr?: string;
    imageDescAttr?: string;
    respectRobotsNoindex?: boolean;
  };
  transform?: {
    preserveCodeBlocks?: boolean;
    preserveTables?: boolean;
  };
  chunking?: {
    maxChars?: number;
    overlapChars?: number;
    minChars?: number;
    headingPathDepth?: number;
    dontSplitInside?: Array<"code" | "table" | "blockquote">;
    prependTitle?: boolean;
    pageSummaryChunk?: boolean;
  };
  upstash?: {
    url?: string;
    token?: string;
    urlEnv?: string;
    tokenEnv?: string;
    namespaces?: {
      pages?: string;
      chunks?: string;
    };
    /** Records per write/delete/fetch request. Default 90, max 500. */
    batchSize?: number;
    /** Retries for transient failures (rate limit, timeout, 5xx). Default 2. */
    maxRetries?: number;
  };
  indexing?: {
    /**
     * Refuse deletions removing more than this fraction of existing pages
     * unless explicitly accepted. Default 0.5.
     */
    maxDeletionRatio?: number;
  };
  ranking?: {
    enableIncomingLinkBoost?: boolean;
    enableDepthBoost?: boolean;
    enableFreshnessBoost?: boolean;
    freshnessDecayRate?: number;
    enableAnchorTextBoost?: boolean;
    pageWeights?: Record<string, number>;
    minScoreRatio?: number;
    scoreGapThreshold?: number;
    weights?: {
      incomingLinks?: number;
      depth?: number;
      titleMatch?: number;
      freshness?: number;
      anchorText?: number;
    };
  };
  api?: {
    path?: string;
    cors?: {
      allowOrigins?: string[];
    };
    /**
     * Scopes a browser request may select with `?scope=`. Empty (the default)
     * means the caller always gets the server's configured scope.
     */
    allowedScopes?: string[];
    /**
     * Include source file paths and matched sections' indexed text in browser responses.
     * Off by default.
     */
    exposeInternalFields?: boolean;
    rateLimit?: {
      windowMs?: number;
      max?: number;
    };
  };
  mcp?: {
    enable?: boolean;
    access?: "public" | "private";
    transport?: "stdio" | "http";
    http?: {
      port?: number;
      path?: string;
      apiKey?: string;
      apiKeyEnv?: string;
    };
    handle?: {
      path?: string;
      /**
       * Independent of the top-level `mcp.access`, which only governs the
       * standalone server's bind address. "public" (default "private") serves
       * anonymous callers a redacted result set instead of refusing them.
       */
      access?: "public" | "private";
      apiKey?: string;
      /** Env var holding the key, so it need not be committed. */
      apiKeyEnv?: string;
      enableJsonResponse?: boolean;
    };
  };
  llmsTxt?: {
    enable?: boolean;
    outputPath?: string;
    title?: string;
    description?: string;
    generateFull?: boolean;
    serveMarkdownVariants?: boolean;
  };
  state?: {
    dir?: string;
  };
}

export interface ResolvedSearchSocketConfig {
  project: {
    id: string;
    baseUrl?: string;
  };
  scope: {
    mode: ScopeMode;
    fixed: string;
    envVar: string;
    sanitize: boolean;
  };
  exclude: string[];
  respectRobotsTxt: boolean;
  source: {
    mode: SourceMode;
    staticOutputDir: string;
    strictRouteMapping: boolean;
    crawl?: {
      baseUrl: string;
      routes: string[];
      sitemapUrl?: string;
    };
    contentFiles?: {
      globs: string[];
      baseDir: string;
    };
    build?: {
      outputDir: string;
      paramValues: Record<string, string[]>;
      exclude: string[];
      previewTimeout: number;
      discover: boolean;
      seedUrls: string[];
      maxPages: number;
      maxDepth: number;
    };
  };
  extract: {
    mainSelector: string;
    dropTags: string[];
    dropSelectors: string[];
    ignoreAttr: string;
    noindexAttr: string;
    imageDescAttr: string;
    respectRobotsNoindex: boolean;
  };
  transform: {
    preserveCodeBlocks: boolean;
    preserveTables: boolean;
  };
  chunking: {
    maxChars: number;
    overlapChars: number;
    minChars: number;
    headingPathDepth: number;
    dontSplitInside: Array<"code" | "table" | "blockquote">;
    prependTitle: boolean;
    pageSummaryChunk: boolean;
  };
  upstash: {
    url?: string;
    token?: string;
    urlEnv: string;
    tokenEnv: string;
    namespaces: {
      pages: string;
      chunks: string;
    };
    batchSize: number;
    maxRetries: number;
  };
  indexing: {
    maxDeletionRatio: number;
  };
  ranking: {
    enableIncomingLinkBoost: boolean;
    enableDepthBoost: boolean;
    enableFreshnessBoost: boolean;
    freshnessDecayRate: number;
    enableAnchorTextBoost: boolean;
    pageWeights: Record<string, number>;
    minScoreRatio: number;
    scoreGapThreshold: number;
    weights: {
      incomingLinks: number;
      depth: number;
      titleMatch: number;
      freshness: number;
      anchorText: number;
    };
  };
  api: {
    path: string;
    cors: {
      allowOrigins: string[];
    };
    /** Scopes a browser request may select. Empty means none. */
    allowedScopes: string[];
    /** Expose routeFile and chunkText to browser callers. */
    exposeInternalFields: boolean;
    rateLimit?: {
      windowMs: number;
      max: number;
    };
  };
  mcp: {
    enable: boolean;
    access: "public" | "private";
    transport: "stdio" | "http";
    http: {
      port: number;
      path: string;
      apiKey?: string;
      apiKeyEnv?: string;
    };
    handle: {
      path: string;
      access: "public" | "private";
      apiKey?: string;
      apiKeyEnv?: string;
      enableJsonResponse: boolean;
    };
  };
  llmsTxt: {
    enable: boolean;
    outputPath: string;
    title?: string;
    description?: string;
    generateFull: boolean;
    serveMarkdownVariants: boolean;
  };
  state: {
    dir: string;
  };
}

export interface Scope {
  projectId: string;
  scopeName: string;
  scopeId: string;
}

export interface PageSourceRecord {
  url: string;
  html?: string;
  markdown?: string;
  title?: string;
  sourcePath?: string;
  outgoingLinks: OutgoingLink[];
  tags?: string[];
  routeFile?: string;
  routeResolution?: "exact" | "best-effort";
}

export interface RouteMatch {
  routeFile: string;
  routeResolution: "exact" | "best-effort";
}

export interface ExtractedPage {
  url: string;
  title: string;
  markdown: string;
  outgoingLinks: OutgoingLink[];
  noindex: boolean;
  tags: string[];
  description?: string;
  keywords?: string[];
  weight?: number;
  publishedAt?: number;
  /** True when this page came from a caller-supplied CustomRecord. */
  custom?: boolean;
  meta?: Record<string, string | number | boolean | string[]>;
}

export interface IndexedPage {
  url: string;
  title: string;
  scope: string;
  routeFile: string;
  routeResolution: "exact" | "best-effort";
  generatedAt: string;
  incomingLinks: number;
  outgoingLinks: number;
  outgoingLinkUrls?: string[];
  depth: number;
  tags: string[];
  markdown: string;
  description?: string;
  keywords?: string[];
  publishedAt?: number;
  incomingAnchorText?: string;
  /** Per-page weight from `searchsocket-weight` / frontmatter, if set. */
  weight?: number;
  /** True when this page came from a caller-supplied CustomRecord. */
  custom?: boolean;
  meta?: Record<string, string | number | boolean | string[]>;
}

export interface Chunk {
  chunkKey: string;
  ordinal: number;
  url: string;
  path: string;
  title: string;
  sectionTitle?: string;
  headingLevel?: number;
  headingPath: string[];
  chunkText: string;
  snippet: string;
  depth: number;
  incomingLinks: number;
  routeFile: string;
  tags: string[];
  contentHash: string;
  description?: string;
  keywords?: string[];
  publishedAt?: number;
  incomingAnchorText?: string;
  meta?: Record<string, string | number | boolean | string[]>;
  /** True when this chunk belongs to a caller-supplied CustomRecord. */
  custom?: boolean;
}

export interface VectorHit {
  id: string;
  score: number;
  metadata: {
    projectId: string;
    scopeName: string;
    url: string;
    path: string;
    title: string;
    sectionTitle: string;
    headingPath: string[];
    snippet: string;
    chunkText: string;
    ordinal: number;
    contentHash: string;
    depth: number;
    incomingLinks: number;
    routeFile: string;
    tags: string[];
    type?: "chunk" | "page" | "image";
    description?: string;
    keywords?: string[];
    incomingAnchorText?: string;
    imageSrc?: string;
    imageAlt?: string;
    publishedAt?: number;
  };
}

export interface PageRecord {
  url: string;
  title: string;
  markdown: string;
  projectId: string;
  scopeName: string;
  routeFile: string;
  routeResolution: "exact" | "best-effort";
  incomingLinks: number;
  outgoingLinks: number;
  outgoingLinkUrls?: string[];
  depth: number;
  tags: string[];
  indexedAt: string;
  summary?: string;
  description?: string;
  keywords?: string[];
  contentHash?: string;
  publishedAt?: number;
  incomingAnchorText?: string;
  weight?: number;
  /** True when this page came from a caller-supplied CustomRecord. */
  custom?: boolean;
  meta?: Record<string, string | number | boolean | string[]>;
}

export interface PageHit {
  id: string;
  score: number;
  title: string;
  url: string;
  description: string;
  tags: string[];
  depth: number;
  incomingLinks: number;
  routeFile: string;
  publishedAt?: number;
  /**
   * Anchor text of links pointing at this page. Without it the documented
   * `ranking.enableAnchorTextBoost` had nothing to match against in the
   * page-first path and was silently inert.
   */
  incomingAnchorText?: string;
  /**
   * Per-page weight from `searchsocket-weight` / frontmatter. Extraction read
   * it but only ever used it to drop zero-weight pages, so a page asking to be
   * ranked higher was ignored.
   */
  weight?: number;
}

export interface ScopeInfo {
  projectId: string;
  scopeName: string;
  lastIndexedAt: string;
  documentCount?: number;
}

export interface RankingOverrides {
  ranking?: {
    enableIncomingLinkBoost?: boolean;
    enableDepthBoost?: boolean;
    minScoreRatio?: number;
    scoreGapThreshold?: number;
    weights?: {
      incomingLinks?: number;
      depth?: number;
      titleMatch?: number;
    };
  };
}

export interface SearchRequest {
  q: string;
  topK?: number;
  scope?: string;
  pathPrefix?: string;
  tags?: string[];
  filters?: Record<string, string | number | boolean>;
  groupBy?: "page" | "chunk";
  maxSubResults?: number;
  debug?: boolean;
  rankingOverrides?: RankingOverrides;
}

export interface ScoreBreakdown {
  /** Effective per-page weight multiplier applied to the score. */
  pageWeight?: number;
  baseScore: number;
  incomingLinkBoost: number;
  depthBoost: number;
  titleMatchBoost: number;
  freshnessBoost: number;
  anchorTextMatchBoost: number;
}

export interface SearchResultChunk {
  sectionTitle?: string;
  snippet: string;
  chunkText?: string;
  headingPath: string[];
  score: number;
}

export interface SearchResult {
  url: string;
  title: string;
  sectionTitle?: string;
  snippet: string;
  /**
   * The matched section's indexed text. This is the text that was embedded,
   * capped at the storage metadata limit — not necessarily the section's full
   * source. Present only when the deployment sets `api.exposeInternalFields`,
   * or on a privileged surface such as MCP.
   */
  chunkText?: string;
  score: number;
  /**
   * Path to the source file in the author's repository. Present only when the
   * deployment sets `api.exposeInternalFields`, or on a privileged surface such
   * as MCP — a public search response omits it, so this is optional and code
   * reading it must handle its absence.
   */
  routeFile?: string;
  chunks?: SearchResultChunk[];
  breakdown?: ScoreBreakdown;
}

export interface SearchResponse {
  q: string;
  scope: string;
  results: SearchResult[];
  meta: {
    timingsMs: {
      search: number;
      total: number;
    };
  };
}

/**
 * Why an indexing run could not claim a complete view of the source.
 * Any warning present makes the run deletion-ineligible.
 */
export interface RunWarning {
  kind:
    | "source-limited"
    | "source-failure"
    | "chunks-limited"
    | "extraction-failure"
    | "hook-failure";
  detail: string;
}

/**
 * Why an indexing run refused to mutate the index.
 *
 * - `max-deletion-ratio`: the planned deletions exceeded
 *   `indexing.maxDeletionRatio`; resolve with `acceptLargeDeletion`.
 * - `robots-unavailable`: robots.txt was configured to be respected but could
 *   not be read, so no write could be proven safe.
 */
export interface IndexWriteRefusal {
  reason: "max-deletion-ratio" | "robots-unavailable";
  detail: string;
}

export interface IndexStats {
  pagesProcessed: number;
  pagesChanged: number;
  pagesDeleted: number;
  chunksTotal: number;
  chunksChanged: number;
  documentsUpserted: number;
  deletes: number;
  routeExact: number;
  routeBestEffort: number;
  stageTimingsMs: Record<string, number>;
  /**
   * Whether this run observed the complete source of truth and was therefore
   * allowed to delete records missing from it. False means stale records were
   * intentionally left in place.
   */
  deletionEligible: boolean;
  /**
   * Non-null when a safety check refused the whole index mutation: nothing was
   * written or deleted (or, on a dry run, nothing would be). The run still
   * resolves normally, so callers that gate a deploy on indexing must check
   * this — the index is frozen at its last accepted state until it is resolved.
   */
  writesRefused: IndexWriteRefusal | null;
  /** Every reason the run's view of the source may be partial. */
  warnings: RunWarning[];
  /**
   * Destructive operations performed or refused, for machine-readable output.
   */
  dangerousOperations: string[];
}

export interface IndexingHooks {
  transformPage?: (page: ExtractedPage) => Awaitable<ExtractedPage | null>;
  transformChunk?: (chunk: Chunk) => Awaitable<Chunk | null>;
  beforeIndex?: (chunks: Chunk[]) => Awaitable<Chunk[]>;
  afterIndex?: (stats: IndexStats) => Awaitable<void>;
}

export interface CustomRecord {
  url: string;
  title: string;
  content: string;
  metadata?: Record<string, string>;
  tags?: string[];
  weight?: number;
}

export interface IndexOptions {
  scopeOverride?: string;
  changedOnly?: boolean;
  force?: boolean;
  dryRun?: boolean;
  sourceOverride?: SourceMode;
  maxPages?: number;
  maxChunks?: number;
  verbose?: boolean;
  customRecords?: CustomRecord[];
  /**
   * Permit deletion when a complete run legitimately produced zero pages.
   * Without this an unexpectedly empty source deletes nothing, because the far
   * more common cause is a broken source config rather than an emptied site.
   */
  allowEmpty?: boolean;
  /**
   * Permit a deletion that would remove more than
   * `indexing.maxDeletionRatio` of the existing pages.
   */
  acceptLargeDeletion?: boolean;
}

export interface SearchRuntimeOptions {
  configPath?: string;
  cwd?: string;
}

export interface JsonLogEntry {
  event: string;
  ts: string;
  data?: Record<string, unknown>;
}

export interface SiteTreeNode {
  url: string;
  title: string;
  depth: number;
  routeFile: string;
  isIndexed: boolean;
  childCount: number;
  children: SiteTreeNode[];
}

export interface SiteStructureResult {
  root: SiteTreeNode;
  totalPages: number;
  truncated: boolean;
}

export type RelationshipType = "outgoing_link" | "incoming_link" | "sibling" | "semantic";

export interface RelatedPage {
  url: string;
  title: string;
  score: number;
  relationshipType: RelationshipType;
  routeFile: string;
}

export interface RelatedPagesResult {
  sourceUrl: string;
  scope: string;
  relatedPages: RelatedPage[];
}
