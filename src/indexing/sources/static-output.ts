import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { PageSourceRecord, ResolvedSearchSocketConfig } from "../../types";
import { staticHtmlFileToUrl } from "../../utils/path";
import { applyMaxPagesByUrl, sourceResult, type SourceFailure, type SourceLoadResult } from "./result";

export async function loadStaticOutputPages(
  cwd: string,
  config: ResolvedSearchSocketConfig,
  maxPages?: number
): Promise<SourceLoadResult> {
  const outputDir = path.resolve(cwd, config.source.staticOutputDir);
  const htmlFiles = await fg(["**/*.html"], {
    cwd: outputDir,
    absolute: true
  });

  // Sort before limiting: fast-glob makes no ordering guarantee, and an
  // unstable slice means repeated --max-pages runs index different subsets.
  htmlFiles.sort();

  // Limited by URL, not by file: see applyMaxPagesByUrl.
  const { selected, limitedBy } = applyMaxPagesByUrl(htmlFiles, maxPages, (filePath) =>
    staticHtmlFileToUrl(filePath, outputDir)
  );

  const pages: PageSourceRecord[] = [];
  const failures: SourceFailure[] = [];

  for (const filePath of selected) {
    let html: string;
    try {
      html = await fs.readFile(filePath, "utf8");
    } catch (error) {
      // An unreadable file is a failure, not an absence. Recording it keeps
      // the run non-authoritative so its records are not treated as deleted.
      failures.push({
        target: path.relative(cwd, filePath).replace(/\\/g, "/"),
        reason: error instanceof Error ? error.message : String(error),
        url: staticHtmlFileToUrl(filePath, outputDir)
      });
      continue;
    }
    pages.push({
      url: staticHtmlFileToUrl(filePath, outputDir),
      html,
      sourcePath: path.relative(cwd, filePath).replace(/\\/g, "/"),
      outgoingLinks: []
    });
  }

  return sourceResult({
    records: pages,
    discoveredCount: htmlFiles.length,
    failures,
    limitedBy
  });
}
