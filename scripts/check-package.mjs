#!/usr/bin/env node
/**
 * Verify the published tarball is complete and contains nothing it shouldn't.
 *
 * `pnpm run test` exercises the source tree, which resolves imports that the
 * package may not actually ship. The `./svelte` subpath is the standing example:
 * it publishes raw TypeScript, so adding an import to `src/svelte/*` silently
 * breaks the installed package while every local test stays green. That is
 * exactly how v0.7.1 shipped broken.
 *
 * Run after `pnpm run build`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

/** Files the tarball must contain for each declared export to resolve. */
function requiredFiles() {
  const required = new Set();

  for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) {
    for (const target of Object.values(entry)) {
      if (typeof target === "string") {
        required.add(target.replace(/^\.\//, ""));
      }
    }
    void subpath;
  }

  if (pkg.bin) {
    for (const target of Object.values(pkg.bin)) {
      required.add(String(target).replace(/^\.\//, ""));
    }
  }

  return [...required];
}

/**
 * Every local file the raw-source `./svelte` subpath imports, transitively.
 *
 * These are shipped as source, so the tarball needs each one — but `files`
 * lists them by hand, and nothing else notices when a new import is added.
 */
function svelteSourceDependencies() {
  const found = new Set();
  const seen = new Set();
  const queue = [];

  for (const entry of Object.values(pkg.exports?.["./svelte"] ?? {})) {
    if (typeof entry === "string") queue.push(entry.replace(/^\.\//, ""));
  }

  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);

    const abs = path.join(root, file);
    if (!existsSync(abs)) continue;
    const source = readFileSync(abs, "utf8");

    for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const specifier = match[1];
      const resolvedBase = path.join(path.dirname(file), specifier);

      for (const candidate of [
        resolvedBase,
        `${resolvedBase}.ts`,
        `${resolvedBase}.svelte`,
        `${resolvedBase}.svelte.ts`,
        path.join(resolvedBase, "index.ts")
      ]) {
        if (existsSync(path.join(root, candidate))) {
          found.add(candidate);
          queue.push(candidate);
          break;
        }
      }
    }
  }

  return [...found];
}

/**
 * Entry points a browser bundler must be able to resolve, and the Node-only code
 * that proves it cannot.
 *
 * `searchsocket/sveltekit` re-exports the server handle, the Vite plugin AND
 * `searchsocketScrollToText` from one module, so a browser importing the scroll
 * helper from there drags in `fs/promises`, `child_process` and the MCP SDK, and
 * the Vite build fails on `createRequire` from `__vite-browser-external`.
 * `searchsocket/scroll` and `searchsocket/client` exist so that import has a
 * home, and this check is what keeps them clean.
 *
 * WHAT THIS PROVES, EXACTLY: the built ESM file for each browser subpath contains
 * no import of a `node:`-prefixed specifier, no import of a bare Node builtin
 * name, and no `createRequire`/`require(` call. Both entries are bundled into a
 * single file by the current tsup config, so today that scan reaches everything
 * they pull in.
 *
 * WHAT IT DOES NOT PROVE: it is a text scan, not a browser build. Nothing here
 * enforces that the entries stay bundled, so a future externalised dependency
 * would move code out of the file and out of this check's reach; it cannot see
 * a builtin reached through a bare dependency the bundle chose to externalise,
 * and a matching string inside a comment or a string literal would be reported
 * as a problem. It says nothing about the server entries, which are expected to
 * be full of this.
 */
const BROWSER_SAFE_SUBPATHS = ["./client", "./scroll"];

/** Bare builtin names, for the specifiers that omit the `node:` prefix. */
const NODE_BUILTINS = [
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http",
  "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process",
  "punycode", "querystring", "readline", "repl", "sqlite", "stream", "string_decoder",
  "test", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi",
  "worker_threads", "zlib"
];

function browserEntryProblems() {
  const problems = [];
  const bare = NODE_BUILTINS.join("|");
  // Anything `node:`-prefixed is a builtin by definition, so match that whole
  // namespace rather than a name list; bare names still need the list. The
  // trailing class allows the `fs/promises`, `stream/web`, `util/types` forms.
  const patterns = [
    // Digits belong in builtin names (`node:v8`, `node:http2`); a letters-only
    // class silently let both through.
    [/(?:^|[\s;{(,])(?:from|import|require)\s*\(?\s*["'`]node:[a-z0-9_/]+["'`]/g, null],
    [new RegExp(`(?:^|[\\s;{(,])(?:from|import|require)\\s*\\(?\\s*["'\`](?:${bare})(?:/[a-z0-9]+)?["'\`]`, "g"), null],
    [/\bcreateRequire\b/g, "createRequire"],
    [/\brequire\s*\(/g, "require("]
  ];

  for (const subpath of BROWSER_SAFE_SUBPATHS) {
    const entry = pkg.exports?.[subpath];
    if (!entry) {
      problems.push(`missing browser entry: package.json "exports" has no ${subpath}`);
      continue;
    }

    // Only the ESM build: a browser bundler never reaches the CJS one, and that
    // file legitimately contains CommonJS plumbing.
    const target = typeof entry.import === "string" ? entry.import : null;
    if (!target) {
      problems.push(`missing browser entry: ${subpath} declares no "import" condition`);
      continue;
    }

    const file = target.replace(/^\.\//, "");
    const abs = path.join(root, file);
    if (!existsSync(abs)) {
      // Absence is already reported by the packed-file check; do not double up.
      continue;
    }

    const source = readFileSync(abs, "utf8");
    const hits = new Set();
    for (const [pattern, label] of patterns) {
      for (const match of source.matchAll(pattern)) {
        hits.add(label ?? match[0].trim().replace(/^[\s;{(,]+/, ""));
      }
    }

    if (hits.size > 0) {
      problems.push(
        `${file} — the browser entry ${subpath} references Node-only code ` +
          `(${[...hits].join(", ")}); a browser build of it will fail`
      );
    }
  }

  return problems;
}

function packedFiles() {
  // The file listing goes to stderr as `npm notice` lines, while the `prepare`
  // build hook writes to stdout — so `--json` is not parseable here and the
  // listing has to be read from stderr.
  const result = spawnSync("npm", ["pack", "--dry-run", "--loglevel", "notice"], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    throw new Error("`npm pack --dry-run` failed");
  }
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;

  const files = [];
  for (const line of output.split(/\r?\n/)) {
    // "npm notice 1.2kB dist/index.js"
    const match = line.match(/^npm notice\s+[\d.]+\s*[kMG]?B\s+(.+)$/);
    if (match) files.push(match[1].trim());
  }
  return files;
}

function main() {
  const packed = new Set(packedFiles());
  if (packed.size === 0) {
    console.error("could not determine packed files from `npm pack --dry-run`");
    process.exit(1);
  }

  const problems = [];

  for (const file of requiredFiles()) {
    if (!packed.has(file)) {
      problems.push(`missing: ${file} — an entry in package.json "exports"/"bin" is not packed`);
    }
  }

  problems.push(...browserEntryProblems());

  for (const file of svelteSourceDependencies()) {
    if (!packed.has(file)) {
      problems.push(
        `missing: ${file} — imported by the raw-source ./svelte export but not in "files"`
      );
    }
  }

  // Things that must never ship.
  for (const file of packed) {
    if (file.endsWith(".map")) problems.push(`unexpected source map: ${file}`);
    if (/(^|\/)\.env/.test(file)) problems.push(`unexpected env file: ${file}`);
    if (/(^|\/)(tests?|__tests__)\//.test(file)) problems.push(`unexpected test file: ${file}`);
    if (file.endsWith(".test.ts") || file.endsWith(".spec.ts")) {
      problems.push(`unexpected test file: ${file}`);
    }
  }

  if (problems.length > 0) {
    console.error(`package check failed (${problems.length} problem(s)):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }

  console.log(
    `package check passed: ${packed.size} files, every "exports"/"bin" target packed, ` +
      `browser entries (${BROWSER_SAFE_SUBPATHS.join(", ")}) free of Node builtins`
  );
}

main();
