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
  IndexWriteRefusal,
  OutgoingLink,
  PageHit,
  PageRecord,
  RankingOverrides,
  RelatedPage,
  RelatedPagesResult,
  RelationshipType,
  ResolvedSearchSocketConfig,
  RunWarning,
  Scope,
  ScopeInfo,
  ScopeMode,
  ScoreBreakdown,
  SearchRequest,
  SearchResponse,
  SearchResult,
  SearchResultChunk,
  SearchSocketConfig,
  SiteStructureResult,
  SiteTreeNode,
  SourceMode,
  VectorHit
} from "./types";

export type { SearchSocketErrorCode, SearchSocketErrorOptions } from "./errors";
export { SearchSocketError } from "./errors";

/**
 * The logger `SearchEngineOptions.logger` and `IndexPipelineOptions.logger`
 * accept. Construct one to control verbosity, JSON output or stderr-only mode.
 */
export type { LoggerOptions } from "./core/logger";
export { Logger } from "./core/logger";

export type { ConfigOverrides, LoadConfigOptions } from "./config/load";
export { loadConfig, mergeConfig } from "./config/load";
export type { IndexPipelineOptions } from "./indexing/pipeline";
export { IndexPipeline } from "./indexing/pipeline";
export type { SearchEngineOptions } from "./search/engine";
export { SearchEngine } from "./search/engine";
export { MAX_PATH_LENGTH, MAX_QUERY_LENGTH } from "./search/limits";
export type { SearchSocketAutoIndexOptions, SearchSocketHandleOptions } from "./sveltekit";
export { searchsocketHandle, searchsocketVitePlugin } from "./sveltekit";
export type { SearchClient, SearchClientOptions } from "./client";
export { createSearchClient } from "./client";

/**
 * The index identity contract. Exported because a consumer inspecting or
 * migrating records needs to know which schema version wrote them.
 */
export { INDEX_SCHEMA_VERSION } from "./vector/ids";

/**
 * Storage access.
 *
 * `createUpstashStore` is the supported way to obtain a store, and it is typed
 * as `SearchStore`: the operations `SearchEngine` (`SearchStoreReader`) and
 * `IndexPipeline` (`SearchStoreWriter`) actually call. Those interfaces are the
 * compatibility surface; anything else the Upstash implementation does —
 * batching, ID encoding, scan strategy, the CLI's administrative and migration
 * operations — is not, and is free to change. A custom store passed as
 * `SearchEngineOptions.store` or `IndexPipelineOptions.store` must implement
 * the matching interface and keep every read and write inside the given scope.
 */
export type {
  ChunkHashEntry,
  ChunkInventoryEntry,
  PageHashEntry,
  RetrievalConstraints,
  SearchStore,
  SearchStoreReader,
  SearchStoreWriter,
  StoreMetadataUpdate,
  StoreQueryOptions,
  StoreRecord
} from "./vector";
export { createUpstashStore } from "./vector";
