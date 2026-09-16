import { afterEach, describe, expect, it, vi } from "vitest";
import { searchsocketHandle } from "../src/sveltekit/handle";
import { createDefaultConfig } from "../src/config/defaults";
import { SearchEngine } from "../src/search/engine";

/**
 * The MCP route driven end to end: real SvelteKit hook, real SDK transport,
 * real tool server. Only the engine is a stub, so the test counts exactly how
 * many searches one HTTP request can cause.
 */

function stubEngine() {
  const search = vi.fn().mockResolvedValue({
    q: "x",
    scope: "main",
    results: [],
    meta: { timingsMs: { search: 0, total: 0 } }
  });
  vi.spyOn(SearchEngine, "create").mockResolvedValue({ search } as unknown as SearchEngine);
  return search;
}

function mcpPost(body: unknown) {
  const url = new URL("https://site.example/api/mcp");
  return {
    url,
    request: new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify(body)
    }),
    getClientAddress: () => "127.0.0.1"
  };
}

function searchCall(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "search", arguments: { query: "install" } }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP route JSON-RPC batching", () => {
  function publicHandle() {
    const config = createDefaultConfig("test");
    config.mcp.handle.access = "public";
    return searchsocketHandle({ config });
  }

  it("refuses a batch without dispatching any of its messages", async () => {
    const search = stubEngine();
    const handle = publicHandle();
    const resolve = vi.fn();

    const batch = Array.from({ length: 50 }, (_, i) => searchCall(i + 1));
    const response = await handle({ event: mcpPost(batch), resolve });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid Request: JSON-RPC batching is not supported" },
      id: null
    });
    expect(search).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses a single-element batch too", async () => {
    const search = stubEngine();
    const response = await publicHandle()({ event: mcpPost([searchCall(1)]), resolve: vi.fn() });

    expect(response.status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it("still serves a single tools/call message", async () => {
    const search = stubEngine();
    const response = await publicHandle()({ event: mcpPost(searchCall(1)), resolve: vi.fn() });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { id: number; result?: unknown };
    expect(payload.id).toBe(1);
    expect(payload.result).toBeDefined();
    expect(search).toHaveBeenCalledTimes(1);
  });
});
