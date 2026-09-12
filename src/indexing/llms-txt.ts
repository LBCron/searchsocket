import fs from "node:fs/promises";
import path from "node:path";
import type { IndexedPage, ResolvedSearchSocketConfig } from "../types";
import type { Logger } from "../core/logger";

/**
 * Build the absolute URL for a page, given the project's baseUrl.
 * Falls back to the raw page URL (relative path) if baseUrl is not configured.
 */
function resolvePageUrl(pageUrl: string, baseUrl?: string): string {
  if (!baseUrl) return pageUrl;
  try {
    return new URL(pageUrl, baseUrl).href;
  } catch {
    return pageUrl;
  }
}

/**
 * Generate the content of an llms.txt file from indexed pages.
 */
export function generateLlmsTxt(
  pages: IndexedPage[],
  config: ResolvedSearchSocketConfig
): string {
  const title = config.llmsTxt.title ?? config.project.id;
  const description = config.llmsTxt.description;
  const baseUrl = config.project.baseUrl;

  const lines: string[] = [`# ${title}`];

  if (description) {
    lines.push("", `> ${description}`);
  }

  // Filter out /llms.txt and /llms-full.txt from the page list
  const filtered = pages.filter(
    (p) => p.url !== "/llms.txt" && p.url !== "/llms-full.txt"
  );

  // Sort by depth ascending, then by incoming links descending
  const sorted = [...filtered].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return b.incomingLinks - a.incomingLinks;
  });

  if (sorted.length > 0) {
    lines.push("", "## Pages", "");
    for (const page of sorted) {
      const url = resolvePageUrl(page.url, baseUrl);
      if (page.description) {
        lines.push(`- [${page.title}](${url}): ${page.description}`);
      } else {
        lines.push(`- [${page.title}](${url})`);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Generate the content of an llms-full.txt file.
 *
 * Uses the markdown extracted during the run, not the lossy chunk
 * reconstruction that `getPage` performs, so this output is complete.
 */
export function generateLlmsFullTxt(
  pages: IndexedPage[],
  config: ResolvedSearchSocketConfig
): string {
  const title = config.llmsTxt.title ?? config.project.id;
  const description = config.llmsTxt.description;
  const baseUrl = config.project.baseUrl;

  const lines: string[] = [`# ${title}`];

  if (description) {
    lines.push("", `> ${description}`);
  }

  const filtered = pages.filter(
    (p) => p.url !== "/llms.txt" && p.url !== "/llms-full.txt"
  );

  const sorted = [...filtered].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return b.incomingLinks - a.incomingLinks;
  });

  for (const page of sorted) {
    const url = resolvePageUrl(page.url, baseUrl);
    lines.push("", "---", "", `## [${page.title}](${url})`, "");
    lines.push(page.markdown.trim());
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Derive the full-content export path from the index export path.
 *
 * A plain `.txt` suffix swap collapses whenever the configured output has some
 * other extension or none at all — `static/export` produced `static/export`
 * again, so the full export silently overwrote the index export.
 */
export function deriveFullOutputPath(outputPath: string): string {
  const dir = path.dirname(outputPath);
  const ext = path.extname(outputPath);
  const base = path.basename(outputPath, ext);
  return path.join(dir, `${base}-full${ext}`);
}

/**
 * Write llms.txt (and optionally llms-full.txt) to disk.
 */
export async function writeLlmsTxt(
  pages: IndexedPage[],
  config: ResolvedSearchSocketConfig,
  cwd: string,
  logger: Logger
): Promise<void> {
  const outputPath = path.resolve(cwd, config.llmsTxt.outputPath);
  const outputDir = path.dirname(outputPath);

  await fs.mkdir(outputDir, { recursive: true });

  const content = generateLlmsTxt(pages, config);
  await fs.writeFile(outputPath, content, "utf8");
  logger.info(`Generated llms.txt at ${config.llmsTxt.outputPath}`);

  if (config.llmsTxt.generateFull) {
    const fullPath = deriveFullOutputPath(outputPath);
    const fullContent = generateLlmsFullTxt(pages, config);
    await fs.writeFile(fullPath, fullContent, "utf8");
    const relativeFull = path.relative(cwd, fullPath);
    logger.info(`Generated llms-full.txt at ${relativeFull}`);
  }
}
