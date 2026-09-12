import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import type { UpstashSearchStore } from "../src/vector/upstash";

const tempDirs: string[] = [];

function createMockStore(
  existingHashes: Map<string, { contentHash: string; metadataHash?: string }>,
  upsertSpy?: ReturnType<typeof vi.fn>
): UpstashSearchStore {
  return {
    upsertChunks: upsertSpy ?? vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    deleteByIds: vi.fn().mockResolvedValue(undefined),
    deleteScope: vi.fn().mockResolvedValue(undefined),
    listScopes: vi.fn().mockResolvedValue([]),
    getContentHashes: vi.fn().mockResolvedValue(existingHashes),
    fetchContentHashesForKeys: vi.fn().mockImplementation(async (keys: string[]) => {
      const filtered = new Map<string, { contentHash: string; metadataHash?: string }>();
      for (const k of keys) {
        const v = existingHashes.get(k);
        if (v) filtered.set(k, v);
      }
      return filtered;
    }),
    scanChunkIds: vi.fn().mockResolvedValue(new Map([...existingHashes.keys()].map((k) => [k, false]))),
    upsertPages: vi.fn().mockResolvedValue(undefined),
    getPage: vi.fn().mockResolvedValue(null),
    deletePages: vi.fn().mockResolvedValue(undefined),
    getPageHashes: vi.fn().mockResolvedValue(new Map()),
    deletePagesByIds: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ok: true }),
    dropAllIndexes: vi.fn().mockResolvedValue(undefined)
  } as unknown as UpstashSearchStore;
}

async function createFixture(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-resync-"));
  tempDirs.push(cwd);

  await fs.mkdir(path.join(cwd, "build", "docs"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "docs"), { recursive: true });

  await fs.writeFile(
    path.join(cwd, "build", "docs", "index.html"),
    `
      <html>
        <head><title>Docs</title></head>
        <body><main><h1>Docs</h1><p>Stable content.</p></main></body>
      </html>
    `,
    "utf8"
  );
  await fs.writeFile(path.join(cwd, "src", "routes", "docs", "+page.svelte"), "<main>Docs</main>\n", "utf8");

  return cwd;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("IndexPipeline single-source-of-truth resync", () => {
  it("performs full index when store has no existing hashes (fresh state)", async () => {
    const cwd = await createFixture();
    const config = createDefaultConfig("searchsocket-resync");
    config.source.mode = "static-output";
    config.source.staticOutputDir = "build";
    config.state.dir = ".searchsocket";

    const upsertSpy = vi.fn().mockResolvedValue(undefined);
    const store = createMockStore(new Map(), upsertSpy);

    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    const stats = await pipeline.run({ changedOnly: true });
    expect(stats.chunksChanged).toBeGreaterThan(0);
    expect(upsertSpy).toHaveBeenCalled();
  });

  it("skips unchanged chunks when store has matching hashes", async () => {
    const cwd = await createFixture();
    const config = createDefaultConfig("searchsocket-resync");
    config.source.mode = "static-output";
    config.source.staticOutputDir = "build";
    config.state.dir = ".searchsocket";

    // First run to get the hashes
    const firstUpsertSpy = vi.fn().mockResolvedValue(undefined);
    const firstStore = createMockStore(new Map(), firstUpsertSpy);

    const firstPipeline = await IndexPipeline.create({
      cwd,
      config,
      store: firstStore,
    });
    const firstStats = await firstPipeline.run({ changedOnly: true });
    expect(firstStats.chunksChanged).toBeGreaterThan(0);

    // Collect the hashes from the upserted chunks
    const existingHashes = new Map<string, { contentHash: string; metadataHash?: string }>();
    for (const call of firstUpsertSpy.mock.calls) {
      const chunks = call[0];
      for (const chunk of chunks) {
        existingHashes.set(chunk.id, {
          contentHash: chunk.metadata.contentHash,
          metadataHash: chunk.metadata.metadataHash
        });
      }
    }

    // Second run with existing hashes should skip all chunks
    const secondUpsertSpy = vi.fn().mockResolvedValue(undefined);
    const secondStore = createMockStore(existingHashes, secondUpsertSpy);

    const secondPipeline = await IndexPipeline.create({
      cwd,
      config,
      store: secondStore,
    });
    const secondStats = await secondPipeline.run({ changedOnly: true });

    expect(secondStats.chunksChanged).toBe(0);
    expect(secondUpsertSpy).not.toHaveBeenCalled();
  });
});
