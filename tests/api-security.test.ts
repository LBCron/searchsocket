import { afterEach, describe, expect, it, vi } from "vitest";
import { PRIVILEGED_SEARCH_FIELDS, searchsocketHandle } from "../src/sveltekit/handle";
import { createSearchClient } from "../src/client";
import { SearchEngine } from "../src/search/engine";
import { createDefaultConfig } from "../src/config/defaults";
import type { ResolvedSearchSocketConfig, SearchRequest, SearchResponse } from "../src/types";

/**
 * Release-blocking invariant: a browser request may not choose which scope it
 * reads, and a public search response does not disclose repository paths or
 * full page content.
 *
 * `?scope=` used to be passed straight through, so any visitor could read a
 * preview or staging scope by naming it, and every result carried `routeFile`
 * (a path inside the author's repo) plus `chunkText` (the section in full).
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function makeConfig(overrides: Partial<ResolvedSearchSocketConfig> = {}): ResolvedSearchSocketConfig {
  const config = createDefaultConfig("api-security-test");
  return { ...config, ...overrides, api: { ...config.api, ...(overrides.api ?? {}) } };
}

function makeEvent(opts: {
  pathname: string;
  method: string;
  searchParams?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  const url = new URL(`https://site.example${opts.pathname}`);
  for (const [key, value] of Object.entries(opts.searchParams ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers = new Headers(opts.headers ?? {});
  if (opts.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return {
    url,
    request: {
      method: opts.method,
      headers,
      // Preserves an explicit `null` rather than coercing it to `{}` — null is
      // valid JSON and the handler must reject it as a 400, not crash.
      text: async () => JSON.stringify(opts.body === undefined ? {} : opts.body),
      json: async () => (opts.body === undefined ? {} : opts.body)
    } as unknown as Request
  };
}

const SAMPLE_RESPONSE: SearchResponse = {
  q: "test",
  scope: "main",
  results: [
    {
      url: "/docs/auth",
      title: "Auth",
      snippet: "A snippet.",
      score: 0.9,
      routeFile: "src/routes/docs/auth/+page.svelte",
      chunkText: "The complete text of this section, verbatim.",
      breakdown: {
        baseScore: 0.8,
        incomingLinkBoost: 0.05,
        depthBoost: 0,
        titleMatchBoost: 0.05,
        freshnessBoost: 0,
        anchorTextMatchBoost: 0
      },
      chunks: [
        {
          sectionTitle: "Tokens",
          snippet: "A snippet.",
          chunkText: "The complete text of the Tokens section.",
          headingPath: ["Auth", "Tokens"],
          score: 0.8
        }
      ]
    }
  ],
  meta: { timingsMs: { search: 1, total: 2 } }
};

function stubEngine(search = vi.fn().mockResolvedValue(SAMPLE_RESPONSE)) {
  vi.spyOn(SearchEngine, "create").mockResolvedValue({
    search,
    getPage: vi.fn()
  } as unknown as SearchEngine);
  return search;
}

describe("scope access policy", () => {
  it("ignores a caller-supplied scope by default", async () => {
    const search = stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "GET",
        searchParams: { q: "test", scope: "staging" }
      }),
      resolve
    });

    expect(response.status).toBe(403);
    expect(search).not.toHaveBeenCalled();
  });

  it("rejects a scope in a POST body too", async () => {
    // The body is no more trustworthy than the query string.
    const search = stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "POST",
        body: { q: "test", scope: "staging" }
      }),
      resolve
    });

    expect(response.status).toBe(403);
    expect(search).not.toHaveBeenCalled();
  });

  it("honours a scope the deployment explicitly allowed", async () => {
    const search = stubEngine();
    const handle = searchsocketHandle({
      config: makeConfig({ api: { allowedScopes: ["staging"] } } as Partial<ResolvedSearchSocketConfig>)
    });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "GET",
        searchParams: { q: "test", scope: "staging" }
      }),
      resolve
    });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ scope: "staging" }));
  });

  it("searches the server's own scope when none is requested", async () => {
    const search = stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    await handle({
      event: makeEvent({ pathname: "/api/search", method: "GET", searchParams: { q: "test" } }),
      resolve
    });

    expect(search.mock.calls[0]![0]).not.toHaveProperty("scope");
  });
});

describe("public versus privileged fields", () => {
  async function searchAndParse(config: ResolvedSearchSocketConfig) {
    stubEngine();
    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));
    const response = await handle({
      event: makeEvent({ pathname: "/api/search", method: "GET", searchParams: { q: "test" } }),
      resolve
    });
    return (await response.json()) as SearchResponse;
  }

  it("omits repository paths and full section text by default", async () => {
    const body = await searchAndParse(makeConfig());
    const [result] = body.results;

    expect(result!.routeFile).toBeUndefined();
    expect(result!.chunkText).toBeUndefined();
    expect(result!.breakdown).toBeUndefined();
    expect(result!.chunks![0]!.chunkText).toBeUndefined();
    // The snippet is what a search box needs, and it survives.
    expect(result!.snippet).toBe("A snippet.");
    expect(result!.url).toBe("/docs/auth");
  });

  // The POST handler redacts through a separate call site from GET. Nothing
  // asserted on its response body, so an inverted flag there would have leaked
  // every one of these fields with the suite still green.
  async function postAndParse(config: ResolvedSearchSocketConfig) {
    stubEngine();
    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));
    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "POST",
        body: { q: "test" },
        headers: { "content-type": "application/json" }
      }),
      resolve
    });
    return (await response.json()) as SearchResponse;
  }

  it("omits the same fields from a POST search", async () => {
    const body = await postAndParse(makeConfig());
    const [result] = body.results;

    expect(result!.routeFile).toBeUndefined();
    expect(result!.chunkText).toBeUndefined();
    expect(result!.breakdown).toBeUndefined();
    expect(result!.chunks![0]!.chunkText).toBeUndefined();
    expect(result!.snippet).toBe("A snippet.");
  });

  it("includes them on a POST search when the deployment opts in", async () => {
    const body = await postAndParse(
      makeConfig({ api: { exposeInternalFields: true } } as Partial<ResolvedSearchSocketConfig>)
    );
    const [result] = body.results;

    expect(result!.routeFile).toBe("src/routes/docs/auth/+page.svelte");
    expect(result!.chunkText).toContain("verbatim");
  });

  it("includes them when the deployment opts in", async () => {
    const body = await searchAndParse(
      makeConfig({ api: { exposeInternalFields: true } } as Partial<ResolvedSearchSocketConfig>)
    );
    const [result] = body.results;

    expect(result!.routeFile).toBe("src/routes/docs/auth/+page.svelte");
    expect(result!.chunkText).toContain("verbatim");
  });
});

describe("request hardening", () => {
  it("rejects a POST that is not JSON", async () => {
    // A form POST is sent cross-origin without a preflight, so a CORS policy
    // that denies the origin is never consulted.
    stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "POST",
        body: { q: "test" },
        headers: { "content-type": "application/x-www-form-urlencoded" }
      }),
      resolve
    });

    expect(response.status).toBe(415);
  });

  it("rejects a POST with no content type at all", async () => {
    // `if (mediaType && ...)` let an absent header through, so JSON bytes sent
    // as an ArrayBuffer body were a simple cross-origin POST — no preflight,
    // so the CORS policy was never consulted.
    stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const url = new URL("https://site.example/api/search");
    const response = await handle({
      event: {
        url,
        request: {
          method: "POST",
          headers: new Headers(),
          text: async () => JSON.stringify({ q: "test" }),
          json: async () => ({ q: "test" })
        } as unknown as Request
      },
      resolve
    });

    expect(response.status).toBe(415);
  });

  it("returns 400, not 500, for a JSON body of null", async () => {
    stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({ pathname: "/api/search", method: "POST", body: null }),
      resolve
    });

    expect(response.status).toBe(400);
  });

  it("accepts application/json with a charset parameter", async () => {
    const search = stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "POST",
        body: { q: "test" },
        headers: { "content-type": "application/json; charset=utf-8" }
      }),
      resolve
    });

    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalled();
  });

  it("marks search responses uncacheable", async () => {
    stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({ pathname: "/api/search", method: "GET", searchParams: { q: "test" } }),
      resolve
    });

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("names the permitted methods on a 405", async () => {
    stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({ pathname: "/api/search", method: "DELETE" }),
      resolve
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("GET");
  });

  it("sets Vary: Origin when reflecting an allowed origin", async () => {
    // Without it a shared cache can hand one origin's allow-origin header to
    // a different origin.
    stubEngine();
    const handle = searchsocketHandle({
      config: makeConfig({
        api: { cors: { allowOrigins: ["https://app.example"] } }
      } as Partial<ResolvedSearchSocketConfig>)
    });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "GET",
        searchParams: { q: "test" },
        headers: { origin: "https://app.example" }
      }),
      resolve
    });

    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(response.headers.get("vary")).toBe("Origin");
  });
});

describe("page retrieval does not disclose repository paths", () => {
  it("strips routeFile from the page response by default", async () => {
    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn(),
      getPage: vi.fn().mockResolvedValue({
        url: "/docs/auth",
        markdown: "# Auth",
        frontmatter: { title: "Auth", routeFile: "src/routes/docs/auth/+page.svelte" }
      })
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));
    const response = await handle({
      event: makeEvent({ pathname: "/api/search/pages/docs/auth", method: "GET" }),
      resolve
    });

    const body = (await response.json()) as { frontmatter: Record<string, unknown> };
    expect(body.frontmatter.routeFile).toBeUndefined();
    expect(body.frontmatter.title).toBe("Auth");
  });
});

/**
 * `SearchEngine.search` applies `rankingOverrides` whenever `debug` is true, so
 * an anonymous POST could retune the site's ranking for its own request. The
 * engine keeps the capability for the CLI, MCP and the local playground, which
 * call it directly; the public HTTP surface refuses the fields outright.
 */
describe("debug ranking overrides are not a public capability", () => {
  it("refuses an anonymous POST that enables ranking overrides", async () => {
    const search = stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "POST",
        body: {
          q: "test",
          debug: true,
          rankingOverrides: { ranking: { weights: { titleMatch: 100 } } }
        }
      }),
      resolve
    });

    expect(response.status).toBe(403);
    expect(search).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  // The field is refused for being present, not for being enabled, so there is
  // no shape of body that gets it as far as the engine.
  it.each([
    ["debug alone", { q: "test", debug: true }],
    ["debug disabled but present", { q: "test", debug: false }],
    ["overrides without debug", { q: "test", rankingOverrides: { ranking: { enableDepthBoost: false } } }],
    ["a non-boolean debug", { q: "test", debug: "true" }],
    ["a null override", { q: "test", rankingOverrides: null }]
  ])("refuses a POST carrying %s", async (_label, body) => {
    const search = stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({ pathname: "/api/search", method: "POST", body }),
      resolve
    });

    expect(response.status).toBe(403);
    expect(search).not.toHaveBeenCalled();
  });

  it("refuses the same fields on GET, which never read them", async () => {
    const search = stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "GET",
        searchParams: { q: "test", debug: "true" }
      }),
      resolve
    });

    expect(response.status).toBe(403);
    expect(search).not.toHaveBeenCalled();
  });

  it("leaves an ordinary POST untouched", async () => {
    const search = stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({ pathname: "/api/search", method: "POST", body: { q: "test", topK: 5 } }),
      resolve
    });

    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ q: "test", topK: 5 }));
  });
});

/**
 * Release-blocking invariant: the fields the server refuses are the fields the
 * client strips.
 *
 * They are two separate literals in two files — `PRIVILEGED_SEARCH_FIELDS` in
 * `src/sveltekit/handle.ts` and `PRIVILEGED_REQUEST_FIELDS` in
 * `src/client.ts`. Add one to the server's list alone and type-correct browser
 * code starts getting a 403 it cannot see coming; drop one from the server's
 * list alone and the client quietly discards a field that is now legitimate.
 *
 * The server's list is read directly (it is module-private to the package —
 * `src/sveltekit.ts` re-exports this module by name and does not list it). The
 * client's is checked behaviourally, through a mock fetch, because
 * `src/client.ts` *is* the `searchsocket/client` entry point: anything exported
 * from it is public API, and a test is not a reason to widen that.
 */
describe("the privileged-field lists cannot drift apart", () => {
  /** A plausible value per field, so the request is realistic rather than a bare key. */
  const SAMPLE_VALUES: Record<string, unknown> = {
    debug: true,
    rankingOverrides: { ranking: { enableDepthBoost: false } }
  };

  it.each(PRIVILEGED_SEARCH_FIELDS)("the client strips %s before sending", async (field) => {
    const sample = SAMPLE_VALUES[field];
    // A field the server refuses but this table has never heard of is itself
    // the drift: it means the server's list grew and nothing here followed.
    expect(sample, `add a sample value for the new privileged field "${field}"`).toBeDefined();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => SAMPLE_RESPONSE
    });
    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await client.search({ q: "test", [field]: sample } as SearchRequest);

    const init = vi.mocked(mockFetch).mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(field in body).toBe(false);
    expect(body.q).toBe("test");
  });

  it("what the client actually sends is accepted by the server", async () => {
    // The two halves joined end to end: strip on the way out, refuse on the way
    // in. A request carrying every privileged field at once must still reach
    // the engine once the client has been through it.
    const captured: { body?: string } = {};
    const mockFetch = vi.fn(async (_url: string, init: RequestInit) => {
      captured.body = init.body as string;
      return { ok: true, json: async () => SAMPLE_RESPONSE };
    });
    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    const request = { q: "test", topK: 5 } as Record<string, unknown>;
    for (const field of PRIVILEGED_SEARCH_FIELDS) request[field] = SAMPLE_VALUES[field];
    await client.search(request as unknown as SearchRequest);

    const search = stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "POST",
        body: JSON.parse(captured.body!)
      }),
      resolve
    });

    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ q: "test", topK: 5 }));
  });
});
