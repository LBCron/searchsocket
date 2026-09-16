import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildResultUrl, createSearchClient, isSafeResultUrl } from "../src/client";
// The conformance table the reactive store is held to as well — see
// tests/svelte/response-validation.test.ts.
import { RESPONSE_VALIDATION_CASES } from "./svelte/response-validation-cases";

describe("createSearchClient", () => {
  it("creates a client with default endpoint", () => {
    const client = createSearchClient();
    expect(typeof client.search).toBe("function");
  });

  it("uses custom endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        q: "test",
        scope: "main",
        results: [],
        meta: { timingsMs: { search: 0, total: 0 } }
      })
    });

    const client = createSearchClient({
      endpoint: "/custom/search",
      fetchImpl: mockFetch as unknown as typeof fetch
    });

    await client.search({ q: "test" });

    expect(mockFetch).toHaveBeenCalledWith(
      "/custom/search",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: "test" })
      })
    );
  });

  it("returns search results on success", async () => {
    const expected = {
      q: "hello",
      scope: "main",
      results: [
        {
          url: "/docs/intro",
          title: "Intro",
          snippet: "Welcome",
          score: 0.9,
          routeFile: "src/routes/docs/intro/+page.svelte"
        }
      ],
      meta: {
        timingsMs: { search: 10, total: 30 }
      }
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => expected
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });
    const result = await client.search({ q: "hello", topK: 5 });

    expect(result.q).toBe("hello");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.url).toBe("/docs/intro");
  });

  it("throws on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: { code: "INVALID_REQUEST", message: "Bad query" }
      })
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await expect(client.search({ q: "" })).rejects.toThrow("Bad query");
  });

  it("throws generic message when error message is missing", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({})
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await expect(client.search({ q: "test" })).rejects.toThrow("Search failed");
  });

  it("throws generic message when error response is not valid JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      }
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await expect(client.search({ q: "test" })).rejects.toThrow("Search failed");
  });

  it("throws explicit error when success response is not valid JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      }
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await expect(client.search({ q: "test" })).rejects.toThrow("Invalid search response");
  });

  it("sends all request fields", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        q: "test",
        scope: "main",
        results: [],
        meta: { timingsMs: { search: 0, total: 0 } }
      })
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await client.search({
      q: "test query",
      topK: 20,
      scope: "feature",
      pathPrefix: "/docs",
      tags: ["guides"],
      groupBy: "page"
    });

    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(body.q).toBe("test query");
    expect(body.topK).toBe(20);
    expect(body.scope).toBe("feature");
    expect(body.pathPrefix).toBe("/docs");
    expect(body.tags).toEqual(["guides"]);
    expect(body.groupBy).toBe("page");
  });

  it("rejects a JSON null response body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => null
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await expect(client.search({ q: "test" })).rejects.toThrow("Invalid search response");
  });

  it("rejects a response whose results is not an array", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        q: "test",
        scope: "main",
        results: null,
        meta: { timingsMs: { search: 0, total: 0 } }
      })
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await expect(client.search({ q: "test" })).rejects.toThrow("Invalid search response");
  });

  it("rejects a result row that is missing its required fields", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        q: "test",
        scope: "main",
        results: [{ title: "No url", snippet: "x", score: 1 }],
        meta: { timingsMs: { search: 0, total: 0 } }
      })
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await expect(client.search({ q: "test" })).rejects.toThrow("Invalid search response");
  });

  it("accepts a result row that omits only optional fields", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        q: "test",
        scope: "main",
        results: [{ url: "/a", title: "A", snippet: "", score: 0 }],
        meta: { timingsMs: { search: 0, total: 0 } }
      })
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await expect(client.search({ q: "test" })).resolves.toMatchObject({
      results: [{ url: "/a" }]
    });
  });

  it("rejects a result row that is missing snippet", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        q: "test",
        scope: "main",
        results: [{ url: "/a", title: "A", score: 1 }],
        meta: { timingsMs: { search: 0, total: 0 } }
      })
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    // buildResultUrl() feeds snippet straight into string normalization.
    await expect(client.search({ q: "test" })).rejects.toThrow("Invalid search response");
  });

  it("rejects a present optional field of the wrong type", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        q: "test",
        scope: "main",
        results: [{ url: "/a", title: "A", snippet: "x", score: 1, sectionTitle: 42 }],
        meta: { timingsMs: { search: 0, total: 0 } }
      })
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await expect(client.search({ q: "test" })).rejects.toThrow("Invalid search response");
  });

  it("rejects a response missing its envelope fields", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] })
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await expect(client.search({ q: "test" })).rejects.toThrow("Invalid search response");
  });
});

describe("createSearchClient response validation", () => {
  for (const testCase of RESPONSE_VALIDATION_CASES) {
    it(`${testCase.valid ? "accepts" : "rejects"} ${testCase.name}`, async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => testCase.payload
      });

      const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });
      const search = client.search({ q: "test" });

      if (testCase.valid) {
        await expect(search).resolves.toBeDefined();
      } else {
        await expect(search).rejects.toThrow("Invalid search response");
      }
    });
  }
});

describe("isSafeResultUrl", () => {
  const safe = [
    "/docs/getting-started",
    "docs/getting-started",
    "?q=1",
    "#section",
    "//cdn.example.com/docs",
    "http://example.com/a",
    "HTTPS://Example.com/a"
  ];

  const unsafe = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    `java${String.fromCharCode(0)}script:alert(1)`,
    "data:text/html,<svg onload=alert(1)>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "",
    "   ",
    // Malformed: a scheme test alone would wave all of these through.
    "http://",
    "https://[::1",
    "https://example.com:70000",
    "//",
    "//%zz/a"
  ];

  for (const url of safe) {
    it(`accepts ${JSON.stringify(url)}`, () => {
      expect(isSafeResultUrl(url)).toBe(true);
    });
  }

  for (const url of unsafe) {
    it(`rejects ${JSON.stringify(url)}`, () => {
      expect(isSafeResultUrl(url)).toBe(false);
    });
  }

  it("rejects a non-string", () => {
    expect(isSafeResultUrl(42)).toBe(false);
    expect(isSafeResultUrl(null)).toBe(false);
  });
});

describe("buildResultUrl safe-link gate", () => {
  it("returns an empty string for an unsafe URL instead of an executable href", () => {
    expect(
      buildResultUrl({ url: "javascript:alert(1)", title: "A", snippet: "Hello", score: 1 })
    ).toBe("");
    expect(
      buildResultUrl({ url: " java\nscript:alert(1)", title: "A", snippet: "Hello", score: 1 })
    ).toBe("");
  });

  it("normalizes surrounding whitespace before appending scroll metadata", () => {
    // Untrimmed, "/docs " would resolve to "/docs%20" once a query was appended.
    expect(
      buildResultUrl({ url: "  /docs  ", title: "A", snippet: "Hello", score: 1 })
    ).toBe("/docs?_sskt=Hello#:~:text=Hello");
  });

  it("still builds a scroll target for an ordinary URL", () => {
    expect(buildResultUrl({ url: "/docs", title: "A", snippet: "Hello", score: 1 })).toContain(
      "_sskt=Hello"
    );
  });
});

describe("browser response validation stays shared", () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

  // The two entry points used to carry byte-identical copies of these checks,
  // which is exactly how they drift. Re-declaring one here is the failure this
  // guards, not the import itself.
  for (const entry of ["../src/client.ts", "../src/svelte/index.svelte.ts"]) {
    it(`${entry} imports the shared validator instead of declaring one`, () => {
      const source = read(entry);
      expect(source).toMatch(/from "\.(\/svelte)?\/response-validation"/);
      expect(source).not.toMatch(/function isSearchResponse\b/);
      expect(source).not.toMatch(/function isSearchResult\b/);
    });
  }
});
