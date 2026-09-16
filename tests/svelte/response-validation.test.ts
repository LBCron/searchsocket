import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { createSearch, isSafeResultUrl } from "../../src/svelte/index.svelte";
import { RESPONSE_VALIDATION_CASES } from "./response-validation-cases";

/**
 * The store half of the response-validation conformance suite. `createSearch`
 * and `createSearchClient` must accept and reject exactly the same payloads, so
 * both are driven from `RESPONSE_VALIDATION_CASES`; the client half lives in
 * `tests/client.test.ts`.
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

/**
 * `JSON.stringify` drops NaN and Infinity to `null`, which would quietly turn a
 * non-finite-score case into a missing-field one. Returning the object straight
 * from `json()` keeps the value the case is actually about.
 */
function fetchReturning(payload: unknown) {
  return vi.fn<typeof fetch>().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload
  } as unknown as Response);
}

async function runQuery(search: ReturnType<typeof createSearch>, value: string): Promise<void> {
  search.query = value;
  await tick();
  vi.advanceTimersByTime(300);
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await tick();
  }
}

describe("createSearch response validation", () => {
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
    for (const teardown of cleanup) teardown();
    vi.useRealTimers();
  });

  for (const testCase of RESPONSE_VALIDATION_CASES) {
    it(`${testCase.valid ? "accepts" : "rejects"} ${testCase.name}`, async () => {
      const fetchImpl = fetchReturning(testCase.payload);
      const search = tracked(createSearch({ fetchImpl, debounce: 10 }));

      await runQuery(search, "test");

      if (testCase.valid) {
        expect(search.error).toBeNull();
        // "empty" for a valid response with no rows, "success" otherwise —
        // either way the store settled instead of rejecting.
        expect(["success", "empty"]).toContain(search.status);
        if (testCase.urls) expect(search.results.map((r) => r.url)).toEqual(testCase.urls);
        if (testCase.chunkCounts) {
          expect(search.results.map((r) => r.chunks?.length ?? 0)).toEqual(testCase.chunkCounts);
        }
      } else {
        expect(search.error?.message).toBe("Invalid search response");
        expect(search.results).toEqual([]);
        expect(search.status).toBe("error");
      }
    });
  }

  it("does not cache a response it rejected", async () => {
    const fetchImpl = fetchReturning({
      q: "test",
      scope: "main",
      // A broken envelope: the one thing still refused outright.
      results: null,
      meta: { timingsMs: { search: 0, total: 0 } }
    });
    const search = tracked(createSearch({ fetchImpl, debounce: 10 }));

    // A → B → A, never retry(): retry() deletes the cache entry by design, so a
    // store that cached the rejected response would still look correct there.
    // Coming back to the original query is the only path a cache hit can serve.
    await runQuery(search, "test");
    expect(search.error?.message).toBe("Invalid search response");

    await runQuery(search, "other");
    await runQuery(search, "test");

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(search.error?.message).toBe("Invalid search response");
    expect(search.results).toEqual([]);
  });

  it("keeps a valid response usable", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        q: "test",
        scope: "main",
        results: [{ url: "/docs", title: "Docs", snippet: "x", score: 1 }],
        meta: { timingsMs: { search: 1, total: 2 } }
      })
    );
    const search = tracked(createSearch({ fetchImpl, debounce: 10 }));

    await runQuery(search, "test");

    expect(search.error).toBeNull();
    expect(search.results.map((result) => result.url)).toEqual(["/docs"]);
  });

  it("exports the same safe-link rule the client exports", () => {
    expect(isSafeResultUrl("/docs")).toBe(true);
    expect(isSafeResultUrl("javascript:alert(1)")).toBe(false);
  });
});
