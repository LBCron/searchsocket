import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import type { UpstashSearchStore } from "../src/vector/upstash";
import type { ResolvedSearchSocketConfig } from "../src/types";

const tempDirs: string[] = [];

function createMockStore(): UpstashSearchStore {
  return {
    upsertChunks: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    deleteByIds: vi.fn().mockResolvedValue(undefined),
    deleteScope: vi.fn().mockResolvedValue(undefined),
    listScopes: vi.fn().mockResolvedValue([]),
    getContentHashes: vi.fn().mockResolvedValue(new Map()),
    fetchContentHashesForKeys: vi.fn().mockResolvedValue(new Map()),
    scanChunkIds: vi.fn().mockResolvedValue(new Map()),
    upsertPages: vi.fn().mockResolvedValue(undefined),
    getPage: vi.fn().mockResolvedValue(null),
    deletePages: vi.fn().mockResolvedValue(undefined),
    getPageHashes: vi.fn().mockResolvedValue(new Map()),
    deletePagesByIds: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ok: true }),
    dropAllIndexes: vi.fn().mockResolvedValue(undefined)
  } as unknown as UpstashSearchStore;
}

async function createProjectFixture(): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-strict-routes-"));
  tempDirs.push(cwd);

  await fs.mkdir(path.join(cwd, "build", "docs", "orphan"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes"), { recursive: true });

  await fs.writeFile(
    path.join(cwd, "build", "docs", "orphan", "index.html"),
    `
      <html>
        <head><title>Orphan</title></head>
        <body><main><h1>Orphan Page</h1></main></body>
      </html>
    `,
    "utf8"
  );

  // Intentionally only root route so /docs/orphan falls back to best-effort mapping.
  await fs.writeFile(path.join(cwd, "src", "routes", "+page.svelte"), "<main>Root</main>\n", "utf8");

  const config = createDefaultConfig("searchsocket-strict-routes");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.source.strictRouteMapping = true;
  config.state.dir = ".searchsocket";

  return { cwd, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createRootOnlyFixture(): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-strict-root-"));
  tempDirs.push(cwd);

  await fs.mkdir(path.join(cwd, "build"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes"), { recursive: true });

  await fs.writeFile(
    path.join(cwd, "build", "index.html"),
    `
      <html>
        <head><title>Home</title></head>
        <body><main><h1>Home Page</h1><p>Welcome to the homepage of the site.</p></main></body>
      </html>
    `,
    "utf8"
  );

  await fs.writeFile(path.join(cwd, "src", "routes", "+page.svelte"), "<main>Root</main>\n", "utf8");

  const config = createDefaultConfig("searchsocket-strict-root");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.source.strictRouteMapping = true;
  config.state.dir = ".searchsocket";

  return { cwd, config };
}

describe("IndexPipeline strict route mapping", () => {
  it("fails with a 4xx error when no exact route mapping exists", async () => {
    const { cwd, config } = await createProjectFixture();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store: createMockStore(),
    });

    await expect(pipeline.run({ changedOnly: true })).rejects.toMatchObject({
      code: "ROUTE_MAPPING_FAILED",
      status: 400
    });
  });

  it("accepts a homepage backed by a real root +page.svelte", async () => {
    const { cwd, config } = await createRootOnlyFixture();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store: createMockStore(),
    });

    const stats = await pipeline.run({ changedOnly: false });

    // The homepage must resolve exactly; a best-effort fallback would have
    // thrown under strict mapping.
    expect(stats.pagesProcessed).toBe(1);
    expect(stats.routeExact).toBe(1);
    expect(stats.routeBestEffort).toBe(0);
  });
});
