import { execSync } from "node:child_process";
import type { ResolvedSearchSocketConfig, Scope } from "../types";
import { sanitizeScopeName } from "../utils/text";
import { assertSafeName } from "../vector/ids";
import { SearchSocketError } from "../errors";

function resolveRawScopeName(config: ResolvedSearchSocketConfig, cwd?: string): string {
  if (config.scope.mode === "fixed") {
    return config.scope.fixed;
  }

  if (config.scope.mode === "env") {
    const value = process.env[config.scope.envVar];
    if (!value) {
      throw new SearchSocketError("CONFIG_MISSING", `Scope mode is env but ${config.scope.envVar} is not set.`);
    }

    return value;
  }

  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      // Without this, `searchsocket --cwd ../site index` read ../site's config
      // and content but resolved the *current* repository's branch — indexing
      // into, and deleting from, the wrong scope.
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return config.scope.fixed;
  }
}

export function resolveScope(
  config: ResolvedSearchSocketConfig,
  override?: string,
  cwd?: string
): Scope {
  const rawName = override ?? resolveRawScopeName(config, cwd);
  const scopeName = config.scope.sanitize ? sanitizeScopeName(rawName) : rawName;

  // Both values are embedded in record IDs and in Upstash filter literals.
  // Validating here means an unsafe name fails at resolution rather than
  // producing a malformed ID or escaping the surrounding filter expression.
  // `scope.sanitize: false` is the path that makes this reachable: it hands
  // the raw branch name straight through.
  assertSafeName("project id", config.project.id);
  assertSafeName("scope name", scopeName);

  return {
    projectId: config.project.id,
    scopeName,
    scopeId: `${config.project.id}:${scopeName}`
  };
}
