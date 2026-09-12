import fs from "node:fs";
import path from "node:path";
import { parseModule, generateCode, builders } from "magicast";

/**
 * Create or merge a .mcp.json file with the searchsocket MCP server entry.
 * Uses ${VAR} env var references that Claude Code expands at runtime.
 * @internal
 */
export function ensureMcpJson(cwd: string): void {
  const mcpPath = path.join(cwd, ".mcp.json");

  const entry = {
    command: "npx",
    args: ["searchsocket", "mcp"],
    env: {
      UPSTASH_VECTOR_REST_URL: "${UPSTASH_VECTOR_REST_URL}",
      UPSTASH_VECTOR_REST_TOKEN: "${UPSTASH_VECTOR_REST_TOKEN}",
    },
  };

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(mcpPath)) {
    try {
      const raw = fs.readFileSync(mcpPath, "utf8");
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      process.stderr.write("warning: .mcp.json exists but could not be parsed — skipping\n");
      return;
    }
  }

  const raw_servers = existing.mcpServers ?? {};
  const servers = (typeof raw_servers === "object" && !Array.isArray(raw_servers) ? raw_servers : {}) as Record<string, unknown>;
  if (JSON.stringify(servers["searchsocket"]) === JSON.stringify(entry)) {
    return;
  }

  existing.mcpServers = { ...servers, searchsocket: entry };
  fs.writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
}

export type HookInjectionResult = "created" | "injected" | "composed" | "already-present" | "fallback";

export const HOOKS_SNIPPET = `import { searchsocketHandle } from "searchsocket/sveltekit";

export const handle = searchsocketHandle();`;

export const HOOKS_SEQUENCE_SNIPPET = `import { sequence } from "@sveltejs/kit/hooks";
import { searchsocketHandle } from "searchsocket/sveltekit";

// Compose with your existing handle. Keep yours first: searchsocketHandle()
// answers its own endpoints without calling resolve(), so anything sequenced
// after it never sees those requests. Your handle stays outer, and search is
// reached through its resolve() — which also means a handle that blocks a
// request (auth, maintenance mode) blocks search, MCP, CORS preflight and
// llms.txt too. Exempt those paths in your own handle if that is not what
// you want.
export const handle = sequence(yourExistingHandle, searchsocketHandle());`;

export const VITE_PLUGIN_SNIPPET = `import { searchsocketVitePlugin } from "searchsocket/sveltekit";

// Add to your Vite config plugins array:
// plugins: [sveltekit(), searchsocketVitePlugin()]`;

/**
 * True when the file exports a handle in a shape magicast's `exports` view
 * cannot see: `export { handle } from "./auth"`, `export { authHandle as
 * handle }`, or a star re-export that may forward one.
 *
 * Adding `export const handle` beside any of those is worse than doing
 * nothing: the named forms become a duplicate export (a syntax error) and a
 * star re-export silently shadows the app's real handle, disabling its
 * middleware for every route rather than only the search ones.
 */
function hasUnreachableHandleExport(program: unknown): boolean {
  const body = (program as { body?: unknown }).body;
  if (!Array.isArray(body)) return false;

  return body.some((node: { type?: string; specifiers?: unknown }) => {
    if (node.type === "ExportAllDeclaration") {
      return true;
    }
    if (node.type !== "ExportNamedDeclaration" || !Array.isArray(node.specifiers)) {
      return false;
    }
    return node.specifiers.some(
      (specifier: { exported?: { name?: string } }) => specifier.exported?.name === "handle"
    );
  });
}

/**
 * Inject searchsocketHandle into src/hooks.server.ts using AST manipulation.
 * Falls back gracefully if the file can't be parsed.
 */
export function injectHooksServerTs(cwd: string): HookInjectionResult {
  const hooksDir = path.join(cwd, "src");
  const tsPath = path.join(hooksDir, "hooks.server.ts");
  const jsPath = path.join(hooksDir, "hooks.server.js");
  const hooksPath = fs.existsSync(tsPath) ? tsPath : fs.existsSync(jsPath) ? jsPath : null;

  // If no hooks file exists, create hooks.server.ts from scratch
  if (!hooksPath) {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(tsPath, HOOKS_SNIPPET + "\n", "utf8");
    return "created";
  }

  // Read existing file
  const original = fs.readFileSync(hooksPath, "utf8");

  // Check if searchsocketHandle is already imported
  if (original.includes("searchsocketHandle")) {
    return "already-present";
  }

  try {
    const mod = parseModule(original);

    if (!mod.exports.handle && hasUnreachableHandleExport(mod.$ast)) {
      return "fallback";
    }

    // Add the searchsocketHandle import
    mod.imports.$append({
      from: "searchsocket/sveltekit",
      imported: "searchsocketHandle",
    });

    if (mod.exports.handle) {
      // Existing handle export — compose with sequence()
      mod.imports.$append({
        from: "@sveltejs/kit/hooks",
        imported: "sequence",
      });

      // The app's own handle goes first. Under `sequence`, each handler's
      // `resolve` invokes the next one, and searchsocketHandle() returns its
      // endpoint responses without ever calling `resolve` — so putting it
      // first would skip the app's auth, logging and header middleware for
      // every SearchSocket route. Outer-first keeps that middleware in the
      // path; a handler that short-circuits now blocks search as well, which
      // is the behaviour an authenticated site actually asked for.
      const existingHandle = mod.exports.handle;
      mod.exports.handle = builders.functionCall(
        "sequence",
        existingHandle,
        builders.functionCall("searchsocketHandle"),
      );

      const { code } = generateCode(mod);
      fs.writeFileSync(hooksPath, code, "utf8");
      return "composed";
    }

    // No existing handle — add a simple export
    mod.exports.handle = builders.functionCall("searchsocketHandle");
    const { code } = generateCode(mod);
    fs.writeFileSync(hooksPath, code, "utf8");
    return "injected";
  } catch {
    // AST manipulation failed — leave file unchanged
    return "fallback";
  }
}

export type ViteInjectionResult = "injected" | "already-present" | "no-config" | "fallback";

/**
 * Inject searchsocketVitePlugin into vite.config.ts/js using AST manipulation.
 * Falls back gracefully if the file can't be parsed.
 */
export function injectViteConfig(cwd: string): ViteInjectionResult {
  // Find the vite config file
  const tsPath = path.join(cwd, "vite.config.ts");
  const jsPath = path.join(cwd, "vite.config.js");
  const configPath = fs.existsSync(tsPath) ? tsPath : fs.existsSync(jsPath) ? jsPath : null;

  if (!configPath) {
    return "no-config";
  }

  const original = fs.readFileSync(configPath, "utf8");

  // Check if searchsocketVitePlugin is already imported
  if (original.includes("searchsocketVitePlugin")) {
    return "already-present";
  }

  try {
    const mod = parseModule(original);

    // Add the import
    mod.imports.$append({
      from: "searchsocket/sveltekit",
      imported: "searchsocketVitePlugin",
    });

    // Get the config object — may be wrapped in defineConfig()
    let config = mod.exports.default;
    if (!config) {
      return "fallback";
    }

    // Unwrap defineConfig() wrapper
    if (config.$type === "function-call") {
      config = config.$args[0];
    }

    // Ensure plugins array exists and append our plugin
    if (!config.plugins) {
      config.plugins = [builders.functionCall("searchsocketVitePlugin")];
    } else {
      config.plugins.push(builders.functionCall("searchsocketVitePlugin"));
    }

    const { code } = generateCode(mod);
    fs.writeFileSync(configPath, code, "utf8");
    return "injected";
  } catch {
    // AST manipulation failed — leave file unchanged
    return "fallback";
  }
}

/**
 * Append Upstash credentials to .env file if not already present.
 * Creates .env if it doesn't exist.
 */
export function writeEnvFile(cwd: string, url: string, token: string): void {
  const envPath = path.join(cwd, ".env");
  let content = "";

  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf8");
  }

  const lines: string[] = [];
  if (!content.includes("UPSTASH_VECTOR_REST_URL=")) {
    lines.push(`UPSTASH_VECTOR_REST_URL=${url}`);
  }
  if (!content.includes("UPSTASH_VECTOR_REST_TOKEN=")) {
    lines.push(`UPSTASH_VECTOR_REST_TOKEN=${token}`);
  }

  if (lines.length > 0) {
    const suffix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(envPath, content + suffix + lines.join("\n") + "\n", "utf8");
  }

  // Ensure .env is in .gitignore
  ensureGitignoreEntry(cwd, ".env");
}

/**
 * Ensure a single entry exists in .gitignore.
 */
function ensureGitignoreEntry(cwd: string, entry: string): void {
  const gitignorePath = path.join(cwd, ".gitignore");
  let content = "";
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf8");
  }

  const lines = content.split("\n");
  if (lines.some((line) => line.trim() === entry)) {
    return;
  }

  const suffix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(gitignorePath, content + suffix + entry + "\n", "utf8");
}
