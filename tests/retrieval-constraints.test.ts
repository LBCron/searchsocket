import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchEngine } from "../src/search/engine";
import { createDefaultConfig } from "../src/config/defaults";
import { UpstashSearchStore } from "../src/vector/upstash";
import { matchesPathPrefix, planRetrievalConstraints } from "../src/vector/upstash";
import { INDEX_SCHEMA_VERSION } from "../src/vector/ids";
import type { PageHit, Scope, VectorHit } from "../src/types";
import type { UpstashSearchStore as Store } from "../src/vector/upstash";

/**
 * Release-blocking invariant: a selective path or tag filter must be applied
 * *during* retrieval, not to an already-cut global candidate window.
 *
 * Before this, `topK: 10` restricted to `/docs` fetched 40 globally-ranked
 * candidates with no path constraint sent to storage; when those 40 were all
 * blog pages the engine returned nothing, however good the `/docs` match
 * ranked 41st was.
 */

const alpha: Scope = { projectId: "alpha", scopeName: "main", scopeId: "alpha:main" };

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function makeTempCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-retrieval-"));
  tempDirs.push(dir);
  return dir;
}

// ── A corpus-backed store that behaves like the backend: it applies the
// constraints it is handed, and returns at most `limit` records. ──

interface Doc {
  url: string;
  tags: string[];
}

function makePageHit(doc: Doc, score: number): PageHit {
  return {
    id: doc.url,
    score,
    title: doc.url,
    url: doc.url,
    description: "",
    tags: doc.tags,
    depth: 1,
    incomingLinks: 0,
    routeFile: ""
  };
}

function makeChunkHit(doc: Doc, score: number): VectorHit {
  return {
    id: `chunk${doc.url}`,
    score,
    metadata: {
      projectId: "alpha",
      scopeName: "main",
      url: doc.url,
      path: doc.url,
      title: doc.url,
      sectionTitle: "",
      headingPath: [],
      snippet: "snippet",
      chunkText: "text",
      ordinal: 0,
      contentHash: "h",
      depth: 1,
      incomingLinks: 0,
      routeFile: "",
      tags: doc.tags
    }
  } as VectorHit;
}

/**
 * `honour: false` models a backend that was sent no usable constraint — what
 * happens when a value cannot be expressed as a filter literal.
 */
function createCorpusStore(corpus: Doc[], honour = true) {
  const pageLimits: number[] = [];
  const chunkLimits: number[] = [];

  // The backend applies exactly the clauses it was sent, and nothing else.
  const select = (opts: { limit: number; pathPrefix?: string; tags?: string[] }): Doc[] => {
    const clauses = honour ? planRetrievalConstraints(opts).clauses : [];
    return corpus
      .filter((doc) => clauses.every((clause) => evaluateClause(clause, doc)))
      .slice(0, opts.limit);
  };

  const store = {
    searchPagesByText: vi.fn(async (_q: string, opts: { limit: number; pathPrefix?: string; tags?: string[] }) => {
      pageLimits.push(opts.limit);
      return select(opts).map((doc, i) => makePageHit(doc, 1 - i / 1000));
    }),
    search: vi.fn(async (_q: string, opts: { limit: number; pathPrefix?: string; tags?: string[] }) => {
      chunkLimits.push(opts.limit);
      return select(opts).map((doc, i) => makeChunkHit(doc, 1 - i / 1000));
    }),
    searchChunksByUrl: vi.fn(async (_q: string, url: string) => {
      const doc = corpus.find((d) => d.url === url);
      return doc ? [makeChunkHit(doc, 0.9)] : [];
    }),
    getPage: vi.fn(async () => null),
    health: vi.fn(async () => ({ ok: true }))
  } as unknown as Store;

  return { store, pageLimits, chunkLimits };
}

/**
 * A corpus whose only `/docs` page ranks far below any candidate window the
 * engine would take without a backend-side filter.
 */
function needleCorpus(): Doc[] {
  const corpus: Doc[] = Array.from({ length: 200 }, (_, i) => ({
    url: `/blog/post-${i}`,
    tags: ["blog"]
  }));
  corpus.push({ url: "/docs/needle", tags: ["docs", "guide"] });
  return corpus;
}

async function createEngine(store: Store) {
  const cwd = await makeTempCwd();
  return SearchEngine.create({ cwd, config: createDefaultConfig("searchsocket-retrieval"), store });
}

describe("constraint pushdown", () => {
  it("finds a path match that ranks below the unfiltered candidate window", async () => {
    const { store, pageLimits } = createCorpusStore(needleCorpus());
    const engine = await createEngine(store);

    const response = await engine.search({ q: "needle", topK: 10, pathPrefix: "/docs" });

    expect(response.results.map((r) => r.url)).toEqual(["/docs/needle"]);
    // One page query, and no overfetch: the backend did the filtering.
    expect(pageLimits).toEqual([20]);
  });

  it("finds a tag match that ranks below the unfiltered candidate window", async () => {
    const { store, pageLimits } = createCorpusStore(needleCorpus());
    const engine = await createEngine(store);

    const response = await engine.search({ q: "needle", topK: 10, tags: ["guide"] });

    expect(response.results.map((r) => r.url)).toEqual(["/docs/needle"]);
    expect(pageLimits).toEqual([20]);
  });

  it("finds it in chunk mode too", async () => {
    const { store, chunkLimits } = createCorpusStore(needleCorpus());
    const engine = await createEngine(store);

    const response = await engine.search({
      q: "needle",
      topK: 10,
      pathPrefix: "/docs",
      groupBy: "chunk"
    });

    expect(response.results.map((r) => r.url)).toEqual(["/docs/needle"]);
    expect(chunkLimits).toEqual([50]);
  });

  it("combines a path prefix, tags, and structured metadata in one query", async () => {
    const { store } = createCorpusStore(needleCorpus());
    const engine = await createEngine(store);

    const response = await engine.search({
      q: "needle",
      topK: 10,
      pathPrefix: "/docs",
      tags: ["docs", "guide"],
      filters: { section: "reference" }
    });

    expect(response.results.map((r) => r.url)).toEqual(["/docs/needle"]);
    const opts = vi.mocked(store.searchPagesByText).mock.lastCall![1];
    expect(opts).toMatchObject({
      pathPrefix: "/docs",
      tags: ["docs", "guide"],
      filter: "meta.section CONTAINS 'reference'"
    });
  });

  it("requires every tag, in page mode and chunk mode alike", async () => {
    const corpus: Doc[] = [
      { url: "/a", tags: ["docs"] },
      { url: "/b", tags: ["docs", "guide"] },
      { url: "/c", tags: ["guide"] }
    ];

    for (const groupBy of ["page", "chunk"] as const) {
      const { store } = createCorpusStore(corpus);
      const engine = await createEngine(store);
      const response = await engine.search({ q: "q", topK: 10, tags: ["docs", "guide"], groupBy });
      expect(response.results.map((r) => r.url)).toEqual(["/b"]);
    }
  });
});

describe("path prefix semantics", () => {
  it("matches whole segments, not a literal string prefix", async () => {
    // Deliberate behaviour change: `/docs` used to also match `/docsmith`.
    const corpus: Doc[] = [
      { url: "/docs", tags: [] },
      { url: "/docs/intro", tags: [] },
      { url: "/docsmith", tags: [] }
    ];
    const { store } = createCorpusStore(corpus);
    const engine = await createEngine(store);

    const response = await engine.search({ q: "q", topK: 10, pathPrefix: "/docs" });
    expect(response.results.map((r) => r.url).sort()).toEqual(["/docs", "/docs/intro"]);
  });

  it("normalises a prefix the caller wrote loosely", async () => {
    const corpus: Doc[] = [{ url: "/docs/intro", tags: [] }];
    const { store } = createCorpusStore(corpus);
    const engine = await createEngine(store);

    for (const prefix of ["docs", "/docs/", "//docs"]) {
      const response = await engine.search({ q: "q", topK: 10, pathPrefix: prefix });
      expect(response.results.map((r) => r.url)).toEqual(["/docs/intro"]);
    }
  });

  it("agrees exactly with the clause it pushes to the backend", () => {
    // A filter that means one thing in the backend and another in JS is worse
    // than the recall bug it replaces, so evaluate both over the same URLs.
    const urls = [
      "/",
      "/docs",
      "/docs/",
      "/docs/intro",
      "/docs/a/b/c",
      "/docsmith",
      "/docs-old",
      "/blog/docs",
      "/DOCS"
    ];

    for (const prefix of ["/docs", "/", "/a/b"]) {
      const { clauses, complete } = planRetrievalConstraints({ pathPrefix: prefix });
      expect(complete).toBe(true);
      for (const url of urls) {
        expect(evaluateUrlClauses(clauses, url)).toBe(matchesPathPrefix(url, prefix));
      }
    }
  });
});

/** Evaluate one emitted clause against a corpus document, as the backend would. */
function evaluateClause(clause: string, doc: Doc): boolean {
  const tag = /^tags CONTAINS '(.*)'$/.exec(clause);
  if (tag) return doc.tags.includes(tag[1]!);
  return evaluateUrlClauses([clause], doc.url);
}

/** Evaluate the `url = '…' OR url GLOB '…'` clause form the plan emits. */
function evaluateUrlClauses(clauses: string[], url: string): boolean {
  if (clauses.length === 0) return true;
  return clauses.every((clause) => {
    const inner = clause.replace(/^\(|\)$/g, "");
    return inner.split(" OR ").some((term) => {
      const eq = /^url = '(.*)'$/.exec(term);
      if (eq) return url === eq[1];
      const glob = /^url GLOB '(.*)'$/.exec(term);
      if (!glob) throw new Error(`unhandled clause: ${term}`);
      return globToRegExp(glob[1]!).test(url);
    });
  });
}

function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (const ch of pattern) {
    if (ch === "*") out += "[\\s\\S]*";
    else if (ch === "?") out += "[\\s\\S]";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

describe("unexpressible constraints", () => {
  it("does not push a prefix that cannot be written as a filter literal", () => {
    for (const prefix of ["/blog/it's-here", "/a\\b", "/docs*", "/doc?", "/doc[s]"]) {
      const plan = planRetrievalConstraints({ pathPrefix: prefix });
      expect(plan.clauses).toEqual([]);
      expect(plan.complete).toBe(false);
    }
  });

  it("cannot be used to widen or escape the ownership clauses", async () => {
    const { index, pagesNs } = createFakeIndex();
    const store = new UpstashSearchStore({
      index: index as never,
      pagesNamespace: "pages",
      chunksNamespace: "chunks"
    });

    await store.searchPagesByText(
      "q",
      { limit: 5, pathPrefix: "/x' OR projectId = 'beta", tags: ["t' OR projectId = 'beta"] },
      alpha
    );

    const filter = (pagesNs.query.mock.lastCall as unknown as [{ filter: string }])[0].filter;
    expect(filter).toContain("projectId = 'alpha'");
    expect(filter).not.toContain("beta");
    expect(filter).toBe(
      `projectId = 'alpha' AND scopeName = 'main' AND schemaVersion = ${INDEX_SCHEMA_VERSION}`
    );
  });

  it("keeps the OR of a pushed prefix inside its own parentheses", async () => {
    const { index, pagesNs } = createFakeIndex();
    const store = new UpstashSearchStore({
      index: index as never,
      pagesNamespace: "pages",
      chunksNamespace: "chunks"
    });

    await store.searchPagesByText("q", { limit: 5, pathPrefix: "/docs", tags: ["guide"] }, alpha);

    const filter = (pagesNs.query.mock.lastCall as unknown as [{ filter: string }])[0].filter;
    expect(filter).toContain("(url = '/docs' OR url GLOB '/docs/*')");
    expect(filter).toContain("tags CONTAINS 'guide'");
    // Without the parentheses the trailing OR escapes the tenant predicates.
    expect(filter).not.toMatch(/AND url = '\/docs' OR /);
  });

  it("still enforces an unexpressible constraint locally, within a work bound", async () => {
    // The backend is handed nothing usable, so the engine escalates — but only
    // so far, and it never returns a record the filter excludes.
    const corpus = needleCorpus();
    const { store, pageLimits } = createCorpusStore(corpus, false);
    const engine = await createEngine(store);

    const response = await engine.search({ q: "needle", topK: 10, tags: ["it's"] });

    expect(response.results).toEqual([]);
    expect(pageLimits.length).toBeLessThanOrEqual(3);
    expect(Math.max(...pageLimits)).toBeLessThanOrEqual(500);
    expect(pageLimits).toEqual([20, 80, 320]);
  });

  it("reports a retrieval that stopped at the work bound", async () => {
    const { store } = createCorpusStore(
      Array.from({ length: 1000 }, (_, i) => ({ url: `/blog/post-${i}`, tags: ["blog"] })),
      false
    );
    const cwd = await makeTempCwd();
    const warn = vi.fn();
    const engine = await SearchEngine.create({
      cwd,
      config: createDefaultConfig("searchsocket-retrieval"),
      store,
      logger: { warn } as never
    });

    await engine.search({ q: "q", topK: 10, tags: ["it's"] });

    expect(warn).toHaveBeenCalledTimes(1);
    // The real final window, not the ceiling it never reached.
    expect(warn.mock.calls[0]![0]).toMatch(/candidate limit of 320/);
    expect(warn.mock.calls[0]![0]).toMatch(/may be incomplete/);
  });

  it("says nothing when the constrained result is complete", async () => {
    const { store } = createCorpusStore(needleCorpus());
    const cwd = await makeTempCwd();
    const warn = vi.fn();
    const engine = await SearchEngine.create({
      cwd,
      config: createDefaultConfig("searchsocket-retrieval"),
      store,
      logger: { warn } as never
    });

    await engine.search({ q: "needle", topK: 10, pathPrefix: "/docs" });
    expect(warn).not.toHaveBeenCalled();
  });
});

function createFakeIndex() {
  const pagesNs = {
    upsert: vi.fn(async () => "Success"),
    delete: vi.fn(async () => ({ deleted: 0 })),
    query: vi.fn(async () => []),
    fetch: vi.fn(async () => [null]),
    range: vi.fn(async () => ({ vectors: [], nextCursor: "0" }))
  };
  const chunksNs = { ...pagesNs, query: vi.fn(async () => []) };
  const index = {
    namespace: vi.fn((name: string) => (name === "pages" ? pagesNs : chunksNs)),
    info: vi.fn(async () => ({ vectorCount: 0 }))
  };
  return { index, pagesNs, chunksNs };
}
