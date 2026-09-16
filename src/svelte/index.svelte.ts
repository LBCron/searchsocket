import type { SearchRequest, SearchResult } from "../types";
import { errorMessageFrom, isSearchResponse } from "./response-validation";
export { default as SearchSocket } from "./SearchSocket.svelte";
// Re-exported so a Svelte consumer that renders results from its own fetch can
// apply the same safe-link rule the store applies.
export { isSafeResultUrl } from "./response-validation";

export interface CreateSearchOptions {
  endpoint?: string;
  debounce?: number;
  cache?: boolean;
  cacheSize?: number;
  fetchImpl?: typeof fetch;
  topK?: number;
  scope?: string;
  pathPrefix?: string;
  tags?: string[];
  filters?: Record<string, string | number | boolean>;
  groupBy?: "page" | "chunk";
  maxSubResults?: number;
  /**
   * Shortest query that triggers a request, measured after trimming. `0`
   * (the default) keeps the historical behaviour: any non-empty query searches.
   */
  minQueryLength?: number;
  /**
   * Whether results from the previous query stay visible while the next one
   * loads. Defaults to `true`, matching every release before this option
   * existed. Render with `resolvedQuery` rather than `query` so retained rows
   * are never highlighted against a query that did not produce them.
   */
  keepPreviousResults?: boolean;
}

/**
 * Where the search is in its lifecycle. Lets a UI pick one state to render
 * instead of reconstructing it from a combination of `loading`, `error`,
 * `results.length` and `query`.
 */
export type SearchStatus =
  | "idle"
  | "debouncing"
  | "loading"
  | "success"
  | "empty"
  | "error";

class LruCache<K, V> {
  private map = new Map<K, V>();
  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}

function buildCacheKey(query: string, options: CreateSearchOptions): string {
  // Keyed on the query exactly as typed. Collapsing whitespace here would let
  // one query serve another's cached response, and a custom endpoint is free to
  // treat the two differently.
  const parts: Record<string, unknown> = { q: query };
  if (options.topK !== undefined) parts.topK = options.topK;
  if (options.scope !== undefined) parts.scope = options.scope;
  if (options.pathPrefix !== undefined) parts.pathPrefix = options.pathPrefix;
  if (options.tags !== undefined) parts.tags = options.tags;
  if (options.filters !== undefined) parts.filters = options.filters;
  if (options.groupBy !== undefined) parts.groupBy = options.groupBy;
  if (options.maxSubResults !== undefined) parts.maxSubResults = options.maxSubResults;
  return JSON.stringify(parts);
}

/**
 * The original store surface. Unchanged since it was first published — anything
 * that annotates or implements this type keeps compiling.
 */
export interface SearchState {
  query: string;
  readonly results: SearchResult[];
  readonly loading: boolean;
  readonly error: Error | null;
  readonly destroy: () => void;
}

/** What {@link createSearch} actually returns: {@link SearchState} plus state helpers. */
export interface SearchStore extends SearchState {
  /** Coarse lifecycle state — see {@link SearchStatus}. */
  readonly status: SearchStatus;
  /** The query that produced the currently visible `results`. */
  readonly resolvedQuery: string;
  /** True once any query has settled, so an empty list can be told from a fresh store. */
  readonly hasSearched: boolean;
  /** Reset query, results, error and `hasSearched` back to the initial state. */
  readonly clear: () => void;
  /** Re-run the current query, bypassing the cache. No query mutation needed. */
  readonly retry: () => void;
}

export function createSearch(options: CreateSearchOptions = {}): SearchStore {
  const endpoint = options.endpoint ?? "/api/search";
  const debounceMs = options.debounce ?? 250;
  const cacheEnabled = options.cache !== false;
  const cacheSize = options.cacheSize ?? 50;
  const fetchFn = options.fetchImpl ?? fetch;
  const minQueryLength = options.minQueryLength ?? 0;
  const keepPreviousResults = options.keepPreviousResults !== false;

  const resultCache = new LruCache<string, SearchResult[]>(cacheSize);

  let query = $state("");
  let results = $state<SearchResult[]>([]);
  let loading = $state(false);
  let error = $state<Error | null>(null);
  let status = $state<SearchStatus>("idle");
  let resolvedQuery = $state("");
  let hasSearched = $state(false);

  // Bumped by retry() to re-enter the effect without touching `query`.
  let generation = $state(0);
  // The query a retry was requested for. Read and consumed inside the effect,
  // deliberately not reactive. Matching on the query means `retry()` followed by
  // a query change in the same turn does not make the new query skip its cache.
  let retryFor: string | null = null;

  // Identifies the run of the effect a response belongs to. Bumped on every run
  // and on clear()/destroy(), so a response that arrives after the store moved
  // on is recognised as stale without relying on the transport honouring
  // `AbortController` — `fetchImpl` is a documented extension point and may
  // ignore the signal entirely.
  let requestSeq = 0;

  function settle(nextResults: SearchResult[], forQuery: string): void {
    results = nextResults;
    resolvedQuery = forQuery;
    error = null;
    hasSearched = true;
    status = nextResults.length > 0 ? "success" : "empty";
  }

  const stopEffects = $effect.root(() => {
    $effect(() => {
      const currentQuery = query;
      // Subscribe to retry() without using the value for anything else.
      void generation;

      // Claim this run's identity first: everything below, cache hits and empty
      // queries included, abandons whatever was still in flight.
      const requestId = ++requestSeq;
      const isCurrent = () => requestId === requestSeq;

      const trimmed = currentQuery.trim();

      if (!trimmed || trimmed.length < minQueryLength) {
        retryFor = null;
        results = [];
        loading = false;
        error = null;
        status = "idle";
        resolvedQuery = "";
        return;
      }

      const cacheKey = buildCacheKey(currentQuery, options);
      const bypassCache = retryFor === currentQuery;
      retryFor = null;
      if (bypassCache) resultCache.delete(cacheKey);

      if (cacheEnabled && !bypassCache) {
        const cached = resultCache.get(cacheKey);
        if (cached) {
          loading = false;
          settle(cached, currentQuery);
          return;
        }
      }

      if (!keepPreviousResults) {
        results = [];
        resolvedQuery = "";
      }

      loading = true;
      status = "debouncing";
      const controller = new AbortController();

      const timer = setTimeout(async () => {
        status = "loading";

        const request: SearchRequest = { q: currentQuery };
        if (options.topK !== undefined) request.topK = options.topK;
        if (options.scope !== undefined) request.scope = options.scope;
        if (options.pathPrefix !== undefined) request.pathPrefix = options.pathPrefix;
        if (options.tags !== undefined) request.tags = options.tags;
        if (options.filters !== undefined) request.filters = options.filters;
        if (options.groupBy !== undefined) request.groupBy = options.groupBy;
        if (options.maxSubResults !== undefined) request.maxSubResults = options.maxSubResults;

        try {
          const response = await fetchFn(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
            signal: controller.signal,
          });

          let payload: unknown;
          try {
            payload = await response.json();
          } catch {
            throw new Error(response.ok ? "Invalid search response" : "Search failed");
          }

          if (!response.ok) {
            throw new Error(errorMessageFrom(payload, "Search failed"));
          }

          if (!isSearchResponse(payload)) {
            throw new Error("Invalid search response");
          }

          // A response that resolved after the request was abandoned must not
          // overwrite the state — or the cache entry — that a newer query,
          // clear() or destroy() already produced.
          if (!isCurrent()) return;
          if (cacheEnabled) {
            resultCache.set(cacheKey, payload.results);
          }
          settle(payload.results, currentQuery);
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (!isCurrent()) return;
          error = err instanceof Error ? err : new Error(String(err));
          results = [];
          resolvedQuery = currentQuery;
          hasSearched = true;
          status = "error";
        } finally {
          if (isCurrent()) {
            loading = false;
          }
        }
      }, debounceMs);

      return () => {
        clearTimeout(timer);
        controller.abort();
      };
    });
  });

  return {
    get query() {
      return query;
    },
    set query(v: string) {
      query = v;
    },
    get results() {
      return results;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
    get status() {
      return status;
    },
    get resolvedQuery() {
      return resolvedQuery;
    },
    get hasSearched() {
      return hasSearched;
    },
    clear() {
      // Reset synchronously: reading `results` immediately after clear() should
      // not still see the previous query's rows while the effect is pending.
      // Bump before the effect re-runs: a response already in flight must not
      // land in the window between here and the effect's own invalidation.
      requestSeq += 1;
      query = "";
      results = [];
      error = null;
      loading = false;
      status = "idle";
      resolvedQuery = "";
      hasSearched = false;
    },
    retry() {
      retryFor = query;
      generation += 1;
    },
    destroy() {
      // Teardown invalidates every in-flight request, so nothing can write
      // state or the cache once the component is gone.
      requestSeq += 1;
      stopEffects();
    },
  };
}
