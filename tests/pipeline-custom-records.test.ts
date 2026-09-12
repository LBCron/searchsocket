import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import type { UpstashSearchStore } from "../src/vector/upstash";
import type { ResolvedSearchSocketConfig, CustomRecord } from "../src/types";

const tempDirs: string[] = [];

function createMockStore(
  existingHashes = new Map<string, { contentHash: string; metadataHash?: string }>(),
  existingPageHashes = new Map<string, { contentHash: string; custom: boolean }>()
): UpstashSearchStore {
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
    getPageHashes: vi.fn().mockResolvedValue(existingPageHashes),
    deletePagesByIds: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ok: true }),
    dropAllIndexes: vi.fn().mockResolvedValue(undefined)
  } as unknown as UpstashSearchStore;
}

async function createFixture(opts?: {
  includeHtmlPage?: boolean;
  strictRouteMapping?: boolean;
}): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-custom-"));
  tempDirs.push(cwd);

  await fs.mkdir(path.join(cwd, "build"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes"), { recursive: true });

  if (opts?.includeHtmlPage) {
    await fs.mkdir(path.join(cwd, "build", "docs"), { recursive: true });
    await fs.mkdir(path.join(cwd, "src", "routes", "docs"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "build", "docs", "index.html"),
      `<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>Documentation page content.</p></main></body></html>`,
      "utf8"
    );
    await fs.writeFile(
      path.join(cwd, "src", "routes", "docs", "+page.svelte"),
      "<main>Docs</main>\n",
      "utf8"
    );
  }

  const config = createDefaultConfig("searchsocket-custom-test");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.state.dir = ".searchsocket";
  if (opts?.strictRouteMapping) {
    config.source.strictRouteMapping = true;
  }

  return { cwd, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("IndexPipeline custom records", () => {
  it("indexes custom records into both page and chunk indices", async () => {
    const { cwd, config } = await createFixture();
    const store = createMockStore();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    const stats = await pipeline.run({
      customRecords: [
        { url: "/api/openapi", title: "OpenAPI Spec", content: "# API Reference\n\nEndpoint documentation." },
        { url: "/changelog/v2", title: "Changelog v2", content: "## Version 2.0\n\nNew features and improvements." }
      ]
    });

    expect(stats.pagesProcessed).toBe(2);
    expect(stats.chunksTotal).toBeGreaterThanOrEqual(2);
    expect(store.upsertPages).toHaveBeenCalled();
    expect(store.upsertChunks).toHaveBeenCalled();

    // Verify page URLs in upserted pages
    const upsertPagesCall = (store.upsertPages as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const pageUrls = upsertPagesCall[0].map((d: { id: string }) => d.id);
    expect(pageUrls).toContain("/api/openapi");
    expect(pageUrls).toContain("/changelog/v2");
  });

  it("forwards tags to chunks", async () => {
    const { cwd, config } = await createFixture();
    const store = createMockStore();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    await pipeline.run({
      customRecords: [
        { url: "/api/spec", title: "API Spec", content: "API content here.", tags: ["api", "reference"] }
      ]
    });

    const upsertChunksCall = (store.upsertChunks as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const chunkDoc = upsertChunksCall[0][0];
    expect(chunkDoc.metadata.tags).toContain("api");
    expect(chunkDoc.metadata.tags).toContain("reference");
  });

  it("skips custom records with weight 0", async () => {
    const { cwd, config } = await createFixture();
    const store = createMockStore();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    const stats = await pipeline.run({
      customRecords: [
        { url: "/hidden", title: "Hidden", content: "Should not be indexed.", weight: 0 }
      ]
    });

    expect(stats.pagesProcessed).toBe(0);
  });

  it("does not throw with strict route mapping for virtual URLs", async () => {
    const { cwd, config } = await createFixture({ strictRouteMapping: true });
    const store = createMockStore();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    const stats = await pipeline.run({
      customRecords: [
        { url: "/api/virtual-endpoint", title: "Virtual", content: "Virtual page content." }
      ]
    });

    expect(stats.pagesProcessed).toBe(1);
    expect(store.upsertPages).toHaveBeenCalled();
    const upsertPagesCall = (store.upsertPages as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(upsertPagesCall[0][0].id).toBe("/api/virtual-endpoint");
  });

  it("treats content as literal markdown without frontmatter parsing", async () => {
    const { cwd, config } = await createFixture();
    const store = createMockStore();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    // Content with frontmatter that would cause extractFromMarkdown to drop the record
    const stats = await pipeline.run({
      customRecords: [
        {
          url: "/frontmatter-test",
          title: "Frontmatter Test",
          content: "---\nsearchsocket:\n  noindex: true\n---\n\nActual content that should be indexed."
        }
      ]
    });

    // Record should still be indexed — frontmatter is treated as literal content
    expect(stats.pagesProcessed).toBe(1);
  });

  it("caller weight takes precedence over content with frontmatter weight", async () => {
    const { cwd, config } = await createFixture();
    const store = createMockStore();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    // Content that would set weight=0 via frontmatter, but caller sets weight=2
    const stats = await pipeline.run({
      customRecords: [
        {
          url: "/weight-override",
          title: "Weight Override",
          content: "---\nsearchsocket:\n  weight: 0\n---\n\nContent.",
          weight: 2
        }
      ]
    });

    expect(stats.pagesProcessed).toBe(1);
  });

  it("coexists with source pages", async () => {
    const { cwd, config } = await createFixture({ includeHtmlPage: true });
    const store = createMockStore();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    const stats = await pipeline.run({
      customRecords: [
        { url: "/api/spec", title: "API Spec", content: "API content." }
      ]
    });

    expect(stats.pagesProcessed).toBe(2); // 1 HTML + 1 custom
  });

  it("source page wins on URL collision with warning", async () => {
    const { cwd, config } = await createFixture({ includeHtmlPage: true });
    const store = createMockStore();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    // Custom record URL collides with the HTML page at /docs
    const stats = await pipeline.run({
      customRecords: [
        { url: "/docs", title: "Custom Docs", content: "Custom docs content." }
      ]
    });

    // Dedup keeps first (after sort), so only one page for /docs
    expect(stats.pagesProcessed).toBe(1);

    // Verify upserted page title is from the HTML source page (which is "Docs")
    const upsertPagesCall = (store.upsertPages as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const docsPage = upsertPagesCall[0].find((d: { id: string }) => d.id === "/docs");
    expect(docsPage.metadata.title).toBe("Docs");
  });

  it("skips custom records with empty content", async () => {
    const { cwd, config } = await createFixture();
    const store = createMockStore();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    const stats = await pipeline.run({
      customRecords: [
        { url: "/empty", title: "Empty", content: "" }
      ]
    });

    expect(stats.pagesProcessed).toBe(0);
  });

  it("applies transformPage hook to custom records", async () => {
    const { cwd, config } = await createFixture();
    const store = createMockStore();
    const transformPage = vi.fn().mockImplementation((page) => {
      if (page.url === "/skip-me") return null;
      return { ...page, title: "Transformed: " + page.title };
    });

    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
      hooks: { transformPage }
    });

    const stats = await pipeline.run({
      customRecords: [
        { url: "/keep", title: "Keep", content: "Keep this record." },
        { url: "/skip-me", title: "Skip", content: "Skip this record." }
      ]
    });

    expect(stats.pagesProcessed).toBe(1);
    expect(transformPage).toHaveBeenCalledTimes(2);

    const upsertPagesCall = (store.upsertPages as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(upsertPagesCall[0][0].metadata.title).toBe("Transformed: Keep");
  });

  it("produces no writes on dry run", async () => {
    const { cwd, config } = await createFixture();
    const store = createMockStore();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    const stats = await pipeline.run({
      dryRun: true,
      customRecords: [
        { url: "/api/spec", title: "API Spec", content: "Dry run content." }
      ]
    });

    expect(stats.pagesProcessed).toBe(1);
    expect(stats.documentsUpserted).toBe(0);
    expect(store.upsertChunks).not.toHaveBeenCalled();
    expect(store.upsertPages).not.toHaveBeenCalled();
  });

  it("handles undefined and empty customRecords without regression", async () => {
    const { cwd, config } = await createFixture({ includeHtmlPage: true });
    const store = createMockStore();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    const statsUndefined = await pipeline.run({});
    const store2 = createMockStore();
    const pipeline2 = await IndexPipeline.create({
      cwd,
      config,
      store: store2,
    });
    const statsEmpty = await pipeline2.run({ customRecords: [] });

    expect(statsUndefined.pagesProcessed).toBe(1);
    expect(statsEmpty.pagesProcessed).toBe(1);
  });

  it("applies custom weight override", async () => {
    const { cwd, config } = await createFixture();
    const store = createMockStore();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    // weight=2 should not be filtered (only weight=0 is filtered)
    const stats = await pipeline.run({
      customRecords: [
        { url: "/weighted", title: "Weighted Page", content: "Content with weight.", weight: 2 }
      ]
    });

    expect(stats.pagesProcessed).toBe(1);
  });
});
