/**
 * Public API.
 *
 * Types a caller can receive from a public method are exported here, so
 * consumer code can name them without reaching into internal paths. Concrete
 * storage classes are deliberately absent — see the note at the bottom.
 */
export type {
  Awaitable,
  Chunk,
  CustomRecord,
  ExtractedPage,
  IndexedPage,
  IndexingHooks,
  IndexOptions,
  IndexStats,
  PageRecord,
  RelatedPagesResult,
  ResolvedSearchSocketConfig,
  RunWarning,
  Scope,
  ScopeInfo,
  SearchRequest,
  SearchResponse,
  SearchResult,
  SearchResultChunk,
  SearchSocketConfig,
  VectorHit
} from "./types";

export type { SearchSocketErrorCode } from "./errors";
export { SearchSocketError } from "./errors";

export { loadConfig, mergeConfig, mergeConfigServerless } from "./config/load";
export { isServerless } from "./core/serverless";
export { resolveScope } from "./core/scope";
export { IndexPipeline } from "./indexing/pipeline";
export { SearchEngine } from "./search/engine";
export { runMcpServer } from "./mcp/server";
export { searchsocketHandle, searchsocketVitePlugin } from "./sveltekit";
export { createSearchClient } from "./client";

/**
 * The index identity contract. Exported because a consumer inspecting or
 * migrating records needs to know which schema version wrote them.
 */
export { INDEX_SCHEMA_VERSION } from "./vector/ids";

/**
 * Storage access.
 *
 * `createUpstashStore` is the supported way to obtain a store. The concrete
 * `UpstashSearchStore` class is no longer exported from the root: it was public
 * only by accident, and exposing it made its internals — batching, ID encoding,
 * scan strategy — part of the package's compatibility surface. There is no
 * exported subpath for it and the bundler emits no separate file, so the class
 * is not reachable from the published package at all. If you need it, work from
 * the source in the repository and expect it to change.
 */
export { createUpstashStore } from "./vector";
