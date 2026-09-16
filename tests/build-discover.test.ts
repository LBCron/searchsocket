import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isExcluded } from "../src/indexing/sources/build/manifest-parser";
import { extractLinksFromHtml } from "../src/indexing/sources/build/index";
import { mergeConfig } from "../src/config/load";
import { createDefaultConfig } from "../src/config/defaults";
import type { PreviewServer } from "../src/indexing/sources/build/preview-server";

// ---------------------------------------------------------------------------
// Mock startPreviewServer so integration tests don't require vite
// ---------------------------------------------------------------------------

let mockPreviewServer: PreviewServer | null = null;

vi.mock("../src/indexing/sources/build/preview-server", () => ({
  startPreviewServer: async () => {
    if (!mockPreviewServer) {
      throw new Error("mockPreviewServer not set");
    }
    return mockPreviewServer;
  }
}));

// ---------------------------------------------------------------------------
// Test HTTP server helpers
// ---------------------------------------------------------------------------

const servers: http.Server[] = [];

function createTestServer(
  pages: Record<string, string>,
  options?: { contentTypeOverrides?: Record<string, string> }
): Promise<{ port: number; baseUrl: string; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      const html = pages[url];
      if (html) {
        const contentType = options?.contentTypeOverrides?.[url] ?? "text/html; charset=utf-8";
        res.writeHead(200, { "Content-Type": contentType });
        res.end(html);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      servers.push(server);
      resolve({ port, baseUrl: `http://127.0.0.1:${port}`, server });
    });
  });
}

function htmlPage(title: string, links: string[] = [], extra?: string): string {
  const linkTags = links.map((href) => `<a href="${href}">${href}</a>`).join("\n");
  return `<html><head><title>${title}</title></head><body><main><h1>${title}</h1>\n${linkTags}${extra ?? ""}</main></body></html>`;
}

afterEach(async () => {
  mockPreviewServer = null;
  await Promise.all(
    servers.splice(0).map(
      (s) => new Promise<void>((resolve) => s.close(() => resolve()))
    )
  );
});

// ---------------------------------------------------------------------------
// isExcluded
// ---------------------------------------------------------------------------

describe("isExcluded", () => {
  it("matches exact paths", () => {
    expect(isExcluded("/admin", ["/admin"])).toBe(true);
    expect(isExcluded("/admin", ["/other"])).toBe(false);
  });

  it("exact pattern does not match subpaths", () => {
    expect(isExcluded("/admin/users", ["/admin"])).toBe(false);
  });

  it("single-level wildcard matches direct children only", () => {
    expect(isExcluded("/api/users", ["/api/*"])).toBe(true);
    expect(isExcluded("/api/users/1", ["/api/*"])).toBe(false);
    expect(isExcluded("/api", ["/api/*"])).toBe(false);
    expect(isExcluded("/apiary", ["/api/*"])).toBe(false);
  });

  it("globstar matches any depth and the parent", () => {
    expect(isExcluded("/api/users", ["/api/**"])).toBe(true);
    expect(isExcluded("/api/users/1", ["/api/**"])).toBe(true);
    expect(isExcluded("/api", ["/api/**"])).toBe(true);
    expect(isExcluded("/apiary", ["/api/**"])).toBe(false);
  });

  it("returns false for empty patterns", () => {
    expect(isExcluded("/anything", [])).toBe(false);
  });

  it("matches multiple patterns", () => {
    expect(isExcluded("/admin", ["/api/**", "/admin"])).toBe(true);
    expect(isExcluded("/api/v2", ["/api/**", "/admin"])).toBe(true);
    expect(isExcluded("/docs", ["/api/**", "/admin"])).toBe(false);
  });

  it("does not match partial path segments for wildcard", () => {
    expect(isExcluded("/apiary", ["/api/*"])).toBe(false);
    expect(isExcluded("/api-docs", ["/api/*"])).toBe(false);
  });

  it("globstar handles nested paths", () => {
    expect(isExcluded("/admin/users/edit", ["/admin/**"])).toBe(true);
    expect(isExcluded("/admin/settings", ["/admin/**"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractLinksFromHtml
// ---------------------------------------------------------------------------

describe("extractLinksFromHtml", () => {
  const origin = "http://127.0.0.1:3000";

  it("extracts simple absolute path links", () => {
    const html = `<html><body><a href="/docs">Docs</a><a href="/blog">Blog</a></body></html>`;
    const links = extractLinksFromHtml(html, "/", origin);
    expect(links.sort()).toEqual(["/blog", "/docs"]);
  });

  it("extracts relative links resolved against page URL", () => {
    const html = `<html><body><a href="guide">Guide</a><a href="intro">Intro</a></body></html>`;
    const links = extractLinksFromHtml(html, "/docs/", origin);
    expect(links.sort()).toEqual(["/docs/guide", "/docs/intro"]);
  });

  it("ignores fragment-only links", () => {
    const html = `<html><body><a href="#section">Section</a><a href="/docs">Docs</a></body></html>`;
    const links = extractLinksFromHtml(html, "/", origin);
    expect(links).toEqual(["/docs"]);
  });

  it("ignores mailto links", () => {
    const html = `<html><body><a href="mailto:admin@example.com">Email</a><a href="/about">About</a></body></html>`;
    const links = extractLinksFromHtml(html, "/", origin);
    expect(links).toEqual(["/about"]);
  });

  it("ignores tel links", () => {
    const html = `<html><body><a href="tel:+1234567890">Call</a><a href="/contact">Contact</a></body></html>`;
    const links = extractLinksFromHtml(html, "/", origin);
    expect(links).toEqual(["/contact"]);
  });

  it("ignores javascript: links", () => {
    const html = `<html><body><a href="javascript:void(0)">Click</a><a href="/home">Home</a></body></html>`;
    const links = extractLinksFromHtml(html, "/", origin);
    expect(links).toEqual(["/home"]);
  });

  it("filters out external links (different origin)", () => {
    const html = `<html><body>
      <a href="https://external.com/page">External</a>
      <a href="/internal">Internal</a>
      <a href="http://other.com">Other</a>
    </body></html>`;
    const links = extractLinksFromHtml(html, "/", origin);
    expect(links).toEqual(["/internal"]);
  });

  it("deduplicates links", () => {
    const html = `<html><body>
      <a href="/docs">Docs 1</a>
      <a href="/docs">Docs 2</a>
      <a href="/docs">Docs 3</a>
    </body></html>`;
    const links = extractLinksFromHtml(html, "/", origin);
    expect(links).toEqual(["/docs"]);
  });

  it("handles elements without href", () => {
    const html = `<html><body><a>No href</a><a href="/real">Real</a></body></html>`;
    const links = extractLinksFromHtml(html, "/", origin);
    expect(links).toEqual(["/real"]);
  });

  it("normalizes trailing slashes", () => {
    const html = `<html><body><a href="/docs/">Docs</a></body></html>`;
    const links = extractLinksFromHtml(html, "/", origin);
    expect(links).toEqual(["/docs"]);
  });

  it("handles full same-origin URLs", () => {
    const html = `<html><body><a href="http://127.0.0.1:3000/about">About</a></body></html>`;
    const links = extractLinksFromHtml(html, "/", origin);
    expect(links).toEqual(["/about"]);
  });

  it("strips query parameters from extracted links", () => {
    const html = `<html><body><a href="/search?q=test">Search</a></body></html>`;
    const links = extractLinksFromHtml(html, "/", origin);
    expect(links).toEqual(["/search"]);
  });

  it("returns empty array for page with no links", () => {
    const html = `<html><body><h1>No links here</h1></body></html>`;
    const links = extractLinksFromHtml(html, "/", origin);
    expect(links).toEqual([]);
  });

  it("handles deeply nested links in HTML structure", () => {
    const html = `<html><body>
      <nav><ul><li><a href="/nav-link">Nav</a></li></ul></nav>
      <main>
        <div><p>Text <a href="/content-link">link</a></p></div>
      </main>
      <footer><a href="/footer-link">Footer</a></footer>
    </body></html>`;
    const links = extractLinksFromHtml(html, "/", origin);
    expect(links.sort()).toEqual(["/content-link", "/footer-link", "/nav-link"]);
  });

  it("resolves parent-relative paths", () => {
    const html = `<html><body><a href="../blog">Blog</a></body></html>`;
    const links = extractLinksFromHtml(html, "/docs/guide", origin);
    expect(links).toEqual(["/blog"]);
  });

  it("returns empty array for empty HTML", () => {
    const links = extractLinksFromHtml("", "/", origin);
    expect(links).toEqual([]);
  });

  it("handles links in nav, header, and aside elements", () => {
    const html = `<html><body>
      <header><a href="/header-link">Header</a></header>
      <aside><a href="/sidebar-link">Sidebar</a></aside>
      <main><a href="/main-link">Main</a></main>
    </body></html>`;
    const links = extractLinksFromHtml(html, "/", origin);
    expect(links.sort()).toEqual(["/header-link", "/main-link", "/sidebar-link"]);
  });
});

// ---------------------------------------------------------------------------
// discoverPages via loadBuildPages (integration)
// ---------------------------------------------------------------------------

describe("build discover mode (integration)", () => {
  async function runDiscoverFull(
    pages: Record<string, string>,
    buildConfig?: Partial<NonNullable<ReturnType<typeof createDefaultConfig>["source"]["build"]>>,
    maxPages?: number,
    contentTypeOverrides?: Record<string, string>
  ) {
    const { baseUrl, server } = await createTestServer(pages, { contentTypeOverrides });
    const port = (server.address() as { port: number }).port;

    // Set the mock preview server
    mockPreviewServer = {
      baseUrl,
      port,
      shutdown: async () => {}
    };

    const { loadBuildPages } = await import("../src/indexing/sources/build/index");

    const config = createDefaultConfig("discover-test");
    config.source.mode = "build";
    config.source.build = {
      outputDir: ".svelte-kit/output",
      paramValues: {},
      exclude: [],
      previewTimeout: 5000,
      discover: true,
      seedUrls: ["/"],
      maxPages: 200,
      maxDepth: 10,
      ...buildConfig
    };

    return loadBuildPages("/tmp", config, maxPages);
  }

  /** Records only — most assertions here are about which pages were found. */
  async function runDiscover(
    ...args: Parameters<typeof runDiscoverFull>
  ): Promise<Awaited<ReturnType<typeof runDiscoverFull>>["records"]> {
    return (await runDiscoverFull(...args)).records;
  }

  it("discovers pages by following links from seed URL", async () => {
    const result = await runDiscover({
      "/": htmlPage("Home", ["/docs", "/blog"]),
      "/docs": htmlPage("Docs", ["/docs/guide"]),
      "/blog": htmlPage("Blog"),
      "/docs/guide": htmlPage("Guide")
    });

    const urls = result.map((p) => p.url).sort();
    expect(urls).toEqual(["/", "/blog", "/docs", "/docs/guide"]);
  });

  it("returns HTML content for each discovered page", async () => {
    const result = await runDiscover({
      "/": htmlPage("Home", ["/about"]),
      "/about": htmlPage("About Us")
    });

    const homePage = result.find((p) => p.url === "/");
    expect(homePage?.html).toContain("Home");

    const aboutPage = result.find((p) => p.url === "/about");
    expect(aboutPage?.html).toContain("About Us");
  });

  it("skips 404 pages without failing", async () => {
    const result = await runDiscover({
      "/": htmlPage("Home", ["/missing", "/also-missing"])
    });

    expect(result.map((p) => p.url)).toEqual(["/"]);
  });

  /**
   * The split matters beyond bookkeeping: a failure marks the run incomplete
   * and blocks stale-record deletion, while a skip leaves it authoritative.
   */
  describe("skip versus failure classification", () => {
    it("treats a successful non-HTML response as a skip, not a failure", async () => {
      const result = await runDiscoverFull(
        {
          "/": htmlPage("Home", ["/report.pdf"]),
          "/report.pdf": "%PDF-1.4 pretend document"
        },
        {},
        undefined,
        { "/report.pdf": "application/pdf" }
      );

      expect(result.records.map((p) => p.url)).toEqual(["/"]);
      expect(result.failures).toEqual([]);
      expect(result.complete).toBe(true);
    });

    it("records a non-2xx response as a failure that blocks deletion", async () => {
      const result = await runDiscoverFull({ "/": htmlPage("Home", ["/missing"]) });

      expect(result.records.map((p) => p.url)).toEqual(["/"]);
      expect(result.failures.map((f) => f.target)).toEqual(["/missing"]);
      expect(result.failures[0]?.reason).toContain("404");
      expect(result.complete).toBe(false);
    });

    it("indexes a page whose content type differs only in case", async () => {
      const result = await runDiscoverFull(
        { "/": htmlPage("Home", ["/docs"]), "/docs": htmlPage("Docs") },
        {},
        undefined,
        { "/docs": "TEXT/HTML; charset=utf-8" }
      );

      expect(result.records.map((p) => p.url).sort()).toEqual(["/", "/docs"]);
      expect(result.complete).toBe(true);
    });
  });

  it("respects maxPages limit from build config", async () => {
    const result = await runDiscover(
      {
        "/": htmlPage("Home", ["/a", "/b", "/c", "/d", "/e"]),
        "/a": htmlPage("A"),
        "/b": htmlPage("B"),
        "/c": htmlPage("C"),
        "/d": htmlPage("D"),
        "/e": htmlPage("E")
      },
      { maxPages: 3 }
    );

    expect(result.length).toBe(3);
  });

  it("uses pipeline maxPages when lower than config maxPages", async () => {
    const result = await runDiscover(
      {
        "/": htmlPage("Home", ["/a", "/b", "/c"]),
        "/a": htmlPage("A"),
        "/b": htmlPage("B"),
        "/c": htmlPage("C")
      },
      { maxPages: 100 },
      2
    );

    expect(result.length).toBe(2);
  });

  it("returns empty array when config maxPages is zero", async () => {
    const result = await runDiscover(
      { "/": htmlPage("Home", ["/docs"]), "/docs": htmlPage("Docs") },
      { maxPages: 0 }
    );

    expect(result).toEqual([]);
  });

  it("floors fractional pipeline maxPages", async () => {
    const result = await runDiscover(
      {
        "/": htmlPage("Home", ["/a", "/b"]),
        "/a": htmlPage("A"),
        "/b": htmlPage("B")
      },
      { maxPages: 100 },
      1.9
    );

    expect(result.length).toBe(1);
  });

  it("treats negative pipeline maxPages as zero", async () => {
    const result = await runDiscover(
      { "/": htmlPage("Home", ["/docs"]), "/docs": htmlPage("Docs") },
      { maxPages: 100 },
      -5
    );

    expect(result).toEqual([]);
  });

  it("respects maxDepth limit", async () => {
    // Chain: / -> /level1 -> /level2 -> /level3
    const result = await runDiscover(
      {
        "/": htmlPage("Home", ["/level1"]),
        "/level1": htmlPage("Level 1", ["/level2"]),
        "/level2": htmlPage("Level 2", ["/level3"]),
        "/level3": htmlPage("Level 3")
      },
      { maxDepth: 1 }
    );

    const urls = result.map((p) => p.url).sort();
    expect(urls).toEqual(["/", "/level1"]);
  });

  it("reports excluded links seen on a page at maxDepth", async () => {
    const result = await runDiscoverFull(
      {
        "/": htmlPage("Home", ["/level1"]),
        "/level1": htmlPage("Level 1", ["/private/old"]),
        "/private/old": htmlPage("Private")
      },
      { maxDepth: 1, exclude: ["/private/**"] }
    );

    expect(result.records.map((p) => p.url).sort()).toEqual(["/", "/level1"]);
    expect([...(result.excludedUrls ?? [])]).toEqual(["/private/old"]);
    expect(result.limitedBy).toBeUndefined();
  });

  it("maxDepth=0 only fetches seed URLs without following links", async () => {
    const result = await runDiscover(
      {
        "/": htmlPage("Home", ["/docs", "/blog"]),
        "/docs": htmlPage("Docs"),
        "/blog": htmlPage("Blog")
      },
      { maxDepth: 0 }
    );

    expect(result.map((p) => p.url)).toEqual(["/"]);
  });

  it("excludes URLs matching exclude patterns", async () => {
    const result = await runDiscover(
      {
        "/": htmlPage("Home", ["/docs", "/api/v1", "/api/v2", "/admin"]),
        "/docs": htmlPage("Docs"),
        "/api/v1": htmlPage("API v1"),
        "/api/v2": htmlPage("API v2"),
        "/admin": htmlPage("Admin")
      },
      { exclude: ["/api/*", "/admin"] }
    );

    const urls = result.map((p) => p.url).sort();
    expect(urls).toEqual(["/", "/docs"]);
  });

  it("excludes seed URLs that match exclude patterns", async () => {
    const result = await runDiscover(
      {
        "/": htmlPage("Home"),
        "/api/data": htmlPage("API")
      },
      { seedUrls: ["/", "/api/data"], exclude: ["/api/*"] }
    );

    expect(result.map((p) => p.url)).toEqual(["/"]);
  });

  it("supports multiple seed URLs", async () => {
    const result = await runDiscover(
      {
        "/docs": htmlPage("Docs", ["/docs/guide"]),
        "/blog": htmlPage("Blog"),
        "/docs/guide": htmlPage("Guide")
      },
      { seedUrls: ["/docs", "/blog"] }
    );

    const urls = result.map((p) => p.url).sort();
    expect(urls).toEqual(["/blog", "/docs", "/docs/guide"]);
  });

  it("deduplicates seed URLs", async () => {
    const result = await runDiscover(
      { "/docs": htmlPage("Docs") },
      { seedUrls: ["/docs", "/docs/", "/docs"] }
    );

    expect(result.length).toBe(1);
    expect(result[0]!.url).toBe("/docs");
  });

  it("handles cyclic link graphs without infinite loops", async () => {
    const result = await runDiscover({
      "/": htmlPage("Home", ["/a"]),
      "/a": htmlPage("A", ["/b"]),
      "/b": htmlPage("B", ["/"])
    });

    const urls = result.map((p) => p.url).sort();
    expect(urls).toEqual(["/", "/a", "/b"]);
  });

  it("handles self-referencing pages", async () => {
    const result = await runDiscover({
      "/": htmlPage("Home", ["/", "/docs"]),
      "/docs": htmlPage("Docs", ["/docs"])
    });

    const urls = result.map((p) => p.url).sort();
    expect(urls).toEqual(["/", "/docs"]);
  });

  it("filters external links during discovery", async () => {
    const html = `<html><body><main>
      <a href="/internal">Internal</a>
      <a href="https://external.com/page">External</a>
      <a href="http://other-domain.com">Other</a>
    </main></body></html>`;

    const result = await runDiscover({
      "/": html,
      "/internal": htmlPage("Internal")
    });

    const urls = result.map((p) => p.url).sort();
    expect(urls).toEqual(["/", "/internal"]);
  });

  it("skips non-HTML content types", async () => {
    const result = await runDiscover(
      {
        "/": htmlPage("Home", ["/data", "/page"]),
        "/data": '{"key": "value"}',
        "/page": htmlPage("Page")
      },
      {},
      undefined,
      { "/data": "application/json" }
    );

    const urls = result.map((p) => p.url).sort();
    expect(urls).toEqual(["/", "/page"]);
  });

  it("handles empty site with just a root page", async () => {
    const result = await runDiscover({
      "/": htmlPage("Home")
    });

    expect(result.length).toBe(1);
    expect(result[0]!.url).toBe("/");
  });

  it("handles wide pages with many links", async () => {
    const links = Array.from({ length: 20 }, (_, i) => `/page-${i}`);
    const pages: Record<string, string> = {
      "/": htmlPage("Home", links)
    };
    for (const link of links) {
      pages[link] = htmlPage(`Page ${link}`);
    }

    const result = await runDiscover(pages);
    expect(result.length).toBe(21); // root + 20 pages
  });

  it("sets sourcePath to the full fetch URL", async () => {
    const result = await runDiscover({
      "/": htmlPage("Home")
    });

    expect(result[0]!.sourcePath).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it("discovers deep chains up to maxDepth", async () => {
    const pages: Record<string, string> = {};
    for (let i = 0; i <= 5; i++) {
      const url = i === 0 ? "/" : `/d${i}`;
      const nextLink = i < 5 ? [`/d${i + 1}`] : [];
      pages[url] = htmlPage(`Depth ${i}`, nextLink);
    }

    const result = await runDiscover(pages, { maxDepth: 3 });
    const urls = result.map((p) => p.url).sort();
    expect(urls).toEqual(["/", "/d1", "/d2", "/d3"]);
  });

  it("handles mixed valid and invalid links on a page", async () => {
    const html = `<html><body><main>
      <a href="/valid">Valid</a>
      <a href="mailto:test@test.com">Email</a>
      <a href="tel:123">Phone</a>
      <a href="#anchor">Anchor</a>
      <a href="javascript:alert(1)">JS</a>
      <a href="/also-valid">Also Valid</a>
    </main></body></html>`;

    const result = await runDiscover({
      "/": html,
      "/valid": htmlPage("Valid"),
      "/also-valid": htmlPage("Also Valid")
    });

    const urls = result.map((p) => p.url).sort();
    expect(urls).toEqual(["/", "/also-valid", "/valid"]);
  });

  it("normalizes discovered URLs (trailing slashes, double slashes)", async () => {
    const html = `<html><body>
      <a href="/docs/">Docs with slash</a>
      <a href="/blog//">Blog double slash</a>
    </body></html>`;

    const result = await runDiscover({
      "/": html,
      "/docs": htmlPage("Docs"),
      "/blog": htmlPage("Blog")
    });

    const urls = result.map((p) => p.url).sort();
    expect(urls).toEqual(["/", "/blog", "/docs"]);
  });

  it("sets outgoingLinks to empty array for discovered pages", async () => {
    const result = await runDiscover({
      "/": htmlPage("Home", ["/about"]),
      "/about": htmlPage("About")
    });

    for (const page of result) {
      expect(page.outgoingLinks).toEqual([]);
    }
  });

  it("handles diamond-shaped link graphs", async () => {
    // / -> /a, /b; /a -> /c; /b -> /c
    const result = await runDiscover({
      "/": htmlPage("Home", ["/a", "/b"]),
      "/a": htmlPage("A", ["/c"]),
      "/b": htmlPage("B", ["/c"]),
      "/c": htmlPage("C")
    });

    const urls = result.map((p) => p.url).sort();
    expect(urls).toEqual(["/", "/a", "/b", "/c"]);
    // /c should only appear once despite being linked from /a and /b
  });

  it("does not discover pages beyond max depth in branching graphs", async () => {
    // / (d0) -> /a (d1), /b (d1); /a -> /a/deep (d2); /b -> /b/deep (d2) -> /b/deeper (d3)
    const result = await runDiscover(
      {
        "/": htmlPage("Home", ["/a", "/b"]),
        "/a": htmlPage("A", ["/a/deep"]),
        "/a/deep": htmlPage("A Deep"),
        "/b": htmlPage("B", ["/b/deep"]),
        "/b/deep": htmlPage("B Deep", ["/b/deeper"]),
        "/b/deeper": htmlPage("B Deeper")
      },
      { maxDepth: 2 }
    );

    const urls = result.map((p) => p.url).sort();
    expect(urls).toEqual(["/", "/a", "/a/deep", "/b", "/b/deep"]);
    expect(urls).not.toContain("/b/deeper");
  });

  it("excludes links discovered during crawl", async () => {
    // / -> /docs, /api/data; /docs -> /api/extra
    // With /api/* excluded, neither /api/data nor /api/extra should appear
    const result = await runDiscover(
      {
        "/": htmlPage("Home", ["/docs", "/api/data"]),
        "/docs": htmlPage("Docs", ["/api/extra"]),
        "/api/data": htmlPage("API Data"),
        "/api/extra": htmlPage("API Extra")
      },
      { exclude: ["/api/*"] }
    );

    const urls = result.map((p) => p.url).sort();
    expect(urls).toEqual(["/", "/docs"]);
  });

  it("pipeline maxPages uses config maxPages when pipeline maxPages is higher", async () => {
    const result = await runDiscover(
      {
        "/": htmlPage("Home", ["/a", "/b", "/c"]),
        "/a": htmlPage("A"),
        "/b": htmlPage("B"),
        "/c": htmlPage("C")
      },
      { maxPages: 2 },
      999
    );

    expect(result.length).toBe(2);
  });

  it("handles pages that link to pages returning errors", async () => {
    const { baseUrl, server } = await createTestServer({
      "/": htmlPage("Home", ["/good", "/error"]),
      "/good": htmlPage("Good")
      // /error will 404
    });
    const port = (server.address() as { port: number }).port;
    mockPreviewServer = { baseUrl, port, shutdown: async () => {} };

    const { loadBuildPages } = await import("../src/indexing/sources/build/index");
    const config = createDefaultConfig("discover-test");
    config.source.mode = "build";
    config.source.build = {
      outputDir: ".svelte-kit/output",
      paramValues: {},
      exclude: [],
      previewTimeout: 5000,
      discover: true,
      seedUrls: ["/"],
      maxPages: 200,
      maxDepth: 10
    };

    const result = (await loadBuildPages("/tmp", config)).records;
    const urls = result.map((p) => p.url).sort();
    expect(urls).toEqual(["/", "/good"]);
  });
});

// ---------------------------------------------------------------------------
// Config merging for build discover fields
// ---------------------------------------------------------------------------

describe("build discover config merging", () => {
  it("validates build config with discover fields", () => {
    const config = mergeConfig("/tmp", {
      source: {
        mode: "build",
        build: {
          discover: true,
          seedUrls: ["/", "/docs"],
          maxPages: 50,
          maxDepth: 5,
          exclude: ["/api/*"]
        }
      }
    });

    expect(config.source.build).toBeDefined();
    expect(config.source.build!.discover).toBe(true);
    expect(config.source.build!.seedUrls).toEqual(["/", "/docs"]);
    expect(config.source.build!.maxPages).toBe(50);
    expect(config.source.build!.maxDepth).toBe(5);
    expect(config.source.build!.exclude).toEqual(["/api/*"]);
  });

  it("applies defaults for discover fields when not specified", () => {
    const config = mergeConfig("/tmp", {
      source: {
        mode: "build",
        build: {
          discover: true
        }
      }
    });

    expect(config.source.build!.discover).toBe(true);
    expect(config.source.build!.seedUrls).toEqual(["/"]);
    expect(config.source.build!.maxPages).toBe(200);
    expect(config.source.build!.maxDepth).toBe(10);
    expect(config.source.build!.exclude).toEqual([]);
  });

  it("defaults discover to false when not set", () => {
    const config = mergeConfig("/tmp", {
      source: {
        mode: "build",
        build: {}
      }
    });

    expect(config.source.build!.discover).toBe(false);
  });

  it("creates build config with defaults when mode is build but no build section", () => {
    const config = mergeConfig("/tmp", {
      source: {
        mode: "build"
      }
    });

    expect(config.source.build).toBeDefined();
    expect(config.source.build!.discover).toBe(false);
    expect(config.source.build!.seedUrls).toEqual(["/"]);
    expect(config.source.build!.maxPages).toBe(200);
    expect(config.source.build!.maxDepth).toBe(10);
    expect(config.source.build!.outputDir).toBe(".svelte-kit/output");
  });

  it("preserves non-discover build fields alongside discover fields", () => {
    const config = mergeConfig("/tmp", {
      source: {
        mode: "build",
        build: {
          outputDir: "custom/output",
          paramValues: { "/blog/[slug]": ["hello", "world"] },
          exclude: ["/admin"],
          previewTimeout: 10000,
          discover: true,
          seedUrls: ["/docs"],
          maxPages: 100,
          maxDepth: 5
        }
      }
    });

    expect(config.source.build!.outputDir).toBe("custom/output");
    expect(config.source.build!.paramValues).toEqual({ "/blog/[slug]": ["hello", "world"] });
    expect(config.source.build!.previewTimeout).toBe(10000);
    expect(config.source.build!.discover).toBe(true);
    expect(config.source.build!.seedUrls).toEqual(["/docs"]);
    expect(config.source.build!.maxPages).toBe(100);
    expect(config.source.build!.maxDepth).toBe(5);
  });

  it("auto-detects build mode from build config presence", () => {
    const config = mergeConfig("/tmp", {
      source: {
        build: {
          discover: true
        }
      }
    });

    expect(config.source.mode).toBe("build");
    expect(config.source.build!.discover).toBe(true);
  });

  it("defaults previewTimeout to 30000", () => {
    const config = mergeConfig("/tmp", {
      source: {
        mode: "build",
        build: { discover: true }
      }
    });

    expect(config.source.build!.previewTimeout).toBe(30000);
  });
});
