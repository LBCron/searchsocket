import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import type { UpstashSearchStore } from "../src/vector/upstash";
import type { PageRecord, ResolvedSearchSocketConfig } from "../src/types";

const tempDirs: string[] = [];

/**
 * Creates a stateful mock store that tracks both chunk and page hashes,
 * simulating a real persistent store across multiple index runs.
 */
function createStatefulMockStore(): {
  store: UpstashSearchStore;
  getChunkHashes: () => Map<string, { contentHash: string; metadataHash?: string }>;
  getPageHashes: () => Map<string, { contentHash: string; metadataHash?: string; custom: boolean }>;
} {
  const chunkHashes = new Map<string, { contentHash: string; metadataHash?: string }>();
  const pageHashes = new Map<string, { contentHash: string; metadataHash?: string; custom: boolean }>();

  const store = {
    upsertChunks: vi.fn().mockImplementation(async (chunks: Array<{ id: string; metadata: { contentHash: string; metadataHash?: string } }>) => {
      for (const chunk of chunks) {
        chunkHashes.set(chunk.id, {
          contentHash: chunk.metadata.contentHash,
          metadataHash: chunk.metadata.metadataHash
        });
      }
    }),
    updateChunkMetadata: vi.fn().mockImplementation(async (items: Array<{ id: string; metadata: { metadataHash?: string } }>) => {
      const missing: string[] = [];
      for (const item of items) {
        const existing = chunkHashes.get(item.id);
        if (!existing) {
          missing.push(item.id);
          continue;
        }
        chunkHashes.set(item.id, { ...existing, metadataHash: item.metadata.metadataHash });
      }
      return missing;
    }),
    search: vi.fn().mockResolvedValue([]),
    deleteByIds: vi.fn().mockImplementation(async (ids: string[]) => {
      for (const id of ids) {
        chunkHashes.delete(id);
      }
    }),
    deleteScope: vi.fn().mockResolvedValue(undefined),
    listScopes: vi.fn().mockResolvedValue([]),
    getContentHashes: vi.fn().mockImplementation(async () => new Map(chunkHashes)),
    fetchContentHashesForKeys: vi.fn().mockImplementation(async (keys: string[]) => {
      const filtered = new Map<string, { contentHash: string; metadataHash?: string }>();
      for (const k of keys) {
        const v = chunkHashes.get(k);
        if (v) filtered.set(k, v);
      }
      return filtered;
    }),
    scanChunkIds: vi.fn().mockImplementation(async () => new Map([...chunkHashes.keys()].map((k) => [k, false]))),
    upsertPages: vi.fn().mockImplementation(async (pages: Array<{ id: string; data: string; metadata: Record<string, unknown> }>) => {
      for (const page of pages) {
        const contentHash = page.metadata.contentHash as string;
        if (contentHash) {
          pageHashes.set(page.id, {
            contentHash,
            metadataHash: page.metadata.metadataHash as string | undefined,
            custom: page.metadata.custom === true
          });
        }
      }
    }),
    updatePageMetadata: vi.fn().mockImplementation(async (items: Array<{ id: string; metadata: Record<string, unknown> }>) => {
      const missing: string[] = [];
      for (const item of items) {
        const existing = pageHashes.get(item.id);
        if (!existing) {
          missing.push(item.id);
          continue;
        }
        pageHashes.set(item.id, {
          ...existing,
          metadataHash: item.metadata.metadataHash as string | undefined
        });
      }
      return missing;
    }),
    getPage: vi.fn().mockResolvedValue(null),
    deletePages: vi.fn().mockImplementation(async () => {
      pageHashes.clear();
    }),
    getPageHashes: vi.fn().mockImplementation(async () => new Map(pageHashes)),
    deletePagesByIds: vi.fn().mockImplementation(async (ids: string[]) => {
      for (const id of ids) {
        pageHashes.delete(id);
      }
    }),
    health: vi.fn().mockResolvedValue({ ok: true }),
    dropAllIndexes: vi.fn().mockResolvedValue(undefined)
  } as unknown as UpstashSearchStore;

  return { store, getChunkHashes: () => new Map(chunkHashes), getPageHashes: () => new Map(pageHashes) };
}

async function createFixture(pageContents: Record<string, { title: string; body: string }>): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-incpages-"));
  tempDirs.push(cwd);

  for (const [pagePath, { title, body }] of Object.entries(pageContents)) {
    const dir = path.join(cwd, "build", pagePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`,
      "utf8"
    );

    const routeDir = path.join(cwd, "src", "routes", pagePath);
    await fs.mkdir(routeDir, { recursive: true });
    await fs.writeFile(path.join(routeDir, "+page.svelte"), `<main>${title}</main>\n`, "utf8");
  }

  const config = createDefaultConfig("searchsocket-incpages");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.state.dir = ".searchsocket";

  return { cwd, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("IndexPipeline incremental pages", () => {
  it("upserts all pages on fresh run", async () => {
    const { cwd, config } = await createFixture({
      "docs/alpha": { title: "Alpha", body: "Alpha content here." },
      "docs/beta": { title: "Beta", body: "Beta content here." }
    });
    const { store, getPageHashes } = createStatefulMockStore();

    const pipeline = await IndexPipeline.create({ cwd, config, store });
    const stats = await pipeline.run({ changedOnly: true });

    expect(stats.pagesProcessed).toBe(2);
    expect(stats.pagesChanged).toBe(2);
    expect(stats.pagesDeleted).toBe(0);
    expect(store.upsertPages).toHaveBeenCalled();
    expect(store.deletePages).not.toHaveBeenCalled();
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(getPageHashes().size).toBe(2);
  });

  it("skips unchanged pages on second run", async () => {
    const { cwd, config } = await createFixture({
      "docs/alpha": { title: "Alpha", body: "Alpha content here." },
      "docs/beta": { title: "Beta", body: "Beta content here." }
    });
    const { store } = createStatefulMockStore();

    // First run — all pages upserted
    const pipeline1 = await IndexPipeline.create({ cwd, config, store });
    await pipeline1.run({ changedOnly: true });

    // Clear call history
    vi.mocked(store.upsertPages).mockClear();
    vi.mocked(store.deletePagesByIds).mockClear();

    // Second run — nothing changed
    const pipeline2 = await IndexPipeline.create({ cwd, config, store });
    const stats2 = await pipeline2.run({ changedOnly: true });

    expect(stats2.pagesChanged).toBe(0);
    expect(stats2.pagesDeleted).toBe(0);
    expect(store.upsertPages).not.toHaveBeenCalled();
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
  });

  it("upserts only changed pages when one page is modified", async () => {
    const { cwd, config } = await createFixture({
      "docs/alpha": { title: "Alpha", body: "Alpha content here." },
      "docs/beta": { title: "Beta", body: "Beta content here." }
    });
    const { store } = createStatefulMockStore();

    // First run
    const pipeline1 = await IndexPipeline.create({ cwd, config, store });
    await pipeline1.run({ changedOnly: true });

    // Modify one page
    await fs.writeFile(
      path.join(cwd, "build", "docs", "alpha", "index.html"),
      "<html><head><title>Alpha</title></head><body><main><h1>Alpha</h1><p>Updated alpha content.</p></main></body></html>",
      "utf8"
    );

    vi.mocked(store.upsertPages).mockClear();

    // Second run
    const pipeline2 = await IndexPipeline.create({ cwd, config, store });
    const stats2 = await pipeline2.run({ changedOnly: true });

    expect(stats2.pagesChanged).toBe(1);
    expect(stats2.pagesDeleted).toBe(0);
    expect(store.upsertPages).toHaveBeenCalledTimes(1);

    // Verify only the changed page was upserted
    const upsertedPages = vi.mocked(store.upsertPages).mock.calls[0]![0] as Array<{ id: string }>;
    expect(upsertedPages).toHaveLength(1);
    expect(upsertedPages[0]!.id).toBe("/docs/alpha");
  });

  it("deletes stale pages when a page is removed", async () => {
    const { cwd, config } = await createFixture({
      "docs/alpha": { title: "Alpha", body: "Alpha content here." },
      "docs/beta": { title: "Beta", body: "Beta content here." }
    });
    const { store, getPageHashes } = createStatefulMockStore();

    // First run
    const pipeline1 = await IndexPipeline.create({ cwd, config, store });
    await pipeline1.run({ changedOnly: true });
    expect(getPageHashes().size).toBe(2);

    // Remove one page
    await fs.rm(path.join(cwd, "build", "docs", "beta"), { recursive: true, force: true });

    vi.mocked(store.deletePagesByIds).mockClear();
    vi.mocked(store.deletePages).mockClear();

    // Second run
    const pipeline2 = await IndexPipeline.create({ cwd, config, store });
    const stats2 = await pipeline2.run({ changedOnly: true });

    expect(stats2.pagesDeleted).toBe(1);
    expect(store.deletePagesByIds).toHaveBeenCalledTimes(1);
    expect(store.deletePages).not.toHaveBeenCalled();

    const deletedIds = vi.mocked(store.deletePagesByIds).mock.calls[0]![0] as string[];
    expect(deletedIds).toContain("/docs/beta");
  });

  it("re-upserts every page under force mode without wiping the index first", async () => {
    const { cwd, config } = await createFixture({
      "docs/alpha": { title: "Alpha", body: "Alpha content here." }
    });
    const { store } = createStatefulMockStore();

    // First incremental run
    const pipeline1 = await IndexPipeline.create({ cwd, config, store });
    await pipeline1.run({ changedOnly: true });

    vi.mocked(store.deletePages).mockClear();
    vi.mocked(store.upsertPages).mockClear();

    // Force run
    const pipeline2 = await IndexPipeline.create({ cwd, config, store });
    const stats2 = await pipeline2.run({ force: true });

    // Force used to call deletePages() first, leaving the index empty for the
    // duration of the re-upsert — a crash in between served an empty index.
    // Force now means "re-upsert everything regardless of hash".
    expect(store.deletePages).not.toHaveBeenCalled();
    expect(store.upsertPages).toHaveBeenCalled();
    expect(stats2.pagesChanged).toBe(1); // force treats all as changed
  });

  it("still removes pages that disappeared, under force mode", async () => {
    const { cwd, config } = await createFixture({
      "docs/alpha": { title: "Alpha", body: "Alpha content here." },
      "docs/beta": { title: "Beta", body: "Beta content here." }
    });
    const { store } = createStatefulMockStore();

    const pipeline1 = await IndexPipeline.create({ cwd, config, store });
    await pipeline1.run({ changedOnly: true });

    // Remove one page from the source
    await fs.rm(path.join(cwd, "build", "docs", "beta", "index.html"), { force: true });

    vi.mocked(store.deletePagesByIds).mockClear();
    const pipeline2 = await IndexPipeline.create({ cwd, config, store });
    const stats2 = await pipeline2.run({ force: true });

    expect(stats2.deletionEligible).toBe(true);
    expect(stats2.pagesDeleted).toBe(1);
    expect(store.deletePagesByIds).toHaveBeenCalledWith(["/docs/beta"], expect.anything());
  });

  it("does not write pages on dry run", async () => {
    const { cwd, config } = await createFixture({
      "docs/alpha": { title: "Alpha", body: "Alpha content here." }
    });
    const { store } = createStatefulMockStore();

    const pipeline = await IndexPipeline.create({ cwd, config, store });
    const stats = await pipeline.run({ dryRun: true });

    expect(stats.pagesProcessed).toBe(1);
    expect(store.upsertPages).not.toHaveBeenCalled();
    expect(store.deletePages).not.toHaveBeenCalled();
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
  });

  it("reports correct pagesChanged and pagesDeleted stats", async () => {
    const { cwd, config } = await createFixture({
      "docs/alpha": { title: "Alpha", body: "Alpha content." },
      "docs/beta": { title: "Beta", body: "Beta content." },
      "docs/gamma": { title: "Gamma", body: "Gamma content." }
    });
    const { store } = createStatefulMockStore();

    // First run — all 3 pages are new
    const pipeline1 = await IndexPipeline.create({ cwd, config, store });
    const stats1 = await pipeline1.run({ changedOnly: true });
    expect(stats1.pagesChanged).toBe(3);
    expect(stats1.pagesDeleted).toBe(0);

    // Modify alpha, remove gamma
    await fs.writeFile(
      path.join(cwd, "build", "docs", "alpha", "index.html"),
      "<html><head><title>Alpha</title></head><body><main><h1>Alpha</h1><p>New alpha text.</p></main></body></html>",
      "utf8"
    );
    await fs.rm(path.join(cwd, "build", "docs", "gamma"), { recursive: true, force: true });

    // Second run
    const pipeline2 = await IndexPipeline.create({ cwd, config, store });
    const stats2 = await pipeline2.run({ changedOnly: true });

    expect(stats2.pagesProcessed).toBe(2);
    expect(stats2.pagesChanged).toBe(1); // only alpha changed
    expect(stats2.pagesDeleted).toBe(1); // gamma was deleted
  });
});
