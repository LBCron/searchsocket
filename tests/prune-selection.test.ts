import { describe, expect, it } from "vitest";
import {
  parseRemoteBranches,
  selectStaleScopes,
  summarizePruneDeletions
} from "../src/cli/services/prune";
import type { ScopeInfo } from "../src/types";

/**
 * `prune --apply` permanently deletes every record in the scopes it selects,
 * so the selection itself is the thing that needs proving.
 */

const NOW = Date.parse("2026-08-18T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function scope(scopeName: string, lastIndexedAt = "unknown"): ScopeInfo {
  return { projectId: "proj", scopeName, lastIndexedAt, documentCount: 1 };
}

const base = {
  protectedScopes: new Set(["main"]),
  matchMode: "all" as const,
  now: NOW
};

describe("selectStaleScopes", () => {
  it("selects a scope with no matching branch", () => {
    const { stale } = selectStaleScopes({
      ...base,
      scopes: [scope("feature-gone"), scope("feature-live")],
      keepScopes: new Set(["feature-live"])
    });

    expect(stale.map((s) => s.scopeName)).toEqual(["feature-gone"]);
  });

  it("never selects a protected scope, even when orphaned", () => {
    const { stale } = selectStaleScopes({
      ...base,
      protectedScopes: new Set(["main", "staging"]),
      scopes: [scope("main"), scope("staging"), scope("gone")],
      keepScopes: new Set(["something-else"])
    });

    expect(stale.map((s) => s.scopeName)).toEqual(["gone"]);
  });

  it("requires both orphaned AND inactive by default", () => {
    const recent = new Date(NOW - DAY).toISOString();
    const old = new Date(NOW - 60 * DAY).toISOString();

    const { stale } = selectStaleScopes({
      ...base,
      scopes: [
        scope("orphaned-but-recent", recent),
        scope("live-but-old", old),
        scope("orphaned-and-old", old)
      ],
      keepScopes: new Set(["live-but-old"]),
      olderThanMs: 30 * DAY
    });

    // An active branch that simply has not been reindexed lately must survive.
    expect(stale.map((s) => s.scopeName)).toEqual(["orphaned-and-old"]);
  });

  it("accepts either condition under match: any", () => {
    const recent = new Date(NOW - DAY).toISOString();
    const old = new Date(NOW - 60 * DAY).toISOString();

    const { stale } = selectStaleScopes({
      ...base,
      matchMode: "any",
      scopes: [scope("orphaned-but-recent", recent), scope("live-but-old", old)],
      keepScopes: new Set(["live-but-old"]),
      olderThanMs: 30 * DAY
    });

    expect(stale.map((s) => s.scopeName).sort()).toEqual(["live-but-old", "orphaned-but-recent"]);
  });

  it("skips a scope whose age is unknown rather than assuming it is old", () => {
    // Before listScopes stopped fabricating timestamps this was every scope.
    const { stale, skipped } = selectStaleScopes({
      ...base,
      scopes: [scope("no-timestamp", "unknown")],
      keepScopes: new Set(["other"]),
      olderThanMs: 30 * DAY
    });

    expect(stale).toEqual([]);
    expect(skipped).toEqual([
      { scopeName: "no-timestamp", reason: "no recorded indexedAt, cannot evaluate --older-than" }
    ]);
  });

  it("skips a scope with an unparseable timestamp", () => {
    const { stale, skipped } = selectStaleScopes({
      ...base,
      scopes: [scope("broken", "not-a-date")],
      keepScopes: new Set(["other"]),
      olderThanMs: 30 * DAY
    });

    expect(stale).toEqual([]);
    expect(skipped[0]!.reason).toContain("unparseable");
  });

  it("ignores unknown timestamps entirely when no TTL is requested", () => {
    const { stale, skipped } = selectStaleScopes({
      ...base,
      scopes: [scope("orphaned", "unknown")],
      keepScopes: new Set(["other"])
    });

    expect(stale.map((s) => s.scopeName)).toEqual(["orphaned"]);
    expect(skipped).toEqual([]);
  });

  it("selects nothing when every scope has a live branch", () => {
    const { stale } = selectStaleScopes({
      ...base,
      scopes: [scope("a"), scope("b")],
      keepScopes: new Set(["a", "b"])
    });

    expect(stale).toEqual([]);
  });

  it("treats a scope exactly at the TTL boundary as not yet stale", () => {
    const exactly = new Date(NOW - 30 * DAY).toISOString();
    const { stale } = selectStaleScopes({
      ...base,
      scopes: [scope("edge", exactly)],
      keepScopes: new Set(["other"]),
      olderThanMs: 30 * DAY
    });

    expect(stale).toEqual([]);
  });
});

describe("parseRemoteBranches", () => {
  it("strips the remote prefix", () => {
    const result = parseRemoteBranches("origin/main\norigin/develop\n", ["origin"]);
    expect(result).toEqual(new Set(["main", "develop"]));
  });

  it("strips a non-origin remote's prefix", () => {
    const result = parseRemoteBranches("upstream/main\nfork/feature-x\n", ["upstream", "fork"]);
    expect(result).toEqual(new Set(["main", "feature-x"]));
  });

  it("drops the symbolic remote HEAD", () => {
    // `git branch -r` prints the remote HEAD as a bare remote name. Counting it
    // inflated the branch total, so a shallow one-branch inventory looked
    // plausible while marking every other scope orphaned.
    const result = parseRemoteBranches("origin\norigin/main\n", ["origin"]);
    expect(result).toEqual(new Set(["main"]));
  });

  it("drops an explicit HEAD ref", () => {
    const result = parseRemoteBranches("origin/HEAD\norigin/main\n", ["origin"]);
    expect(result).toEqual(new Set(["main"]));
  });

  it("strips the quoting git applies to --format", () => {
    const result = parseRemoteBranches("'origin/main'\n'origin/dev'\n", ["origin"]);
    expect(result).toEqual(new Set(["main", "dev"]));
  });

  it("returns null when there are no remotes", () => {
    expect(parseRemoteBranches("origin/main\n", [])).toBeNull();
  });

  it("returns null when nothing usable remains", () => {
    // Fails closed: an empty set would mark every live scope orphaned.
    expect(parseRemoteBranches("", ["origin"])).toBeNull();
    expect(parseRemoteBranches("origin\n", ["origin"])).toBeNull();
    expect(parseRemoteBranches("origin/HEAD\n", ["origin"])).toBeNull();
  });

  it("keeps branch names containing slashes", () => {
    const result = parseRemoteBranches("origin/feature/nested\n", ["origin"]);
    expect(result).toEqual(new Set(["feature/nested"]));
  });
});

describe("summarizePruneDeletions", () => {
  it("counts a clean run as fully deleted", () => {
    const summary = summarizePruneDeletions([{ scopeName: "a" }, { scopeName: "b" }]);
    expect(summary).toEqual({ attempted: 2, deleted: 2, failed: [] });
  });

  it("separates failures so the caller can exit non-zero", () => {
    const summary = summarizePruneDeletions([
      { scopeName: "a" },
      { scopeName: "b", error: "429 too many requests" }
    ]);

    expect(summary.attempted).toBe(2);
    expect(summary.deleted).toBe(1);
    expect(summary.failed).toEqual([{ scopeName: "b", error: "429 too many requests" }]);
  });

  it("reports zero deletions when every scope failed", () => {
    const summary = summarizePruneDeletions([
      { scopeName: "a", error: "boom" },
      { scopeName: "b", error: "boom" }
    ]);

    expect(summary.deleted).toBe(0);
    expect(summary.failed).toHaveLength(2);
  });
});
