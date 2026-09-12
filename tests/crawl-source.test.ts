import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { createDefaultConfig } from "../src/config/defaults";
import { loadCrawledPages } from "../src/indexing/sources/crawl";


/**
 * A mock Response with the fields `safeFetch` reads: status, headers, and a
 * real body. The crawler now enforces timeouts, size caps, content types, and
 * a same-origin redirect policy, so a `{ ok, text }` stub is no longer enough.
 */
function mockResponse(
  body: string | Buffer,
  init: { status?: number; contentType?: string; location?: string } = {}
): Response {
  const buffer = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const headers = new Headers();
  headers.set("content-type", init.contentType ?? "text/html; charset=utf-8");
  headers.set("content-length", String(buffer.byteLength));
  if (init.location) headers.set("location", init.location);

  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers,
    text: async () => buffer.toString("utf8"),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  } as unknown as Response;
}

describe("loadCrawledPages", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches explicit routes and returns normalized page urls", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: ["/docs", "/docs/getting-started"],
      sitemapUrl: undefined
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      return mockResponse(`<html><body><main><h1>${url}</h1></main></body></html>`);
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url)).toEqual(["/docs", "/docs/getting-started"]);
  });

  it("normalizes and deduplicates explicit routes before crawling", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: ["/docs", "/docs/", "docs", "/docs//", "/blog/"],
      sitemapUrl: undefined
    };

    const seen = new Set<string>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      seen.add(String(input));
      return mockResponse(`<html><body><main><h1>${String(input)}</h1></main></body></html>`);
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url).sort()).toEqual(["/blog", "/docs"]);
    expect(seen).toEqual(new Set(["https://example.com/docs", "https://example.com/blog"]));
  });

  it("parses relative sitemap <loc> entries against baseUrl", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: [],
      sitemapUrl: "/sitemap.xml"
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);

      if (url === "https://example.com/sitemap.xml") {
        return mockResponse(`
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>/docs</loc></url>
              <url><loc>/blog/intro</loc></url>
            </urlset>
          `);
      }

      return mockResponse(`<html><body><main><h1>${url}</h1></main></body></html>`);
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url).sort()).toEqual(["/blog/intro", "/docs"]);
  });

  it("resolves sitemap indexes, deduplicates routes, and skips failed page fetches", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: [],
      sitemapUrl: "/sitemap-index.xml"
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);

      if (url === "https://example.com/sitemap-index.xml") {
        return mockResponse(`
            <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <sitemap><loc>/sitemap-a.xml</loc></sitemap>
              <sitemap><loc>https://example.com/sitemap-b.xml</loc></sitemap>
            </sitemapindex>
          `);
      }

      if (url === "https://example.com/sitemap-a.xml") {
        return mockResponse(`
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>https://example.com/docs</loc></url>
              <url><loc>https://example.com/shared</loc></url>
            </urlset>
          `);
      }

      if (url === "https://example.com/sitemap-b.xml") {
        return mockResponse(`
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>https://example.com/shared</loc></url>
              <url><loc>https://example.com/fails</loc></url>
            </urlset>
          `);
      }

      if (url.endsWith("/fails")) {
        return {
          ok: false,
          status: 500,
          statusText: "Server Error"
        } as Response;
      }

      return mockResponse(`<html><body><main><h1>${url}</h1></main></body></html>`);
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url).sort()).toEqual(["/docs", "/shared"]);
  });

  it("supports gzipped sitemap files", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: [],
      sitemapUrl: "/sitemap.xml.gz"
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);

      if (url === "https://example.com/sitemap.xml.gz") {
        const xml = `
          <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <url><loc>https://example.com/docs</loc></url>
          </urlset>
        `;
        const gz = gzipSync(Buffer.from(xml, "utf8"));
        return mockResponse(gz, { contentType: "application/gzip" });
      }

      return mockResponse(`<html><body><main><h1>${url}</h1></main></body></html>`);
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url)).toEqual(["/docs"]);
  });

  it("treats negative maxPages as zero", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: ["/docs", "/blog"],
      sitemapUrl: undefined
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      return mockResponse(`<html><body><main><h1>${String(input)}</h1></main></body></html>`);
    });

    const pages = (await loadCrawledPages(config, -10)).records;
    expect(pages).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("handles cyclic sitemap indexes without infinite recursion", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: [],
      sitemapUrl: "/sitemap.xml"
    };

    let sitemapFetches = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);

      if (url === "https://example.com/sitemap.xml") {
        sitemapFetches += 1;
        if (sitemapFetches > 3) {
          throw new Error("cyclic sitemap recursion was not stopped");
        }

        return mockResponse(`
            <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <sitemap><loc>/sitemap.xml</loc></sitemap>
              <sitemap><loc>/leaf.xml</loc></sitemap>
            </sitemapindex>
          `);
      }

      if (url === "https://example.com/leaf.xml") {
        return mockResponse(`
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>https://example.com/docs</loc></url>
            </urlset>
          `);
      }

      return mockResponse("<html><body><main><h1>docs</h1></main></body></html>");
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url)).toEqual(["/docs"]);
    expect(sitemapFetches).toBe(1);
  });

  it("fetches duplicate child sitemaps only once", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: [],
      sitemapUrl: "/index.xml"
    };

    let childFetches = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);

      if (url === "https://example.com/index.xml") {
        return mockResponse(`
            <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <sitemap><loc>/child.xml</loc></sitemap>
              <sitemap><loc>https://example.com/child.xml</loc></sitemap>
            </sitemapindex>
          `);
      }

      if (url === "https://example.com/child.xml") {
        childFetches += 1;
        return mockResponse(`
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>https://example.com/docs</loc></url>
            </urlset>
          `);
      }

      return mockResponse("<html><body><main>Docs</main></body></html>");
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url)).toEqual(["/docs"]);
    expect(childFetches).toBe(1);
  });

  it("falls back to crawling root when no routes or sitemap are configured", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: [],
      sitemapUrl: undefined
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://example.com/");
      return mockResponse("<html><body><main><h1>Home</h1></main></body></html>");
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url)).toEqual(["/"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("floors maxPages to an integer before route selection", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: ["/a", "/b", "/c"],
      sitemapUrl: undefined
    };

    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      seen.push(String(input));
      return mockResponse("<html><body><main><h1>ok</h1></main></body></html>");
    });

    const pages = (await loadCrawledPages(config, 1.9)).records;
    expect(pages.map((page) => page.url)).toEqual(["/a"]);
    expect(seen).toEqual(["https://example.com/a"]);
  });

  /**
   * The sitemap cap is a data-loss path: it used to stop the traversal and
   * return an empty list, so a capped run looked like a complete small site
   * and the pipeline deleted everything it never saw.
   */
  describe("sitemap cap", () => {
    /**
     * A root sitemap index listing `childCount` children, one page each.
     * MAX_SITEMAPS counts the root, so `childCount` 49 sits exactly on the cap.
     */
    function mockWideIndex(childCount: number) {
      return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
        const url = String(input);

        if (url === "https://example.com/sitemap.xml") {
          const children = Array.from(
            { length: childCount },
            (_v, i) => `<sitemap><loc>/child-${i}.xml</loc></sitemap>`
          ).join("");
          return mockResponse(
            `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children}</sitemapindex>`
          );
        }

        const child = /^https:\/\/example\.com\/child-(\d+)\.xml$/.exec(url);
        if (child) {
          return mockResponse(
            `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
              `<url><loc>https://example.com/p-${child[1]}</loc></url></urlset>`
          );
        }

        return mockResponse("<html><body><main>page</main></body></html>");
      });
    }

    function sitemapConfig() {
      const config = createDefaultConfig("crawl-test");
      config.source.mode = "crawl";
      config.source.crawl = {
        baseUrl: "https://example.com",
        routes: [],
        sitemapUrl: "/sitemap.xml"
      };
      return config;
    }

    it("stays complete when the traversal sits exactly on the cap", async () => {
      mockWideIndex(49);

      const result = await loadCrawledPages(sitemapConfig());

      expect(result.records).toHaveLength(49);
      expect(result.complete).toBe(true);
      expect(result.limitedBy).toBeUndefined();
      expect(result.failures).toEqual([]);
    });

    it("stays complete below the cap", async () => {
      mockWideIndex(10);

      const result = await loadCrawledPages(sitemapConfig());

      expect(result.records).toHaveLength(10);
      expect(result.complete).toBe(true);
    });

    it("reports a wide index truncated by the cap as incomplete", async () => {
      mockWideIndex(60);

      const result = await loadCrawledPages(sitemapConfig());

      // The root consumes a slot, so only 49 of the 60 children are read.
      expect(result.records).toHaveLength(49);
      expect(result.complete).toBe(false);
      expect(result.limitedBy).toBe("max-sitemaps");
    });

    it("reports a nested index truncated by the cap as incomplete", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
        const url = String(input);

        if (url === "https://example.com/sitemap.xml") {
          return mockResponse(`
            <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <sitemap><loc>/group-a.xml</loc></sitemap>
              <sitemap><loc>/group-b.xml</loc></sitemap>
            </sitemapindex>
          `);
        }

        const group = /^https:\/\/example\.com\/group-([ab])\.xml$/.exec(url);
        if (group) {
          const leaves = Array.from(
            { length: 30 },
            (_v, i) => `<sitemap><loc>/${group[1]}-${i}.xml</loc></sitemap>`
          ).join("");
          return mockResponse(
            `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${leaves}</sitemapindex>`
          );
        }

        const leaf = /^https:\/\/example\.com\/([ab])-(\d+)\.xml$/.exec(url);
        if (leaf) {
          return mockResponse(
            `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
              `<url><loc>https://example.com/${leaf[1]}-${leaf[2]}</loc></url></urlset>`
          );
        }

        return mockResponse("<html><body><main>page</main></body></html>");
      });

      const result = await loadCrawledPages(sitemapConfig());

      expect(result.complete).toBe(false);
      expect(result.limitedBy).toBe("max-sitemaps");
    });

    it("keeps a nested index below the cap complete", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
        const url = String(input);

        if (url === "https://example.com/sitemap.xml") {
          return mockResponse(`
            <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <sitemap><loc>/group.xml</loc></sitemap>
            </sitemapindex>
          `);
        }

        if (url === "https://example.com/group.xml") {
          const leaves = Array.from({ length: 5 }, (_v, i) => `<sitemap><loc>/leaf-${i}.xml</loc></sitemap>`).join("");
          return mockResponse(
            `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${leaves}</sitemapindex>`
          );
        }

        const leaf = /^https:\/\/example\.com\/leaf-(\d+)\.xml$/.exec(url);
        if (leaf) {
          return mockResponse(
            `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
              `<url><loc>https://example.com/n-${leaf[1]}</loc></url></urlset>`
          );
        }

        return mockResponse("<html><body><main>page</main></body></html>");
      });

      const result = await loadCrawledPages(sitemapConfig());

      expect(result.records).toHaveLength(5);
      expect(result.complete).toBe(true);
      expect(result.limitedBy).toBeUndefined();
    });

    it("prefers the discovery cap over --max-pages when both truncated the run", async () => {
      mockWideIndex(60);

      const result = await loadCrawledPages(sitemapConfig(), 5);

      expect(result.records).toHaveLength(5);
      expect(result.limitedBy).toBe("max-sitemaps");
    });
  });

  it("records an unreadable child sitemap as a failure instead of shrinking silently", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: [],
      sitemapUrl: "/sitemap.xml"
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);

      if (url === "https://example.com/sitemap.xml") {
        return mockResponse(`
            <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <sitemap><loc>/good.xml</loc></sitemap>
              <sitemap><loc>/broken.xml</loc></sitemap>
            </sitemapindex>
          `);
      }

      if (url === "https://example.com/good.xml") {
        return mockResponse(`
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>https://example.com/docs</loc></url>
            </urlset>
          `);
      }

      if (url === "https://example.com/broken.xml") {
        return mockResponse("nope", { status: 500 });
      }

      return mockResponse("<html><body><main>docs</main></body></html>");
    });

    const result = await loadCrawledPages(config);

    expect(result.records.map((page) => page.url)).toEqual(["/docs"]);
    expect(result.complete).toBe(false);
    expect(result.failures.map((failure) => failure.target)).toEqual(["https://example.com/broken.xml"]);
  });

  it("ignores non-http(s) sitemap loc entries", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: [],
      sitemapUrl: "/sitemap.xml"
    };

    const requested: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);

      if (url === "https://example.com/sitemap.xml") {
        return mockResponse(`
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>https://example.com/docs</loc></url>
              <url><loc>ftp://example.com/private</loc></url>
              <url><loc>mailto:admin@example.com</loc></url>
            </urlset>
          `);
      }

      return mockResponse("<html><body><main>ok</main></body></html>");
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url)).toEqual(["/docs"]);
    expect(requested).toEqual(["https://example.com/sitemap.xml", "https://example.com/docs"]);
  });
});
