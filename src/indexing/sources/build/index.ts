import { load as cheerioLoad } from "cheerio";
import pLimit from "p-limit";
import { Logger } from "../../../core/logger";
import { normalizeUrlPath, joinUrl } from "../../../utils/path";
import { boundedFetch, BoundedFetchError } from "../../../utils/fetch";
import type { PageSourceRecord, ResolvedSearchSocketConfig } from "../../../types";
import { parseManifest, expandRoutes, isExcluded } from "./manifest-parser";
import { startPreviewServer, type PreviewServer } from "./preview-server";
import { detectBuildOutput } from "./detect-output";
import { loadPrerenderedPages } from "./prerendered-fallback";
import { applyMaxPagesByUrl, sourceResult, type SourceFailure, type SourceLoadResult } from "../result";

const logger = new Logger();

/**
 * Extract internal links from an HTML document for link-discovery crawling.
 * Scans all `<a href>` tags (including navigation) to find linked pages.
 */
export function extractLinksFromHtml(html: string, pageUrl: string, baseOrigin: string): string[] {
  const $ = cheerioLoad(html);
  const links: string[] = [];

  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) {
      return;
    }

    try {
      const resolved = new URL(href, `${baseOrigin}${pageUrl}`);
      if (resolved.origin !== baseOrigin) return;
      if (!["http:", "https:"].includes(resolved.protocol)) return;

      links.push(normalizeUrlPath(resolved.pathname));
    } catch {
      // Ignore malformed URLs
    }
  });

  return [...new Set(links)];
}

/**
 * BFS link-discovery crawl against a running preview server.
 * Starts from seed URLs, follows internal `<a href>` links, and collects
 * pages up to maxPages with depth tracking.
 */
async function discoverPages(
  server: PreviewServer,
  buildConfig: NonNullable<ResolvedSearchSocketConfig["source"]["build"]>,
  pipelineMaxPages?: number
): Promise<SourceLoadResult> {
  const { seedUrls, maxDepth, exclude } = buildConfig;
  const baseOrigin = new URL(server.baseUrl).origin;

  // Use the lower of pipeline maxPages and config maxPages
  let effectiveMax = buildConfig.maxPages;
  if (typeof pipelineMaxPages === "number") {
    const floored = Math.max(0, Math.floor(pipelineMaxPages));
    effectiveMax = Math.min(effectiveMax, floored);
  }

  if (effectiveMax === 0) {
    return sourceResult({ records: [], discoveredCount: 0, limitedBy: "max-pages" });
  }

  const visited = new Set<string>();
  // Links the crawl saw and deliberately did not follow because
  // `source.build.exclude` matched them. Reported so the pipeline can remove
  // their old records; see SourceLoadResult.excludedUrls.
  const excludedUrls = new Set<string>();
  const failures: SourceFailure[] = [];
  let depthTruncated = false;
  const pages: PageSourceRecord[] = [];
  const queue: Array<{ url: string; depth: number }> = [];
  const limit = pLimit(8);

  // Seed the queue
  for (const seed of seedUrls) {
    const normalized = normalizeUrlPath(seed);
    if (isExcluded(normalized, exclude)) {
      excludedUrls.add(normalized);
    } else if (!visited.has(normalized)) {
      visited.add(normalized);
      queue.push({ url: normalized, depth: 0 });
    }
  }

  // Process in waves (BFS order)
  while (queue.length > 0 && pages.length < effectiveMax) {
    const remaining = effectiveMax - pages.length;
    const batch = queue.splice(0, remaining);

    const results = await Promise.allSettled(
      batch.map((item) =>
        limit(async (): Promise<PageSourceRecord | null> => {
          const fullUrl = joinUrl(server.baseUrl, item.url);

          let html: string;
          try {
            // The content-type filter belongs in the fetch: rejecting on the
            // headers keeps a linked PDF a deliberate skip instead of letting
            // its body time out or blow the size cap and mark the run
            // incomplete.
            const fetched = await boundedFetch(fullUrl, {
              allowedOrigin: baseOrigin,
              accept: "text/html",
              allowedContentTypes: ["text/html"]
            });
            html = fetched.body.toString("utf8");
          } catch (error) {
            if (error instanceof BoundedFetchError && error.kind === "content-type") {
              // Not a page — a deliberate skip, not a failure.
              return null;
            }
            // Keep the helper's message rather than just the status: a 200 HTML
            // response rejected for exceeding the size cap would otherwise be
            // reported as "200" and be undiagnosable.
            const reason = error instanceof Error ? error.message : String(error);
            logger.warn(`Skipping ${item.url}: ${reason}`);
            failures.push({ target: item.url, reason, url: item.url });
            return null;
          }

          // Sorted so the queue order does not depend on which concurrent
          // fetch resolved first — otherwise a run that stops at maxPages
          // indexes a different subset each time.
          const links = extractLinksFromHtml(html, item.url, baseOrigin).sort();
          for (const link of links) {
            // An excluded link is evidence at every depth, including maxDepth:
            // seeing it costs no fetch, and it lets the pipeline remove the
            // page's old records.
            if (isExcluded(link, exclude)) {
              excludedUrls.add(link);
            } else if (visited.has(link)) {
              continue;
            } else if (item.depth < maxDepth) {
              visited.add(link);
              queue.push({ url: link, depth: item.depth + 1 });
            } else {
              // Stopped following links here; pages beyond maxDepth were never
              // observed, so this run cannot claim a complete view of the site.
              depthTruncated = true;
            }
          }

          return {
            url: item.url,
            html,
            sourcePath: fullUrl,
            outgoingLinks: []
          };
        })
      )
    );

    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      if (!result) continue;
      if (result.status === "fulfilled") {
        if (result.value) pages.push(result.value);
      } else {
        const target = batch[i]?.url ?? "unknown";
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failures.push({ target, reason, ...(batch[i] ? { url: batch[i]!.url } : {}) });
        logger.warn(`Skipping ${target}: ${reason}`);
      }
    }
  }

  const hitMaxPages = pages.length >= effectiveMax && queue.length > 0;
  if (hitMaxPages) {
    logger.warn(`Discovery crawl reached maxPages limit (${effectiveMax}), ${queue.length} URLs not visited.`);
  }

  logger.event("build_discover_complete", {
    pagesFound: pages.length,
    urlsVisited: visited.size,
    urlsSkipped: queue.length
  });

  return sourceResult({
    records: pages,
    discoveredCount: visited.size,
    failures,
    limitedBy: hitMaxPages ? "max-pages" : depthTruncated ? "max-depth" : undefined,
    excludedUrls
  });
}

export async function loadBuildPages(
  cwd: string,
  config: ResolvedSearchSocketConfig,
  maxPages?: number
): Promise<SourceLoadResult> {
  const buildConfig = config.source.build;
  if (!buildConfig) {
    throw new Error("build source config is missing");
  }

  // Prerendered-output fallback: most non-node adapters (vercel, cloudflare,
  // netlify, static) don't produce a vite-previewable server bundle. Detect
  // the adapter's prerendered HTML directory via marker files and read it
  // directly — no preview server, works on any CI that ran `vite build`.
  if (!buildConfig.discover) {
    const detected = await detectBuildOutput(cwd, config.source.staticOutputDir);
    if (detected && detected.adapter !== "node") {
      logger.info(`Detected ${detected.adapter} build output at ${detected.relativePath}; indexing prerendered HTML directly.`);
      // The inventory here is exactly the prerendered HTML on disk. A route
      // that stops being prerendered (moves to SSR) is still live but has no
      // file, so it reads as removed and its records are pruned. That is not
      // detected: SvelteKit's server manifest lists every page route, but most
      // real sites have SSR pages that were never meant to be in a prerendered
      // inventory, so a manifest-coverage check would mark nearly every such
      // run incomplete and disable pruning outright. Sites whose indexed pages
      // are server-rendered should use manifest (`discover: false` with a node
      // build) or discovery mode instead.
      return loadPrerenderedPages(cwd, detected.absolutePath, maxPages, buildConfig.exclude);
    }
    if (!detected) {
      logger.info(
        `No adapter build output detected in ${cwd}; falling back to vite preview. ` +
          `Expected one of: .vercel/output/config.json, .svelte-kit/cloudflare/_worker.js, build/handler.js, .netlify/server, or ${config.source.staticOutputDir}/index.html.`
      );
    } else {
      logger.info(`Detected node build output at ${detected.relativePath}; using vite preview.`);
    }
  }

  // Discovery mode: BFS crawl from seed URLs instead of manifest parsing
  if (buildConfig.discover) {
    const server = await startPreviewServer(cwd, { previewTimeout: buildConfig.previewTimeout }, logger);
    try {
      return await discoverPages(server, buildConfig, maxPages);
    } finally {
      await server.shutdown();
    }
  }

  // Manifest mode: parse SvelteKit build manifest and fetch known routes
  const routes = await parseManifest(cwd, buildConfig.outputDir);
  // Routes the manifest names but expansion could not enumerate. They are
  // failures of the inventory, not deliberate skips: reporting them keeps a
  // partial inventory from being treated as authoritative and deleting live
  // pages under those routes.
  const expansionFailures: SourceFailure[] = [];
  const excludedUrls = new Set<string>();
  const expanded = expandRoutes(
    routes,
    buildConfig.paramValues,
    buildConfig.exclude,
    logger,
    expansionFailures,
    {
      // The top-level `exclude` is applied by the pipeline, after loading, but
      // it decides here whether an unexpandable dynamic route is a gap in the
      // inventory or a route nobody wants indexed.
      coverageExclude: config.exclude,
      excludedUrls
    }
  );

  logger.event("build_routes_discovered", {
    manifestRoutes: routes.length,
    expandedRoutes: expanded.length
  });

  // Deterministic order before limiting: manifest expansion order depends on
  // param-value iteration, so an unsorted slice indexes a different subset on
  // each limited run.
  expanded.sort((a, b) => a.url.localeCompare(b.url));
  // Limited by URL: a static route and a dynamic route's expansion can yield
  // the same URL, and one must not be loaded without the other.
  const { selected, limitedBy } = applyMaxPagesByUrl(expanded, maxPages, (route) =>
    normalizeUrlPath(route.url)
  );

  const server = await startPreviewServer(cwd, { previewTimeout: buildConfig.previewTimeout }, logger);
  const previewOrigin = new URL(server.baseUrl).origin;

  try {
    const concurrencyLimit = pLimit(8);
    const results = await Promise.allSettled(
      selected.map((route) =>
        concurrencyLimit(async (): Promise<PageSourceRecord> => {
          const fetchUrl = joinUrl(server.baseUrl, route.url);
          const { body } = await boundedFetch(fetchUrl, {
            allowedOrigin: previewOrigin,
            accept: "text/html"
          });

          return {
            url: normalizeUrlPath(route.url),
            html: body.toString("utf8"),
            sourcePath: route.routeFile,
            outgoingLinks: [],
            routeFile: route.routeFile,
            routeResolution: "exact"
          };
        })
      )
    );

    const pages: PageSourceRecord[] = [];
    const failures: SourceFailure[] = [...expansionFailures];
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      if (!result) continue;
      if (result.status === "fulfilled") {
        pages.push(result.value);
      } else {
        const route = selected[i]?.url ?? "unknown";
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failures.push({ target: route, reason, ...(selected[i] ? { url: normalizeUrlPath(route) } : {}) });
        logger.warn(`Skipping build route ${route}: ${reason}`);
      }
    }

    return sourceResult({
      records: pages,
      discoveredCount: expanded.length,
      failures,
      limitedBy,
      excludedUrls
    });
  } finally {
    await server.shutdown();
  }
}
