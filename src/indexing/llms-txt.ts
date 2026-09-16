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
 * Describe the site's retrieval endpoints for an LLM reading llms.txt.
 *
 * An agent that finds only a page list will crawl the page list; the whole
 * point of an indexed site is that it can be asked a question instead. This
 * section is what turns the file from a directory into a pointer at the API.
 */
function buildRetrievalSection(config: ResolvedSearchSocketConfig): string[] {
  const baseUrl = config.project.baseUrl;
  const lines: string[] = [];

  // The browser search route is mounted unconditionally by the SvelteKit hook
  // and needs no credential, so it is always advertisable.
  const searchUrl = resolveRoute(config.api.path, baseUrl);
  lines.push(
    `- Search: \`GET ${searchUrl}?q={query}\` returns JSON results (page URL, title, matching sections). No authentication required.`
  );

  if (isMcpReachable(config)) {
    const mcpUrl = resolveRoute(config.mcp.handle.path, baseUrl);
    lines.push(`- MCP: \`POST ${mcpUrl}\` speaks JSON-RPC over Streamable HTTP. ${mcpAuthNote(config)}`);
  }

  return ["", "## Retrieval API", "", ...lines];
}

/**
 * Resolve the MCP key the same way the request handler does.
 *
 * Deliberately reads `process.env` rather than treating a configured
 * `apiKeyEnv` *name* as proof of a key: the name being set says nothing about
 * the variable being set, and handle.ts resolves the value. A build that runs
 * without the deploy-time secret therefore stays quiet about MCP, which is the
 * direction to err in — a missing pointer costs an agent one fallback to the
 * page list, an advertised 503 costs it a failed call and misplaced trust.
 */
function resolveMcpApiKey(config: ResolvedSearchSocketConfig): string | undefined {
  return (
    config.mcp.handle.apiKey ??
    (config.mcp.handle.apiKeyEnv ? process.env[config.mcp.handle.apiKeyEnv] : undefined)
  );
}

/**
 * Whether the MCP route would actually answer a request.
 *
 * `handle.ts` mounts the route only when `mcp.enable` is true, and then fails
 * closed with a 503 when access is private and no key resolved. Advertising a
 * dead endpoint in a public file is worse than saying nothing, so this mirrors
 * that gating exactly.
 */
function isMcpReachable(config: ResolvedSearchSocketConfig): boolean {
  if (!config.mcp.enable) return false;
  if (config.mcp.handle.access === "public") return true;
  return Boolean(resolveMcpApiKey(config));
}

/**
 * The credential sentence for the MCP line.
 *
 * Never names the key or the environment variable holding it: this file is
 * served publicly at /llms.txt, and the variable's name is deployment detail an
 * external caller cannot act on anyway. A caller entitled to the endpoint was
 * given the key out of band.
 */
function mcpAuthNote(config: ResolvedSearchSocketConfig): string {
  // Resolved, not merely named: under public access an unresolved key means
  // every authenticated attempt is a 401, so promising that a Bearer token
  // unlocks the full result set would be a lie.
  const hasKey = Boolean(resolveMcpApiKey(config));

  if (config.mcp.handle.access === "public") {
    return hasKey
      ? "Open to anonymous callers, which receive a redacted result set; an API key sent as a Bearer token unlocks the full one."
      : "Open to anonymous callers, which receive a redacted result set.";
  }

  return "Requires an API key sent as an `Authorization: Bearer` header.";
}

/**
 * Resolve a configured route to the form an LLM should call.
 *
 * Uses the same URL resolution as the page list rather than `joinUrl`: routes
 * are matched against `event.url.pathname`, so they are origin-absolute, and
 * appending them to a baseUrl that carries a path prefix would produce a URL
 * the hook never sees. With no baseUrl the relative path stands on its own —
 * whoever is reading this fetched it from the site, so it resolves against the
 * origin they already have, exactly as the page links do.
 *
 * The configured path is passed through verbatim, deliberately skipping
 * `normalizeUrlPath`: the hook compares it to the pathname literally, so a
 * configured "/api/search/" is the path that answers and normalising the
 * trailing slash away would advertise one that does not.
 */
function resolveRoute(routePath: string, baseUrl?: string): string {
  return resolvePageUrl(routePath, baseUrl);
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

  lines.push(...buildRetrievalSection(config));

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

  lines.push(...buildRetrievalSection(config));

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
