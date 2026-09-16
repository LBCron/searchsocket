import type { ScoreBreakdown, SearchResponse, SearchResult, SearchResultChunk } from "../types";

/**
 * Shared response validation for the two browser entry points.
 *
 * The wire is untyped, so a cast is a promise, not a check. A JSON `null` body,
 * an error page that happened to parse, or `results: null` from a custom
 * endpoint would otherwise reach the caller as a valid-looking empty response —
 * indistinguishable from "no matches".
 *
 * Hand-written rather than a `zod` schema on purpose: both callers are browser
 * code, and `src/svelte/` ships as raw source, so anything imported here lands
 * in the consumer's bundle.
 *
 * It lives under `src/svelte/` because that is the only source directory the
 * published tarball carries whole (`files` in package.json publishes `dist`,
 * `src/svelte`, `src/types.ts` and `src/utils/structured-meta.ts` — nothing
 * else). `src/client.ts` is bundled into `dist/` by tsup, so it can import from
 * here; `src/svelte/index.svelte.ts` is not bundled and can only import files
 * that actually ship. Anywhere else would resolve in this repo and break at
 * install time for a real consumer of `searchsocket/svelte`.
 *
 * Every field the type declares as required is checked; an optional one only
 * has to be the right type when it is present.
 */

/** `typeof NaN` and `typeof Infinity` are both "number"; neither is a score. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

// Browsers strip tab, newline and carriage return from a URL before parsing it,
// so a scheme split across a newline still navigates. No legitimate result URL
// carries a control character, so the whole Unicode control category (C0, DEL
// and C1) is refused rather than normalised away and re-checked.
const CONTROL_CHARACTERS = /\p{Cc}/u;
const LEADING_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/;
const NAVIGABLE_SCHEMES = new Set(["http", "https"]);
// Only ever used to resolve a relative URL far enough to parse it. It never
// reaches a caller, and the hostname is reserved so a leak could not resolve.
const PARSE_BASE = "http://searchsocket.invalid/";

/**
 * Whether a result URL is safe to render as an `href` or hand to a router.
 *
 * Accepts ordinary site URLs — relative paths, query-only and hash-only
 * targets, protocol-relative URLs, and absolute `http:`/`https:` — and refuses
 * everything that can execute, including `javascript:`, `data:`, `vbscript:`
 * and `file:`, plus anything the URL parser cannot make sense of. A string
 * check is not a safe-link check: the type of a URL says nothing about where
 * it goes.
 */
export function isSafeResultUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (CONTROL_CHARACTERS.test(value)) return false;

  // `trim()` covers every code point a browser would ignore in front of the
  // scheme, so a leading-whitespace disguise cannot slip past as a relative path.
  const trimmed = value.trim();
  if (!trimmed) return false;

  // A scheme is checked before parsing because the parser happily accepts
  // `javascript:`; no scheme at all is a relative URL ("/docs", "docs/x",
  // "?q=1", "#section") and is resolved against the base below.
  const scheme = LEADING_SCHEME.exec(trimmed);
  if (scheme && !NAVIGABLE_SCHEMES.has(scheme[1]!.toLowerCase())) return false;

  // "Looks like http" is not the same as "is a URL": `http://`, `https://[::1`
  // and `https://example.com:70000` all pass a scheme test and then fail to
  // parse. A target a router cannot resolve is malformed, not merely unusual.
  let parsed: URL;
  try {
    parsed = new URL(trimmed, PARSE_BASE);
  } catch {
    return false;
  }
  // The parser is the last word on the protocol — a spelling the scheme regex
  // read as relative must still end up on http(s) once resolved.
  return NAVIGABLE_SCHEMES.has(parsed.protocol.replace(/:$/, "").toLowerCase());
}

/**
 * `breakdown` only appears on a debug response, but it is the one remaining
 * field of the documented result shape that nothing checked — so `null`,
 * `"garbage"` and `{ baseScore: "wrong" }` all used to pass as a score
 * breakdown and blow up in whatever renders it.
 */
function isScoreBreakdown(value: unknown): value is ScoreBreakdown {
  if (typeof value !== "object" || value === null) return false;
  const breakdown = value as Partial<ScoreBreakdown>;
  if (breakdown.pageWeight !== undefined && !isFiniteNumber(breakdown.pageWeight)) return false;
  return (
    isFiniteNumber(breakdown.baseScore) &&
    isFiniteNumber(breakdown.incomingLinkBoost) &&
    isFiniteNumber(breakdown.depthBoost) &&
    isFiniteNumber(breakdown.titleMatchBoost) &&
    isFiniteNumber(breakdown.freshnessBoost) &&
    isFiniteNumber(breakdown.anchorTextMatchBoost)
  );
}

export function isSearchResultChunk(value: unknown): value is SearchResultChunk {
  if (typeof value !== "object" || value === null) return false;
  const chunk = value as Partial<SearchResultChunk>;
  // Every field the shipped UI reads off a chunk: the snippet and section title
  // are rendered, `headingPath` is iterated, and the score is compared.
  if (typeof chunk.snippet !== "string") return false;
  if (!isFiniteNumber(chunk.score)) return false;
  if (!isStringArray(chunk.headingPath)) return false;
  if (chunk.sectionTitle !== undefined && typeof chunk.sectionTitle !== "string") return false;
  if (chunk.chunkText !== undefined && typeof chunk.chunkText !== "string") return false;
  return true;
}

export function isSearchResult(value: unknown): value is SearchResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<SearchResult>;
  if (
    typeof result.title !== "string" ||
    typeof result.snippet !== "string" ||
    !isFiniteNumber(result.score)
  ) {
    return false;
  }
  // The URL is both a required string and a navigation target, so it is checked
  // as one here — a hostile row never reaches a template that might render it.
  if (!isSafeResultUrl(result.url)) return false;
  // An optional field may be absent, but a present one still has to be the
  // type it is read as: `sectionTitle` reaches string methods and `chunks` is
  // iterated.
  if (result.sectionTitle !== undefined && typeof result.sectionTitle !== "string") return false;
  if (result.chunkText !== undefined && typeof result.chunkText !== "string") return false;
  if (result.routeFile !== undefined && typeof result.routeFile !== "string") return false;
  if (result.chunks !== undefined) {
    if (!Array.isArray(result.chunks)) return false;
    if (!result.chunks.every(isSearchResultChunk)) return false;
  }
  if (result.breakdown !== undefined && !isScoreBreakdown(result.breakdown)) return false;
  return true;
}

export function isSearchResponse(payload: unknown): payload is SearchResponse {
  if (typeof payload !== "object" || payload === null) return false;
  const response = payload as Partial<SearchResponse>;
  if (typeof response.q !== "string" || typeof response.scope !== "string") return false;

  // `meta.timingsMs` is rendered ("12 results in 30ms"), so an object with the
  // wrong shape inside is a render-time failure, not a cosmetic one.
  const meta = response.meta as SearchResponse["meta"] | undefined;
  if (typeof meta !== "object" || meta === null) return false;
  const timings = meta.timingsMs as SearchResponse["meta"]["timingsMs"] | undefined;
  if (typeof timings !== "object" || timings === null) return false;
  if (!isFiniteNumber(timings.search) || !isFiniteNumber(timings.total)) return false;

  return Array.isArray(response.results) && response.results.every(isSearchResult);
}

/**
 * Pull the server's message out of a non-2xx body.
 *
 * Both entry points reached for `payload.error?.message` directly, where the
 * optional chain guards `error` but not `payload`: a non-2xx response whose
 * body is JSON `null` — or a bare string or number, which an upstream proxy or
 * a custom endpoint can easily return — threw a `TypeError` that surfaced in
 * place of the real failure. Falls back to the caller's default whenever the
 * body is not the documented `{ error: { message } }` envelope.
 */
export function errorMessageFrom(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return fallback;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message !== "" ? message : fallback;
}
