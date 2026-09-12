import { afterEach, describe, expect, it, vi } from "vitest";
import { searchsocketHandle } from "../src/sveltekit/handle";
import { createDefaultConfig } from "../src/config/defaults";
import { SearchEngine } from "../src/search/engine";
import type { ResolvedSearchSocketConfig } from "../src/types";

/**
 * `searchsocket init` writes `sequence(existingHandle, searchsocketHandle())`
 * into hooks.server.ts. These tests run that composition for real — a denied
 * request and a permitted one — because the ordering bug it guards against is
 * invisible to any string assertion on the generated file.
 *
 * @sveltejs/kit is not a dependency of this package (it is a peer of the host
 * app), so `sequence` is reproduced here with the part of SvelteKit's
 * semantics these tests turn on: the first handler is outermost, and the
 * `resolve` handed to each handler invokes the next one in the list. The real
 * one also merges resolve options across handlers — searchsocketHandle passes
 * none, so ordering cannot disturb the app's own transforms.
 */
type SvelteKitHandle = (input: {
  event: unknown;
  resolve: (event: unknown) => Promise<Response>;
}) => Promise<Response>;

function sequence(...handlers: SvelteKitHandle[]): SvelteKitHandle {
  return ({ event, resolve }) => {
    const apply = (index: number) => (nextEvent: unknown): Promise<Response> => {
      const next = handlers[index];
      return next ? next({ event: nextEvent, resolve: apply(index + 1) }) : resolve(nextEvent);
    };

    return apply(0)(event);
  };
}

function makeConfig(): ResolvedSearchSocketConfig {
  return createDefaultConfig("test") as ResolvedSearchSocketConfig;
}

function makeEvent(authorized: boolean) {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorized) {
    headers.set("cookie", "session=valid");
  }

  return {
    url: { pathname: "/api/search", searchParams: new URLSearchParams() },
    request: {
      method: "POST",
      headers,
      json: async () => ({ q: "install" }),
      text: async () => JSON.stringify({ q: "install" })
    },
    getClientAddress: () => "127.0.0.1"
  };
}

/** An app hook of the shape `searchsocket init` has to compose with. */
function makeAuthHandle(): { handle: SvelteKitHandle; calls: () => number } {
  let calls = 0;
  const handle: SvelteKitHandle = async ({ event, resolve }) => {
    calls += 1;
    const headers = (event as { request: { headers: Headers } }).request.headers;
    if (!headers.get("cookie")?.includes("session=valid")) {
      return new Response("unauthorized", { status: 401 });
    }
    return resolve(event);
  };
  return { handle, calls: () => calls };
}

function mockSearch() {
  const search = vi.fn().mockResolvedValue({
    q: "install",
    scope: "main",
    results: [{ url: "/docs/install", title: "Install", snippet: "…", score: 0.9 }],
    meta: { timingsMs: { search: 1, total: 2 } }
  });
  vi.spyOn(SearchEngine, "create").mockResolvedValue({ search } as unknown as SearchEngine);
  return search;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generated hooks composition", () => {
  it("lets the app's handle deny a search request", async () => {
    const search = mockSearch();
    const auth = makeAuthHandle();
    const handle = sequence(auth.handle, searchsocketHandle({ config: makeConfig() }));

    const response = await handle({
      event: makeEvent(false),
      resolve: async () => new Response("page")
    });

    expect(response.status).toBe(401);
    expect(auth.calls()).toBe(1);
    expect(search).not.toHaveBeenCalled();
  });

  it("still answers a permitted search request", async () => {
    const search = mockSearch();
    const auth = makeAuthHandle();
    const handle = sequence(auth.handle, searchsocketHandle({ config: makeConfig() }));

    const response = await handle({
      event: makeEvent(true),
      resolve: async () => new Response("page")
    });

    expect(response.status).toBe(200);
    expect(auth.calls()).toBe(1);
    expect(search).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      q: "install",
      results: [{ url: "/docs/install" }]
    });
  });

  it("passes non-search routes through both handles to the app", async () => {
    const auth = makeAuthHandle();
    const handle = sequence(auth.handle, searchsocketHandle({ config: makeConfig() }));
    const resolve = vi.fn().mockResolvedValue(new Response("page"));

    const event = makeEvent(true);
    event.url.pathname = "/docs/install";

    const response = await handle({ event, resolve });

    expect(await response.text()).toBe("page");
    expect(auth.calls()).toBe(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("documents why the order matters: searchsocket first bypasses the app handle", async () => {
    const search = mockSearch();
    const auth = makeAuthHandle();
    const handle = sequence(searchsocketHandle({ config: makeConfig() }), auth.handle);

    const response = await handle({
      event: makeEvent(false),
      resolve: async () => new Response("page")
    });

    // The wrong order: searchsocketHandle answers without calling resolve, so
    // the 401 never happens and unauthenticated search data goes out.
    expect(response.status).toBe(200);
    expect(auth.calls()).toBe(0);
    expect(search).toHaveBeenCalledTimes(1);
  });
});
