# SearchSocket Config Reference

Configuration file: `searchsocket.config.ts`

Minimal config:

```ts
export default {};
```

SearchSocket reads `UPSTASH_VECTOR_REST_URL` and `UPSTASH_VECTOR_REST_TOKEN` from your environment by default.

That empty object is enough for local development, where the filesystem and
`package.json` are both present: `project.id` falls back to the `package.json` name
and `source.mode` is detected from what exists on disk. Neither inference is
available to a deployed server bundle, and both have to agree between the machine
that indexed and the machine that serves. Set them explicitly once you deploy:

```ts
export default {
  project: { id: "my-site" },
  source: { mode: "static-output" }
};
```

## Project

- `project.id` (default: `package.json` name) — unique identifier for the project
- `project.baseUrl` (optional) — canonical URL for the site

## Scope

- `scope.mode` (`fixed` | `git` | `env`, default `fixed`) — how the active scope is determined
- `scope.fixed` (default `main`) — scope name when mode is `fixed`
- `scope.envVar` (default `SEARCHSOCKET_SCOPE`) — env var to read when mode is `env`
- `scope.sanitize` (default `true`) — sanitize scope names (e.g., strip special characters)

## Source

- `source.mode` (`static-output` | `crawl` | `content-files` | `build`) — auto-detected if not set
- `source.staticOutputDir` (default `build`) — directory for prerendered HTML
- `source.strictRouteMapping` (default `false`) — require exact route file matches

### Build mode

- `source.build.outputDir` (default `.svelte-kit/output`)
- `source.build.previewTimeout` (default `30000`) — ms to wait for preview server
- `source.build.exclude` — glob patterns to skip (e.g., `["/api/*"]`)
- `source.build.paramValues` — values for dynamic routes (e.g., `{ "/blog/[slug]": ["hello-world"] }`)
- `source.build.discover` (default `false`) — crawl internal links to find pages
- `source.build.seedUrls` (default `["/"]`) — starting URLs for discovery
- `source.build.maxPages` (default `200`) — max pages to discover
- `source.build.maxDepth` (default `10`) — max link depth from seed URLs

### Crawl mode

- `source.crawl.baseUrl` (required) — URL of the running server
- `source.crawl.routes` (optional) — explicit route list
- `source.crawl.sitemapUrl` (optional) — sitemap URL for route discovery

### Content files mode

- `source.contentFiles.globs` (required) — glob patterns for source files (e.g., `["src/routes/**/*.md"]`)
- `source.contentFiles.baseDir` (default project root)

## Extraction

- `extract.mainSelector` (default `main`) — CSS selector for content area
- `extract.dropTags` (default `header`, `nav`, `footer`, `aside`) — HTML tags to remove before extraction
- `extract.dropSelectors` (default includes `.sidebar`, `.toc`, `.table-of-contents`, `.breadcrumbs`, `.breadcrumb`, `[role='navigation']`) — CSS selectors to remove
- `extract.ignoreAttr` (default `data-search-ignore`) — attribute that marks elements to skip
- `extract.noindexAttr` (default `data-search-noindex`) — attribute that marks entire pages to skip
- `extract.imageDescAttr` (default `data-search-description`) — attribute for explicit image descriptions. When present on an `<img>` or parent `<figure>`, the value is indexed as the image's text representation. See README "Making Images Searchable" for the full priority chain.
- `extract.respectRobotsNoindex` (default `true`) — honor `<meta name="robots" content="noindex">`

## Transform

- `transform.output` (`markdown`) — output format for extracted content
- `transform.preserveCodeBlocks` (default `true`) — keep code blocks intact
- `transform.preserveTables` (default `true`) — keep tables intact

## Chunking

- `chunking.strategy` (`hybrid`) — chunking strategy
- `chunking.maxChars` (default `1500`) — maximum characters per chunk
- `chunking.overlapChars` (default `200`) — overlap between consecutive chunks
- `chunking.minChars` (default `250`) — minimum characters per chunk (smaller chunks are merged)
- `chunking.headingPathDepth` (default `3`) — max heading depth for section path tracking
- `chunking.dontSplitInside` (default `["code", "table", "blockquote"]`) — block types to keep intact
- `chunking.prependTitle` (default `true`) — prepend page title to chunk text before indexing
- `chunking.pageSummaryChunk` (default `true`) — generate a synthetic identity chunk per page
- `chunking.weightHeadings` — **removed in 0.8.** It only changed the chunk
  content hash; the weighted heading text never reached the embedding model, so
  it caused re-embedding churn without affecting relevance. Use
  `chunking.prependTitle`.

## Upstash

- `upstash.urlEnv` (default `UPSTASH_VECTOR_REST_URL`) — env var for Upstash REST URL
- `upstash.tokenEnv` (default `UPSTASH_VECTOR_REST_TOKEN`) — env var for Upstash REST token
- `upstash.url` — direct Upstash REST URL (alternative to env var)
- `upstash.token` — direct Upstash REST token (alternative to env var)
- `upstash.namespaces.pages` (default `pages`) — namespace for page vectors
- `upstash.namespaces.chunks` (default `chunks`) — namespace for chunk vectors
- `upstash.batchSize` (default `90`, max `500`) — records per upsert/delete/fetch request
- `upstash.maxRetries` (default `2`, max `10`) — retries for transient backend failures
  (rate limits, timeouts, 5xx). Authorization and filter-syntax errors are never
  retried. The Upstash SDK separately retries network failures on its own, so
  raising this multiplies with those attempts.

## Embedding

SearchSocket never embeds anything itself. It sends text in the `data` field and
Upstash embeds it with the model the index was created with, so **the embedding
model is chosen in the Upstash console when you create the index** — there is no
SearchSocket setting for it. To change model, create a new index with that model
and point `upstash.url`/`upstash.token` at it, then reindex.

There is no `embedding` config section. Every key it once accepted was inert, and
setting any of them now fails config loading with a migration error rather than
being silently ignored:

- `embedding.model` — a property of the Upstash index, never read here.
- `embedding.dimensions` — follows from the index's model. SearchSocket never generates
  an embedding itself: indexing sends text for Upstash to embed, and the only vector it
  ever sends back is one it read out of the index (related-page lookup).
- `embedding.taskType` — Upstash-hosted embedding takes no task-type parameter, and
  SearchSocket never sent one.
- `embedding.batchSize` — never affected anything at runtime. Use `upstash.batchSize`.
- `embedding.images.enable` — SearchSocket is text-only. Images are made searchable
  via their text descriptions (`data-search-description`, `alt`, `figcaption`),
  never image embeddings.

### Non-English / multilingual sites

`bge-large-en-v1.5` is English-specific. For multilingual content, create the Upstash
Vector index with a multilingual model such as `bge-m3` and point SearchSocket at that
index. Nothing changes in `searchsocket.config.ts`. See
[Upstash's embedding model list](https://upstash.com/docs/vector/features/embeddingmodels)
for the available options.

## Search

Search is page-first: one query ranks pages, then the best-matching sections
within the top pages are retrieved as sub-results. There is no `search` config
section — `search.dualSearch` and `search.pageSearchWeight` described a parallel
blended retrieval path that the default search stopped using, and setting either
now produces a migration error. Tune ranking through `ranking.weights`.

### API access policy

- `api.allowedScopes` (default `[]`) — scopes a browser request may select with
  `?scope=` or a `scope` field in a POST body. Empty means the caller cannot
  choose and always gets the server's configured scope; anything else is a 403.
- `api.exposeInternalFields` (default `false`) — include `routeFile` (a path in
  your repository) and `chunkText` (the matched section's indexed text) in
  browser search responses, and `routeFile` in page responses. Off by default.

### MCP access

- `mcp.enable` (default `NODE_ENV !== "production"`) — mount the MCP endpoint on
  the SvelteKit handle.
- `mcp.handle.apiKey` / `mcp.handle.apiKeyEnv` — required for the endpoint to
  serve anything while `mcp.handle.access` is `private`. MCP returns repository
  paths, a page's indexed markdown, and any scope the caller names, so without a
  key the route answers 503.
- `mcp.handle.access` (default `private`) — governs the **SvelteKit handle
  route**. `public` serves callers that present no `Authorization` header
  instead of refusing them, with `routeFile`, `chunkText` and `breakdown`
  stripped from every tool result and the caller's `scope` ignored — the same
  fields `api.exposeInternalFields` withholds from the browser API. A valid
  bearer token still returns them, so an editing agent configured with the key
  keeps source paths and a public agent does not. A wrong or malformed token is
  still a 401 rather than a silent downgrade.
- `mcp.access` (default `private`) — governs the **standalone** MCP server only:
  whether it binds to loopback or all interfaces. It has no effect on the
  SvelteKit handle route, which is governed by `mcp.handle.access`.

## Ranking

- `ranking.enableIncomingLinkBoost` (default `true`) — boost pages with more incoming links
- `ranking.enableDepthBoost` (default `true`) — boost shallower pages
- `ranking.enableFreshnessBoost` (default `false`) — boost recently published pages
- `ranking.freshnessDecayRate` (default `0.001`) — decay rate for freshness boost
- `ranking.enableAnchorTextBoost` (default `false`) — boost pages whose anchor text matches the query
- `ranking.pageWeights` (default `{}`) — per-URL score multipliers (e.g.,
  `{ "/docs": 1.15 }`). The key is a URL *pattern*, not a raw prefix: `/docs` matches
  only `/docs`, `/docs/*` matches one level down, and `/docs/**` matches the whole
  subtree. A page's own `searchsocket-weight` / frontmatter weight takes precedence,
  except that a `0` from either source excludes the page.
- `ranking.minScoreRatio` (default `0.70`) — drop results scoring below this
  fraction of the best result
- `ranking.scoreGapThreshold` (default `0.4`) — **page mode only** (`groupBy: "page"`,
  the default). Cuts the result list at the first *adjacent* pair whose score drops by at
  least this fraction. Chunk mode applies `minScoreRatio` but never this. Walking down the
  ranked list, if a result scores `0.4` (40%) or more below the result immediately
  above it, that result and everything after it is dropped. It is a
  neighbour-to-neighbour cliff detector, not a distance from the top result — that
  is what `minScoreRatio` measures. Set to `0` to disable.

Final scores are not confined to 0–1 and are not confidence values: the boosts above are
additive, and in page mode `pageWeights` multiplies on top of them. Both thresholds are
therefore relative — they compare scores within one result set and mean nothing as
absolute numbers. Neither can empty a non-empty result list: the top result always
survives both, so no threshold setting makes an off-topic query return nothing.

## Ranking weights

- `ranking.weights.incomingLinks` (default `0.05`)
- `ranking.weights.depth` (default `0.03`)
- `ranking.weights.titleMatch` (default `0.15`)
- `ranking.weights.freshness` (default `0.1`)
- `ranking.weights.anchorText` (default `0.10`)

## API

- `api.path` (default `/api/search`) — search endpoint path. `searchsocketHandle({ path })`
  overrides the path actually served at runtime; `api.path` is what indexing-time output
  (llms.txt) advertises. If you use the override, set `api.path` to match, or the
  advertised URL points at nothing.
- `api.cors.allowOrigins` (default `[]`) — allowed CORS origins
- `api.rateLimit.windowMs` (optional) — rate limit window in milliseconds
- `api.rateLimit.max` (optional) — max requests per window

## MCP

- `mcp.enable` (default `true` in dev, `false` in prod) — enable MCP server
- `mcp.access` (`public` | `private`, default `private`) — access level
- `mcp.transport` (`stdio` | `http`, default `stdio`) — transport protocol
- `mcp.http.port` (default `3338`) — HTTP server port
- `mcp.http.path` (default `/mcp`) — HTTP endpoint path
- `mcp.http.apiKey` (optional) — API key for HTTP transport
- `mcp.http.apiKeyEnv` (optional) — env var for HTTP API key
- `mcp.handle.path` (default `/api/mcp`) — SvelteKit handle endpoint path
- `mcp.handle.access` (`public` | `private`, default `private`) — whether the
  handle route serves anonymous callers a redacted result set
- `mcp.handle.apiKey` (optional) — API key for handle endpoint
- `mcp.handle.enableJsonResponse` (default `true`) — enable JSON response format

## llms.txt

- `llmsTxt.enable` (default `false`) — generate llms.txt output
- `llmsTxt.outputPath` (default `static/llms.txt`) — output file path
- `llmsTxt.title` (optional) — custom title
- `llmsTxt.description` (optional) — custom description
- `llmsTxt.generateFull` (default `true`) — generate full content version
- `llmsTxt.serveMarkdownVariants` (default `false`) — serve markdown variants

The generated `llms.txt` and `llms-full.txt` carry a short **Retrieval API** section
so an agent asks the index a question instead of crawling the page list. It always
names the search endpoint (`config.api.path`, resolved against `project.baseUrl`), and
names the MCP endpoint only when that route would actually answer: `mcp.enable` is on
*and* `mcp.handle.access` is `public` or an API key resolves. Neither the key nor the
variable holding it is ever written into the file.

Both URLs are resolved at index time from config, so build and runtime have to agree —
see the note on `api.path` above, and keep `project.id` and the scope the same on both
sides.

## State

- `state.dir` (default `.searchsocket`) — state directory for indexing metadata

## Filtering

- `exclude` (default `[]`) — glob patterns for URLs to exclude from indexing
- `respectRobotsTxt` (default `true`) — honor robots.txt rules

## Indexing Hooks

Hooks let you transform pages and chunks during indexing. They're passed programmatically to the Vite plugin or the `IndexPipeline` — not via `searchsocket.config.ts`.

### Via the Vite plugin

```ts
// vite.config.ts
import { searchsocketVitePlugin } from "searchsocket/sveltekit";

export default {
  plugins: [
    sveltekit(),
    searchsocketVitePlugin({
      hooks: {
        // Modify or skip pages before chunking
        transformPage: async (page) => {
          // `ExtractedPage` is flat — there is no `page.frontmatter`. Arbitrary
          // per-page values arrive in `page.meta`, populated from `searchsocket.meta`
          // in markdown frontmatter or `<meta name="searchsocket:KEY">` in HTML.
          if (page.meta?.draft === true) return null;

          // Add a tag of your own
          if (page.url.startsWith("/blog/")) {
            page.tags = [...page.tags, "blog"];
          }

          return page;
        },

        // Modify or skip individual chunks
        transformChunk: async (chunk) => {
          // Skip very short chunks
          if (chunk.chunkText.length < 100) return null;
          return chunk;
        },

        // Transform the full chunk array before indexing
        beforeIndex: async (chunks) => {
          console.log(`Indexing ${chunks.length} chunks`);
          return chunks;
        },

        // Run after indexing completes
        // Run after indexing completes. `IndexStats` uses flat counters —
        // pagesProcessed, pagesChanged, pagesDeleted, chunksTotal, chunksChanged,
        // documentsUpserted, deletes — not nested `pages`/`chunks` objects.
        afterIndex: async (stats) => {
          console.log(
            `Indexed ${stats.chunksTotal} chunks across ${stats.pagesProcessed} pages`
          );
        }
      }
    })
  ]
};
```

### Hook reference

| Hook | Signature | Description |
|------|-----------|-------------|
| `transformPage` | `(page: ExtractedPage) => ExtractedPage \| null` | Modify or skip a page before chunking. Return `null` to exclude. |
| `transformChunk` | `(chunk: Chunk) => Chunk \| null` | Modify or skip a chunk. Return `null` to exclude. |
| `beforeIndex` | `(chunks: Chunk[]) => Chunk[]` | Transform the full chunk array before upserting to Upstash. |
| `afterIndex` | `(stats: IndexStats) => void` | Run after indexing completes. Receives indexing statistics. |

All hooks are async-compatible.

## Custom Records

Inject data from external sources (databases, APIs, CMS) into the search index alongside your site content. Custom records bypass HTML extraction and are processed directly as pages.

```ts
import { IndexPipeline } from "searchsocket";

const pipeline = await IndexPipeline.create({ cwd: process.cwd() });

await pipeline.run({
  customRecords: [
    {
      url: "/products/widget-pro",
      title: "Widget Pro",
      content: "The Widget Pro is our flagship product with 50GB storage and real-time sync.",
      tags: ["product", "featured"],
      metadata: { category: "widgets", price: "49.99" },
      weight: 1.2
    },
    {
      url: "/products/widget-lite",
      title: "Widget Lite",
      content: "Widget Lite is the free tier with 5GB storage.",
      tags: ["product", "free-tier"]
    }
  ]
});
```

Custom records receive the same `transformPage` hook treatment as regular pages,
and are tagged with their URL path segments automatically. `metadata` becomes
filterable page metadata, the same as `searchsocket:` meta tags on a real page.

### Deletion semantics

Each run's `customRecords` is treated as the complete set from its caller, so a
record present last run and absent this run is removed — the same rule the site
source follows.

Omitting the option entirely is different from passing an empty array:

```ts
await pipeline.run({});                     // says nothing; existing custom records are kept
await pipeline.run({ customRecords: [] });  // asserts there are none; existing ones are removed
```

This matters because custom records live in the same index as site pages. A
plain `searchsocket index` — from the CLI or the Vite plugin — passes no
`customRecords`, and previously deleted every one of them as "no longer
present". A provider that merely failed to run once took its content with it.
To remove custom records, call `run()` programmatically with an explicit list
(or an empty one).

## Environment Variables

Required:

- `UPSTASH_VECTOR_REST_URL` — Upstash Vector REST API endpoint
- `UPSTASH_VECTOR_REST_TOKEN` — Upstash Vector REST API token

Optional:

- `SEARCHSOCKET_SCOPE` — override scope (when `scope.mode: "env"`)
- `SEARCHSOCKET_AUTO_INDEX` — enable build-triggered indexing (`1`, `true`, or `yes`)
- `SEARCHSOCKET_DISABLE_AUTO_INDEX` — disable build-triggered indexing
- `SEARCHSOCKET_FORCE_REINDEX` — force full re-index in CI/CD (`1`, `true`, or `yes`)
