import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { z } from "zod";
import { searchSocketConfigSchema } from "./schema";
import { createDefaultConfig } from "./defaults";
import type { ParsedSearchSocketConfig } from "./schema";
import type { ResolvedSearchSocketConfig, SearchSocketConfig, SourceMode } from "../types";
import { SearchSocketError } from "../errors";

/**
 * Settings supplied outside the config file — CLI flags — that must be part of
 * the config before it is validated. Applied after validation, a flag such as
 * `--api-key` would arrive too late to satisfy a check it exists to satisfy.
 */
export interface ConfigOverrides {
  mcp?: {
    access?: "public" | "private";
    apiKey?: string;
  };
}

export interface LoadConfigOptions {
  cwd?: string;
  configPath?: string;
  allowMissing?: boolean;
  overrides?: ConfigOverrides;
}

function inferProjectId(cwd: string): string {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return path.basename(cwd);
  }

  const raw = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: string };
  return (raw.name ?? path.basename(cwd)).replace(/[^a-zA-Z0-9._-]/g, "-");
}

function detectSourceMode(cwd: string, config: ResolvedSearchSocketConfig, parsedInput: ParsedSearchSocketConfig): SourceMode {
  if (parsedInput.source?.mode) {
    return parsedInput.source.mode;
  }

  if (parsedInput.source?.build) {
    return "build";
  }

  if (parsedInput.source?.crawl) {
    return "crawl";
  }

  if (parsedInput.source?.contentFiles) {
    return "content-files";
  }

  const staticOutputPath = path.resolve(cwd, config.source.staticOutputDir);
  if (fs.existsSync(staticOutputPath)) {
    return "static-output";
  }

  throw new SearchSocketError(
    "CONFIG_MISSING",
    `Unable to auto-detect source mode because ${staticOutputPath} does not exist. ` +
      "Set `source.mode` explicitly (static-output, crawl, content-files, or build)."
  );
}

/**
 * Config keys that no longer exist, mapped to what to do instead.
 *
 * The schema rejects unknown keys, but "unrecognized key" says nothing about
 * what to do next. This runs first so a key that used to exist gets a migration
 * message instead — `search.dualSearch` and `search.pageSearchWeight` were tuned
 * by users for several releases despite having no effect.
 */
const REMOVED_CONFIG_KEYS: Array<{ path: string; reason: string }> = [
  {
    path: "transform.output",
    reason:
      "Markdown was the only accepted value and nothing read this option; extraction " +
      "always produces Markdown. Delete it."
  },
  {
    path: "chunking.strategy",
    reason:
      '"hybrid" was the only accepted value and nothing read this option; chunking is ' +
      "always heading-aware with length limits. Delete it and tune chunking.maxChars, " +
      "chunking.overlapChars and chunking.minChars instead."
  },
  {
    path: "analytics",
    reason: "Search analytics were removed and this option does nothing. Delete it."
  },
  {
    path: "search.dualSearch",
    reason:
      "Dual page+chunk retrieval was removed in 0.8. Search is page-first: pages are " +
      "ranked, then the best sections within each are retrieved. Delete this option."
  },
  {
    path: "search.pageSearchWeight",
    reason:
      "This blended page and chunk scores in the removed dual-retrieval path and has " +
      "had no effect on the default search since page-first ranking landed. Delete it; " +
      "tune ranking.weights instead."
  },
  {
    path: "ranking.aggregationCap",
    reason:
      "Chunk aggregation was part of the removed dual-retrieval path and never " +
      "affected page-first search. Delete this option."
  },
  {
    path: "ranking.aggregationDecay",
    reason:
      "Chunk aggregation was part of the removed dual-retrieval path and never " +
      "affected page-first search. Delete this option."
  },
  {
    path: "ranking.minChunkScoreRatio",
    reason:
      "This filtered sub-results in the removed page-grouping code path. Section " +
      "sub-results are now bounded by the maxSubResults request option."
  },
  {
    path: "ranking.weights.aggregation",
    reason:
      "The aggregation bonus it weighted was part of the removed dual-retrieval " +
      "path. Delete this option."
  },
  {
    path: "chunking.weightHeadings",
    reason:
      "This only perturbed the chunk content hash — the weighted heading text was " +
      "never sent to the embedding model — so enabling it caused re-embedding churn " +
      "without changing relevance. Use chunking.prependTitle, which does reach the model."
  },
  {
    path: "embedding.images.enable",
    reason:
      "SearchSocket is text-only. Images are searchable through their text " +
      "descriptions (data-search-description, alt, figcaption); there is no image " +
      "embedding to enable."
  },
  {
    path: "embedding.batchSize",
    reason:
      "Batch size is controlled by upstash.batchSize. This option never affected " +
      "anything at runtime."
  },
  {
    path: "embedding.model",
    reason:
      "Embeddings are generated by Upstash, not by SearchSocket, so the model is a " +
      "property of the index itself and is chosen when you create it in the Upstash " +
      "console. Setting it here never changed which model ran. To use a different " +
      "model, create a new index with it and point upstash.url/token at that index."
  },
  {
    path: "embedding.dimensions",
    reason:
      "Vector dimensions follow from the model the Upstash index was created with; " +
      "SearchSocket sends text, never vectors, so this value was never read. Delete it."
  },
  {
    path: "embedding.taskType",
    reason:
      "Upstash-hosted embedding takes no task-type parameter, and SearchSocket never " +
      "sent one. Delete this option."
  }
];

function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function assertNoRemovedKeys(rawConfig: SearchSocketConfig): void {
  const found = REMOVED_CONFIG_KEYS.filter(
    (entry) => readPath(rawConfig, entry.path) !== undefined
  );
  if (found.length === 0) return;

  const details = found.map((entry) => `  ${entry.path}\n    ${entry.reason}`).join("\n");
  throw new SearchSocketError(
    "CONFIG_INVALID",
    `searchsocket.config.ts sets options that have been removed:\n${details}\n\n` +
      "See https://github.com/gregpriday/searchsocket/blob/main/docs/migration-0.8.md"
  );
}

type ConfigIssue = z.core.$ZodIssue;

function formatIssuePath(segments: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else {
      const key = String(segment);
      out += /^[A-Za-z_$][\w$]*$/.test(key) ? (out ? `.${key}` : key) : `[${JSON.stringify(key)}]`;
    }
  }
  return out || "(root)";
}

/** Keys the schema accepts at an object path, for did-you-mean suggestions. */
function knownKeysAt(segments: ReadonlyArray<PropertyKey>): string[] {
  let current: z.ZodType = searchSocketConfigSchema;
  for (const segment of [...segments, undefined]) {
    while (current instanceof z.ZodOptional) {
      current = current.unwrap() as z.ZodType;
    }
    if (segment === undefined) break;
    if (!(current instanceof z.ZodObject)) return [];
    const next = (current.shape as Record<string, z.ZodType>)[String(segment)];
    if (!next) return [];
    current = next;
  }
  return current instanceof z.ZodObject ? Object.keys(current.shape) : [];
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        diagonal + (a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase() ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return row[b.length]!;
}

function suggestKey(unknown: string, known: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const distance = editDistance(unknown, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best !== undefined && bestDistance <= Math.max(2, Math.floor(unknown.length / 3)) ? best : undefined;
}

function formatConfigIssues(issues: ReadonlyArray<ConfigIssue>): string {
  const lines: string[] = [];
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      const known = knownKeysAt(issue.path);
      for (const key of issue.keys) {
        const suggestion = suggestKey(key, known);
        const hint = suggestion ? ` Did you mean \`${formatIssuePath([...issue.path, suggestion])}\`?` : "";
        lines.push(`  ${formatIssuePath([...issue.path, key])}: unknown option.${hint}`);
      }
      continue;
    }
    if (issue.code === "invalid_key" && issue.issues.length > 0) {
      for (const inner of issue.issues) {
        lines.push(`  ${formatIssuePath(issue.path)}: ${inner.message}`);
      }
      continue;
    }
    lines.push(`  ${formatIssuePath(issue.path)}: ${issue.message}`);
  }
  return lines.join("\n");
}

function applyOverrides(rawConfig: SearchSocketConfig, overrides: ConfigOverrides | undefined): SearchSocketConfig {
  const mcp = overrides?.mcp;
  if (!mcp || (mcp.access === undefined && mcp.apiKey === undefined)) return rawConfig;
  return {
    ...rawConfig,
    mcp: {
      ...rawConfig.mcp,
      ...(mcp.access !== undefined ? { access: mcp.access } : {}),
      ...(mcp.apiKey !== undefined ? { http: { ...rawConfig.mcp?.http, apiKey: mcp.apiKey } } : {})
    }
  };
}

export function mergeConfig(cwd: string, rawConfig: SearchSocketConfig): ResolvedSearchSocketConfig {
  const projectId = rawConfig.project?.id ?? inferProjectId(cwd);
  const defaults = createDefaultConfig(projectId);

  // Before schema validation: a removed key must produce a migration message,
  // not be quietly stripped.
  assertNoRemovedKeys(rawConfig);

  const parseResult = searchSocketConfigSchema.safeParse(rawConfig);
  if (!parseResult.success) {
    const issues = formatConfigIssues(parseResult.error.issues);
    throw new SearchSocketError(
      "CONFIG_INVALID",
      `Invalid searchsocket.config.ts:\n${issues}`
    );
  }
  const parsed = parseResult.data;

  const merged: ResolvedSearchSocketConfig = {
    ...defaults,
    project: {
      ...defaults.project,
      ...parsed.project
    },
    scope: {
      ...defaults.scope,
      ...parsed.scope
    },
    exclude: parsed.exclude ?? defaults.exclude,
    respectRobotsTxt: parsed.respectRobotsTxt ?? defaults.respectRobotsTxt,
    source: {
      ...defaults.source,
      ...parsed.source,
      crawl: parsed.source?.crawl
        ? {
            ...defaults.source.crawl,
            ...parsed.source.crawl,
            routes: parsed.source.crawl.routes ?? []
          }
        : defaults.source.crawl,
      contentFiles: parsed.source?.contentFiles
        ? {
            ...defaults.source.contentFiles,
            ...parsed.source.contentFiles,
            baseDir: parsed.source.contentFiles.baseDir ?? defaults.source.contentFiles?.baseDir ?? cwd
          }
        : defaults.source.contentFiles,
      build: parsed.source?.build
        ? {
            outputDir: parsed.source.build.outputDir ?? ".svelte-kit/output",
            paramValues: parsed.source.build.paramValues ?? {},
            exclude: parsed.source.build.exclude ?? [],
            previewTimeout: parsed.source.build.previewTimeout ?? 30_000,
            discover: parsed.source.build.discover ?? false,
            seedUrls: parsed.source.build.seedUrls ?? ["/"],
            maxPages: parsed.source.build.maxPages ?? 200,
            maxDepth: parsed.source.build.maxDepth ?? 10
          }
        : undefined
    },
    extract: {
      ...defaults.extract,
      ...parsed.extract
    },
    transform: {
      ...defaults.transform,
      ...parsed.transform
    },
    chunking: {
      ...defaults.chunking,
      ...parsed.chunking
    },
    upstash: {
      ...defaults.upstash,
      ...parsed.upstash,
      namespaces: {
        ...defaults.upstash.namespaces,
        ...parsed.upstash?.namespaces
      },
      batchSize: parsed.upstash?.batchSize ?? defaults.upstash.batchSize,
      maxRetries: parsed.upstash?.maxRetries ?? defaults.upstash.maxRetries
    },
    indexing: {
      ...defaults.indexing,
      ...parsed.indexing
    },
    ranking: {
      ...defaults.ranking,
      ...parsed.ranking,
      pageWeights: {
        ...defaults.ranking.pageWeights,
        ...parsed.ranking?.pageWeights
      },
      weights: {
        ...defaults.ranking.weights,
        ...parsed.ranking?.weights
      }
    },
    api: {
      ...defaults.api,
      ...parsed.api,
      cors: {
        ...defaults.api.cors,
        ...parsed.api?.cors,
        allowOrigins: parsed.api?.cors?.allowOrigins ?? defaults.api.cors.allowOrigins
      },
      rateLimit: parsed.api?.rateLimit
        ? {
            windowMs: parsed.api.rateLimit.windowMs ?? 60_000,
            max: parsed.api.rateLimit.max ?? 60
          }
        : defaults.api.rateLimit
    },
    mcp: {
      ...defaults.mcp,
      ...parsed.mcp,
      http: {
        ...defaults.mcp.http,
        ...parsed.mcp?.http
      },
      handle: {
        ...defaults.mcp.handle,
        ...parsed.mcp?.handle
      }
    },
    llmsTxt: {
      ...defaults.llmsTxt,
      ...parsed.llmsTxt
    },
    state: {
      ...defaults.state,
      ...parsed.state
    }
  };

  merged.project.id = projectId;
  merged.source.mode = detectSourceMode(cwd, merged, parsed);

  if (merged.source.mode === "build" && !merged.source.build) {
    merged.source.build = {
      outputDir: ".svelte-kit/output",
      paramValues: {},
      exclude: [],
      previewTimeout: 30_000,
      discover: false,
      seedUrls: ["/"],
      maxPages: 200,
      maxDepth: 10
    };
  }

  // `mcp.access` governs the standalone MCP server only — it decides whether
  // that process binds to loopback or to all interfaces, so its public mode
  // still has to have a key and that guard stays here.
  //
  // `mcp.handle.access` is a separate switch, enforced per request by the
  // SvelteKit handler. Its public mode deliberately serves anonymous callers a
  // redacted result set, so requiring a handle key at load time would defeat
  // the setting outright — it gets no check here.
  if (merged.mcp.access === "public") {
    const resolvedKey = merged.mcp.http.apiKey
      ?? (merged.mcp.http.apiKeyEnv ? process.env[merged.mcp.http.apiKeyEnv] : undefined);
    if (!resolvedKey) {
      throw new SearchSocketError(
        "CONFIG_MISSING",
        '`mcp.access` is "public" but no API key is configured. Set `mcp.http.apiKey` or `mcp.http.apiKeyEnv`, or pass --api-key to `searchsocket mcp`.'
      );
    }
  }

  if (merged.source.mode === "crawl" && !merged.source.crawl?.baseUrl) {
    throw new SearchSocketError("CONFIG_MISSING", "`source.crawl.baseUrl` is required when source.mode is crawl.");
  }

  if (merged.source.mode === "content-files" && (!merged.source.contentFiles || merged.source.contentFiles.globs.length === 0)) {
    throw new SearchSocketError(
      "CONFIG_MISSING",
      "`source.contentFiles.globs` is required when source.mode is content-files."
    );
  }

  return merged;
}

/**
 * Resolve a partial config for serverless environments where filesystem lookups
 * (package.json, static output dir) are unavailable. Validates that `project.id`
 * and `source.mode` are explicitly set, then delegates to `mergeConfig()`.
 */
export function mergeConfigServerless(rawConfig: SearchSocketConfig): ResolvedSearchSocketConfig {
  if (!rawConfig.project?.id) {
    throw new SearchSocketError(
      "CONFIG_MISSING",
      "`project.id` is required for serverless config (cannot infer from package.json)."
    );
  }

  if (!rawConfig.source?.mode) {
    throw new SearchSocketError(
      "CONFIG_MISSING",
      "`source.mode` is required for serverless config (cannot auto-detect from filesystem)."
    );
  }

  return mergeConfig(process.cwd(), rawConfig);
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedSearchSocketConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const configPath = path.resolve(cwd, options.configPath ?? "searchsocket.config.ts");

  if (!fs.existsSync(configPath)) {
    if (options.allowMissing) {
      return mergeConfig(cwd, applyOverrides({
        source: {
          mode: "static-output"
        }
      }, options.overrides));
    }

    throw new SearchSocketError(
      "CONFIG_MISSING",
      `Configuration file not found at ${configPath}. Run \`searchsocket init\` first.`
    );
  }

  const jiti = createJiti(cwd, { interopDefault: true });
  let loaded: SearchSocketConfig;
  try {
    loaded = (await jiti.import(configPath)) as SearchSocketConfig;
  } catch (error) {
    // A syntax error or a throw while the file evaluates is a broken config,
    // not an operational failure; untyped, it escaped as exit 1 instead of 2.
    if (error instanceof SearchSocketError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new SearchSocketError("CONFIG_INVALID", `Failed to load configuration file ${configPath}: ${detail}`, {
      status: 500,
      cause: error
    });
  }
  const raw = (loaded as { default?: SearchSocketConfig }).default ?? loaded;

  return mergeConfig(cwd, applyOverrides(raw, options.overrides));
}

export function writeMinimalConfig(cwd: string): string {
  const target = path.join(cwd, "searchsocket.config.ts");
  if (fs.existsSync(target)) {
    return target;
  }

  const content = `export default {
  // Upstash Vector credentials (set via env vars or directly here)
  // upstash: { urlEnv: "UPSTASH_VECTOR_REST_URL", tokenEnv: "UPSTASH_VECTOR_REST_TOKEN" }
};
`;

  fs.writeFileSync(target, content, "utf8");
  return target;
}
