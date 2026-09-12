import type { SearchRequest, SearchResponse, SearchResult } from "./types";

/**
 * Build a URL for a search result that includes section metadata (`_ssk`) and
 * a text-target phrase (`_sskt`) plus a Text Fragment (`#:~:text=`). When the destination
 * page uses `searchsocketScrollToText`, `_sskt` (or `_ssk`) triggers a smooth
 * scroll on SvelteKit client-side navigations. For full page loads, browsers
 * that support Text Fragments will scroll natively.
 *
 * If no usable text target is available, the original URL is returned unchanged.
 */
const SNIPPET_TARGET_MAX_WORDS = 12;

function normalizeTargetText(value: string): string {
  return value
    .replace(/\u2026/g, " ")
    .replace(/\.{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shortenForTarget(value: string): string {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length <= SNIPPET_TARGET_MAX_WORDS) {
    return value;
  }
  return words.slice(0, SNIPPET_TARGET_MAX_WORDS).join(" ");
}

function selectTextTarget(result: SearchResult): string {
  const sectionTitle = normalizeTargetText(result.sectionTitle ?? "");
  const snippetCandidate = normalizeTargetText(result.chunks?.[0]?.snippet ?? result.snippet);

  // Prefer snippet text when it appears to be tied to the selected section.
  if (snippetCandidate) {
    if (!sectionTitle || snippetCandidate.toLowerCase().includes(sectionTitle.toLowerCase())) {
      return shortenForTarget(snippetCandidate);
    }
  }

  return sectionTitle;
}

export function buildResultUrl(result: SearchResult): string {
  const textTarget = selectTextTarget(result);
  if (!textTarget) {
    return result.url;
  }

  // Split the URL preserving its original form (relative, absolute, etc.)
  const hashIdx = result.url.indexOf("#");
  const beforeHash = hashIdx >= 0 ? result.url.slice(0, hashIdx) : result.url;
  const existingHash = hashIdx >= 0 ? result.url.slice(hashIdx) : "";

  const queryIdx = beforeHash.indexOf("?");
  const path = queryIdx >= 0 ? beforeHash.slice(0, queryIdx) : beforeHash;
  const existingQuery = queryIdx >= 0 ? beforeHash.slice(queryIdx + 1) : "";

  const params = new URLSearchParams(existingQuery);
  if (result.sectionTitle) {
    params.set("_ssk", result.sectionTitle);
  } else {
    params.delete("_ssk");
  }
  params.set("_sskt", textTarget);

  // Build a Text Fragment for native browser scroll-to-text support
  const textFragment = `:~:text=${encodeURIComponent(textTarget)}`;
  const hashWithoutTextFragment = existingHash.replace(/:~:text=.*$/u, "");
  const hash = existingHash
    ? `${hashWithoutTextFragment}${textFragment}`
    : `#${textFragment}`;

  return `${path}?${params.toString()}${hash}`;
}

export interface SearchClientOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The wire is untyped, so a cast is a promise, not a check. A JSON `null` body,
 * an error page that happened to parse, or `results: null` from a custom
 * endpoint would otherwise reach the caller as a valid-looking empty response —
 * indistinguishable from "no matches".
 *
 * Hand-written rather than a `zod` schema on purpose: this is a browser entry
 * point, and the store in `src/svelte/` needs the same check but ships as raw
 * source that cannot import from here. Every field the type declares as
 * required is checked; an optional one only has to be the right type when it is present.
 */
function isSearchResult(value: unknown): value is SearchResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<SearchResult>;
  if (
    typeof result.url !== "string" ||
    typeof result.title !== "string" ||
    typeof result.snippet !== "string" ||
    typeof result.score !== "number"
  ) {
    return false;
  }
  // An optional field may be absent, but a present one still has to be the
  // type it is read as: `sectionTitle` reaches string methods and `chunks` is
  // iterated.
  if (result.sectionTitle !== undefined && typeof result.sectionTitle !== "string") return false;
  if (result.chunks !== undefined) {
    if (!Array.isArray(result.chunks)) return false;
    if (!result.chunks.every((chunk) => typeof chunk === "object" && chunk !== null)) return false;
  }
  return true;
}

function isSearchResponse(payload: unknown): payload is SearchResponse {
  if (typeof payload !== "object" || payload === null) return false;
  const response = payload as Partial<SearchResponse>;
  return (
    typeof response.q === "string" &&
    typeof response.scope === "string" &&
    typeof response.meta === "object" &&
    response.meta !== null &&
    Array.isArray(response.results) &&
    response.results.every(isSearchResult)
  );
}

export function createSearchClient(options: SearchClientOptions = {}) {
  const endpoint = options.endpoint ?? "/api/search";
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async search(request: SearchRequest): Promise<SearchResponse> {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (!response.ok) {
          throw new Error("Search failed");
        }
        throw new Error("Invalid search response");
      }

      if (!response.ok) {
        const message = (payload as { error?: { message?: string } }).error?.message ?? "Search failed";
        throw new Error(message);
      }

      if (!isSearchResponse(payload)) {
        throw new Error("Invalid search response");
      }

      return payload;
    }
  };
}
