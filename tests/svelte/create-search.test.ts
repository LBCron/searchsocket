import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { createSearch } from "../../src/svelte/index.svelte";
import type { SearchResponse } from "../../src/types";

function mockResponse(results: SearchResponse["results"] = []): SearchResponse {
  return {
    q: "test",
    scope: "",
    results,
    meta: { timingsMs: { search: 10, total: 15 } },
  };
}

function mockResult(title: string) {
  return {
    url: `/${title.toLowerCase()}`,
    title,
    snippet: `Snippet for ${title}`,
    score: 0.9,
    routeFile: `src/routes/${title.toLowerCase()}/+page.svelte`,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createMockFetch(response: SearchResponse = mockResponse()) {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
}

/**
 * Set query, let Svelte effects run, advance debounce timer, let async settle.
 * For tests that need to check intermediate states, use the lower-level helpers.
 */
async function setQueryAndFlush(search: ReturnType<typeof createSearch>, value: string) {
  search.query = value;
  await tick(); // Let $effect run (schedules setTimeout for debounce)
}

async function advanceAndSettle(ms: number) {
  vi.advanceTimersByTime(ms);
  // Let the async setTimeout callback (fetch + response.json() + state update) settle.
  // Multiple rounds needed: fetch resolve → json() resolve → state update → tick
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => queueMicrotask(r));
    await tick();
  }
}

describe("createSearch", () => {
  let cleanup: (() => void)[] = [];

  function tracked<T extends { destroy: () => void }>(instance: T): T {
    cleanup.push(() => instance.destroy());
    return instance;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanup = [];
  });

  afterEach(() => {
    cleanup.forEach((fn) => fn());
    vi.useRealTimers();
  });

  it("initializes with default state", () => {
    const search = tracked(createSearch({ fetchImpl: createMockFetch() }));
    expect(search.query).toBe("");
    expect(search.results).toEqual([]);
    expect(search.loading).toBe(false);
    expect(search.error).toBeNull();
  });

  it("does not fetch on empty query", async () => {
    const mockFetch = createMockFetch();
    const search = tracked(createSearch({ fetchImpl: mockFetch }));

    await setQueryAndFlush(search, "   ");
    await advanceAndSettle(500);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(search.results).toEqual([]);
    expect(search.loading).toBe(false);
  });

  it("debounces fetch by default 250ms", async () => {
    const mockFetch = createMockFetch(mockResponse([mockResult("Page")]));
    const search = tracked(createSearch({ fetchImpl: mockFetch }));

    await setQueryAndFlush(search, "test");

    vi.advanceTimersByTime(249);
    await tick();
    expect(mockFetch).not.toHaveBeenCalled();

    await advanceAndSettle(1);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("resets debounce on rapid input", async () => {
    const mockFetch = createMockFetch(mockResponse([mockResult("Page")]));
    const search = tracked(createSearch({ fetchImpl: mockFetch }));

    await setQueryAndFlush(search, "te");
    vi.advanceTimersByTime(100);
    await tick();

    await setQueryAndFlush(search, "test");
    await advanceAndSettle(250);

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.q).toBe("test");
  });

  it("sets loading state and clears on response", async () => {
    let resolveResponse!: (v: Response) => void;
    const mockFetch = vi.fn<typeof fetch>().mockReturnValue(
      new Promise<Response>((r) => {
        resolveResponse = r;
      })
    );

    const search = tracked(createSearch({ fetchImpl: mockFetch }));
    await setQueryAndFlush(search, "test");

    // After effect runs, loading should be true
    expect(search.loading).toBe(true);

    // Advance past debounce to trigger fetch
    vi.advanceTimersByTime(250);
    await tick();
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(search.loading).toBe(true);

    resolveResponse(
      new Response(JSON.stringify(mockResponse([mockResult("Page")])), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    // Settle: fetch resolve → json() resolve → state update
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((r) => queueMicrotask(r));
      await tick();
    }

    expect(search.loading).toBe(false);
    expect(search.results).toHaveLength(1);
  });

  it("populates results on successful fetch", async () => {
    const resultData = [mockResult("Alpha"), mockResult("Beta")];
    const mockFetch = createMockFetch(mockResponse(resultData));
    const search = tracked(createSearch({ fetchImpl: mockFetch }));

    await setQueryAndFlush(search, "test");
    await advanceAndSettle(250);

    expect(search.results).toHaveLength(2);
    expect(search.results[0]!.title).toBe("Alpha");
    expect(search.results[1]!.title).toBe("Beta");
    expect(search.error).toBeNull();
  });

  it("sets error on fetch failure", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error("Network error"));
    const search = tracked(createSearch({ fetchImpl: mockFetch }));

    await setQueryAndFlush(search, "test");
    await advanceAndSettle(250);

    expect(search.error).toBeInstanceOf(Error);
    expect(search.error!.message).toBe("Network error");
    expect(search.results).toEqual([]);
    expect(search.loading).toBe(false);
  });

  it("sets error on non-ok HTTP response", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      })
    );
    const search = tracked(createSearch({ fetchImpl: mockFetch }));

    await setQueryAndFlush(search, "test");
    await advanceAndSettle(250);

    expect(search.error).toBeInstanceOf(Error);
    expect(search.error!.message).toBe("Rate limited");
  });

  it("does not set error on abort", async () => {
    let fetchCallCount = 0;
    const mockFetch = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      fetchCallCount++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    const search = tracked(createSearch({ fetchImpl: mockFetch, debounce: 0 }));

    await setQueryAndFlush(search, "first");
    await advanceAndSettle(0);
    expect(fetchCallCount).toBe(1);

    // Changing query aborts the first request
    await setQueryAndFlush(search, "second");
    await advanceAndSettle(0);

    // AbortError should not propagate to error state
    expect(search.error).toBeNull();
  });

  it("returns cached results for repeated queries", async () => {
    const mockFetch = createMockFetch(mockResponse([mockResult("Cached")]));
    const search = tracked(createSearch({ fetchImpl: mockFetch }));

    await setQueryAndFlush(search, "test");
    await advanceAndSettle(250);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(search.results).toHaveLength(1);

    await setQueryAndFlush(search, "");
    await advanceAndSettle(250);

    // Same query again — should hit cache (effect runs, finds cached, returns early)
    await setQueryAndFlush(search, "test");
    expect(search.results).toHaveLength(1);
    expect(search.results[0]!.title).toBe("Cached");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("skips cache when cache option is false", async () => {
    const mockFetch = createMockFetch(mockResponse([mockResult("Uncached")]));
    const search = tracked(createSearch({ fetchImpl: mockFetch, cache: false }));

    await setQueryAndFlush(search, "test");
    await advanceAndSettle(250);
    expect(mockFetch).toHaveBeenCalledOnce();

    await setQueryAndFlush(search, "");
    await advanceAndSettle(250);

    await setQueryAndFlush(search, "test");
    await advanceAndSettle(250);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("evicts oldest cache entry when cacheSize exceeded", async () => {
    let callCount = 0;
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
      callCount++;
      return new Response(
        JSON.stringify(mockResponse([mockResult(`Result${callCount}`)])),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const search = tracked(createSearch({ fetchImpl: mockFetch, cacheSize: 2, debounce: 0 }));

    for (const q of ["a", "b", "c"]) {
      await setQueryAndFlush(search, q);
      await advanceAndSettle(0);
    }
    expect(callCount).toBe(3);

    // "b" should still be cached
    await setQueryAndFlush(search, "b");
    expect(callCount).toBe(3);

    // "a" was evicted — should trigger new fetch
    await setQueryAndFlush(search, "a");
    await advanceAndSettle(0);
    expect(callCount).toBe(4);
  });

  it("uses custom endpoint", async () => {
    const mockFetch = createMockFetch();
    const search = tracked(createSearch({ fetchImpl: mockFetch, endpoint: "/custom/search" }));

    await setQueryAndFlush(search, "test");
    await advanceAndSettle(250);

    expect(mockFetch).toHaveBeenCalledWith("/custom/search", expect.anything());
  });

  it("uses custom debounce", async () => {
    const mockFetch = createMockFetch();
    const search = tracked(createSearch({ fetchImpl: mockFetch, debounce: 100 }));

    await setQueryAndFlush(search, "test");
    vi.advanceTimersByTime(99);
    await tick();
    expect(mockFetch).not.toHaveBeenCalled();

    await advanceAndSettle(1);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("passes search params in request body", async () => {
    const mockFetch = createMockFetch();
    const search = tracked(createSearch({
      fetchImpl: mockFetch,
      topK: 5,
      scope: "docs",
      pathPrefix: "/guide",
      tags: ["tutorial"],
      groupBy: "page",
    }));

    await setQueryAndFlush(search, "test");
    await advanceAndSettle(250);

    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({
      q: "test",
      topK: 5,
      scope: "docs",
      pathPrefix: "/guide",
      tags: ["tutorial"],
      groupBy: "page",
    });
  });

  it("clears error on successful query after error", async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse([mockResult("OK")])), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );

    const search = tracked(createSearch({ fetchImpl: mockFetch, debounce: 0 }));

    await setQueryAndFlush(search, "bad");
    await advanceAndSettle(0);
    expect(search.error).toBeInstanceOf(Error);

    await setQueryAndFlush(search, "good");
    await advanceAndSettle(0);
    expect(search.error).toBeNull();
    expect(search.results).toHaveLength(1);
  });

  it("destroy stops reactivity", async () => {
    const mockFetch = createMockFetch();
    const search = createSearch({ fetchImpl: mockFetch, debounce: 0 });
    search.destroy();

    search.query = "test";
    await tick();
    await advanceAndSettle(0);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sets error on invalid JSON in success response", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("not json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    );
    const search = tracked(createSearch({ fetchImpl: mockFetch, debounce: 0 }));

    await setQueryAndFlush(search, "test");
    await advanceAndSettle(0);

    expect(search.error).toBeInstanceOf(Error);
    expect(search.error!.message).toBe("Invalid search response");
  });

  it("sets error when the response body is JSON null", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("null", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const search = tracked(createSearch({ fetchImpl: mockFetch, debounce: 0 }));

    await setQueryAndFlush(search, "test");
    await advanceAndSettle(0);

    expect(search.error!.message).toBe("Invalid search response");
    expect(search.status).toBe("error");
  });

  it("sets error when results is null rather than reporting no matches", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ q: "test", scope: "", results: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const search = tracked(createSearch({ fetchImpl: mockFetch, debounce: 0 }));

    await setQueryAndFlush(search, "test");
    await advanceAndSettle(0);

    // "empty" would be indistinguishable from a genuine zero-result search.
    expect(search.status).toBe("error");
    expect(search.error!.message).toBe("Invalid search response");
    expect(search.results).toEqual([]);
  });

  it("sets error when a result row is missing its required fields", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ q: "test", scope: "", results: [{ title: "No url" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const search = tracked(createSearch({ fetchImpl: mockFetch, debounce: 0 }));

    await setQueryAndFlush(search, "test");
    await advanceAndSettle(0);

    expect(search.status).toBe("error");
    expect(search.error!.message).toBe("Invalid search response");
  });

  it("does not let an abandoned response overwrite a newer cache entry", async () => {
    const pending: Array<(response: Response) => void> = [];
    // Deliberately ignores `signal`: fetchImpl is a documented extension point,
    // so correctness cannot depend on the transport honouring cancellation.
    const mockFetch = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        })
    );
    const search = tracked(createSearch({ fetchImpl: mockFetch, debounce: 0 }));

    await setQueryAndFlush(search, "same");
    await advanceAndSettle(0);
    search.retry();
    await tick();
    await advanceAndSettle(0);
    expect(pending).toHaveLength(2);

    // Reverse order: the retry lands first, the abandoned original second.
    pending[1]!(jsonResponse(mockResponse([mockResult("New")])));
    await advanceAndSettle(0);
    pending[0]!(jsonResponse(mockResponse([mockResult("Old")])));
    await advanceAndSettle(0);

    expect(search.results.map((r) => r.title)).toEqual(["New"]);

    await setQueryAndFlush(search, "other");
    await advanceAndSettle(0);
    pending[2]!(jsonResponse(mockResponse([])));
    await advanceAndSettle(0);

    await setQueryAndFlush(search, "same");
    await advanceAndSettle(0);

    expect(search.results.map((r) => r.title)).toEqual(["New"]);
    // Served from the cache, so the revisit issued no fourth request.
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("ignores a response that lands after destroy", async () => {
    const pending: Array<(response: Response) => void> = [];
    const mockFetch = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        })
    );
    const search = createSearch({ fetchImpl: mockFetch, debounce: 0 });

    await setQueryAndFlush(search, "test");
    await advanceAndSettle(0);
    expect(pending).toHaveLength(1);

    search.destroy();
    pending[0]!(jsonResponse(mockResponse([mockResult("Late")])));
    await advanceAndSettle(0);

    expect(search.results).toEqual([]);
    expect(search.error).toBeNull();
    expect(search.status).toBe("loading");
  });

  it("leaves a pending request in charge when an abandoned one resolves first", async () => {
    const pending: Array<(response: Response) => void> = [];
    const mockFetch = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        })
    );
    const search = tracked(createSearch({ fetchImpl: mockFetch, debounce: 0 }));

    await setQueryAndFlush(search, "same");
    await advanceAndSettle(0);
    search.retry();
    await tick();
    await advanceAndSettle(0);

    // The abandoned original resolves while its replacement is still in flight:
    // it must neither settle results nor claim the search has finished.
    pending[0]!(jsonResponse(mockResponse([mockResult("Old")])));
    await advanceAndSettle(0);

    expect(search.loading).toBe(true);
    expect(search.status).toBe("loading");
    expect(search.results).toEqual([]);

    pending[1]!(jsonResponse(mockResponse([mockResult("New")])));
    await advanceAndSettle(0);

    expect(search.loading).toBe(false);
    expect(search.results.map((r) => r.title)).toEqual(["New"]);
  });

  it("ignores a response that lands after clear()", async () => {
    const pending: Array<(response: Response) => void> = [];
    const mockFetch = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        })
    );
    const search = tracked(createSearch({ fetchImpl: mockFetch, debounce: 0 }));

    await setQueryAndFlush(search, "test");
    await advanceAndSettle(0);

    search.clear();
    pending[0]!(jsonResponse(mockResponse([mockResult("Late")])));
    await advanceAndSettle(0);

    expect(search.results).toEqual([]);
    expect(search.status).toBe("idle");
    expect(search.hasSearched).toBe(false);

    // The abandoned response must not have seeded the cache either.
    await setQueryAndFlush(search, "test");
    await advanceAndSettle(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(search.results).toEqual([]);
  });
});
