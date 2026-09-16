import fs from "node:fs/promises";
import nodePath from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createDefaultConfig } from "../config/defaults";
import { loadConfig, mergeConfig } from "../config/load";
import { Logger } from "../core/logger";
import { isServerless } from "../core/serverless";
import { SearchSocketError, toErrorPayload } from "../errors";
import { createServer as createMcpServer, verifyApiKey } from "../mcp/server";
import { SearchEngine } from "../search/engine";
import { toPublicPage, toPublicResults } from "../utils/redact";
import type { ResolvedSearchSocketConfig, SearchRequest, SearchSocketConfig } from "../types";

interface RateBucket {
  count: number;
  resetAt: number;
}

/**
 * Ceiling on distinct client keys the optional in-memory limiter will track.
 * 10k buckets is a few hundred kilobytes — enough that a real site never hits
 * it, small enough that a flood of unique addresses cannot grow without bound.
 */
const DEFAULT_MAX_RATE_LIMIT_BUCKETS = 10_000;

/**
 * Per-process request counter for non-serverless deployments.
 *
 * Buckets used to be replaced only when the *same* key came back, so a one-time
 * visitor's window stayed in the map for the life of the process. Expiry is now
 * swept once a window and the map has a hard ceiling, because this thing lives
 * inside a long-running Node server that never gets a chance to forget.
 *
 * Deliberately timer-free: a `setInterval` here would hold the event loop open
 * and would be dead weight on the serverless deployments where the limiter is
 * disabled anyway.
 *
 * Exported for tests only — `src/sveltekit.ts` does not re-export it, so it is
 * not part of the package's public surface.
 */
export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly maxBuckets: number;
  private lastSweepAt = Date.now();

  constructor(private readonly windowMs: number, private readonly max: number, maxBuckets?: number) {
    // A non-positive or non-finite ceiling would disable eviction entirely
    // (every comparison against NaN is false), which is the one thing this
    // class exists to prevent.
    this.maxBuckets =
      typeof maxBuckets === "number" && Number.isFinite(maxBuckets) && maxBuckets >= 1
        ? Math.floor(maxBuckets)
        : DEFAULT_MAX_RATE_LIMIT_BUCKETS;
  }

  check(key: string): boolean {
    const now = Date.now();

    if (now - this.lastSweepAt >= this.windowMs) {
      this.sweep(now);
    }

    const existing = this.buckets.get(key);

    if (existing && existing.resetAt > now) {
      if (existing.count >= this.max) {
        return false;
      }

      existing.count += 1;
      return true;
    }

    if (existing) {
      // Re-`set` on an existing key keeps its original position, which would
      // leave a freshly started window sitting at the head of the eviction
      // order. Delete first so insertion order stays window-start order.
      this.buckets.delete(key);
    } else {
      this.makeRoom();
    }

    this.buckets.set(key, {
      count: 1,
      resetAt: now + this.windowMs
    });
    return true;
  }

  /** Test/introspection hook: how many client windows are currently held. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Whole seconds until this key's window resets, for `Retry-After`.
   *
   * The limiter already knows when it will forgive a caller; a 429 that does
   * not say so leaves a well-behaved client guessing. Read-only — it must not
   * disturb the window `check` just consumed.
   */
  retryAfterSeconds(key: string): number | undefined {
    const bucket = this.buckets.get(key);
    if (!bucket) return undefined;

    const remaining = bucket.resetAt - Date.now();
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  private sweep(now: number): void {
    this.lastSweepAt = now;

    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }

  private makeRoom(): void {
    // A Map iterates in insertion order and `check` keeps that order equal to
    // window-start order, so the head is the oldest window — already expired if
    // anything in the map is. Dropping from the head therefore reclaims dead
    // buckets before live ones without scanning, which matters because this
    // runs on every new client once the map is full. Evicting a live window
    // hands that client a fresh allowance: the honest trade for refusing to
    // grow, and why this limiter is best-effort rather than authoritative.
    while (this.buckets.size >= this.maxBuckets) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
    }
  }
}

export interface SearchSocketHandleOptions {
  configPath?: string;
  cwd?: string;
  path?: string;
  maxBodyBytes?: number;
  /** Ceiling on tracked clients for the optional in-memory rate limiter. */
  maxRateLimitBuckets?: number;
  config?: ResolvedSearchSocketConfig;
  rawConfig?: SearchSocketConfig;
}

/**
 * The route this hook owns when the deployment does not name one. Taken from
 * the packaged defaults rather than spelled out again, so the path the hook
 * claims before the config loads cannot drift from the path the resolved
 * config would have given it.
 */
const DEFAULT_API_PATH = createDefaultConfig("searchsocket").api.path;

export function searchsocketHandle(options: SearchSocketHandleOptions = {}) {
  let enginePromise: Promise<SearchEngine> | null = null;
  let configPromise: Promise<ResolvedSearchSocketConfig> | null = null;
  // A config supplied inline already names its own api path, so ownership is
  // exact from the first request rather than falling back to the packaged
  // default. A path that only a disk load would reveal stays unknowable until
  // that load succeeds; deployments that move the route should pass
  // `options.path` so the hook can claim it even when the config is broken.
  let apiPath = options.path ?? options.config?.api.path ?? options.rawConfig?.api?.path;
  let llmsServePath: string | null = null;
  let serveMarkdownVariants = false;
  let mcpPath: string | undefined;
  let mcpApiKey: string | undefined;
  let mcpAccess: "public" | "private" = "private";
  let mcpEnableJsonResponse = true;
  let rateLimiter: InMemoryRateLimiter | null = null;
  let notConfigured = false;
  let configFailureLogged = false;
  const logger = new Logger({ stderrOnly: true });

  const getConfig = async (): Promise<ResolvedSearchSocketConfig> => {
    if (!configPromise) {
      let configP: Promise<ResolvedSearchSocketConfig>;

      if (options.config) {
        configP = Promise.resolve(options.config);
      } else if (options.rawConfig) {
        const cwd = options.cwd ?? process.cwd();
        configP = Promise.resolve(mergeConfig(cwd, options.rawConfig));
      } else {
        configP = loadConfig({
          cwd: options.cwd,
          configPath: options.configPath
        });
      }

      const tracked: Promise<ResolvedSearchSocketConfig> = configP.then((config) => {
        apiPath = apiPath ?? config.api.path;
        // `mcp.enable` was documented as the switch for this endpoint but was
        // never read, so the MCP route was mounted regardless — including on
        // deployments that had deliberately turned it off.
        mcpPath = config.mcp.enable ? config.mcp.handle.path : undefined;
        mcpApiKey =
          config.mcp.handle.apiKey ??
          (config.mcp.handle.apiKeyEnv ? process.env[config.mcp.handle.apiKeyEnv] : undefined);
        // `options.config` is handed through unmerged, so a config object built
        // before this field existed arrives with `access` undefined. Only an
        // exact "public" opts in; anything else stays private.
        mcpAccess = config.mcp.handle.access === "public" ? "public" : "private";
        mcpEnableJsonResponse = config.mcp.handle.enableJsonResponse;

        if (config.llmsTxt.enable) {
          llmsServePath = "/" + config.llmsTxt.outputPath.replace(/^static\//, "");
          serveMarkdownVariants = config.llmsTxt.serveMarkdownVariants;
        }

        if (config.api.rateLimit && !isServerless()) {
          rateLimiter = new InMemoryRateLimiter(
            config.api.rateLimit.windowMs,
            config.api.rateLimit.max,
            options.maxRateLimitBuckets
          );
        }

        return config;
      });

      // A rejected load must not be memoized for the life of the process: the
      // usual causes are transient (a config file not deployed yet, a source
      // directory the next build creates), and the site would stay dark until
      // it restarted. `getEngine` below already resets itself this way.
      const retryable: Promise<ResolvedSearchSocketConfig> = tracked.catch((error) => {
        // Guarded on identity so a later attempt already in flight is not
        // discarded by an older one failing.
        if (configPromise === retryable) configPromise = null;
        throw error;
      });

      configPromise = retryable;
      return retryable;
    }

    return configPromise;
  };

  const getEngine = async (): Promise<SearchEngine> => {
    if (notConfigured) {
      throw new SearchSocketError(
        "SEARCH_NOT_CONFIGURED",
        "Search is not configured. Set the required Upstash environment variables to enable search.",
        503
      );
    }

    if (!enginePromise) {
      const config = await getConfig();
      enginePromise = SearchEngine.create({
        cwd: options.cwd,
        config
      }).catch((error) => {
        enginePromise = null;
        if (error instanceof SearchSocketError && error.code === "VECTOR_BACKEND_UNAVAILABLE") {
          notConfigured = true;
          throw new SearchSocketError(
            "SEARCH_NOT_CONFIGURED",
            "Search is not configured. Set the required Upstash environment variables to enable search.",
            503
          );
        }
        throw error;
      });
    }

    return enginePromise;
  };

  const bodyLimit = options.maxBodyBytes ?? 64 * 1024;

  return async ({ event, resolve }: { event: any; resolve: (event: any) => Promise<Response> }) => {
    const pathname: string = event.url.pathname;
    const method: string = event.request.method;

    // Ownership of the search API is decided from `options.path` or the
    // packaged default, so it is known before any configuration is loaded.
    // This is what keeps a broken config search-scoped: the hook runs in front
    // of the entire application, and it used to await `getConfig()` on the way
    // to *every* route, so a project whose config could not be resolved lost
    // `GET /` along with its search endpoint.
    const ownsSearchPath = isApiPath(pathname, apiPath ?? DEFAULT_API_PATH);

    let config: ResolvedSearchSocketConfig;
    try {
      config = await getConfig();
    } catch (error) {
      if (!configFailureLogged) {
        configFailureLogged = true;
        logger.warn(
          `SearchSocket config could not be loaded; search routes will report unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      // Every other route — including MCP and markdown variants, whose paths
      // are only knowable from a config — belongs to the application.
      if (!ownsSearchPath) {
        return resolve(event);
      }

      return searchUnavailableResponse();
    }

    // Serve llms.txt if enabled and the file exists
    if (llmsServePath && method === "GET" && pathname === llmsServePath) {
      const cwd = options.cwd ?? process.cwd();
      const filePath = nodePath.resolve(cwd, config.llmsTxt.outputPath);
      try {
        const content = await fs.readFile(filePath, "utf8");
        return new Response(content, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      } catch {
        return resolve(event);
      }
    }

    const targetPath = apiPath ?? config.api.path;
    const isMcpRoute = mcpPath !== undefined && pathname === mcpPath;
    const isMarkdownVariant = serveMarkdownVariants && method === "GET" && pathname.endsWith(".md");
    const isApiRoute = isApiPath(pathname, targetPath);

    if (!isMcpRoute && !isMarkdownVariant && !isApiRoute) {
      return resolve(event);
    }

    // Preflights are cheap and must succeed for the limited request that
    // follows to be judged on its own, so they stay ahead of the limiter.
    if (method === "OPTIONS" && isApiRoute && !isMcpRoute) {
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(event.request, config)
      });
    }

    // The optional in-memory limiter now covers every route this hook answers
    // itself — the browser API, the MCP endpoint and the markdown variants —
    // because all three can make an anonymous caller's request turn into
    // backend retrieval work. Previously it guarded the browser API alone, so
    // the two surfaces that are reachable without a key were the two that were
    // not counted.
    //
    // `llms.txt` is deliberately left out: it is one static file read, no more
    // expensive than any asset the application already serves, and it exists
    // precisely so that crawlers and agents fetch it.
    //
    // The markdown surface is counted before we know whether the page is
    // indexed, so a `.md` route the application serves itself can be refused
    // once the limit is reached. That is the deliberate trade: with
    // `serveMarkdownVariants` on, every `.md` GET already costs an engine
    // lookup, and leaving the one anonymous surface that does retrieval work
    // uncounted is worse than occasionally 429-ing a shared path.
    const limitedKey = rateLimiter ? clientKey(event) : undefined;
    if (rateLimiter && limitedKey !== undefined && !rateLimiter.check(limitedKey)) {
      const retryAfter = rateLimiter.retryAfterSeconds(limitedKey);
      const retryHeader: Record<string, string> =
        retryAfter === undefined ? {} : { "retry-after": String(retryAfter) };

      if (isMcpRoute) {
        return mcpErrorResponse(429, -32000, "Rate limit exceeded", retryHeader);
      }

      const headers: Record<string, string> = {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...retryHeader
      };

      return withCors(
        new Response(
          JSON.stringify(toErrorPayload(new SearchSocketError("RATE_LIMITED", "Rate limit exceeded", 429))),
          {
            status: 429,
            headers
          }
        ),
        event.request,
        config
      );
    }

    // Serve markdown variant of indexed pages (e.g. /docs/api.md → markdown for /docs/api)
    if (isMarkdownVariant) {
      let rawPath: string;
      try {
        rawPath = decodeURIComponent(pathname.slice(0, -3));
      } catch {
        return resolve(event);
      }
      let scope: string | undefined;
      try {
        scope = resolveRequestedScope(event.url.searchParams?.get("scope"), config);
      } catch {
        return resolve(event);
      }
      try {
        const engine = await getEngine();
        const page = await engine.getPage(rawPath, scope);
        return new Response(page.markdown, {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8" }
        });
      } catch (error) {
        if (error instanceof SearchSocketError && error.status === 404) {
          return resolve(event);
        }
        throw error;
      }
    }

    // MCP endpoint handling
    if (isMcpRoute) {
      return handleMcpRequest(event, mcpAccess, mcpApiKey, mcpEnableJsonResponse, bodyLimit, getEngine);
    }

    const subPath = pathname.slice(targetPath.length); // "" | "/health" | "/pages/..."

    try {
      if (method === "GET") {
        if (subPath === "" || subPath === "/") {
          return await handleGetSearch(event, config, getEngine);
        }
        if (subPath === "/health") {
          return await handleGetHealth(event, config, getEngine);
        }
        if (subPath.startsWith("/pages/")) {
          return await handleGetPage(event, config, getEngine, subPath);
        }
        // Unknown GET sub-route
        return withCors(
          new Response(JSON.stringify(toErrorPayload(new SearchSocketError("INVALID_REQUEST", "Not found", 404))), {
            status: 404,
            headers: { "content-type": "application/json", "cache-control": "no-store" }
          }),
          event.request,
          config
        );
      }

      if (method === "POST" && (subPath === "" || subPath === "/")) {
        return await handlePostSearch(event, config, getEngine, bodyLimit);
      }

      // Unsupported method or sub-route
      return withCors(
        new Response(JSON.stringify(toErrorPayload(new SearchSocketError("INVALID_REQUEST", "Method not allowed", 405))), {
          status: 405,
          // RFC 9110 requires Allow on a 405.
          headers: { "content-type": "application/json", "cache-control": "no-store", allow: "GET, POST, OPTIONS" }
        }),
        event.request,
        config
      );
    } catch (error) {
      const payload = toErrorPayload(error);
      const status = error instanceof SearchSocketError ? error.status : 500;

      return withCors(
        new Response(JSON.stringify(payload), {
          status,
          // Error responses are as uncacheable as the success paths: a shared
          // cache holding a 403 or a 429 would hand it to the next caller.
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store"
          }
        }),
        event.request,
        config
      );
    }
  };
}


/**
 * Resolve the scope a browser request is permitted to search.
 *
 * A caller-supplied `?scope=` used to be passed through unchecked, so any
 * visitor could read a preview, staging, or unpublished branch scope simply by
 * naming it. A scope is now only honoured when the deployment explicitly lists
 * it in `api.allowedScopes`; otherwise the request gets the server's own scope.
 */
function resolveRequestedScope(
  requested: string | null | undefined,
  config: ResolvedSearchSocketConfig
): string | undefined {
  if (requested === null || requested === undefined || requested === "") return undefined;
  if (config.api.allowedScopes.includes(requested)) return requested;

  throw new SearchSocketError(
    "INVALID_REQUEST",
    `Scope "${requested}" is not selectable from this endpoint.`,
    403
  );
}

function isApiPath(pathname: string, apiPath: string): boolean {
  return pathname === apiPath || pathname.startsWith(apiPath + "/");
}

function clientKey(event: any): string {
  return (
    event.getClientAddress?.() ??
    event.request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/**
 * The answer a search route gives when the configuration could not be loaded.
 *
 * Fixed wording on purpose: a config failure carries filesystem paths and
 * environment-variable names, and this route is reachable anonymously. CORS
 * headers are omitted because the policy that would allow them lives in the
 * config we just failed to read.
 */
function searchUnavailableResponse(): Response {
  const failure = new SearchSocketError(
    "SEARCH_NOT_CONFIGURED",
    "Search is unavailable: the SearchSocket configuration could not be loaded.",
    503
  );

  return new Response(JSON.stringify(toErrorPayload(failure)), {
    status: 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

function mcpErrorResponse(
  status: number,
  code: number,
  message: string,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null
    }),
    { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders } }
  );
}

/**
 * Read a request body as JSON without ever holding more than `bodyLimit` bytes.
 *
 * A declared `Content-Length` is only a hint: it can be absent (chunked
 * transfer) or simply untrue, and both cases used to sail past the size check.
 * So the stream is pulled a chunk at a time and abandoned the moment the byte
 * count crosses the limit — the bytes already in flight are the most an
 * oversized request can cost us. Counting bytes rather than characters is what
 * lets a valid multi-byte UTF-8 body right up against the limit through.
 *
 * The fallback exists for request objects that expose no stream — SvelteKit
 * adapters and test doubles both produce them — where measuring after the fact
 * is the only option available.
 */
async function readBoundedJsonBody(request: any, bodyLimit: number): Promise<unknown> {
  const tooLarge = () => new SearchSocketError("INVALID_REQUEST", "Request body too large", 413);
  const malformed = () => new SearchSocketError("INVALID_REQUEST", "Malformed JSON request body", 400);

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
    throw tooLarge();
  }

  const stream: ReadableStream<Uint8Array> | null | undefined = request.body;

  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    let seen = 0;
    let text = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        seen += value.byteLength;
        if (seen > bodyLimit) {
          throw tooLarge();
        }

        text += decoder.decode(value, { stream: true });
      }

      text += decoder.decode();
    } finally {
      // Whether we finished, gave up on the size, or the client went away, the
      // stream is done with: cancel discards anything still queued and the
      // release lets the runtime tear the request down.
      try {
        await reader.cancel();
      } catch {
        // A stream that already errored or closed cannot be cancelled; nothing
        // to release in that case either.
      }
      try {
        reader.releaseLock();
      } catch {
        // Already released.
      }
    }

    try {
      return JSON.parse(text);
    } catch {
      throw malformed();
    }
  }

  if (typeof request.text === "function") {
    const rawBody: string = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > bodyLimit) {
      throw tooLarge();
    }

    try {
      return JSON.parse(rawBody);
    } catch {
      throw malformed();
    }
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw malformed();
    }
    throw error;
  }

  if (Buffer.byteLength(JSON.stringify(parsed) ?? "", "utf8") > bodyLimit) {
    throw tooLarge();
  }

  return parsed;
}

/**
 * Fields that retune ranking for a single request.
 *
 * `SearchEngine.search` honours `rankingOverrides` whenever `debug` is true, so
 * an anonymous POST used to be able to reweight the site's ranking for its own
 * request simply by naming them in the body. They stay on the engine's own API
 * — the CLI and the local playground call it directly — but the public HTTP
 * surface refuses them, present at all, on GET and POST alike.
 * Refusing the *field* rather than the enabled value is what makes the rule
 * unbypassable: `debug: false` with overrides attached is not a special case to
 * reason about, it is simply not accepted here.
 *
 * Exported for tests only — `src/sveltekit.ts` re-exports this module by name
 * and does not list it, so it is not part of the package's public surface. The
 * browser client strips the same fields before sending; the test that holds the
 * two lists together needs this one to be readable rather than retyped.
 */
export const PRIVILEGED_SEARCH_FIELDS = ["debug", "rankingOverrides"] as const;

function assertNoPrivilegedFields(has: (field: string) => boolean): void {
  for (const field of PRIVILEGED_SEARCH_FIELDS) {
    if (has(field)) {
      throw new SearchSocketError(
        "INVALID_REQUEST",
        `"${field}" is not accepted on this endpoint.`,
        403
      );
    }
  }
}

/**
 * Query parameters that carry exactly one value.
 *
 * `URLSearchParams.get` returns the first occurrence and silently drops the
 * rest, so `?topK=1&topK=99` was answered as `topK=1` with no policy behind it.
 * A repeat is now refused outright — equal or not — because the alternative is
 * a contract that depends on parser order. `tags` is deliberately absent: it is
 * the one parameter meant to repeat.
 */
const SINGLETON_SEARCH_PARAMS = ["q", "topK", "scope", "pathPrefix", "groupBy", "maxSubResults"] as const;

function assertSingletonParams(params: URLSearchParams, names: readonly string[]): void {
  for (const name of names) {
    if (params.getAll(name).length > 1) {
      throw new SearchSocketError(
        "INVALID_REQUEST",
        `Query parameter "${name}" may only be supplied once`,
        400
      );
    }
  }
}

/**
 * Bounds for the numeric query parameters.
 *
 * These mirror `requestSchema` in `src/search/engine.ts`, which re-validates
 * every request: the engine remains the contract, and this exists only so a
 * bad parameter is refused before any engine or backend work is done. Keep the
 * two in step.
 */
const NUMBER_PARAM_MAX = {
  topK: 100,
  maxSubResults: 20
} as const;

const NUMBER_PARAM_SCHEMAS = {
  topK: z.number().int().positive().max(NUMBER_PARAM_MAX.topK),
  maxSubResults: z.number().int().positive().max(NUMBER_PARAM_MAX.maxSubResults)
} as const;

/** A whole decimal integer and nothing else — no trailing text, no exponent, no radix prefix. */
const INTEGER_PARAM_PATTERN = /^[+-]?\d+$/;

/**
 * Parse a numeric query parameter as a whole value.
 *
 * `Number.parseInt` scans a prefix and stops at the first character it cannot
 * use, so `topK=10abc` was accepted as 10, `topK=1.5` as 1 and `topK=1e3` as 1
 * — every one of them a value the caller never asked for. (`0x10` parsed to 0
 * and was refused, but by the positivity check rather than on its merits.)
 * Anything that is not exactly an integer is now a 400.
 */
function parseNumberParam(name: keyof typeof NUMBER_PARAM_SCHEMAS, raw: string): number {
  const trimmed = raw.trim();
  const value = INTEGER_PARAM_PATTERN.test(trimmed) ? Number(trimmed) : Number.NaN;
  const parsed = NUMBER_PARAM_SCHEMAS[name].safeParse(value);

  if (!parsed.success) {
    throw new SearchSocketError(
      "INVALID_REQUEST",
      `${name} must be an integer between 1 and ${NUMBER_PARAM_MAX[name]}`,
      400
    );
  }

  return parsed.data;
}

async function handleGetSearch(
  event: any,
  config: ResolvedSearchSocketConfig,
  getEngine: () => Promise<SearchEngine>
): Promise<Response> {
  const params: URLSearchParams = event.url.searchParams;

  assertSingletonParams(params, SINGLETON_SEARCH_PARAMS);
  assertNoPrivilegedFields((field) => params.has(field));

  const q = params.get("q");

  if (!q || q.trim() === "") {
    throw new SearchSocketError("INVALID_REQUEST", "Missing required query parameter: q", 400);
  }

  const searchRequest: SearchRequest = { q };

  const topK = params.get("topK");
  if (topK !== null) {
    searchRequest.topK = parseNumberParam("topK", topK);
  }

  const scope = resolveRequestedScope(params.get("scope"), config);
  if (scope !== undefined) searchRequest.scope = scope;

  const pathPrefix = params.get("pathPrefix");
  if (pathPrefix !== null) searchRequest.pathPrefix = pathPrefix;

  const groupBy = params.get("groupBy");
  if (groupBy) {
    if (groupBy !== "page" && groupBy !== "chunk") {
      throw new SearchSocketError("INVALID_REQUEST", 'groupBy must be "page" or "chunk"', 400);
    }
    searchRequest.groupBy = groupBy;
  }

  const maxSubResults = params.get("maxSubResults");
  if (maxSubResults !== null) {
    searchRequest.maxSubResults = parseNumberParam("maxSubResults", maxSubResults);
  }

  const tags = params.getAll("tags");
  if (tags.length > 0) searchRequest.tags = tags;

  const engine = await getEngine();
  const result = await engine.search(searchRequest);

  return withCors(
    new Response(JSON.stringify({ ...result, results: toPublicResults(result.results, !config.api.exposeInternalFields) }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    }),
    event.request,
    config
  );
}

async function handleGetHealth(
  event: any,
  config: ResolvedSearchSocketConfig,
  getEngine: () => Promise<SearchEngine>
): Promise<Response> {
  const engine = await getEngine();

  // An unhealthy engine used to be reported as HTTP 200 with `ok: false`, so
  // every uptime check that watches status codes — which is most of them —
  // read an unreachable or unconfigured store as a healthy site. The body is
  // unchanged (and still the redacted one); only the status now tells the
  // truth. 503 matches the status `getEngine` already throws when the engine
  // cannot be created at all.
  const result = await engine.health();

  return withCors(
    new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    }),
    event.request,
    config
  );
}

async function handleGetPage(
  event: any,
  config: ResolvedSearchSocketConfig,
  getEngine: () => Promise<SearchEngine>,
  subPath: string
): Promise<Response> {
  const rawPath = subPath.slice("/pages".length); // includes leading "/"
  let pagePath: string;
  try {
    pagePath = decodeURIComponent(rawPath);
  } catch {
    throw new SearchSocketError("INVALID_REQUEST", "Malformed page path", 400);
  }

  // Same singleton policy as the search route: one `?scope=` or none.
  const pageParams: URLSearchParams | undefined = event.url.searchParams;
  if (pageParams) assertSingletonParams(pageParams, ["scope"]);

  const scope = resolveRequestedScope(pageParams?.get("scope"), config);
  const engine = await getEngine();
  const result = await engine.getPage(pagePath, scope);

  return withCors(
    new Response(JSON.stringify(toPublicPage(result, !config.api.exposeInternalFields)), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    }),
    event.request,
    config
  );
}

async function handlePostSearch(
  event: any,
  config: ResolvedSearchSocketConfig,
  getEngine: () => Promise<SearchEngine>,
  bodyLimit: number
): Promise<Response> {
  // Require a JSON content type. Without this the endpoint accepts a form
  // POST, which browsers send cross-origin without a preflight — so a CORS
  // policy that denies the origin never gets consulted.
  // The header must be present, not merely non-conflicting. Allowing an absent
  // Content-Type let a browser send JSON bytes as an ArrayBuffer body, which is
  // a simple cross-origin POST and never triggers a preflight — so the CORS
  // policy is not consulted at all.
  const contentType = event.request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new SearchSocketError(
      "INVALID_REQUEST",
      "Content-Type must be application/json",
      415
    );
  }

  // Bounded read: the body used to be buffered in full and only then measured,
  // so an oversized POST was allocated before it was refused.
  const body = await readBoundedJsonBody(event.request, bodyLimit);

  // Reject a non-object body before touching its fields. `null` is valid JSON,
  // and reading `.scope` off it threw a TypeError that surfaced as a 500 where
  // the schema would have produced a 400.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new SearchSocketError("INVALID_REQUEST", "Request body must be a JSON object", 400);
  }

  // `in`, not `Object.hasOwn`: zod reads inherited properties too, so an own-
  // property check would miss a body whose fields sit on a prototype. JSON can
  // never produce that shape — `{"__proto__": …}` parses to an ordinary own key
  // — but the guard should not depend on the adapter that handed us the body.
  assertNoPrivilegedFields((field) => field in body);

  const engine = await getEngine();
  const searchRequest = body as SearchRequest;
  // Same scope policy as GET: the body is no more trustworthy than the query
  // string, and previously a POST could name any scope it liked.
  const requestedScope = resolveRequestedScope(searchRequest.scope, config);
  if (requestedScope === undefined) delete searchRequest.scope;
  else searchRequest.scope = requestedScope;

  const result = await engine.search(searchRequest);

  return withCors(
    new Response(JSON.stringify({ ...result, results: toPublicResults(result.results, !config.api.exposeInternalFields) }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    }),
    event.request,
    config
  );
}

async function handleMcpRequest(
  event: any,
  access: "public" | "private",
  apiKey: string | undefined,
  enableJsonResponse: boolean,
  bodyLimit: number,
  getEngine: () => Promise<SearchEngine>
): Promise<Response> {
  const method = event.request.method;

  // Only POST is supported — reject GET (SSE streams) and DELETE (session teardown)
  // with 405 so MCP clients stop retrying.
  if (method === "GET") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "SSE transport is not supported. Use POST with Streamable HTTP."
        },
        id: null
      }),
      { status: 405, headers: { "content-type": "application/json", "cache-control": "no-store", allow: "POST" } }
    );
  }

  if (method === "DELETE") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Session management is not supported. This server is stateless."
        },
        id: null
      }),
      { status: 405, headers: { "content-type": "application/json", "cache-control": "no-store", allow: "POST" } }
    );
  }

  // MCP is a privileged surface: its tools return repository paths, a page's
  // indexed markdown, and any scope the caller names — none of which the browser API
  // discloses. It therefore fails closed unless the deployment says otherwise.
  // Previously the auth check was wrapped in `if (apiKey)`, so a deployment
  // that never configured a key — or whose `apiKeyEnv` was unset in production
  // — served all of that to anyone.
  //
  // `mcp.handle.access: "public"` is the deliberate opt-out: an anonymous
  // caller is served, but with the same fields stripped that the browser API
  // already withholds, so what it can reach is the site's published content and
  // nothing more.
  const isPublic = access === "public";


  if (!apiKey && !isPublic) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message:
            "MCP endpoint is not configured with an API key. Set mcp.handle.apiKey " +
            "(or mcp.handle.apiKeyEnv) to enable it, set mcp.handle.access: 'public' to serve " +
            "anonymous callers a redacted result set, or set mcp.enable: false to disable the route. " +
            "If the key is set and this still fails under `vite dev`: apiKeyEnv reads process.env, " +
            "which a SvelteKit dev server does not populate from .env. Pass it explicitly instead — " +
            "mcp.handle.apiKey: env.YOUR_KEY from $env/dynamic/private."
        },
        id: null
      }),
      { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } }
    );
  }

  const unauthorized = () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null
      }),
      { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" } }
    );

  // A caller that sent no Authorization header at all is anonymous. One that
  // sent a header is attempting to authenticate, so a wrong or malformed
  // credential is a 401 even under public access — a misconfigured editing
  // agent should be told its key is bad, not quietly downgraded to the public
  // result set and left wondering where `routeFile` went.
  const authHeader: string | null = event.request.headers.get("authorization");
  let isAnonymous = false;

  if (authHeader === null) {
    if (!isPublic) return unauthorized();
    isAnonymous = true;
  } else {
    if (!apiKey) return unauthorized();
    // The scheme name is case-insensitive and may be followed by more than one
    // space (RFC 7235 grammar is `1*SP`); the credential itself is neither, and
    // is compared byte-exact below.
    const bearer = /^Bearer +(.*)$/is.exec(authHeader);
    if (!bearer) return unauthorized();

    const token = bearer[1] ?? "";
    // `verifyApiKey` hashes both sides to equal-length digests before
    // comparing, so an attacker cannot learn the key's length from how long a
    // rejection takes — the previous inline length check leaked exactly that.
    if (token.length === 0 || !verifyApiKey(token, apiKey)) return unauthorized();
  }

  // Only now that the caller is entitled to the endpoint. Placing this before
  // the checks above turned a private deployment's 503 into a 413 and told an
  // unauthenticated caller the configured threshold.
  //
  // The transport used to own the body stream, so this could only bound the
  // *declared* length — a client that omitted content-length was not stopped at
  // all. The SDK accepts a pre-parsed body (`HandleRequestOptions.parsedBody`,
  // the same hook Express body-parser middleware uses), so we read the stream
  // ourselves under a hard byte ceiling and hand the parsed message on. The
  // transport still sees the original Request for its Accept, Content-Type,
  // session and protocol-version checks; it simply does not re-read the body.
  let parsedBody: unknown;
  // Deliberately the same loose substring test the transport applies, not the
  // stricter media-type parse `handlePostSearch` uses. Anything narrower leaves
  // a hole: a content type the transport accepts but we decline to pre-read
  // (`application/json-patch+json`, say) would go straight to `handleRequest`,
  // which reads the body itself and is bounded by nothing.
  const contentType = (event.request.headers.get("content-type") ?? "").toLowerCase();

  // A body the transport will not read either is left to it: it answers a
  // non-JSON content type with its own 415 before it looks at the body.
  if (method === "POST" && contentType.includes("application/json")) {
    try {
      parsedBody = await readBoundedJsonBody(event.request, bodyLimit);
    } catch (error) {
      if (error instanceof SearchSocketError && error.status === 413) {
        // Implementation-defined server error, as used by the 405s above. The
        // request is a structurally valid one, so -32600 would misreport it.
        return mcpErrorResponse(413, -32000, "Request body too large");
      }
      // Matches the transport's own wording for an unparseable body.
      return mcpErrorResponse(400, -32700, "Parse error: Invalid JSON");
    }
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse
  });

  let server: { close(): Promise<void> } | undefined;

  try {
    const engine = await getEngine();
    server = createMcpServer(engine, { redact: isAnonymous });

    await (server as ReturnType<typeof createMcpServer>).connect(transport);
    const response = await transport.handleRequest(
      event.request,
      parsedBody === undefined ? undefined : { parsedBody }
    );

    if (enableJsonResponse) {
      // JSON mode: response is complete, clean up immediately
      await transport.close();
      await server.close();
    }
    // SSE mode: response body is a ReadableStream — transport and server
    // will be garbage collected when the stream ends. Closing early would
    // terminate the stream before the client receives data.

    return response;
  } catch (error) {
    try { await transport.close(); } catch {}
    try { await server?.close(); } catch {}

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          // Not the raw exception: transport failures can surface internal
          // paths and configuration detail to the client.
          message: "Internal server error"
        },
        id: null
      }),
      { status: 500, headers: { "content-type": "application/json", "cache-control": "no-store" } }
    );
  }
}

function buildCorsHeaders(request: Request, config: ResolvedSearchSocketConfig): Record<string, string> {
  const allowOrigins = config.api.cors.allowOrigins;
  if (!allowOrigins || allowOrigins.length === 0) {
    return {};
  }

  const origin = request.headers.get("origin") ?? "";
  const allowed = allowOrigins.includes("*") || allowOrigins.includes(origin);

  if (!allowed) {
    return {};
  }

  const wildcard = allowOrigins.includes("*");
  return {
    "access-control-allow-origin": wildcard ? "*" : origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    // A CORS-filtered response hides every header but the safelisted ones, so
    // a cross-origin client could see the 429 but not the hint telling it when
    // to come back.
    "access-control-expose-headers": "retry-after",
    // Required when the origin is reflected: without it a shared cache can
    // serve one origin's allow-origin header to a different origin.
    ...(wildcard ? {} : { vary: "Origin" })
  };
}

function withCors(response: Response, request: Request, config: ResolvedSearchSocketConfig): Response {
  const corsHeaders = buildCorsHeaders(request, config);

  if (Object.keys(corsHeaders).length === 0) {
    return response;
  }

  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    merged.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged
  });
}
