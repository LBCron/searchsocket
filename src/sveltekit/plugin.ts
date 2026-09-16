import path from "node:path";
import { IndexPipeline } from "../indexing/pipeline";
import { Logger } from "../core/logger";
import { SearchSocketError } from "../errors";
import type { IndexingHooks } from "../types";

interface MinimalResolvedConfig {
  build?: { ssr?: unknown };
}

interface MinimalHookContext {
  environment?: {
    name?: string;
    config?: { build?: { ssr?: unknown } };
  };
}

interface MinimalVitePlugin {
  name: string;
  apply?: "build" | "serve";
  enforce?: "pre" | "post";
  config?: () => Record<string, unknown>;
  configResolved?: (config: MinimalResolvedConfig) => void;
  closeBundle?: {
    sequential?: boolean;
    order?: "pre" | "post";
    handler: (this: MinimalHookContext) => Promise<void> | void;
  };
}

export interface SearchSocketAutoIndexOptions {
  cwd?: string;
  configPath?: string;
  enabled?: boolean;
  triggerEnvVar?: string;
  disableEnvVar?: string;
  changedOnly?: boolean;
  force?: boolean;
  dryRun?: boolean;
  scope?: string;
  verbose?: boolean;
  hooks?: IndexingHooks;
  /**
   * Treat missing Upstash credentials as a skip rather than a build failure.
   * Defaults to true, matching `searchsocket index --allow-unconfigured`: a
   * contributor without credentials should still be able to build the site.
   * Set to false when the build is the deploy — then an unconfigured
   * production build fails instead of shipping a stale index.
   *
   * This only covers a missing backend. A configured backend that fails
   * mid-run still fails the build.
   */
  allowUnconfigured?: boolean;
  /**
   * Permit a deletion exceeding `indexing.maxDeletionRatio`, like
   * `searchsocket index --accept-large-deletion`. Set it for the one build that
   * is meant to remove a large part of the site, then remove it again.
   */
  acceptLargeDeletion?: boolean;
  /**
   * Fail the build when a safety check refuses to change the index — the
   * deletion ratio was exceeded, or robots.txt could not be read. Defaults to
   * true: a refused run writes nothing, so a build that passed would deploy a
   * site whose search index silently stopped following it. Set to false to
   * log the refusal as a warning and let the build continue.
   */
  failOnRefusedWrites?: boolean;
}

function shouldRunAutoIndex(options: SearchSocketAutoIndexOptions): boolean {
  if (options.enabled === true) {
    return true;
  }

  if (options.enabled === false) {
    return false;
  }

  const triggerEnvVar = options.triggerEnvVar ?? "SEARCHSOCKET_AUTO_INDEX";
  const disableEnvVar = options.disableEnvVar ?? "SEARCHSOCKET_DISABLE_AUTO_INDEX";

  const disabled = process.env[disableEnvVar];
  if (disabled && /^(1|true|yes)$/i.test(disabled)) {
    return false;
  }

  const explicit = process.env[triggerEnvVar];
  if (explicit && /^(1|true|yes)$/i.test(explicit)) {
    return true;
  }

  return false;
}

export function searchsocketVitePlugin(options: SearchSocketAutoIndexOptions = {}): MinimalVitePlugin {
  let executed = false;
  let running = false;
  // Fallback for Vite <6 where `this.environment` isn't available in hooks.
  let resolvedIsSsrBuild = false;

  return {
    name: "searchsocket:auto-index",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      resolvedIsSsrBuild = Boolean(config.build?.ssr);
    },
    closeBundle: {
      // Rollup runs `closeBundle` hooks in parallel by default. Without
      // `sequential: true`, we race against the SvelteKit adapter (which runs
      // inside sveltekit's own closeBundle on the SSR pass) and may fire
      // before `.vercel/output/` exists. Sequential + order:'post' forces us
      // to wait for all non-post closeBundles to finish first.
      sequential: true,
      order: "post",
      async handler() {
        // SvelteKit splits `vite build` into two passes (client, then SSR)
        // and only runs its adapter on the SSR pass. If we ran on the client
        // pass we'd see an empty `.vercel/output/` (adapter hasn't run yet),
        // fall back to vite preview, and crash. Prefer Vite 6+ environment
        // API; fall back to the build.ssr flag captured in configResolved.
        const envName = this.environment?.name;
        const envIsSsr = Boolean(this.environment?.config?.build?.ssr);
        const isSsrBuild = envName === "ssr" || envIsSsr || resolvedIsSsrBuild;

        if (!isSsrBuild) {
          return;
        }

        if (executed || running) {
          return;
        }

        if (!shouldRunAutoIndex(options)) {
          return;
        }

        running = true;

        const cwd = path.resolve(options.cwd ?? process.cwd());
        const logger = new Logger({
          verbose: options.verbose ?? true
        });

        try {
          logger.info("[searchsocket] build completed, starting incremental index...");

          let pipeline: IndexPipeline;
          try {
            pipeline = await IndexPipeline.create({
              cwd,
              configPath: options.configPath,
              logger,
              hooks: options.hooks
            });
          } catch (error) {
            if (
              error instanceof SearchSocketError &&
              error.code === "VECTOR_BACKEND_UNAVAILABLE" &&
              (options.allowUnconfigured ?? true)
            ) {
              // Reuse the thrown message rather than naming the default env
              // vars: a project that set upstash.urlEnv/tokenEnv needs to be
              // told about *its* variables.
              logger.warn(
                `[searchsocket] skipping indexing — ${error.message} ` +
                  "Pass allowUnconfigured: false to fail the build instead."
              );
              return;
            }
            throw error;
          }

          const stats = await pipeline.run({
            changedOnly: options.changedOnly ?? true,
            force: (options.force ?? false) || /^(1|true|yes)$/i.test(process.env.SEARCHSOCKET_FORCE_REINDEX ?? ""),
            dryRun: options.dryRun ?? false,
            scopeOverride: options.scope,
            verbose: options.verbose,
            acceptLargeDeletion: options.acceptLargeDeletion ?? false
          });

          if (stats.writesRefused) {
            const remedy =
              stats.writesRefused.reason === "max-deletion-ratio"
                ? "If the deletion is intended, pass acceptLargeDeletion: true for this build."
                : "Fix robots.txt availability and rebuild.";
            const message =
              `[searchsocket] index left unchanged — ${stats.writesRefused.detail}. ${remedy} ` +
              "Pass failOnRefusedWrites: false to build anyway.";
            if (options.failOnRefusedWrites ?? true) {
              throw new SearchSocketError("INDEX_WRITES_REFUSED", message);
            }
            logger.warn(message);
            executed = true;
            return;
          }

          logger.info(
            `[searchsocket] indexed pages=${stats.pagesProcessed} chunks=${stats.chunksTotal} changed=${stats.chunksChanged} upserted=${stats.documentsUpserted}`
          );
          executed = true;
        } finally {
          running = false;
        }
      }
    }
  };
}
