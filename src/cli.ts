import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { config as dotenvConfig } from "dotenv";
import chokidar from "chokidar";
import fg from "fast-glob";
import { Command, CommanderError, Option } from "commander";
import pkg from "../package.json";
import { writeMinimalConfig, loadConfig, mergeConfig } from "./config/load";
import { Logger } from "./core/logger";
import { resolveScope } from "./core/scope";
import { ensureStateDirs, removeStateDir } from "./core/state";
import { SearchSocketError } from "./errors";
import { IndexPipeline } from "./indexing/pipeline";
import { runMcpServer } from "./mcp/server";
import { runPlaygroundServer } from "./playground/server";
import { SearchEngine } from "./search/engine";
import { reciprocalRank, mrrReport, type MrrObservation } from "./search/quality-metrics";
import { testFileSchema } from "./cli/test-schemas";
import { openUpstashStore } from "./vector";
import { sanitizeScopeName } from "./utils/text";
import type { IndexStats, ResolvedSearchSocketConfig, Scope, ScopeInfo, SearchResult } from "./types";
import type { UpstashSearchStore } from "./vector/upstash";
import * as clack from "@clack/prompts";
import {
  ensureMcpJson,
  injectHooksServerTs,
  injectViteConfig,
  writeEnvFile,
  HOOKS_SNIPPET,
  VITE_PLUGIN_SNIPPET,
} from "./init-helpers";
import { copyComponent, isValidComponent, listAvailableComponents } from "./add-helpers";
import { INDEX_SCHEMA_VERSION } from "./vector/ids";
import {
  parseRemoteBranches,
  selectStaleScopes,
  summarizePruneDeletions,
  type PruneDeletionResult,
  type PruneMatchMode
} from "./cli/services/prune";

interface RootCommandOptions {
  cwd?: string;
  config?: string;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SearchSocketError("INVALID_REQUEST", `${flag} must be a positive integer`, 400);
  }
  return parsed;
}

function parseDurationMs(value: string): number {
  const match = value.trim().match(/^(\d+)(ms|s|m|h|d)$/i);
  if (!match) {
    throw new SearchSocketError(
      "INVALID_REQUEST",
      "Duration must look like 30d, 12h, 15m, 45s, or 500ms",
      400
    );
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();

  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    case "d":
      return amount * 86_400_000;
    default:
      throw new SearchSocketError("INVALID_REQUEST", `Unsupported duration unit: ${unit}`, 400);
  }
}

function printIndexSummary(stats: IndexStats): void {
  process.stdout.write(`pages processed: ${stats.pagesProcessed}\n`);
  process.stdout.write(`pages changed: ${stats.pagesChanged}\n`);
  process.stdout.write(`pages deleted: ${stats.pagesDeleted}\n`);
  process.stdout.write(`chunks total: ${stats.chunksTotal}\n`);
  process.stdout.write(`chunks changed: ${stats.chunksChanged}\n`);
  process.stdout.write(`documents upserted: ${stats.documentsUpserted}\n`);
  process.stdout.write(`deletes: ${stats.deletes}\n`);
  process.stdout.write(`route mapping: ${stats.routeExact} exact, ${stats.routeBestEffort} best-effort\n`);
  process.stdout.write(`deletion eligible: ${stats.deletionEligible ? "yes" : "no"}\n`);
  if (stats.warnings.length > 0) {
    process.stdout.write(`warnings (${stats.warnings.length}):\n`);
    for (const warning of stats.warnings) {
      process.stdout.write(`  ${warning.kind}: ${warning.detail}\n`);
    }
  }
  if (stats.dangerousOperations.length > 0) {
    process.stdout.write("destructive operations:\n");
    for (const op of stats.dangerousOperations) {
      process.stdout.write(`  ${op}\n`);
    }
  }
  process.stdout.write("stage timings (ms):\n");
  for (const [stage, ms] of Object.entries(stats.stageTimingsMs)) {
    process.stdout.write(`  ${stage}: ${ms}\n`);
  }
}

interface WatchTarget {
  /** Concrete file or directory handed to chokidar. Never a glob. */
  root: string;
  /**
   * When true, an event under this root only counts if the path is part of the
   * configured content-file glob membership. Unfiltered roots (routes, build
   * output, the config file) count for every event.
   */
  filtered: boolean;
  /**
   * Hand-edited source trees (routes, content, the config file) are polled.
   * With native events, chokidar 5 on macOS intermittently never subscribes
   * to a directory created after startup, so every later edit inside it is
   * lost without a trace. Build output is regenerated wholesale, where any
   * one event is enough, and stays on native events: polling it would stat
   * every emitted file on each interval.
   */
  poll: boolean;
}

/** Stat interval for polled source roots. */
const WATCH_POLL_INTERVAL_MS = 1000;

interface WatchPlan {
  targets: WatchTarget[];
  /** Present only in content-files mode; the input to the membership query. */
  contentFiles?: { baseDir: string; globs: string[] };
}

/**
 * Decide what the dev watcher subscribes to.
 *
 * Chokidar 4 removed glob support, so the globs that used to be handed to
 * `chokidar.watch()` verbatim (and therefore watched as literal, non-existent
 * paths) are turned into concrete roots here. `fg.generateTasks` supplies those
 * roots so they agree with the indexer even when a glob is absolute or reaches
 * outside `baseDir` with `../`.
 */
function collectWatchPlan(config: ResolvedSearchSocketConfig, cwd: string): WatchPlan {
  // Unfiltered roots go first: if a content root resolves to the same directory,
  // the dedup below keeps this one and the watcher errs towards indexing.
  const targets: WatchTarget[] = [{ root: path.resolve(cwd, "src/routes"), filtered: false, poll: true }];
  let contentFiles: WatchPlan["contentFiles"];

  if (config.source.mode === "content-files" && config.source.contentFiles) {
    const baseDir = path.resolve(cwd, config.source.contentFiles.baseDir);
    const globs = config.source.contentFiles.globs;
    contentFiles = { baseDir, globs };

    for (const task of fg.generateTasks(globs, { cwd: baseDir })) {
      targets.push({ root: path.resolve(baseDir, task.base), filtered: true, poll: true });
    }
  }

  if (config.source.mode === "static-output") {
    targets.push({ root: path.resolve(cwd, config.source.staticOutputDir), filtered: false, poll: false });
  }

  if (config.source.mode === "crawl") {
    targets.push({ root: path.resolve(cwd, "searchsocket.config.ts"), filtered: false, poll: true });
  }

  if (config.source.mode === "build" && config.source.build) {
    targets.push({ root: path.resolve(cwd, "searchsocket.config.ts"), filtered: false, poll: true });
    targets.push({ root: path.resolve(cwd, config.source.build.outputDir), filtered: false, poll: false });
  }

  const seen = new Set<string>();
  return {
    targets: targets.filter((target) => {
      if (seen.has(target.root)) return false;
      seen.add(target.root);
      return true;
    }),
    contentFiles
  };
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  // `relative === ""` is the root itself (a watched config file). A name that
  // merely starts with ".." — `..notes.md` — is inside; only the ".." segment
  // is not.
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/**
 * The set of files the indexer would currently load, as absolute paths.
 *
 * Asking fast-glob — the same matcher `src/indexing/sources/content-files.ts`
 * uses — is what keeps the watcher and the indexer from disagreeing about
 * extglobs, brace ranges, dotfiles and negated patterns. Returns null when the
 * query fails, which callers read as "unknown, so index anyway".
 */
function readContentMembership(plan: WatchPlan): Set<string> | null {
  if (!plan.contentFiles) return new Set();

  try {
    const matches = fg.sync(plan.contentFiles.globs, {
      cwd: plan.contentFiles.baseDir,
      absolute: true,
      onlyFiles: true
    });
    return new Set(matches.map((match) => path.resolve(match)));
  } catch {
    return null;
  }
}


function ensureStateDir(cwd: string): string {
  const target = path.join(cwd, ".searchsocket");
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function ensureGitignore(cwd: string): void {
  const gitignorePath = path.join(cwd, ".gitignore");
  const entries = [
    ".searchsocket/manifest.json",
    ".searchsocket/registry.json"
  ];

  let content = "";
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf8");
  }

  const lines = content.split("\n");
  const missing = entries.filter((entry) => !lines.some((line) => line.trim() === entry));

  if (missing.length === 0) {
    return;
  }

  const block = `\n# SearchSocket local state\n${missing.join("\n")}\n`;
  fs.writeFileSync(gitignorePath, content.trimEnd() + block, "utf8");
}

function readScopesFromFile(filePath: string): Set<string> {
  const raw = fs.readFileSync(filePath, "utf8");
  return new Set(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

/**
 * The set of branch names that exist on remotes, used by `prune` to decide
 * which scopes are orphaned.
 *
 * Returns `null` — not an empty set — whenever the inventory cannot be trusted.
 * A shallow clone, a missing remote, or a git failure all yield a short or
 * empty branch list, and treating that as "these are all the branches" marks
 * every live scope orphaned and deletes it.
 */
function readRemoteGitBranches(cwd: string): Set<string> | null {
  const git = (args: string): string =>
    execSync(`git ${args}`, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });

  try {
    // A shallow checkout does not have the full ref set. `actions/checkout`
    // defaults to fetch-depth: 1, so this is the common CI case.
    if (git("rev-parse --is-shallow-repository").trim() === "true") {
      process.stderr.write(
        "warning: repository is a shallow clone, so its branch list is incomplete.\n"
      );
      return null;
    }

    const remotes = git("remote")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (remotes.length === 0) {
      process.stderr.write("warning: repository has no configured remotes.\n");
      return null;
    }

    const scopes = parseRemoteBranches(git("branch -r --format='%(refname:short)'"), remotes);
    if (scopes === null) {
      process.stderr.write("warning: no remote branches found.\n");
      return null;
    }

    return scopes;
  } catch {
    return null;
  }
}

async function loadResolvedConfigForDev(cwd: string, configPath?: string): Promise<ResolvedSearchSocketConfig> {
  const resolvedConfigPath = path.resolve(cwd, configPath ?? "searchsocket.config.ts");
  if (fs.existsSync(resolvedConfigPath)) {
    return loadConfig({ cwd, configPath });
  }

  return mergeConfig(cwd, {});
}

function getRootOptions(command: Command): RootCommandOptions {
  const maybeParent = command.parent as Command | undefined;
  const optsFn = maybeParent?.opts;
  if (typeof optsFn !== "function") {
    return {};
  }

  return optsFn.call(maybeParent) as RootCommandOptions;
}

/**
 * Stable process exit codes. Machine consumers (CI, the prune workflow) branch
 * on these, so the meanings must not be reassigned. Documented in README.md
 * ("Exit codes") — keep the two in sync.
 */
const EXIT_OPERATIONAL_FAILURE = 1;
const EXIT_INVALID_USAGE = 2;
const EXIT_QUALITY_GATE = 3;
const EXIT_DESTRUCTIVE_REFUSED = 4;
const EXIT_BACKEND_UNAVAILABLE = 5;

/** `SearchEngine.search`'s upper bound on `topK`. */
const MAX_TEST_TOP_K = 100;

async function runIndexCommand(opts: {
  cwd: string;
  configPath?: string;
  scope?: string;
  changedOnly: boolean;
  force: boolean;
  dryRun: boolean;
  source?: "static-output" | "crawl" | "content-files" | "build";
  maxPages?: number;
  maxChunks?: number;
  quiet?: boolean;
  verbose?: boolean;
  json?: boolean;
  allowEmpty?: boolean;
  acceptLargeDeletion?: boolean;
  /**
   * Treat a missing backend as a skip rather than a failure. The Vite plugin
   * sets this so an unconfigured local build still succeeds; an explicit
   * `searchsocket index` must fail instead of silently doing nothing.
   */
  allowUnconfigured?: boolean;
}): Promise<IndexStats | undefined> {
  const logger = new Logger({
    quiet: opts.quiet,
    verbose: opts.verbose,
    json: opts.json
  });

  let pipeline: IndexPipeline;
  try {
    pipeline = await IndexPipeline.create({
      cwd: opts.cwd,
      configPath: opts.configPath,
      logger
    });
  } catch (error) {
    if (error instanceof SearchSocketError && error.code === "VECTOR_BACKEND_UNAVAILABLE") {
      if (opts.allowUnconfigured) {
        logger.warn("Search backend not configured — skipping indexing. Set UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN to enable.");
        return;
      }
      // An explicit index run that indexes nothing must not report success:
      // CI would treat a missing credential as a green deploy.
      logger.error(
        "Search backend not configured. Set UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN, " +
          "or pass --allow-unconfigured to skip indexing without failing."
      );
      process.exitCode = EXIT_BACKEND_UNAVAILABLE;
      return;
    }
    throw error;
  }

  const stats = await pipeline.run({
    scopeOverride: opts.scope,
    changedOnly: opts.changedOnly,
    force: opts.force,
    dryRun: opts.dryRun,
    sourceOverride: opts.source,
    maxPages: opts.maxPages,
    maxChunks: opts.maxChunks,
    verbose: opts.verbose,
    allowEmpty: opts.allowEmpty,
    acceptLargeDeletion: opts.acceptLargeDeletion
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    return stats;
  }

  if (!opts.quiet) {
    printIndexSummary(stats);
  }
  return stats;
}

async function runInteractiveInit(cwd: string): Promise<void> {
  clack.intro("searchsocket setup");

  // Step 1: Config file + state dir + gitignore + MCP
  const s = clack.spinner();
  s.start("Creating config files");
  const configPath = writeMinimalConfig(cwd);
  ensureStateDir(cwd);
  ensureGitignore(cwd);
  ensureMcpJson(cwd);
  s.stop("Config files created");

  // Step 2: Check for Upstash credentials
  const hasUrl = Boolean(process.env.UPSTASH_VECTOR_REST_URL);
  const hasToken = Boolean(process.env.UPSTASH_VECTOR_REST_TOKEN);

  if (!hasUrl || !hasToken) {
    clack.log.warn("Upstash Vector credentials not found in environment.");

    const shouldConfigure = await clack.confirm({
      message: "Would you like to configure Upstash credentials now?",
      initialValue: true,
    });

    if (clack.isCancel(shouldConfigure)) {
      clack.cancel("Setup cancelled.");
      process.exit(0);
    }

    if (shouldConfigure) {
      const url = hasUrl
        ? process.env.UPSTASH_VECTOR_REST_URL!
        : await clack.text({
            message: "Upstash Vector REST URL:",
            placeholder: "https://your-index.upstash.io",
            validate: (v) => (!v ? "URL is required" : undefined),
          });

      if (clack.isCancel(url)) {
        clack.cancel("Setup cancelled.");
        process.exit(0);
      }

      const token = hasToken
        ? process.env.UPSTASH_VECTOR_REST_TOKEN!
        : await clack.text({
            message: "Upstash Vector REST Token:",
            placeholder: "AX...",
            validate: (v) => (!v ? "Token is required" : undefined),
          });

      if (clack.isCancel(token)) {
        clack.cancel("Setup cancelled.");
        process.exit(0);
      }

      writeEnvFile(cwd, url as string, token as string);
      clack.log.success("Credentials written to .env");
    }
  } else {
    clack.log.success("Upstash credentials found in environment.");
  }

  // Step 3: Inject hooks.server.ts
  s.start("Configuring hooks.server.ts");
  const hookResult = injectHooksServerTs(cwd);
  s.stop("hooks.server.ts configured");

  switch (hookResult) {
    case "created":
      clack.log.success("Created src/hooks.server.ts with searchsocketHandle.");
      break;
    case "injected":
      clack.log.success("Added searchsocketHandle to src/hooks.server.ts.");
      break;
    case "composed":
      clack.log.success("Composed searchsocketHandle with existing handle using sequence().");
      break;
    case "already-present":
      clack.log.info("searchsocketHandle already configured in hooks.server.ts.");
      break;
    case "fallback":
      clack.log.warn("Could not auto-inject hooks.server.ts. Add manually:");
      clack.log.message(HOOKS_SNIPPET);
      break;
  }

  // Step 4: Inject vite config
  s.start("Configuring Vite plugin");
  const viteResult = injectViteConfig(cwd);
  s.stop("Vite plugin configured");

  switch (viteResult) {
    case "injected":
      clack.log.success("Added searchsocketVitePlugin to Vite config.");
      break;
    case "already-present":
      clack.log.info("searchsocketVitePlugin already in Vite config.");
      break;
    case "no-config":
      clack.log.warn("No vite.config.ts/js found. Add the plugin manually:");
      clack.log.message(VITE_PLUGIN_SNIPPET);
      break;
    case "fallback":
      clack.log.warn("Could not auto-inject Vite config. Add manually:");
      clack.log.message(VITE_PLUGIN_SNIPPET);
      break;
  }

  clack.log.info("Run `searchsocket doctor` to verify your setup.");
  clack.outro("SearchSocket initialized! Run `searchsocket index` to index your site.");
}

async function runSilentInit(cwd: string): Promise<void> {
  const configPath = writeMinimalConfig(cwd);
  const stateDir = ensureStateDir(cwd);
  ensureGitignore(cwd);
  ensureMcpJson(cwd);

  process.stdout.write(`created/verified config: ${configPath}\n`);
  process.stdout.write(`created/verified state dir: ${stateDir}\n`);
  process.stdout.write("created/verified .mcp.json (MCP server config for Claude Code)\n\n");

  // Attempt auto-injection
  const hookResult = injectHooksServerTs(cwd);
  switch (hookResult) {
    case "created":
      process.stdout.write("created src/hooks.server.ts with searchsocketHandle\n");
      break;
    case "injected":
      process.stdout.write("added searchsocketHandle to src/hooks.server.ts\n");
      break;
    case "composed":
      process.stdout.write("composed searchsocketHandle with existing handle via sequence()\n");
      break;
    case "already-present":
      process.stdout.write("searchsocketHandle already present in hooks.server.ts\n");
      break;
    case "fallback":
      process.stdout.write("could not auto-inject hooks.server.ts — add manually:\n\n");
      process.stdout.write(HOOKS_SNIPPET + "\n\n");
      break;
  }

  const viteResult = injectViteConfig(cwd);
  switch (viteResult) {
    case "injected":
      process.stdout.write("added searchsocketVitePlugin to Vite config\n");
      break;
    case "already-present":
      process.stdout.write("searchsocketVitePlugin already in Vite config\n");
      break;
    case "no-config":
      process.stdout.write("no vite.config.ts/js found — add plugin manually:\n\n");
      process.stdout.write(VITE_PLUGIN_SNIPPET + "\n\n");
      break;
    case "fallback":
      process.stdout.write("could not auto-inject Vite config — add manually:\n\n");
      process.stdout.write(VITE_PLUGIN_SNIPPET + "\n\n");
      break;
  }
}

const program = new Command();

// Commander exits 1 on a usage error by default, which would collide with the
// operational-failure code. Settings applied here are inherited by every
// subcommand added below; main() maps the thrown CommanderError to an exit code.
program.exitOverride();

program
  .name("searchsocket")
  .description("Semantic site search and MCP retrieval for SvelteKit")
  .version(pkg.version)
  .option("-C, --cwd <path>", "working directory", process.cwd())
  .option("--config <path>", "config path (defaults to searchsocket.config.ts)");

program
  .command("init")
  .description("Initialize SearchSocket in a SvelteKit project")
  .option("--non-interactive", "skip interactive prompts")
  .action(async (opts, command) => {
    const root = getRootOptions(command).cwd ?? process.cwd();
    const cwd = path.resolve(root);
    const isInteractive = Boolean(process.stdout.isTTY) && !opts.nonInteractive;

    if (isInteractive) {
      await runInteractiveInit(cwd);
    } else {
      await runSilentInit(cwd);
    }
  });

program
  .command("index")
  .description("Index site content into Upstash Vector")
  .option("--scope <name>", "scope override")
  .option("--changed-only", "only process changed chunks", true)
  .option("--no-changed-only", "re-index regardless of previous manifest")
  .option("--force", "force full rebuild", false)
  .option("--dry-run", "compute plan, no writes", false)
  .option("--source <mode>", "source mode override: static-output|crawl|content-files|build")
  .option("--max-pages <n>", "limit pages processed")
  .option("--max-chunks <n>", "limit chunks processed")
  .option("--quiet", "suppress all output except errors and warnings", false)
  .option("--verbose", "verbose output", false)
  .option("--json", "emit JSON logs and summary", false)
  .option("--allow-empty", "permit deleting all records when the source legitimately produced zero pages", false)
  .option("--accept-large-deletion", "permit a deletion exceeding indexing.maxDeletionRatio", false)
  .option("--allow-unconfigured", "exit 0 instead of failing when no vector backend is configured", false)
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    const stats = await runIndexCommand({
      cwd,
      configPath: rootOpts?.config,
      scope: opts.scope,
      changedOnly: opts.changedOnly,
      force: opts.force || /^(1|true|yes)$/i.test(process.env.SEARCHSOCKET_FORCE_REINDEX ?? ""),
      dryRun: opts.dryRun,
      source: opts.source,
      maxPages: opts.maxPages ? parsePositiveInt(opts.maxPages, "--max-pages") : undefined,
      maxChunks: opts.maxChunks ? parsePositiveInt(opts.maxChunks, "--max-chunks") : undefined,
      quiet: opts.quiet,
      verbose: opts.verbose,
      json: opts.json,
      allowEmpty: opts.allowEmpty,
      acceptLargeDeletion: opts.acceptLargeDeletion,
      allowUnconfigured: opts.allowUnconfigured
    });

    // A refused run resolves normally and leaves the index frozen at its last
    // accepted state; exiting 0 would let CI deploy as if it had indexed. A
    // ratio refusal is a destructive plan refused (resolved by
    // --accept-large-deletion, which never reaches this branch); an unreadable
    // robots.txt is an operational failure. Applies to --dry-run as well, which
    // exists to predict exactly this.
    if (stats?.writesRefused) {
      process.stderr.write(`index refused: ${stats.writesRefused.detail}\n`);
      process.exitCode =
        stats.writesRefused.reason === "max-deletion-ratio"
          ? EXIT_DESTRUCTIVE_REFUSED
          : EXIT_OPERATIONAL_FAILURE;
    }
  });

program
  .command("status")
  .description("Show scope, indexing state, and backend health")
  .option("--scope <name>", "scope override")
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    const config = await loadConfig({ cwd, configPath: rootOpts?.config });
    const scope = resolveScope(config, opts.scope, cwd);

    let store: UpstashSearchStore;
    let health: { ok: boolean; details?: string } = { ok: false, details: "not checked" };
    try {
      store = await openUpstashStore(config);
      health = await store.health();
    } catch (error) {
      health = {
        ok: false,
        details: error instanceof Error ? error.message : "unknown error"
      };
      process.stdout.write(`project: ${config.project.id}\n`);
      process.stdout.write(`backend health: error (${health.details})\n`);
      process.exitCode = EXIT_BACKEND_UNAVAILABLE;
      return;
    }

    let scopeRegistry: ScopeInfo[] = [];
    let scopeInfo: ScopeInfo | undefined;

    try {
      scopeRegistry = await store.listScopes(config.project.id);
      scopeInfo = scopeRegistry.find((entry) => entry.scopeName === scope.scopeName);
    } catch (error) {
      process.stdout.write(`project: ${config.project.id}\n`);
      process.stdout.write(`resolved scope: ${scope.scopeName}\n`);
      process.stdout.write(`backend health: error (${error instanceof Error ? error.message : "unknown error"})\n`);
      process.exitCode = EXIT_BACKEND_UNAVAILABLE;
      return;
    }

    process.stdout.write(`project: ${config.project.id}\n`);
    process.stdout.write(`resolved scope: ${scope.scopeName}\n`);
    process.stdout.write(`backend: upstash-vector\n`);
    process.stdout.write(`backend health: ${health.ok ? "ok" : `error (${health.details ?? "n/a"})`}\n`);
    if (!health.ok) {
      // The report still prints, but a health check that failed must not read
      // as success to a script branching on the exit code.
      process.exitCode = EXIT_BACKEND_UNAVAILABLE;
    }

    if (scopeInfo) {
      process.stdout.write(`last indexed (${scope.scopeName}): ${scopeInfo.lastIndexedAt ?? "never"}\n`);
      if (scopeInfo.documentCount != null) {
        process.stdout.write(`documents: ${scopeInfo.documentCount}\n`);
      }
    } else {
      process.stdout.write(`last indexed (${scope.scopeName}): never\n`);
    }

    if (scopeRegistry.length > 0) {
      process.stdout.write("\nregistry scopes:\n");
      for (const item of scopeRegistry) {
        process.stdout.write(
          `  - ${item.scopeName} lastIndexedAt=${item.lastIndexedAt} documents=${item.documentCount ?? "unknown"}\n`
        );
      }
    }
  });

program
  .command("dev")
  .description("Watch content files/routes and incrementally reindex on changes")
  .option("--scope <name>", "scope override")
  .option("--playground", "serve playground UI at /_searchsocket (default: true)", true)
  .option("--no-playground", "disable playground UI")
  .option("--playground-port <n>", "playground HTTP port", "3337")
  .option("--mcp", "start MCP server (http transport) alongside watcher", false)
  // No Commander defaults: a default would always be passed and shadow
  // mcp.http.port / mcp.http.path from the config.
  .option("--mcp-port <n>", "MCP HTTP port (default: mcp.http.port, 3338)")
  .option("--mcp-path <path>", "MCP HTTP path (default: mcp.http.path, /mcp)")
  .option("--no-poll", "use native file events for source trees instead of polling them")
  .option("--verbose", "verbose logs", false)
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    const config = await loadResolvedConfigForDev(cwd, rootOpts?.config);
    const plan = collectWatchPlan(config, cwd);

    process.stdout.write("starting searchsocket dev watcher...\n");
    process.stdout.write(
      `watching:\n${plan.targets
        .map((target) => {
          const missing = fs.existsSync(target.root) ? "" : " [not found yet]";
          return `  - ${target.root}${missing}`;
        })
        .join("\n")}\n`
    );
    if (plan.contentFiles) {
      process.stdout.write(`matching: ${plan.contentFiles.globs.join(", ")}\n`);
    }

    const upstashUrl = config.upstash.url ?? process.env[config.upstash.urlEnv];
    const upstashToken = config.upstash.token ?? process.env[config.upstash.tokenEnv];
    const backendMissing = !upstashUrl || !upstashToken;

    if (backendMissing) {
      process.stdout.write(
        `Search backend not configured — set ${config.upstash.urlEnv} and ${config.upstash.tokenEnv} to enable indexing. Watching for file changes only.\n`
      );
    }

    let running = false;
    let pending = false;
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;

    const run = async (): Promise<void> => {
      if (backendMissing || stopped) {
        return;
      }

      if (running) {
        pending = true;
        return;
      }

      running = true;
      try {
        await runIndexCommand({
          cwd,
          configPath: rootOpts?.config,
          scope: opts.scope,
          changedOnly: true,
          force: false,
          dryRun: false,
          verbose: opts.verbose,
          json: false
        });
      } catch (error) {
        process.stderr.write(`index error: ${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        running = false;
        if (pending) {
          pending = false;
          // Not after a shutdown: `run()` re-checks `stopped` for exactly this,
          // otherwise a burst that arrived mid-index started a fresh index run
          // against a closing process.
          await run();
        }
      }
    };

    await run();

    // Only concrete roots are subscribed; relevance is decided per event below,
    // so a file created after startup — in a directory that did not exist at
    // startup — still triggers a reindex.
    const pollSources = opts.poll !== false;
    const polledRoots = plan.targets.filter((target) => pollSources && target.poll).map((target) => target.root);
    const nativeRoots = plan.targets.filter((target) => !(pollSources && target.poll)).map((target) => target.root);
    const watchers = [
      ...(polledRoots.length > 0
        ? [
            chokidar.watch(polledRoots, {
              ignoreInitial: true,
              usePolling: true,
              interval: WATCH_POLL_INTERVAL_MS,
              binaryInterval: WATCH_POLL_INTERVAL_MS
            })
          ]
        : []),
      ...(nativeRoots.length > 0 ? [chokidar.watch(nativeRoots, { ignoreInitial: true })] : [])
    ];

    let membership = readContentMembership(plan);
    let queued: Array<{ event: string; path: string; filtered: boolean }> = [];

    // Coalesce a burst — an editor's atomic save is an unlink plus an add — into
    // a single follow-up run.
    const flush = (): void => {
      timer = null;
      if (stopped) return;

      const events = queued;
      queued = [];

      const previous = membership;
      if (events.some((entry) => entry.filtered)) {
        membership = readContentMembership(plan);
      }

      const relevant = events.filter(
        (entry) =>
          !entry.filtered ||
          previous === null ||
          membership === null ||
          previous.has(entry.path) ||
          membership.has(entry.path)
      );

      if (relevant.length === 0) return;

      for (const entry of relevant) {
        process.stdout.write(`detected ${entry.event}: ${entry.path}\n`);
      }
      void run();
    };

    const onWatchEvent = (event: string, changedPath: string): void => {
      if (stopped) return;

      const absolute = path.resolve(cwd, changedPath);
      const unfiltered = plan.targets.some(
        (target) => !target.filtered && isInside(target.root, absolute)
      );
      const filtered =
        !unfiltered &&
        plan.targets.some((target) => target.filtered && isInside(target.root, absolute));

      if (!unfiltered && !filtered) return;

      queued.push({ event, path: absolute, filtered });

      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(flush, 350);
    };
    for (const watcher of watchers) watcher.on("all", onWatchEvent);

    // Chokidar walks the tree before it starts reporting; announcing readiness
    // gives callers (and the test suite) something deterministic to wait for.
    // Announced once, when every watcher is ready: chokidar emits "ready" once
    // per watched root that does not exist yet, which printed it twice.
    void Promise.all(
      watchers.map((watcher) => new Promise<void>((resolve) => watcher.once("ready", () => resolve())))
    ).then(() => {
      if (!stopped) process.stdout.write("watcher ready\n");
    });

    if (opts.mcp) {
      void runMcpServer({
        cwd,
        configPath: rootOpts?.config,
        transport: "http",
        httpPort: opts.mcpPort !== undefined ? parsePositiveInt(opts.mcpPort, "--mcp-port") : undefined,
        httpPath: opts.mcpPath
      });
    }

    let closePlayground: (() => Promise<void>) | undefined;

    if (opts.playground) {
      if (backendMissing) {
        process.stdout.write("playground disabled: search backend not configured\n");
      } else {
        void runPlaygroundServer({
          cwd,
          configPath: rootOpts?.config,
          config,
          port: parsePositiveInt(opts.playgroundPort, "--playground-port")
        }).then(({ port, close }) => {
          closePlayground = close;
          process.stdout.write(`playground available at http://127.0.0.1:${port}/_searchsocket\n`);
        }).catch((err) => {
          process.stderr.write(`playground error: ${err instanceof Error ? err.message : String(err)}\n`);
        });
      }
    }

    // Only SIGINT: the MCP HTTP server started by --mcp installs its own SIGINT
    // handler but nothing for SIGTERM, so intercepting SIGTERM here would
    // suppress the default termination and leave that server holding the process
    // open forever.
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        if (stopped) return;
        stopped = true;

        // A pending debounce keeps the event loop alive and would start an index
        // run against a closing process.
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        pending = false;
        queued = [];

        const cleanups = watchers.map((watcher) => watcher.close());
        if (closePlayground) cleanups.push(closePlayground());
        void Promise.all(cleanups).then(() => resolve());
      });
    });
  });

program
  .command("clean")
  .description(
    "Delete local state and optionally delete remote indexes " +
      "(--remote is plan-only, deleting nothing at all, until --apply)"
  )
  .option("--scope <name>", "scope to delete remotely (defaults to the resolved scope)")
  .option("--remote", "delete remote indexes for a single scope", false)
  .option("--all-scopes", "delete every scope in the project (requires --confirm-project)", false)
  .option("--confirm-project <id>", "confirmation token for --all-scopes; must equal the project id")
  .option("--apply", "actually perform the planned deletions (remote records and local state)", false)
  .option("--keep-local", "do not delete the local state directory", false)
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    const config = await loadConfig({ cwd, configPath: rootOpts?.config });

    // Every option and confirmation is validated before anything is deleted.
    // The local state removal used to run first, so a command that was about to
    // be refused had already wiped local state on its way to the refusal.
    if (opts.allScopes && !opts.remote) {
      process.stderr.write("error: --all-scopes requires --remote\n");
      process.exitCode = EXIT_INVALID_USAGE;
      return;
    }

    // --all-scopes is the only path that may touch scopes other than the one
    // named. Previously `clean --remote --scope foo` resolved the scope flag
    // and then dropped the entire project regardless.
    if (opts.remote && opts.allScopes && opts.confirmProject !== config.project.id) {
      process.stderr.write(
        `error: --all-scopes deletes every scope in project "${config.project.id}". ` +
          `Re-run with --confirm-project ${config.project.id} to acknowledge.\n`
      );
      process.exitCode = EXIT_DESTRUCTIVE_REFUSED;
      return;
    }

    // resolveScope rejects a name that cannot be embedded in a record ID. It has
    // to run before the local removal, or `clean --remote --scope bad/name`
    // wipes local state on its way to failing.
    let scope: Scope | undefined;
    if (opts.remote && !opts.allScopes) {
      try {
        scope = resolveScope(config, opts.scope, cwd);
      } catch (error) {
        process.stderr.write(
          `error: ${error instanceof Error ? error.message : String(error)}\n`
        );
        process.exitCode = EXIT_INVALID_USAGE;
        return;
      }
    }

    // A remote clean is plan-first: without --apply it deletes nothing at all,
    // local state included. The local removal used to run before the dry-run
    // guard, so `clean --remote` printed "dry-run only" *after* it had already
    // wiped the local state directory.
    const planOnly = opts.remote && !opts.apply;

    if (!opts.keepLocal) {
      let removal: Awaited<ReturnType<typeof removeStateDir>>;
      try {
        // A plan run goes through the same guards with the deletion itself
        // stubbed out, so the plan is the real decision rather than a second,
        // drifting prediction of it. It is still a snapshot: a marker file or
        // the directory itself can change between the plan and the apply.
        removal = planOnly
          ? await removeStateDir(cwd, config.state.dir, async () => {})
          : await removeStateDir(cwd, config.state.dir);
      } catch (error) {
        process.stderr.write(
          `error: ${error instanceof Error ? error.message : String(error)}\n`
        );
        process.exitCode = EXIT_DESTRUCTIVE_REFUSED;
        return;
      }

      if (removal.removed) {
        process.stdout.write(
          planOnly
            ? `plan: delete local state directory: ${removal.statePath}\n`
            : `deleted local state directory: ${removal.statePath}\n`
        );
      } else {
        process.stdout.write(
          planOnly
            ? `plan: leave local state directory alone: ${removal.statePath} (${removal.reason})\n`
            : `left local state directory alone: ${removal.statePath} (${removal.reason})\n`
        );
      }
    } else if (planOnly) {
      process.stdout.write("plan: keep the local state directory (--keep-local)\n");
    }

    if (!opts.remote) return;

    if (opts.allScopes) {
      process.stdout.write(`plan: drop ALL scopes in project ${config.project.id}\n`);
      if (!opts.apply) {
        process.stdout.write("dry-run only. pass --apply to delete.\n");
        process.stdout.write("nothing has been deleted.\n");
        return;
      }

      const store = await openUpstashStore(config);
      await store.dropAllIndexes(config.project.id);
      process.stdout.write(`dropped all remote indexes for project ${config.project.id}\n`);
      return;
    }

    // Resolved above, before anything was deleted.
    const target = scope!;
    process.stdout.write(
      `plan: delete remote records for project ${target.projectId}, scope ${target.scopeName}\n`
    );
    if (!opts.apply) {
      process.stdout.write("dry-run only. pass --apply to delete.\n");
      return;
    }

    const store = await openUpstashStore(config);
    await store.deleteScope(target);
    process.stdout.write(`deleted remote records for scope ${target.scopeName}\n`);
  });

const migrate = program
  .command("migrate")
  .description("Index schema migration helpers");

migrate
  .command("cleanup-legacy")
  .description(
    "Delete records written under an older index schema (dry-run by default). " +
      "Run only after a successful reindex on the current schema."
  )
  .option("--apply", "actually delete the legacy records", false)
  .option("--confirm-project <id>", "confirmation token; must equal the project id")
  .action(async (opts, command) => {
    // getRootOptions() reads its argument's *parent*, so for a nested command
    // (`migrate cleanup-legacy`) the right argument is the `migrate` command.
    // Passing the program itself overshot and returned {}, silently dropping
    // --cwd and --config on a destructive operation.
    const rootOpts = getRootOptions(command.parent as Command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());
    const config = await loadConfig({ cwd, configPath: rootOpts?.config });

    let store: UpstashSearchStore;
    let legacy: { pages: string[]; chunks: string[] };
    try {
      store = await openUpstashStore(config);
      legacy = await store.scanLegacyRecords(config.project.id);
    } catch (error) {
      process.stderr.write(
        `error: failed to scan for legacy records: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = EXIT_BACKEND_UNAVAILABLE;
      return;
    }

    const total = legacy.pages.length + legacy.chunks.length;
    if (total === 0) {
      process.stdout.write(`no legacy records found for project ${config.project.id}\n`);
      return;
    }

    process.stdout.write(
      `legacy records in project ${config.project.id} (schema older than ${INDEX_SCHEMA_VERSION}):\n` +
        `  pages: ${legacy.pages.length}\n` +
        `  chunks: ${legacy.chunks.length}\n`
    );
    for (const id of [...legacy.pages, ...legacy.chunks].slice(0, 20)) {
      process.stdout.write(`  - ${id}\n`);
    }
    if (total > 20) process.stdout.write(`  ... and ${total - 20} more\n`);

    if (!opts.apply) {
      process.stdout.write(
        "dry-run only. Verify the current schema is fully indexed and searching correctly, " +
          `then re-run with --apply --confirm-project ${config.project.id}.\n`
      );
      return;
    }

    if (opts.confirmProject !== config.project.id) {
      process.stderr.write(
        `error: this permanently deletes ${total} record(s). ` +
          `Re-run with --confirm-project ${config.project.id} to acknowledge.\n`
      );
      process.exitCode = EXIT_DESTRUCTIVE_REFUSED;
      return;
    }

    const result = await store.deleteLegacyRecords(config.project.id, legacy);
    process.stdout.write(`deleted ${result.deleted} legacy record(s)\n`);
    if (result.skipped > 0) {
      process.stdout.write(
        `skipped ${result.skipped} record(s) that were no longer legacy at deletion time\n`
      );
    }
  });

program
  .command("prune")
  .description("List/delete stale scopes (dry-run by default)")
  .option("--apply", "apply deletions", false)
  .option("--scopes-file <path>", "file containing active scopes")
  .option("--older-than <duration>", "ttl cutoff like 30d")
  .option(
    "--match <mode>",
    "when both --scopes-file/git branches and --older-than are given: 'any' or 'all'",
    "all"
  )
  .option("--protect <names>", "comma-separated scopes that must never be pruned")
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    const config = await loadConfig({ cwd, configPath: rootOpts?.config });
    const baseScope = resolveScope(config, undefined, cwd);

    let store: UpstashSearchStore;
    let scopes: ScopeInfo[];
    try {
      store = await openUpstashStore(config);
      scopes = await store.listScopes(config.project.id);
    } catch (error) {
      process.stderr.write(
        `error: failed to access Upstash Vector: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = EXIT_BACKEND_UNAVAILABLE;
      return;
    }

    process.stdout.write(`using Upstash Vector\n`);

    if (opts.match !== "any" && opts.match !== "all") {
      process.stderr.write(`error: --match must be "any" or "all", got "${opts.match}"\n`);
      process.exitCode = EXIT_INVALID_USAGE;
      return;
    }

    // Scopes that must survive regardless of any rule: the scope this checkout
    // resolves to, the conventional production scope, and anything the caller
    // explicitly protected.
    const protectedScopes = new Set<string>(["main", baseScope.scopeName]);
    if (typeof opts.protect === "string") {
      for (const name of opts.protect.split(",").map((n: string) => n.trim()).filter(Boolean)) {
        protectedScopes.add(config.scope.sanitize ? sanitizeScopeName(name) : name);
      }
    }

    let keepScopes = new Set<string>();
    if (opts.scopesFile) {
      keepScopes = readScopesFromFile(path.resolve(cwd, opts.scopesFile));
      if (keepScopes.size === 0) {
        // An empty keep-list would mark every scope orphaned.
        process.stderr.write(
          `error: scopes file ${opts.scopesFile} listed no scopes. Refusing to treat every scope as orphaned.\n`
        );
        process.exitCode = EXIT_DESTRUCTIVE_REFUSED;
        return;
      }
    } else {
      const branches = readRemoteGitBranches(cwd);
      if (branches === null) {
        // Fail closed: the branch inventory could not be established, so every
        // scope would look orphaned.
        process.stderr.write(
          "error: could not establish a trustworthy remote branch list. " +
            "Refusing to prune. Use --scopes-file to supply the active scopes explicitly, " +
            "or check out with full history (actions/checkout with fetch-depth: 0).\n"
        );
        process.exitCode = EXIT_DESTRUCTIVE_REFUSED;
        return;
      }
      keepScopes = branches;
    }

    if (config.scope.sanitize) {
      keepScopes = new Set([...keepScopes].map(sanitizeScopeName));
    }

    let olderThanMs: number | undefined;
    if (opts.olderThan) {
      olderThanMs = parseDurationMs(opts.olderThan);
      if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) {
        process.stderr.write(`error: could not parse --older-than "${opts.olderThan}"\n`);
        process.exitCode = EXIT_INVALID_USAGE;
        return;
      }
    }
    const now = Date.now();

    const { stale, skipped } = selectStaleScopes({
      scopes,
      keepScopes,
      protectedScopes,
      olderThanMs,
      matchMode: opts.match as PruneMatchMode,
      now
    });

    if (skipped.length > 0) {
      process.stdout.write(`skipped ${skipped.length} scope(s) with unusable timestamps:\n`);
      for (const entry of skipped) {
        process.stdout.write(`  - ${entry.scopeName}: ${entry.reason}\n`);
      }
    }

    if (stale.length === 0) {
      process.stdout.write("no stale scopes found\n");
      return;
    }

    process.stdout.write(`stale scopes (${stale.length}):\n`);
    for (const entry of stale) {
      process.stdout.write(`  - ${entry.scopeName} lastIndexedAt=${entry.lastIndexedAt}\n`);
    }

    if (!opts.apply) {
      process.stdout.write("dry-run only. pass --apply to delete these scopes.\n");
      return;
    }

    const outcomes: PruneDeletionResult[] = [];
    for (const entry of stale) {
      const scope: Scope = {
        projectId: config.project.id,
        scopeName: entry.scopeName,
        scopeId: `${config.project.id}:${entry.scopeName}`
      };

      try {
        await store.deleteScope(scope);
        outcomes.push({ scopeName: entry.scopeName });
      } catch (error) {
        outcomes.push({
          scopeName: entry.scopeName,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const summary = summarizePruneDeletions(outcomes);
    process.stdout.write(`deleted scopes: ${summary.deleted} of ${summary.attempted} attempted\n`);

    if (summary.failed.length > 0) {
      // Failures went to stdout and left the exit code at 0, so automation read
      // a partial or total failure as a successful cleanup.
      for (const failure of summary.failed) {
        process.stderr.write(`error: failed to delete scope ${failure.scopeName}: ${failure.error}\n`);
      }
      process.stderr.write(`error: ${summary.failed.length} scope deletion(s) failed\n`);
      process.exitCode = EXIT_OPERATIONAL_FAILURE;
    }

    if (baseScope.scopeName === "main") {
      process.stdout.write("main scope retained\n");
    }
  });

program
  .command("doctor")
  .description("Validate config, env vars, provider connectivity, and local write access")
  .action(async (_opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    const checks: Array<{ name: string; ok: boolean; details?: string }> = [];

    let config: ResolvedSearchSocketConfig | null = null;
    try {
      config = await loadConfig({ cwd, configPath: rootOpts?.config });
      checks.push({ name: "config parse", ok: true });
    } catch (error) {
      checks.push({
        name: "config parse",
        ok: false,
        details: error instanceof Error ? error.message : "unknown error"
      });
    }

    if (config) {
      const upstashUrl = config.upstash.url ?? process.env[config.upstash.urlEnv];
      const upstashToken = config.upstash.token ?? process.env[config.upstash.tokenEnv];
      checks.push({
        name: `env ${config.upstash.urlEnv}`,
        ok: Boolean(upstashUrl),
        details: upstashUrl ? undefined : "missing"
      });
      checks.push({
        name: `env ${config.upstash.tokenEnv}`,
        ok: Boolean(upstashToken),
        details: upstashToken ? undefined : "missing"
      });

      // Validate source mode prerequisites
      if (config.source.mode === "static-output") {
        const outputDir = path.resolve(cwd, config.source.staticOutputDir);
        const exists = fs.existsSync(outputDir);
        checks.push({
          name: "source: static output dir",
          ok: exists,
          details: exists ? outputDir : `${outputDir} not found (run your build first)`
        });
      } else if (config.source.mode === "build") {
        const buildConfig = config.source.build;
        if (buildConfig) {
          const manifestPath = path.resolve(cwd, buildConfig.outputDir, "server", "manifest-full.js");
          const manifestExists = fs.existsSync(manifestPath);
          checks.push({
            name: "source: build manifest",
            ok: manifestExists,
            details: manifestExists
              ? manifestPath
              : `${manifestPath} not found (run \`vite build\` first)`
          });

          const viteBin = path.resolve(cwd, "node_modules", ".bin", "vite");
          const viteExists = fs.existsSync(viteBin);
          checks.push({
            name: "source: vite binary",
            ok: viteExists,
            details: viteExists ? viteBin : `${viteBin} not found (install vite)`
          });
        } else {
          checks.push({
            name: "source: build config",
            ok: false,
            details: "source.build config missing"
          });
        }
      } else if (config.source.mode === "content-files") {
        const contentConfig = config.source.contentFiles;
        if (contentConfig) {
          const fg = await import("fast-glob");
          const baseDir = path.resolve(cwd, contentConfig.baseDir);
          const files = await fg.default(contentConfig.globs, { cwd: baseDir, onlyFiles: true });
          checks.push({
            name: "source: content files",
            ok: files.length > 0,
            details: files.length > 0
              ? `${files.length} files matched`
              : `no files matched globs ${contentConfig.globs.join(", ")} in ${baseDir}`
          });
        } else {
          checks.push({
            name: "source: content files",
            ok: false,
            details: "source.contentFiles config missing"
          });
        }
      }

      let store: UpstashSearchStore | null = null;
      try {
        store = await openUpstashStore(config);
        const health = await store.health();
        checks.push({
          name: "upstash search connectivity",
          ok: health.ok,
          details: health.details
        });
      } catch (error) {
        checks.push({
          name: "upstash search connectivity",
          ok: false,
          details: error instanceof Error ? error.message : "unknown error"
        });
      }

      try {
        const scope = resolveScope(config, undefined, cwd);
        const { statePath } = ensureStateDirs(cwd, config.state.dir, scope);
        const testPath = path.join(statePath, ".write-test");
        await fsp.writeFile(testPath, "ok\n", "utf8");
        await fsp.rm(testPath, { force: true });
        checks.push({ name: "state directory writable", ok: true });
      } catch (error) {
        checks.push({
          name: "state directory writable",
          ok: false,
          details: error instanceof Error ? error.message : "unknown error"
        });
      }
    }

    let hasFailure = false;
    for (const check of checks) {
      process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${check.name}`);
      if (check.details) {
        process.stdout.write(` (${check.details})`);
      }
      process.stdout.write("\n");

      if (!check.ok) {
        hasFailure = true;
      }
    }

    if (hasFailure) {
      process.exitCode = EXIT_OPERATIONAL_FAILURE;
    }
  });

program
  .command("mcp")
  .description("Run SearchSocket MCP server")
  // No Commander defaults: a default would always be passed and shadow
  // mcp.transport / mcp.http.port / mcp.http.path from the config.
  .addOption(
    new Option("--transport <transport>", "transport (default: mcp.transport, stdio)").choices(["stdio", "http"])
  )
  .option("--port <n>", "HTTP port (default: mcp.http.port, 3338)")
  .option("--path <path>", "HTTP path (default: mcp.http.path, /mcp)")
  .addOption(new Option("--access <mode>", "access mode").choices(["public", "private"]))
  .option("--api-key <key>", "API key for public access mode")
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    await runMcpServer({
      cwd,
      configPath: rootOpts?.config,
      transport: opts.transport,
      httpPort: opts.port !== undefined ? parsePositiveInt(opts.port, "--port") : undefined,
      httpPath: opts.path,
      access: opts.access,
      apiKey: opts.apiKey
    });
  });

program
  .command("search")
  .description("Quick CLI search against the Upstash Vector index")
  .argument("[query]", "search query")
  .option("--q <query>", "search query (alternative to the positional argument)")
  .option("--scope <name>", "scope override")
  .option("--top-k <n>", "top K results", "10")
  .option("--path-prefix <prefix>", "path prefix filter")
  .action(async (queryArg: string | undefined, opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    if (queryArg !== undefined && opts.q !== undefined && queryArg !== opts.q) {
      process.stderr.write("error: pass the query either as an argument or with --q, not both\n");
      process.exitCode = EXIT_INVALID_USAGE;
      return;
    }
    const query: string | undefined = queryArg ?? opts.q;
    if (query === undefined || query.trim() === "") {
      process.stderr.write('error: a search query is required, e.g. searchsocket search "getting started"\n');
      process.exitCode = EXIT_INVALID_USAGE;
      return;
    }

    const engine = await SearchEngine.create({
      cwd,
      configPath: rootOpts?.config
    });

    const result = await engine.search({
      q: query,
      scope: opts.scope,
      topK: parsePositiveInt(opts.topK, "--top-k"),
      pathPrefix: opts.pathPrefix
    });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

program
  .command("test")
  .description("Run search quality assertions against the live index")
  .option("--file <path>", "path to test file", "searchsocket.test.json")
  .option("--scope <name>", "scope override")
  .option("--top-k <n>", "results per query", "10")
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());
    const topK = parsePositiveInt(opts.topK, "--top-k");
    // The engine's own bound. Checked here because a per-query rejection would
    // otherwise be counted as a failed assertion (exit 3) rather than bad usage.
    if (topK > MAX_TEST_TOP_K) {
      throw new SearchSocketError("INVALID_REQUEST", `--top-k must be at most ${MAX_TEST_TOP_K}`, 400);
    }

    const filePath = path.resolve(cwd, opts.file);
    let rawContent: string;
    try {
      rawContent = await fsp.readFile(filePath, "utf8");
    } catch {
      process.stderr.write(`error: test file not found: ${filePath}\n`);
      process.exitCode = EXIT_INVALID_USAGE;
      return;
    }

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(rawContent);
    } catch {
      process.stderr.write(`error: invalid JSON in ${filePath}\n`);
      process.exitCode = EXIT_INVALID_USAGE;
      return;
    }

    const parsed = testFileSchema.safeParse(rawJson);
    if (!parsed.success) {
      process.stderr.write(`error: invalid test file: ${parsed.error.issues[0]?.message ?? "unknown error"}\n`);
      process.exitCode = EXIT_INVALID_USAGE;
      return;
    }

    const testCases = parsed.data;

    const engine = await SearchEngine.create({
      cwd,
      configPath: rootOpts?.config
    });
    if (!engine.isConfigured()) {
      process.stderr.write(
        "error: search backend not configured. Set UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN.\n"
      );
      process.exitCode = EXIT_BACKEND_UNAVAILABLE;
      return;
    }

    let passed = 0;
    let failed = 0;
    const mrrData: MrrObservation[] = [];
    // Queries whose retrieval threw. They contribute no observation, so the MRR
    // below describes a smaller sample than the test file and says so.
    let retrievalErrors = 0;
    // Exit codes of the retrieval errors, classified as if each had escaped the
    // command: a query the engine refused is a test-file defect (2), a backend
    // failure is 5. Neither is a failed assertion.
    const retrievalExitCodes = new Set<number>();

    for (const tc of testCases) {
      let results: SearchResult[];
      try {
        const response = await engine.search({
          q: tc.query,
          topK,
          scope: opts.scope
        });
        results = response.results;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stdout.write(`FAIL "${tc.query}" → search error: ${msg}\n`);
        failed++;
        retrievalErrors++;
        retrievalExitCodes.add(exitCodeForError(error));
        continue;
      }

      // One relevance observation per query, whatever mix of assertions the case
      // carries. Pushing once per assertion let a case asserting both topResult
      // and inTop5 count twice and skew the mean towards well-specified queries.
      const relevantUrls = new Set<string>();
      if (tc.expect.topResult !== undefined) relevantUrls.add(tc.expect.topResult);
      for (const url of tc.expect.inTop5 ?? []) relevantUrls.add(url);
      if (relevantUrls.size > 0) {
        mrrData.push({ results, relevant: [...relevantUrls] });
      }

      if (tc.expect.topResult !== undefined) {
        const expectedUrl = tc.expect.topResult;
        const rank = results.findIndex((r) => r.url === expectedUrl) + 1;

        if (rank === 1) {
          process.stdout.write(`PASS "${tc.query}" → ${expectedUrl} at rank 1\n`);
          passed++;
        } else {
          const detail = rank === 0 ? "not found" : `got rank ${rank}`;
          process.stdout.write(`FAIL "${tc.query}" → expected ${expectedUrl} at rank 1, ${detail}\n`);
          failed++;
        }
      }

      if (tc.expect.inTop5 !== undefined) {
        const expectedUrls = tc.expect.inTop5;
        const top5Urls = results.slice(0, 5).map((r) => r.url);
        const missing = expectedUrls.filter((url) => !top5Urls.includes(url));

        if (missing.length === 0) {
          process.stdout.write(`PASS "${tc.query}" → all expected URLs in top 5\n`);
          passed++;
        } else {
          const missingDetail = missing
            .map((url) => {
              const rank = results.findIndex((r) => r.url === url) + 1;
              return rank === 0 ? `${url} (not found)` : `${url} (rank ${rank})`;
            })
            .join(", ");
          process.stdout.write(`FAIL "${tc.query}" → missing from top 5: ${missingDetail}\n`);
          failed++;
        }
      }

      if (tc.expect.maxResults !== undefined) {
        const max = tc.expect.maxResults;
        const actual = results.length;

        if (actual <= max) {
          process.stdout.write(`PASS "${tc.query}" → ${actual} results (max ${max})\n`);
          passed++;
        } else {
          process.stdout.write(`FAIL "${tc.query}" → expected at most ${max} results, got ${actual}\n`);
          failed++;
        }
      }
    }

    const total = passed + failed;
    process.stdout.write(`\nresults: ${passed} passed, ${failed} failed of ${total} assertions\n`);

    if (mrrData.length > 0 || retrievalErrors > 0) {
      const report = mrrReport(mrrData, retrievalErrors);
      const plural = (n: number): string => (n === 1 ? "query" : "queries");
      process.stdout.write(`MRR: ${report.score.toFixed(4)} over ${report.scored} ${plural(report.scored)}\n`);
      if (!report.complete) {
        process.stdout.write(
          `MRR incomplete: ${report.unscored} ${plural(report.unscored)} could not be retrieved and are excluded\n`
        );
        process.stderr.write(
          `warning: MRR excludes ${report.unscored} ${plural(report.unscored)} whose search failed; ` +
            `the score is not comparable to a clean run\n`
        );
      }
    }

    process.stdout.write(`pass rate: ${total > 0 ? ((passed / total) * 100).toFixed(1) : "0.0"}%\n`);

    // Assertions only mean something when every query was retrieved, so a
    // retrieval failure outranks the quality gate.
    const retrievalExit = [EXIT_INVALID_USAGE, EXIT_BACKEND_UNAVAILABLE, EXIT_OPERATIONAL_FAILURE].find((code) =>
      retrievalExitCodes.has(code)
    );
    if (retrievalExit !== undefined) {
      process.exitCode = retrievalExit;
    } else if (failed > 0) {
      process.exitCode = EXIT_QUALITY_GATE;
    }
  });

program
  .command("add <component>")
  .description("Copy a Svelte 5 search component template into your project")
  .option("--dir <path>", "output directory", "src/lib/components/search")
  .option("--overwrite", "overwrite existing files", false)
  .action(async (component: string, opts: { dir: string; overwrite: boolean }, command) => {
    const root = getRootOptions(command).cwd ?? process.cwd();
    const cwd = path.resolve(root);

    if (!isValidComponent(component)) {
      const available = listAvailableComponents();
      process.stderr.write(`unknown component: ${component}\n`);
      process.stderr.write(`available components: ${available.join(", ")}\n`);
      process.exit(EXIT_INVALID_USAGE);
    }

    const targetDir = path.resolve(cwd, opts.dir);
    const result = await copyComponent(component, targetDir, { overwrite: opts.overwrite });

    for (const filePath of result.written) {
      process.stdout.write(`created: ${path.relative(cwd, filePath)}\n`);
    }
    for (const filePath of result.skipped) {
      process.stdout.write(`skipped (exists): ${path.relative(cwd, filePath)}\n`);
    }

    const entryName = path.basename(result.entry, ".svelte");
    const relativeEntry = path.relative(cwd, result.entry).replace(/\\/g, "/");

    if (result.skipped.length > 0 && result.entryWritten) {
      process.stdout.write(
        `\nnote: ${result.skipped.length} existing file(s) were kept. ` +
          `${entryName} uses those, not the versions in this release.\n` +
          `Pass --overwrite to replace them.\n`
      );
    }

    if (!result.entryWritten) {
      // Your copy was kept. Describing the new template's props here would be
      // describing a component you do not have.
      process.stdout.write(
        `\n${relativeEntry} already exists and was kept.\n` +
          `Pass --overwrite to replace it with the current template.\n`
      );
      return;
    }

    // SvelteKit projects address src/lib through the $lib alias; printing the
    // raw relative path there gives an import that does not resolve.
    const entryPath = relativeEntry.startsWith("src/lib/")
      ? `$lib/${relativeEntry.slice("src/lib/".length)}`
      : `./${relativeEntry}`;
    process.stdout.write(`\nImport:\n`);
    process.stdout.write(`  import ${entryName} from "${entryPath}";\n`);
    process.stdout.write(`\nTheme:\n`);
    process.stdout.write(`  <${entryName} theme="inherit" />   inherit | system | light | dark\n`);
    process.stdout.write(`\nCustomize:\n`);
    process.stdout.write(
      `  override --ss-search-accent and the other tokens in search-theme.css,\n`
    );
    process.stdout.write(`  globally or per instance via the style prop.\n`);
  });

/**
 * Load `.env` without letting dotenv write to stdout.
 *
 * dotenv 17 prints "injecting env (n) from .env" via console.log, and the MCP
 * stdio transport requires stdout to carry protocol JSON only — this runs long
 * before the MCP server installs its own redirect. `quiet: true` alone is not
 * enough: dotenv re-reads DOTENV_CONFIG_QUIET/DOTENV_CONFIG_DEBUG from the
 * environment *and* from the .env file it just loaded, either of which turns the
 * logging back on. Pinning console output to stderr for the duration covers
 * every one of those paths.
 */
function loadDotenvWithoutTouchingStdout(envPath: string): void {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    originalError(...args);
  };

  try {
    dotenvConfig({ path: envPath, quiet: true });
  } finally {
    console.log = originalLog;
  }
}

async function main(): Promise<void> {
  // Resolve --cwd before loading .env. Loading from process.cwd() first meant
  // `searchsocket --cwd ../site index` read the wrong directory's credentials —
  // or none at all, and then reported the backend as unconfigured.
  // Commander accepts --cwd path, --cwd=path, -C path, and -Cpath, so all four
  // must be recognised here or `.env` is read from the wrong directory for the
  // forms this misses.
  let cwdArg: string | undefined;
  for (let i = 0; i < process.argv.length; i += 1) {
    const arg = process.argv[i]!;
    if (arg === "--cwd" || arg === "-C") {
      cwdArg = process.argv[i + 1];
      break;
    }
    if (arg.startsWith("--cwd=")) {
      cwdArg = arg.slice("--cwd=".length);
      break;
    }
    if (arg.startsWith("-C") && arg.length > 2) {
      cwdArg = arg.slice(2);
      break;
    }
  }
  const envDir = cwdArg ? path.resolve(process.cwd(), cwdArg) : process.cwd();

  loadDotenvWithoutTouchingStdout(path.resolve(envDir, ".env"));
  await program.parseAsync(process.argv);
}

/** Exit code for an error that escaped a command's own handling. */
function exitCodeForError(error: unknown): number {
  if (error instanceof SearchSocketError) {
    switch (error.code) {
      case "CONFIG_INVALID":
      case "CONFIG_MISSING":
      case "INVALID_REQUEST":
        return EXIT_INVALID_USAGE;
      case "VECTOR_BACKEND_UNAVAILABLE":
      // No backend credentials: `search` builds an engine without a store and
      // fails on first use, which is the table's "unconfigured backend".
      case "SEARCH_NOT_CONFIGURED":
      case "RATE_LIMITED":
        return EXIT_BACKEND_UNAVAILABLE;
      default:
        return EXIT_OPERATIONAL_FAILURE;
    }
  }
  return EXIT_OPERATIONAL_FAILURE;
}

main().catch((error) => {
  if (error instanceof CommanderError) {
    // Commander has already printed the message (or the help/version text).
    process.exit(error.exitCode === 0 ? 0 : EXIT_INVALID_USAGE);
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`searchsocket error: ${message}\n`);
  process.exit(exitCodeForError(error));
});
