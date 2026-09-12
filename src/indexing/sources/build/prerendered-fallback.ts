import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { PageSourceRecord } from "../../../types";
import { staticHtmlFileToUrl } from "../../../utils/path";
import { matchUrlPatterns } from "../../../utils/pattern";
import { applyMaxPages, sourceResult, type SourceFailure, type SourceLoadResult } from "../result";

/**
 * Universal skip list for SvelteKit prerendered output across adapters.
 * Covers build-asset directories, framework fallback/error pages, and
 * platform routing/header files so they never reach the indexer.
 */
export const PRERENDERED_IGNORE_PATTERNS = [
  "_app/**",
  "__data.json",
  "**/__data.json",
  "200.html",
  "404.html",
  "fallback.html",
  "_worker.js",
  "_worker.js/**",
  "_routes.json",
  "_headers",
  "_redirects"
];

/**
 * Load prerendered HTML pages from an adapter's output directory. Works for
 * any adapter that writes prerendered routes as `.html` files mirroring the
 * URL tree (vercel, cloudflare, node's `build/prerendered/`, netlify, static).
 *
 * `exclude` carries `source.build.exclude`, the same patterns the manifest and
 * discovery paths honour. Without it a page the user explicitly excluded
 * reached a public index from the adapter-output path alone.
 */
export async function loadPrerenderedPages(
  cwd: string,
  outputDir: string,
  maxPages?: number,
  exclude: string[] = []
): Promise<SourceLoadResult> {
  const htmlFiles = await fg(["**/*.html"], {
    cwd: outputDir,
    absolute: true,
    ignore: PRERENDERED_IGNORE_PATTERNS
  });

  // Deterministic order before limiting — see static-output for why.
  htmlFiles.sort();

  // Exclusions are applied before the page budget: an excluded page must not
  // consume a slot that a page the user actually wants indexed needed.
  const candidates = htmlFiles
    .map((filePath) => ({ filePath, url: staticHtmlFileToUrl(filePath, outputDir) }))
    .filter((candidate) => !matchUrlPatterns(candidate.url, exclude));

  const { selected, limitedBy } = applyMaxPages(candidates, maxPages);

  const pages: PageSourceRecord[] = [];
  const failures: SourceFailure[] = [];
  for (const { filePath, url } of selected) {
    let html: string;
    try {
      html = await fs.readFile(filePath, "utf8");
    } catch (error) {
      failures.push({
        target: path.relative(cwd, filePath).replace(/\\/g, "/"),
        reason: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    pages.push({
      url,
      html,
      sourcePath: path.relative(cwd, filePath).replace(/\\/g, "/"),
      outgoingLinks: []
    });
  }

  return sourceResult({
    records: pages,
    // Excluded pages were never part of the inventory this run intends to
    // cover, so they do not count as discovered — same as manifest mode.
    discoveredCount: candidates.length,
    failures,
    limitedBy
  });
}
