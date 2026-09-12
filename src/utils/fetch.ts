/**
 * Bounded HTTP fetching shared by every indexing-time network caller.
 *
 * Plain `fetch()` has no deadline, no size cap, and follows redirects anywhere.
 * Every one of those defaults is wrong for indexing: the URLs being fetched are
 * content the operator does not fully control, so a sitemap entry, a preview
 * route, or a robots endpoint can stall a run indefinitely, exhaust memory, or
 * redirect the crawl to an internal address and have the response indexed.
 */

/** Wall-clock limit for a single request, so a hung server cannot stall a run. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Largest response body accepted, so one huge document cannot exhaust memory. */
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
/** Redirect hops followed before giving up, so a redirect loop terminates. */
export const DEFAULT_MAX_REDIRECTS = 5;

export const USER_AGENT = "Searchsocket";

/**
 * Where a redirect is allowed to lead.
 *
 * `same-origin` confines the whole hop chain to `allowedOrigin` — the right
 * policy for crawling a site's own content. `none` rejects any redirect, for
 * callers that address a single known endpoint and should notice when it moves.
 */
export type RedirectPolicy = "same-origin" | "none";

export interface BoundedFetchOptions {
  /** Origin every request in the redirect chain must belong to. */
  allowedOrigin: string;
  /** Accept header sent with the request. */
  accept: string;
  redirectPolicy?: RedirectPolicy;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /**
   * Media types this caller is willing to read, checked before the body is
   * touched. A caller that deliberately skips non-HTML links needs to reject
   * them here: reading first means a linked PDF that stalls or blows the size
   * cap becomes a load *failure* — which marks the whole run incomplete — when
   * it should have been an uneventful skip.
   */
  allowedContentTypes?: string[];
}

export interface BoundedResponse {
  body: Buffer;
  contentType: string;
  /** Final URL after any redirects, so callers can resolve relative links. */
  url: string;
}

/**
 * Why a bounded fetch gave up.
 *
 * Callers need this to decide whether a failure is benign. A robots.txt fetcher
 * must treat `http` 404 as "this site publishes no rules" and carry on, but
 * treat `http` 5xx, `timeout`, or `network` as "the policy is unknown" and fail
 * closed — indexing pages that a readable robots.txt might have excluded is the
 * one outcome that cannot be undone by a later run.
 */
export type BoundedFetchFailure =
  | "http"
  | "timeout"
  | "network"
  | "policy"
  | "too-large"
  | "content-type"
  | "malformed-url";

export class BoundedFetchError extends Error {
  readonly kind: BoundedFetchFailure;
  /** HTTP status, set whenever the failure came from an actual response. */
  readonly status?: number;
  /** Response content type, set when `kind` is `"content-type"`. */
  readonly contentType?: string;
  readonly url: string;

  constructor(
    message: string,
    kind: BoundedFetchFailure,
    url: string,
    extra: { status?: number; contentType?: string } = {}
  ) {
    super(message);
    this.name = "BoundedFetchError";
    this.kind = kind;
    this.url = url;
    this.status = extra.status;
    this.contentType = extra.contentType;
  }
}

/**
 * Discard a body we are not going to read.
 *
 * Always best effort: a cancel that rejects must never replace the HTTP status
 * or size violation we already diagnosed with an opaque cleanup error.
 */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

/**
 * Read a response body, aborting as soon as it exceeds the size cap.
 *
 * Buffering the whole body first and checking afterwards means an unbounded
 * response is fully allocated before it is rejected.
 */
async function readBounded(response: Response, url: string, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.from(await response.arrayBuffer());

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new BoundedFetchError(`Response from ${url} exceeds ${maxBytes} bytes`, "too-large", url);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    await response.body.cancel().catch(() => {});
  }

  return Buffer.concat(chunks, total);
}

/**
 * Fetch with a timeout, a size cap, and an explicit redirect policy.
 *
 * Throws on a non-2xx status, an oversized body, a disallowed redirect, or a
 * timeout. Callers decide whether that failure is fatal to the run — a fetch
 * helper cannot know whether an unreachable URL means "skip this page" or
 * "stop before deleting anything".
 */
export async function boundedFetch(
  url: string,
  options: BoundedFetchOptions
): Promise<BoundedResponse> {
  const {
    allowedOrigin,
    accept,
    redirectPolicy = "same-origin",
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    allowedContentTypes
  } = options;

  let current = url;

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    let target: URL;
    try {
      target = new URL(current);
    } catch {
      throw new BoundedFetchError(`Cannot parse URL ${current}`, "malformed-url", current);
    }
    if (target.origin !== allowedOrigin) {
      throw new BoundedFetchError(
        `Refusing to fetch ${target.origin}: outside the configured crawl origin`,
        "policy",
        current
      );
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new BoundedFetchError(`Unsupported scheme ${target.protocol}`, "policy", current);
    }

    const controller = new AbortController();
    // The timer stays armed until the body has been read. Clearing it as soon
    // as headers arrived meant a server could answer within the timeout and
    // then trickle the body forever, stalling the run indefinitely.
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": USER_AGENT, accept }
        });
      } catch (cause) {
        // The abort we armed above and a DNS/connection failure both surface
        // here. Callers deciding whether to fail closed need them apart.
        if (controller.signal.aborted) {
          throw new BoundedFetchError(
            `Timed out after ${timeoutMs}ms fetching ${current}`,
            "timeout",
            current
          );
        }
        throw new BoundedFetchError(
          `Network failure fetching ${current}: ${(cause as Error).message}`,
          "network",
          current
        );
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        // Discard the redirect body rather than leaving the socket open.
        await discard(response);
        if (redirectPolicy === "none") {
          throw new BoundedFetchError(`Refusing to follow a redirect from ${current}`, "policy", current, {
            status: response.status
          });
        }
        if (!location) {
          throw new BoundedFetchError(`Redirect from ${current} had no Location header`, "http", current, {
            status: response.status
          });
        }
        try {
          current = new URL(location, current).href;
        } catch {
          // A server-supplied Location is untrusted input like any other.
          throw new BoundedFetchError(
            `Redirect from ${current} had an unparseable Location: ${location}`,
            "malformed-url",
            current,
            { status: response.status }
          );
        }
        continue;
      }

      if (!response.ok) {
        await discard(response);
        throw new BoundedFetchError(
          `Failed to fetch ${current}: ${response.status} ${response.statusText}`,
          "http",
          current,
          { status: response.status }
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (allowedContentTypes) {
        const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
        if (!allowedContentTypes.includes(mediaType)) {
          // Rejected before the body is read, so an unwanted 200 MB PDF costs
          // one set of headers rather than the size cap.
          await discard(response);
          throw new BoundedFetchError(
            `Response from ${current} has content type ${mediaType || "(none)"}`,
            "content-type",
            current,
            { status: response.status, contentType }
          );
        }
      }

      // An early rejection for honest servers only; Content-Length is supplied
      // by the peer and may be absent or wrong, so it is not the real bound.
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > maxBytes) {
        await discard(response);
        throw new BoundedFetchError(`Response from ${current} exceeds ${maxBytes} bytes`, "too-large", current, {
          status: response.status
        });
      }

      let body: Buffer;
      try {
        body = await readBounded(response, current, maxBytes);
      } catch (cause) {
        if (cause instanceof BoundedFetchError) throw cause;
        // A body that stalls past the deadline aborts mid-read, which is a
        // timeout rather than a transport fault even though it lands here.
        if (controller.signal.aborted) {
          throw new BoundedFetchError(
            `Timed out after ${timeoutMs}ms reading ${current}`,
            "timeout",
            current
          );
        }
        throw new BoundedFetchError(
          `Failed reading ${current}: ${(cause as Error).message}`,
          "network",
          current
        );
      }

      return { body, contentType, url: current };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new BoundedFetchError(`Too many redirects fetching ${url}`, "policy", url);
}
