import { gunzipSync } from "node:zlib";
import { load as cheerioLoad } from "cheerio";
import pLimit from "p-limit";
import { Logger } from "../../core/logger";
import type { PageSourceRecord, ResolvedSearchSocketConfig } from "../../types";
import { boundedFetch, DEFAULT_MAX_RESPONSE_BYTES } from "../../utils/fetch";
import { ensureLeadingSlash, joinUrl, normalizeUrlPath } from "../../utils/path";
import {
  applyMaxPages,
  sourceResult,
  type SourceFailure,
  type SourceLimitReason,
  type SourceLoadResult
} from "./result";

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

/**
 * A sitemap traversal's routes plus every reason it fell short of the full
 * inventory.
 *
 * The recursion used to return a bare `string[]`, so a fan-out stopped by
 * `MAX_SITEMAPS` was indistinguishable from a genuinely small site: the run
 * reported `complete: true` and the pipeline deleted every page past the cap.
 */
interface SitemapTraversal {
  routes: string[];
  limitedBy?: SourceLimitReason;
  failures: SourceFailure[];
}

async function parseSitemap(
  xml: string,
  baseUrl: string,
  visitedSitemaps: Set<string>
): Promise<SitemapTraversal> {
  if (isSitemapIndex(xml)) {
    const childUrls = extractLocs(xml);
    const routes: string[] = [];
    const failures: SourceFailure[] = [];
    let limitedBy: SourceLimitReason | undefined;

    for (const childUrl of childUrls) {
      let child: SitemapTraversal;
      try {
        child = await parseSitemapFromUrl(childUrl, baseUrl, visitedSitemaps);
      } catch (error) {
        // A child sitemap we could not read covers an unknown slice of the
        // site, not an empty one. Aborting the whole run is too harsh and
        // dropping it silently would present a shrunken inventory as
        // authoritative, so record it and keep going.
        const reason = error instanceof Error ? error.message : String(error);
        failures.push({ target: resolveSitemapUrl(baseUrl, childUrl), reason });
        logger.warn(`Skipping child sitemap ${childUrl}: ${reason}`);
        continue;
      }

      routes.push(...child.routes);
      failures.push(...child.failures);
      limitedBy ??= child.limitedBy;
    }

    return {
      routes: [...new Set(routes)],
      failures,
      ...(limitedBy ? { limitedBy } : {})
    };
  }

  const locs = extractLocs(xml);
  const routes: string[] = [];
  const failures: SourceFailure[] = [];

  for (const loc of locs) {
    let parsed: URL;
    try {
      parsed = loc.startsWith("http://") || loc.startsWith("https://")
        ? new URL(loc)
        : new URL(loc, baseUrl);
    } catch {
      // An entry we cannot parse names a page we cannot rule out, so it is a
      // hole in the inventory rather than something to drop quietly.
      failures.push({ target: loc, reason: "Unparseable sitemap <loc> entry" });
      continue;
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      // A mailto:/ftp: entry is not an indexable page of this site, so its
      // absence is a deliberate skip and not a gap in the inventory.
      logger.debug(`Ignoring non-http(s) sitemap entry ${loc}`);
      continue;
    }

    routes.push(normalizeUrlPath(parsed.pathname));
  }

  return { routes: [...new Set(routes)], failures };
}

async function parseSitemapFromUrl(
  url: string,
  baseUrl: string,
  visitedSitemaps: Set<string>
): Promise<SitemapTraversal> {
  const resolved = resolveSitemapUrl(baseUrl, url);
  if (visitedSitemaps.has(resolved)) {
    return { routes: [], failures: [] };
  }

  if (visitedSitemaps.size >= MAX_SITEMAPS) {
    // The cap counts the root index too, so a root listing 50 children reaches
    // only 49 of them. Whatever is behind the skipped sitemaps was never seen.
    logger.warn(`Sitemap limit of ${MAX_SITEMAPS} reached; skipping ${resolved}`);
    return { routes: [], failures: [], limitedBy: "max-sitemaps" };
  }

  visitedSitemaps.add(resolved);
  const xml = await fetchSitemapXml(resolved, new URL(baseUrl).origin);
  return parseSitemap(xml, baseUrl, visitedSitemaps);
}

async function resolveRoutes(config: ResolvedSearchSocketConfig): Promise<SitemapTraversal> {
  const crawlConfig = config.source.crawl;
  if (!crawlConfig) {
    return { routes: [], failures: [] };
  }

  if (crawlConfig.routes.length > 0) {
    return {
      routes: [...new Set(crawlConfig.routes.map((route) => normalizeUrlPath(ensureLeadingSlash(route))))],
      failures: []
    };
  }

  if (!crawlConfig.sitemapUrl) {
    return { routes: ["/"], failures: [] };
  }

  // The configured root sitemap is the run's whole inventory: if it cannot be
  // read there is nothing to fall back to, so that failure still propagates.
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
  const discovery = await resolveRoutes(config);
  const routes = discovery.routes;
  // Deterministic order before limiting — see static-output for why.
  routes.sort();
  const { selected, limitedBy: pageLimit } = applyMaxPages(routes, maxPages);
  // Discovery truncation outranks --max-pages: it means `discoveredCount` may
  // itself understate the site, which is the more useful thing to report.
  const limitedBy = discovery.limitedBy ?? pageLimit;

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
  const failures: SourceFailure[] = [...discovery.failures];
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
