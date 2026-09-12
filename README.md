# SearchSocket

[![npm version](https://img.shields.io/npm/v/searchsocket.svg)](https://www.npmjs.com/package/searchsocket)
[![ci](https://github.com/gregpriday/searchsocket/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/gregpriday/searchsocket/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/searchsocket.svg)](./LICENSE)

Semantic site search and MCP retrieval for SvelteKit content projects. Index your site, search it from the browser or AI tools, and scroll users to the exact content they're looking for.

**Requirements**: Node.js >= 22.12 | **Backend**: [Upstash Vector](https://upstash.com/docs/vector/overall/getstarted) | **License**: MIT

## How it works

```
SvelteKit Pages → Extractor (Cheerio + Turndown) → Chunker → Upstash Vector
                                                                    ↓
                    Search UI ← SvelteKit API Hook ← Search Engine + Ranking
                                       ↓
                              MCP Endpoint → Claude Code / Claude Desktop
```

SearchSocket extracts content from your SvelteKit site, converts it to markdown, splits it into chunks, and stores them in Upstash Vector. At runtime, the SvelteKit hook serves both a search API for your frontend and an MCP endpoint for AI tools.

## Features

- **Semantic + keyword search** — an Upstash Vector hybrid index runs the dense and sparse queries and fuses their rankings with DBSF. There is no separate reranking model and no query-enrichment step
- **Page-first search** — pages are ranked first, then the best-matching sections within the top pages are attached as sub-results
- **Scroll-to-text** — auto-scroll to the matching section when a user clicks a search result, with CSS Highlight API and Text Fragment support
- **SvelteKit integration** — server hook for the search API, Vite plugin for build-triggered indexing
- **Svelte 5 components** — reactive `createSearch` store and `<SearchSocket>` metadata component (Svelte 5.20 or newer)
- **MCP server** — three tools for Claude Code, Claude Desktop, and other MCP clients (stdio + HTTP)
- **llms.txt generation** — auto-generate LLM-friendly site indexes during indexing
- **Four source modes** — index from static output, build manifest, a running server, or raw markdown files
- **CLI** — init, index, search, dev, status, doctor, clean, prune, test, mcp, add

## Install

```bash
pnpm add -D searchsocket
```

SearchSocket is typically a dev dependency since indexing runs at build time. If you use `searchsocketHandle()` at runtime (e.g., in a Node server adapter or serving the MCP endpoint from a production deployment), add it as a regular dependency:

```bash
pnpm add searchsocket
```

## Quickstart

### 1. Initialize

```bash
pnpm searchsocket init
```

Creates `searchsocket.config.ts`, the `.searchsocket/` state directory, wires up your SvelteKit hooks and Vite config, and generates `.mcp.json` for Claude Code.

### 2. Configure

Minimal config (`searchsocket.config.ts`):

```ts
export default {};
```

That's it — defaults handle the rest. SearchSocket reads `UPSTASH_VECTOR_REST_URL` and `UPSTASH_VECTOR_REST_TOKEN` from your environment automatically.

### 3. Set environment variables

```bash
# .env
UPSTASH_VECTOR_REST_URL=https://...
UPSTASH_VECTOR_REST_TOKEN=...
```

Create an [Upstash Vector index](https://console.upstash.com/vector) with the `bge-large-en-v1.5` embedding model (1024 dimensions). Copy the REST URL and token.

### 4. Add the SvelteKit hook

The `init` command does this for you, but if you need to do it manually:

```ts
// src/hooks.server.ts
import { searchsocketHandle } from "searchsocket/sveltekit";

export const handle = searchsocketHandle();
```

This exposes `POST /api/search`, `GET /api/search/health`, the MCP endpoint at `/api/mcp`, and page retrieval routes.

`searchsocket/sveltekit` is **server-only**. It pulls in the indexing pipeline, the MCP
SDK, and Node builtins (`fs/promises`, `child_process`, `crypto`, `net`, `zlib`), so
importing it from browser code fails the Vite browser build on `createRequire`. The
browser-safe entry points are `searchsocket/client` (the search client) and
`searchsocket/scroll` (`searchsocketScrollToText`); neither imports a Node builtin.

If your app already exports a `handle`, compose the two with `sequence()` and keep
**your** handle first:

```ts
// src/hooks.server.ts
import { sequence } from "@sveltejs/kit/hooks";
import { searchsocketHandle } from "searchsocket/sveltekit";

export const handle = sequence(yourExistingHandle, searchsocketHandle());
```

Order matters. `searchsocketHandle()` answers its own endpoints without calling
`resolve()`, so anything sequenced after it never sees those requests. With your
handle outer, every SearchSocket route passes through your auth, logging and header
middleware first — which also means a handle that short-circuits a request blocks
the search API, the MCP endpoint, CORS preflight, `GET /api/search/health` and
`llms.txt` along with it. Exempt those paths in your own handle if that is not what
you want.

`searchsocket init` writes this composition for a fresh install. On an existing
install it does **not**: if `hooks.server.ts` already mentions `searchsocketHandle`
it reports "already present" and changes nothing, so an install that has the two
handles in the wrong order has to be reordered by hand.

If you run into SSR bundling issues, mark SearchSocket as external in your Vite config:

```ts
// vite.config.ts
export default defineConfig({
  plugins: [sveltekit()],
  ssr: {
    external: ["searchsocket", "searchsocket/sveltekit", "searchsocket/client", "searchsocket/scroll"]
  }
});
```

### 5. Add search to your frontend

Copy the search dialog template into your project:

```bash
pnpm searchsocket add search-dialog
pnpm searchsocket add search-trigger
```

`add` copies one component per invocation, so the trigger button used below needs its
own command. This copies a styled Svelte 5 command palette (the templates use `$props.id()`, so they need Svelte 5.20 or newer) into `src/lib/components/search/`, alongside its stylesheet and helpers. It needs no CSS framework — Tailwind optional — and follows your app's light/dark theme by default. Import it in your layout and add the scroll-to-text handler:

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { afterNavigate } from "$app/navigation";
  import { searchsocketScrollToText } from "searchsocket/scroll";
  import SearchDialog from "$lib/components/search/SearchDialog.svelte";
  import SearchTrigger from "$lib/components/search/SearchTrigger.svelte";

  let searchOpen = $state(false);
  afterNavigate(searchsocketScrollToText);
</script>

<SearchTrigger bind:open={searchOpen} />
<SearchDialog bind:open={searchOpen} />

<slot />
```

Brand it by overriding a few semantic CSS variables — no need to touch the component:

```svelte
<SearchDialog
  bind:open={searchOpen}
  label="Search documentation"
  pathPrefix="/docs"
  topK={10}
  style="--ss-search-accent: #0f766e; --ss-search-radius: 20px"
/>
```

See [docs/search-ui.md](docs/search-ui.md) for the full token list, prop tables, and theme modes.

Users can now press Cmd+K to search. See [Building a Search UI](docs/search-ui.md) for scoped search, custom styling, and more patterns.

### 6. Deploy

SearchSocket is designed to index automatically on deploy. The `init` command already added the Vite plugin to your config. Set these environment variables on your hosting platform (Vercel, Cloudflare, etc.):

| Variable | Value |
|----------|-------|
| `UPSTASH_VECTOR_REST_URL` | Your Upstash Vector REST URL |
| `UPSTASH_VECTOR_REST_TOKEN` | Your Upstash Vector REST token |
| `SEARCHSOCKET_AUTO_INDEX` | `1` |

Every deploy will build your site, index the content, and serve the search API — fully automated.

For local testing, you can also build and index manually:

```bash
pnpm build
pnpm searchsocket index
```

### 7. Connect Claude Code (optional)

Point Claude Code at your deployed site's MCP endpoint:

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "http",
      "url": "https://your-site.com/api/mcp"
    }
  }
}
```

See [MCP Server](#mcp-server) for authentication and other options.

### Querying the API directly

The search API is also available via HTTP and CLI:

```bash
# cURL
curl -X POST http://localhost:5173/api/search \
  -H "content-type: application/json" \
  -d '{"q":"getting started","topK":5,"groupBy":"page"}'

# CLI
pnpm searchsocket search --q "getting started" --top-k 5
```

### Response format

With `groupBy: "page"` (the default):

```json
{
  "q": "getting started",
  "scope": "main",
  "results": [
    {
      "url": "/docs/intro",
      "title": "Getting Started",
      "sectionTitle": "Installation",
      "snippet": "Install SearchSocket with pnpm add searchsocket...",
      "score": 0.89,
      "chunks": [
        {
          "sectionTitle": "Installation",
          "snippet": "Install SearchSocket with pnpm add searchsocket...",
          "headingPath": ["Getting Started", "Installation"],
          "score": 0.89
        },
        {
          "sectionTitle": "Configuration",
          "snippet": "Create searchsocket.config.ts with your API key...",
          "headingPath": ["Getting Started", "Configuration"],
          "score": 0.74
        }
      ]
    }
  ],
  "meta": {
    "timingsMs": { "total": 135 }
  }
}
```

The `chunks` array contains matching sections within each page. Use `groupBy: "chunk"` for flat per-chunk results without page aggregation.

## Source Modes

SearchSocket supports four ways to load your site content for indexing.

### `static-output` (default)

Reads prerendered HTML files from SvelteKit's build output directory.

```ts
export default {
  source: {
    mode: "static-output",
    staticOutputDir: "build"   // default
  }
};
```

Best for fully prerendered sites. Run `vite build` first, then `searchsocket index`.

### `build`

Discovers routes from SvelteKit's build manifest and renders via an ephemeral `vite preview` server. No manual route lists needed.

```ts
export default {
  source: {
    mode: "build",
    build: {
      exclude: ["/api/*", "/admin/*"],
      paramValues: {
        "/blog/[slug]": ["hello-world", "getting-started"],
        "/docs/[category]/[page]": ["guides/quickstart", "api/search"]
      },
      discover: true,        // crawl internal links to find more pages
      seedUrls: ["/"],
      maxPages: 200,
      maxDepth: 5
    }
  }
};
```

Best for CI/CD pipelines: `vite build && searchsocket index` with zero route configuration.

### `crawl`

Fetches pages from a running HTTP server.

```ts
export default {
  source: {
    mode: "crawl",
    crawl: {
      baseUrl: "http://localhost:4173",
      routes: ["/", "/docs", "/blog"],
      sitemapUrl: "https://example.com/sitemap.xml"
    }
  }
};
```

### `content-files`

Reads markdown and Svelte source files directly, without building or serving.

```ts
export default {
  source: {
    mode: "content-files",
    contentFiles: {
      globs: ["src/routes/**/*.md", "content/**/*.md"],
      baseDir: "."
    }
  }
};
```

Raw `.svelte` files are read as source, never rendered, so exclusion signals are read
statically. A `<SearchSocket noindex />`, an `ignore` attribute, or `weight={0}` with a
literal value is honoured. When a recognised protective signal is present but
**not** statically decidable — the value is an expression, the element sits inside an
`{#if}`, or the props are spread over an element the scanner can tie to a protective
attribute — the page is **withheld** and a warning is logged. Reading an undecidable
protective signal as "false" would publish a page someone asked to hold back, so the
strict direction is deliberate.

Known gaps, all pinned by tests: content inside `{@html}` and `{@render}` is not
extracted; signals in a `+layout.svelte` do not propagate to the pages beneath it; a
conditional or expression-valued `data-search-ignore` drops that subtree without
withholding the page; and a spread that hides a protective attribute the scanner cannot
see in the source text is not detected. Use the `static-output` or `build` source mode
when a page's exclusion depends on anything computed at runtime.

## Client Library

### `createSearchClient(options?)`

Lightweight browser-side search client.

```ts
import { createSearchClient } from "searchsocket/client";

const client = createSearchClient({
  endpoint: "/api/search",   // default
  fetchImpl: fetch            // override for SSR or testing
});

const { results } = await client.search({
  q: "deployment guide",
  topK: 8,
  groupBy: "page",
  pathPrefix: "/docs",
  tags: ["guide"],
  filters: { version: 2 },
  maxSubResults: 3
});
```

### `buildResultUrl(result)`

Builds a URL from a search result that includes scroll-to-text metadata:

- `_ssk` query parameter — section title for SvelteKit client-side navigation
- `_sskt` query parameter — text target snippet for precise scroll
- `#:~:text=` — [Text Fragment](https://developer.mozilla.org/en-US/docs/Web/URI/Fragment/Text_fragments) for native browser scroll on full page loads

```ts
import { buildResultUrl } from "searchsocket/client";

const href = buildResultUrl(result);
// "/docs/getting-started?_ssk=Installation&_sskt=Install+with+pnpm#:~:text=Install%20with%20pnpm"
```

## Svelte 5 Integration

### `createSearch(options?)`

A reactive search store built on Svelte 5 runes with debouncing and LRU caching.

```svelte
<script>
  import { createSearch } from "searchsocket/svelte";
  import { buildResultUrl } from "searchsocket/client";

  const search = createSearch({
    endpoint: "/api/search",
    debounce: 250,            // ms (default)
    cache: true,              // LRU result caching (default)
    cacheSize: 50,            // max cached queries (default)
    topK: 10,
    groupBy: "page",
    pathPrefix: "/docs"       // scope search to a section
  });
</script>

<input bind:value={search.query} placeholder="Search docs..." />

{#if search.loading}
  <p>Searching...</p>
{/if}

{#if search.error}
  <p class="error">{search.error.message}</p>
{/if}

{#each search.results as result}
  <a href={buildResultUrl(result)}>
    <strong>{result.title}</strong>
    {#if result.sectionTitle}
      <span>— {result.sectionTitle}</span>
    {/if}
  </a>
  <p>{result.snippet}</p>
{/each}
```

Call `search.destroy()` when the search is no longer needed. This is **not**
automatic: `createSearch()` uses `$effect.root`, which returns a teardown
function rather than registering one with the surrounding component. In a
component, call it from `onDestroy`:

```svelte
<script>
  import { onDestroy } from "svelte";
  import { createSearch } from "searchsocket/svelte";

  const search = createSearch();
  onDestroy(search.destroy);
</script>
```


### `<SearchSocket>` component

Declarative meta tag component for controlling per-page search behavior:

```svelte
<script>
  import { SearchSocket } from "searchsocket/svelte";
</script>

<!-- Boost this page's search ranking -->
<SearchSocket weight={1.2} />

<!-- Exclude from search -->
<SearchSocket noindex />

<!-- Add filterable tags -->
<SearchSocket tags={["guide", "advanced"]} />

<!-- Add structured metadata (filterable via search API) -->
<SearchSocket meta={{ version: 2, category: "api" }} />
```

The component renders `<meta>` tags in `<svelte:head>` that SearchSocket reads during indexing.

### Template components

Copy ready-made search UI components into your project:

```bash
pnpm searchsocket add search-dialog     # Cmd+K command palette
pnpm searchsocket add search-input      # inline field with a dropdown
pnpm searchsocket add search-results    # standalone result list
pnpm searchsocket add search-trigger    # the button that opens the dialog
```

Each command writes a self-contained kit to `src/lib/components/search/` (configurable via `--dir`): the component, a shared `SearchResultRow.svelte`, pure helpers in `search-ui.ts`, and `search-theme.css`. They are Svelte 5 source you own, not dependencies — nothing imports back into `node_modules`.

The default is styled with plain CSS and semantic `--ss-search-*` variables, so it works with or without Tailwind and looks finished without edits. Existing files are never overwritten without `--overwrite`, so adding a second component keeps any changes you made to the shared files.

## Scroll-to-Text Navigation

When a user clicks a search result, SearchSocket scrolls them to the matching section on the destination page.

### Setup

Add the scroll handler to your root layout:

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { afterNavigate } from '$app/navigation';
  import { searchsocketScrollToText } from 'searchsocket/scroll';

  afterNavigate(searchsocketScrollToText);
</script>
```

### How it works

1. `buildResultUrl()` encodes the section title and text snippet into the URL
2. On SvelteKit client-side navigation, the `afterNavigate` hook reads `_ssk`/`_sskt` params
3. A TreeWalker-based text mapper finds the exact position in the DOM
4. The page scrolls smoothly to the match
5. The matching text is highlighted using the [CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API) (with a DOM fallback for older browsers)
6. On full page loads, browsers that support Text Fragments (`#:~:text=`) handle scrolling natively

The highlight fades after 2 seconds. Customize with CSS:

```css
::highlight(ssk-search-match) {
  background-color: rgba(250, 204, 21, 0.4);
}
```

## Search & Ranking

### Page-first search

SearchSocket searches page-first: one query ranks page summaries, then the
best-matching sections within the top pages are retrieved and attached as
sub-results. This keeps results coherent at page level while still pointing at
the exact section that matched.

Section lookups are bounded — only the top pages are expanded, and those
requests run through a concurrency limit — so a large `topK` cannot fan out into
one backend request per result.

### Page weights

A page's weight multiplies its final score. It comes from the page itself —
`<meta name="searchsocket-weight" content="1.5">` or `searchsocket.weight` in
frontmatter — falling back to a `ranking.pageWeights` pattern. A weight of `0`
from either source excludes the page entirely, so an operator can suppress
pages regardless of what their markup asks for.

### Ranking configuration

```ts
export default {
  ranking: {
    enableIncomingLinkBoost: true,    // boost pages with more internal links pointing to them
    enableDepthBoost: true,           // boost shallower pages (/ > /docs > /docs/api)
    enableFreshnessBoost: false,      // boost recently published content
    enableAnchorTextBoost: false,     // boost pages whose link text matches the query

    pageWeights: {                    // per-URL score multipliers. Patterns, not raw
                                      // prefixes: "/docs" is an exact match, "/docs/*"
                                      // is one level down, "/docs/**" is the subtree
      "/": 0.95,
      "/docs": 1.15,
      "/download": 1.05
    },

    minScoreRatio: 0.70,             // drop results scoring below 70% of the top result
    scoreGapThreshold: 0.4,          // page mode only: cut the list at the first
                                     // adjacent pair whose score drops 40% or more

    weights: {
      incomingLinks: 0.05,
      depth: 0.03,
      titleMatch: 0.15,
      freshness: 0.1,
      anchorText: 0.10
    }
  }
};
```

Use gentle `pageWeights` values (0.9–1.2) since they compound with other boosts.

## Build-Triggered Indexing

The recommended workflow is to index automatically on every deploy. Add the Vite plugin to your config:

```ts
// vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import { searchsocketVitePlugin } from "searchsocket/sveltekit";

export default {
  plugins: [
    sveltekit(),
    searchsocketVitePlugin({
      changedOnly: true,    // incremental indexing (default)
      verbose: true
    })
  ]
};
```

By default the plugin skips indexing with a warning when no Upstash credentials are
configured, so a contributor without secrets can still run a build. On a deploy build
that is usually the wrong trade — the site ships with a stale index and nothing fails.
Pass `allowUnconfigured: false` to turn the missing backend into a build failure. It only
bites when auto-indexing actually runs — the SSR build pass, with `enabled: true` or
`SEARCHSOCKET_AUTO_INDEX` set — so a deploy build usually wants both:

```ts
searchsocketVitePlugin({
  enabled: true,             // or set SEARCHSOCKET_AUTO_INDEX=1 in the deploy env
  allowUnconfigured: false   // fail the build instead of skipping indexing
})
```

### Vercel / Cloudflare / Netlify

Set these environment variables in your hosting platform:

| Variable | Value |
|----------|-------|
| `UPSTASH_VECTOR_REST_URL` | Your Upstash Vector REST URL |
| `UPSTASH_VECTOR_REST_TOKEN` | Your Upstash Vector REST token |
| `SEARCHSOCKET_AUTO_INDEX` | `1` |

Every deploy will build your site, index the content into Upstash, and serve the search API and MCP endpoint — fully automated.

### Environment variable control

```bash
# Enable indexing on build
SEARCHSOCKET_AUTO_INDEX=1 pnpm build

# Disable temporarily
SEARCHSOCKET_DISABLE_AUTO_INDEX=1 pnpm build

# Force full rebuild (ignore incremental cache)
SEARCHSOCKET_FORCE_REINDEX=1 pnpm build
```

## Making Images Searchable

SearchSocket converts images to text during extraction using this priority chain:

1. `data-search-description` on the `<img>` — your explicit description
2. `data-search-description` on the parent `<figure>`
3. `alt` text + `<figcaption>` combined
4. `alt` text alone (filters generic words like "image", "icon")
5. `<figcaption>` alone
6. Removed — images with no useful text are dropped

```html
<img
  src="/screenshots/settings.png"
  alt="Settings page"
  data-search-description="The settings page showing API key configuration, theme selection, and notification preferences"
/>
```

Works with SvelteKit's `enhanced:img`:

```svelte
<enhanced:img
  src="./screenshots/dashboard.png"
  alt="Dashboard"
  data-search-description="Main dashboard showing active projects and indexing status"
/>
```

## MCP Server

SearchSocket includes an MCP server that gives Claude Code, Claude Desktop, and other MCP clients direct access to your site's search index. The MCP endpoint is built into `searchsocketHandle()` — once your site is deployed, any MCP client can connect to it over HTTP.

### Available tools

| Tool | Description |
|------|-------------|
| `search` | Semantic search with filtering and section sub-results |
| `get_page` | Retrieve a page's indexed markdown and frontmatter |
| `get_related_pages` | Find related pages by links, semantics, and structure |

### Connecting to your deployed site

The recommended setup is to connect Claude Code to your deployed site's MCP endpoint. This way the index stays up to date automatically as you deploy, and there's no local process to manage.

Add `.mcp.json` to your project root:

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "http",
      "url": "https://your-site.com/api/mcp"
    }
  }
}
```

The MCP endpoint requires an API key. Its tools return repository paths, a
page's indexed markdown, and any scope the caller names, so it refuses to serve
without one:

```ts
// src/hooks.server.ts
export const handle = searchsocketHandle({
  rawConfig: {
    mcp: {
      enable: true,
      handle: {
        // Read from the environment rather than committing the key.
        apiKeyEnv: "SEARCHSOCKET_MCP_API_KEY"
      }
    }
  }
});
```

`mcp.enable` defaults to `NODE_ENV !== "production"`, so set it explicitly for a
production deployment.

Then pass the key in `.mcp.json`:

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "http",
      "url": "https://your-site.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${SEARCHSOCKET_MCP_API_KEY}"
      }
    }
  }
}
```

The `${SEARCHSOCKET_MCP_API_KEY}` syntax references an environment variable so you don't hardcode secrets in `.mcp.json`.

### Auto-approving in Claude Code

Skip the approval prompt each time a tool is called:

```json
{
  "allowedMcpServers": [
    { "serverName": "searchsocket" }
  ]
}
```

Add this to `.claude/settings.json` in your project.

### Local development

During local development, you can point to your dev server instead:

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "http",
      "url": "http://localhost:5173/api/mcp"
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "searchsocket": {
      "command": "npx",
      "args": ["searchsocket", "mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

### Standalone HTTP server

Run the MCP server as a standalone process (outside SvelteKit):

```bash
pnpm searchsocket mcp --transport http --port 3338
```

## llms.txt Generation

Generate [llms.txt](https://llmstxt.org/) files during indexing — a standardized way to make your site content available to LLMs.

```ts
export default {
  project: {
    baseUrl: "https://example.com"
  },
  llmsTxt: {
    enable: true,
    title: "My Project",
    description: "Documentation for My Project",
    outputPath: "static/llms.txt",    // default
    generateFull: true,                // also generate llms-full.txt
    serveMarkdownVariants: false       // serve /page.md variants via the hook
  }
};
```

After indexing, `llms.txt` (page index with links) and `llms-full.txt` (full content) are written to your static directory. `searchsocketHandle()` serves the file at `llmsTxt.outputPath` directly; `llms-full.txt` has no handler of its own and is served as a static asset, so it has to be in the deployed output. If your adapter copies `static/` before indexing runs, generate these ahead of the adapter step or serve them from your own route.

These are published artifacts with no second copy to recover from, so they are only
replaced by a run that held the **complete** page list. A truncated crawl, a failed
extraction, or a refused deletion plan leaves the existing files alone and logs the
reason. A chunk limit does not freeze them — it truncates no pages.

There is one sharp edge worth knowing about. If the index holds custom records and a
run is not passed `customRecords`, those pages are absent from the run's page list even
though they are still in the index, so publishing would silently drop them from the
public list. The exports are therefore left as they are, and the warning says exactly
that: pass `customRecords` to refresh them. Passing `customRecords: []` explicitly
asserts there are none.

## CLI Commands

### `searchsocket init`

Initialize config and state directory. Creates `searchsocket.config.ts`, `.searchsocket/`, `.mcp.json`, and wires up your hooks and Vite config.

```bash
pnpm searchsocket init
pnpm searchsocket init --non-interactive
```

### `searchsocket index`

Index content into Upstash Vector.

```bash
pnpm searchsocket index                    # incremental (default: --changed-only)
pnpm searchsocket index --force            # full re-index
pnpm searchsocket index --source build     # override source mode
pnpm searchsocket index --scope staging    # override scope
pnpm searchsocket index --dry-run          # preview without writing
pnpm searchsocket index --max-pages 10     # limit for testing (no deletions when it truncates)
pnpm searchsocket index --verbose          # detailed output
pnpm searchsocket index --json             # machine-readable output
```


#### Deletion safety

An indexing run removes stale records only when it observed the complete source
of truth. A run truncated by `--max-pages`/`--max-chunks`, one that failed to
fetch or extract a page, or one whose source unexpectedly returned nothing is
reported as `deletionEligible: false` and deletes nothing — the stale records
are left in place rather than risking the loss of a valid index.

Two further guards need an explicit opt-in:

```bash
# The source legitimately produced zero pages and you want the index emptied
pnpm searchsocket index --allow-empty

# The run would remove more than indexing.maxDeletionRatio (default 50%)
pnpm searchsocket index --accept-large-deletion
```

When the **ratio** guard refuses a run, the run writes **nothing** — not the deletions
and not the additions either. Withholding only the deletions used to leave
the replacement records written, which enlarged the inventory the ratio is measured
against; an identical rerun then saw the same stale records as a smaller fraction and
deleted them without `--accept-large-deletion` ever being supplied. Refusing the whole
mutation is what keeps a refused plan refused however often you repeat it, and leaves
the index exactly as it was last accepted. The empty-source guard is narrower: it stops
deletions but still writes the run's additions, because an empty site source is a source
problem rather than a plan whose arithmetic a retry could game.

An unreadable `robots.txt` blocks index writes, in **`crawl` mode with
`respectRobotsTxt` on** — the only mode that fetches it over the network. If the fetch
times out, returns a server error, or exceeds the 512 KiB size cap, the run cannot tell
which pages the site means to exclude, so it writes nothing rather than risk publishing
a page that was meant to stay out. A 404 or 410 is not unreadable: that is how a site
says "no rules here", and indexing proceeds. (`static-output` and `build` read
`robots.txt` from the build directory and treat an unreadable file as absent;
`content-files` does not consult it at all.)

Rule matching follows RFC 9309 for the parts that matter in practice: `*` wildcards, the
`$` end-anchor, group merging across consecutive `User-agent` lines, and
longest-rule-wins specificity with `Allow` beating an equally long `Disallow`. It is not
a certified-complete implementation — percent-encoded paths are compared as written
rather than canonicalised, so `Disallow: /admin` does not also block `/%61dmin`.

Chunk and page metadata is budgeted in **UTF-8 bytes** against Upstash's 48 KB
per-record limit, measured on the exact JSON that will be sent. The one trimmable
field (the record's text) is truncated to fit, with a warning naming the record. If
the required fields alone still do not fit, the run fails with the page URL and the
name and size of the largest offending field, rather than letting the backend reject
one item in the middle of a half-written batch.

`searchsocket index` exits 5 when no vector backend is configured. Pass
`--allow-unconfigured` to skip indexing without failing (the Vite plugin already
behaves this way).

### `searchsocket search`

CLI search for testing.

```bash
pnpm searchsocket search --q "getting started" --top-k 5
pnpm searchsocket search --q "api" --path-prefix /docs
```

### `searchsocket dev`

Watch for file changes and auto-reindex, with optional playground UI.

```bash
pnpm searchsocket dev                                # watch + playground at :3337
pnpm searchsocket dev --mcp --mcp-port 3338          # also start MCP HTTP server
pnpm searchsocket dev --no-playground                 # watch only
```

### `searchsocket status`

Show indexing status and backend health.

```bash
pnpm searchsocket status
```

### `searchsocket doctor`

Validate config, env vars, provider connectivity, and write access.

```bash
pnpm searchsocket doctor
```

### `searchsocket test`

Run search quality assertions against the live index.

```bash
pnpm searchsocket test                              # uses searchsocket.test.json
pnpm searchsocket test --file custom-tests.json     # custom test file
```

Test file format:

```json
[
  {
    "query": "installation guide",
    "expect": {
      "topResult": "/docs/getting-started",
      "inTop5": ["/docs/getting-started", "/docs/quickstart"]
    }
  }
]
```

Reports pass/fail per assertion and Mean Reciprocal Rank (MRR) across all queries.

### `searchsocket clean`

Delete local state and optionally remote indexes. Remote deletion is a dry run
until you pass `--apply`.

```bash
pnpm searchsocket clean                                  # local state only
pnpm searchsocket clean --remote --scope staging         # show the plan
pnpm searchsocket clean --remote --scope staging --apply # delete that scope
pnpm searchsocket clean --keep-local --remote --scope staging --apply
```

Dropping every scope in the project needs an explicit confirmation token:

```bash
pnpm searchsocket clean --remote --all-scopes --apply --confirm-project my-site
```

`--scope` applies to the remote deletion only. Without `--remote` the command
just removes the local state directory.

### `searchsocket prune`

List and delete stale scopes. Compares against remote git branches to find
orphaned scopes.

```bash
pnpm searchsocket prune                                  # dry-run (default)
pnpm searchsocket prune --apply                          # delete orphaned scopes
pnpm searchsocket prune --older-than 30d --apply         # orphaned AND inactive 30d
pnpm searchsocket prune --older-than 30d --match any --apply  # orphaned OR inactive
pnpm searchsocket prune --protect staging,demo --apply   # never touch these
```

Prune fails closed. It refuses to run when the remote branch list cannot be
trusted — a shallow clone, a repository with no remotes, or an empty
`--scopes-file` — because every scope would otherwise look orphaned. In CI,
check out with full history (`actions/checkout` with `fetch-depth: 0`) or pass
`--scopes-file`. Scopes with no recorded index timestamp are skipped by
`--older-than` rather than assumed old, and the current scope plus `main` are
always protected.

### `searchsocket mcp`

Run the MCP server standalone.

```bash
pnpm searchsocket mcp                                   # stdio (default)
pnpm searchsocket mcp --transport http --port 3338       # HTTP
pnpm searchsocket mcp --access public --api-key SECRET   # public with auth
```

### `searchsocket add`

Copy Svelte 5 search UI template components into your project. They require Svelte 5.20 or newer.

```bash
pnpm searchsocket add search-dialog
pnpm searchsocket add search-input
pnpm searchsocket add search-results
pnpm searchsocket add search-trigger
pnpm searchsocket add search-dialog --dir src/lib/components/ui  # custom dir
pnpm searchsocket add search-dialog --overwrite                  # replace existing files
```

## Real-World Example

Here's how [Canopy](https://canopy.dev) integrates SearchSocket into a production SvelteKit site.

### Configuration

```ts
// searchsocket.config.ts
export default {
  project: {
    id: "canopy-website",
    baseUrl: "https://canopy.dev"
  },
  source: {
    mode: "build"
  },
  extract: {
    dropSelectors: [".nav-blur", ".mobile-overlay", ".docs-sidebar"]
  },
  ranking: {
    minScoreRatio: 0.70,
    pageWeights: {
      "/": 0.95,
      "/download": 1.05,
      "/docs/**": 1.05
    },
  }
};
```

### Server hook

```ts
// src/hooks.server.ts
import { searchsocketHandle } from "searchsocket/sveltekit";
import { env } from "$env/dynamic/private";

export const handle = searchsocketHandle({
  rawConfig: {
    project: { id: "canopy-website", baseUrl: "https://canopy.dev" },
    source: { mode: "build" },
    upstash: {
      url: env.UPSTASH_VECTOR_REST_URL,
      token: env.UPSTASH_VECTOR_REST_TOKEN
    },
    extract: {
      dropSelectors: [".nav-blur", ".mobile-overlay", ".docs-sidebar"]
    },
    ranking: {
      minScoreRatio: 0.70,
      pageWeights: { "/": 0.95, "/download": 1.05, "/docs/**": 1.05 },
    }
  }
});
```

### Search modal with scoped search

```svelte
<!-- SearchModal.svelte -->
<script>
  import { createSearchClient, buildResultUrl } from "searchsocket/client";

  let { open = $bindable(false), pathPrefix = "", placeholder = "Search..." } = $props();

  const client = createSearchClient();
  let query = $state("");
  let results = $state([]);

  async function doSearch() {
    if (!query.trim()) { results = []; return; }
    const res = await client.search({
      q: query,
      topK: 8,
      groupBy: "page",
      pathPrefix: pathPrefix || undefined
    });
    results = res.results;
  }
</script>

{#if open}
  <dialog open>
    <input bind:value={query} oninput={doSearch} {placeholder} />
    {#each results as result}
      <a href={buildResultUrl(result)} onclick={() => open = false}>
        <strong>{result.title}</strong>
        {#if result.sectionTitle}<span>— {result.sectionTitle}</span>{/if}
        <p>{result.snippet}</p>
      </a>
    {/each}
  </dialog>
{/if}
```

### Scroll-to-text in layout

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { afterNavigate } from "$app/navigation";
  import { searchsocketScrollToText } from "searchsocket/scroll";

  afterNavigate(searchsocketScrollToText);
</script>
```

### Deploy and index

Indexing runs automatically on every Vercel deploy. Set these env vars in the Vercel dashboard:

- `UPSTASH_VECTOR_REST_URL`
- `UPSTASH_VECTOR_REST_TOKEN`
- `SEARCHSOCKET_AUTO_INDEX=1`

The Vite plugin handles the rest. Alternatively, use a postbuild script:

```json
{
  "scripts": {
    "build": "vite build",
    "postbuild": "searchsocket index"
  }
}
```

### Connect Claude Code to the deployed site

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "http",
      "url": "https://canopy.dev/api/mcp"
    }
  }
}
```

Now Claude Code can search the live docs, retrieve page content, and find source files — all backed by the production index that stays current with every deploy.

### Excluding pages from search

```svelte
<!-- src/routes/blog/+page.svelte (archive page) -->
<svelte:head>
  <meta name="searchsocket-weight" content="0" />
</svelte:head>
```

Or with the component:

```svelte
<script>
  import { SearchSocket } from "searchsocket/svelte";
</script>

<SearchSocket weight={0} />
```

### Vite SSR config

```ts
// vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  ssr: {
    external: ["searchsocket", "searchsocket/sveltekit", "searchsocket/client", "searchsocket/scroll"]
  }
});
```

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `UPSTASH_VECTOR_REST_URL` | Upstash Vector REST API endpoint |
| `UPSTASH_VECTOR_REST_TOKEN` | Upstash Vector REST API token |

### Optional

| Variable | Description |
|----------|-------------|
| `SEARCHSOCKET_SCOPE` | Override scope (when `scope.mode: "env"`) |
| `SEARCHSOCKET_AUTO_INDEX` | Enable build-triggered indexing (`1`, `true`, or `yes`) |
| `SEARCHSOCKET_DISABLE_AUTO_INDEX` | Disable build-triggered indexing |
| `SEARCHSOCKET_FORCE_REINDEX` | Force full re-index in CI/CD |

The CLI automatically loads `.env` from the working directory on startup.

## Configuration Reference

See [docs/config.md](docs/config.md) for the full configuration reference. Here's the full example:

```ts
export default {
  project: {
    id: "my-site",
    baseUrl: "https://example.com"
  },

  scope: {
    mode: "git",                 // "fixed" | "git" | "env"
    fixed: "main",
    sanitize: true
  },

  exclude: ["/admin/*", "/api/*"],
  respectRobotsTxt: true,

  source: {
    mode: "build",
    staticOutputDir: "build",
    build: {
      exclude: ["/api/*"],
      paramValues: {
        "/blog/[slug]": ["hello-world", "getting-started"]
      },
      discover: true,
      maxPages: 200
    }
  },

  extract: {
    mainSelector: "main",
    dropTags: ["header", "nav", "footer", "aside"],
    dropSelectors: [".sidebar", ".toc"],
    ignoreAttr: "data-search-ignore",
    noindexAttr: "data-search-noindex",
    imageDescAttr: "data-search-description"
  },

  chunking: {
    maxChars: 1500,
    overlapChars: 200,
    minChars: 250,
    prependTitle: true,
    pageSummaryChunk: true
  },

  upstash: {
    urlEnv: "UPSTASH_VECTOR_REST_URL",
    tokenEnv: "UPSTASH_VECTOR_REST_TOKEN"
  },

  ranking: {
    enableIncomingLinkBoost: true,
    enableDepthBoost: true,
    pageWeights: { "/docs": 1.15 },
    minScoreRatio: 0.70,
  },

  api: {
    path: "/api/search",
    cors: { allowOrigins: ["https://example.com"] }
  },

  mcp: {
    enable: true,
    handle: { path: "/api/mcp" }
  },

  llmsTxt: {
    enable: true,
    title: "My Project",
    description: "Documentation for My Project"
  },

  state: {
    dir: ".searchsocket"
  }
};
```

## CI/CD

See [docs/ci.md](docs/ci.md) for ready-to-use GitHub Actions workflows covering:

- Main branch indexing on push
- PR dry-run validation
- Preview branch scope isolation
- Scheduled scope pruning
- Vercel build-triggered indexing

## Further Reading

- [Building a Search UI](docs/search-ui.md) — Cmd+K modals, scoped search, styling, and API reference
- [Tuning Search Relevance](docs/tuning.md) — visual playground, ranking parameters, and search quality testing
- [Configuration Reference](docs/config.md) — all config options, indexing hooks, and custom records
- [CI/CD Workflows](docs/ci.md) — GitHub Actions and Vercel integration
- [MCP over HTTP Guide](docs/mcp-claude-code.md) — detailed HTTP MCP setup for Claude Code
- [Troubleshooting](docs/troubleshooting.md) — common issues, diagnostics, and FAQ

## Contributing

This repo follows **Git Flow**:

| Branch | Purpose |
| --- | --- |
| `main` | Production. Only ever receives merges from `release/*` and `hotfix/*`, and carries the `v*` release tags. |
| `develop` | Integration branch and the default PR target. |
| `feature/*` | Branched from `develop`, merged back into `develop`. |
| `release/*` | Branched from `develop`, merged into both `main` and `develop`. |
| `hotfix/*` | Branched from `main`, merged into both `main` and `develop`. |

```bash
# start a feature
git switch develop && git pull
git switch -c feature/my-thing

# open the PR against develop
gh pr create --base develop
```

Local development:

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm run test        # vitest run
pnpm run build       # tsup → dist/
```

CI runs typecheck, build, the test suite, and the packed-tarball check on Node 22 and 24 for every push to
`main`/`develop`/`release/*`/`hotfix/*` and every PR into `main` or `develop`.

`pnpm run test:quality` runs Mean Reciprocal Rank assertions against a live index. It needs
Upstash credentials and is not part of CI — run it locally when changing `src/search/ranking.ts`.

Releases are cut from a `release/*` branch: bump the version, merge to `main`, then push the
`v*` tag. The [`publish`](.github/workflows/publish.yml) workflow builds, tests, and publishes to
NPM via Trusted Publishing (OIDC).

## License

MIT
