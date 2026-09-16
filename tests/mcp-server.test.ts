import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const app = {
    post: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    listen: vi.fn((_port: number, _host: string, cb: () => void) => {
      cb();
      return {
        once: vi.fn(),
        close: (closeCb: () => void) => closeCb()
      };
    })
  };

  const stdioConnect = vi.fn().mockResolvedValue(undefined);
  const httpConnect = vi.fn().mockResolvedValue(undefined);
  const createEngine = vi.fn();
  const loadConfig = vi.fn();

  return {
    app,
    stdioConnect,
    httpConnect,
    createEngine,
    loadConfig
  };
});

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  class McpServer {
    registerTool = vi.fn();
    close = vi.fn();
    connect = mocks.stdioConnect;
  }
  return { McpServer };
});

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => {
  class StdioServerTransport {}
  return { StdioServerTransport };
});

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => {
  class StreamableHTTPServerTransport {
    handleRequest = vi.fn().mockResolvedValue(undefined);
    close = vi.fn();
  }
  return { StreamableHTTPServerTransport };
});

vi.mock("@modelcontextprotocol/sdk/server/express.js", () => {
  return {
    createMcpExpressApp: () => mocks.app
  };
});

vi.mock("../src/search/engine", () => {
  return {
    SearchEngine: {
      create: mocks.createEngine
    }
  };
});

vi.mock("../src/config/load", () => {
  return {
    loadConfig: mocks.loadConfig
  };
});

import { runMcpServer, createServer, resolveApiKey, verifyApiKey } from "../src/mcp/server";
import { SearchSocketError } from "../src/errors";

/** The typed 404 SearchEngine.getPage throws for a page that is not indexed. */
function notFoundError(): SearchSocketError {
  return new SearchSocketError("INVALID_REQUEST", "Indexed page not found for /x", 404);
}

describe("runMcpServer", () => {
  const originalLog = console.log;
  const originalWarn = console.warn;

  beforeEach(() => {
    vi.clearAllMocks();
    console.log = originalLog;
    console.warn = originalWarn;
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
  });

  it("uses stdio transport and redirects console output to stderr", async () => {
    const config = {
      mcp: {
        transport: "stdio" as const,
        http: { port: 3338, path: "/mcp" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({
      getConfig: () => config
    });

    await runMcpServer({ transport: "stdio" });

    expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
    expect(mocks.createEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        config
      })
    );
    expect(mocks.stdioConnect).toHaveBeenCalledTimes(1);
    expect(console.log).not.toBe(originalLog);
  });

  it("respects config-driven http transport without forcing stdio redirection", async () => {
    const config = {
      mcp: {
        transport: "http" as const,
        http: { port: 3338, path: "/mcp" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({
      getConfig: () => config
    });

    await runMcpServer({});

    expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
    expect(mocks.createEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        config
      })
    );
    expect(mocks.app.listen).toHaveBeenCalledTimes(1);
    expect(console.log).toBe(originalLog);
  });

  it("honors explicit http transport override even if config defaults to stdio", async () => {
    const config = {
      mcp: {
        transport: "stdio" as const,
        http: { port: 3338, path: "/mcp" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({
      getConfig: () => config
    });

    await runMcpServer({ transport: "http" });

    expect(mocks.app.listen).toHaveBeenCalledTimes(1);
    expect(console.log).toBe(originalLog);
  });

  it("uses config-driven stdio transport when no explicit transport is provided", async () => {
    const config = {
      mcp: {
        transport: "stdio" as const,
        http: { port: 3338, path: "/mcp" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({
      getConfig: () => config
    });

    await runMcpServer({});

    expect(mocks.stdioConnect).toHaveBeenCalledTimes(1);
    expect(console.log).not.toBe(originalLog);
  });

  it("hands --access and --api-key to loadConfig so they count toward validation", async () => {
    // Applied after loading, a flag key arrived too late: loadConfig had
    // already rejected a public config for having no key.
    const config = { mcp: { transport: "stdio" as const, http: { port: 3338, path: "/mcp" } } };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await runMcpServer({ access: "public", apiKey: "SECRET" });

    expect(mocks.loadConfig).toHaveBeenCalledWith(
      expect.objectContaining({ overrides: { mcp: { access: "public", apiKey: "SECRET" } } })
    );
  });
});

describe("tool registration", () => {
  it("registers exactly 3 tools", () => {
    const mockEngine = { search: vi.fn(), getPage: vi.fn(), getRelatedPages: vi.fn() };
    const server = createServer(mockEngine as never);
    const calls = (server.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(3);
  });

  it("registers search, get_page, and get_related_pages", () => {
    const mockEngine = { search: vi.fn(), getPage: vi.fn(), getRelatedPages: vi.fn() };
    const server = createServer(mockEngine as never);
    const calls = (server.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    const toolNames = calls.map((c: unknown[]) => c[0]);
    expect(toolNames).toContain("search");
    expect(toolNames).toContain("get_page");
    expect(toolNames).toContain("get_related_pages");
  });

  it("does not register removed tools", () => {
    const mockEngine = { search: vi.fn(), getPage: vi.fn(), getRelatedPages: vi.fn() };
    const server = createServer(mockEngine as never);
    const calls = (server.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    const toolNames = calls.map((c: unknown[]) => c[0]);
    expect(toolNames).not.toContain("find_source_file");
    expect(toolNames).not.toContain("list_pages");
    expect(toolNames).not.toContain("get_site_structure");
  });
});

describe("search tool", () => {
  function getSearchCall(mockEngine: Record<string, unknown>) {
    const server = createServer(mockEngine as never);
    const calls = (server.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    return calls.find((c: unknown[]) => c[0] === "search")!;
  }

  function getSearchHandler(mockEngine: Record<string, unknown>) {
    const call = getSearchCall(mockEngine);
    return call[2] as (input: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
    }>;
  }

  it("description mentions routeFile for editing and get_page for deep-dives", () => {
    const mockEngine = { search: vi.fn() };
    const call = getSearchCall(mockEngine);
    const config = call[1] as { description: string };
    expect(config.description).toContain("routeFile");
    expect(config.description).toContain("get_page");
  });

  it("description mentions chunk grouping", () => {
    const mockEngine = { search: vi.fn() };
    const call = getSearchCall(mockEngine);
    const config = call[1] as { description: string };
    expect(config.description).toContain("chunk");
  });

  it("returns search results as JSON content", async () => {
    const mockResult = {
      q: "test",
      scope: "main",
      results: [{ url: "/home", title: "Home", snippet: "Welcome", score: 0.9, routeFile: "src/routes/+page.svelte" }],
      meta: { timingsMs: { search: 10, total: 15 } }
    };
    const mockEngine = { search: vi.fn().mockResolvedValue(mockResult) };
    const handler = getSearchHandler(mockEngine);

    const result = await handler({ query: "test" });

    expect(result.content).toBeDefined();
    expect(result.content[0]!.type).toBe("text");
    expect(JSON.parse(result.content[0]!.text)).toEqual(mockResult);
  });

  it("returns helpful message when no results found", async () => {
    const mockResult = { q: "nonexistent", scope: "main", results: [], meta: { timingsMs: { search: 5, total: 8 } } };
    const mockEngine = { search: vi.fn().mockResolvedValue(mockResult) };
    const handler = getSearchHandler(mockEngine);

    const result = await handler({ query: "nonexistent" });

    expect(result.content[0]!.text).toContain("No results found");
    expect(result.content[0]!.text).toContain("nonexistent");
  });

  it("forwards all parameters to engine.search", async () => {
    const mockResult = { q: "auth", scope: "main", results: [{ url: "/a", title: "A", snippet: "...", score: 0.9, routeFile: "" }], meta: { timingsMs: { search: 5, total: 8 } } };
    const mockEngine = { search: vi.fn().mockResolvedValue(mockResult) };
    const handler = getSearchHandler(mockEngine);

    await handler({
      query: "auth",
      topK: 5,
      pathPrefix: "/docs",
      tags: ["security"],
      filters: { version: 2 },
      groupBy: "chunk",
      scope: "my-scope"
    });

    expect(mockEngine.search).toHaveBeenCalledWith({
      q: "auth",
      topK: 5,
      pathPrefix: "/docs",
      tags: ["security"],
      filters: { version: 2 },
      groupBy: "chunk",
      scope: "my-scope"
    });
  });

  it("forwards only query when optional params omitted", async () => {
    const mockResult = { q: "test", scope: "main", results: [{ url: "/a", title: "A", snippet: "...", score: 0.9, routeFile: "" }], meta: { timingsMs: { search: 5, total: 8 } } };
    const mockEngine = { search: vi.fn().mockResolvedValue(mockResult) };
    const handler = getSearchHandler(mockEngine);

    await handler({ query: "test" });

    expect(mockEngine.search).toHaveBeenCalledWith({
      q: "test",
      topK: undefined,
      pathPrefix: undefined,
      tags: undefined,
      filters: undefined,
      groupBy: undefined,
      scope: undefined
    });
  });

  it("propagates engine.search errors", async () => {
    const mockEngine = { search: vi.fn().mockRejectedValue(new Error("Upstash unreachable")) };
    const handler = getSearchHandler(mockEngine);

    await expect(handler({ query: "fail" })).rejects.toThrow("Upstash unreachable");
  });
});

describe("get_page tool", () => {
  function getHandler(mockEngine: Record<string, unknown>) {
    const server = createServer(mockEngine as never);
    const calls = (server.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    const call = calls.find((c: unknown[]) => c[0] === "get_page");
    expect(call).toBeDefined();
    return call![2] as (input: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
  }

  it("returns page content from engine", async () => {
    const mockPage = {
      url: "/docs/auth",
      frontmatter: { title: "Auth", routeFile: "src/routes/docs/auth/+page.svelte" },
      markdown: "# Auth\n\nContent here."
    };
    const mockEngine = {
      search: vi.fn(),
      getPage: vi.fn().mockResolvedValue(mockPage)
    };

    const handler = getHandler(mockEngine);
    const result = await handler({ path: "/docs/auth" });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed).toEqual(mockPage);
    expect(mockEngine.getPage).toHaveBeenCalledWith("/docs/auth", undefined);
  });

  it("returns suggestions when page not found", async () => {
    const mockEngine = {
      search: vi.fn().mockResolvedValue({
        results: [{ url: "/docs/authentication" }, { url: "/docs/api" }]
      }),
      getPage: vi.fn().mockRejectedValue(notFoundError())
    };

    const handler = getHandler(mockEngine);
    const result = await handler({ path: "/docs/auth" });

    expect(result.content[0]!.text).toContain("not found");
    expect(result.content[0]!.text).toContain("/docs/authentication");
  });

  it("passes scope to engine.getPage", async () => {
    const mockEngine = {
      search: vi.fn(),
      getPage: vi.fn().mockResolvedValue({ url: "/docs", frontmatter: {}, markdown: "" })
    };

    const handler = getHandler(mockEngine);
    await handler({ path: "/docs", scope: "my-scope" });

    expect(mockEngine.getPage).toHaveBeenCalledWith("/docs", "my-scope");
  });

  it("returns fallback message when page not found and no suggestions", async () => {
    const mockEngine = {
      search: vi.fn().mockResolvedValue({ results: [] }),
      getPage: vi.fn().mockRejectedValue(notFoundError())
    };

    const handler = getHandler(mockEngine);
    const result = await handler({ path: "/nonexistent" });

    expect(result.content[0]!.text).toContain("not found");
    expect(result.content[0]!.text).toContain("Use search");
  });

  it("passes scope to fallback search when page not found", async () => {
    const mockEngine = {
      search: vi.fn().mockResolvedValue({ results: [{ url: "/docs/auth" }] }),
      getPage: vi.fn().mockRejectedValue(notFoundError())
    };

    const handler = getHandler(mockEngine);
    await handler({ path: "/docs/missing", scope: "my-scope" });

    expect(mockEngine.search).toHaveBeenCalledWith({
      q: "/docs/missing",
      topK: 3,
      scope: "my-scope"
    });
  });

  it("description mentions search-first workflow", () => {
    const mockEngine = { search: vi.fn(), getPage: vi.fn() };
    const server = createServer(mockEngine as never);
    const calls = (server.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    const call = calls.find((c: unknown[]) => c[0] === "get_page");
    const config = call![1] as { description: string };
    expect(config.description).toContain("Do NOT use this for discovery");
    expect(config.description).toContain("search");
  });
});

describe("get_related_pages tool", () => {
  function getHandler(mockEngine: Record<string, unknown>) {
    const server = createServer(mockEngine as never);
    const calls = (server.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    const call = calls.find((c: unknown[]) => c[0] === "get_related_pages");
    expect(call).toBeDefined();
    return call![2] as (input: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
  }

  it("returns related pages from engine", async () => {
    const mockResult = {
      sourceUrl: "/docs/auth",
      scope: "main",
      relatedPages: [
        { url: "/docs/api", title: "API", score: 0.87, relationshipType: "outgoing_link", routeFile: "src/routes/docs/api/+page.svelte" },
        { url: "/docs/security", title: "Security", score: 0.73, relationshipType: "semantic", routeFile: "src/routes/docs/security/+page.svelte" }
      ]
    };
    const mockEngine = {
      search: vi.fn(),
      getRelatedPages: vi.fn().mockResolvedValue(mockResult)
    };

    const handler = getHandler(mockEngine);
    const result = await handler({ path: "/docs/auth" });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed).toEqual(mockResult);
    expect(mockEngine.getRelatedPages).toHaveBeenCalledWith("/docs/auth", {
      topK: undefined,
      scope: undefined
    });
  });

  it("forwards topK and scope to engine", async () => {
    const mockEngine = {
      search: vi.fn(),
      getRelatedPages: vi.fn().mockResolvedValue({ sourceUrl: "/a", scope: "s", relatedPages: [] })
    };

    const handler = getHandler(mockEngine);
    await handler({ path: "/docs/auth", topK: 5, scope: "my-scope" });

    expect(mockEngine.getRelatedPages).toHaveBeenCalledWith("/docs/auth", {
      topK: 5,
      scope: "my-scope"
    });
  });

  it("propagates engine errors", async () => {
    const mockEngine = {
      search: vi.fn(),
      getRelatedPages: vi.fn().mockRejectedValue(new Error("Page not found in index"))
    };

    const handler = getHandler(mockEngine);
    await expect(handler({ path: "/nonexistent" })).rejects.toThrow("Page not found in index");
  });

  it("description contains negative constraint", () => {
    const mockEngine = { search: vi.fn(), getRelatedPages: vi.fn() };
    const server = createServer(mockEngine as never);
    const calls = (server.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    const call = calls.find((c: unknown[]) => c[0] === "get_related_pages");
    const config = call![1] as { description: string };
    expect(config.description).toContain("Do NOT use this for general search");
  });
});

describe("redacted servers (mcp.handle.access: \"public\")", () => {
  function getHandler(mockEngine: Record<string, unknown>, name: string, redact: boolean) {
    const server = createServer(mockEngine as never, { redact });
    const calls = (server.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    const call = calls.find((c: unknown[]) => c[0] === name);
    expect(call).toBeDefined();
    return call![2] as (input: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
  }

  function getToolConfig(mockEngine: Record<string, unknown>, name: string, redact: boolean) {
    const server = createServer(mockEngine as never, { redact });
    const calls = (server.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    const call = calls.find((c: unknown[]) => c[0] === name);
    return call![1] as { description: string };
  }

  function searchResponse() {
    return {
      q: "auth",
      scope: "main",
      results: [
        {
          url: "/docs/auth",
          title: "Auth",
          snippet: "How to authenticate.",
          score: 0.9,
          chunkText: "The full indexed section text.",
          routeFile: "src/routes/docs/auth/+page.svelte",
          breakdown: { baseScore: 0.8, incomingLinkBoost: 0.1 },
          chunks: [
            {
              sectionTitle: "Tokens",
              snippet: "Tokens expire.",
              chunkText: "Tokens expire after an hour.",
              headingPath: ["Auth", "Tokens"],
              score: 0.7
            },
            {
              sectionTitle: "Refresh",
              snippet: "Refresh tokens rotate.",
              chunkText: "Refresh tokens rotate on every use.",
              headingPath: ["Auth", "Refresh"],
              score: 0.6
            }
          ]
        },
        {
          url: "/docs/api",
          title: "API",
          snippet: "The HTTP API.",
          score: 0.5,
          chunkText: "Second result indexed text.",
          routeFile: "src/routes/docs/api/+page.svelte",
          breakdown: { baseScore: 0.4, incomingLinkBoost: 0.05 },
          chunks: [
            {
              sectionTitle: "Endpoints",
              snippet: "Endpoints listed.",
              chunkText: "Every endpoint, listed.",
              headingPath: ["API", "Endpoints"],
              score: 0.4
            }
          ]
        }
      ],
      meta: { timingsMs: { search: 1, total: 2 } }
    };
  }

  it("strips routeFile, chunkText and breakdown from search results", async () => {
    const response = searchResponse();
    const mockEngine = { search: vi.fn().mockResolvedValue(response) };

    const handler = getHandler(mockEngine, "search", true);
    const parsed = JSON.parse((await handler({ query: "auth" })).content[0]!.text);

    expect(parsed.results).toHaveLength(2);
    for (const result of parsed.results) {
      expect(result.routeFile).toBeUndefined();
      expect(result.chunkText).toBeUndefined();
      expect(result.breakdown).toBeUndefined();
      for (const chunk of result.chunks) {
        expect(chunk.chunkText).toBeUndefined();
      }
    }

    // Everything the site already publishes survives.
    const [result] = parsed.results;
    expect(result.url).toBe("/docs/auth");
    expect(result.title).toBe("Auth");
    expect(result.snippet).toBe("How to authenticate.");
    expect(result.score).toBe(0.9);
    expect(result.chunks[0].snippet).toBe("Tokens expire.");
    expect(parsed.q).toBe("auth");
    expect(parsed.meta).toEqual({ timingsMs: { search: 1, total: 2 } });
  });

  it("does not mutate the engine result while redacting", async () => {
    const response = searchResponse();
    const pristine = structuredClone(response);
    const mockEngine = { search: vi.fn().mockResolvedValue(response) };

    const parsed = JSON.parse(
      (await getHandler(mockEngine, "search", true)({ query: "auth" })).content[0]!.text
    );

    // The returned payload really was redacted...
    expect(parsed.results[0].routeFile).toBeUndefined();
    // ...and the engine's own object came through untouched.
    expect(response).toEqual(pristine);
  });

  it("strips frontmatter.routeFile from get_page but keeps the markdown", async () => {
    const mockEngine = {
      search: vi.fn(),
      getPage: vi.fn().mockResolvedValue({
        url: "/docs/auth",
        frontmatter: { title: "Auth", tags: ["a"], routeFile: "src/routes/docs/auth/+page.svelte" },
        markdown: "# Auth\n\nContent here."
      })
    };

    const handler = getHandler(mockEngine, "get_page", true);
    const parsed = JSON.parse((await handler({ path: "/docs/auth" })).content[0]!.text);

    expect(parsed.frontmatter.routeFile).toBeUndefined();
    expect(parsed.frontmatter.title).toBe("Auth");
    expect(parsed.frontmatter.tags).toEqual(["a"]);
    // The markdown is the same content the site serves publicly, so it stays.
    expect(parsed.markdown).toBe("# Auth\n\nContent here.");
  });

  it("strips routeFile from every related page", async () => {
    const mockEngine = {
      search: vi.fn(),
      getRelatedPages: vi.fn().mockResolvedValue({
        sourceUrl: "/docs/auth",
        scope: "main",
        relatedPages: [
          { url: "/docs/api", title: "API", score: 0.87, relationshipType: "outgoing_link", routeFile: "src/routes/docs/api/+page.svelte" },
          { url: "/docs/security", title: "Security", score: 0.73, relationshipType: "semantic", routeFile: "src/routes/docs/security/+page.svelte" }
        ]
      })
    };

    const handler = getHandler(mockEngine, "get_related_pages", true);
    const parsed = JSON.parse((await handler({ path: "/docs/auth" })).content[0]!.text);

    expect(parsed.relatedPages).toHaveLength(2);
    for (const page of parsed.relatedPages) {
      expect(page.routeFile).toBeUndefined();
    }
    expect(parsed.relatedPages[0].url).toBe("/docs/api");
    expect(parsed.relatedPages[0].relationshipType).toBe("outgoing_link");
  });

  it("ignores a caller-supplied scope so anonymous callers cannot read a staging namespace", async () => {
    const mockEngine = {
      search: vi.fn().mockResolvedValue({ q: "x", scope: "main", results: [], meta: {} }),
      getPage: vi.fn().mockResolvedValue({ url: "/a", frontmatter: {}, markdown: "" }),
      getRelatedPages: vi.fn().mockResolvedValue({ sourceUrl: "/a", scope: "main", relatedPages: [] })
    };

    await getHandler(mockEngine, "search", true)({ query: "x", scope: "staging" });
    expect(mockEngine.search).toHaveBeenCalledWith(expect.objectContaining({ scope: undefined }));

    await getHandler(mockEngine, "get_page", true)({ path: "/a", scope: "staging" });
    expect(mockEngine.getPage).toHaveBeenCalledWith("/a", undefined);

    await getHandler(mockEngine, "get_related_pages", true)({ path: "/a", scope: "staging" });
    expect(mockEngine.getRelatedPages).toHaveBeenCalledWith("/a", { topK: undefined, scope: undefined });
  });

  it("forces the scope on the get_page not-found suggestion search too", async () => {
    // The fallback issues a *second* engine call, and it was the one most
    // likely to be missed — it would hand back staging URLs as "similar pages".
    const mockEngine = {
      search: vi.fn().mockResolvedValue({ q: "/docs/missing", scope: "main", results: [], meta: {} }),
      getPage: vi.fn().mockRejectedValue(notFoundError())
    };

    const handler = getHandler(mockEngine, "get_page", true);
    await handler({ path: "/docs/missing", scope: "staging" });

    expect(mockEngine.getPage).toHaveBeenCalledWith("/docs/missing", undefined);
    expect(mockEngine.search).toHaveBeenCalledWith({
      q: "/docs/missing",
      topK: 3,
      scope: undefined
    });
  });

  it("reports an engine failure to an anonymous caller without naming internals", async () => {
    // SDK 1.26 turns a thrown error into an isError result carrying the message
    // verbatim, and engine messages name env vars and backend URLs.
    const leaky = new Error("Scope mode is env but PRIVATE_PREVIEW_SCOPE is not set.");
    const mockEngine = {
      search: vi.fn().mockRejectedValue(leaky),
      getRelatedPages: vi.fn().mockRejectedValue(leaky)
    };

    for (const tool of ["search", "get_related_pages"]) {
      const handler = getHandler(mockEngine, tool, true);
      const result = await handler(tool === "search" ? { query: "x" } : { path: "/a" });
      const text = result.content[0]!.text;
      expect(text).not.toContain("PRIVATE_PREVIEW_SCOPE");
      expect(text).toContain("INTERNAL_ERROR");
    }
  });

  it("still propagates the real error to a privileged caller", async () => {
    const mockEngine = { search: vi.fn().mockRejectedValue(new Error("Upstash unreachable")) };

    await expect(getHandler(mockEngine, "search", false)({ query: "x" })).rejects.toThrow(
      "Upstash unreachable"
    );
  });

  it("still forwards a scope for a privileged caller", async () => {
    const mockEngine = {
      search: vi.fn().mockResolvedValue({ q: "x", scope: "staging", results: [], meta: {} })
    };

    await getHandler(mockEngine, "search", false)({ query: "x", scope: "staging" });
    expect(mockEngine.search).toHaveBeenCalledWith(expect.objectContaining({ scope: "staging" }));
  });

  it("leaves results untouched when redact is not set", async () => {
    const response = searchResponse();
    const mockEngine = { search: vi.fn().mockResolvedValue(response) };

    const handler = getHandler(mockEngine, "search", false);
    const parsed = JSON.parse((await handler({ query: "auth" })).content[0]!.text);

    expect(parsed).toEqual(response);
    expect(parsed.results[0].routeFile).toBe("src/routes/docs/auth/+page.svelte");
    expect(parsed.results[1].chunks[0].chunkText).toBe("Every endpoint, listed.");
  });

  it("keeps the standalone default unredacted when no options are passed", async () => {
    const response = searchResponse();
    const mockEngine = { search: vi.fn().mockResolvedValue(response) };
    const server = createServer(mockEngine as never);
    const calls = (server.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    const handler = calls.find((c: unknown[]) => c[0] === "search")![2] as (
      input: Record<string, unknown>
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;

    const parsed = JSON.parse((await handler({ query: "auth" })).content[0]!.text);
    expect(parsed.results[0].routeFile).toBe("src/routes/docs/auth/+page.svelte");
  });

  it("does not advertise fields a redacted caller will never receive", () => {
    const mockEngine = { search: vi.fn(), getPage: vi.fn() };

    const publicSearch = getToolConfig(mockEngine, "search", true).description;
    expect(publicSearch).not.toContain("routeFile");
    expect(publicSearch).not.toContain("chunkText");

    const publicGetPage = getToolConfig(mockEngine, "get_page", true).description;
    expect(publicGetPage).not.toContain("routeFile");
    // The caveats about what the markdown is still apply.
    expect(publicGetPage).toContain("NOT byte-exact source");
  });

  it("keeps the editing-oriented descriptions for a privileged caller", () => {
    const mockEngine = { search: vi.fn(), getPage: vi.fn() };

    expect(getToolConfig(mockEngine, "search", false).description).toContain("routeFile");
    expect(getToolConfig(mockEngine, "get_page", false).description).toContain("routeFile");
  });
});

describe("verifyApiKey", () => {
  it("returns true for matching keys", () => {
    expect(verifyApiKey("test-key-123", "test-key-123")).toBe(true);
  });

  it("returns false for mismatched keys", () => {
    expect(verifyApiKey("wrong-key", "test-key-123")).toBe(false);
  });

  it("returns false for keys with different lengths", () => {
    expect(verifyApiKey("short", "a-much-longer-key-value")).toBe(false);
  });

  it("returns false for empty provided key", () => {
    expect(verifyApiKey("", "test-key-123")).toBe(false);
  });
});

describe("resolveApiKey", () => {
  it("returns apiKey from config when set", () => {
    const config = {
      mcp: { http: { apiKey: "direct-key", port: 3338, path: "/mcp" } }
    } as never;
    expect(resolveApiKey(config)).toBe("direct-key");
  });

  it("returns env var value when apiKeyEnv is set", () => {
    const envKey = "TEST_SEARCHSOCKET_MCP_KEY_" + Date.now();
    process.env[envKey] = "env-key-value";
    try {
      const config = {
        mcp: { http: { apiKeyEnv: envKey, port: 3338, path: "/mcp" } }
      } as never;
      expect(resolveApiKey(config)).toBe("env-key-value");
    } finally {
      delete process.env[envKey];
    }
  });

  it("prefers apiKey over apiKeyEnv", () => {
    const envKey = "TEST_SEARCHSOCKET_MCP_KEY2_" + Date.now();
    process.env[envKey] = "env-value";
    try {
      const config = {
        mcp: { http: { apiKey: "direct-value", apiKeyEnv: envKey, port: 3338, path: "/mcp" } }
      } as never;
      expect(resolveApiKey(config)).toBe("direct-value");
    } finally {
      delete process.env[envKey];
    }
  });

  it("returns undefined when neither is set", () => {
    const config = {
      mcp: { http: { port: 3338, path: "/mcp" } }
    } as never;
    expect(resolveApiKey(config)).toBeUndefined();
  });
});

describe("startHttpServer access modes", () => {
  const originalLog = console.log;
  const originalWarn = console.warn;

  beforeEach(() => {
    vi.clearAllMocks();
    console.log = originalLog;
    console.warn = originalWarn;
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
  });

  it("binds to 127.0.0.1 in private mode (default)", async () => {
    const config = {
      mcp: {
        access: "private" as const,
        transport: "http" as const,
        http: { port: 3338, path: "/mcp" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await runMcpServer({ transport: "http" });

    expect(mocks.app.listen).toHaveBeenCalledWith(
      3338,
      "127.0.0.1",
      expect.any(Function)
    );
  });

  it("binds to 0.0.0.0 in public mode", async () => {
    const config = {
      mcp: {
        access: "public" as const,
        transport: "http" as const,
        http: { port: 3338, path: "/mcp", apiKey: "test-key" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await runMcpServer({ transport: "http" });

    expect(mocks.app.listen).toHaveBeenCalledWith(
      3338,
      "0.0.0.0",
      expect.any(Function)
    );
  });

  it("rejects requests without auth in public mode", async () => {
    const config = {
      mcp: {
        access: "public" as const,
        transport: "http" as const,
        http: { port: 3338, path: "/mcp", apiKey: "secret-key" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await runMcpServer({ transport: "http" });

    const postHandler = mocks.app.post.mock.calls[0]![1] as (req: unknown, res: unknown) => Promise<void>;
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };

    await postHandler(
      { headers: {}, body: {} },
      mockRes
    );

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: "2.0",
        error: expect.objectContaining({ code: -32001, message: "Unauthorized" })
      })
    );
  });

  it("accepts requests with valid Bearer token in public mode", async () => {
    const config = {
      mcp: {
        access: "public" as const,
        transport: "http" as const,
        http: { port: 3338, path: "/mcp", apiKey: "secret-key" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await runMcpServer({ transport: "http" });

    const postHandler = mocks.app.post.mock.calls[0]![1] as (req: unknown, res: unknown) => Promise<void>;
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      on: vi.fn(),
      headersSent: false
    };

    await postHandler(
      { headers: { authorization: "Bearer secret-key" }, body: {} },
      mockRes
    );

    // Should NOT have returned 401
    expect(mockRes.status).not.toHaveBeenCalledWith(401);
  });

  it("accepts requests with valid x-api-key header in public mode", async () => {
    const config = {
      mcp: {
        access: "public" as const,
        transport: "http" as const,
        http: { port: 3338, path: "/mcp", apiKey: "secret-key" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await runMcpServer({ transport: "http" });

    const postHandler = mocks.app.post.mock.calls[0]![1] as (req: unknown, res: unknown) => Promise<void>;
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      on: vi.fn(),
      headersSent: false
    };

    await postHandler(
      { headers: { "x-api-key": "secret-key" }, body: {} },
      mockRes
    );

    expect(mockRes.status).not.toHaveBeenCalledWith(401);
  });

  it("rejects requests with wrong Bearer token in public mode", async () => {
    const config = {
      mcp: {
        access: "public" as const,
        transport: "http" as const,
        http: { port: 3338, path: "/mcp", apiKey: "secret-key" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await runMcpServer({ transport: "http" });

    const postHandler = mocks.app.post.mock.calls[0]![1] as (req: unknown, res: unknown) => Promise<void>;
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };

    await postHandler(
      { headers: { authorization: "Bearer wrong-key" }, body: {} },
      mockRes
    );

    expect(mockRes.status).toHaveBeenCalledWith(401);
  });

  it("does not require auth in private mode", async () => {
    const config = {
      mcp: {
        access: "private" as const,
        transport: "http" as const,
        http: { port: 3338, path: "/mcp" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await runMcpServer({ transport: "http" });

    const postHandler = mocks.app.post.mock.calls[0]![1] as (req: unknown, res: unknown) => Promise<void>;
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      on: vi.fn(),
      headersSent: false
    };

    await postHandler(
      { headers: {}, body: {} },
      mockRes
    );

    // Should NOT have returned 401
    expect(mockRes.status).not.toHaveBeenCalledWith(401);
  });

  it("applies CLI access and apiKey overrides", async () => {
    // loadConfig merges the overrides (see tests/config.test.ts); the mock
    // returns the config as it would after that merge.
    const config = {
      mcp: {
        access: "public" as const,
        transport: "http" as const,
        http: { port: 3338, path: "/mcp", apiKey: "cli-key" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await runMcpServer({ transport: "http", access: "public", apiKey: "cli-key" });

    expect(mocks.loadConfig).toHaveBeenCalledWith(
      expect.objectContaining({ overrides: { mcp: { access: "public", apiKey: "cli-key" } } })
    );

    // Should bind to 0.0.0.0 because CLI overrode access to public
    expect(mocks.app.listen).toHaveBeenCalledWith(
      3338,
      "0.0.0.0",
      expect.any(Function)
    );

    // Auth should be enforced with the CLI key
    const postHandler = mocks.app.post.mock.calls[0]![1] as (req: unknown, res: unknown) => Promise<void>;
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };

    await postHandler(
      { headers: {}, body: {} },
      mockRes
    );
    expect(mockRes.status).toHaveBeenCalledWith(401);
  });

  it("throws when CLI sets access to public without apiKey", async () => {
    // The key check runs inside loadConfig against the overridden config.
    mocks.loadConfig.mockRejectedValue(
      new Error('`mcp.access` is "public" but no API key is configured.')
    );

    await expect(
      runMcpServer({ transport: "http", access: "public" })
    ).rejects.toThrow("no API key");
  });
});
