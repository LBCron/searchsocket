import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import type { UpstashSearchStore } from "../src/vector/upstash";
import type { ResolvedSearchSocketConfig } from "../src/types";

const tempDirs: string[] = [];

function createMockStore(existingHashes = new Map<string, { contentHash: string; metadataHash?: string }>()): UpstashSearchStore {
  return {
    upsertChunks: vi.fn().mockResolvedValue(undefined),
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

async function createFixture(): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-cost-"));
  tempDirs.push(cwd);

  await fs.mkdir(path.join(cwd, "build", "docs"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "docs"), { recursive: true });

  await fs.writeFile(
    path.join(cwd, "build", "docs", "index.html"),
    `<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>Token source.</p></main></body></html>`,
    "utf8"
  );
  await fs.writeFile(path.join(cwd, "src", "routes", "docs", "+page.svelte"), "<main>Docs</main>\n", "utf8");

  const config = createDefaultConfig("searchsocket-cost");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.state.dir = ".searchsocket";

  return { cwd, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("IndexPipeline documentsUpserted tracking", () => {
  it("reports documentsUpserted for changed chunks", async () => {
    const { cwd, config } = await createFixture();
    const store = createMockStore();

    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    const stats = await pipeline.run({ changedOnly: true });
    expect(stats.chunksChanged).toBeGreaterThan(0);
    expect(stats.documentsUpserted).toBe(stats.chunksChanged);
  });

  it("reports zero documentsUpserted on dry run", async () => {
    const { cwd, config } = await createFixture();
    const store = createMockStore();

    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    const stats = await pipeline.run({ changedOnly: true, dryRun: true });
    expect(stats.chunksChanged).toBeGreaterThan(0);
    expect(stats.documentsUpserted).toBe(0);
  });
});
