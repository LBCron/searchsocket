import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateLlmsTxt, generateLlmsFullTxt, writeLlmsTxt } from "../src/indexing/llms-txt";
import { createDefaultConfig } from "../src/config/defaults";
import type { IndexedPage, ResolvedSearchSocketConfig } from "../src/types";
import { Logger } from "../src/core/logger";

function makePage(overrides: Partial<IndexedPage> = {}): IndexedPage {
  return {
    url: "/docs/intro",
    title: "Introduction",
    scope: "main",
    routeFile: "src/routes/docs/intro/+page.svelte",
    routeResolution: "exact",
    generatedAt: "2026-01-01T00:00:00Z",
    incomingLinks: 3,
    outgoingLinks: 2,
    depth: 1,
    tags: [],
    markdown: "# Introduction\n\nWelcome to the docs.",
    description: "Getting started with the project.",
    ...overrides
  };
}

function makeConfig(overrides: Partial<ResolvedSearchSocketConfig["llmsTxt"]> = {}): ResolvedSearchSocketConfig {
  const base = createDefaultConfig("test-project");
  return {
    ...base,
    llmsTxt: {
      ...base.llmsTxt,
      enable: true,
      ...overrides
    }
  };
}

function withMcp(
  config: ResolvedSearchSocketConfig,
  handle: Partial<ResolvedSearchSocketConfig["mcp"]["handle"]> & { enable?: boolean }
): ResolvedSearchSocketConfig {
  const { enable, ...handleOverrides } = handle;
  return {
    ...config,
    mcp: {
      ...config.mcp,
      enable: enable ?? config.mcp.enable,
      handle: { ...config.mcp.handle, ...handleOverrides }
    }
  };
}

describe("generateLlmsTxt", () => {
  it("generates valid llms.txt with title, description, and page entries", () => {
    const config = makeConfig({ title: "My Site", description: "A site about things." });
    const pages = [
      makePage({ url: "/docs/intro", title: "Intro", description: "Introduction page.", depth: 1, incomingLinks: 5 }),
      makePage({ url: "/docs/api", title: "API Reference", description: "Full API docs.", depth: 2, incomingLinks: 2 })
    ];

    const result = generateLlmsTxt(pages, config);

    expect(result).toContain("# My Site");
    expect(result).toContain("> A site about things.");
    expect(result).toContain("## Pages");
    expect(result).toContain("- [Intro](/docs/intro): Introduction page.");
    expect(result).toContain("- [API Reference](/docs/api): Full API docs.");
  });

  it("uses project.id as title when llmsTxt.title is not set", () => {
    const config = makeConfig({ title: undefined });
    const result = generateLlmsTxt([], config);
    expect(result).toContain("# test-project");
  });

  it("omits description blockquote when not set", () => {
    const config = makeConfig({ description: undefined });
    const result = generateLlmsTxt([], config);
    expect(result).not.toContain(">");
  });

  it("uses absolute URLs when baseUrl is configured", () => {
    const config = makeConfig();
    config.project.baseUrl = "https://example.com";
    const pages = [makePage({ url: "/docs/intro", title: "Intro" })];

    const result = generateLlmsTxt(pages, config);
    expect(result).toContain("https://example.com/docs/intro");
    expect(result).not.toContain("](/docs/intro)");
  });

  it("falls back to relative URLs when baseUrl is not set", () => {
    const config = makeConfig();
    config.project.baseUrl = undefined;
    const pages = [makePage({ url: "/docs/intro", title: "Intro" })];

    const result = generateLlmsTxt(pages, config);
    expect(result).toContain("](/docs/intro)");
  });

  it("filters out /llms.txt and /llms-full.txt pages", () => {
    const config = makeConfig();
    const pages = [
      makePage({ url: "/llms.txt", title: "LLMs" }),
      makePage({ url: "/llms-full.txt", title: "LLMs Full" }),
      makePage({ url: "/docs/intro", title: "Intro" })
    ];

    const result = generateLlmsTxt(pages, config);
    expect(result).not.toContain("[LLMs]");
    expect(result).not.toContain("[LLMs Full]");
    expect(result).toContain("[Intro]");
  });

  it("sorts pages by depth ascending, then incoming links descending", () => {
    const config = makeConfig();
    const pages = [
      makePage({ url: "/deep", title: "Deep", depth: 3, incomingLinks: 10 }),
      makePage({ url: "/", title: "Home", depth: 0, incomingLinks: 5 }),
      makePage({ url: "/about", title: "About", depth: 1, incomingLinks: 8 }),
      makePage({ url: "/contact", title: "Contact", depth: 1, incomingLinks: 2 })
    ];

    const result = generateLlmsTxt(pages, config);
    const lines = result.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines[0]).toContain("[Home]");
    expect(lines[1]).toContain("[About]");
    expect(lines[2]).toContain("[Contact]");
    expect(lines[3]).toContain("[Deep]");
  });

  it("omits description in link line when page has no description", () => {
    const config = makeConfig();
    const pages = [makePage({ url: "/x", title: "No Desc", description: undefined })];

    const result = generateLlmsTxt(pages, config);
    expect(result).toContain("- [No Desc](/x)");
    expect(result).not.toContain("- [No Desc](/x):");
  });

  it("returns valid output with empty pages array", () => {
    const config = makeConfig({ title: "Empty Site" });
    const result = generateLlmsTxt([], config);
    expect(result).toContain("# Empty Site");
    expect(result).not.toContain("## Pages");
  });
});

describe("generateLlmsFullTxt", () => {
  it("generates full content with page markdown separated by horizontal rules", () => {
    const config = makeConfig({ title: "Full Site", description: "All content." });
    const pages = [
      makePage({ url: "/docs/a", title: "Page A", markdown: "Content of page A." }),
      makePage({ url: "/docs/b", title: "Page B", markdown: "Content of page B." })
    ];

    const result = generateLlmsFullTxt(pages, config);
    expect(result).toContain("# Full Site");
    expect(result).toContain("> All content.");
    expect(result).toContain("---");
    expect(result).toContain("## [Page A](/docs/a)");
    expect(result).toContain("Content of page A.");
    expect(result).toContain("## [Page B](/docs/b)");
    expect(result).toContain("Content of page B.");
  });

  it("uses absolute URLs when baseUrl is configured", () => {
    const config = makeConfig();
    config.project.baseUrl = "https://example.com";
    const pages = [makePage({ url: "/docs/a", title: "Page A" })];

    const result = generateLlmsFullTxt(pages, config);
    expect(result).toContain("## [Page A](https://example.com/docs/a)");
  });
});

describe("writeLlmsTxt", () => {
  let tmpDir: string;
  let logger: Logger;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llms-txt-test-"));
    logger = new Logger({ quiet: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes llms.txt to the configured output path", async () => {
    const config = makeConfig({ outputPath: "static/llms.txt" });
    const pages = [makePage()];

    await writeLlmsTxt(pages, config, tmpDir, logger);

    const content = await fs.readFile(path.join(tmpDir, "static/llms.txt"), "utf8");
    expect(content).toContain("# test-project");
    expect(content).toContain("[Introduction]");
  });

  it("creates nested directories for outputPath", async () => {
    const config = makeConfig({ outputPath: "deep/nested/dir/llms.txt" });

    await writeLlmsTxt([], config, tmpDir, logger);

    const content = await fs.readFile(path.join(tmpDir, "deep/nested/dir/llms.txt"), "utf8");
    expect(content).toContain("# test-project");
  });

  it("writes llms-full.txt when generateFull is true", async () => {
    const config = makeConfig({ outputPath: "static/llms.txt", generateFull: true });
    const pages = [makePage({ url: "/a", title: "Page A", markdown: "Full content here." })];

    await writeLlmsTxt(pages, config, tmpDir, logger);

    const fullContent = await fs.readFile(path.join(tmpDir, "static/llms-full.txt"), "utf8");
    expect(fullContent).toContain("Full content here.");
  });

  it("keeps the two exports apart when outputPath has no .txt extension", async () => {
    // A plain suffix swap left both writes pointing at the same file, so the
    // full export silently clobbered the index export.
    const config = makeConfig({ outputPath: "static/export", generateFull: true });
    const pages = [makePage({ url: "/a", title: "Page A", markdown: "Full content here." })];

    await writeLlmsTxt(pages, config, tmpDir, logger);

    const index = await fs.readFile(path.join(tmpDir, "static/export"), "utf8");
    const full = await fs.readFile(path.join(tmpDir, "static/export-full"), "utf8");
    expect(index).toContain("## Pages");
    expect(index).not.toContain("Full content here.");
    expect(full).toContain("Full content here.");
  });

  it("preserves a non-txt extension on the full export", async () => {
    const config = makeConfig({ outputPath: "static/llms.md", generateFull: true });

    await writeLlmsTxt([makePage()], config, tmpDir, logger);

    await expect(fs.access(path.join(tmpDir, "static/llms-full.md"))).resolves.toBeUndefined();
  });

  it("does not write llms-full.txt when generateFull is false", async () => {
    const config = makeConfig({ outputPath: "static/llms.txt", generateFull: false });

    await writeLlmsTxt([], config, tmpDir, logger);

    await expect(fs.access(path.join(tmpDir, "static/llms-full.txt"))).rejects.toThrow();
  });
});

describe("retrieval API section", () => {
  it("always points at the public search endpoint", () => {
    const config = makeConfig();
    const result = generateLlmsTxt([], config);

    expect(result).toContain("## Retrieval API");
    expect(result).toContain("- Search: `GET /api/search?q={query}`");
    expect(result).toContain("No authentication required.");
  });

  it("honours a custom api.path", () => {
    const base = makeConfig();
    const config = { ...base, api: { ...base.api, path: "/_search" } };

    expect(generateLlmsTxt([], config)).toContain("`GET /_search?q={query}`");
  });

  it("uses absolute endpoint URLs when baseUrl is configured", () => {
    const config = makeConfig();
    config.project.baseUrl = "https://example.com";

    const result = generateLlmsTxt([], withMcp(config, { enable: true, apiKey: "sk-test-key" }));
    expect(result).toContain("`GET https://example.com/api/search?q={query}`");
    expect(result).toContain("`POST https://example.com/api/mcp`");
  });

  it("falls back to origin-relative endpoint paths when baseUrl is unset", () => {
    const config = makeConfig();
    config.project.baseUrl = undefined;

    const result = generateLlmsTxt([], withMcp(config, { enable: true, apiKey: "sk-test-key" }));
    expect(result).toContain("`GET /api/search?q={query}`");
    expect(result).toContain("`POST /api/mcp`");
  });

  it("resolves endpoints against the origin, not a baseUrl path prefix", () => {
    // Routes are matched against event.url.pathname, so they are
    // origin-absolute; appending them to a prefixed baseUrl would advertise a
    // URL the SvelteKit hook never sees.
    const config = makeConfig();
    config.project.baseUrl = "https://example.com/docs/";

    expect(generateLlmsTxt([], config)).toContain("`GET https://example.com/api/search?q={query}`");
  });

  it("advertises MCP when it is enabled and a key is configured", () => {
    const config = withMcp(makeConfig(), { enable: true, apiKey: "sk-test-key" });
    const result = generateLlmsTxt([], config);

    expect(result).toContain("- MCP: `POST /api/mcp`");
    expect(result).toContain("Authorization: Bearer");
  });

  it("advertises MCP when apiKeyEnv resolves to a value", () => {
    process.env.SS_MCP_KEY_PRESENT = "sk-from-env";
    try {
      const config = withMcp(makeConfig(), { enable: true, apiKeyEnv: "SS_MCP_KEY_PRESENT" });
      const result = generateLlmsTxt([], config);

      expect(result).toContain("- MCP: `POST /api/mcp`");
      // Neither the value nor the variable's name belongs in a public file.
      expect(result).not.toContain("sk-from-env");
      expect(result).not.toContain("SS_MCP_KEY_PRESENT");
    } finally {
      delete process.env.SS_MCP_KEY_PRESENT;
    }
  });

  it("stays silent about MCP when apiKeyEnv names a variable that is not set", () => {
    // handle.ts resolves the variable, so an unset name is a 503 at runtime.
    delete process.env.SS_MCP_KEY_ABSENT;
    const config = withMcp(makeConfig(), { enable: true, apiKeyEnv: "SS_MCP_KEY_ABSENT" });

    expect(generateLlmsTxt([], config)).not.toContain("/api/mcp");
  });

  it("does not promise a Bearer upgrade on a public route whose key never resolves", () => {
    delete process.env.SS_MCP_KEY_ABSENT;
    const config = withMcp(makeConfig(), {
      enable: true,
      access: "public",
      apiKeyEnv: "SS_MCP_KEY_ABSENT"
    });

    const result = generateLlmsTxt([], config);
    expect(result).toContain("- MCP: `POST /api/mcp`");
    expect(result).not.toContain("Bearer");
  });

  it("advertises configured paths verbatim, trailing slash included", () => {
    // The hook matches the pathname literally, so normalising the slash away
    // would advertise a path that falls through to the application.
    const base = makeConfig();
    const config = withMcp(
      { ...base, api: { ...base.api, path: "/api/search/" } },
      { enable: true, access: "public", path: "/api/mcp/" }
    );

    const result = generateLlmsTxt([], config);
    expect(result).toContain("`GET /api/search/?q={query}`");
    expect(result).toContain("`POST /api/mcp/`");
  });

  it("advertises MCP when access is public and no key is configured", () => {
    const config = withMcp(makeConfig(), { enable: true, access: "public" });
    const result = generateLlmsTxt([], config);

    expect(result).toContain("- MCP: `POST /api/mcp`");
    expect(result).toContain("anonymous callers");
    expect(result).not.toContain("Authorization: Bearer");
  });

  it("mentions both modes when access is public and a key is configured", () => {
    const config = withMcp(makeConfig(), { enable: true, access: "public", apiKey: "sk-test-key" });
    const result = generateLlmsTxt([], config);

    expect(result).toContain("anonymous callers");
    expect(result).toContain("Bearer token");
  });

  it("stays silent about MCP when it is enabled but private with no key", () => {
    // handle.ts fails this configuration closed with a 503; advertising it
    // would point an LLM at a dead endpoint.
    const config = withMcp(makeConfig(), { enable: true, access: "private" });
    const result = generateLlmsTxt([], config);

    expect(result).toContain("## Retrieval API");
    expect(result).not.toContain("/api/mcp");
  });

  it("stays silent about MCP when mcp.enable is false", () => {
    const config = withMcp(makeConfig(), { enable: false, access: "public", apiKey: "sk-test-key" });

    expect(generateLlmsTxt([], config)).not.toContain("/api/mcp");
  });

  it("never leaks the API key value into the public file", () => {
    const config = withMcp(makeConfig(), { enable: true, apiKey: "sk-super-secret-value" });

    expect(generateLlmsTxt([], config)).not.toContain("sk-super-secret-value");
    expect(generateLlmsFullTxt([], config)).not.toContain("sk-super-secret-value");
  });

  it("appears in llms-full.txt ahead of the page content", () => {
    const config = withMcp(makeConfig(), { enable: true, apiKey: "sk-test-key" });
    const pages = [makePage({ url: "/a", title: "Page A", markdown: "Body." })];

    const result = generateLlmsFullTxt(pages, config);
    expect(result).toContain("## Retrieval API");
    expect(result).toContain("## [Page A]");
    expect(result.indexOf("## Retrieval API")).toBeLessThan(result.indexOf("## [Page A]"));
  });

  it("sits above the page list in llms.txt", () => {
    const config = makeConfig();
    const result = generateLlmsTxt([makePage()], config);

    // Both headings must exist, or the index comparison passes on -1.
    expect(result).toContain("## Retrieval API");
    expect(result).toContain("## Pages");
    expect(result.indexOf("## Retrieval API")).toBeLessThan(result.indexOf("## Pages"));
  });
});
