import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SearchEngine } from "../src/search/engine";
import { MAX_PATH_LENGTH, MAX_QUERY_LENGTH } from "../src/search/limits";
import { createServer } from "../src/mcp/server";
import { createDefaultConfig } from "../src/config/defaults";
import { SearchSocketError } from "../src/errors";
import { queryAwareExcerpt } from "../src/utils/text";
import type { UpstashSearchStore } from "../src/vector/upstash";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function makeEngine() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-bounds-"));
  tempDirs.push(cwd);
  const store = {
    searchPagesByText: vi.fn(async () => []),
    searchChunksByUrl: vi.fn(async () => []),
    search: vi.fn(async () => []),
    getPage: vi.fn(async () => null),
    fetchPageWithVector: vi.fn(async () => null)
  };
  const engine = await SearchEngine.create({
    cwd,
    config: createDefaultConfig("searchsocket-bounds"),
    store: store as unknown as UpstashSearchStore
  });
  return { engine, store };
}

describe("search input bounds", () => {
  it("accepts a query at the limit and refuses one past it as INVALID_REQUEST 400", async () => {
    const { engine, store } = await makeEngine();

    await expect(engine.search({ q: "a".repeat(MAX_QUERY_LENGTH) })).resolves.toBeDefined();
    await expect(engine.search({ q: "a".repeat(MAX_QUERY_LENGTH + 1) })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400
    });
    expect(store.searchPagesByText).toHaveBeenCalledTimes(1);
  });

  it("measures the query after trimming", async () => {
    const { engine } = await makeEngine();
    await expect(engine.search({ q: `  ${"a".repeat(MAX_QUERY_LENGTH)}  ` })).resolves.toBeDefined();
  });

  it("refuses an over-long page path before touching the backend", async () => {
    const { engine, store } = await makeEngine();
    const longPath = `/${"a".repeat(MAX_PATH_LENGTH)}`;

    await expect(engine.getPage(longPath)).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    await expect(engine.getRelatedPages(longPath)).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    expect(store.getPage).not.toHaveBeenCalled();
    expect(store.fetchPageWithVector).not.toHaveBeenCalled();
  });
});

describe("queryAwareExcerpt work bound", () => {
  it("treats a term repeated thousands of times as one term", () => {
    // Every term is a regex scan of the section and every match is recorded,
    // so this query used to cost 20,000 scans and millions of positions.
    const section = "the thing that the theme threads through ".repeat(400);
    const started = performance.now();

    const excerpt = queryAwareExcerpt(section, "th ".repeat(20_000));

    expect(performance.now() - started).toBeLessThan(1000);
    expect(excerpt).toBe(queryAwareExcerpt(section, "th"));
  });

  it("only considers the first distinct terms of a very long query", () => {
    const section = `${"alpha beta gamma ".repeat(100)}zebra ${"alpha beta gamma ".repeat(100)}`;
    const filler = Array.from({ length: 5000 }, (_, i) => `w${i}`);

    // Within the cap the late term steers the excerpt to the middle...
    expect(queryAwareExcerpt(section, `zebra ${filler.join(" ")}`)).toContain("zebra");
    // ...past it the term is never scanned for, and the excerpt is the lead.
    expect(queryAwareExcerpt(section, `${filler.join(" ")} zebra`).startsWith("alpha")).toBe(true);
  });
});

describe("MCP tool input bounds", () => {
  async function connect(engine: Partial<SearchEngine>) {
    const server = createServer(engine as SearchEngine);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bounds-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("refuses an over-long search query without calling the engine", async () => {
    const search = vi.fn();
    const client = await connect({ search });

    const result = await client.callTool({ name: "search", arguments: { query: "x".repeat(MAX_QUERY_LENGTH + 1) } });

    expect(result.isError).toBe(true);
    expect(search).not.toHaveBeenCalled();
  });

  it("measures the query after trimming, as the engine does", async () => {
    // A query HTTP accepts must not be refused over MCP for surrounding
    // whitespace: both paths now trim before the length check.
    const query = ` ${"a".repeat(MAX_QUERY_LENGTH)} `;
    const { engine } = await makeEngine();
    await expect(engine.search({ q: query })).resolves.toBeDefined();

    const client = await connect(engine);
    const result = await client.callTool({ name: "search", arguments: { query } });
    expect(result.isError).toBeFalsy();

    const blank = await client.callTool({ name: "search", arguments: { query: "   " } });
    expect(blank.isError).toBe(true);
  });

  it("refuses an over-long get_page path without calling the engine", async () => {
    const getPage = vi.fn();
    const client = await connect({ getPage });

    const result = await client.callTool({ name: "get_page", arguments: { path: `/${"x".repeat(MAX_PATH_LENGTH)}` } });

    expect(result.isError).toBe(true);
    expect(getPage).not.toHaveBeenCalled();
  });

  it("bounds the not-found suggestion search to the query limit", async () => {
    const getPage = vi.fn().mockRejectedValue(new SearchSocketError("INVALID_REQUEST", "Indexed page not found", 404));
    const search = vi.fn().mockResolvedValue({ results: [] });
    const client = await connect({ getPage, search });

    const longPath = `/${"docs/".repeat(300)}`.slice(0, MAX_PATH_LENGTH);
    const result = await client.callTool({ name: "get_page", arguments: { path: longPath } });

    expect(result.isError).toBeFalsy();
    expect(search).toHaveBeenCalledTimes(1);
    expect((search.mock.calls[0]![0] as { q: string }).q.length).toBeLessThanOrEqual(MAX_QUERY_LENGTH);
  });
});
