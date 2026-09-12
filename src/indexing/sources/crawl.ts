import { gunzipSync } from "node:zlib";
import { load as cheerioLoad } from "cheerio";
import pLimit from "p-limit";
import { Logger } from "../../core/logger";
import type { PageSourceRecord, ResolvedSearchSocketConfig } from "../../types";
import { boundedFetch, DEFAULT_MAX_RESPONSE_BYTES } from "../../utils/fetch";
import { ensureLeadingSlash, joinUrl, normalizeUrlPath } from "../../utils/path";
import { applyMaxPages, sourceResult, type SourceFailure, type SourceLoadResult } from "./result";

const logger = new Logger();

function extractLocs(xml: string): string[] {
  const $ = cheerioLoad(xml, { xmlMode: true });
  const locs: string[] = [];
  $("loc").each((_i, el) => {
    const text = $(el).text().trim();
    if (text) {
      locs.push(text);
    }
  });
  return locs;
}

function isSitemapIndex(xml: string): boolean {
  const $ = cheerioLoad(xml, { xmlMode: true });
  return $("sitemapindex").length > 0;
}

/** Bounds a sitemap-index fan-out, including a maliciously deep or wide one. */
const MAX_SITEMAPS = 50;

async function fetchSitemapXml(url: string, allowedOrigin: string): Promise<string> {
  const { body } = await boundedFetch(url, {
    allowedOrigin,
    accept: "application/xml,text/xml"
  });

  if (url.endsWith(".gz")) {
    // Without an output cap a sub-10MB gzip sitemap can expand without bound.
    return gunzipSync(body, { maxOutputLength: DEFAULT_MAX_RESPONSE_BYTES }).toString("utf8");
  }

  return body.toString("utf8");
}

function resolveSitemapUrl(baseUrl: string, candidate: string): string {
  return candidate.startsWith("http") ? candidate : joinUrl(baseUrl, candidate);
}

async function parseSitemap(xml: string, baseUrl: string, visitedSitemaps: Set<string>): Promise<string[]> {
  if (isSitemapIndex(xml)) {
    const childUrls = extractLocs(xml);
    const routes: string[] = [];

    for (const childUrl of childUrls) {
      const childRoutes = await parseSitemapFromUrl(childUrl, baseUrl, visitedSitemaps);
      routes.push(...childRoutes);
    }

    return [...new Set(routes)];
  }

  const locs = extractLocs(xml);
  const routes: string[] = [];

  for (const loc of locs) {
    try {
      const parsed = loc.startsWith("http://") || loc.startsWith("https://")
        ? new URL(loc)
        : new URL(loc, baseUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        continue;
      }
      routes.push(normalizeUrlPath(parsed.pathname));
    } catch {
      // ignore invalid entry
    }
  }

  return [...new Set(routes)];
}

async function parseSitemapFromUrl(url: string, baseUrl: string, visitedSitemaps: Set<string>): Promise<string[]> {
  const resolved = resolveSitemapUrl(baseUrl, url);
  if (visitedSitemaps.has(resolved)) {
    return [];
  }

  if (visitedSitemaps.size >= MAX_SITEMAPS) {
    logger.warn(`Sitemap limit of ${MAX_SITEMAPS} reached; skipping ${resolved}`);
    return [];
  }

  visitedSitemaps.add(resolved);
  const xml = await fetchSitemapXml(resolved, new URL(baseUrl).origin);
  return parseSitemap(xml, baseUrl, visitedSitemaps);
}

async function resolveRoutes(config: ResolvedSearchSocketConfig): Promise<string[]> {
  const crawlConfig = config.source.crawl;
  if (!crawlConfig) {
    return [];
  }

  if (crawlConfig.routes.length > 0) {
    return [...new Set(crawlConfig.routes.map((route) => normalizeUrlPath(ensureLeadingSlash(route))))];
  }

  if (!crawlConfig.sitemapUrl) {
    return ["/"];
  }

  return parseSitemapFromUrl(crawlConfig.sitemapUrl, crawlConfig.baseUrl, new Set<string>());
}

export async function loadCrawledPages(
  config: ResolvedSearchSocketConfig,
  maxPages?: number
): Promise<SourceLoadResult> {
  const crawlConfig = config.source.crawl;
  if (!crawlConfig) {
    throw new Error("crawl source config is missing");
  }

  const baseOrigin = new URL(crawlConfig.baseUrl).origin;
  const routes = await resolveRoutes(config);
  // Deterministic order before limiting — see static-output for why.
  routes.sort();
  const { selected, limitedBy } = applyMaxPages(routes, maxPages);

  const concurrencyLimit = pLimit(8);
  const results = await Promise.allSettled(
    selected.map((route) =>
      concurrencyLimit(async (): Promise<PageSourceRecord> => {
        const url = joinUrl(crawlConfig.baseUrl, route);
        const { body, contentType } = await boundedFetch(url, {
          allowedOrigin: baseOrigin,
          accept: "text/html"
        });

        const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
        if (mediaType && mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
          throw new Error(`Route ${route} returned ${mediaType}, expected text/html`);
        }

        return {
          url: normalizeUrlPath(route),
          html: body.toString("utf8"),
          sourcePath: url,
          outgoingLinks: []
        };
      })
    )
  );

  const pages: PageSourceRecord[] = [];
  const failures: SourceFailure[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (!result) continue;
    if (result.status === "fulfilled") {
      pages.push(result.value);
    } else {
      const route = selected[i] ?? "unknown";
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      // A failed fetch is not evidence the page is gone. Recording it here
      // makes the whole run deletion-ineligible rather than silently
      // presenting a partial crawl as an authoritative snapshot.
      failures.push({ target: route, reason });
      logger.warn(`Skipping route ${route}: ${reason}`);
    }
  }

  return sourceResult({
    records: pages,
    discoveredCount: routes.length,
    failures,
    limitedBy
  });
}
