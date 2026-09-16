import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import type { UpstashSearchStore } from "../src/vector/upstash";
import type { PageRecord, ResolvedSearchSocketConfig } from "../src/types";

/**
 * Release-blocking invariant: a robots.txt the run could not read must not let
 * a previously excluded page reach the index.
 *
 * Marking the run non-authoritative stops deletions and artifact publication,
 * but the exposure here comes from a *write* — the sitemap still lists the
 * page, so without a ruleset to filter against it would be upserted and served.
 * The sitemap-truncation suite deliberately disables robots handling, so this
 * combination needs its own coverage.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function createMockStore() {
  const pageHashes = new Map<string, { contentHash: string; custom: boolean }>();
  const chunkIds = new Set<string>();

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
    deletePagesByIds: vi.fn(async () => {}),
    deletePages: vi.fn(async () => {}),
    scanChunkIds: vi.fn(async () => new Map([...chunkIds].map((k) => [k, false]))),
    fetchContentHashesForKeys: vi.fn(async () => new Map<string, string>()),
    upsertChunks: vi.fn(async (docs: Array<{ id: string }>) => {
      for (const doc of docs) chunkIds.add(doc.id);
    }),
    deleteByIds: vi.fn(async () => {}),
    listPages: vi.fn(async (): Promise<PageRecord[]> => [])
  } as unknown as UpstashSearchStore;

  return store;
}

async function createCrawlFixture(): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-robots-"));
  tempDirs.push(cwd);

  const config = createDefaultConfig("searchsocket-robots");
  config.source.mode = "crawl";
  config.source.crawl = { baseUrl: "https://example.com", routes: [], sitemapUrl: "/sitemap.xml" };
  config.respectRobotsTxt = true;
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

/** Sitemap lists both a public and a private route; robots answers `robotsStatus`. */
function mockCrawl(robotsStatus: number, robotsBody = "User-agent: *\nDisallow: /private") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);

    if (url === "https://example.com/robots.txt") {
      return mockResponse(robotsStatus === 200 ? robotsBody : "", {
        status: robotsStatus,
        contentType: "text/plain"
      });
    }

    if (url === "https://example.com/sitemap.xml") {
      return mockResponse(
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
          `<url><loc>https://example.com/public</loc></url>` +
          `<url><loc>https://example.com/private</loc></url></urlset>`,
        { contentType: "application/xml" }
      );
    }

    return mockResponse(pageHtml(new URL(url).pathname));
  });
}

describe("robots.txt availability and index mutation", () => {
  it("writes nothing when robots.txt is unreadable, so an excluded page cannot leak", async () => {
    const { cwd, config } = await createCrawlFixture();
    const store = createMockStore();
    mockCrawl(503);

    const pipeline = await IndexPipeline.create({ cwd, config, store });
    const stats = await pipeline.run({ changedOnly: true });

    // The whole point: /private is in the sitemap and nothing told us it is
    // excluded, so the run must not publish it — or anything else.
    expect(store.upsertPages).not.toHaveBeenCalled();
    expect(store.upsertChunks).not.toHaveBeenCalled();
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(store.deleteByIds).not.toHaveBeenCalled();
    expect(stats.deletionEligible).toBe(false);
    expect(stats.warnings.some((w) => w.detail.includes("robots.txt unreadable"))).toBe(true);
    // A refused run resolves normally, so the refusal has to be on the stats.
    expect(stats.writesRefused?.reason).toBe("robots-unavailable");
  });

  it("treats a 404 as no rules published and indexes normally", async () => {
    const { cwd, config } = await createCrawlFixture();
    const store = createMockStore();
    mockCrawl(404);

    const pipeline = await IndexPipeline.create({ cwd, config, store });
    const stats = await pipeline.run({ changedOnly: true });

    // A site that publishes no robots.txt has not withheld anything.
    expect(store.upsertPages).toHaveBeenCalled();
    expect(stats.pagesProcessed).toBe(2);
    expect(stats.warnings.some((w) => w.detail.includes("robots.txt unreadable"))).toBe(false);
  });

  it("indexes only the permitted page when robots.txt is readable", async () => {
    const { cwd, config } = await createCrawlFixture();
    const store = createMockStore();
    mockCrawl(200);

    const pipeline = await IndexPipeline.create({ cwd, config, store });
    const stats = await pipeline.run({ changedOnly: true });

    expect(stats.pagesProcessed).toBe(1);
    expect(store.upsertPages).toHaveBeenCalled();
    const upserted = (store.upsertPages as unknown as { mock: { calls: Array<[Array<{ metadata: { url: string } }>]> } })
      .mock.calls.flatMap(([docs]) => docs.map((d) => d.metadata.url));
    expect(upserted).toContain("/public");
    expect(upserted).not.toContain("/private");
  });
});
