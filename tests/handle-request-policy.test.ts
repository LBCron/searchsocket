import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryRateLimiter, searchsocketHandle } from "../src/sveltekit/handle";
import { createServer as mockedCreateServer } from "../src/mcp/server";
import { loadConfig as mockedLoadConfig } from "../src/config/load";
import { createDefaultConfig } from "../src/config/defaults";
import { SearchEngine } from "../src/search/engine";
import { SearchSocketError } from "../src/errors";
import type { ResolvedSearchSocketConfig } from "../src/types";

/**
 * Companion to handle.test.ts covering the request policy the hook applies
 * before it will do any work: which routes it claims when the configuration is
 * unavailable, how many bytes a caller can make it allocate, and how long the
 * optional rate limiter remembers a client.
 */

let mockTransportHandleRequest = vi.fn();
let mockTransportClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => {
  return {
    WebStandardStreamableHTTPServerTransport: class {
      handleRequest = (...args: unknown[]) => mockTransportHandleRequest(...args);
      close = (...args: unknown[]) => mockTransportClose(...args);
    }
  };
});

vi.mock("../src/mcp/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/mcp/server")>();
  return {
    ...original,
    createServer: vi.fn().mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    })
  };
});

vi.mock("../src/config/load", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/config/load")>();
  return {
    ...original,
    loadConfig: vi.fn()
  };
});

const loadConfigMock = mockedLoadConfig as unknown as ReturnType<typeof vi.fn>;
const createServerMock = mockedCreateServer as unknown as ReturnType<typeof vi.fn>;

function makeConfig(mutate: (config: ResolvedSearchSocketConfig) => void = () => {}): ResolvedSearchSocketConfig {
  const config = createDefaultConfig("test");
  mutate(config);
  return config;
}

/** Event double matching the shape SvelteKit hands a hook, with a real Request. */
function makeRealEvent(options: {
  pathname: string;
  method: string;
  body?: BodyInit;
  headers?: Record<string, string>;
  clientAddress?: string;
}) {
  const url = new URL(`https://site.example${options.pathname}`);
  const init: RequestInit & { duplex?: string } = {
    method: options.method,
    headers: options.headers ?? {}
  };

  if (options.body !== undefined) {
    init.body = options.body;
    // undici requires this for a streaming body.
    init.duplex = "half";
  }

  return {
    url,
    request: new Request(url, init as RequestInit),
    getClientAddress: () => options.clientAddress ?? "127.0.0.1"
  };
}

/**
 * A body that produces `total` bytes but only as fast as it is pulled, so the
 * test can assert how much the handler actually asked for before giving up.
 */
function lazyBody(total: number, chunkSize = 256) {
  const chunk = new Uint8Array(chunkSize).fill(0x61); // "a"
  let produced = 0;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced >= total) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      produced += chunk.byteLength;
    }
  });

  return { stream, produced: () => produced };
}

function mockEngine(overrides: Record<string, unknown> = {}) {
  return vi.spyOn(SearchEngine, "create").mockResolvedValue({
    search: vi.fn().mockResolvedValue({
      q: "ok",
      scope: "main",
      results: [],
      meta: { timingsMs: { search: 0, total: 0 } }
    }),
    getPage: vi.fn().mockResolvedValue({ url: "/docs/install", markdown: "# Install" }),
    ...overrides
  } as unknown as SearchEngine);
}

beforeEach(() => {
  mockTransportHandleRequest = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
  mockTransportClose = vi.fn().mockResolvedValue(undefined);
  createServerMock.mockClear();
  loadConfigMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("configuration failures stay inside SearchSocket's own routes", () => {
  it("still resolves an unrelated application route when the config cannot load", async () => {
    loadConfigMock.mockRejectedValue(new SearchSocketError("CONFIG_MISSING", "No config found", 500));

    const handle = searchsocketHandle();
    const resolve = vi.fn().mockResolvedValue(new Response("home page"));

    const response = await handle({ event: makeRealEvent({ pathname: "/", method: "GET" }), resolve });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("home page");
  });

  it("answers the default search route with a search-scoped 503 instead of throwing", async () => {
    loadConfigMock.mockRejectedValue(new SearchSocketError("CONFIG_MISSING", "No config found", 500));

    const handle = searchsocketHandle();
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeRealEvent({ pathname: "/api/search", method: "GET" }),
      resolve
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "SEARCH_NOT_CONFIGURED" }
    });
  });

  it("does not disclose the loader's message to an anonymous caller", async () => {
    loadConfigMock.mockRejectedValue(new SearchSocketError("CONFIG_MISSING", "/srv/app/searchsocket.config.js", 500));

    const handle = searchsocketHandle();
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeRealEvent({ pathname: "/api/search", method: "GET" }),
      resolve
    });

    expect(await response.text()).not.toContain("/srv/app");
  });

  it("claims the configured path and only that path when the config is unavailable", async () => {
    loadConfigMock.mockRejectedValue(new SearchSocketError("CONFIG_MISSING", "No config found", 500));

    const handle = searchsocketHandle({ path: "/custom/search" });
    const resolve = vi.fn().mockResolvedValue(new Response("app"));

    const owned = await handle({
      event: makeRealEvent({ pathname: "/custom/search", method: "GET" }),
      resolve
    });
    expect(owned.status).toBe(503);

    // With a custom path configured, the packaged default belongs to the app.
    const notOwned = await handle({
      event: makeRealEvent({ pathname: "/api/search", method: "GET" }),
      resolve
    });
    expect(await notOwned.text()).toBe("app");
  });

  it("retries a failed load instead of memoizing it forever", async () => {
    loadConfigMock
      .mockRejectedValueOnce(new SearchSocketError("CONFIG_MISSING", "Not deployed yet", 500))
      .mockResolvedValue(makeConfig());
    mockEngine();

    const handle = searchsocketHandle();
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const first = await handle({
      event: makeRealEvent({ pathname: "/api/search?q=install", method: "GET" }),
      resolve
    });
    expect(first.status).toBe(503);

    const second = await handle({
      event: makeRealEvent({ pathname: "/api/search?q=install", method: "GET" }),
      resolve
    });
    expect(second.status).toBe(200);
    expect(loadConfigMock).toHaveBeenCalledTimes(2);
  });
});

describe("bounded request bodies", () => {
  it("rejects a search POST that lies about its size without draining it", async () => {
    const create = mockEngine();
    const { stream, produced } = lazyBody(1_000_000);

    const handle = searchsocketHandle({ config: makeConfig(), maxBodyBytes: 1024 });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeRealEvent({
        pathname: "/api/search",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream
      }),
      resolve
    });

    expect(response.status).toBe(413);
    expect(create).not.toHaveBeenCalled();
    // The megabyte is never produced: the reader stops pulling as soon as the
    // count crosses the limit. The slack allowed here is undici's own read-ahead
    // between the stream and the Request body, not anything the handler kept.
    expect(produced()).toBeLessThan(4096);
  });

  it("accepts a valid multi-byte body that sits just under the limit", async () => {
    const search = vi.fn().mockResolvedValue({
      q: "é",
      scope: "main",
      results: [],
      meta: { timingsMs: { search: 0, total: 0 } }
    });
    vi.spyOn(SearchEngine, "create").mockResolvedValue({ search } as unknown as SearchEngine);

    // Two bytes per character, so a character-counting limit would let this
    // through at twice the size and a naive byte guess would refuse it.
    const q = "é".repeat(400);
    const payload = JSON.stringify({ q });
    const bytes = Buffer.byteLength(payload, "utf8");

    const handle = searchsocketHandle({ config: makeConfig(), maxBodyBytes: bytes });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeRealEvent({
        pathname: "/api/search",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload
      }),
      resolve
    });

    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ q }));
    // Guard against a character-count regression sneaking past.
    expect(bytes).toBeGreaterThan(q.length);
  });

  it("rejects an MCP POST with no content-length once it crosses the limit", async () => {
    const create = mockEngine();
    const { stream, produced } = lazyBody(1_000_000);

    const config = makeConfig((c) => {
      c.mcp.handle.access = "public";
    });
    const handle = searchsocketHandle({ config, maxBodyBytes: 1024 });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeRealEvent({
        pathname: "/api/mcp",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream
      }),
      resolve
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000 }
    });
    expect(create).not.toHaveBeenCalled();
    expect(createServerMock).not.toHaveBeenCalled();
    expect(mockTransportHandleRequest).not.toHaveBeenCalled();
    expect(produced()).toBeLessThan(4096);
  });

  it("hands the transport the body it already read", async () => {
    mockEngine();

    const config = makeConfig((c) => {
      c.mcp.handle.access = "public";
    });
    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const message = { jsonrpc: "2.0", method: "initialize", id: 1 };
    const response = await handle({
      event: makeRealEvent({
        pathname: "/api/mcp",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message)
      }),
      resolve
    });

    expect(response.status).toBe(200);
    // The SDK only skips re-reading the (now consumed) stream when it is given
    // parsedBody, so this is the contract the bounded read depends on.
    expect(mockTransportHandleRequest).toHaveBeenCalledWith(expect.anything(), { parsedBody: message });
  });

  it("answers an unparseable MCP body with the transport's own parse error", async () => {
    mockEngine();

    const config = makeConfig((c) => {
      c.mcp.handle.access = "public";
    });
    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeRealEvent({
        pathname: "/api/mcp",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not json"
      }),
      resolve
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32700 } });
    expect(createServerMock).not.toHaveBeenCalled();
  });

  it("bounds a JSON content type the transport accepts but a strict parse would not", async () => {
    // The SDK's own gate is a substring test, so any content type containing
    // "application/json" reaches its body read. A stricter check here would let
    // `application/json-patch+json` through unbounded.
    const create = mockEngine();
    const { stream } = lazyBody(1_000_000);

    const config = makeConfig((c) => {
      c.mcp.handle.access = "public";
    });
    const handle = searchsocketHandle({ config, maxBodyBytes: 1024 });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeRealEvent({
        pathname: "/api/mcp",
        method: "POST",
        headers: { "content-type": "application/json-patch+json" },
        body: stream
      }),
      resolve
    });

    expect(response.status).toBe(413);
    expect(create).not.toHaveBeenCalled();
    expect(mockTransportHandleRequest).not.toHaveBeenCalled();
  });

  it("leaves a non-JSON content type to the transport", async () => {
    mockEngine();

    const config = makeConfig((c) => {
      c.mcp.handle.access = "public";
    });
    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    await handle({
      event: makeRealEvent({
        pathname: "/api/mcp",
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello"
      }),
      resolve
    });

    expect(mockTransportHandleRequest).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it("keeps the size check behind the auth check for a streamed body", async () => {
    // d7127b2: an oversized body must not turn a private deployment's 503 into
    // a 413 that discloses the configured threshold.
    mockEngine();
    const { stream } = lazyBody(1_000_000);

    const handle = searchsocketHandle({ config: makeConfig(), maxBodyBytes: 1024 });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeRealEvent({
        pathname: "/api/mcp",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream
      }),
      resolve
    });

    expect(response.status).toBe(503);
  });
});

describe("rate limiter coverage and lifetime", () => {
  function limitedConfig(mutate: (config: ResolvedSearchSocketConfig) => void = () => {}) {
    return makeConfig((config) => {
      config.api.rateLimit = { windowMs: 60_000, max: 1 };
      mutate(config);
    });
  }

  it("counts MCP requests, which are reachable without a key", async () => {
    mockEngine();

    const config = limitedConfig((c) => {
      c.mcp.handle.access = "public";
    });
    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const mcpEvent = () =>
      makeRealEvent({
        pathname: "/api/mcp",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 })
      });

    expect((await handle({ event: mcpEvent(), resolve })).status).toBe(200);

    const second = await handle({ event: mcpEvent(), resolve });
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({ jsonrpc: "2.0", error: { code: -32000 } });
  });

  it("counts markdown variant requests", async () => {
    mockEngine();

    const config = limitedConfig((c) => {
      c.llmsTxt.enable = true;
      c.llmsTxt.serveMarkdownVariants = true;
    });
    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const mdEvent = () => makeRealEvent({ pathname: "/docs/install.md", method: "GET" });

    expect((await handle({ event: mdEvent(), resolve })).status).toBe(200);

    const second = await handle({ event: mdEvent(), resolve });
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({ error: { code: "RATE_LIMITED" } });
  });

  it("resets a client's window at the configured time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    mockEngine();

    const handle = searchsocketHandle({ config: limitedConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));
    const search = () => makeRealEvent({ pathname: "/api/search?q=install", method: "GET" });

    expect((await handle({ event: search(), resolve })).status).toBe(200);
    expect((await handle({ event: search(), resolve })).status).toBe(429);

    vi.setSystemTime(new Date("2026-01-01T00:00:59Z"));
    expect((await handle({ event: search(), resolve })).status).toBe(429);

    vi.setSystemTime(new Date("2026-01-01T00:01:01Z"));
    expect((await handle({ event: search(), resolve })).status).toBe(200);
    expect((await handle({ event: search(), resolve })).status).toBe(429);
  });

  it("does not grow without bound under high-cardinality traffic", async () => {
    mockEngine();

    // A ceiling of four buckets makes the eviction observable: the first
    // client's window is dropped by the flood behind it, so its next request is
    // allowed again rather than counted against a bucket held forever.
    const handle = searchsocketHandle({ config: limitedConfig(), maxRateLimitBuckets: 4 });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const from = (ip: string) =>
      makeRealEvent({ pathname: "/api/search?q=install", method: "GET", clientAddress: ip });

    expect((await handle({ event: from("10.0.0.1"), resolve })).status).toBe(200);
    expect((await handle({ event: from("10.0.0.1"), resolve })).status).toBe(429);

    for (let i = 0; i < 50; i += 1) {
      expect((await handle({ event: from(`10.1.0.${i}`), resolve })).status).toBe(200);
    }

    expect((await handle({ event: from("10.0.0.1"), resolve })).status).toBe(200);
  });

  it("forgets expired buckets even when the client never comes back", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    mockEngine();

    // Ten one-time visitors against a ceiling of four: without the expiry sweep
    // the map would be full of dead windows and the still-live client below
    // would have been evicted along with them.
    const handle = searchsocketHandle({ config: limitedConfig(), maxRateLimitBuckets: 4 });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));
    const from = (ip: string) =>
      makeRealEvent({ pathname: "/api/search?q=install", method: "GET", clientAddress: ip });

    for (let i = 0; i < 10; i += 1) {
      await handle({ event: from(`10.2.0.${i}`), resolve });
    }

    vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));

    expect((await handle({ event: from("10.9.9.9"), resolve })).status).toBe(200);
    // The sweep reclaimed the dead windows, so this client keeps its own.
    expect((await handle({ event: from("10.9.9.9"), resolve })).status).toBe(429);
  });

  it("stays disabled on serverless, where a per-instance counter means nothing", async () => {
    process.env.VERCEL = "1";
    mockEngine();

    try {
      const handle = searchsocketHandle({ config: limitedConfig() });
      const resolve = vi.fn().mockResolvedValue(new Response("ok"));
      const search = () => makeRealEvent({ pathname: "/api/search?q=install", method: "GET" });

      expect((await handle({ event: search(), resolve })).status).toBe(200);
      expect((await handle({ event: search(), resolve })).status).toBe(200);
    } finally {
      delete process.env.VERCEL;
    }
  });
});

describe("InMemoryRateLimiter", () => {
  // The handler can only show that limiting works; the memory properties this
  // class exists for are only visible on the map itself.
  it("reclaims the windows of clients that never come back", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const limiter = new InMemoryRateLimiter(60_000, 5);
    for (let i = 0; i < 500; i += 1) {
      limiter.check(`visitor-${i}`);
    }
    expect(limiter.size).toBe(500);

    vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
    limiter.check("someone-else");

    // Every dead window is gone, not just the ones a returning client replaced.
    expect(limiter.size).toBe(1);
  });

  it("holds a hard ceiling under high-cardinality traffic", () => {
    const limiter = new InMemoryRateLimiter(60_000, 5, 100);
    for (let i = 0; i < 50_000; i += 1) {
      limiter.check(`10.0.${i % 256}.${i}`);
    }

    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  it("evicts the oldest window first when it has to make room", () => {
    const limiter = new InMemoryRateLimiter(60_000, 1, 2);

    expect(limiter.check("first")).toBe(true);
    expect(limiter.check("second")).toBe(true);
    // Over the ceiling, so the oldest window goes.
    expect(limiter.check("third")).toBe(true);

    expect(limiter.check("second")).toBe(false);
    // "first" was evicted, so it starts over rather than staying counted.
    expect(limiter.check("first")).toBe(true);
    expect(limiter.size).toBeLessThanOrEqual(2);
  });

  it("falls back to the default ceiling when handed a nonsensical one", () => {
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      const limiter = new InMemoryRateLimiter(60_000, 1, bad);
      limiter.check("a");
      limiter.check("b");

      // A ceiling of 0 or NaN disables eviction or empties the map on every
      // insert; either way "a" would no longer be holding a window.
      expect(limiter.size).toBe(2);
      expect(limiter.check("a")).toBe(false);
    }
  });

  it("resets a window at the configured time, not before", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const limiter = new InMemoryRateLimiter(1_000, 2);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(false);

    vi.setSystemTime(new Date("2026-01-01T00:00:00.999Z"));
    expect(limiter.check("a")).toBe(false);

    vi.setSystemTime(new Date("2026-01-01T00:00:01.001Z"));
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(false);
  });
});
