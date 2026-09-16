import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UpstashSearchStore,
  classifyStorageError,
  createUpstashRequester,
  UpstashHttpError,
  isMissingNamespaceError,
  toStorageError
} from "../src/vector/upstash";
import { INDEX_SCHEMA_VERSION, pageId } from "../src/vector/ids";
import { SearchSocketError } from "../src/errors";
import type { Scope } from "../src/types";

/**
 * Release-blocking invariant: a backend failure must never be presented as
 * "no results" or "empty index".
 *
 * Every read in this store used to `catch {}` and return `[]`, `null`, or an
 * empty map. A transient outage therefore looked identical to an empty index —
 * which made search answer every query with nothing, and made the indexing
 * pipeline believe there was nothing to compare against.
 */

const scope: Scope = { projectId: "proj", scopeName: "main", scopeId: "proj:main" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function boom(message: string, status?: number): Error {
  const error = new Error(message);
  if (status !== undefined) Object.assign(error, { status });
  return error;
}

function createStore(behaviour: {
  fail?: Error;
  failTimes?: number;
  batchSize?: number;
  maxRetries?: number;
}) {

  let remaining = behaviour.failTimes ?? Number.POSITIVE_INFINITY;

  const call = async <T>(ok: T): Promise<T> => {
    if (behaviour.fail && remaining > 0) {
      remaining -= 1;
      throw behaviour.fail;
    }
    return ok;
  };

  const ns = {
    upsert: vi.fn(() => call("Success")),
    delete: vi.fn(() => call({ deleted: 0 })),
    query: vi.fn(() => call([] as unknown[])),
    fetch: vi.fn(() => call([null])),
    range: vi.fn(() => call({ vectors: [] as unknown[], nextCursor: "0" }))
  };

  const index = {
    namespace: vi.fn(() => ns),
    info: vi.fn(async () => ({ vectorCount: 0 }))
  };

  const store = new UpstashSearchStore({
    index: index as never,
    pagesNamespace: "pages",
    chunksNamespace: "chunks",
    batchSize: behaviour.batchSize,
    maxRetries: behaviour.maxRetries ?? 0,
    retryBaseMs: 1
  });

  return { store, ns };
}

describe("classifyStorageError", () => {
  it("recognises a genuinely absent namespace", () => {
    expect(isMissingNamespaceError(boom("namespace pages not found"))).toBe(true);
    expect(classifyStorageError(boom("Namespace 'x' does not exist"))).toBe("NAMESPACE_MISSING");
  });

  it("does not mistake other failures for an absent namespace", () => {
    for (const error of [
      boom("unauthorized", 401),
      boom("rate limit exceeded", 429),
      boom("request timed out"),
      boom("service unavailable", 503),
      boom("fetch failed")
    ]) {
      expect(isMissingNamespaceError(error)).toBe(false);
    }
  });

  it("classifies each backend condition distinctly", () => {
    expect(classifyStorageError(boom("Invalid token", 401))).toBe("UNAUTHORIZED");
    expect(classifyStorageError(boom("forbidden", 403))).toBe("UNAUTHORIZED");
    expect(classifyStorageError(boom("Too Many Requests", 429))).toBe("RATE_LIMITED");
    expect(classifyStorageError(boom("quota exceeded"))).toBe("RATE_LIMITED");
    expect(classifyStorageError(boom("ETIMEDOUT"))).toBe("TIMEOUT");
    expect(classifyStorageError(boom("filter syntax error"))).toBe("INVALID_FILTER");
    expect(classifyStorageError(boom("internal error", 500))).toBe("SERVICE_UNAVAILABLE");
    expect(classifyStorageError(boom("ECONNREFUSED"))).toBe("SERVICE_UNAVAILABLE");
    // A typo in this pattern meant a real connection reset classified as
    // UNKNOWN and was never retried.
    expect(classifyStorageError(boom("read ECONNRESET"))).toBe("SERVICE_UNAVAILABLE");
    expect(classifyStorageError(boom("something odd"))).toBe("UNKNOWN");
  });

  // @upstash/vector's UpstashError carries only the server's error string —
  // no status code — so classification must work on the message alone.
  it("classifies the message-only errors this SDK actually throws", () => {
    expect(classifyStorageError(new Error("Unauthorized"))).toBe("UNAUTHORIZED");
    expect(classifyStorageError(new Error("Too Many Requests"))).toBe("RATE_LIMITED");
    expect(classifyStorageError(new Error("Internal Server Error"))).toBe("SERVICE_UNAVAILABLE");
    expect(classifyStorageError(new Error("Bad Gateway"))).toBe("SERVICE_UNAVAILABLE");
    expect(classifyStorageError(new Error("Service Unavailable"))).toBe("SERVICE_UNAVAILABLE");
    expect(classifyStorageError(new Error("Exhausted all retries"))).toBe("SERVICE_UNAVAILABLE");
  });

  it("does not mistake 'sparseVector' for a filter error", () => {
    // An unbounded /parse/ matched the substring in "sparseVector", so an
    // unrelated vector error was classified non-retryable.
    expect(
      classifyStorageError(new Error("Either data, vector or sparseVector should be provided"))
    ).not.toBe("INVALID_FILTER");
  });

  it("does not treat caller cancellation as a retryable timeout", () => {
    expect(classifyStorageError(new Error("The operation was aborted"))).not.toBe("TIMEOUT");
  });

  it("lets a transient status outrank missing-namespace wording", () => {
    const message = "namespace chunks not found";
    expect(classifyStorageError(new UpstashHttpError(message, 503))).toBe("SERVICE_UNAVAILABLE");
    expect(classifyStorageError(new UpstashHttpError(message, 429))).toBe("RATE_LIMITED");
    expect(classifyStorageError(new UpstashHttpError(message, 404))).toBe("NAMESPACE_MISSING");
    expect(classifyStorageError(new Error(message))).toBe("NAMESPACE_MISSING");
  });

  it("prefers a status code over message matching", () => {
    // A 502 whose body mentions "filter" must still be retryable.
    expect(classifyStorageError(boom("filter service failed", 502))).toBe("SERVICE_UNAVAILABLE");
  });
});

describe("option bounds", () => {
  it("falls back to defaults for non-finite options", async () => {
    // The store is exported, so a direct consumer can pass anything. A NaN
    // batch size produced an empty first batch and silently wrote nothing.
    const { store, ns } = createStore({ batchSize: Number.NaN });
    await store.upsertPages(
      Array.from({ length: 5 }, (_, i) => ({ id: `/p${i}`, data: "d", metadata: {} })),
      scope
    );
    expect(ns.upsert).toHaveBeenCalledTimes(1);
    expect((ns.upsert.mock.calls[0] as unknown as [unknown[]])[0]).toHaveLength(5);
  });

  it("clamps a negative retry count to zero attempts of retrying", async () => {
    const { store, ns } = createStore({ fail: boom("ECONNREFUSED"), maxRetries: -1 });
    await expect(
      store.upsertPages([{ id: "/a", data: "d", metadata: {} }], scope)
    ).rejects.toThrow(SearchSocketError);
    // Still attempted once — a negative count must not skip the operation.
    expect(ns.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("toStorageError", () => {
  it("preserves the original error as cause without exposing it", () => {
    const original = boom("Invalid token abc123secret", 401);
    const wrapped = toStorageError("page query", original);

    expect(wrapped).toBeInstanceOf(SearchSocketError);
    expect(wrapped.cause).toBe(original);
    // The raw SDK message can carry a credential or an internal URL.
    expect(wrapped.message).not.toContain("abc123secret");
    expect(wrapped.message).toContain("page query");
  });

  it("maps a rate limit to a 429", () => {
    const wrapped = toStorageError("upsert", boom("rate limit", 429));
    expect(wrapped.code).toBe("RATE_LIMITED");
    expect(wrapped.status).toBe(429);
  });

  it("maps other failures to a 503", () => {
    expect(toStorageError("query", boom("ECONNREFUSED")).status).toBe(503);
  });
});

describe("reads fail loudly instead of returning empty", () => {
  const outage = boom("service unavailable", 503);

  it("throws from a page query rather than reporting zero results", async () => {
    const { store } = createStore({ fail: outage });
    await expect(store.searchPagesByText("q", { limit: 5 }, scope)).rejects.toThrow(
      SearchSocketError
    );
  });

  it("throws from a chunk query", async () => {
    const { store } = createStore({ fail: outage });
    await expect(store.search("q", { limit: 5 }, scope)).rejects.toThrow(SearchSocketError);
  });

  it("throws from getPage rather than reporting not-found", async () => {
    const { store } = createStore({ fail: outage });
    await expect(store.getPage("/docs", scope)).rejects.toThrow(SearchSocketError);
  });

  it("throws from getPageHashes rather than reporting an empty index", async () => {
    // This one mattered most: an empty page inventory told the pipeline there
    // was nothing indexed, so every current page looked new.
    const { store } = createStore({ fail: outage });
    await expect(store.getPageHashes(scope)).rejects.toThrow(SearchSocketError);
  });

  it("throws from scanChunkIds rather than reporting no stale chunks", async () => {
    const { store } = createStore({ fail: outage });
    await expect(store.scanChunkIds(scope)).rejects.toThrow(SearchSocketError);
  });

  it("throws from listPages", async () => {
    const { store } = createStore({ fail: outage });
    await expect(store.listPages(scope)).rejects.toThrow(SearchSocketError);
  });

  it("throws from fetchPagesBatch", async () => {
    const { store } = createStore({ fail: outage });
    await expect(store.fetchPagesBatch(["/a"], scope)).rejects.toThrow(SearchSocketError);
  });
});

describe("an absent namespace is still treated as empty", () => {
  const missing = boom("namespace does not exist");

  it("returns empty state for each read", async () => {
    const { store } = createStore({ fail: missing });

    expect(await store.getPageHashes(scope)).toEqual(new Map());
    expect(await store.scanChunkIds(scope)).toEqual(new Map());
    expect(await store.listPages(scope)).toEqual({ pages: [] });
    expect(await store.getPage("/docs", scope)).toBeNull();
    expect(await store.fetchPagesBatch(["/a"], scope)).toEqual([]);
    expect(await store.searchPagesByText("q", { limit: 5 }, scope)).toEqual([]);
  });
});

describe("retry policy", () => {
  it("retries a transient failure and then succeeds", async () => {
    const { store, ns } = createStore({
      fail: boom("rate limit", 429),
      failTimes: 2,
      maxRetries: 3
    });

    await store.upsertPages([{ id: "/a", data: "d", metadata: {} }], scope);
    expect(ns.upsert).toHaveBeenCalledTimes(3);
  });

  it("does not retry an authorization failure", async () => {
    // It would fail identically every time; retrying only delays the error the
    // caller needs to see.
    const { store, ns } = createStore({
      fail: boom("Invalid token", 401),
      maxRetries: 3
    });

    await expect(
      store.upsertPages([{ id: "/a", data: "d", metadata: {} }], scope)
    ).rejects.toThrow(SearchSocketError);
    expect(ns.upsert).toHaveBeenCalledTimes(1);
  });

  it("does not retry a filter-syntax failure", async () => {
    const { store, ns } = createStore({ fail: boom("filter parse error"), maxRetries: 3 });

    await expect(store.deleteByIds(["k1"], scope)).rejects.toThrow(SearchSocketError);
    expect(ns.delete).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries and reports the failure", async () => {
    const { store, ns } = createStore({ fail: boom("ECONNREFUSED"), maxRetries: 2 });

    await expect(
      store.upsertChunks([{ id: "k", data: "d", metadata: {} }], scope)
    ).rejects.toThrow(SearchSocketError);
    expect(ns.upsert).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it("performs no retries when maxRetries is 0", async () => {
    const { store, ns } = createStore({ fail: boom("ECONNREFUSED"), maxRetries: 0 });

    await expect(
      store.upsertChunks([{ id: "k", data: "d", metadata: {} }], scope)
    ).rejects.toThrow(SearchSocketError);
    expect(ns.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("batching", () => {
  it("splits a write into batches of the configured size", async () => {
    const { store, ns } = createStore({ batchSize: 10 });
    const docs = Array.from({ length: 25 }, (_, i) => ({
      id: `/p${i}`,
      data: "d",
      metadata: {}
    }));

    await store.upsertPages(docs, scope);
    expect(ns.upsert).toHaveBeenCalledTimes(3);
  });

  it("clamps an unreasonable batch size", async () => {
    const { store, ns } = createStore({ batchSize: 100_000 });
    const docs = Array.from({ length: 501 }, (_, i) => ({
      id: `/p${i}`,
      data: "d",
      metadata: {}
    }));

    await store.upsertPages(docs, scope);
    // Capped at 500, so 501 records still need two requests.
    expect(ns.upsert).toHaveBeenCalledTimes(2);
  });
});

describe("listPages pagination", () => {
  function pageVector(url: string) {
    return {
      id: pageId(scope, url),
      metadata: {
        projectId: "proj",
        scopeName: "main",
        schemaVersion: INDEX_SCHEMA_VERSION,
        url,
        title: url,
        description: "",
        routeFile: ""
      }
    };
  }

  it("keeps reading until the requested page is full", async () => {
    // Previously it filtered a single backend page and returned whatever
    // survived, so a request for 3 could return 1 while more still matched.
    const { store, ns } = createStore({});
    ns.range
      .mockResolvedValueOnce({
        vectors: [pageVector("/docs/a"), pageVector("/other/b")],
        nextCursor: "c1"
      } as never)
      .mockResolvedValueOnce({
        vectors: [pageVector("/docs/c"), pageVector("/other/d")],
        nextCursor: "c2"
      } as never)
      .mockResolvedValueOnce({
        vectors: [pageVector("/docs/e")],
        nextCursor: "0"
      } as never);

    const result = await store.listPages(scope, { limit: 3, pathPrefix: "/docs" });

    expect(result.pages.map((p) => p.url)).toEqual(["/docs/a", "/docs/c", "/docs/e"]);
    expect(ns.range).toHaveBeenCalledTimes(3);
  });

  it("reports no cursor once the scope is exhausted", async () => {
    const { store, ns } = createStore({});
    ns.range.mockResolvedValueOnce({
      vectors: [pageVector("/a")],
      nextCursor: "0"
    } as never);

    const result = await store.listPages(scope, { limit: 50 });
    expect(result.nextCursor).toBeUndefined();
  });

  it("returns a cursor when records remain", async () => {
    const { store, ns } = createStore({});
    ns.range.mockResolvedValueOnce({
      vectors: [pageVector("/a"), pageVector("/b")],
      nextCursor: "next"
    } as never);

    const result = await store.listPages(scope, { limit: 2 });
    expect(result.pages).toHaveLength(2);
    expect(result.nextCursor).toBe("next");
  });

  it("bounds the scan so an unmatchable prefix cannot walk the whole scope", async () => {
    const { store, ns } = createStore({});
    ns.range.mockResolvedValue({
      vectors: [pageVector("/other")],
      nextCursor: "more"
    } as never);

    const result = await store.listPages(scope, { limit: 50, pathPrefix: "/nope" });

    expect(result.pages).toEqual([]);
    expect(ns.range.mock.calls.length).toBeLessThanOrEqual(10);
    // A cursor is still returned so the caller can continue deliberately.
    expect(result.nextCursor).toBe("more");
  });

  it("never asks the backend for more records than it can return", async () => {
    const { store, ns } = createStore({});
    ns.range.mockResolvedValueOnce({
      vectors: [pageVector("/a"), pageVector("/b")],
      nextCursor: "0"
    } as never);

    const result = await store.listPages(scope, { limit: 2 });

    expect((ns.range.mock.calls[0] as unknown as [{ limit: number }])[0].limit).toBe(2);
    expect(result.pages).toHaveLength(2);
  });

  it("clamps an out-of-range limit", async () => {
    const { store, ns } = createStore({});
    await store.listPages(scope, { limit: 10_000 });
    expect((ns.range.mock.calls[0] as unknown as [{ limit: number }])[0].limit).toBe(200);
  });

  it("never skips a record it fetched but could not return", async () => {
    // Collecting more than `limit` and slicing meant the surplus was dropped
    // while the cursor advanced past it, so those records were unreachable
    // from any subsequent page.
    const { store, ns } = createStore({});
    ns.range
      .mockResolvedValueOnce({ vectors: [pageVector("/a")], nextCursor: "c1" } as never)
      .mockResolvedValueOnce({
        vectors: [pageVector("/b"), pageVector("/c")],
        nextCursor: "c2"
      } as never);

    const result = await store.listPages(scope, { limit: 3 });

    // The second call must ask for only the 2 still needed, not another 3.
    expect((ns.range.mock.calls[1] as unknown as [{ limit: number }])[0].limit).toBe(2);
    expect(result.pages.map((p) => p.url)).toEqual(["/a", "/b", "/c"]);
  });
});

describe("indexing reads survive transient backend failures", () => {
  // The SDK retries only thrown network errors; an HTTP 429/5xx response
  // surfaces as an error the SDK never retries, and used to fail the build.
  const transient = boom("service unavailable", 503);

  it("retries getPageHashes on a transient failure", async () => {
    const { store, ns } = createStore({ fail: transient, failTimes: 1, maxRetries: 2 });
    await expect(store.getPageHashes(scope)).resolves.toEqual(new Map());
    expect(ns.range).toHaveBeenCalledTimes(2);
  });

  it("retries scanChunkIds on a rate limit", async () => {
    const { store, ns } = createStore({ fail: boom("Too Many Requests"), failTimes: 2, maxRetries: 2 });
    await expect(store.scanChunkIds(scope)).resolves.toEqual(new Map());
    expect(ns.range).toHaveBeenCalledTimes(3);
  });

  it("retries fetchContentHashesForKeys on a transient failure", async () => {
    const { store, ns } = createStore({ fail: transient, failTimes: 1, maxRetries: 1 });
    await expect(store.fetchContentHashesForKeys(["k"], scope)).resolves.toEqual(new Map());
    expect(ns.fetch).toHaveBeenCalledTimes(2);
  });

  it("still gives up after maxRetries with a typed error", async () => {
    const { store, ns } = createStore({ fail: transient, maxRetries: 2 });
    await expect(store.getPageHashes(scope)).rejects.toMatchObject({ code: "VECTOR_BACKEND_UNAVAILABLE" });
    expect(ns.range).toHaveBeenCalledTimes(3);
  });

  it("does not retry a read that fails for a non-transient reason", async () => {
    const { store, ns } = createStore({ fail: boom("Unauthorized"), maxRetries: 2 });
    await expect(store.scanChunkIds(scope)).rejects.toThrow(SearchSocketError);
    expect(ns.range).toHaveBeenCalledTimes(1);
  });

  it("still treats a missing namespace as empty after the retry wrapper", async () => {
    const { store } = createStore({ fail: boom("namespace chunks not found"), maxRetries: 2 });
    await expect(store.scanChunkIds(scope)).resolves.toEqual(new Map());
  });

  it("classifies a non-JSON error body as a retryable service failure", async () => {
    // The SDK calls res.json() before checking res.ok, so an HTML 502 page
    // from a proxy arrives as a bare SyntaxError with no status.
    let htmlError: unknown;
    try {
      JSON.parse("<html><body>502 Bad Gateway</body></html>");
    } catch (error) {
      htmlError = error;
    }
    expect(classifyStorageError(htmlError)).toBe("SERVICE_UNAVAILABLE");

    const { store, ns } = createStore({ fail: htmlError as Error, failTimes: 1, maxRetries: 1 });
    await expect(store.getPageHashes(scope)).resolves.toEqual(new Map());
    expect(ns.range).toHaveBeenCalledTimes(2);
  });
});

describe("deletePages", () => {
  it("wraps a scan failure as a typed storage error", async () => {
    const raw = boom("Invalid token abc123secret", 401);
    const { store } = createStore({ fail: raw });
    const rejection = store.deletePages(scope);
    await expect(rejection).rejects.toThrow(SearchSocketError);
    await expect(rejection).rejects.not.toThrow("abc123secret");
  });
});

describe("legacy page reads without a chunk manifest", () => {
  it("stops scanning the scope at a hard ceiling instead of walking it unbounded", async () => {
    let cursor = 0;
    const ns = {
      fetch: vi.fn(async () => [
        {
          id: pageId(scope, "/legacy"),
          metadata: {
            projectId: scope.projectId,
            scopeName: scope.scopeName,
            schemaVersion: INDEX_SCHEMA_VERSION,
            type: "page",
            url: "/legacy",
            title: "Legacy"
          }
        }
      ]),
      // An endless scope of chunks that belong to other pages.
      range: vi.fn(async () => ({ vectors: [], nextCursor: String(++cursor) }))
    };
    const store = new UpstashSearchStore({
      index: { namespace: vi.fn(() => ns) } as never,
      pagesNamespace: "pages",
      chunksNamespace: "chunks",
      maxRetries: 0,
      retryBaseMs: 1
    });

    const rejection = store.getPage("/legacy", scope);
    await expect(rejection).rejects.toMatchObject({ code: "VECTOR_BACKEND_UNAVAILABLE", status: 503 });
    await expect(rejection).rejects.toThrow(/Reindex/);
    expect(ns.range.mock.calls.length).toBeLessThanOrEqual(50);
  });
});

describe("HTTP errors from the real @upstash/vector SDK", () => {
  // The SDK builds `new UpstashError(body.error)` and throws the response
  // status away, so these go through the real Index class with a mocked
  // `fetch` rather than hand-built error objects.
  async function realStore(responses: Array<() => Response>, maxRetries = 2) {
    const { Index } = await import("@upstash/vector");
    const fetchMock = vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra request");
      return next();
    });
    vi.stubGlobal("fetch", fetchMock);
    const index = new Index(createUpstashRequester({ url: "https://vector.example", token: "secret-token" }));
    const store = new UpstashSearchStore({
      index,
      pagesNamespace: "pages",
      chunksNamespace: "chunks",
      maxRetries,
      retryBaseMs: 1
    });
    return { store, fetchMock };
  }

  const json = (status: number, body: unknown) => () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const html = (status: number) => () =>
    new Response("<html><body>Bad Gateway</body></html>", { status, headers: { "Content-Type": "text/html" } });
  const emptyRange = json(200, { result: { vectors: [], nextCursor: "0" } });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries a 503 whose JSON body does not say 'unavailable'", async () => {
    const { store, fetchMock } = await realStore([json(503, { error: "overloaded" }), emptyRange]);
    await expect(store.getPageHashes(scope)).resolves.toEqual(new Map());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 whatever its wording, and reports it as a rate limit", async () => {
    const { store, fetchMock } = await realStore([
      json(429, { error: "ERR max concurrent requests exceeded" }),
      json(429, { error: "ERR max concurrent requests exceeded" }),
      json(429, { error: "ERR max concurrent requests exceeded" })
    ]);
    await expect(store.scanChunkIds(scope)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a 502 answered with an HTML page", async () => {
    const { store, fetchMock } = await realStore([html(502), emptyRange]);
    await expect(store.getPageHashes(scope)).resolves.toEqual(new Map());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401, even with an unhelpful body", async () => {
    const { store, fetchMock } = await realStore([json(401, { error: "nope" })]);
    await expect(store.getPageHashes(scope)).rejects.toMatchObject({ code: "VECTOR_BACKEND_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 400 filter error", async () => {
    const { store, fetchMock } = await realStore([json(400, { error: "Invalid filter: unexpected token" })]);
    await expect(store.getPageHashes(scope)).rejects.toThrow(SearchSocketError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 or 429 that says the namespace is missing instead of reading it as empty", async () => {
    const missing = { error: "namespace chunks not found" };
    const { store, fetchMock } = await realStore([json(503, missing), json(429, missing), emptyRange]);
    await expect(store.scanChunkIds(scope)).resolves.toEqual(new Map());
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails a persistent 503 with missing-namespace wording rather than returning empty", async () => {
    const missing = { error: "namespace chunks not found" };
    const { store, fetchMock } = await realStore([json(503, missing), json(503, missing), json(503, missing)]);
    await expect(store.getPageHashes(scope)).rejects.toMatchObject({ code: "VECTOR_BACKEND_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("still treats a non-transient status with missing-namespace wording as an absent namespace", async () => {
    const { store, fetchMock } = await realStore([json(404, { error: "namespace chunks not found" })]);
    await expect(store.scanChunkIds(scope)).resolves.toEqual(new Map());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still returns successful results and a 200 error body as before", async () => {
    const { store } = await realStore([emptyRange, json(200, { error: "namespace chunks not found" })]);
    await expect(store.getPageHashes(scope)).resolves.toEqual(new Map());
    await expect(store.scanChunkIds(scope)).resolves.toEqual(new Map());
  });
});
