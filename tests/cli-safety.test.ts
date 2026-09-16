/**
 * Behaviour that only shows up in the real process: the order in which `clean`
 * validates versus deletes, and whether the dev watcher actually receives file
 * events now that chokidar no longer expands globs.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "dist", "cli.js");

function config(stateDir?: string): string {
  const state = stateDir === undefined ? "" : `,\n  state: { dir: ${JSON.stringify(stateDir)} }`;
  return `export default {
  project: { id: "cli-safety" },
  scope: { mode: "fixed", fixed: "main", sanitize: false },
  source: {
    mode: "content-files",
    contentFiles: { baseDir: "content", globs: ["**/*.{md,mdx}"] }
  }${state}
};
`;
}

function scaffold(dir: string): void {
  fs.writeFileSync(path.join(dir, "searchsocket.config.ts"), config());
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "cli-safety" }));
  fs.mkdirSync(path.join(dir, "content"), { recursive: true });
  fs.writeFileSync(path.join(dir, "content", "index.md"), "# index\n");
}

function runCli(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, "--cwd", cwd, ...args], {
    encoding: "utf8",
    // The backend is deliberately unconfigured: none of these cases reach it.
    env: { ...process.env, UPSTASH_VECTOR_REST_URL: "", UPSTASH_VECTOR_REST_TOKEN: "" }
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}


/**
 * Run the CLI without blocking the event loop, so a fake backend served from
 * this process can answer it.
 */
function runCliAsync(
  cwd: string,
  args: string[],
  env: Record<string, string>
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--cwd", cwd, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/**
 * A stand-in for the Upstash Vector REST API: `info` fails (an unhealthy
 * backend), `range` answers an empty page, and every other call fails.
 */
async function fakeUpstash(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("/range")) {
        res.end(JSON.stringify({ result: { nextCursor: "", vectors: [] } }));
        return;
      }
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "fake backend failure" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r()))
  };
}

describe("searchsocket CLI safety (real process)", () => {
  let tmpDir: string;

  beforeAll(() => {
    if (!fs.existsSync(cli)) {
      throw new Error('dist/cli.js not found — run "pnpm run build" before this suite.');
    }
  });

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ss-cli-safety-"));
    scaffold(tmpDir);
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  describe("clean", () => {
    it("refuses a missing --confirm-project before touching local state", () => {
      fs.mkdirSync(path.join(tmpDir, ".searchsocket"));
      fs.writeFileSync(path.join(tmpDir, ".searchsocket", "manifest.json"), "{}");

      const { status, stderr } = runCli(tmpDir, ["clean", "--remote", "--all-scopes"]);

      expect(status).toBe(4);
      expect(stderr).toContain("--confirm-project");
      expect(fs.existsSync(path.join(tmpDir, ".searchsocket", "manifest.json"))).toBe(true);
    });

    it("refuses a wrong --confirm-project before touching local state", () => {
      fs.mkdirSync(path.join(tmpDir, ".searchsocket"));

      const { status } = runCli(tmpDir, [
        "clean",
        "--remote",
        "--all-scopes",
        "--confirm-project",
        "not-the-project"
      ]);

      expect(status).toBe(4);
      expect(fs.existsSync(path.join(tmpDir, ".searchsocket"))).toBe(true);
    });

    it("refuses --all-scopes without --remote before touching local state", () => {
      fs.mkdirSync(path.join(tmpDir, ".searchsocket"));

      const { status } = runCli(tmpDir, ["clean", "--all-scopes"]);

      expect(status).toBe(2);
      expect(fs.existsSync(path.join(tmpDir, ".searchsocket"))).toBe(true);
    });

    it("refuses an unusable --scope before touching local state", () => {
      fs.mkdirSync(path.join(tmpDir, ".searchsocket"));

      const { status } = runCli(tmpDir, ["clean", "--remote", "--scope", "bad/name"]);

      expect(status).toBe(2);
      expect(fs.existsSync(path.join(tmpDir, ".searchsocket"))).toBe(true);
    });

    it("deletes the default local state directory when nothing refuses the run", () => {
      fs.mkdirSync(path.join(tmpDir, ".searchsocket"));

      const { status, stdout } = runCli(tmpDir, ["clean"]);

      expect(status).toBe(0);
      expect(stdout).toContain("deleted local state directory");
      // A local-only clean is not plan-first: --remote is what defers deletion.
      expect(stdout).not.toContain("plan:");
      expect(fs.existsSync(path.join(tmpDir, ".searchsocket"))).toBe(false);
    });

    // The bug this closes: the local removal ran before the remote dry-run
    // guard, so a plan run printed "dry-run only" after it had already wiped
    // .searchsocket.
    it("deletes nothing on a --remote dry run and says what it would delete", () => {
      fs.mkdirSync(path.join(tmpDir, ".searchsocket"));
      fs.writeFileSync(path.join(tmpDir, ".searchsocket", "manifest.json"), "{}");

      const { status, stdout } = runCli(tmpDir, ["clean", "--remote"]);

      expect(status).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, ".searchsocket", "manifest.json"))).toBe(true);
      expect(stdout).toContain("plan: delete local state directory");
      expect(stdout).toContain("plan: delete remote records");
      expect(stdout).toContain("dry-run only. pass --apply to delete.");
      expect(stdout).not.toContain("deleted local state directory");
    });

    it("deletes nothing on an --all-scopes dry run", () => {
      fs.mkdirSync(path.join(tmpDir, ".searchsocket"));

      const { status, stdout } = runCli(tmpDir, [
        "clean",
        "--remote",
        "--all-scopes",
        "--confirm-project",
        "cli-safety"
      ]);

      expect(status).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, ".searchsocket"))).toBe(true);
      expect(stdout).toContain("plan: drop ALL scopes");
      expect(stdout).toContain("nothing has been deleted.");
    });

    it("reports a plan for a state directory it would not delete anyway", () => {
      fs.writeFileSync(path.join(tmpDir, "searchsocket.config.ts"), config("content"));

      const { stdout } = runCli(tmpDir, ["clean", "--remote"]);

      expect(stdout).toContain("plan: leave local state directory alone");
      expect(fs.existsSync(path.join(tmpDir, "content", "index.md"))).toBe(true);
    });

    it("honours --keep-local on a dry run and on an applied run", () => {
      fs.mkdirSync(path.join(tmpDir, ".searchsocket"));

      const plan = runCli(tmpDir, ["clean", "--remote", "--keep-local"]);
      expect(plan.status).toBe(0);
      expect(plan.stdout).toContain("plan: keep the local state directory");
      expect(fs.existsSync(path.join(tmpDir, ".searchsocket"))).toBe(true);

      // The backend is unconfigured, so the applied run fails at the remote
      // step — local state must survive that too.
      runCli(tmpDir, ["clean", "--remote", "--keep-local", "--apply"]);
      expect(fs.existsSync(path.join(tmpDir, ".searchsocket"))).toBe(true);
    });

    it("refuses a state.dir that points at the project directory", () => {
      fs.writeFileSync(path.join(tmpDir, "searchsocket.config.ts"), config("."));

      const { status } = runCli(tmpDir, ["clean"]);

      expect(status).not.toBe(0);
      expect(fs.existsSync(path.join(tmpDir, "content", "index.md"))).toBe(true);
    });

    it("leaves a state.dir SearchSocket did not create alone", () => {
      fs.writeFileSync(path.join(tmpDir, "searchsocket.config.ts"), config("content"));

      const { stdout } = runCli(tmpDir, ["clean"]);

      expect(stdout).toContain("left local state directory alone");
      expect(fs.existsSync(path.join(tmpDir, "content", "index.md"))).toBe(true);
    });
  });

  describe("exit codes", () => {
    const testFile = JSON.stringify([{ query: "index", expect: { topResult: "/" } }]);

    it("exits 5 when search runs with no backend configured", () => {
      const { status, stderr } = runCli(tmpDir, ["search", "anything"]);

      expect(status).toBe(5);
      expect(stderr).toContain("not configured");
    });

    it.each([["search", "anything"], ["test"], ["status"]])(
      "exits 2 when the config file does not parse (%s)",
      (...args) => {
        fs.writeFileSync(path.join(tmpDir, "searchsocket.config.ts"), "export default {\n  project: { id: \"x\" ,\n");
        fs.writeFileSync(path.join(tmpDir, "searchsocket.test.json"), testFile);

        const { status, stderr } = runCli(tmpDir, args);
        expect(status).toBe(2);
        expect(stderr).toContain("searchsocket.config.ts");
      }
    );

    it("exits 2 for test --top-k above the engine's bound", () => {
      fs.writeFileSync(path.join(tmpDir, "searchsocket.test.json"), testFile);

      expect(runCli(tmpDir, ["test", "--top-k", "101"]).status).toBe(2);
    });

    it("exits 5 when test runs with no backend configured", () => {
      fs.writeFileSync(path.join(tmpDir, "searchsocket.test.json"), testFile);

      expect(runCli(tmpDir, ["test"]).status).toBe(5);
    });

    it("exits 5, not 3, when the backend fails test's queries", async () => {
      fs.writeFileSync(path.join(tmpDir, "searchsocket.test.json"), testFile);
      const backend = await fakeUpstash();
      try {
        const { status, stdout } = await runCliAsync(tmpDir, ["test"], {
          UPSTASH_VECTOR_REST_URL: backend.url,
          UPSTASH_VECTOR_REST_TOKEN: "fake-token"
        });

        expect(stdout).toContain("search error");
        expect(status).toBe(5);
      } finally {
        await backend.close();
      }
    }, 60_000);

    it("exits 5 when status finds the backend unhealthy", async () => {
      const backend = await fakeUpstash();
      try {
        const { status, stdout } = await runCliAsync(tmpDir, ["status"], {
          UPSTASH_VECTOR_REST_URL: backend.url,
          UPSTASH_VECTOR_REST_TOKEN: "fake-token"
        });

        expect(stdout).toContain("backend health: error");
        expect(stdout).toContain("resolved scope");
        expect(status).toBe(5);
      } finally {
        await backend.close();
      }
    }, 60_000);
  });

  describe("dev watcher", () => {
    let child: ChildProcessWithoutNullStreams | undefined;

    afterEach(async () => {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
      }
      child = undefined;
    });

    // These budgets are generous on purpose. This spawns a real CLI process and
    // waits on wall-clock output while the rest of the suite runs in parallel,
    // so on a loaded machine the child is competing for CPU with dozens of other
    // test files. The assertion is that the watcher *eventually* reacts; a tight
    // budget only measures how busy the machine is.
    async function waitFor(output: () => string, needle: string, timeoutMs: number): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (output().includes(needle)) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    }

    it("reacts to a newly created matching file and ignores a non-matching one", async () => {
      let out = "";
      child = spawn(process.execPath, [cli, "--cwd", tmpDir, "dev", "--no-playground"], {
        env: { ...process.env, UPSTASH_VECTOR_REST_URL: "", UPSTASH_VECTOR_REST_TOKEN: "" }
      }) as ChildProcessWithoutNullStreams;
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });

      // chokidar walks the tree before it reports anything, so wait for the
      // watcher's own ready signal rather than guessing at a delay.
      expect(await waitFor(() => out, "watcher ready", 45_000)).toBe(true);

      fs.writeFileSync(path.join(tmpDir, "content", "notes.txt"), "not indexed\n");
      await new Promise((r) => setTimeout(r, 1000));

      // A dotfile: fast-glob's default excludes it, so the watcher must too.
      fs.writeFileSync(path.join(tmpDir, "content", ".hidden.md"), "# hidden\n");
      await new Promise((r) => setTimeout(r, 1000));

      // A nested directory created after startup, which a one-time glob
      // expansion would never have covered.
      fs.mkdirSync(path.join(tmpDir, "content", "guides"));
      fs.writeFileSync(path.join(tmpDir, "content", "guides", "new.md"), "# new\n");

      expect(await waitFor(() => out, "new.md", 45_000)).toBe(true);
      expect(out).not.toContain("notes.txt");
      expect(out).not.toContain(".hidden.md");

      // The configured glob uses {md,mdx} alternation, which chokidar never saw
      // and the event filter has to expand itself. Written straight after
      // `new.md` into the directory created moments ago: with native events
      // chokidar 5 on macOS intermittently never watches that directory, so
      // this is the case the polled source watcher exists for.
      fs.writeFileSync(path.join(tmpDir, "content", "guides", "other.mdx"), "# other\n");
      expect(await waitFor(() => out, "other.mdx", 45_000)).toBe(true);

      // Deleting it is a change too.
      fs.rmSync(path.join(tmpDir, "content", "guides", "new.md"));
      expect(await waitFor(() => out, "detected unlink", 45_000)).toBe(true);

      const exited = new Promise<void>((resolve) => child!.on("exit", () => resolve()));
      child.kill("SIGINT");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    }, 180_000);
  });
});
