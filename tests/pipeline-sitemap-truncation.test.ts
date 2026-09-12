import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import type { UpstashSearchStore } from "../src/vector/upstash";
import type { PageRecord, ResolvedSearchSocketConfig } from "../src/types";

/**
 * Release-blocking invariant, at pipeline level: a sitemap traversal stopped by
 * MAX_SITEMAPS must not delete the pages it never enumerated.
 *
 * The loader-level assertions live in crawl-source.test.ts. These run the whole
 * pipeline because the audit's warning was specifically that a loader can lose
 * its truncation flag on the way up to the deletion gate.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

/** A store that remembers what was written, so run 2 sees run 1's records. */
function createStatefulMockStore() {
  const pageHashes = new Map<string, { contentHash: string; custom: boolean }>();
  const chunkIds = new Set<string>();
  const chunkHashes = new Map<string, string>();

  const store = {
    getPageHashes: vi.fn(async () => new Map(pageHashes)),
    upsertPages: vi.fn(async (docs: Array<{ id: string; metadata: { contentHash?: string; custom?: boolean } }>) => {
      for (const doc of docs) {
        pageHashes.set(doc.id, {
          contentHash: doc.metadata.contentHash ?? "",
          custom: doc.metadata.custom === true
        });
      }
    }),
    deletePagesByIds: vi.fn(async (ids: string[]) => {
      for (const id of ids) pageHashes.delete(id);
    }),
    deletePages: vi.fn(async () => pageHashes.clear()),
    scanChunkIds: vi.fn(async () => new Map([...chunkIds].map((k) => [k, false]))),
    fetchContentHashesForKeys: vi.fn(async (keys: string[]) => {
      const out = new Map<string, string>();
      for (const key of keys) {
        const hash = chunkHashes.get(key);
        if (hash !== undefined) out.set(key, hash);
      }
      return out;
    }),
    upsertChunks: vi.fn(async (docs: Array<{ id: string; metadata: { contentHash?: string } }>) => {
      for (const doc of docs) {
        chunkIds.add(doc.id);
        chunkHashes.set(doc.id, doc.metadata.contentHash ?? "");
      }
    }),
    deleteByIds: vi.fn(async (ids: string[]) => {
      for (const id of ids) {
        chunkIds.delete(id);
        chunkHashes.delete(id);
      }
    }),
    listPages: vi.fn(async (): Promise<PageRecord[]> => [])
  } as unknown as UpstashSearchStore;

  return { store, pageHashes, chunkIds };
}

async function createCrawlFixture(): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-sitemap-"));
  tempDirs.push(cwd);

  const config = createDefaultConfig("searchsocket-sitemap");
  config.source.mode = "crawl";
  config.source.crawl = {
    baseUrl: "https://example.com",
    routes: [],
    sitemapUrl: "/sitemap.xml"
  };
  // robots.txt is fetched over the network in crawl mode; it is not what these
  // cases are about, and leaving it on would add an unrelated request.
  config.respectRobotsTxt = false;
  config.state.dir = ".searchsocket";
  return { cwd, config };
}

function mockResponse(body: string, init: { status?: number; contentType?: string } = {}): Response {
  const buffer = Buffer.from(body, "utf8");
  const headers = new Headers();
  headers.set("content-type", init.contentType ?? "text/html; charset=utf-8");
  headers.set("content-length", String(buffer.byteLength));
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers,
    text: async () => body,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  } as unknown as Response;
}

function pageHtml(route: string): string {
  return (
    `<html><head><title>${route}</title></head><body><main>` +
    `<h1>${route}</h1><p>Body copy for ${route} with enough words to chunk.</p>` +
    `</main></body></html>`
  );
}

/** One leaf sitemap listing every page — two sitemaps total, well under the cap. */
function mockFlatSitemap(routes: string[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);

    if (url === "https://example.com/sitemap.xml") {
      const entries = routes.map((route) => `<url><loc>https://example.com${route}</loc></url>`).join("");
      return mockResponse(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`);
    }

    return mockResponse(pageHtml(new URL(url).pathname));
  });
}

/**
 * A root sitemap index with one child sitemap per route. MAX_SITEMAPS counts
 * the root, so 49 children sit exactly on the cap and 60 overrun it.
 */
function mockWideSitemapIndex(routes: string[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);

    if (url === "https://example.com/sitemap.xml") {
      const children = routes.map((_r, i) => `<sitemap><loc>/child-${i}.xml</loc></sitemap>`).join("");
      return mockResponse(
        `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children}</sitemapindex>`
      );
    }

    const child = /^https:\/\/example\.com\/child-(\d+)\.xml$/.exec(url);
    if (child) {
      const route = routes[Number(child[1])];
      return mockResponse(
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
          `<url><loc>https://example.com${route}</loc></url></urlset>`
      );
    }

    return mockResponse(pageHtml(new URL(url).pathname));
  });
}

const SIXTY_ROUTES = Array.from({ length: 60 }, (_v, i) => `/p-${String(i).padStart(2, "0")}`);

describe("sitemap truncation never deletes", () => {
  it("deletes nothing when a capped index hides pages the index already holds", async () => {
    const { cwd, config } = await createCrawlFixture();
    const { store } = createStatefulMockStore();

    // Run 1: all 60 pages arrive through a single leaf sitemap.
    mockFlatSitemap(SIXTY_ROUTES);
    const first = await IndexPipeline.create({ cwd, config, store });
    const firstStats = await first.run({ changedOnly: true });
    expect(firstStats.pagesProcessed).toBe(60);
    expect(firstStats.deletionEligible).toBe(true);

    vi.restoreAllMocks();
    vi.mocked(store.deletePagesByIds).mockClear();
    vi.mocked(store.deleteByIds).mockClear();

    // Run 2: the same 60 pages, now behind 60 child sitemaps. The cap stops the
    // traversal at 49, so 11 pages are unseen — 18%, under the 50% ratio guard.
    mockWideSitemapIndex(SIXTY_ROUTES);
    const second = await IndexPipeline.create({ cwd, config, store });
    const stats = await second.run({ changedOnly: true });

    expect(stats.pagesProcessed).toBe(49);
    expect(stats.deletionEligible).toBe(false);
    expect(stats.pagesDeleted).toBe(0);
    expect(stats.deletes).toBe(0);
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(store.deleteByIds).not.toHaveBeenCalled();
    expect(stats.warnings.some((w) => w.kind === "source-limited" && w.detail.includes("max-sitemaps"))).toBe(true);
  });

  it("retains all 50 pages when the traversal sits exactly on the cap", async () => {
    const { cwd, config } = await createCrawlFixture();
    const { store } = createStatefulMockStore();
    const routes = Array.from({ length: 50 }, (_v, i) => `/q-${String(i).padStart(2, "0")}`);

    mockFlatSitemap(routes);
    const first = await IndexPipeline.create({ cwd, config, store });
    expect((await first.run({ changedOnly: true })).pagesProcessed).toBe(50);

    vi.restoreAllMocks();
    vi.mocked(store.deletePagesByIds).mockClear();
    vi.mocked(store.deleteByIds).mockClear();

    // 49 children plus the root is exactly MAX_SITEMAPS, so nothing is skipped;
    // the fiftieth page rides along in the last child sitemap.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);

      if (url === "https://example.com/sitemap.xml") {
        const children = Array.from({ length: 49 }, (_v, i) => `<sitemap><loc>/child-${i}.xml</loc></sitemap>`).join("");
        return mockResponse(
          `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children}</sitemapindex>`
        );
      }

      const child = /^https:\/\/example\.com\/child-(\d+)\.xml$/.exec(url);
      if (child) {
        const index = Number(child[1]);
        const owned = index === 48 ? [routes[48], routes[49]] : [routes[index]];
        const entries = owned.map((route) => `<url><loc>https://example.com${route}</loc></url>`).join("");
        return mockResponse(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`);
      }

      return mockResponse(pageHtml(new URL(url).pathname));
    });

    const second = await IndexPipeline.create({ cwd, config, store });
    const stats = await second.run({ changedOnly: true });

    expect(stats.pagesProcessed).toBe(50);
    expect(stats.deletionEligible).toBe(true);
    expect(stats.pagesDeleted).toBe(0);
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
  });

  it("still deletes a genuinely removed page on a complete crawl", async () => {
    const { cwd, config } = await createCrawlFixture();
    const { store } = createStatefulMockStore();

    mockFlatSitemap(SIXTY_ROUTES);
    const first = await IndexPipeline.create({ cwd, config, store });
    await first.run({ changedOnly: true });

    vi.restoreAllMocks();
    vi.mocked(store.deletePagesByIds).mockClear();

    mockFlatSitemap(SIXTY_ROUTES.slice(0, 59));
    const second = await IndexPipeline.create({ cwd, config, store });
    const stats = await second.run({ changedOnly: true });

    expect(stats.deletionEligible).toBe(true);
    expect(stats.pagesDeleted).toBe(1);
    expect(store.deletePagesByIds).toHaveBeenCalled();
  });

  it("deletes nothing when a nested index overruns the cap", async () => {
    const { cwd, config } = await createCrawlFixture();
    const { store } = createStatefulMockStore();

    mockFlatSitemap(SIXTY_ROUTES);
    const first = await IndexPipeline.create({ cwd, config, store });
    await first.run({ changedOnly: true });

    vi.restoreAllMocks();
    vi.mocked(store.deletePagesByIds).mockClear();
    vi.mocked(store.deleteByIds).mockClear();

    // root -> 2 group indexes -> 30 leaves each = 63 sitemaps.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);

      if (url === "https://example.com/sitemap.xml") {
        return mockResponse(`
          <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <sitemap><loc>/group-0.xml</loc></sitemap>
            <sitemap><loc>/group-1.xml</loc></sitemap>
          </sitemapindex>
        `);
      }

      const group = /^https:\/\/example\.com\/group-(\d)\.xml$/.exec(url);
      if (group) {
        const base = Number(group[1]) * 30;
        const leaves = Array.from({ length: 30 }, (_v, i) => `<sitemap><loc>/leaf-${base + i}.xml</loc></sitemap>`).join("");
        return mockResponse(
          `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${leaves}</sitemapindex>`
        );
      }

      const leaf = /^https:\/\/example\.com\/leaf-(\d+)\.xml$/.exec(url);
      if (leaf) {
        return mockResponse(
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
            `<url><loc>https://example.com${SIXTY_ROUTES[Number(leaf[1])]}</loc></url></urlset>`
        );
      }

      return mockResponse(pageHtml(new URL(url).pathname));
    });

    const second = await IndexPipeline.create({ cwd, config, store });
    const stats = await second.run({ changedOnly: true });

    expect(stats.pagesProcessed).toBeLessThan(60);
    expect(stats.deletionEligible).toBe(false);
    expect(stats.pagesDeleted).toBe(0);
    expect(stats.deletes).toBe(0);
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(store.deleteByIds).not.toHaveBeenCalled();
  });
});
