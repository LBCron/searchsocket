import fs from "node:fs/promises";
import path from "node:path";
import { SearchSocketError } from "../../../errors";
import { Logger } from "../../../core/logger";
import { matchUrlPatterns } from "../../../utils/pattern";
import { normalizeUrlPath } from "../../../utils/path";
import type { SourceFailure } from "../result";

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

/** Options for {@link expandRoutes} beyond the build-level exclude list. */
export interface ExpandRoutesOptions {
  /**
   * Further patterns, in practice the top-level `exclude`, that are applied
   * later by the pipeline rather than here. They matter to one decision only:
   * a dynamic route they provably cover does not need `paramValues`, because
   * every page it can produce would be excluded anyway. Reporting it as an
   * expansion failure disabled pruning for good over pages nobody wanted.
   * Concrete URLs are NOT filtered by these; the pipeline does that, and
   * records each one as an observed exclusion.
   */
  coverageExclude?: string[];
  /**
   * Receives every concrete URL that `exclude` removed, so the caller can
   * report them as observed exclusions rather than as silent absences.
   */
  excludedUrls?: Set<string>;
}

/**
 * Expand manifest routes into concrete URLs.
 *
 * A dynamic route this cannot enumerate — no `paramValues`, or a value that does
 * not fit the route's parameters — is pushed onto `failures` as well as logged.
 * Those pages exist on the site but are missing from the inventory, and an
 * inventory treated as complete would delete their records as removed. Callers
 * that drive deletion must pass `failures` into the source result; a route that
 * is genuinely not meant to be indexed belongs in `exclude` instead.
 *
 * A dynamic route is only excused from needing `paramValues` when a pattern provably covers
 * every URL it can produce (see {@link routeProvablyExcluded}). Matching the
 * route's literal id as if it were a URL let `/docs/*` "exclude"
 * `/docs/[...slug]`, whose `/docs/a/b` pages the pattern does not match.
 */
export function expandRoutes(
  routes: ManifestRoute[],
  paramValues: Record<string, string[]>,
  exclude: string[],
  logger: Logger,
  failures: SourceFailure[] = [],
  options: ExpandRoutesOptions = {}
): ExpandedRoute[] {
  const expanded: ExpandedRoute[] = [];
  const coverageExclude = options.coverageExclude ?? [];

  for (const route of routes) {
    const url = routeIdToUrl(route.id);

    if (!route.isDynamic) {
      if (isExcluded(url, exclude)) {
        options.excludedUrls?.add(normalizeUrlPath(url));
        continue;
      }
      expanded.push({ url, routeFile: route.routeFile });
      continue;
    }

    // Every URL the route can produce is excluded, here or by a pattern the
    // pipeline applies later, so nothing can be missing from the inventory and
    // lacking paramValues is not a failure. Supplied values are still expanded:
    // at the source they are reported through `excludedUrls`, downstream they
    // reach the pipeline, and either way an already-indexed page is recorded as
    // an observed exclusion instead of silently staying in the index.
    const excludedDownstream =
      routeProvablyExcluded(url, exclude) || routeProvablyExcluded(url, coverageExclude);

    // Look up param values by route ID first, then by URL (handles layout group mismatch)
    const values = paramValues[route.id] ?? paramValues[url];
    if (!values || values.length === 0) {
      if (excludedDownstream) {
        logger.debug(`Skipping dynamic route ${route.id}: every URL it can produce is excluded.`);
        continue;
      }
      logger.warn(
        `Skipping dynamic route ${route.id}: no paramValues provided. ` +
          `Add paramValues["${route.id}"] or paramValues["${url}"] to your build config, ` +
          "or exclude the route. Stale records will not be deleted until it is resolved."
      );
      failures.push({
        target: route.id,
        reason: "dynamic route has no paramValues, so its pages were not enumerated"
      });
      continue;
    }

    for (const value of values) {
      const expandedUrl = expandDynamicUrl(url, value);
      if (expandedUrl === null) {
        if (excludedDownstream) continue;
        logger.warn(
          `Skipping value "${value}" for dynamic route ${route.id}: values are consumed ` +
            "one path segment per parameter, so a two-parameter route needs a value like " +
            '"guides/quickstart".'
        );
        failures.push({
          target: route.id,
          reason: `paramValues entry "${value}" does not fit the route's parameters`
        });
        continue;
      }

      if (isExcluded(expandedUrl, exclude)) {
        options.excludedUrls?.add(expandedUrl);
      } else {
        expanded.push({ url: expandedUrl, routeFile: route.routeFile });
      }
    }
  }

  return expanded;
}

/**
 * Whether one of `patterns` matches EVERY URL a dynamic route can produce.
 *
 * Mirrors `matchUrlPattern` semantics, and answers `true` only when that is
 * provable from the route's shape — an unprovable case must fall through to
 * "needs paramValues", never to "excluded", or real pages would silently drop
 * out of the inventory.
 *
 * - `/**` covers every route.
 * - `/p/**` covers a route whose leading segments are exactly the literal
 *   segments of `/p`: parameters after them can add or drop segments, but every
 *   result is `/p` or lies below it. A parameter inside those leading segments
 *   (`/[[lang]]/p/...`) could change them, so it does not count.
 * - `/p/*` covers a route of exactly one more segment than `/p`, with the same
 *   literal leading segments, whose last segment always renders as one
 *   non-empty segment: no rest parameter (it may span or vanish), and either
 *   some literal text or a required parameter (an optional one may vanish).
 * - An exact pattern never covers a dynamic route.
 */
export function routeProvablyExcluded(routeUrl: string, patterns: string[]): boolean {
  // Segments are split exactly as `matchUrlPattern` compares them: empty
  // segments are kept, so `/docs//**` (prefix `/docs/`) is not mistaken for
  // `/docs/**`. Dropping them proved coverage the matcher never applied.
  const stripTrailing = (p: string): string => (p !== "/" && p.endsWith("/") ? p.slice(0, -1) : p);
  const segments = stripTrailing(routeUrl).split("/");
  const isLiteral = (segment: string): boolean => !segment.includes("[");
  const leadingLiteralsMatch = (prefixSegments: string[]): boolean =>
    prefixSegments.every((segment, i) => segments[i] !== undefined && isLiteral(segments[i]!) && segments[i] === segment);

  for (const pattern of patterns) {
    const norm = stripTrailing(pattern);

    if (norm.endsWith("/**")) {
      if (norm === "/**") return true;
      const prefixSegments = norm.slice(0, -3).split("/");
      if (segments.length >= prefixSegments.length && leadingLiteralsMatch(prefixSegments)) return true;
      continue;
    }

    if (norm.endsWith("/*")) {
      const prefixSegments = norm.slice(0, -2).split("/");
      if (segments.length !== prefixSegments.length + 1 || !leadingLiteralsMatch(prefixSegments)) continue;
      const plan = planSegment(segments[segments.length - 1]!);
      const hasRest = plan.params.some((param) => param.kind === "rest" || param.kind === "optional-rest");
      const alwaysPresent =
        plan.literals.some((literal) => literal.length > 0) ||
        plan.params.some((param) => param.kind === "required");
      if (!hasRest && alwaysPresent) return true;
    }
  }

  return false;
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
