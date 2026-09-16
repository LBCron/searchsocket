import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchEngine } from "../src/search/engine";
import { createDefaultConfig } from "../src/config/defaults";
import { toPublicResults } from "../src/utils/redact";
import { parseSearchResponse } from "../src/svelte/response-validation";
import type { PageHit, ResolvedSearchSocketConfig, SearchResponse, VectorHit } from "../src/types";
import type { UpstashSearchStore } from "../src/vector/upstash";

/**
 * Release-blocking invariant: what the real producer emits is what the real
 * consumer accepts.
 *
 * Every other suite tests one half against a hand-written fixture — the engine
 * against expected objects, the browser validators against literals typed out
 * by hand. That leaves the two free to drift apart with every test still
 * green: a field the engine stops emitting, or a value the validators start
 * refusing, is invisible until a real browser gets a real response.
 *
 * So this one runs the actual `SearchEngine` (only its vector store is faked,
 * because that is the network), puts the response through the same public
 * redaction `src/sveltekit/handle.ts` applies, serializes it the way an HTTP
 * response does, and asserts `isSearchResponse` accepts the result.
 *
 * The JSON round trip is the step that matters. It is where `undefined`
 * vanishes — turning an optional field into an absent one — and where a
 * non-finite number becomes `null`, which the validators reject outright. A
 * response object that satisfies the validator in memory can stop satisfying
 * it the moment it is written to the wire.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function makeTempCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-wire-"));
  tempDirs.push(dir);
  return dir;
}

function makePageHit(url: string, overrides: Partial<PageHit> = {}): PageHit {
  return {
    id: url,
    score: 0.9,
    title: `Title for ${url}`,
    url,
    description: `Description for ${url}`,
    tags: [],
    depth: 1,
    incomingLinks: 2,
    routeFile: `src/routes${url}/+page.svelte`,
    ...overrides
  };
}

function makeChunkHit(url: string, overrides: { score?: number; ordinal?: number } = {}): VectorHit {
  const ordinal = overrides.ordinal ?? 0;
  return {
    id: `chunk-${url}-${ordinal}`,
    score: overrides.score ?? 0.8,
    metadata: {
      projectId: "p",
      scopeName: "main",
      url,
      path: url,
      title: `Title for ${url}`,
      sectionTitle: `Section ${ordinal}`,
      headingPath: ["Guide", `Section ${ordinal}`],
      snippet: "A snippet long enough to be used verbatim by the engine.",
      chunkText: "The indexed body text of this section, which the engine excerpts.",
      ordinal,
      contentHash: "h",
      depth: 1,
      incomingLinks: 2,
      routeFile: `src/routes${url}/+page.svelte`,
      tags: []
    }
  } as VectorHit;
}

/**
 * The whole store surface `SearchEngine.search` touches: page retrieval, the
 * per-page section expansion of the page-first pipeline, and the flat chunk
 * query behind `groupBy: "chunk"`. Nothing else is stubbed, so a new backend
 * call added to the search path fails loudly here instead of being silently
 * satisfied by a permissive mock.
 */
function createStore(opts: {
  pages?: PageHit[];
  chunksByUrl?: Record<string, VectorHit[]>;
  chunks?: VectorHit[];
}): UpstashSearchStore {
  return {
    searchPagesByText: vi.fn(async () => opts.pages ?? []),
    searchChunksByUrl: vi.fn(async (_data: string, url: string) => opts.chunksByUrl?.[url] ?? []),
    search: vi.fn(async () => opts.chunks ?? [])
  } as unknown as UpstashSearchStore;
}

async function makeEngine(
  store: UpstashSearchStore,
  configOverride?: (config: ResolvedSearchSocketConfig) => void
): Promise<SearchEngine> {
  const cwd = await makeTempCwd();
  const config = createDefaultConfig("searchsocket-wire");
  configOverride?.(config);
  return SearchEngine.create({ cwd, config, store });
}

/**
 * The exact journey a response makes between the engine and the browser
 * validator: public redaction, then JSON serialization.
 *
 * `redact` mirrors `api.exposeInternalFields` — false is the default public
 * deployment, true the one that lets `routeFile` and `chunkText` through — so
 * both shapes are held to the same validator.
 */
function overTheWire(response: SearchResponse, redact = true): unknown {
  const publicResponse: SearchResponse = {
    ...response,
    results: toPublicResults(response.results, redact)
  };
  return JSON.parse(JSON.stringify(publicResponse));
}

/**
 * Accepted with every row intact. The validator drops a malformed row rather
 * than refusing the response, so "accepted" alone would no longer notice the
 * engine emitting a row the browser throws away.
 */
function expectAcceptedWhole(wire: unknown): void {
  const parsed = parseSearchResponse(wire);
  expect(parsed).not.toBeNull();
  expect(parsed!.results).toEqual((wire as SearchResponse).results);
}

describe("engine responses satisfy the browser validator", () => {
  it("accepts a page-first response with nested section chunks", async () => {
    const store = createStore({
      pages: [makePageHit("/docs/intro"), makePageHit("/docs/config", { score: 0.85 })],
      chunksByUrl: {
        "/docs/intro": [makeChunkHit("/docs/intro"), makeChunkHit("/docs/intro", { ordinal: 1, score: 0.7 })],
        "/docs/config": [makeChunkHit("/docs/config")]
      }
    });
    const engine = await makeEngine(store);

    const response = await engine.search({ q: "config", groupBy: "page" });

    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results[0]?.chunks?.length).toBeGreaterThan(0);
    expectAcceptedWhole(overTheWire(response));
  });

  it("accepts a page-first response whose page has no sections at all", async () => {
    // `chunks` is left `undefined` in that case, and `undefined` does not
    // survive `JSON.stringify` — so the wire shape is a result with no
    // `chunks` key, which the validator must read as absent rather than wrong.
    const store = createStore({
      pages: [makePageHit("/about")],
      chunksByUrl: {}
    });
    const engine = await makeEngine(store);

    const response = await engine.search({ q: "about", groupBy: "page" });
    const wire = overTheWire(response) as SearchResponse;

    expect(wire.results).toHaveLength(1);
    expect("chunks" in (wire.results[0] as object)).toBe(false);
    expectAcceptedWhole(wire);
  });

  it("accepts a chunk-grouped response", async () => {
    const store = createStore({
      chunks: [makeChunkHit("/docs/intro"), makeChunkHit("/docs/config", { score: 0.75 })]
    });
    const engine = await makeEngine(store);

    const response = await engine.search({ q: "config", groupBy: "chunk" });

    expect(response.results.length).toBeGreaterThan(0);
    expectAcceptedWhole(overTheWire(response));
  });

  it.each(["page", "chunk"] as const)("accepts an empty %s-grouped response", async (groupBy) => {
    // "No matches" is the most common response there is, and an empty
    // `results` array must not be mistaken for a malformed one.
    const engine = await makeEngine(createStore({ pages: [], chunks: [] }));

    const response = await engine.search({ q: "nothing matches this", groupBy });

    expect(response.results).toEqual([]);
    expectAcceptedWhole(overTheWire(response));
  });

  it("accepts an unredacted response carrying routeFile, chunkText and a breakdown", async () => {
    // `api.exposeInternalFields` keeps three fields the public shape drops.
    // `breakdown` in particular is only produced on a debug response, so it is
    // the one part of the documented result shape no wire test would otherwise
    // reach — and the validator requires every one of its numbers to be finite.
    const store = createStore({
      pages: [makePageHit("/docs/intro")],
      chunksByUrl: { "/docs/intro": [makeChunkHit("/docs/intro")] }
    });
    const engine = await makeEngine(store);

    const response = await engine.search({ q: "intro", groupBy: "page", debug: true });
    const wire = overTheWire(response, false) as SearchResponse;

    expect(wire.results[0]?.routeFile).toBeDefined();
    expect(wire.results[0]?.chunkText).toBeDefined();
    expect(wire.results[0]?.breakdown).toBeDefined();
    expectAcceptedWhole(wire);
  });
});

/**
 * A backend score that is not a number is the one defect this contract exists
 * to catch. `JSON.stringify(-Infinity)` and `JSON.stringify(NaN)` are both
 * `null`, so a single malformed record used to reach the browser as
 * `score: null` and fail `isSearchResponse` for the *entire* response — every
 * good result on the page discarded along with it.
 */
describe("non-finite backend scores never reach the wire", () => {
  const nonFinite = [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY]
  ] as const;

  it.each(nonFinite)("drops a page hit scored %s while keeping its valid neighbours", async (_label, score) => {
    // `minScoreRatio` is disabled here on purpose: with it on, the sentinel
    // -Infinity a malformed hit is ranked at falls below the threshold and is
    // removed for the wrong reason, which would let the engine's own finite
    // guard rot undetected.
    const store = createStore({
      pages: [makePageHit("/good"), makePageHit("/bad", { score }), makePageHit("/also-good")],
      chunksByUrl: { "/good": [makeChunkHit("/good")] }
    });
    const engine = await makeEngine(store, (config) => {
      config.ranking.minScoreRatio = 0;
      config.ranking.scoreGapThreshold = 0;
    });

    const response = await engine.search({ q: "test", groupBy: "page" });
    const wire = overTheWire(response) as SearchResponse;

    expect(wire.results.map((r) => r.url)).toEqual(["/good", "/also-good"]);
    expectAcceptedWhole(wire);
  });

  it.each(nonFinite)("drops a chunk hit scored %s in chunk-grouped mode", async (_label, score) => {
    const store = createStore({
      chunks: [
        makeChunkHit("/good"),
        makeChunkHit("/bad", { score }),
        makeChunkHit("/also-good", { score: 0.79 })
      ]
    });
    const engine = await makeEngine(store, (config) => {
      config.ranking.minScoreRatio = 0;
    });

    const response = await engine.search({ q: "test", groupBy: "chunk" });
    const wire = overTheWire(response) as SearchResponse;

    expect(wire.results.map((r) => r.url)).toEqual(["/good", "/also-good"]);
    expectAcceptedWhole(wire);
  });

  it.each(nonFinite)("drops a sub-result chunk scored %s from a valid page", async (_label, score) => {
    // Sub-result scores come straight off the backend hit rather than through
    // ranking, so nothing upstream of the result builder ever inspects them.
    const store = createStore({
      pages: [makePageHit("/docs/intro")],
      chunksByUrl: {
        "/docs/intro": [makeChunkHit("/docs/intro"), makeChunkHit("/docs/intro", { ordinal: 1, score })]
      }
    });
    const engine = await makeEngine(store);

    const response = await engine.search({ q: "intro", groupBy: "page" });
    const wire = overTheWire(response) as SearchResponse;

    expect(wire.results).toHaveLength(1);
    expect(wire.results[0]?.chunks).toHaveLength(1);
    expectAcceptedWhole(wire);
  });

  it("returns an empty result set when every page hit is non-finite", async () => {
    // The actual defect: `minScoreRatio` is skipped entirely when the top score
    // is itself non-finite, so a run of malformed hits was never filtered by
    // anything and passed through whole. Default config here — no override —
    // because that skip is what makes the case real.
    const store = createStore({
      pages: [
        makePageHit("/a", { score: Number.NaN }),
        makePageHit("/b", { score: Number.POSITIVE_INFINITY }),
        makePageHit("/c", { score: Number.NEGATIVE_INFINITY })
      ]
    });
    const engine = await makeEngine(store);

    const response = await engine.search({ q: "test", groupBy: "page" });
    const wire = overTheWire(response) as SearchResponse;

    expect(wire.results).toEqual([]);
    expectAcceptedWhole(wire);
  });

  it("returns an empty result set when every chunk hit is non-finite", async () => {
    const store = createStore({
      chunks: [
        makeChunkHit("/a", { score: Number.NaN }),
        makeChunkHit("/b", { score: Number.POSITIVE_INFINITY }),
        makeChunkHit("/c", { score: Number.NEGATIVE_INFINITY })
      ]
    });
    const engine = await makeEngine(store);

    const response = await engine.search({ q: "test", groupBy: "chunk" });
    const wire = overTheWire(response) as SearchResponse;

    expect(wire.results).toEqual([]);
    expectAcceptedWhole(wire);
  });

  it("is not satisfied by a `null` score, so the guard is doing the work", async () => {
    // Guards the guard: if the engine ever stopped dropping these, the wire
    // shape would be `score: null` and the validator would refuse the row. This
    // asserts that refusal directly, so a vacuously-passing test above cannot
    // hide behind an over-permissive validator. The response survives — only a
    // broken envelope is refused whole — but the row does not.
    const withNullScore = {
      q: "test",
      scope: "main",
      results: [{ url: "/a", title: "A", snippet: "s", score: null }],
      meta: { timingsMs: { search: 1, total: 2 } }
    };

    expect(parseSearchResponse(withNullScore)?.results).toEqual([]);
  });
});
