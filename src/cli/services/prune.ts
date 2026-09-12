import type { ScopeInfo } from "../../types";

/**
 * How a scope qualifies as stale when both an orphan check and a TTL check are
 * active.
 *
 * `all` (the default) requires both. The original implementation used an
 * implicit `any`, which deleted the scope of a live, actively developed branch
 * purely because it had not been reindexed recently.
 */
export type PruneMatchMode = "any" | "all";

export interface PruneSelectionInput {
  scopes: ScopeInfo[];
  /** Scope names known to be active. Never empty — see `readRemoteGitBranches`. */
  keepScopes: Set<string>;
  /** Scopes that must never be pruned regardless of any rule. */
  protectedScopes: Set<string>;
  /** TTL cutoff in milliseconds, or undefined to disable the TTL check. */
  olderThanMs?: number;
  matchMode: PruneMatchMode;
  /** Injected so the decision is deterministic and testable. */
  now: number;
}

export interface PruneSelection {
  stale: ScopeInfo[];
  /** Scopes excluded because their age could not be established. */
  skipped: Array<{ scopeName: string; reason: string }>;
}

/**
 * Decide which scopes may be deleted.
 *
 * Pure and side-effect free so the destructive decision can be tested directly
 * rather than only through the CLI.
 */
export function selectStaleScopes(input: PruneSelectionInput): PruneSelection {
  const skipped: PruneSelection["skipped"] = [];

  const stale = input.scopes.filter((entry) => {
    if (input.protectedScopes.has(entry.scopeName)) return false;

    const staleByList = !input.keepScopes.has(entry.scopeName);

    if (input.olderThanMs === undefined) return staleByList;

    if (entry.lastIndexedAt === "unknown") {
      // No trustworthy timestamp. Treating unknown as "old" would delete a
      // scope purely because its age could not be established — and every
      // scope reported "unknown" age before listScopes stopped fabricating it.
      skipped.push({
        scopeName: entry.scopeName,
        reason: "no recorded indexedAt, cannot evaluate --older-than"
      });
      return false;
    }

    const parsed = Date.parse(entry.lastIndexedAt);
    if (Number.isNaN(parsed)) {
      skipped.push({
        scopeName: entry.scopeName,
        reason: `unparseable indexedAt "${entry.lastIndexedAt}"`
      });
      return false;
    }

    const staleByTtl = input.now - parsed > input.olderThanMs;

    return input.matchMode === "any" ? staleByList || staleByTtl : staleByList && staleByTtl;
  });

  return { stale, skipped };
}

/**
 * Turn raw `git branch -r` output into the set of active branch names.
 *
 * Returns `null` whenever the list cannot be trusted, so the caller fails
 * closed instead of concluding that every scope is orphaned.
 */
export function parseRemoteBranches(rawOutput: string, remotes: string[]): Set<string> | null {
  if (remotes.length === 0) return null;

  const names = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^'|'$/g, ""))
    .filter(Boolean)
    // Drop the symbolic remote HEAD, printed bare as "origin". Counting it
    // inflated the branch total and let a one-branch shallow inventory look
    // plausible enough to pass a naive size check.
    .filter((line) => line.includes("/"))
    // Strip whichever remote the ref belongs to, not just "origin/".
    .map((line) => {
      const remote = remotes.find((r) => line.startsWith(`${r}/`));
      return remote ? line.slice(remote.length + 1) : line;
    })
    .filter((name) => name !== "HEAD" && name.length > 0);

  return names.length === 0 ? null : new Set(names);
}

/** Outcome of one scope deletion. `error` is set when the backend rejected it. */
export interface PruneDeletionResult {
  scopeName: string;
  error?: string;
}

export interface PruneDeletionSummary {
  attempted: number;
  deleted: number;
  failed: PruneDeletionResult[];
}

/**
 * Fold per-scope deletion outcomes into the counts `prune --apply` reports and
 * exits on.
 *
 * Split out from the command so the "exit 0 even though every deletion failed"
 * regression is testable without a live backend.
 */
export function summarizePruneDeletions(results: PruneDeletionResult[]): PruneDeletionSummary {
  const failed = results.filter((entry) => entry.error !== undefined);
  return {
    attempted: results.length,
    deleted: results.length - failed.length,
    failed
  };
}
