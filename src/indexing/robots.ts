import fs from "node:fs/promises";
import path from "node:path";
import { boundedFetch, BoundedFetchError } from "../utils/fetch";

export interface RobotsTxtRules {
  disallow: string[];
  allow: string[];
}

/**
 * Parse a robots.txt string for a specific user-agent.
 * Checks `Searchsocket` first, then falls back to `*`.
 */
export function parseRobotsTxt(content: string, userAgent = "Searchsocket"): RobotsTxtRules {
  const lines = content.split(/\r?\n/);

  // Group rules by user-agent
  const agentGroups = new Map<string, RobotsTxtRules>();
  let currentAgents: string[] = [];
  // Whether the group currently being accumulated has seen any allow/disallow
  // line yet — used to decide when a new user-agent line starts a new group.
  let currentGroupHasRules = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (directive === "user-agent") {
      // Per RFC 9309, consecutive user-agent lines share one group, but a
      // user-agent line that *follows* rule lines starts a new group. Without
      // this reset the extremely common pattern
      //
      //   User-agent: *
      //   Disallow: /admin
      //   User-agent: GPTBot
      //   Disallow: /
      //
      // leaked the site-wide block into the `*` group and excluded the entire
      // site from indexing.
      if (currentGroupHasRules) {
        currentAgents = [];
        currentGroupHasRules = false;
      }

      const agentName = value.toLowerCase();
      currentAgents.push(agentName);
      if (!agentGroups.has(agentName)) {
        agentGroups.set(agentName, { disallow: [], allow: [] });
      }
    } else if (directive === "disallow" || directive === "allow") {
      // An empty value ("Disallow:" meaning allow-all) carries no path, but it
      // still counts as a rule line for the purpose of splitting groups.
      currentGroupHasRules = true;

      if (value && currentAgents.length > 0) {
        for (const agent of currentAgents) {
          agentGroups.get(agent)![directive].push(value);
        }
      }
    }
    // Any other directive (sitemap, crawl-delay, host, ...) is ignored and
    // leaves the current group intact — crawl-delay in particular is commonly
    // written *inside* a group, and dropping the group there discarded every
    // rule that followed it.
  }

  // Check for specific user-agent first, then fallback to *
  const specific = agentGroups.get(userAgent.toLowerCase());
  if (specific && (specific.disallow.length > 0 || specific.allow.length > 0)) {
    return specific;
  }

  return agentGroups.get("*") ?? { disallow: [], allow: [] };
}

/**
 * Put a rule and a URL path into one comparable encoding (RFC 9309 §2.2.2).
 *
 * Everything is canonicalized *up*, never decoded: escapes keep their form with
 * uppercase hex and anything outside printable ASCII becomes its UTF-8 octets.
 * Decoding instead would let an escape turn into syntax — `%2A` becoming a
 * wildcard, `%2F` becoming a path separator — so a rule written to allow one
 * literal URL would start allowing a whole subtree.
 */
function canonicalizeForMatch(value: string): string {
  return value.replace(/%[0-9a-fA-F]{2}|[\s\S]/gu, (token) => {
    if (token.length === 3) return token.toUpperCase();
    const code = token.codePointAt(0)!;
    // A bare `%` that did not start a valid escape is encoded as one, so a
    // malformed rule still compares against an equally malformed path.
    if (code > 0x20 && code < 0x7f && token !== "%") return token;
    return [...Buffer.from(token, "utf8")]
      .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
      .join("");
  });
}

interface CompiledPattern {
  /** Literal runs between the pattern's `*` wildcards. */
  segments: string[];
  /** Whether the pattern ended in `$` and must therefore match to end of path. */
  anchored: boolean;
  /** Canonical length, used as the specificity score. */
  length: number;
}

/**
 * Compile a robots path pattern: `*` matches any run of characters and a
 * trailing `$` anchors the end of the path (RFC 9309 §2.2.3).
 *
 * Deliberately not a regular expression. `Disallow: /*a*a*a...` compiles to a
 * chain of `.*` that backtracks exponentially, and a robots.txt is fetched from
 * the site being crawled — one hostile rule would hang the run on a string
 * comparison. The segment walk below is bounded.
 */
function compilePattern(pattern: string): CompiledPattern {
  const canonical = canonicalizeForMatch(pattern);
  const anchored = canonical.endsWith("$");
  const body = anchored ? canonical.slice(0, -1) : canonical;
  return { segments: body.split("*"), anchored, length: canonical.length };
}

const patternCache = new Map<string, CompiledPattern>();

function compile(pattern: string): CompiledPattern {
  let compiled = patternCache.get(pattern);
  if (!compiled) {
    compiled = compilePattern(pattern);
    patternCache.set(pattern, compiled);
  }
  return compiled;
}

/**
 * Match a compiled pattern against an already-canonical path.
 *
 * Leftmost-first is optimal for `*`-only patterns: consuming the least text for
 * an earlier segment can never lose a match for a later one.
 */
function matches(urlPath: string, compiled: CompiledPattern): boolean {
  const { segments, anchored } = compiled;
  const first = segments[0]!;
  if (!urlPath.startsWith(first)) return false;

  let pos = first.length;
  if (segments.length === 1) return anchored ? pos === urlPath.length : true;

  for (let i = 1; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    if (segment === "") continue;
    const found = urlPath.indexOf(segment, pos);
    if (found === -1) return false;
    pos = found + segment.length;
  }

  const last = segments[segments.length - 1]!;
  if (last === "") return true;
  if (anchored) {
    const start = urlPath.length - last.length;
    return start >= pos && urlPath.startsWith(last, start);
  }
  return urlPath.indexOf(last, pos) !== -1;
}

/** Specificity of a matching rule, or -1 when it does not match. */
function matchLength(urlPath: string, pattern: string): number {
  const compiled = compile(pattern);
  // Specificity is the length of the rule, per RFC 9309 §2.2.2, not the length
  // of the text it consumed — otherwise a one-character `*` pattern would
  // outrank a long explicit path.
  return matches(urlPath, compiled) ? compiled.length : -1;
}

/**
 * Check if a URL path is blocked by robots.txt rules.
 *
 * The most specific (longest) matching rule wins; an allow rule wins a tie.
 */
export function isBlockedByRobots(urlPath: string, rules: RobotsTxtRules): boolean {
  const canonicalPath = canonicalizeForMatch(urlPath);

  let longestDisallow = -1;
  for (const pattern of rules.disallow) {
    longestDisallow = Math.max(longestDisallow, matchLength(canonicalPath, pattern));
  }

  if (longestDisallow < 0) return false;

  let longestAllow = -1;
  for (const pattern of rules.allow) {
    longestAllow = Math.max(longestAllow, matchLength(canonicalPath, pattern));
  }

  return longestAllow < longestDisallow;
}

/**
 * Load and parse robots.txt from a directory (for static-output/build modes).
 * Returns null if the file doesn't exist.
 */
export async function loadRobotsTxtFromDir(dir: string): Promise<RobotsTxtRules | null> {
  try {
    const content = await fs.readFile(path.join(dir, "robots.txt"), "utf8");
    return parseRobotsTxt(content);
  } catch {
    return null;
  }
}

/**
 * Outcome of trying to read a site's robots.txt over the network.
 *
 * `absent` and `unavailable` are kept apart because they mean opposite things:
 * a 404 is the site stating that it publishes no rules, while a timeout or a
 * 5xx means the publication policy is unknown. Collapsing both into "no rules"
 * lets a transient outage silently index pages the operator excluded.
 */
export type RobotsFetchResult =
  | { status: "rules"; rules: RobotsTxtRules }
  | { status: "absent" }
  | { status: "unavailable"; reason: string };

/**
 * RFC 9309 §2.5 asks crawlers to parse at least 500 KiB of a robots.txt. A file
 * beyond that is treated as unreadable rather than truncated: acting on half a
 * policy is the failure mode this whole path exists to avoid.
 */
const ROBOTS_MAX_BYTES = 512 * 1024;

/**
 * Fetch and parse robots.txt from a URL (for crawl mode).
 *
 * Bounded like every other indexing-time fetch: a deadline, a size cap, and an
 * explicit redirect policy. RFC 9309 §2.3.1.2 suggests following robots.txt
 * redirects across authorities, but a redirect off the crawl origin is exactly
 * how a compromised hop would hand us a permissive policy written for someone
 * else's site, so a cross-origin hop fails closed here instead.
 */
export async function fetchRobotsTxt(baseUrl: string): Promise<RobotsFetchResult> {
  let url: string;
  let origin: string;
  try {
    const resolved = new URL("/robots.txt", baseUrl);
    url = resolved.href;
    origin = resolved.origin;
  } catch {
    return { status: "unavailable", reason: `cannot resolve robots.txt against ${baseUrl}` };
  }

  try {
    const response = await boundedFetch(url, {
      allowedOrigin: origin,
      accept: "text/plain",
      redirectPolicy: "same-origin",
      maxBytes: ROBOTS_MAX_BYTES
    });
    return { status: "rules", rules: parseRobotsTxt(response.body.toString("utf8")) };
  } catch (error) {
    if (error instanceof BoundedFetchError) {
      // 404/410 is how a site says "no rules here". RFC 9309 §2.3.1.3 lets a
      // crawler read every other 4xx the same way, but 401 and 403 mean a
      // policy exists and is being withheld — deliberately treated here as
      // unknown rather than as permission to index the site.
      if (error.kind === "http" && (error.status === 404 || error.status === 410)) {
        return { status: "absent" };
      }
      return { status: "unavailable", reason: error.message };
    }
    return {
      status: "unavailable",
      reason: `${url}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
