import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { SearchSocketError } from "../errors";
import type { Scope } from "../types";

/** Mirrors `state.dir` in config/defaults.ts. */
export const DEFAULT_STATE_DIR = ".searchsocket";

/**
 * Ownership marker written into every state directory SearchSocket creates.
 *
 * `clean` refuses to remove a non-default `state.dir` that does not carry it,
 * so a mistyped or inherited path pointing at somebody else's data cannot be
 * recursively deleted by a command the user thinks only clears a cache.
 */
export const STATE_MARKER_FILE = ".searchsocket-state";

const MARKER_CONTENT =
  "SearchSocket state directory. Safe to delete; recreated on the next index run.\n";

/**
 * Canonicalize `target`, or return null when the OS cannot.
 *
 * `realpathSync.native` rather than `realpathSync`: only the native call
 * canonicalizes the spelling of a path on a case-insensitive filesystem. The
 * JS implementation returns `/users/gpriday` unchanged, which is a different
 * string from `/Users/gpriday` and therefore invisible to a prefix comparison
 * — a state.dir spelled in the wrong case walked straight past the ancestor
 * guard on macOS.
 */
function canonicalize(target: string): string | null {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

/**
 * Canonicalize as much of `target` as exists and re-append the rest, so a state
 * directory that has not been created yet is still compared in the project's
 * own coordinate system.
 */
function canonicalizeExistingPrefix(target: string): string {
  const missing: string[] = [];
  let current = target;

  for (;;) {
    const real = canonicalize(current);
    if (real !== null) return path.join(real, ...missing.reverse());

    const parent = path.dirname(current);
    if (parent === current) return target;
    missing.push(path.basename(current));
    current = parent;
  }
}

function refuse(statePath: string, why: string): never {
  throw new SearchSocketError(
    "INVALID_REQUEST",
    `state.dir resolves to ${statePath}, which ${why}. Point state.dir at a dedicated subdirectory such as "${DEFAULT_STATE_DIR}".`,
    400
  );
}

/**
 * Resolve `state.dir` to the one absolute path both creation and deletion use.
 *
 * Creation previously used `path.resolve` while `clean` used `path.join`, so an
 * absolute `state.dir` was created in one place and deleted from another. The
 * dangerous-target guards live here rather than at the call sites because the
 * deletion is recursive and unattended: `state.dir: "."` is a valid string that
 * targets the project itself, and `".."` targets its parent.
 */
export function resolveStateDir(cwd: string, stateDir: string): string {
  // Deliberately not trimmed into the resolved value: on POSIX ".searchsocket "
  // is a different directory from ".searchsocket", and silently rewriting one
  // to the other would also hand it the default directory's marker exemption.
  if (stateDir.trim() === "") {
    throw new SearchSocketError("INVALID_REQUEST", "state.dir must not be empty", 400);
  }

  const projectRoot = path.resolve(cwd);
  const statePath = path.resolve(projectRoot, stateDir);

  const canonicalProjectRoot = canonicalize(projectRoot);
  if (canonicalProjectRoot === null) {
    // Without a canonical project root there is nothing to measure the target
    // against, and a guard that cannot be evaluated must not be assumed to pass.
    throw new SearchSocketError(
      "INVALID_REQUEST",
      `Cannot resolve the project directory ${projectRoot}, so state.dir cannot be checked for safety.`,
      400
    );
  }

  // Check the literal path and the canonicalized path: a state dir that is (or
  // lives behind) a symlink to an ancestor passes the literal check unharmed.
  const candidates: Array<[root: string, target: string]> = [
    [projectRoot, statePath],
    [canonicalProjectRoot, canonicalizeExistingPrefix(statePath)]
  ];

  for (const [root, target] of candidates) {
    if (target === path.parse(target).root) {
      refuse(statePath, "is the filesystem root");
    }
    if (target === root) {
      refuse(statePath, "is the project directory itself");
    }
    if (root.startsWith(target + path.sep)) {
      refuse(statePath, "contains the project directory");
    }
  }

  return statePath;
}

export function ensureStateDirs(cwd: string, stateDir: string, scope: Scope): {
  statePath: string;
} {
  const statePath = resolveStateDir(cwd, stateDir);

  // Only a directory SearchSocket brought into existence (or an empty one it is
  // adopting) gets the marker. Stamping whatever `state.dir` happens to name
  // would hand `clean` the right to recursively delete a directory full of the
  // user's own files — `state.dir: "content"` plus one `index --dry-run` was
  // enough to re-open exactly the hole the marker exists to close.
  const claimable = !fs.existsSync(statePath) || fs.readdirSync(statePath).length === 0;

  fs.mkdirSync(statePath, { recursive: true });

  const marker = path.join(statePath, STATE_MARKER_FILE);
  if (claimable && !fs.existsSync(marker)) {
    fs.writeFileSync(marker, MARKER_CONTENT);
  }

  return { statePath };
}

export interface StateDirRemoval {
  /** The exact path considered, so the caller can show what it acted on. */
  statePath: string;
  removed: boolean;
  /** Why nothing was removed. Only set when `removed` is false. */
  reason?: string;
}

/**
 * Delete the local state directory, or explain why it was left alone.
 *
 * `remove` is injectable so the refusal paths can be asserted without a real
 * recursive delete standing behind them.
 */
export async function removeStateDir(
  cwd: string,
  stateDir: string,
  remove: (target: string) => Promise<void> = (target) =>
    fsp.rm(target, { recursive: true, force: true })
): Promise<StateDirRemoval> {
  const statePath = resolveStateDir(cwd, stateDir);

  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(statePath);
  } catch {
    return { statePath, removed: false, reason: "directory does not exist" };
  }

  if (stats.isSymbolicLink()) {
    return {
      statePath,
      removed: false,
      reason: "state directory is a symlink; remove it by hand so the target is not deleted by surprise"
    };
  }

  if (!stats.isDirectory()) {
    return { statePath, removed: false, reason: "state path is not a directory" };
  }

  const isDefault = statePath === path.resolve(cwd, DEFAULT_STATE_DIR);
  if (!isDefault && !fs.existsSync(path.join(statePath, STATE_MARKER_FILE))) {
    return {
      statePath,
      removed: false,
      reason: `no ${STATE_MARKER_FILE} marker — SearchSocket did not create this directory`
    };
  }

  await remove(statePath);
  return { statePath, removed: true };
}
