import { z } from "zod";
import { URL_PATTERN_SYNTAX, describeUnsupportedUrlPattern } from "../utils/pattern";

/**
 * A URL path pattern as understood by `matchUrlPattern`. Validated here because
 * an unsupported glob would otherwise be compared literally and never match —
 * an `exclude` that excludes nothing, or a page weight that weights nothing.
 */
const urlPattern = z.string().superRefine((pattern, ctx) => {
  const problem = describeUnsupportedUrlPattern(pattern);
  if (problem) {
    ctx.addIssue({ code: "custom", message: `${problem} ${URL_PATTERN_SYNTAX}` });
  }
});

// Every object is strict: zod would otherwise strip an unknown key silently, so
// a misspelled option (`ranking.minScoreRaito`) would look accepted while doing
// nothing. load.ts turns the resulting issue into a message naming the key.
export const searchSocketConfigSchema = z.strictObject({
  project: z
    .strictObject({
      id: z.string().min(1).optional(),
      baseUrl: z.string().url().optional()
    })
    .optional(),
  scope: z
    .strictObject({
      mode: z.enum(["fixed", "git", "env"]).optional(),
      fixed: z.string().min(1).optional(),
      envVar: z.string().min(1).optional(),
      sanitize: z.boolean().optional()
    })
    .optional(),
  exclude: z.array(urlPattern).optional(),
  respectRobotsTxt: z.boolean().optional(),
  source: z
    .strictObject({
      mode: z.enum(["static-output", "crawl", "content-files", "build"]).optional(),
      staticOutputDir: z.string().min(1).optional(),
      strictRouteMapping: z.boolean().optional(),
      crawl: z
        .strictObject({
          baseUrl: z.string().url(),
          routes: z.array(z.string()).optional(),
          sitemapUrl: z.string().optional()
        })
        .optional(),
      contentFiles: z
        .strictObject({
          globs: z.array(z.string()).min(1),
          baseDir: z.string().optional()
        })
        .optional(),
      build: z
        .strictObject({
          outputDir: z.string().min(1).optional(),
          paramValues: z.record(z.string(), z.array(z.string())).optional(),
          exclude: z.array(urlPattern).optional(),
          previewTimeout: z.number().int().positive().optional(),
          discover: z.boolean().optional(),
          seedUrls: z.array(z.string()).optional(),
          maxPages: z.number().int().positive().optional(),
          maxDepth: z.number().int().nonnegative().optional()
        })
        .optional()
    })
    .optional(),
  extract: z
    .strictObject({
      mainSelector: z.string().optional(),
      dropTags: z.array(z.string()).optional(),
      dropSelectors: z.array(z.string()).optional(),
      ignoreAttr: z.string().optional(),
      noindexAttr: z.string().optional(),
      imageDescAttr: z.string().optional(),
      respectRobotsNoindex: z.boolean().optional()
    })
    .optional(),
  transform: z
    .strictObject({
      preserveCodeBlocks: z.boolean().optional(),
      preserveTables: z.boolean().optional()
    })
    .optional(),
  chunking: z
    .strictObject({
      maxChars: z.number().int().positive().optional(),
      overlapChars: z.number().int().nonnegative().optional(),
      minChars: z.number().int().positive().optional(),
      headingPathDepth: z.number().int().positive().optional(),
      dontSplitInside: z.array(z.enum(["code", "table", "blockquote"])).optional(),
      prependTitle: z.boolean().optional(),
      pageSummaryChunk: z.boolean().optional(),
    })
    .optional(),
  upstash: z
    .strictObject({
      url: z.string().url().optional(),
      token: z.string().min(1).optional(),
      urlEnv: z.string().min(1).optional(),
      tokenEnv: z.string().min(1).optional(),
      namespaces: z
        .strictObject({
          pages: z.string().min(1).optional(),
          chunks: z.string().min(1).optional()
        })
        .optional(),
      /** Records per write/delete/fetch request. Default 90, max 500. */
      batchSize: z.number().int().positive().max(500).optional(),
      /** Retries for transient failures (rate limit, timeout, 5xx). Default 2. */
      maxRetries: z.number().int().min(0).max(10).optional()
    })
    .optional(),
  indexing: z
    .strictObject({
      /**
       * Refuse to delete when a run would remove more than this fraction of
       * the existing pages, unless --accept-large-deletion is passed.
       * A sudden mass deletion is far more often a broken source config than
       * a genuinely emptied site.
       */
      maxDeletionRatio: z.number().min(0).max(1).optional()
    })
    .optional(),
  ranking: z
    .strictObject({
      enableIncomingLinkBoost: z.boolean().optional(),
      enableDepthBoost: z.boolean().optional(),
      enableFreshnessBoost: z.boolean().optional(),
      freshnessDecayRate: z.number().positive().optional(),
      enableAnchorTextBoost: z.boolean().optional(),
      pageWeights: z.record(urlPattern, z.number().min(0)).optional(),
      minScoreRatio: z.number().min(0).max(1).optional(),
      scoreGapThreshold: z.number().min(0).max(1).optional(),
      weights: z
        .strictObject({
          incomingLinks: z.number().optional(),
          depth: z.number().optional(),
          titleMatch: z.number().optional(),
          freshness: z.number().optional(),
          anchorText: z.number().optional()
        })
        .optional()
    })
    .optional(),
  api: z
    .strictObject({
      path: z.string().optional(),
      cors: z
        .strictObject({
          allowOrigins: z.array(z.string()).optional()
        })
        .optional(),
      /**
       * Scopes a browser request may select with `?scope=`. Empty (the default)
       * means the caller cannot choose at all and always gets the server's
       * configured scope.
       */
      allowedScopes: z.array(z.string()).optional(),
      /**
       * Include internal fields — source file paths and matched sections' indexed text — in
       * browser search responses. Off by default: these are useful to an editing
       * agent and are not something a public search box should disclose.
       */
      exposeInternalFields: z.boolean().optional(),
      rateLimit: z
        .strictObject({
          windowMs: z.number().int().positive().optional(),
          max: z.number().int().positive().optional()
        })
        .optional()
    })
    .optional(),
  mcp: z
    .strictObject({
      enable: z.boolean().optional(),
      access: z.enum(["public", "private"]).optional(),
      transport: z.enum(["stdio", "http"]).optional(),
      http: z
        .strictObject({
          port: z.number().int().positive().optional(),
          path: z.string().optional(),
          apiKey: z.string().min(1).optional(),
          apiKeyEnv: z.string().min(1).optional()
        })
        .optional(),
      handle: z
        .strictObject({
          path: z.string().optional(),
          /**
           * Independent of the top-level `mcp.access`, which only governs the
           * standalone server's bind address. "public" serves anonymous
           * callers a redacted result set instead of refusing them.
           */
          access: z.enum(["public", "private"]).optional(),
          apiKey: z.string().min(1).optional(),
          /** Env var holding the key, so it need not be committed. */
          apiKeyEnv: z.string().min(1).optional(),
          enableJsonResponse: z.boolean().optional()
        })
        .optional()
    })
    .optional(),
  llmsTxt: z
    .strictObject({
      enable: z.boolean().optional(),
      outputPath: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      generateFull: z.boolean().optional(),
      serveMarkdownVariants: z.boolean().optional()
    })
    .optional(),
  state: z
    .strictObject({
      // `clean` deletes this directory recursively. Only the two spellings that
      // are always a mistake are rejected here; containment is decided by
      // resolveStateDir in core/state.ts, which knows the project root and can
      // resolve symlinks. Note the value is NOT trimmed: on POSIX a trailing
      // space names a different directory, and rewriting it would silently
      // retarget the deletion.
      dir: z
        .string()
        .refine((dir) => dir.trim() !== "", { message: "state.dir must not be empty" })
        .refine((dir) => dir !== "." && dir !== "./", {
          message: 'state.dir must not be the project directory itself (".")'
        })
        .optional()
    })
    .optional()
});

export type ParsedSearchSocketConfig = z.infer<typeof searchSocketConfigSchema>;
