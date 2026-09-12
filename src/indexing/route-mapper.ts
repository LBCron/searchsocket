import path from "node:path";
import fg from "fast-glob";
import type { RouteMatch } from "../types";
import { normalizeUrlPath } from "../utils/path";

/**
 * Page file extensions we discover, in precedence order. `.svelte` is
 * SvelteKit's own page component; `.svx` and `.md` are the mdsvex defaults.
 * If a route directory happens to hold more than one, the earlier extension
 * wins so discovery stays deterministic across filesystems.
 */
const PAGE_EXTENSIONS = ["svelte", "svx", "md"] as const;

const PAGE_FILE_PATTERN = /^\+page\.[^/]+$/;

interface RoutePattern {
  routeFile: string;
  regex: RegExp;
  score: number;
  isRoot: boolean;
}

function isRouteGroup(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

/**
 * Split a path relative to `src/routes/` into its route segments, dropping the
 * trailing `+page.*` filename and any layout groups.
 *
 * The filename is removed as a whole segment rather than with a leading-slash
 * regex: the root page's relative path is just `+page.svelte`, which such a
 * regex cannot match, and the leftover segment used to compile into a route
 * that only `/+page.svelte` could satisfy. Going through segments also gives
 * the root and a grouped root — `(marketing)/+page.svelte` — the same empty
 * representation.
 */
function toRouteSegments(relativeToRoutes: string): string[] {
  const segments = relativeToRoutes.split("/").filter(Boolean);

  const last = segments[segments.length - 1];
  if (last && PAGE_FILE_PATTERN.test(last)) {
    segments.pop();
  }

  return segments.filter((segment) => !isRouteGroup(segment));
}

function segmentToRegex(segment: string): { regex: string; score: number } {
  if (/^\[\[\.\.\.[^\]]+\]\]$/.test(segment)) {
    return { regex: "(?:/.+)?", score: -2 };
  }

  if (/^\[\.\.\.[^\]]+\]$/.test(segment)) {
    return { regex: "/.+", score: 0 };
  }

  if (/^\[\[[^\]]+\]\]$/.test(segment)) {
    return { regex: "(?:/[^/]+)?", score: -1 };
  }

  if (/^\[[^\]]+\]$/.test(segment)) {
    return { regex: "/[^/]+", score: 3 };
  }

  return { regex: `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, score: 10 };
}

function routeFileToPattern(routeFile: string, cwd: string): RoutePattern {
  const relative = path.relative(cwd, routeFile).replace(/\\/g, "/");
  const withoutPrefix = relative.replace(/^src\/routes\/?/, "");
  const segments = toRouteSegments(withoutPrefix);

  let regex = "^";
  let score = 0;

  if (segments.length === 0) {
    regex += "/";
  } else {
    for (const segment of segments) {
      const converted = segmentToRegex(segment);
      regex += converted.regex;
      score += converted.score;
    }
  }

  regex += "/?$";

  return {
    routeFile: relative,
    regex: new RegExp(regex),
    score,
    isRoot: segments.length === 0
  };
}

function pageExtensionRank(filePath: string): number {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const rank = PAGE_EXTENSIONS.indexOf(extension as (typeof PAGE_EXTENSIONS)[number]);
  return rank === -1 ? PAGE_EXTENSIONS.length : rank;
}

export async function buildRoutePatterns(cwd: string): Promise<RoutePattern[]> {
  const files = await fg(`src/routes/**/+page.{${PAGE_EXTENSIONS.join(",")}}`, {
    cwd,
    absolute: true
  });

  // One directory can only own one URL, so collapse duplicates by extension
  // precedence before compiling patterns.
  const byDirectory = new Map<string, string>();
  for (const file of files) {
    const directory = path.dirname(file);
    const current = byDirectory.get(directory);
    if (!current || pageExtensionRank(file) < pageExtensionRank(current)) {
      byDirectory.set(directory, file);
    }
  }

  return [...byDirectory.values()]
    .map((file) => routeFileToPattern(file, cwd))
    .sort(
      (a, b) =>
        b.score - a.score ||
        // Prefer a `.svelte` page over a markdown one on a tie: `.svelte` is
        // always a route, while `.md`/`.svx` only are when mdsvex is wired up,
        // which we cannot see from here.
        pageExtensionRank(a.routeFile) - pageExtensionRank(b.routeFile) ||
        b.routeFile.length - a.routeFile.length
    );
}

export function mapUrlToRoute(urlPath: string, patterns: RoutePattern[]): RouteMatch {
  const normalized = normalizeUrlPath(urlPath);

  for (const pattern of patterns) {
    if (pattern.regex.test(normalized)) {
      return {
        routeFile: pattern.routeFile,
        routeResolution: "exact"
      };
    }
  }

  const rootRoute = patterns.find((pattern) => pattern.isRoot);
  if (rootRoute) {
    return {
      routeFile: rootRoute.routeFile,
      routeResolution: "best-effort"
    };
  }

  const fallback = patterns[0];
  return {
    routeFile: fallback?.routeFile ?? "src/routes/+page.svelte",
    routeResolution: "best-effort"
  };
}
