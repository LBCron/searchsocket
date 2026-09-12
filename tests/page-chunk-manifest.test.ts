import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import { SearchSocketError } from "../src/errors";
import { PAGE_CHUNK_KEYS_FIELD, UpstashSearchStore } from "../src/vector/upstash";
import { INDEX_SCHEMA_VERSION, chunkId, pageId } from "../src/vector/ids";
import { METADATA_BYTE_BUDGET, metadataByteSize } from "../src/utils/structured-meta";
import { Logger } from "../src/core/logger";
import type { ResolvedSearchSocketConfig, Scope } from "../src/types";

/**
 * Release-blocking invariant: reading one page costs that page.
 *
 * `getChunksForPage` used to range over every chunk record in the scope and
 * filter by URL in JS, so `get_page` on a five-section page cost one backend
 * request per hundred chunks in the whole site. The page record now carries an
 * ordered manifest of its own chunk keys and the chunks are fetched by ID.
 *
 * The tests below count backend requests explicitly, because "it is faster now"
 * is not a property a unit test can hold onto — "unrelated corpus growth does
 * not change the request count for this page" is.
 */

const alpha: Scope = { projectId: "alpha", scopeName: "main", scopeId: "alpha:main" };
const beta: Scope = { projectId: "beta", scopeName: "main", scopeId: "beta:main" };

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

// ── A fake Upstash index that behaves like the backend: `range` pages through
// records by ID prefix in fixed batches, `fetch` returns one slot per requested
// ID with `null` where nothing exists. ──

interface FakeRecord {
  id: string;
  metadata: Record<string, unknown>;
}

/** Metadata for one chunk record, in a given scope. */
function chunkRecord(
  scope: Scope,
  opts: { key: string; url: string; ordinal: number; text: string }
): FakeRecord {
  return {
    id: chunkId(scope, opts.key),
    metadata: {
      projectId: scope.projectId,
      scopeName: scope.scopeName,
      schemaVersion: INDEX_SCHEMA_VERSION,
      type: "chunk",
      chunkKey: opts.key,
      url: opts.url,
      path: opts.url,
      title: "Guide",
      sectionTitle: `Section ${opts.ordinal}`,
      headingPath: "Guide > Section",
      chunkText: opts.text,
      ordinal: opts.ordinal,
      contentHash: `h${opts.ordinal}`
    }
  };
}

/** Metadata for one page record, with or without a chunk-key manifest. */
function pageRecord(
  scope: Scope,
  opts: { url: string; chunkKeys?: string[] }
): FakeRecord {
  return {
    id: pageId(scope, opts.url),
    metadata: {
      projectId: scope.projectId,
      scopeName: scope.scopeName,
      schemaVersion: INDEX_SCHEMA_VERSION,
      type: "page",
      url: opts.url,
      title: "Guide",
      description: "",
      keywords: [],
      summary: "",
      tags: [],
      routeFile: "",
      routeResolution: "exact",
      incomingLinks: 0,
      outgoingLinks: 0,
      depth: 1,
      indexedAt: "2026-01-01T00:00:00.000Z",
      contentHash: "page",
      ...(opts.chunkKeys ? { [PAGE_CHUNK_KEYS_FIELD]: opts.chunkKeys } : {})
    }
  };
}

/**
 * `RANGE_BATCH` mirrors the `limit: 100` the scan path asks for, so the request
 * counts here are the ones the real backend would see.
 */
const RANGE_BATCH = 100;

function createFakeIndex(records: { pages: FakeRecord[]; chunks: FakeRecord[] }) {
  const counts = { pageFetch: 0, chunkFetch: 0, chunkRange: 0, chunkRecordsRead: 0 };

  const makeNs = (all: FakeRecord[], kind: "page" | "chunk") => ({
    upsert: vi.fn(async () => "Success"),
    delete: vi.fn(async () => ({ deleted: 0 })),
    query: vi.fn(async () => []),
    update: vi.fn(async () => ({ updated: 1 })),
    // Metadata is withheld unless it was asked for, exactly as the backend does
    // it: a read that forgot `includeMetadata` must fail here, not silently
    // keep working because the fake was more generous than the real thing.
    fetch: vi.fn(async (ids: string[], opts?: { includeMetadata?: boolean }) => {
      if (kind === "page") counts.pageFetch += 1;
      else counts.chunkFetch += 1;
      const byId = new Map(all.map((record) => [record.id, record]));
      const found = ids.map((id) => {
        const record = byId.get(id);
        if (!record) return null;
        return opts?.includeMetadata ? record : { id: record.id };
      });
      if (kind === "chunk") counts.chunkRecordsRead += found.filter(Boolean).length;
      return found;
    }),
    range: vi.fn(
      async (opts: { cursor: string; prefix: string; limit: number; includeMetadata?: boolean }) => {
        if (kind === "chunk") counts.chunkRange += 1;
        const matching = all.filter((record) => record.id.startsWith(opts.prefix));
        const start = Number(opts.cursor === "0" ? 0 : opts.cursor);
        const limit = Math.min(opts.limit, RANGE_BATCH);
        const slice = matching.slice(start, start + limit);
        if (kind === "chunk") counts.chunkRecordsRead += slice.length;
        const next = start + limit;
        return {
          vectors: opts.includeMetadata ? slice : slice.map((record) => ({ id: record.id })),
          nextCursor: next < matching.length ? String(next) : "0"
        };
      }
    )
  });

  const pagesNs = makeNs(records.pages, "page");
  const chunksNs = makeNs(records.chunks, "chunk");
  const index = {
    namespace: vi.fn((name: string) => (name === "pages" ? pagesNs : chunksNs)),
    info: vi.fn(async () => ({ vectorCount: 0 }))
  };

  return { index, pagesNs, chunksNs, counts };
}

function createStore(index: ReturnType<typeof createFakeIndex>["index"]): UpstashSearchStore {
  return new UpstashSearchStore({
    index: index as never,
    pagesNamespace: "pages",
    chunksNamespace: "chunks"
  });
}

/** A scope holding one three-section page plus `filler` unrelated chunks. */
function corpus(filler: number, opts: { manifest: boolean }) {
  const keys = ["k0", "k1", "k2"];
  const chunks = keys.map((key, ordinal) =>
    chunkRecord(alpha, { key, url: "/guide", ordinal, text: `Section ${ordinal} body.` })
  );
  for (let i = 0; i < filler; i += 1) {
    chunks.push(
      chunkRecord(alpha, {
        key: `filler-${String(i).padStart(6, "0")}`,
        url: `/other/${i}`,
        ordinal: 0,
        text: "Unrelated."
      })
    );
  }
  return {
    pages: [pageRecord(alpha, { url: "/guide", ...(opts.manifest ? { chunkKeys: keys } : {}) })],
    chunks
  };
}

describe("retrieving one page costs that page", () => {
  it("keeps the backend request count constant as unrelated content grows", async () => {
    const small = createFakeIndex(corpus(10, { manifest: true }));
    const large = createFakeIndex(corpus(5_000, { manifest: true }));

    const fromSmall = await createStore(small.index).getPage("/guide", alpha);
    const fromLarge = await createStore(large.index).getPage("/guide", alpha);

    // Same page, same answer, five hundred times the surrounding corpus.
    expect(fromSmall?.markdown).toBe(fromLarge?.markdown);
    expect(fromSmall?.markdown).toContain("Section 2 body.");

    expect(small.counts.chunkRange).toBe(0);
    expect(large.counts.chunkRange).toBe(0);
    expect(large.counts.chunkFetch).toBe(small.counts.chunkFetch);
    expect(large.counts.pageFetch).toBe(small.counts.pageFetch);
    // The page has three chunks; nothing else may be read back.
    expect(large.counts.chunkRecordsRead).toBe(3);
  });

  it("batches a long page by the store's batch size, and nothing more", async () => {
    const keys = Array.from({ length: 250 }, (_, i) => `k${String(i).padStart(4, "0")}`);
    const fake = createFakeIndex({
      pages: [pageRecord(alpha, { url: "/long", chunkKeys: keys })],
      chunks: keys.map((key, ordinal) =>
        chunkRecord(alpha, { key, url: "/long", ordinal, text: `Body ${ordinal}.` })
      )
    });
    const store = new UpstashSearchStore({
      index: fake.index as never,
      pagesNamespace: "pages",
      chunksNamespace: "chunks",
      batchSize: 100
    });

    const page = await store.getPage("/long", alpha);

    expect(page?.markdown).toContain("Body 249.");
    expect(fake.counts.chunkFetch).toBe(3);
    expect(fake.counts.chunkRange).toBe(0);
  });

  it("falls back to the range scan for a page written before the manifest existed", async () => {
    const fake = createFakeIndex(corpus(150, { manifest: false }));

    const page = await createStore(fake.index).getPage("/guide", alpha);

    expect(page?.markdown).toContain("Section 0 body.");
    expect(page?.markdown).toContain("Section 2 body.");
    // The old cost, deliberately: without a manifest there is nothing to fetch
    // by ID, and a silently empty page would be far worse than a slow one.
    expect(fake.counts.chunkRange).toBeGreaterThan(1);
    expect(fake.counts.chunkFetch).toBe(0);
  });

  it("treats an empty manifest as a complete answer, not a missing one", async () => {
    const fake = createFakeIndex({
      pages: [pageRecord(alpha, { url: "/stub", chunkKeys: [] })],
      chunks: [chunkRecord(alpha, { key: "k0", url: "/other", ordinal: 0, text: "Elsewhere." })]
    });

    const page = await createStore(fake.index).getPage("/stub", alpha);

    expect(page?.markdown).toBe("");
    expect(fake.counts.chunkRange).toBe(0);
    expect(fake.counts.chunkFetch).toBe(0);
  });

  it("falls back when the stored manifest is not a well-formed key list", async () => {
    // A record mangled out of band: neither trustworthy enough to fetch from
    // nor a reason to serve an empty page.
    const records = corpus(0, { manifest: false });
    records.pages[0]!.metadata[PAGE_CHUNK_KEYS_FIELD] = ["k0", 7];
    const mangled = createFakeIndex(records);

    const result = await createStore(mangled.index).getPage("/guide", alpha);

    expect(result?.markdown).toContain("Section 0 body.");
    expect(mangled.counts.chunkRange).toBeGreaterThan(0);
    expect(mangled.counts.chunkFetch).toBe(0);
  });
});

describe("the fetch-by-id path enforces ownership", () => {
  it("never returns a chunk belonging to another project", async () => {
    // The manifest names a key that exists only in project beta. Its physical
    // ID differs, so the fetch finds nothing — and the page must report that
    // rather than quietly return two of its three sections.
    const records = corpus(0, { manifest: true });
    records.chunks = records.chunks.filter((record) => !record.id.endsWith("k2"));
    records.chunks.push(
      chunkRecord(beta, { key: "k2", url: "/guide", ordinal: 2, text: "Beta's secret." })
    );
    const fake = createFakeIndex(records);

    await expect(createStore(fake.index).getPage("/guide", alpha)).rejects.toThrow(
      SearchSocketError
    );
  });

  it("rejects a record whose scope metadata does not match, even at its own ID", async () => {
    const records = corpus(0, { manifest: true });
    // Right ID, wrong owner: the kind of record a schema bump or a hand-edit
    // leaves behind. A fetch by ID bypasses the query filter, so the check has
    // to happen here.
    const impostor = records.chunks.find((record) => record.id.endsWith("k1"))!;
    impostor.metadata.projectId = "beta";

    const fake = createFakeIndex(records);
    let error: unknown;
    try {
      await createStore(fake.index).getPage("/guide", alpha);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SearchSocketError);
    expect((error as Error).message).not.toContain("Section 1");
  });

  it("never splices in a chunk that belongs to a different page", async () => {
    const records = corpus(0, { manifest: true });
    records.chunks.find((record) => record.id.endsWith("k1"))!.metadata.url = "/elsewhere";
    const fake = createFakeIndex(records);

    await expect(createStore(fake.index).getPage("/guide", alpha)).rejects.toThrow(
      /could not be read back/
    );
  });
});

describe("a reader whose page snapshot went stale is not failed for it", () => {
  it("re-reads the page record once and serves the current generation", async () => {
    // The reader fetched /guide's record, then an indexing run replaced every
    // section: new keys written, the manifest updated, the old chunks deleted.
    // Nothing is wrong with the index — only with this reader's snapshot.
    const oldKeys = ["k0", "k1", "k2"];
    const newKeys = ["n0", "n1", "n2"];
    const fake = createFakeIndex({
      pages: [pageRecord(alpha, { url: "/guide", chunkKeys: oldKeys })],
      chunks: newKeys.map((key, ordinal) =>
        chunkRecord(alpha, { key, url: "/guide", ordinal, text: `Fresh ${ordinal}.` })
      )
    });
    // The second page fetch — the retry — sees the manifest the run published.
    fake.pagesNs.fetch.mockImplementationOnce(async () => [
      pageRecord(alpha, { url: "/guide", chunkKeys: oldKeys })
    ]);
    fake.pagesNs.fetch.mockImplementation(async () => [
      pageRecord(alpha, { url: "/guide", chunkKeys: newKeys })
    ]);

    const page = await createStore(fake.index).getPage("/guide", alpha);

    expect(page?.markdown).toContain("Fresh 0.");
    expect(page?.markdown).toContain("Fresh 2.");
    expect(fake.counts.chunkRange).toBe(0);
  });

  it("does not retry forever when the manifest has not moved", async () => {
    const records = corpus(0, { manifest: true });
    records.chunks = records.chunks.filter((record) => !record.id.endsWith("k1"));
    const fake = createFakeIndex(records);

    await expect(createStore(fake.index).getPage("/guide", alpha)).rejects.toThrow(
      SearchSocketError
    );
    // One read, one confirming re-read, and no third attempt.
    expect(fake.counts.pageFetch).toBe(2);
  });

  it("scans when the re-read record has dropped its manifest", async () => {
    const records = corpus(3, { manifest: true });
    const fake = createFakeIndex(records);
    // First read has a manifest naming a key that is gone; the refreshed record
    // has no manifest at all — an over-budget page, say — so the scan decides.
    fake.pagesNs.fetch.mockImplementationOnce(async () => [
      pageRecord(alpha, { url: "/guide", chunkKeys: ["k0", "k1", "k2", "vanished"] })
    ]);
    fake.pagesNs.fetch.mockImplementation(async () => [
      pageRecord(alpha, { url: "/guide" })
    ]);

    const page = await createStore(fake.index).getPage("/guide", alpha);

    expect(page?.markdown).toContain("Section 0 body.");
    expect(fake.counts.chunkRange).toBeGreaterThan(0);
  });

  it("ignores a manifest that repeats a key rather than duplicating a section", async () => {
    const records = corpus(0, { manifest: true });
    records.pages[0]!.metadata[PAGE_CHUNK_KEYS_FIELD] = ["k0", "k0", "k1", "k2"];
    const fake = createFakeIndex(records);

    const page = await createStore(fake.index).getPage("/guide", alpha);

    expect(page?.markdown?.match(/Section 0 body\./g)).toHaveLength(1);
    expect(fake.counts.chunkRange).toBeGreaterThan(0);
  });

  it("returns an empty page when the chunks namespace has never been written", async () => {
    const fake = createFakeIndex(corpus(0, { manifest: true }));
    fake.chunksNs.fetch.mockImplementation(async () => {
      throw new Error("Namespace chunks not found");
    });

    const page = await createStore(fake.index).getPage("/guide", alpha);

    expect(page?.markdown).toBe("");
  });
});

describe("an incomplete page is reported, not served", () => {
  it("raises a typed error when a listed chunk is gone", async () => {
    const records = corpus(0, { manifest: true });
    records.chunks = records.chunks.filter((record) => !record.id.endsWith("k1"));
    const fake = createFakeIndex(records);

    let error: unknown;
    try {
      await createStore(fake.index).getPage("/guide", alpha);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SearchSocketError);
    expect((error as SearchSocketError).code).toBe("VECTOR_BACKEND_UNAVAILABLE");
    expect((error as SearchSocketError).status).toBe(503);
    // The count is in the message: an operator needs to know how much is gone.
    expect((error as Error).message).toContain("lists 3 sections but 1 could not be read back");
  });

  it("does not disguise a partial backend failure as a short page", async () => {
    const records = corpus(0, { manifest: true });
    const fake = createFakeIndex(records);
    let call = 0;
    fake.chunksNs.fetch.mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error("upstream service unavailable");
      return [];
    });

    await expect(createStore(fake.index).getPage("/guide", alpha)).rejects.toThrow(
      SearchSocketError
    );
  });
});

// ── Pipeline side: writing the manifest, and what happens when it will not fit.

interface PageSpec {
  body: string;
}

async function writePages(cwd: string, pages: Record<string, PageSpec>): Promise<void> {
  for (const [pagePath, spec] of Object.entries(pages)) {
    const dir = path.join(cwd, "build", pagePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<html><head><title>${pagePath}</title></head><body><main>${spec.body}</main></body></html>`,
      "utf8"
    );
  }
}

async function createFixture(
  pages: Record<string, PageSpec>
): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-manifest-"));
  tempDirs.push(cwd);
  await writePages(cwd, pages);

  const config = createDefaultConfig("searchsocket-manifest");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.state.dir = ".searchsocket";
  config.respectRobotsTxt = false;
  config.llmsTxt.enable = false;
  return { cwd, config };
}

type Metadata = Record<string, unknown>;

/** The stateful store mock from the fingerprint suite, trimmed to what is used here. */
function createStatefulMockStore(seed?: { pages?: Map<string, Metadata> }) {
  const chunks = new Map<string, Metadata>();
  const pages = seed?.pages ?? new Map<string, Metadata>();

  const store = {
    getPageHashes: vi.fn(async () => {
      const out = new Map<string, { contentHash: string; metadataHash?: string; custom: boolean }>();
      for (const [url, metadata] of pages) {
        out.set(url, {
          contentHash: String(metadata.contentHash ?? ""),
          metadataHash: metadata.metadataHash as string | undefined,
          custom: metadata.custom === true
        });
      }
      return out;
    }),
    upsertPages: vi.fn(async (docs: Array<{ id: string; metadata: Metadata }>) => {
      for (const doc of docs) pages.set(doc.id, { ...doc.metadata });
    }),
    updatePageMetadata: vi.fn(async (items: Array<{ id: string; metadata: Metadata }>) => {
      const missing: string[] = [];
      for (const item of items) {
        if (!pages.has(item.id)) {
          missing.push(item.id);
          continue;
        }
        pages.set(item.id, { ...item.metadata });
      }
      return missing;
    }),
    deletePagesByIds: vi.fn(async (ids: string[]) => {
      for (const id of ids) pages.delete(id);
    }),
    scanChunkIds: vi.fn(async () =>
      new Map([...chunks.entries()].map(([key, metadata]) => [key, metadata.custom === true]))
    ),
    fetchContentHashesForKeys: vi.fn(async (keys: string[]) => {
      const out = new Map<string, { contentHash: string; metadataHash?: string }>();
      for (const key of keys) {
        const metadata = chunks.get(key);
        if (!metadata) continue;
        out.set(key, {
          contentHash: String(metadata.contentHash ?? ""),
          metadataHash: metadata.metadataHash as string | undefined
        });
      }
      return out;
    }),
    upsertChunks: vi.fn(async (docs: Array<{ id: string; metadata: Metadata }>) => {
      for (const doc of docs) chunks.set(doc.id, { ...doc.metadata });
    }),
    updateChunkMetadata: vi.fn(async (items: Array<{ id: string; metadata: Metadata }>) => {
      const missing: string[] = [];
      for (const item of items) {
        if (!chunks.has(item.id)) {
          missing.push(item.id);
          continue;
        }
        chunks.set(item.id, { ...item.metadata });
      }
      return missing;
    }),
    deleteByIds: vi.fn(async (ids: string[]) => {
      for (const id of ids) chunks.delete(id);
    })
  } as unknown as UpstashSearchStore;

  const spies = store as unknown as {
    upsertChunks: ReturnType<typeof vi.fn>;
    updateChunkMetadata: ReturnType<typeof vi.fn>;
    upsertPages: ReturnType<typeof vi.fn>;
    updatePageMetadata: ReturnType<typeof vi.fn>;
  };

  return {
    store,
    spies,
    chunks,
    pages,
    resetSpies() {
      for (const spy of Object.values(spies)) spy.mockClear();
    }
  };
}

function sections(count: number): string {
  let html = "<h1>Guide</h1>";
  for (let i = 0; i < count; i += 1) {
    html +=
      `<h2>Section ${i}</h2><p>Section ${i} explains one distinct part of the guide ` +
      `in enough detail to survive chunking as its own section.</p>`;
  }
  return html;
}

describe("the pipeline writes a manifest that matches what it wrote", () => {
  it("lists exactly the chunks the run persisted, in reading order", async () => {
    const { cwd, config } = await createFixture({ guide: { body: sections(4) } });
    const mock = createStatefulMockStore();

    const pipeline = await IndexPipeline.create({ cwd, config, store: mock.store });
    await pipeline.run({ changedOnly: true });

    const manifest = mock.pages.get("/guide")?.[PAGE_CHUNK_KEYS_FIELD] as string[];
    const written = [...mock.chunks.entries()]
      .filter(([, metadata]) => metadata.url === "/guide")
      .sort((a, b) => Number(a[1].ordinal) - Number(b[1].ordinal))
      .map(([key]) => key);

    expect(manifest).toEqual(written);
    expect(manifest.length).toBeGreaterThan(1);
  });

  it("publishes the page only after the chunks it names", async () => {
    const { cwd, config } = await createFixture({ guide: { body: sections(3) } });
    const mock = createStatefulMockStore();
    const order: string[] = [];
    mock.spies.upsertChunks.mockImplementation(async (docs: Array<{ id: string; metadata: Metadata }>) => {
      order.push("chunks");
      for (const doc of docs) mock.chunks.set(doc.id, { ...doc.metadata });
    });
    mock.spies.upsertPages.mockImplementation(async (docs: Array<{ id: string; metadata: Metadata }>) => {
      order.push("pages");
      for (const doc of docs) mock.pages.set(doc.id, { ...doc.metadata });
    });

    const pipeline = await IndexPipeline.create({ cwd, config, store: mock.store });
    await pipeline.run({ changedOnly: true });

    // A manifest published before its chunks names records that do not exist
    // yet, and a chunk-write failure would leave it that way.
    expect(order).toEqual(["chunks", "pages"]);
  });

  it("repairs an index written without manifests by refreshing metadata, not re-embedding", async () => {
    const { cwd, config } = await createFixture({ guide: { body: sections(3) } });
    const mock = createStatefulMockStore();

    const first = await IndexPipeline.create({ cwd, config, store: mock.store });
    await first.run({ changedOnly: true });

    // Rewind the index to the pre-manifest format: same content, same content
    // hash, no chunk-key list and no metadata fingerprint covering one.
    for (const [url, metadata] of mock.pages) {
      const { [PAGE_CHUNK_KEYS_FIELD]: _dropped, metadataHash: _stale, ...rest } = metadata;
      mock.pages.set(url, { ...rest, metadataHash: "legacy" });
    }
    mock.resetSpies();

    const second = await IndexPipeline.create({ cwd, config, store: mock.store });
    await second.run({ changedOnly: true });

    expect(mock.pages.get("/guide")?.[PAGE_CHUNK_KEYS_FIELD]).toHaveLength(
      [...mock.chunks.values()].filter((metadata) => metadata.url === "/guide").length
    );
    // A manifest is metadata. Gaining one must not re-embed a single record.
    expect(mock.spies.updatePageMetadata).toHaveBeenCalled();
    expect(mock.spies.upsertPages).not.toHaveBeenCalled();
    expect(mock.spies.upsertChunks).not.toHaveBeenCalled();
  });

  it("removes an existing manifest when --max-chunks truncates the chunk set", async () => {
    const { cwd, config } = await createFixture({ guide: { body: sections(4) } });
    const mock = createStatefulMockStore();

    const full = await IndexPipeline.create({ cwd, config, store: mock.store });
    await full.run({ changedOnly: true });
    expect(mock.pages.get("/guide")?.[PAGE_CHUNK_KEYS_FIELD]).toBeDefined();

    const limited = await IndexPipeline.create({ cwd, config, store: mock.store });
    await limited.run({ changedOnly: true, maxChunks: 2 });

    // The truncated run cannot state the page's chunk set: chunks it did not
    // write are still in the index. Leaving the old list in place would be a
    // guess, and a partial one would look complete — so it goes.
    expect(mock.pages.get("/guide")?.[PAGE_CHUNK_KEYS_FIELD]).toBeUndefined();

    const restored = await IndexPipeline.create({ cwd, config, store: mock.store });
    await restored.run({ changedOnly: true });
    expect(mock.pages.get("/guide")?.[PAGE_CHUNK_KEYS_FIELD]).toHaveLength(
      [...mock.chunks.values()].filter((metadata) => metadata.url === "/guide").length
    );
  });

  it("removes the manifest when a hook failure leaves the chunk set incomplete", async () => {
    const { cwd, config } = await createFixture({ guide: { body: sections(4) } });
    const mock = createStatefulMockStore();

    const full = await IndexPipeline.create({ cwd, config, store: mock.store });
    await full.run({ changedOnly: true });
    const before = mock.pages.get("/guide")?.[PAGE_CHUNK_KEYS_FIELD] as string[];
    expect(before.length).toBeGreaterThan(1);

    // A hook sends the page's sections to a URL this run never indexed. They
    // are dropped from the plan, the run stops being authoritative, and the
    // records they would have replaced stay in the index.
    const broken = await IndexPipeline.create({
      cwd,
      config,
      store: mock.store,
      hooks: {
        transformChunk: async (chunk) => ({ ...chunk, url: "/nowhere" })
      }
    });
    const stats = await broken.run({ changedOnly: true });

    expect(stats.warnings.some((warning) => warning.kind === "hook-failure")).toBe(true);
    // Every section is still indexed. A manifest naming none of them would make
    // getPage serve an empty page as a whole one; the absent field sends the
    // reader to the scan, which still finds them.
    expect([...mock.chunks.values()].filter((m) => m.url === "/guide")).toHaveLength(before.length);
    expect(mock.pages.get("/guide")?.[PAGE_CHUNK_KEYS_FIELD]).toBeUndefined();
  });

  it("omits the manifest rather than overrunning the metadata byte budget", async () => {
    // Enough sections that the key list alone cannot fit beside the rest of the
    // page payload. Each key is a 40-character digest, so the list crosses the
    // 48 KiB budget somewhere north of a thousand sections.
    const { cwd, config } = await createFixture({ guide: { body: sections(1400) } });
    const mock = createStatefulMockStore();
    const logger = new Logger();
    const warnings: string[] = [];
    vi.spyOn(logger, "warn").mockImplementation((message: string) => {
      warnings.push(message);
    });

    const pipeline = await IndexPipeline.create({ cwd, config, store: mock.store, logger });
    await pipeline.run({ changedOnly: true });

    const page = mock.pages.get("/guide")!;
    const chunkCount = [...mock.chunks.values()].filter((m) => m.url === "/guide").length;

    // The premise of the test: this page's key list genuinely does not fit, so
    // the omission branch has to have run.
    expect(chunkCount).toBeGreaterThan(1000);
    expect(
      metadataByteSize({
        ...page,
        [PAGE_CHUNK_KEYS_FIELD]: Array.from({ length: chunkCount }, () => "0".repeat(40))
      })
    ).toBeGreaterThan(METADATA_BYTE_BUDGET);

    // Never a prefix passing as complete: the whole list or none of it.
    expect(page[PAGE_CHUNK_KEYS_FIELD]).toBeUndefined();
    expect(warnings.some((message) => message.includes(`Omitted "${PAGE_CHUNK_KEYS_FIELD}"`))).toBe(
      true
    );

    // And what was written is inside the budget once the store's envelope is on.
    expect(
      metadataByteSize({
        ...page,
        projectId: "searchsocket-manifest",
        scopeName: "main",
        schemaVersion: INDEX_SCHEMA_VERSION,
        type: "page"
      })
    ).toBeLessThanOrEqual(METADATA_BYTE_BUDGET);
  });
});
