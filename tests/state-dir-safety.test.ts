/**
 * `clean` deletes the state directory recursively and unattended, so the guards
 * that decide what it may point at are tested with the real removal stubbed out
 * — an assertion that fires only after a wrong delete has happened is no use.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STATE_DIR,
  STATE_MARKER_FILE,
  ensureStateDirs,
  removeStateDir,
  resolveStateDir
} from "../src/core/state";
import { searchSocketConfigSchema } from "../src/config/schema";
import { SearchSocketError } from "../src/errors";
import type { Scope } from "../src/types";

const scope: Scope = { projectId: "test", scopeName: "main", scopeId: "test:main" };
const tempDirs: string[] = [];

async function makeProject(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ss-state-safety-"));
  tempDirs.push(dir);
  // The parent of the project, so "../" targets can be asserted without
  // reaching outside the temp tree.
  const project = path.join(dir, "project");
  fs.mkdirSync(project);
  return project;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

describe("resolveStateDir", () => {
  it("resolves a relative dir the same way creation does", async () => {
    const cwd = await makeProject();
    expect(resolveStateDir(cwd, DEFAULT_STATE_DIR)).toBe(path.resolve(cwd, DEFAULT_STATE_DIR));
  });

  it("resolves an absolute dir to itself, matching path.resolve rather than path.join", async () => {
    const cwd = await makeProject();
    const absolute = path.join(path.dirname(cwd), "elsewhere");
    expect(resolveStateDir(cwd, absolute)).toBe(absolute);
  });

  it.each([".", "./"])("refuses the project directory itself (%s)", async (dir) => {
    const cwd = await makeProject();
    expect(() => resolveStateDir(cwd, dir)).toThrow(SearchSocketError);
  });

  it("refuses the project's parent", async () => {
    const cwd = await makeProject();
    expect(() => resolveStateDir(cwd, "..")).toThrow(/contains the project directory/);
  });

  it("refuses a deeper ancestor", async () => {
    const cwd = await makeProject();
    expect(() => resolveStateDir(cwd, "../..")).toThrow(SearchSocketError);
  });

  it("refuses the filesystem root", async () => {
    const cwd = await makeProject();
    expect(() => resolveStateDir(cwd, path.parse(cwd).root)).toThrow(/filesystem root/);
  });

  it("refuses an empty dir", async () => {
    const cwd = await makeProject();
    expect(() => resolveStateDir(cwd, "   ")).toThrow(/must not be empty/);
  });

  it("refuses an ancestor spelled in a different case on a case-insensitive filesystem", async () => {
    const cwd = await makeProject();
    const parent = path.dirname(cwd);
    const swapped = path.join(path.dirname(parent), path.basename(parent).toUpperCase());

    // Only meaningful where the filesystem actually resolves both spellings.
    if (!fs.existsSync(swapped)) return;

    expect(() => resolveStateDir(cwd, swapped)).toThrow(SearchSocketError);
  });

  it("refuses when the project directory cannot be canonicalized", () => {
    const missing = path.join(os.tmpdir(), "ss-does-not-exist-9f2c1a", "project");
    expect(() => resolveStateDir(missing, ".searchsocket")).toThrow(/Cannot resolve the project/);
  });

  it("refuses a symlink that points at an ancestor", async () => {
    const cwd = await makeProject();
    fs.symlinkSync(path.dirname(cwd), path.join(cwd, "sneaky"), "dir");
    expect(() => resolveStateDir(cwd, "sneaky")).toThrow(SearchSocketError);
  });
});

describe("ensureStateDirs", () => {
  it("creates the directory and stamps it with an ownership marker", async () => {
    const cwd = await makeProject();
    const { statePath } = ensureStateDirs(cwd, DEFAULT_STATE_DIR, scope);
    expect(fs.existsSync(path.join(statePath, STATE_MARKER_FILE))).toBe(true);
  });

  it("refuses to create a state dir at a dangerous target", async () => {
    const cwd = await makeProject();
    expect(() => ensureStateDirs(cwd, "..", scope)).toThrow(SearchSocketError);
  });

  it("does not claim an existing directory that already holds the user's files", async () => {
    // Otherwise `state.dir: "content"` plus a single index run would hand
    // `clean` permission to recursively delete the site's source content.
    const cwd = await makeProject();
    fs.mkdirSync(path.join(cwd, "content"));
    fs.writeFileSync(path.join(cwd, "content", "intro.md"), "# hi\n");

    const { statePath } = ensureStateDirs(cwd, "content", scope);

    expect(fs.existsSync(path.join(statePath, STATE_MARKER_FILE))).toBe(false);
  });

  it("adopts an existing but empty directory", async () => {
    const cwd = await makeProject();
    fs.mkdirSync(path.join(cwd, "cache"));

    const { statePath } = ensureStateDirs(cwd, "cache", scope);

    expect(fs.existsSync(path.join(statePath, STATE_MARKER_FILE))).toBe(true);
  });
});

describe("removeStateDir", () => {
  it("removes the default directory", async () => {
    const cwd = await makeProject();
    ensureStateDirs(cwd, DEFAULT_STATE_DIR, scope);
    const remove = vi.fn(async () => {});

    const result = await removeStateDir(cwd, DEFAULT_STATE_DIR, remove);

    expect(result.removed).toBe(true);
    expect(remove).toHaveBeenCalledWith(path.resolve(cwd, DEFAULT_STATE_DIR));
  });

  it("removes a custom directory that carries the marker", async () => {
    const cwd = await makeProject();
    ensureStateDirs(cwd, "cache/ss", scope);
    const remove = vi.fn(async () => {});

    const result = await removeStateDir(cwd, "cache/ss", remove);

    expect(result.removed).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("never deletes a custom directory SearchSocket did not create", async () => {
    const cwd = await makeProject();
    fs.mkdirSync(path.join(cwd, "docs"));
    fs.writeFileSync(path.join(cwd, "docs", "intro.md"), "# hi\n");
    const remove = vi.fn(async () => {});

    const result = await removeStateDir(cwd, "docs", remove);

    expect(result.removed).toBe(false);
    expect(result.reason).toContain(STATE_MARKER_FILE);
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([".", "..", "../.."])("never deletes the dangerous target %s", async (dir) => {
    const cwd = await makeProject();
    const remove = vi.fn(async () => {});

    await expect(removeStateDir(cwd, dir, remove)).rejects.toThrow(SearchSocketError);
    expect(remove).not.toHaveBeenCalled();
  });

  it("never follows a symlinked state directory", async () => {
    const cwd = await makeProject();
    const real = path.join(cwd, "real-state");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, STATE_MARKER_FILE), "x");
    fs.symlinkSync(real, path.join(cwd, "linked-state"), "dir");
    const remove = vi.fn(async () => {});

    const result = await removeStateDir(cwd, "linked-state", remove);

    expect(result.removed).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("reports a missing directory instead of removing anything", async () => {
    const cwd = await makeProject();
    const remove = vi.fn(async () => {});

    const result = await removeStateDir(cwd, DEFAULT_STATE_DIR, remove);

    expect(result.removed).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("state.dir config validation", () => {
  it.each([".", "./", "", "  "])("rejects %j", (dir) => {
    expect(searchSocketConfigSchema.safeParse({ state: { dir } }).success).toBe(false);
  });

  // A sibling directory is a legitimate place for state, and rejecting the
  // relative spelling while accepting the absolute one would be a spelling
  // rule, not containment. resolveStateDir decides ancestry.
  it.each([DEFAULT_STATE_DIR, "cache/ss", "/var/tmp/ss", "../shared-state"])(
    "accepts %j",
    (dir) => {
      expect(searchSocketConfigSchema.safeParse({ state: { dir } }).success).toBe(true);
    }
  );

  it("does not rewrite a value with significant whitespace", () => {
    const parsed = searchSocketConfigSchema.parse({ state: { dir: ".searchsocket " } });
    expect(parsed.state?.dir).toBe(".searchsocket ");
  });
});
