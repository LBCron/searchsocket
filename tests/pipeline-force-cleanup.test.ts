import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import type { UpstashSearchStore } from "../src/vector/upstash";
import type { ResolvedSearchSocketConfig } from "../src/types";

const tempDirs: string[] = [];

/**
 * Creates a mock UpstashSearchStore that tracks upserted chunk hashes and deleted IDs.
 * The internal state is shared across calls, simulating a real persistent store.
 */
function createStatefulMockStore(): {
  store: UpstashSearchStore;
  getHashes: () => Map<string, { contentHash: string; metadataHash?: string }>;
} {
  const hashes = new Map<string, { contentHash: string; metadataHash?: string }>();

  const store = {
    upsertChunks: vi.fn().mockImplementation(async (chunks: Array<{ id: string; metadata: { contentHash: string; metadataHash?: string } }>) => {
      for (const chunk of chunks) {
        hashes.set(chunk.id, {
          contentHash: chunk.metadata.contentHash,
          metadataHash: chunk.metadata.metadataHash
        });
      }
    }),
    search: vi.fn().mockResolvedValue([]),
    deleteByIds: vi.fn().mockImplementation(async (ids: string[]) => {
      for (const id of ids) {
        hashes.delete(id);
      }
    }),
    deleteScope: vi.fn().mockResolvedValue(undefined),
    listScopes: vi.fn().mockResolvedValue([]),
    getContentHashes: vi.fn().mockImplementation(async () => new Map(hashes)),
    fetchContentHashesForKeys: vi.fn().mockImplementation(async (keys: string[]) => {
      const filtered = new Map<string, { contentHash: string; metadataHash?: string }>();
      for (const k of keys) {
        const v = hashes.get(k);
        if (v) filtered.set(k, v);
      }
      return filtered;
    }),
    scanChunkIds: vi.fn().mockImplementation(async () => new Map([...hashes.keys()].map((k) => [k, false]))),
    upsertPages: vi.fn().mockResolvedValue(undefined),
    getPage: vi.fn().mockResolvedValue(null),
    deletePages: vi.fn().mockResolvedValue(undefined),
    getPageHashes: vi.fn().mockResolvedValue(new Map()),
    deletePagesByIds: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ok: true }),
    dropAllIndexes: vi.fn().mockResolvedValue(undefined)
  } as unknown as UpstashSearchStore;

  return { store, getHashes: () => new Map(hashes) };
}

async function createFixture(): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-force-"));
  tempDirs.push(cwd);

  await fs.mkdir(path.join(cwd, "build", "docs", "keep"), { recursive: true });
  await fs.mkdir(path.join(cwd, "build", "docs", "remove"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "docs", "keep"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "docs", "remove"), { recursive: true });

  await fs.writeFile(
    path.join(cwd, "build", "docs", "keep", "index.html"),
    "<html><head><title>Keep</title></head><body><main><h1>Keep</h1><p>Keep me indexed.</p></main></body></html>",
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "build", "docs", "remove", "index.html"),
    "<html><head><title>Remove</title></head><body><main><h1>Remove</h1><p>Delete me from index.</p></main></body></html>",
    "utf8"
  );

  await fs.writeFile(path.join(cwd, "src", "routes", "docs", "keep", "+page.svelte"), "<main>Keep</main>\n", "utf8");
  await fs.writeFile(path.join(cwd, "src", "routes", "docs", "remove", "+page.svelte"), "<main>Remove</main>\n", "utf8");

  const config = createDefaultConfig("searchsocket-force");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.state.dir = ".searchsocket";

  return { cwd, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("IndexPipeline force cleanup", () => {
  it("removes stale documents for deleted pages on reindex", async () => {
    const { cwd, config } = await createFixture();
    const { store, getHashes } = createStatefulMockStore();

    const firstPipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    const firstStats = await firstPipeline.run({ changedOnly: true });
    expect(firstStats.chunksTotal).toBeGreaterThan(1);

    const firstHashes = getHashes();
    expect(firstHashes.size).toBe(firstStats.chunksTotal);

    // Remove one page from the source
    await fs.rm(path.join(cwd, "build", "docs", "remove"), { recursive: true, force: true });

    // Reindex with changedOnly — the pipeline compares current chunks
    // against the store's content hashes and deletes stale entries.
    const secondPipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    const secondStats = await secondPipeline.run({ changedOnly: true });
    const secondHashes = getHashes();

    expect(secondStats.chunksTotal).toBeLessThan(firstStats.chunksTotal);
    expect(secondStats.deletes).toBeGreaterThan(0);
    expect(secondHashes.size).toBe(secondStats.chunksTotal);

    const removedChunkIds = [...firstHashes.keys()].filter((id) => !secondHashes.has(id));
    expect(removedChunkIds.length).toBeGreaterThan(0);
  });
});
