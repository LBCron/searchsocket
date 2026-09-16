# SearchSocket - Claude Code Notes

## Project Overview

Semantic site search and MCP retrieval for SvelteKit static sites. Published on NPM as `searchsocket`.

## Architecture Mental Model

- **Indexing Pipeline (`src/indexing/pipeline.ts`)**:
  Source Pages (HTML/MD) -> Filtering (Exclude/Robots) -> Route Mapping -> Extraction (`cheerio`/`turndown`) -> Link Analysis -> Chunking (Split by headings/length) -> Hashing (for incremental updates) -> Upsert to Upstash Vector.
  The pipeline supports hooks (`transformPage`, `transformChunk`, `beforeIndex`, `afterIndex`) and dry-run mode.
- **Page-first Search**: The system indexes both page summaries and individual chunks. A query ranks pages first, then retrieves the best-matching sections within the top pages as sub-results. Section lookups are bounded (`SUBRESULT_PAGE_LIMIT`, `SUBRESULT_CONCURRENCY` in `src/search/engine.ts`) so a large `topK` cannot fan out into one backend request per result. The older parallel/blended "dual search" path was removed in 1.0.
- **Serverless First**: The core search engine (`SearchEngine`) and MCP Server must remain completely stateless and serverless-compatible. No in-memory rate limiting or persistent WebSocket connections.

## Tech Stack & Core Dependencies

Use existing libraries from `package.json` — do not introduce new dependencies for tasks these already handle:
- **HTML Parsing**: `cheerio` (avoid regex for HTML).
- **Markdown Conversion**: `turndown` and `turndown-plugin-gfm`.
- **Frontmatter**: `gray-matter`.
- **Vector Database**: `@upstash/vector`. Embeddings and reranking are Upstash-hosted — there is no separate embedding provider. **Removed, do not reintroduce**: Jina and Turso (v0.5.0), OpenAI, and the Gemini embedder / `@google/genai`.
- **File globbing**: `fast-glob`.
- **Validation**: `zod`.
- **AST Manipulation**: `magicast` (used in `src/init-helpers.ts`).

## Coding Conventions & Patterns

- **Error Handling**: Do not throw generic `Error` objects. Use the custom `SearchSocketError` class from `src/errors/index.ts` with the appropriate typed error code (e.g., `CONFIG_MISSING`, `INVALID_REQUEST`, `VECTOR_BACKEND_UNAVAILABLE`).
- **Logging**: Never use `console.log` or `console.error` in core logic. Use the `Logger` class from `src/core/logger.ts` which supports JSON output, verbosity flags, and stderr-only modes.
- **Config Validation**: All configuration validation must go through `zod` schemas defined in `src/config/schema.ts`.
- **Svelte 5**: Any UI templates (in `src/templates/`) MUST use Svelte 5 Runes (`$state`, `$props`, `$effect`, `$derived`, `$bindable`). Do not use Svelte 4 `export let` syntax.
- **Path Handling**: Use the utility functions in `src/utils/path.ts` (`normalizeUrlPath`, `staticHtmlFileToUrl`, `getUrlDepth`, `joinUrl`) instead of raw string manipulation for URLs and routes.

## Branching Model (Git Flow)

- `main` — production. Only receives merges from `release/*` and `hotfix/*`, and carries the `v*` tags.
- `develop` — integration branch and the **default branch**. Feature PRs target this.
- `feature/*` — branch from `develop`, merge back to `develop`.
- `release/*` — branch from `develop`, merge to **both** `main` and `develop`.
- `hotfix/*` — branch from `main`, merge to **both** `main` and `develop`.

Never commit directly to `main`. Git Flow branch/prefix names are stored in the repo's
git config (`git config --get-regexp '^gitflow\.'`).

## Release Process

- GitHub Actions workflow (`.github/workflows/publish.yml`) publishes on `v*` tag push via NPM Trusted Publishing (OIDC, no secrets needed)
- Releases are cut from a `release/*` branch, not from `develop` or `main` directly:
  ```bash
  git switch -c release/0.8.0 develop
  npm version minor --no-git-tag-version   # bumps package.json only
  # edit CHANGELOG.md by hand, then:
  git commit -am "chore: prepare for v0.8.0 release"
  # merge release/0.8.0 into main, then tag main:
  git switch main && git merge --no-ff release/0.8.0
  git tag v0.8.0 && git push origin main --tags
  # merge back so develop carries the bump:
  git switch develop && git merge --no-ff release/0.8.0
  git push origin develop
  ```
- The workflow runs: pnpm install, typecheck, build, test, then `pnpm publish --provenance --access public`
- Trusted publisher is configured on NPM to accept the `publish.yml` workflow from `gregpriday/searchsocket`
- Update CHANGELOG.md with each release
- Run the `/release` skill (`.claude/skills/release/SKILL.md`) to drive the whole process — it covers the validation gate, the `npm pack` check for the raw-source `./svelte` subpath, both merges, and the failure/rollback paths.

## CI

`.github/workflows/ci.yml` runs typecheck → build → test → check:package on Node 22 and 24 for pushes to
`main`/`develop`/`release/*`/`hotfix/*` and PRs into `main` or `develop`. Keep the matrix in sync
with `engines.node` in package.json (currently `>=22.12.0` — Node 20 reached end of life in March 2026).

`.github/workflows/searchsocket-prune.yml` no-ops unless `UPSTASH_VECTOR_REST_URL` and
`UPSTASH_VECTOR_REST_TOKEN` repo secrets are set. Note it invokes the CLI as `node dist/cli.js`,
not `pnpm searchsocket` — this repo *is* the package, so its own bin is never linked into
`node_modules/.bin`.

## Build & Test

- Build: `pnpm run build` (uses tsup, outputs ESM + CJS + types to dist/)
- Unit Tests: `pnpm run test` (vitest). Place new tests in `tests/` and use fixtures in `tests/fixtures/`.
  Run `pnpm run build` first: `tests/add-cli.test.ts` exercises the real `dist/cli.js`.
- Search UI templates: `src/templates/_shared/` is the authoring source. The copies inside each
  component directory are generated by `pnpm run sync:templates` (also run by `pnpm run build`)
  and committed; `tests/add-component.test.ts` fails if they drift. Edit `_shared/`, never a copy.
- Search Quality Tests: `pnpm run test:quality` runs Mean Reciprocal Rank (MRR) assertions against the live index using judgments in `tests/fixtures/quality-judgments.ts`. Run this when tweaking `src/search/ranking.ts` to ensure search quality isn't degraded.
- Typecheck: `pnpm run typecheck`
- Package manager: pnpm

## Package Structure

Five entry points (see `exports` in package.json):

| Import | Source |
| --- | --- |
| `searchsocket` | `src/index.ts` |
| `searchsocket/sveltekit` | `src/sveltekit.ts` |
| `searchsocket/client` | `src/client.ts` |
| `searchsocket/scroll` | `src/scroll.ts` |
| `searchsocket/svelte` | `src/svelte/index.svelte.ts` (shipped as source, not bundled) |

- CLI binary: `searchsocket` → `dist/cli.js`
- Published to NPM: `dist/` (minus sourcemaps), `src/svelte/`, and `README.md` — controlled by `files` in package.json

## Key Directories

- `src/cli.ts` — **the entire CLI lives in this one file** (all commands: init, index, status, dev, clean, prune, doctor, mcp, search, test, add). `src/cli/` holds only `test-schemas.ts`, not the commands.
- `src/config/` — `schema.ts` (zod), `defaults.ts`, `load.ts`
- `src/core/` — `logger.ts`, `scope.ts`, `serverless.ts`, `state.ts`
- `src/errors/` — `SearchSocketError` and typed error codes
- `src/indexing/` — pipeline, extractor, chunker, route-mapper, robots, llms-txt, `sources/`
- `src/search/` — `engine.ts`, `ranking.ts`, `related-pages.ts`, `quality-metrics.ts`
- `src/mcp/` — `server.ts` (stdio + HTTP MCP server)
- `src/sveltekit/` — `handle.ts` (server hook), `plugin.ts` (Vite plugin), `scroll-to-text.ts`
- `src/svelte/` — Svelte 5 runes API (`createSearch`) and `<SearchSocket>` component
- `src/templates/` — Svelte 5 search UI components copied out by `searchsocket add`
- `src/vector/` — Upstash Vector client, factory
- `src/utils/` — `path.ts`, `text.ts`, `hash.ts`, `pattern.ts`, `time.ts`, `structured-meta.ts`
- `src/playground/` — local relevance-tuning playground
- `src/client.ts` — browser search client (no `src/client/` directory)
- `tests/` — vitest suites; fixtures in `tests/fixtures/`
