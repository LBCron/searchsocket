/**
 * Match a URL path against a pattern.
 *
 * Patterns:
 * - `/blog`       — exact match only
 * - `/blog/*`     — matches one level: `/blog/foo` but not `/blog/foo/bar`
 * - `/blog/**`    — matches any depth: `/blog/foo`, `/blog/foo/bar`, etc.
 * - `/`           — exact match for root only
 *
 * Both URL and pattern have trailing slashes stripped (except root "/").
 */
export function matchUrlPattern(url: string, pattern: string): boolean {
  const norm = (p: string) => (p !== "/" && p.endsWith("/") ? p.slice(0, -1) : p);
  const normalizedUrl = norm(url);
  const normalizedPattern = norm(pattern);

  // Globstar: /prefix/**
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    if (prefix === "") {
      // /** matches everything
      return true;
    }
    // Match the prefix itself, or anything under it
    return normalizedUrl === prefix || normalizedUrl.startsWith(prefix + "/");
  }

  // Single-level wildcard: /prefix/*
  if (normalizedPattern.endsWith("/*")) {
    const prefix = normalizedPattern.slice(0, -2);
    if (prefix === "") {
      // /* matches single-segment paths like /foo but not /foo/bar
      return normalizedUrl !== "/" && !normalizedUrl.slice(1).includes("/");
    }
    // Must start with prefix/ and have exactly one more segment
    if (!normalizedUrl.startsWith(prefix + "/")) return false;
    const rest = normalizedUrl.slice(prefix.length + 1);
    // rest should be a single segment (no slashes)
    return rest.length > 0 && !rest.includes("/");
  }

  // Exact match
  return normalizedUrl === normalizedPattern;
}

/**
 * Check if a URL matches any of the given patterns.
 */
export function matchUrlPatterns(url: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchUrlPattern(url, pattern)) return true;
  }
  return false;
}

/**
 * The syntax `matchUrlPattern` understands, for error messages and docs.
 * Anything outside it would otherwise be compared literally and silently
 * never match, so config loading rejects it up front.
 */
export const URL_PATTERN_SYNTAX =
  'Supported URL patterns: an exact path ("/docs"), one segment below a path ("/docs/*"), ' +
  'or a path and everything below it ("/docs/**"). Patterns must start with "/", and "*" or ' +
  '"**" may only appear as the whole final segment. Empty segments ("//") are not allowed.';

/**
 * Explain why a pattern is outside the supported syntax, or return null when
 * `matchUrlPattern` will interpret it as written.
 */
export function describeUnsupportedUrlPattern(pattern: string): string | null {
  if (!pattern.startsWith("/")) {
    return `"${pattern}" must start with "/"; patterns match URL paths, not full URLs or relative paths.`;
  }

  // The matcher compares segments literally, so an empty segment only ever
  // matches a URL that itself contains "//", which a normalized path never does.
  if (pattern.includes("//")) {
    return `"${pattern}" contains an empty path segment ("//"), which never matches a URL path.`;
  }

  const glob = pattern.match(/[?[\]{}]/);
  if (glob) {
    return `"${pattern}" uses "${glob[0]}", which is not supported.`;
  }

  if (!pattern.includes("*")) return null;

  const norm = pattern !== "/" && pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  const segments = norm.split("/");
  const last = segments[segments.length - 1];
  const wildcardElsewhere = segments.slice(0, -1).some((segment) => segment.includes("*"));

  if (wildcardElsewhere || (last !== "*" && last !== "**")) {
    return `"${pattern}" places a wildcard somewhere other than the whole final segment.`;
  }

  return null;
}
