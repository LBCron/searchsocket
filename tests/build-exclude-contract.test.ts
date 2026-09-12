import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import type { PreviewServer } from "../src/indexing/sources/build/preview-server";
import type { ResolvedSearchSocketConfig } from "../src/types";

/**
 * `source.build.exclude` must mean the same thing whichever build path runs.
 *
 * The adapter-output path ignored it entirely, so a page the user excluded
 * reached the index from a vercel/cloudflare/static build while the identical
 * config kept it out under manifest and discovery mode.
 */

let mockPreviewServer: PreviewServer | null = null;

vi.mock("../src/indexing/sources/build/preview-server", () => ({
  startPreviewServer: async () => {
    if (!mockPreviewServer) throw new Error("mockPreviewServer not set");
    return mockPreviewServer;
  }
}));

const tempDirs: string[] = [];
const servers: http.Server[] = [];

/** Every mode indexes this same site, so the accepted URLs are comparable. */
const SITE_URLS = ["/", "/docs", "/admin", "/admin/users", "/api/v1"];

function htmlPage(title: string, links: string[] = []): string {
  const linkTags = links.map((href) => `<a href="${href}">${href}</a>`).join("\n");
  return `<html><head><title>${title}</title></head><body><main><h1>${title}</h1>${linkTags}</main></body></html>`;
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-exclude-"));
  tempDirs.push(dir);
  return dir;
}

async function startSite(): Promise<PreviewServer> {
  const pages: Record<string, string> = {};
  for (const url of SITE_URLS) {
    pages[url] = htmlPage(url, url === "/" ? SITE_URLS.filter((u) => u !== "/") : []);
  }

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const html = pages[req.url ?? "/"];
      if (html) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      servers.push(server);
      resolve({ baseUrl: `http://127.0.0.1:${port}`, port, shutdown: async () => {} });
    });
  });
}

function buildConfig(
  exclude: string[],
  overrides: Partial<NonNullable<ResolvedSearchSocketConfig["source"]["build"]>> = {}
): ResolvedSearchSocketConfig {
  const config = createDefaultConfig("exclude-contract");
  config.source.mode = "build";
  config.source.staticOutputDir = "build";
  config.source.build = {
    outputDir: ".svelte-kit/output",
    paramValues: {},
    exclude,
    previewTimeout: 5000,
    discover: false,
    seedUrls: ["/"],
    maxPages: 200,
    maxDepth: 10,
    ...overrides
  };
  return config;
}

async function loadUrls(cwd: string, config: ResolvedSearchSocketConfig, maxPages?: number): Promise<string[]> {
  const { loadBuildPages } = await import("../src/indexing/sources/build/index");
  const result = await loadBuildPages(cwd, config, maxPages);
  return result.records.map((page) => page.url).sort();
}

/** Manifest mode: a SvelteKit manifest plus a preview server serving the site. */
async function manifestUrls(exclude: string[]): Promise<string[]> {
  const cwd = await makeTempDir();
  const serverDir = path.join(cwd, ".svelte-kit", "output", "server");
  await fs.mkdir(serverDir, { recursive: true });

  const routes = SITE_URLS.map(
    (url) => `{ id: "${url}", pattern: /^x$/, page: { layouts: [0], leaf: 1 } }`
  ).join(",\n");
  await fs.writeFile(
    path.join(serverDir, "manifest-full.js"),
    `export const manifest = { _: { routes: [${routes}] } };\n`,
    "utf8"
  );

  mockPreviewServer = await startSite();
  return loadUrls(cwd, buildConfig(exclude));
}

/** Discovery mode: BFS from `/` over the same site. */
async function discoveryUrls(exclude: string[]): Promise<string[]> {
  const cwd = await makeTempDir();
  mockPreviewServer = await startSite();
  return loadUrls(cwd, buildConfig(exclude, { discover: true }));
}

/** Prerendered mode: adapter-static output on disk, no preview server. */
async function prerenderedUrls(exclude: string[], maxPages?: number): Promise<string[]> {
  const cwd = await makeTempDir();
  for (const url of SITE_URLS) {
    const dir = path.join(cwd, "build", ...url.split("/").filter(Boolean));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "index.html"), htmlPage(url), "utf8");
  }
  return loadUrls(cwd, buildConfig(exclude), maxPages);
}

afterEach(async () => {
  mockPreviewServer = null;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

describe("source.build.exclude is honoured identically by every build mode", () => {
  const cases: Array<{ name: string; exclude: string[]; accepted: string[] }> = [
    { name: "no exclusions", exclude: [], accepted: SITE_URLS.slice().sort() },
    {
      name: "an exact pattern",
      exclude: ["/admin"],
      accepted: ["/", "/admin/users", "/api/v1", "/docs"]
    },
    {
      name: "a single-level wildcard",
      exclude: ["/api/*", "/admin"],
      accepted: ["/", "/admin/users", "/docs"]
    },
    {
      name: "a globstar",
      exclude: ["/admin/**"],
      accepted: ["/", "/api/v1", "/docs"]
    }
  ];

  for (const { name, exclude, accepted } of cases) {
    it(`accepts the same URLs across modes for ${name}`, async () => {
      expect(await manifestUrls(exclude)).toEqual(accepted);
      expect(await discoveryUrls(exclude)).toEqual(accepted);
      expect(await prerenderedUrls(exclude)).toEqual(accepted);
    });
  }

  it("keeps an excluded prerendered page out of the records entirely", async () => {
    expect(await prerenderedUrls(["/admin"])).not.toContain("/admin");
  });

  it("reports an excluded prerendered run as complete and undiscovered", async () => {
    const cwd = await makeTempDir();
    for (const url of SITE_URLS) {
      const dir = path.join(cwd, "build", ...url.split("/").filter(Boolean));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "index.html"), htmlPage(url), "utf8");
    }

    const { loadBuildPages } = await import("../src/indexing/sources/build/index");
    const result = await loadBuildPages(cwd, buildConfig(["/admin/**"]));

    // Excluded pages are not a gap in the run's view of the site, so the run
    // stays authoritative and they never count as discovered.
    expect(result.complete).toBe(true);
    expect(result.limitedBy).toBeUndefined();
    expect(result.discoveredCount).toBe(3);
    expect(result.failures).toEqual([]);
  });

  it("drops excluded prerendered pages before maxPages spends its budget", async () => {
    // File order puts build/admin/index.html first, so a budget applied before
    // the filter would have spent a slot on the page the user excluded.
    expect(await prerenderedUrls(["/admin"], 2)).toEqual(["/admin/users", "/api/v1"]);
  });
});
