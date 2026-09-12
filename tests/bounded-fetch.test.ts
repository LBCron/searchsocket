import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundedFetch,
  BoundedFetchError,
  DEFAULT_MAX_RESPONSE_BYTES,
  USER_AGENT
} from "../src/utils/fetch";

/**
 * A mock Response with the fields `boundedFetch` reads: status, headers, and a
 * real streaming body, so the size cap can be exercised chunk by chunk rather
 * than only against an already-buffered string.
 */
function mockResponse(
  body: string | Buffer,
  init: { status?: number; contentType?: string; location?: string; chunkSize?: number } = {}
): Response {
  const status = init.status ?? 200;
  const buffer = typeof body === "string" ? Buffer.from(body) : body;
  const chunkSize = init.chunkSize ?? (buffer.byteLength || 1);

  const headers = new Headers();
  if (init.contentType) headers.set("content-type", init.contentType);
  if (init.location) headers.set("location", init.location);

  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= buffer.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(buffer.subarray(offset, offset + chunkSize)));
      offset += chunkSize;
    }
  });

  return new Response(status === 204 || status >= 300 ? null : stream, { status, headers });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("boundedFetch", () => {
  it("returns the body, content type and final url on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse("<html></html>", { contentType: "text/html" }))
    );

    const result = await boundedFetch("https://example.com/a", {
      allowedOrigin: "https://example.com",
      accept: "text/html"
    });

    expect(result.body.toString("utf8")).toBe("<html></html>");
    expect(result.contentType).toBe("text/html");
    expect(result.url).toBe("https://example.com/a");
  });

  it("sends the crawler user agent and the requested accept header", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => mockResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await boundedFetch("https://example.com/a", {
      allowedOrigin: "https://example.com",
      accept: "application/xml"
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init).toBeDefined();
    expect((init.headers as Record<string, string>)["user-agent"]).toBe(USER_AGENT);
    expect((init.headers as Record<string, string>).accept).toBe("application/xml");
    expect(init.redirect).toBe("manual");
  });

  it("refuses a redirect that leaves the allowed origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse("", { status: 302, location: "https://evil.test/x" }))
    );

    await expect(
      boundedFetch("https://example.com/a", {
        allowedOrigin: "https://example.com",
        accept: "text/html"
      })
    ).rejects.toThrow(/outside the configured crawl origin/);
  });

  it("follows a same-origin redirect and reports the final url", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse("", { status: 301, location: "/b" }))
      .mockResolvedValueOnce(mockResponse("done"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await boundedFetch("https://example.com/a", {
      allowedOrigin: "https://example.com",
      accept: "text/html"
    });

    expect(result.body.toString("utf8")).toBe("done");
    expect(result.url).toBe("https://example.com/b");
  });

  it("rejects any redirect under the none policy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse("", { status: 301, location: "/b" }))
    );

    await expect(
      boundedFetch("https://example.com/a", {
        allowedOrigin: "https://example.com",
        accept: "text/plain",
        redirectPolicy: "none"
      })
    ).rejects.toThrow(/Refusing to follow a redirect/);
  });

  it("gives up on a redirect loop after exactly maxRedirects hops", async () => {
    const fetchMock = vi.fn(async () => mockResponse("", { status: 302, location: "/a" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      boundedFetch("https://example.com/a", {
        allowedOrigin: "https://example.com",
        accept: "text/html",
        maxRedirects: 2
      })
    ).rejects.toThrow(/Too many redirects/);

    // maxRedirects: 2 means two redirects followed, so three requests issued.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("abandons a body partway rather than buffering it whole", async () => {
    // Ten 40-byte chunks against a 100-byte cap. Counting pulls is the point:
    // an implementation that buffered all ten and only then compared sizes
    // would satisfy the thrown error but not the memory bound it exists for.
    let pulls = 0;
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls > 10) {
              controller.close();
              return;
            }
            controller.enqueue(new Uint8Array(40));
          },
          cancel() {
            cancelled = true;
          }
        });
        return new Response(stream, { status: 200 });
      })
    );

    await expect(
      boundedFetch("https://example.com/a", {
        allowedOrigin: "https://example.com",
        accept: "text/html",
        maxBytes: 100
      })
    ).rejects.toThrow(/exceeds 100 bytes/);

    expect(pulls).toBeLessThanOrEqual(4);
    expect(cancelled).toBe(true);
  });

  it("times out a server that sends headers then stalls the body", async () => {
    // The timer must stay armed through the body read; clearing it once
    // headers arrived would let this hang forever.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(10));
            init.signal?.addEventListener("abort", () => {
              controller.error(new Error("aborted"));
            });
            // Never closes: the body trickles and then stops.
          }
        });
        return new Response(stream, { status: 200 });
      })
    );

    const error = await boundedFetch("https://example.com/a", {
      allowedOrigin: "https://example.com",
      accept: "text/html",
      timeoutMs: 25
    }).catch((e: unknown) => e);

    expect((error as BoundedFetchError).kind).toBe("timeout");
  });

  it("rejects an honestly declared oversized body before reading it", async () => {
    const headers = new Headers({ "content-length": String(DEFAULT_MAX_RESPONSE_BYTES + 1) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 200, headers })));

    await expect(
      boundedFetch("https://example.com/a", {
        allowedOrigin: "https://example.com",
        accept: "text/html"
      })
    ).rejects.toThrow(/exceeds/);
  });

  it("throws on a non-success status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse("", { status: 503 })));

    await expect(
      boundedFetch("https://example.com/a", {
        allowedOrigin: "https://example.com",
        accept: "text/html"
      })
    ).rejects.toThrow(/503/);
  });

  it("aborts a request that outlives its deadline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })
      )
    );

    await expect(
      boundedFetch("https://example.com/a", {
        allowedOrigin: "https://example.com",
        accept: "text/html",
        timeoutMs: 10
      })
    ).rejects.toThrow(/Timed out after 10ms/);
  });

  it("classifies a timeout apart from a transport fault", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })
      )
    );

    const error = await boundedFetch("https://example.com/a", {
      allowedOrigin: "https://example.com",
      accept: "text/html",
      timeoutMs: 10
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BoundedFetchError);
    expect((error as BoundedFetchError).kind).toBe("timeout");
  });

  it("classifies a DNS or connection failure as network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );

    const error = await boundedFetch("https://example.com/a", {
      allowedOrigin: "https://example.com",
      accept: "text/html"
    }).catch((e: unknown) => e);

    expect((error as BoundedFetchError).kind).toBe("network");
    expect((error as BoundedFetchError).status).toBeUndefined();
  });

  it("reports the http status so a caller can tell 404 from 5xx", async () => {
    // This is the distinction robots.txt handling depends on: a missing file is
    // "no rules published", a 5xx is "policy unknown" and must fail closed.
    for (const status of [404, 503]) {
      vi.stubGlobal("fetch", vi.fn(async () => mockResponse("", { status })));

      const error = await boundedFetch("https://example.com/robots.txt", {
        allowedOrigin: "https://example.com",
        accept: "text/plain"
      }).catch((e: unknown) => e);

      expect((error as BoundedFetchError).kind).toBe("http");
      expect((error as BoundedFetchError).status).toBe(status);
    }
  });

  it("marks an oversized body and a policy refusal with distinct kinds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse(Buffer.alloc(400, 0x61), { chunkSize: 40 }))
    );
    const tooLarge = await boundedFetch("https://example.com/a", {
      allowedOrigin: "https://example.com",
      accept: "text/html",
      maxBytes: 100
    }).catch((e: unknown) => e);
    expect((tooLarge as BoundedFetchError).kind).toBe("too-large");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse("", { status: 302, location: "https://evil.test/x" }))
    );
    const offOrigin = await boundedFetch("https://example.com/a", {
      allowedOrigin: "https://example.com",
      accept: "text/html"
    }).catch((e: unknown) => e);
    expect((offOrigin as BoundedFetchError).kind).toBe("policy");
  });

  it("refuses a non-http scheme whose origin passes the origin check", async () => {
    // A file: URL has origin "null", so passing "null" as the allowed origin is
    // what actually gets execution as far as the scheme guard. Asserting the
    // permissive "either message" would have let the origin check satisfy this.
    const error = await boundedFetch("file:///etc/passwd", {
      allowedOrigin: "null",
      accept: "text/plain"
    }).catch((e: unknown) => e);

    expect((error as BoundedFetchError).kind).toBe("policy");
    expect((error as Error).message).toMatch(/Unsupported scheme file:/);
  });

  it("classifies an unparseable redirect target rather than leaking a TypeError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse("", { status: 302, location: "http://[" }))
    );

    const error = await boundedFetch("https://example.com/a", {
      allowedOrigin: "https://example.com",
      accept: "text/html"
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BoundedFetchError);
    expect((error as BoundedFetchError).kind).toBe("malformed-url");
  });

  it("rejects a disallowed content type before reading the body", async () => {
    // The build discovery loader deliberately skips non-HTML links. It must be
    // able to do so without a huge or stalling PDF becoming a run failure.
    // A ReadableStream pulls once on its own to fill its internal queue, so
    // counting pulls would measure the stream, not us. Cancellation without a
    // reader ever being taken is the real evidence the body went unread.
    let cancelled = false;
    let readerTaken = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(10));
          },
          cancel() {
            cancelled = true;
          }
        });
        const body = new Proxy(stream, {
          get(target, prop, receiver) {
            if (prop === "getReader") readerTaken = true;
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
        return new Response(body as ReadableStream<Uint8Array>, {
          status: 200,
          headers: new Headers({ "content-type": "application/pdf" })
        });
      })
    );

    const error = await boundedFetch("https://example.com/doc.pdf", {
      allowedOrigin: "https://example.com",
      accept: "text/html",
      allowedContentTypes: ["text/html", "application/xhtml+xml"]
    }).catch((e: unknown) => e);

    expect((error as BoundedFetchError).kind).toBe("content-type");
    expect((error as BoundedFetchError).contentType).toBe("application/pdf");
    expect(readerTaken).toBe(false);
    expect(cancelled).toBe(true);
  });

  it("keeps the http status when discarding a body that errors on cancel", async () => {
    // Cleanup must never overwrite an already-diagnosed failure.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          cancel() {
            throw new Error("cancel exploded");
          }
        });
        return new Response(stream, { status: 404 });
      })
    );

    const error = await boundedFetch("https://example.com/robots.txt", {
      allowedOrigin: "https://example.com",
      accept: "text/plain"
    }).catch((e: unknown) => e);

    expect((error as BoundedFetchError).kind).toBe("http");
    expect((error as BoundedFetchError).status).toBe(404);
  });
});
