import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  routeIdToFile,
  routeIdToUrl,
  expandRoutes,
  parseManifest,
  type ManifestRoute
} from "../src/indexing/sources/build/manifest-parser";
import { Logger } from "../src/core/logger";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-build-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("routeIdToFile", () => {
  it("maps root route", () => {
    expect(routeIdToFile("/")).toBe("src/routes/+page.svelte");
  });

  it("maps static route", () => {
    expect(routeIdToFile("/docs/agents")).toBe("src/routes/docs/agents/+page.svelte");
  });

  it("maps route with layout group", () => {
    expect(routeIdToFile("/(app)/docs")).toBe("src/routes/(app)/docs/+page.svelte");
  });

  it("maps dynamic route", () => {
    expect(routeIdToFile("/blog/[slug]")).toBe("src/routes/blog/[slug]/+page.svelte");
  });

  it("maps nested dynamic route", () => {
    expect(routeIdToFile("/docs/[category]/[page]")).toBe("src/routes/docs/[category]/[page]/+page.svelte");
  });
});

describe("routeIdToUrl", () => {
  it("returns / for root", () => {
    expect(routeIdToUrl("/")).toBe("/");
  });

  it("passes through static routes", () => {
    expect(routeIdToUrl("/docs/agents")).toBe("/docs/agents");
  });

  it("strips layout groups", () => {
    expect(routeIdToUrl("/(app)/docs")).toBe("/docs");
  });

  it("strips nested layout groups", () => {
    expect(routeIdToUrl("/(app)/(marketing)/about")).toBe("/about");
  });

  it("preserves dynamic params", () => {
    expect(routeIdToUrl("/blog/[slug]")).toBe("/blog/[slug]");
  });

  it("returns / when only layout group", () => {
    expect(routeIdToUrl("/(app)")).toBe("/");
  });
});

describe("expandRoutes", () => {
  const logger = new Logger();

  it("emits static routes directly", () => {
    const routes: ManifestRoute[] = [
      { id: "/", isPage: true, isDynamic: false, routeFile: "src/routes/+page.svelte" },
      { id: "/about", isPage: true, isDynamic: false, routeFile: "src/routes/about/+page.svelte" }
    ];

    const result = expandRoutes(routes, {}, [], logger);

    expect(result).toEqual([
      { url: "/", routeFile: "src/routes/+page.svelte" },
      { url: "/about", routeFile: "src/routes/about/+page.svelte" }
    ]);
  });

  it("expands dynamic routes with paramValues", () => {
    const routes: ManifestRoute[] = [
      { id: "/blog/[slug]", isPage: true, isDynamic: true, routeFile: "src/routes/blog/[slug]/+page.svelte" }
    ];

    const result = expandRoutes(
      routes,
      { "/blog/[slug]": ["hello-world", "second-post"] },
      [],
      logger
    );

    expect(result).toEqual([
      { url: "/blog/hello-world", routeFile: "src/routes/blog/[slug]/+page.svelte" },
      { url: "/blog/second-post", routeFile: "src/routes/blog/[slug]/+page.svelte" }
    ]);
  });

  it("skips dynamic routes without paramValues and warns", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const routes: ManifestRoute[] = [
      { id: "/blog/[slug]", isPage: true, isDynamic: true, routeFile: "src/routes/blog/[slug]/+page.svelte" }
    ];

    const result = expandRoutes(routes, {}, [], logger);

    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping dynamic route"));

    warnSpy.mockRestore();
  });

  it("respects exclude patterns", () => {
    const routes: ManifestRoute[] = [
      { id: "/", isPage: true, isDynamic: false, routeFile: "src/routes/+page.svelte" },
      { id: "/api/health", isPage: true, isDynamic: false, routeFile: "src/routes/api/health/+page.svelte" },
      { id: "/about", isPage: true, isDynamic: false, routeFile: "src/routes/about/+page.svelte" }
    ];

    const result = expandRoutes(routes, {}, ["/api/*"], logger);

    expect(result).toEqual([
      { url: "/", routeFile: "src/routes/+page.svelte" },
      { url: "/about", routeFile: "src/routes/about/+page.svelte" }
    ]);
  });

  it("excludes exact match patterns", () => {
    const routes: ManifestRoute[] = [
      { id: "/", isPage: true, isDynamic: false, routeFile: "src/routes/+page.svelte" },
      { id: "/hidden", isPage: true, isDynamic: false, routeFile: "src/routes/hidden/+page.svelte" }
    ];

    const result = expandRoutes(routes, {}, ["/hidden"], logger);

    expect(result).toEqual([
      { url: "/", routeFile: "src/routes/+page.svelte" }
    ]);
  });

  it("expands multi-parameter routes one segment per parameter", () => {
    const routes: ManifestRoute[] = [
      {
        id: "/docs/[category]/[page]",
        isPage: true,
        isDynamic: true,
        routeFile: "src/routes/docs/[category]/[page]/+page.svelte"
      }
    ];

    const result = expandRoutes(
      routes,
      { "/docs/[category]/[page]": ["guides/quickstart", "api/search"] },
      [],
      logger
    );

    expect(result).toEqual([
      { url: "/docs/guides/quickstart", routeFile: "src/routes/docs/[category]/[page]/+page.svelte" },
      { url: "/docs/api/search", routeFile: "src/routes/docs/[category]/[page]/+page.svelte" }
    ]);
  });

  it("gives a rest parameter every segment the later parameters do not need", () => {
    const routes: ManifestRoute[] = [
      {
        id: "/docs/[...path]/[page]",
        isPage: true,
        isDynamic: true,
        routeFile: "src/routes/docs/[...path]/[page]/+page.svelte"
      }
    ];

    const result = expandRoutes(
      routes,
      { "/docs/[...path]/[page]": ["a/b/c/quickstart"] },
      [],
      logger
    );

    expect(result).toEqual([
      { url: "/docs/a/b/c/quickstart", routeFile: "src/routes/docs/[...path]/[page]/+page.svelte" }
    ]);
  });

  it("expands a lone rest parameter with the whole value", () => {
    const routes: ManifestRoute[] = [
      {
        id: "/docs/[...slug]",
        isPage: true,
        isDynamic: true,
        routeFile: "src/routes/docs/[...slug]/+page.svelte"
      }
    ];

    const result = expandRoutes(routes, { "/docs/[...slug]": ["guides/advanced/setup"] }, [], logger);

    expect(result).toEqual([
      { url: "/docs/guides/advanced/setup", routeFile: "src/routes/docs/[...slug]/+page.svelte" }
    ]);
  });

  it("drops an optional parameter when the value runs out", () => {
    const routes: ManifestRoute[] = [
      {
        id: "/lang/[[locale]]/docs/[slug]",
        isPage: true,
        isDynamic: true,
        routeFile: "src/routes/lang/[[locale]]/docs/[slug]/+page.svelte"
      }
    ];

    const result = expandRoutes(
      routes,
      { "/lang/[[locale]]/docs/[slug]": ["en/intro", "intro"] },
      [],
      logger
    );

    expect(result).toEqual([
      { url: "/lang/en/docs/intro", routeFile: "src/routes/lang/[[locale]]/docs/[slug]/+page.svelte" },
      { url: "/lang/docs/intro", routeFile: "src/routes/lang/[[locale]]/docs/[slug]/+page.svelte" }
    ]);
  });

  it("skips and warns when a value has too few segments for the route", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const routes: ManifestRoute[] = [
      {
        id: "/docs/[category]/[page]",
        isPage: true,
        isDynamic: true,
        routeFile: "src/routes/docs/[category]/[page]/+page.svelte"
      }
    ];

    const result = expandRoutes(routes, { "/docs/[category]/[page]": ["guides"] }, [], logger);

    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("one path segment per parameter"));

    warnSpy.mockRestore();
  });

  it("skips and warns when a value has more segments than parameters", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const routes: ManifestRoute[] = [
      {
        id: "/docs/[category]/[page]",
        isPage: true,
        isDynamic: true,
        routeFile: "src/routes/docs/[category]/[page]/+page.svelte"
      }
    ];

    const result = expandRoutes(
      routes,
      { "/docs/[category]/[page]": ["guides/quickstart/extra"] },
      [],
      logger
    );

    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("one path segment per parameter"));

    warnSpy.mockRestore();
  });

  it("keeps giving a single parameter the whole value", () => {
    const routes: ManifestRoute[] = [
      { id: "/blog/[slug]", isPage: true, isDynamic: true, routeFile: "src/routes/blog/[slug]/+page.svelte" }
    ];

    const result = expandRoutes(routes, { "/blog/[slug]": ["nested/post"] }, [], logger);

    expect(result).toEqual([
      { url: "/blog/nested/post", routeFile: "src/routes/blog/[slug]/+page.svelte" }
    ]);
  });

  it("keeps expanding parameters embedded in a segment", () => {
    const routes: ManifestRoute[] = [
      { id: "/foo-[bar]", isPage: true, isDynamic: true, routeFile: "src/routes/foo-[bar]/+page.svelte" },
      { id: "/[slug].json", isPage: true, isDynamic: true, routeFile: "src/routes/[slug].json/+page.svelte" }
    ];

    const result = expandRoutes(
      routes,
      { "/foo-[bar]": ["hello"], "/[slug].json": ["data"] },
      [],
      logger
    );

    expect(result).toEqual([
      { url: "/foo-hello", routeFile: "src/routes/foo-[bar]/+page.svelte" },
      { url: "/data.json", routeFile: "src/routes/[slug].json/+page.svelte" }
    ]);
  });

  it("fills an embedded parameter and a later parameter from separate segments", () => {
    const routes: ManifestRoute[] = [
      {
        id: "/foo-[bar]/[id]",
        isPage: true,
        isDynamic: true,
        routeFile: "src/routes/foo-[bar]/[id]/+page.svelte"
      }
    ];

    const result = expandRoutes(routes, { "/foo-[bar]/[id]": ["hello/7"] }, [], logger);

    expect(result).toEqual([
      { url: "/foo-hello/7", routeFile: "src/routes/foo-[bar]/[id]/+page.svelte" }
    ]);
  });

  it("does not reserve a segment for a later rest parameter", () => {
    const routes: ManifestRoute[] = [
      {
        id: "/[[lang]]/docs/[...rest]",
        isPage: true,
        isDynamic: true,
        routeFile: "src/routes/[[lang]]/docs/[...rest]/+page.svelte"
      }
    ];

    const result = expandRoutes(routes, { "/[[lang]]/docs/[...rest]": ["en"] }, [], logger);

    expect(result).toEqual([
      { url: "/en/docs", routeFile: "src/routes/[[lang]]/docs/[...rest]/+page.svelte" }
    ]);
  });

  it("falls back to URL-based key for paramValues lookup", () => {
    const routes: ManifestRoute[] = [
      { id: "/(app)/blog/[slug]", isPage: true, isDynamic: true, routeFile: "src/routes/(app)/blog/[slug]/+page.svelte" }
    ];

    // Provide paramValues with URL key (without layout group)
    const result = expandRoutes(
      routes,
      { "/blog/[slug]": ["my-post"] },
      [],
      logger
    );

    expect(result).toEqual([
      { url: "/blog/my-post", routeFile: "src/routes/(app)/blog/[slug]/+page.svelte" }
    ]);
  });
});

describe("parseManifest", () => {
  it("parses manifest and extracts page routes", async () => {
    const dir = await makeTempDir();
    const serverDir = path.join(dir, ".svelte-kit", "output", "server");
    await fs.mkdir(serverDir, { recursive: true });

    const manifestContent = `
export const manifest = {
  appDir: "_app",
  appPath: "_app",
  assets: new Set([]),
  mimeTypes: {},
  _: {
    client: {},
    nodes: [],
    routes: [
      {
        id: "/",
        pattern: /^\\/$/,
        params: [],
        page: { layouts: [0], errors: [1], leaf: 2 },
        endpoint: null
      },
      {
        id: "/about",
        pattern: /^\\/about\\/?$/,
        params: [],
        page: { layouts: [0], errors: [1], leaf: 3 },
        endpoint: null
      },
      {
        id: "/api/health",
        pattern: /^\\/api\\/health\\/?$/,
        params: [],
        page: null,
        endpoint: { handler: () => {} }
      },
      {
        id: "/blog/[slug]",
        pattern: /^\\/blog\\/([^/]+?)\\/?$/,
        params: [{ name: "slug" }],
        page: { layouts: [0], errors: [1], leaf: 4 },
        endpoint: null
      },
      {
        id: "/(app)/docs",
        pattern: /^\\/docs\\/?$/,
        params: [],
        page: { layouts: [0, 5], errors: [1, ,], leaf: 6 },
        endpoint: null
      }
    ]
  }
};
`;

    await fs.writeFile(path.join(serverDir, "manifest-full.js"), manifestContent, "utf8");

    const routes = await parseManifest(dir, ".svelte-kit/output");

    // Should include page routes but not the API endpoint
    const ids = routes.map((r) => r.id);
    expect(ids).toContain("/");
    expect(ids).toContain("/about");
    expect(ids).toContain("/blog/[slug]");
    expect(ids).toContain("/(app)/docs");
    expect(ids).not.toContain("/api/health");

    // Dynamic routes should be flagged
    const blogRoute = routes.find((r) => r.id === "/blog/[slug]");
    expect(blogRoute?.isDynamic).toBe(true);
    expect(blogRoute?.routeFile).toBe("src/routes/blog/[slug]/+page.svelte");

    const staticRoute = routes.find((r) => r.id === "/about");
    expect(staticRoute?.isDynamic).toBe(false);
  });

  it("throws when manifest file is missing", async () => {
    const dir = await makeTempDir();

    await expect(parseManifest(dir, ".svelte-kit/output")).rejects.toThrow("manifest not found");
  });
});
