import fs from "node:fs/promises";
import path from "node:path";
import { SearchSocketError } from "../../../errors";
import { Logger } from "../../../core/logger";
import { matchUrlPatterns } from "../../../utils/pattern";
import { normalizeUrlPath } from "../../../utils/path";

export interface ManifestRoute {
  id: string;
  isPage: boolean;
  isDynamic: boolean;
  routeFile: string;
}

export interface ExpandedRoute {
  url: string;
  routeFile: string;
}

export function routeIdToFile(routeId: string): string {
  if (routeId === "/") {
    return "src/routes/+page.svelte";
  }
  return `src/routes${routeId}/+page.svelte`;
}

export function routeIdToUrl(routeId: string): string {
  if (routeId === "/") return "/";

  return routeId
    .split("/")
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")))
    .join("/") || "/";
}

export async function parseManifest(cwd: string, outputDir: string): Promise<ManifestRoute[]> {
  const manifestPath = path.resolve(cwd, outputDir, "server", "manifest-full.js");

  let content: string;
  try {
    content = await fs.readFile(manifestPath, "utf8");
  } catch {
    throw new SearchSocketError(
      "BUILD_MANIFEST_NOT_FOUND",
      `SvelteKit build manifest not found at ${manifestPath}. Run \`vite build\` first.`
    );
  }

  const routes: ManifestRoute[] = [];

  // Find all route ID positions, then extract context between them
  const idRegex = /id:\s*"([^"]+)"/g;
  const idMatches: Array<{ id: string; index: number }> = [];

  let idMatch: RegExpExecArray | null;
  while ((idMatch = idRegex.exec(content)) !== null) {
    idMatches.push({ id: idMatch[1]!, index: idMatch.index });
  }

  for (let i = 0; i < idMatches.length; i++) {
    const current = idMatches[i]!;
    const nextIndex = idMatches[i + 1]?.index ?? content.length;
    const block = content.slice(current.index, nextIndex);

    // A page route has `page: {` with a non-null value
    const isPage = /page:\s*\{/.test(block);
    if (!isPage) continue;

    const isDynamic = current.id.includes("[");

    routes.push({
      id: current.id,
      isPage: true,
      isDynamic,
      routeFile: routeIdToFile(current.id)
    });
  }

  return routes;
}

export function expandRoutes(
  routes: ManifestRoute[],
  paramValues: Record<string, string[]>,
  exclude: string[],
  logger: Logger
): ExpandedRoute[] {
  const expanded: ExpandedRoute[] = [];

  for (const route of routes) {
    const url = routeIdToUrl(route.id);

    if (isExcluded(url, exclude)) continue;

    if (!route.isDynamic) {
      expanded.push({ url, routeFile: route.routeFile });
      continue;
    }

    // Look up param values by route ID first, then by URL (handles layout group mismatch)
    const values = paramValues[route.id] ?? paramValues[url];
    if (!values || values.length === 0) {
      logger.warn(
        `Skipping dynamic route ${route.id}: no paramValues provided. ` +
          `Add paramValues["${route.id}"] or paramValues["${url}"] to your build config.`
      );
      continue;
    }

    for (const value of values) {
      const expandedUrl = expandDynamicUrl(url, value);
      if (expandedUrl === null) {
        logger.warn(
          `Skipping value "${value}" for dynamic route ${route.id}: values are consumed ` +
            "one path segment per parameter, so a two-parameter route needs a value like " +
            '"guides/quickstart".'
        );
        continue;
      }

      if (!isExcluded(expandedUrl, exclude)) {
        expanded.push({ url: expandedUrl, routeFile: route.routeFile });
      }
    }
  }

  return expanded;
}

type ParamKind = "required" | "optional" | "rest" | "optional-rest";

interface ParamToken {
  kind: ParamKind;
  /** True when the parameter is the whole path segment, not part of one. */
  wholeSegment: boolean;
}

interface SegmentPlan {
  /** Literal text around the parameters; always params.length + 1 entries. */
  literals: string[];
  params: ParamToken[];
}

const PARAM_PATTERN = /\[\[\.\.\.[^\]]+\]\]|\[\.\.\.[^\]]+\]|\[\[[^\]]+\]\]|\[[^\]]+\]/g;

function classifyParam(token: string): ParamKind {
  if (token.startsWith("[[...")) return "optional-rest";
  if (token.startsWith("[...")) return "rest";
  if (token.startsWith("[[")) return "optional";
  return "required";
}

function planSegment(segment: string): SegmentPlan {
  const literals: string[] = [];
  const params: ParamToken[] = [];

  let cursor = 0;
  for (const match of segment.matchAll(PARAM_PATTERN)) {
    const token = match[0];
    literals.push(segment.slice(cursor, match.index));
    params.push({
      kind: classifyParam(token),
      wholeSegment: token.length === segment.length
    });
    cursor = match.index + token.length;
  }
  literals.push(segment.slice(cursor));

  return { literals, params };
}

/**
 * Fill a route's parameters from one `paramValues` entry, consuming the value
 * one path segment per parameter. A global replace would substitute the whole
 * value into every parameter, turning `/docs/[category]/[page]` plus
 * `guides/quickstart` into `/docs/guides/quickstart/guides/quickstart`.
 *
 * Returns null when the value cannot be laid over the route's parameters, so
 * the caller can warn instead of emitting a bogus URL.
 */
function expandDynamicUrl(url: string, value: string): string | null {
  const plans = url.split("/").filter(Boolean).map(planSegment);
  const params = plans.flatMap((plan) => plan.params);
  const values = value.split("/").filter(Boolean);

  // A single-parameter route is unambiguous: the whole value belongs to it,
  // whether or not it is a rest parameter. This is also what the old global
  // replace did, so slug values containing slashes keep working.
  const singleParam = params.length === 1;

  // Rest parameters can legitimately match zero segments, so only required
  // parameters reserve one; optional ones are filled from the surplus.
  let requiredAfter = params.filter((param) => param.kind === "required").length;

  const out: string[] = [];
  let cursor = 0;

  for (const plan of plans) {
    let rendered = plan.literals[0]!;

    for (let i = 0; i < plan.params.length; i++) {
      const param = plan.params[i]!;
      if (param.kind === "required") {
        requiredAfter -= 1;
      }

      const available = Math.max(0, values.length - cursor - requiredAfter);
      const isRest = param.kind === "rest" || param.kind === "optional-rest";

      if (singleParam || (param.wholeSegment && isRest)) {
        // Rest parameters absorb every segment the remaining required
        // parameters do not need; a lone parameter takes the whole value.
        // A rest parameter may legitimately match nothing; a required single
        // parameter with no value left cannot be filled.
        if (available === 0 && !isRest) {
          return null;
        }

        rendered += values.slice(cursor, cursor + available).join("/");
        cursor += available;
      } else if (param.kind === "optional" || param.kind === "optional-rest") {
        // An optional parameter drops out when no segment is going spare.
        if (available >= 1) {
          rendered += values[cursor]!;
          cursor += 1;
        }
      } else {
        if (cursor >= values.length) {
          return null;
        }
        rendered += values[cursor]!;
        cursor += 1;
      }

      rendered += plan.literals[i + 1]!;
    }

    // A dropped optional parameter takes its whole segment with it.
    if (rendered !== "") {
      out.push(rendered);
    }
  }

  if (cursor < values.length) {
    return null;
  }

  return normalizeUrlPath(`/${out.join("/")}`);
}

export function isExcluded(url: string, patterns: string[]): boolean {
  return matchUrlPatterns(url, patterns);
}
