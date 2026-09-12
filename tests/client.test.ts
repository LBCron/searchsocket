import { describe, expect, it, vi } from "vitest";
import { createSearchClient } from "../src/client";

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
