import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import type { UpstashSearchStore } from "../src/vector/upstash";
import { chunkPage } from "../src/indexing/chunker";
import { resolveScope } from "../src/core/scope";
import type { Chunk, IndexedPage, PageRecord, ResolvedSearchSocketConfig } from "../src/types";

/**
 * Incremental indexing has to converge on the payload that is actually stored.
 *
 * Every case here asserts the PERSISTED STATE after two runs, not the returned
 * stats: the whole class of bug being closed is one where the stats said
 * "nothing changed" while the index held something else. The store mock
 * therefore keeps the full metadata of every record, exactly as the backend
 * would, so a test can read back what a reader would see.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

type Metadata = Record<string, unknown>;

/**
 * A store that remembers the complete metadata of everything written, so run 2
 * sees exactly what run 1 left behind.
 */
function createStatefulMockStore() {
  const chunks = new Map<string, Metadata>();
  const pages = new Map<string, Metadata>();

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
    deletePages: vi.fn(async () => pages.clear()),
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
    }),
    listPages: vi.fn(async (): Promise<PageRecord[]> => [])
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
    /** Chunks of one page, in the order a reader would reconstruct them. */
    chunksFor(url: string): Metadata[] {
      return [...chunks.values()]
        .filter((metadata) => metadata.url === url)
        .sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
    },
    resetSpies() {
      spies.upsertChunks.mockClear();
      spies.updateChunkMetadata.mockClear();
      spies.upsertPages.mockClear();
      spies.updatePageMetadata.mockClear();
    }
  };
}

/** How many records each write path touched since the last reset. */
function writeCounts(spies: {
  upsertChunks: ReturnType<typeof vi.fn>;
  updateChunkMetadata: ReturnType<typeof vi.fn>;
  upsertPages: ReturnType<typeof vi.fn>;
  updatePageMetadata: ReturnType<typeof vi.fn>;
}) {
  const total = (spy: ReturnType<typeof vi.fn>): number =>
    spy.mock.calls.reduce((sum, call) => sum + (call[0] as unknown[]).length, 0);
  return {
    chunkUpserts: total(spies.upsertChunks),
    chunkMetadataUpdates: total(spies.updateChunkMetadata),
    pageUpserts: total(spies.upsertPages),
    pageMetadataUpdates: total(spies.updatePageMetadata)
  };
}

interface PageSpec {
  /** Extra <head> markup, e.g. a tags meta or a JSON-LD block. */
  head?: string;
  body: string;
}

async function writePages(cwd: string, pages: Record<string, PageSpec>): Promise<void> {
  for (const [pagePath, spec] of Object.entries(pages)) {
    const dir = path.join(cwd, "build", pagePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<html><head><title>${pagePath}</title>${spec.head ?? ""}</head>` +
        `<body><main>${spec.body}</main></body></html>`,
      "utf8"
    );
  }
}

async function createFixture(
  pages: Record<string, PageSpec>
): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-fingerprint-"));
  tempDirs.push(cwd);

  await writePages(cwd, pages);

  const config = createDefaultConfig("searchsocket-fingerprint");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.state.dir = ".searchsocket";
  config.respectRobotsTxt = false;
  config.llmsTxt.enable = false;
  return { cwd, config };
}

function sectionBody(first: string, second: string): string {
  return (
    `<h1>Guide</h1>` +
    `<h2>${first}</h2><p>Section ${first} explains the ${first.toLowerCase()} part of the guide in detail.</p>` +
    `<h2>${second}</h2><p>Section ${second} explains the ${second.toLowerCase()} part of the guide in detail.</p>`
  );
}

describe("fingerprints cover the whole persisted payload", () => {
  it("refreshes chunk tags when only the page's tags change", async () => {
    const { cwd, config } = await createFixture({
      guide: { head: `<meta name="searchsocket:tags" content="alpha">`, body: sectionBody("One", "Two") }
    });
    const mock = createStatefulMockStore();

    const first = await IndexPipeline.create({ cwd, config, store: mock.store });
    await first.run({ changedOnly: true });

    expect(mock.chunksFor("/guide").length).toBeGreaterThan(1);
    for (const chunk of mock.chunksFor("/guide")) {
      expect(chunk.tags).toContain("alpha");
    }

    await writePages(cwd, {
      guide: { head: `<meta name="searchsocket:tags" content="beta">`, body: sectionBody("One", "Two") }
    });
    mock.resetSpies();

    const second = await IndexPipeline.create({ cwd, config, store: mock.store });
    const stats = await second.run({ changedOnly: true });

    expect(stats.chunksChanged).toBeGreaterThan(0);
    // Page and chunk tag filters must agree, or a tag query returns the page
    // and none of its sections.
    expect(mock.pages.get("/guide")?.tags).toContain("beta");
    for (const chunk of mock.chunksFor("/guide")) {
      expect(chunk.tags).toContain("beta");
      expect(chunk.tags).not.toContain("alpha");
    }

    // Tags do not reach the embedded text, so nothing should have been re-embedded.
    const counts = writeCounts(mock.spies);
    expect(counts.chunkUpserts).toBe(0);
    expect(counts.chunkMetadataUpdates).toBeGreaterThan(0);
  });

  it("updates ordinals when sections are reordered, keeping chunk keys stable", async () => {
    const { cwd, config } = await createFixture({
      guide: { body: sectionBody("Alpha", "Beta") }
    });
    const mock = createStatefulMockStore();

    const first = await IndexPipeline.create({ cwd, config, store: mock.store });
    await first.run({ changedOnly: true });

    const keysBefore = new Set(mock.chunks.keys());
    const orderBefore = mock.chunksFor("/guide").map((chunk) => chunk.sectionTitle);
    expect(orderBefore).toEqual(["", "Guide", "Alpha", "Beta"]);

    await writePages(cwd, { guide: { body: sectionBody("Beta", "Alpha") } });
    mock.resetSpies();

    const second = await IndexPipeline.create({ cwd, config, store: mock.store });
    await second.run({ changedOnly: true });

    // Identity is ordinal-free by design: a moved section keeps its record.
    expect(new Set(mock.chunks.keys())).toEqual(keysBefore);
    // ...but the ordinal that decides reconstruction order must follow the move.
    expect(mock.chunksFor("/guide").map((chunk) => chunk.sectionTitle)).toEqual(["", "Guide", "Beta", "Alpha"]);

    // Only the two moved sections need a write, and neither needs re-embedding.
    // The page-summary chunk is the one genuine re-embed: its text is built from
    // the page's first paragraph, which the reorder really did change.
    const counts = writeCounts(mock.spies);
    expect(counts.chunkMetadataUpdates).toBe(2);
    expect(counts.chunkUpserts).toBe(1);
  });

  it("refreshes incoming-link counts from another page's edit without re-embedding", async () => {
    const { cwd, config } = await createFixture({
      target: { body: `<h1>Target</h1><p>The target page has some stable prose on it.</p>` },
      one: { body: `<h1>One</h1><p>See <a href="/target">Alpha</a> for details.</p>` }
    });
    const mock = createStatefulMockStore();

    const first = await IndexPipeline.create({ cwd, config, store: mock.store });
    await first.run({ changedOnly: true });

    expect(mock.pages.get("/target")?.incomingLinks).toBe(1);
    expect(mock.chunksFor("/target")[0]?.incomingLinks).toBe(1);

    // A second linker reusing an anchor phrase already collected: the count
    // changes, the deduplicated anchor string does not.
    await writePages(cwd, {
      two: { body: `<h1>Two</h1><p>Also see <a href="/target">Alpha</a> for details.</p>` }
    });
    mock.resetSpies();

    const second = await IndexPipeline.create({ cwd, config, store: mock.store });
    await second.run({ changedOnly: true });

    expect(mock.pages.get("/target")?.incomingLinks).toBe(2);
    expect(mock.pages.get("/target")?.incomingAnchorText).toBe("alpha");
    for (const chunk of mock.chunksFor("/target")) {
      expect(chunk.incomingLinks).toBe(2);
    }

    // Only the brand-new page /two may be embedded; /target's text is untouched.
    for (const call of mock.spies.upsertChunks.mock.calls) {
      for (const doc of call[0] as Array<{ metadata: Metadata }>) {
        expect(doc.metadata.url).toBe("/two");
      }
    }
  });

  it("refreshes publishedAt without re-embedding", async () => {
    const jsonLd = (date: string): string =>
      `<script type="application/ld+json">{"@type":"Article","datePublished":"${date}"}</script>`;
    const body = `<h1>Post</h1><p>An article whose body never changes between the two runs.</p>`;

    const { cwd, config } = await createFixture({ post: { head: jsonLd("2024-01-01"), body } });
    const mock = createStatefulMockStore();

    const first = await IndexPipeline.create({ cwd, config, store: mock.store });
    await first.run({ changedOnly: true });
    const before = mock.chunksFor("/post")[0]?.publishedAt;
    expect(typeof before).toBe("number");

    await writePages(cwd, { post: { head: jsonLd("2025-06-01"), body } });
    mock.resetSpies();

    const second = await IndexPipeline.create({ cwd, config, store: mock.store });
    await second.run({ changedOnly: true });

    for (const chunk of mock.chunksFor("/post")) {
      expect(chunk.publishedAt).not.toBe(before);
    }
    expect(writeCounts(mock.spies).chunkUpserts).toBe(0);
  });

  it("refreshes routeFile when the source file moves under an unchanged URL", async () => {
    const { cwd, config } = await createFixture({
      about: { body: `<h1>About</h1><p>An about page whose text is the same in both runs.</p>` }
    });
    await fs.mkdir(path.join(cwd, "src", "routes", "about"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src", "routes", "about", "+page.svelte"), "<h1>About</h1>", "utf8");

    const mock = createStatefulMockStore();
    const first = await IndexPipeline.create({ cwd, config, store: mock.store });
    await first.run({ changedOnly: true });
    expect(mock.pages.get("/about")?.routeFile).toBe("src/routes/about/+page.svelte");
    expect(mock.chunksFor("/about")[0]?.routeFile).toBe("src/routes/about/+page.svelte");

    // Same URL, different source file — an MCP agent following routeFile would
    // otherwise be sent to a path that no longer exists.
    await fs.rm(path.join(cwd, "src", "routes", "about"), { recursive: true });
    await fs.mkdir(path.join(cwd, "src", "routes", "[slug]"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src", "routes", "[slug]", "+page.svelte"), "<h1>About</h1>", "utf8");
    mock.resetSpies();

    const second = await IndexPipeline.create({ cwd, config, store: mock.store });
    await second.run({ changedOnly: true });

    expect(mock.pages.get("/about")?.routeFile).toBe("src/routes/[slug]/+page.svelte");
    for (const chunk of mock.chunksFor("/about")) {
      expect(chunk.routeFile).toBe("src/routes/[slug]/+page.svelte");
    }
    const counts = writeCounts(mock.spies);
    expect(counts.chunkUpserts).toBe(0);
    expect(counts.chunkMetadataUpdates).toBeGreaterThan(0);
    expect(counts.pageUpserts).toBe(0);
    expect(counts.pageMetadataUpdates).toBe(1);
  });

  it("writes nothing at all on an identical rerun", async () => {
    const { cwd, config } = await createFixture({
      guide: { head: `<meta name="searchsocket:tags" content="alpha">`, body: sectionBody("One", "Two") },
      other: { body: `<h1>Other</h1><p>Another page so the run has more than one record.</p>` }
    });
    const mock = createStatefulMockStore();

    const first = await IndexPipeline.create({ cwd, config, store: mock.store });
    await first.run({ changedOnly: true });
    mock.resetSpies();

    const second = await IndexPipeline.create({ cwd, config, store: mock.store });
    const stats = await second.run({ changedOnly: true });

    expect(stats.chunksChanged).toBe(0);
    expect(stats.pagesChanged).toBe(0);
    expect(stats.documentsUpserted).toBe(0);
    expect(writeCounts(mock.spies)).toEqual({
      chunkUpserts: 0,
      chunkMetadataUpdates: 0,
      pageUpserts: 0,
      pageMetadataUpdates: 0
    });
  });
});

describe("hook output is fingerprinted", () => {
  const body = `<h1>Hooked</h1><p>Body copy that the hook will append a marker to.</p>`;

  it("reindexes when only a transformChunk hook's output changes", async () => {
    const { cwd, config } = await createFixture({ hooked: { body } });
    const mock = createStatefulMockStore();

    const withMarker = (marker: string) => ({
      transformChunk: async (chunk: Chunk): Promise<Chunk> => ({
        ...chunk,
        chunkText: `${chunk.chunkText}\n\n${marker}`
      })
    });

    const first = await IndexPipeline.create({ cwd, config, store: mock.store, hooks: withMarker("HOOK_V1") });
    await first.run({ changedOnly: true });
    expect(String(mock.chunksFor("/hooked")[0]?.chunkText)).toContain("HOOK_V1");

    // Only the hook changes. The source is untouched, so nothing but the final
    // payload can reveal that this run must write.
    const second = await IndexPipeline.create({ cwd, config, store: mock.store, hooks: withMarker("HOOK_V2") });
    await second.run({ changedOnly: true });

    for (const chunk of mock.chunksFor("/hooked")) {
      expect(String(chunk.chunkText)).toContain("HOOK_V2");
      expect(String(chunk.chunkText)).not.toContain("HOOK_V1");
      // The snippet is derived from the text, so it has to follow it.
      expect(String(chunk.snippet)).not.toContain("HOOK_V1");
    }
  });

  it("reindexes when only a beforeIndex hook's output changes", async () => {
    const { cwd, config } = await createFixture({ hooked: { body } });
    const mock = createStatefulMockStore();

    // Returns freshly constructed objects, which is what a hook that maps over
    // the array naturally produces.
    const withMarker = (marker: string) => ({
      beforeIndex: async (chunks: Chunk[]): Promise<Chunk[]> =>
        chunks.map((chunk) => ({ ...chunk, chunkText: `${chunk.chunkText}\n\n${marker}` }))
    });

    const first = await IndexPipeline.create({ cwd, config, store: mock.store, hooks: withMarker("BEFORE_V1") });
    await first.run({ changedOnly: true });
    expect(String(mock.chunksFor("/hooked")[0]?.chunkText)).toContain("BEFORE_V1");

    const second = await IndexPipeline.create({ cwd, config, store: mock.store, hooks: withMarker("BEFORE_V2") });
    await second.run({ changedOnly: true });

    for (const chunk of mock.chunksFor("/hooked")) {
      expect(String(chunk.chunkText)).toContain("BEFORE_V2");
      expect(String(chunk.chunkText)).not.toContain("BEFORE_V1");
    }
  });

  it("keeps a snippet the hook set explicitly", async () => {
    const { cwd, config } = await createFixture({ hooked: { body } });
    const mock = createStatefulMockStore();

    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store: mock.store,
      hooks: {
        transformChunk: async (chunk: Chunk): Promise<Chunk> => ({
          ...chunk,
          chunkText: `${chunk.chunkText}\n\nREWRITTEN`,
          snippet: "curated summary"
        })
      }
    });
    await pipeline.run({ changedOnly: true });

    for (const chunk of mock.chunksFor("/hooked")) {
      expect(chunk.snippet).toBe("curated summary");
    }
  });

  it("removes a chunk a hook starts returning null for", async () => {
    const { cwd, config } = await createFixture({ guide: { body: sectionBody("Alpha", "Beta") } });
    const mock = createStatefulMockStore();

    const first = await IndexPipeline.create({ cwd, config, store: mock.store });
    await first.run({ changedOnly: true });
    expect(mock.chunksFor("/guide").map((chunk) => chunk.sectionTitle)).toContain("Beta");

    const second = await IndexPipeline.create({
      cwd,
      config,
      store: mock.store,
      hooks: {
        transformChunk: async (chunk: Chunk): Promise<Chunk | null> =>
          chunk.sectionTitle === "Beta" ? null : chunk
      }
    });
    await second.run({ changedOnly: true });

    expect(mock.chunksFor("/guide").map((chunk) => chunk.sectionTitle)).not.toContain("Beta");
  });

  it("rejects a duplicate chunk key instead of writing the record twice", async () => {
    const { cwd, config } = await createFixture({ hooked: { body } });
    const mock = createStatefulMockStore();

    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store: mock.store,
      hooks: {
        // A hook that duplicates a chunk makes the write array and the
        // key-indexed plan disagree about what should exist.
        beforeIndex: async (chunks: Chunk[]): Promise<Chunk[]> => [...chunks, { ...chunks[0]! }]
      }
    });
    const stats = await pipeline.run({ changedOnly: true });

    const written = mock.spies.upsertChunks.mock.calls.flatMap(
      (call) => (call[0] as Array<{ id: string }>).map((doc) => doc.id)
    );
    expect(new Set(written).size).toBe(written.length);
    expect(stats.warnings.some((warning) => warning.detail.includes("duplicate chunk key"))).toBe(true);
    expect(stats.deletionEligible).toBe(false);
  });

  it("keeps a hooked run idempotent", async () => {
    const { cwd, config } = await createFixture({ hooked: { body } });
    const mock = createStatefulMockStore();
    const hooks = {
      transformChunk: async (chunk: Chunk): Promise<Chunk> => ({
        ...chunk,
        chunkText: `${chunk.chunkText}\n\nSTABLE`
      })
    };

    const first = await IndexPipeline.create({ cwd, config, store: mock.store, hooks });
    await first.run({ changedOnly: true });
    mock.resetSpies();

    const second = await IndexPipeline.create({ cwd, config, store: mock.store, hooks });
    const stats = await second.run({ changedOnly: true });

    expect(stats.chunksChanged).toBe(0);
    expect(writeCounts(mock.spies)).toEqual({
      chunkUpserts: 0,
      chunkMetadataUpdates: 0,
      pageUpserts: 0,
      pageMetadataUpdates: 0
    });
  });
});

describe("upgrading an index written before the fingerprints were split", () => {
  it("refreshes metadata once, re-embeds nothing, and settles", async () => {
    const { cwd, config } = await createFixture({
      guide: { body: sectionBody("Alpha", "Beta") },
      other: { body: `<h1>Other</h1><p>Another page so more than one record is upgraded.</p>` }
    });
    const mock = createStatefulMockStore();

    const first = await IndexPipeline.create({ cwd, config, store: mock.store });
    await first.run({ changedOnly: true });

    // Rewind storage to what an older version would have left: an embedding
    // fingerprint and nothing else.
    for (const metadata of [...mock.chunks.values(), ...mock.pages.values()]) {
      delete metadata.metadataHash;
    }
    const chunkCount = mock.chunks.size;
    const pageCount = mock.pages.size;
    mock.resetSpies();

    const upgrade = await IndexPipeline.create({ cwd, config, store: mock.store });
    await upgrade.run({ changedOnly: true });

    const counts = writeCounts(mock.spies);
    expect(counts.chunkUpserts).toBe(0);
    expect(counts.pageUpserts).toBe(0);
    expect(counts.chunkMetadataUpdates).toBe(chunkCount);
    expect(counts.pageMetadataUpdates).toBe(pageCount);

    mock.resetSpies();
    const settled = await IndexPipeline.create({ cwd, config, store: mock.store });
    const stats = await settled.run({ changedOnly: true });

    expect(stats.chunksChanged).toBe(0);
    expect(writeCounts(mock.spies)).toEqual({
      chunkUpserts: 0,
      chunkMetadataUpdates: 0,
      pageUpserts: 0,
      pageMetadataUpdates: 0
    });
  });

  it("recreates a record that vanished between the diff and the metadata write", async () => {
    const { cwd, config } = await createFixture({
      guide: { body: sectionBody("Alpha", "Beta") }
    });
    const mock = createStatefulMockStore();

    const first = await IndexPipeline.create({ cwd, config, store: mock.store });
    await first.run({ changedOnly: true });

    for (const metadata of mock.chunks.values()) delete metadata.metadataHash;
    // The backend loses one record after the diff has already read its hash.
    const doomed = [...mock.chunks.keys()][0]!;
    mock.spies.updateChunkMetadata.mockImplementationOnce(async () => [doomed]);
    mock.resetSpies();

    const second = await IndexPipeline.create({ cwd, config, store: mock.store });
    await second.run({ changedOnly: true });

    const upserted = mock.spies.upsertChunks.mock.calls.flatMap(
      (call) => (call[0] as Array<{ id: string }>).map((doc) => doc.id)
    );
    expect(upserted).toEqual([doomed]);
  });
});

describe("a run that may not write does not write metadata either", () => {
  it("skips the metadata-only path when the deletion plan is refused", async () => {
    const { cwd, config } = await createFixture({
      guide: { head: `<meta name="searchsocket:tags" content="alpha">`, body: sectionBody("One", "Two") },
      "doomed-a": { body: `<h1>A</h1><p>One of the pages that will disappear in run two.</p>` },
      "doomed-b": { body: `<h1>B</h1><p>One of the pages that will disappear in run two.</p>` },
      "doomed-c": { body: `<h1>C</h1><p>One of the pages that will disappear in run two.</p>` }
    });
    const mock = createStatefulMockStore();

    const first = await IndexPipeline.create({ cwd, config, store: mock.store });
    await first.run({ changedOnly: true });

    const storedBefore = new Map([...mock.chunks].map(([key, value]) => [key, { ...value }]));

    // Three of four pages vanish, which trips the deletion-ratio guard, and the
    // guard refuses the whole mutation. The tag edit on the surviving page is a
    // metadata-only refresh — the cheapest possible write — and it must be
    // withheld too, or a refused run still mutates the index.
    for (const name of ["doomed-a", "doomed-b", "doomed-c"]) {
      await fs.rm(path.join(cwd, "build", name), { recursive: true });
    }
    await writePages(cwd, {
      guide: { head: `<meta name="searchsocket:tags" content="beta">`, body: sectionBody("One", "Two") }
    });
    mock.resetSpies();

    const second = await IndexPipeline.create({ cwd, config, store: mock.store });
    const stats = await second.run({ changedOnly: true });

    expect(stats.deletionEligible).toBe(false);
    expect(writeCounts(mock.spies)).toEqual({
      chunkUpserts: 0,
      chunkMetadataUpdates: 0,
      pageUpserts: 0,
      pageMetadataUpdates: 0
    });
    expect(mock.chunks).toEqual(storedBefore);
  });
});

describe("canonical serialization", () => {
  it("cannot be fooled by a field value that looks like a delimiter", async () => {
    // Delimiter-joining made these two pages share a hash preimage: `|` occurs
    // freely in tags, keywords and markdown tables.
    const withSplitFields = await createFixture({
      guide: {
        head: `<meta name="searchsocket:tags" content="alpha"><meta name="description" content="beta">`,
        body: `<h1>Guide</h1><p>Identical prose in both fixtures for this comparison.</p>`
      }
    });
    const withJoinedField = await createFixture({
      guide: {
        head: `<meta name="searchsocket:tags" content="alpha|beta">`,
        body: `<h1>Guide</h1><p>Identical prose in both fixtures for this comparison.</p>`
      }
    });

    const hashes: string[] = [];
    for (const fixture of [withSplitFields, withJoinedField]) {
      const mock = createStatefulMockStore();
      const pipeline = await IndexPipeline.create({
        cwd: fixture.cwd,
        config: fixture.config,
        store: mock.store
      });
      await pipeline.run({ changedOnly: true });
      hashes.push(String(mock.pages.get("/guide")?.contentHash));
    }

    expect(hashes[0]).not.toBe(hashes[1]);
  });
});

describe("chunk identity survives its own edge cases", () => {
  it("does not let a real section collide with the synthetic summary chunk", () => {
    // The summary's key is derived from a synthetic `__summary__` identity that
    // page content is perfectly entitled to reproduce.
    const config = createDefaultConfig("searchsocket-collision");
    config.chunking.maxChars = 100;
    config.chunking.minChars = 1;
    config.chunking.overlapChars = 0;

    const page: IndexedPage = {
      url: "/collide",
      title: "Collide",
      scope: "main",
      routeFile: "",
      routeResolution: "exact",
      generatedAt: new Date().toISOString(),
      incomingLinks: 0,
      outgoingLinks: 0,
      outgoingLinkUrls: [],
      depth: 1,
      tags: [],
      markdown: `# __summary__\n\n${"x".repeat(100)}\n\n__summary__`
    };

    const chunks = chunkPage(page, config, resolveScope(config, "main"));
    const keys = chunks.map((chunk) => chunk.chunkKey);

    expect(chunks.some((chunk) => chunk.chunkText === "__summary__")).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("further fingerprint coverage", () => {
  it("re-embeds a page when only its keyword order changes", async () => {
    const keywords = (content: string): string => `<meta name="keywords" content="${content}">`;
    const body = `<h1>Ordered</h1><p>Prose that is byte-identical across both of these runs.</p>`;

    const { cwd, config } = await createFixture({ ordered: { head: keywords("alpha, beta"), body } });
    const mock = createStatefulMockStore();

    const first = await IndexPipeline.create({ cwd, config, store: mock.store });
    await first.run({ changedOnly: true });
    const summaryBefore = mock.pages.get("/ordered")?.summary;

    await writePages(cwd, { ordered: { head: keywords("beta, alpha"), body } });
    mock.resetSpies();

    const second = await IndexPipeline.create({ cwd, config, store: mock.store });
    await second.run({ changedOnly: true });

    // The summary is what gets embedded, and it joins keywords in order — so a
    // reorder must go down the re-embed path, not the metadata-only one.
    expect(mock.pages.get("/ordered")?.summary).not.toBe(summaryBefore);
    expect(writeCounts(mock.spies).pageUpserts).toBe(1);
    expect(writeCounts(mock.spies).pageMetadataUpdates).toBe(0);
  });

  it("keeps a chunk hook's in-place mutation out of the page record", async () => {
    const body = `<h1>Shared</h1><p>Pages and chunks share the very same tags array.</p>`;
    const { cwd, config } = await createFixture({ shared: { body } });
    const mock = createStatefulMockStore();

    const tagging = (marker: string) => ({
      transformChunk: async (chunk: Chunk): Promise<Chunk> => {
        chunk.tags.push(marker);
        return chunk;
      }
    });

    const first = await IndexPipeline.create({ cwd, config, store: mock.store, hooks: tagging("HOOK_V1") });
    await first.run({ changedOnly: true });
    expect(mock.pages.get("/shared")?.tags).not.toContain("HOOK_V1");

    const second = await IndexPipeline.create({ cwd, config, store: mock.store, hooks: tagging("HOOK_V2") });
    await second.run({ changedOnly: true });

    expect(mock.pages.get("/shared")?.tags).not.toContain("HOOK_V2");
    for (const chunk of mock.chunksFor("/shared")) {
      expect(chunk.tags).toContain("HOOK_V2");
      expect(chunk.tags).not.toContain("HOOK_V1");
    }
  });

  it("re-derives the snippet even when the hook also renames the chunk", async () => {
    const body = `<h1>Renamed</h1><p>Original prose that the hook is going to replace wholesale.</p>`;
    const { cwd, config } = await createFixture({ renamed: { body } });
    const mock = createStatefulMockStore();

    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store: mock.store,
      hooks: {
        transformChunk: async (chunk: Chunk): Promise<Chunk> => ({
          ...chunk,
          chunkKey: `${chunk.chunkKey}-renamed`,
          chunkText: "Completely different text supplied by the hook."
        })
      }
    });
    await pipeline.run({ changedOnly: true });

    for (const chunk of mock.chunksFor("/renamed")) {
      expect(String(chunk.snippet)).toContain("supplied by the hook");
      expect(String(chunk.snippet)).not.toContain("Original prose");
    }
  });

  it("re-upserts pages carrying an older page hash without re-embedding chunks", async () => {
    const { cwd, config } = await createFixture({
      guide: { body: sectionBody("Alpha", "Beta") },
      other: { body: `<h1>Other</h1><p>A second page so more than one record migrates.</p>` }
    });
    const mock = createStatefulMockStore();

    const first = await IndexPipeline.create({ cwd, config, store: mock.store });
    await first.run({ changedOnly: true });

    // An index written by a version whose page hash used a different preimage.
    for (const metadata of mock.pages.values()) {
      metadata.contentHash = "legacy-page-hash";
      delete metadata.metadataHash;
    }
    for (const metadata of mock.chunks.values()) delete metadata.metadataHash;
    const pageCount = mock.pages.size;
    const chunkCount = mock.chunks.size;
    mock.resetSpies();

    const migrate = await IndexPipeline.create({ cwd, config, store: mock.store });
    await migrate.run({ changedOnly: true });

    const counts = writeCounts(mock.spies);
    expect(counts.pageUpserts).toBe(pageCount);
    expect(counts.chunkUpserts).toBe(0);
    expect(counts.chunkMetadataUpdates).toBe(chunkCount);

    mock.resetSpies();
    const settled = await IndexPipeline.create({ cwd, config, store: mock.store });
    await settled.run({ changedOnly: true });
    expect(writeCounts(mock.spies)).toEqual({
      chunkUpserts: 0,
      chunkMetadataUpdates: 0,
      pageUpserts: 0,
      pageMetadataUpdates: 0
    });
  });
});
