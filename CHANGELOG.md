# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The 1.0 candidate. A final review ran every surface against the one production
deployment, a SvelteKit site on Vercel, and against its live index. It found that a
single prerendered redirect page had quietly switched off pruning for four weeks,
leaving over a thousand stale sections searchable. Most of this release closes that
class of silent failure: an indexing run that refuses to write now fails the build,
and a run that sees a page is excluded removes it whatever else went wrong. The rest
tightens the public boundary and settles the API that 1.0 commits to.

**Upgrading from 0.11 needs action in three places.** Config is now validated
strictly, so an unknown or misspelled key fails to load. URL patterns that the
matcher could never honour are rejected. A refused indexing run now fails the Vite
build. Each is marked **Breaking:** below.

### Changed

- **Breaking: config is validated strictly.** An unknown key fails to load with
  `CONFIG_INVALID`, naming the full path and suggesting the closest valid key
  (`ranking.minScoreRaito: unknown option. Did you mean ranking.minScoreRatio?`).
  Previously a typo was silently ignored and the setting it meant to change stayed
  at its default.
- **Breaking: `transform.output`, `chunking.strategy` and `analytics` are removed
  keys.** Each accepted one fixed value and was read by nothing. Delete them.
- **Breaking: unsupported URL patterns are rejected.** `exclude`,
  `source.build.exclude` and `ranking.pageWeights` support exact paths and a
  trailing `/*` or `/**`. Anything else, such as `/**/private/**`,
  `/draft-*.html` or a doubled slash like `/docs//**`, was compared as a literal and matched nothing. It now fails
  config load. See "URL patterns" in `docs/config.md`.
- **Breaking: a refused indexing run fails.** If `indexing.maxDeletionRatio`
  refuses a deletion plan, or `robots.txt` cannot be read in `crawl` mode, the run
  writes nothing, as before. It now also reports `stats.writesRefused`
  (`{ reason, detail }`, otherwise `null`). `searchsocketVitePlugin()` then fails
  the build with `INDEX_WRITES_REFUSED` instead of logging "indexed" and deploying
  over a frozen index, and `searchsocket index` exits `4` for a ratio refusal or
  `1` for unreadable robots. New plugin options: `failOnRefusedWrites` (default
  `true`) and `acceptLargeDeletion` (default `false`).
- **Breaking: CLI exit codes follow the documented table.** Usage and config errors
  exit `2` (were `1`), including `searchsocket test --top-k` above 100 and a
  `searchsocket.config.ts` that fails to parse or throws while loading, which is now
  `CONFIG_INVALID` with the underlying message. Failed
  `searchsocket test` assertions exit `3`, but only when every query was retrieved:
  a backend failure during `test` exits `5` rather than counting as failed
  assertions. An unreachable, rate-limited or unconfigured backend exits `5`, which
  now covers `search` and `test` without credentials (previously `1` and `3`) and
  `status` when the health check fails (previously `0`). The full table is in the
  README.
- **Breaking: `clean --remote` is plan-only until `--apply`.** It previously
  printed "dry-run only" after it had already deleted the local state directory.
- **Breaking: the public search endpoint refuses `debug` and `rankingOverrides`**
  with 403, and validates numeric query parameters as whole values (`topK=10abc`
  is a 400, not 10). A repeated singleton parameter is a 400. `GET <api>/health`
  answers 503 when the backend is unhealthy. The browser client strips the two
  refused fields, so type-correct calls keep working.
- **Breaking: MCP endpoints reject JSON-RPC batches** with 400 / `-32600`. One
  anonymous batch could fan out into thousands of concurrent backend queries while
  counting as a single request. The current MCP specification no longer has
  batching. The standalone `searchsocket mcp --transport http` server also refuses
  a POST whose body Express's JSON parser did not accept (415), rather than letting
  the MCP transport read the raw body itself: a `Content-Type` the parser skipped
  but the transport accepted, such as `application/json` followed by U+00A0,
  reached the transport unchecked for batching and outside the body-size limit.
- **Breaking: queries are capped at 512 characters and page paths at 2,048**
  (`MAX_QUERY_LENGTH`, `MAX_PATH_LENGTH`). Longer input is a 400 over HTTP and a
  validation error over MCP. Both measure the query after trimming, so the MCP
  tools accept exactly the queries HTTP does. Query-aware excerpts consider at most 32 distinct
  query terms. A 63 KB query previously cost around 12 seconds of CPU.
- **Pages a run sees as excluded are removed even when the run is not
  authoritative.** A page matched by `exclude`, blocked by `robots.txt`, marked
  `noindex` or weight 0, or served as a redirect stub is deleted from the index
  even if an unrelated page's extraction failure blocks general pruning. Before,
  one broken page kept every newly excluded page public. These deletions still
  count towards `maxDeletionRatio`. An unreadable `robots.txt` still blocks
  everything. This covers pages excluded by `source.build.exclude`, and every
  stored section of an excluded page, including older generations and pages
  indexed before chunk manifests. A URL the same run also indexed is never
  removed, and neither is one whose other source file failed to load or extract.
- **Prerendered redirect pages are skipped, not failed.** A page whose original
  HTML has no body text and a `<meta http-equiv="refresh">` is logged at info and
  treated as excluded; SvelteKit prerenders exactly this for a `redirect()`.
  Previously each one was an extraction failure that disabled pruning for the whole
  site. A page emptied by `dropSelectors` is still an extraction failure. A stub
  that redirects to its own URL, such as `docs.html` pointing to `/docs/`, is
  skipped without excluding `/docs`.
- **`--max-pages` counts URLs, not files.** Source files that serve the same URL,
  such as `docs.html` and `docs/index.html`, are loaded together, so a limited run
  cannot load a redirect stub without the page it stands in for.
- **In manifest mode, a dynamic route that cannot expand blocks deletions.** A
  route with no `paramValues`, or values that do not fit, left an incomplete
  inventory that could still authorise deleting live pages. The exception is a
  route whose every URL is covered by the top-level `exclude` or
  `source.build.exclude` (`/blog/**` covers `/blog/[slug]`). A route id is no longer
  matched against patterns as if it were a URL, so `/docs/*` does not exclude
  `/docs/[...slug]`.
- **Snippets no longer include the embedding prefix.** Result snippets and
  `chunkText` had started with the `Title — Section` text prepended for embedding,
  and page-summary snippets repeated the title. Deep links built from those
  snippets pointed at text that does not exist on the page. This is fixed at read
  time, so existing indexes benefit without re-indexing. The prefix is removed only
  when `chunking.prependTitle` is on, and summary text only from actual
  page-summary records, so a section that genuinely opens with the page title
  keeps it.
- **Scroll-to-text lands on the section, not the table of contents.** When a
  heading on the page matches `_ssk`, the text target is searched from that
  heading onwards; otherwise the first match outside `nav`, `aside` and
  `role="navigation"` wins. A documentation page repeats each heading in its "On
  this page" list ahead of the content, so a result whose target was the heading
  scrolled to the list. If `_sskt` cannot be found, the section heading is used.
  Matching stops at the first eligible occurrence and looks up text nodes by binary
  search, so a phrase repeated thousands of times on a long page no longer makes
  the lookup quadratic.
- **Snippets are plain text.** Markdown syntax was stripped by replacing every
  `#`, `>`, `*`, `_`, `|` and `-` with a space, which left link syntax such as
  `[Settings](/docs/settings)` in snippets and broke real words (`right-click`,
  `max_results`). Only syntax is removed now. Code spans keep their contents
  verbatim (`__init__`, `a || b`), table pipes are removed only on table rows, and
  backslash escapes from HTML conversion (`max\_results`) are removed. The
  conversion is linear, so pathological markdown can no longer make snippet
  building quadratic. Stored snippets change, so the first run after upgrading
  refreshes chunk metadata once, without re-embedding.
- **Browser clients drop malformed or unsafe result rows** instead of failing the
  whole response. An invalid envelope is still an `Invalid search response`. Result
  URLs are checked: a `javascript:` or `data:` URL is dropped, and
  `buildResultUrl` returns `""` for one.
- **`llms.txt` and `llms-full.txt` carry a "Retrieval API" section** naming the
  search endpoint, and the MCP endpoint when it would answer. No key or variable
  name is written.
- **Configured MCP transport, port and path now apply to the CLI.**
  `searchsocket mcp` and `dev --mcp` passed their own defaults, which always
  overrode `mcp.transport`, `mcp.http.port` and `mcp.http.path`.
- **`searchsocket search` takes the query positionally.** `--q` still works.
- **Breaking: the root export no longer exposes internals.** `isServerless`,
  `resolveScope`, `mergeConfigServerless` and `runMcpServer` are removed; none was
  documented. `createUpstashStore()` returns the new `SearchStore` interface rather
  than the concrete Upstash class, so storage internals such as legacy-record
  cleanup are no longer part of the public types. `SearchEngineOptions.store`
  takes a `SearchStoreReader` and `IndexPipelineOptions.store` a
  `SearchStoreWriter`.
- **Breaking: `isSearchResponse` is strict.** It returns `true` only when no row
  would be dropped. Use the new `parseSearchResponse` to get the cleaned response
  (or `null` for a broken envelope). Both are exported from `searchsocket/client`
  and `searchsocket/svelte`, alongside `isSafeResultUrl`.
- **Public types are complete.** Every type used in a public signature can now be
  imported: `SearchEngineOptions`, `IndexPipelineOptions`, `LoadConfigOptions`,
  `ConfigOverrides`, `RelatedPage`, `RelationshipType`, `SiteStructureResult`,
  `SiteTreeNode`, `ScoreBreakdown`, `RankingOverrides`, `OutgoingLink`,
  `ScopeMode`, `SourceMode`, `PageHit`, `IndexWriteRefusal`,
  `SearchSocketErrorOptions`, `SearchSocketHandleOptions`,
  `SearchSocketAutoIndexOptions`, `SearchClient`, `SearchClientOptions`,
  `LoggerOptions`, and the
  store types `SearchStore`, `SearchStoreReader`, `SearchStoreWriter`,
  `StoreRecord`, `StoreMetadataUpdate`, `StoreQueryOptions`, `PageHashEntry`,
  `ChunkHashEntry`, `ChunkInventoryEntry` and `RetrievalConstraints`. `searchsocket/client` exports a
  named `SearchClient` interface. The `Logger` class that
  `SearchEngineOptions.logger` and `IndexPipelineOptions.logger` accept is exported
  from `searchsocket`, so those options can be used without an internal import.
- **Dependencies refreshed.** `@modelcontextprotocol/sdk` now requires `^1.30.0`,
  and the lockfile picks up patched releases of the transitive runtime
  dependencies. `pnpm audit --prod` reports no known vulnerabilities, down from 76.
- **Error codes:** `CONFIG_INVALID` (a config that loads but does not validate;
  `CONFIG_MISSING` now means a file or required value is absent, such as the
  variable `scope.mode: "env"` reads) and
  `INDEX_WRITES_REFUSED` are new. The unused `EMBEDDING_MODEL_MISMATCH` and
  `EMBEDDING_FAILED` are removed.

### Fixed

- Page titles could come from a heading that `dropSelectors`, `dropTags` or
  `data-search-ignore` removed, because the title was derived before extraction
  exclusions ran. `data-search-ignore` on the content root itself was ignored. It
  now excludes the page.
- Index reads (page hashes, chunk scans, content hashes, page chunk fetches) retry
  on 429, 5xx and non-JSON error bodies. The store talks to Upstash through its own
  `Requester` (the SDK's documented transport hook), which keeps the HTTP status
  the SDK's default client discards, so this works whatever the error body says,
  for example a 503 answering `{"error":"overloaded"}`. A single transient Upstash
  error used to fail the deploy.
- Reading a page without a chunk manifest from a large scope scanned the whole
  scope with no ceiling. Pages now also record how many sections they have. A page
  too large to list its sections is read with page-filtered queries, and that
  result is used only when the section count matches. Otherwise the read falls
  back to a scan capped at 50 range requests, with an error that says whether
  reindexing will help. The first run after upgrading refreshes page metadata once,
  without re-embedding.
- `instanceof SearchSocketError` failed across entry points. Each published entry
  (`searchsocket`, `searchsocket/sveltekit`, the CLI, and the CommonJS and ESM
  builds) bundles its own copy of the class, so an error thrown by one and checked
  against the class imported from another was not recognised, and a config file
  that threw a typed error was reported as an invalid config. The class now
  recognises instances from every copy.
- `deletePages()` rethrew the raw SDK error rather than the classified storage
  error.
- With `serveMarkdownVariants` on, a backend outage turned the app's own `.md`
  routes into 500s. They now fall through to the app.
- `searchsocket mcp --transport http` in public mode refused every request whose
  `Host` was not localhost. `searchsocket mcp --api-key` could not satisfy a config
  with `mcp.access: "public"`, because the key was applied after validation.
- `searchsocket dev` could silently miss every edit inside a directory created
  after it started. With native file events, chokidar 5 on macOS intermittently
  never subscribes to such a directory. Source trees (`src/routes`, content roots,
  the config file) are now polled once a second. Build output stays on native
  events. `--no-poll` restores native events everywhere. "watcher ready" is printed
  once, not once per missing root.
- A non-finite score could reach a 200 response that the client then rejected;
  such hits are dropped on the server.
- CommonJS consumers received ESM type declarations. The exports map now points
  `require` at `.d.cts`.
- Documentation: the MCP guide and the README no longer claim the route is on by
  default or show a deployed connection without credentials, and the README's hook
  examples import the full config rather than replacing it with a partial one; the
  README and search UI guide describe row-level response validation instead of
  whole-response rejection; `indexing.maxDeletionRatio` and the
  URL pattern syntax are documented; CLI help names Upstash Vector;
  `SECURITY.md` lists 1.0.x.

## [0.11.0] - 2026-09-12

A correctness release from a full audit of the indexing, retrieval, CLI and
documentation surfaces. Most of it is defence: a refused deletion plan can no longer
be retried into a deletion, a truncated crawl can no longer authorize one, an
unreadable `robots.txt` no longer fails open, and `clean` can no longer delete the
project. Alongside that, chunk metadata that had been going stale forever — tags,
ordinals, route files, hook output — now reaches storage.

**Three changes need action.** The inert `embedding.*` config keys are now rejected
rather than ignored, the `svelte` peer floor moved to `^5.20.0`, and `pathPrefix`
matches whole path segments. Each is marked **Breaking:** below.

### Upgrade cost

The first indexing run after upgrading re-writes more than usual. Nothing is lost, and
the extra cost is one-off:

- **Every page summary re-upserts once.** The page fingerprint is now computed over
  canonical JSON, so every existing page hash differs and each page summary is written
  again.
- **Unchanged chunks get a metadata-only refresh — no re-embedding.** The text is not
  re-sent, so these cost a write but not an embedding.
- **`content-files` chunks whose text contained HTML entities re-embed once.** Raw
  `.svelte` extraction now decodes entities properly, so that text genuinely changed.

### Changed

- **Breaking: the inert `embedding.*` options are rejected instead of ignored.**
  `embedding.model`, `embedding.dimensions` and `embedding.taskType` were validated,
  merged and typed as required, and read by nothing — embeddings are generated by
  Upstash from the text SearchSocket sends, so the model is a property of the index
  and is chosen when that index is created. They join `embedding.batchSize` and
  `embedding.images.enable` in the removed-key list, so a config that still sets one
  now fails to load with a message naming the replacement. Delete the keys; to run a
  different model, create a new Upstash index with it and point `upstash.url` /
  `upstash.token` at that index.

- **A refused large-deletion plan now writes nothing at all.** Previously a run stopped by
  `indexing.maxDeletionRatio` still upserted its additions, which enlarged the
  inventory the ratio is measured against — an identical retry then saw the same stale
  records as a smaller fraction and deleted them without `--accept-large-deletion`
  being supplied. The whole mutation is now refused, so a refused plan stays refused
  however often it is repeated. The separate empty-source guard is unchanged: it stops
  deletions but still writes the run's additions.
- **An unreadable `robots.txt` blocks index writes** in `crawl` mode, the only mode that
  fetches it over the network. If the fetch times out, returns a server error, or exceeds
  the 512 KiB size cap, the run cannot tell which pages the site means to exclude, so it
  writes nothing rather than risk publishing an excluded page. A 404 or 410 still means
  "no rules here" and indexing proceeds. `static-output`/`build` read `robots.txt` from
  the build directory and treat an unreadable file as absent.
- **`robots.txt` matching follows RFC 9309** for `*` wildcards, the `$` end-anchor, group
  merging across consecutive `User-agent` lines, and longest-rule-wins specificity. Not
  certified-complete: percent-encoded paths are compared as written, not canonicalised.
- **`llms.txt` / `llms-full.txt` are only republished by a run holding the complete
  page list.** A truncated crawl, a failed extraction, or a refused deletion plan
  leaves the existing files alone. Sharp edge: if the index holds custom records and a
  run is not passed `customRecords`, those pages are missing from the run's page list
  and the exports are **not** refreshed — the warning now says so, and names
  `customRecords` as the fix. Passing `customRecords: []` asserts there are none.
- **Breaking: `pathPrefix` is now a segment prefix in search.** `/docs` matches `/docs` and
  `/docs/api` and no longer matches `/docsmith`. This is a behaviour change for any
  prefix that was relying on raw string matching. Note the scope: this covers the
  search and section-retrieval paths. Administrative page listing still matches on a
  raw string prefix, so `listPages` with `/docs` continues to return `/docsmith`.
- **`results: null` from a search endpoint is an error, not an empty result set.** The
  client and the `createSearch` store validate the response shape; on a 2xx response a
  `null` body, a parseable error page, or `results: null` raises `Invalid search
  response`. A rejected response is never written to the result cache.
- **Title and anchor ranking keeps non-ASCII letters.** Matching is Unicode-aware and
  NFC-normalized, so Japanese, Cyrillic, Greek and accented-Latin titles get the
  lexical boosts. Accents are preserved rather than folded, so a query for `cafe` no
  longer matches a title of `café`.
- **Chunk metadata is budgeted in UTF-8 bytes** against Upstash's 48 KB per-record
  limit, measured on the exact JSON that will be sent rather than in characters. The
  trimmable text field is truncated to fit with a warning; if the required fields alone
  do not fit, the run fails naming the page URL and the offending field.
- **Raw `.svelte` `content-files` mode honours noindex/weight/ignore signals
  statically**, and **withholds** a page when a recognised signal is present but not
  statically decidable — an expression, inside an `{#if}`, or a spread the scanner can tie
  to a protective attribute. Reading an undecidable protective signal as false would
  publish a page someone asked to hold back. Known gaps, pinned by tests:
  `{@html}`/`{@render}` contents are not extracted, `+layout.svelte` signals do not
  propagate to the pages beneath, and a conditional `data-search-ignore` drops its subtree
  without withholding the page.
- **Breaking: the `svelte` peer range is now `^5.20.0`.** The generated templates use
  `$props.id()`, which landed in Svelte 5.20.0; the previous `^5.0.0` allowed versions
  that cannot compile them.

### Fixed

- The relevance playground returned 500 for every error. It read `error.statusCode`,
  but `SearchSocketError` exposes `status`, so intended 4xx responses were reported as
  server errors.
- Documentation corrections throughout: browser examples import `searchsocketScrollToText`
  from `searchsocket/scroll` rather than the server-only `searchsocket/sveltekit`
  barrel; the quickstart installs `search-trigger` as well as `search-dialog`; the
  page-retrieval route is `/api/search/pages/<path>`, nested under `api.path`; hook
  examples use the real `ExtractedPage` and `IndexStats` shapes; the removed
  `embedding.*` keys no longer appear in a config example; `scoreGapThreshold` is
  described as adjacent-gap trimming, which is what the code does; scores are no longer
  described as a 0–1 confidence scale; the Upstash Vector feature claim says hybrid
  retrieval with DBSF fusion rather than reranking and input enrichment; `SECURITY.md`
  lists the supported versions and the anonymous `mcp.handle.access: "public"` mode.

## [0.10.0] - 2026-08-20

An MCP release. The SvelteKit handle route can now serve anonymous callers a
redacted result set instead of refusing them, so a public documentation agent can
query your site without holding an API key.

**Existing deployments are unaffected.** `mcp.handle.access` defaults to
`private`, which is exactly the previous behaviour: no `Authorization` header
means 503, and a wrong or malformed bearer token is still a 401 rather than a
silent downgrade.

### Added

- **`mcp.handle.access`** (`"public" | "private"`, default `"private"`) — governs
  the SvelteKit handle route. Setting it to `"public"` serves callers that present
  no `Authorization` header, with `routeFile`, `chunkText` and `breakdown` stripped
  from every tool result and a caller-supplied `scope` ignored — the same fields
  `api.exposeInternalFields` withholds from the browser API. A valid bearer token
  still returns them, so an editing agent configured with the key keeps source
  paths while a public agent does not. `mcp.handle.apiKey` / `apiKeyEnv` remain
  required while `access` is `private`.

### Changed

- `mcp.access` now documents its actual scope: it governs only the standalone MCP
  server's bind address. The handle route is governed by `mcp.handle.access`.
- Errors returned to anonymous MCP callers are mapped to a typed code rather than
  surfaced verbatim, so backend URLs and environment variable names are no longer
  disclosed. Authenticated callers keep the underlying error.

### Fixed

- The handle route's bearer comparison now runs through the shared `verifyApiKey`
  helper, which hashes both sides to equal-length digests before comparing. The
  previous inline check short-circuited on length, leaking the configured key's
  length to an unauthenticated caller.
- The MCP request-size check is ordered after authentication, so an oversized
  anonymous request to a private route answers 503 rather than disclosing the
  body limit with a 413.
- `get_related_pages` strips `routeFile` from its results for redacted callers,
  matching the other tools.

## [0.9.0] - 2026-08-19

A search UI release. The copy-paste templates behind `searchsocket add` are now a
polished, themeable command palette that needs no CSS framework.

**Existing integrations are unaffected.** Components you have already copied are
never modified, and `createSearch()` keeps its published interface, defaults and
request payload. Only what `searchsocket add` generates from now on has changed.

### Added

- **Redesigned search UI templates.** `searchsocket add` now generates a polished,
  self-contained command palette instead of a minimal Tailwind sketch. Each
  template directory ships the component plus `SearchResultRow.svelte`,
  `search-ui.ts` and `search-theme.css`, and nothing imports back into
  `node_modules` — the generated code is entirely yours.
- **No CSS framework required.** Styling is plain CSS driven by semantic
  `--ss-search-*` variables, so the default works in any SvelteKit project.
  Tailwind still works if you want it; the templates simply no longer depend
  on it.
- **Explicit theme modes.** A `theme` prop accepts `inherit` (default, follows
  the host app's `.dark` / `[data-theme="dark"]` convention), `system`, `light`
  and `dark`, and sets `color-scheme` to match. Plus a `density` prop, `class`
  and `style` forwarding, and stable `.ss-search__*` part classes documented as
  the styling escape hatch.
- **Richer results.** Rows now show the best matching section and a URL
  breadcrumb alongside the title and snippet, so a result explains *why* it
  matched. `SearchResults` can list matching sections as their own
  scroll-to-text links, and supports `list` and `cards` variants.
- **Search options as props.** `topK`, `scope`, `pathPrefix`, `tags`, `filters`,
  `groupBy`, `maxSubResults`, `debounce`, `cache` and `minQueryLength` are props
  on `SearchDialog` and `SearchInput` rather than hard-coded internals. Changing
  a scope or filter re-runs the current query without recreating the store.
- **`searchsocket add search-trigger`** — the visible button that opens the
  dialog. A keyboard shortcut alone is not discoverable.
- **`createSearch()` gains `status`, `resolvedQuery`, `hasSearched`, `clear()`
  and `retry()`**, plus `minQueryLength` and `keepPreviousResults` options. All
  additive: existing `query`/`results`/`loading`/`error`/`destroy()` behaviour
  and defaults are unchanged, the request body is unchanged, and the cache is
  still keyed on the query exactly as typed. The published `SearchState`
  interface is untouched — the new members live on a `SearchStore` interface
  that extends it, so code annotating or implementing `SearchState` still
  compiles.
- `onSelectError` on `SearchDialog` and `SearchInput`, so a rejected `onSelect`
  or `navigate` surfaces instead of becoming an unhandled rejection.

### Fixed

- Template components no longer use fixed DOM ids (`ss-listbox`, `ss-option-0`),
  which collided when a page had two search inputs, or a dialog and an inline
  input together. Ids are derived per instance and can be pinned with `id`.
- The dialog now traps `Tab` inside itself, restores focus to the element that
  opened it, and restores the previous `body` overflow value instead of clearing
  it — a page setting its own `overflow` no longer loses it on close.
- The active result is scrolled into view during arrow navigation instead of
  moving out of the visible list.
- `Enter` is ignored while an IME composition is active, so committing CJK and
  other composed text no longer navigates away mid-word.
- Inline results are selected on `pointerdown` with the default prevented, so
  the popup can no longer close before a click is processed.
- The first `Escape` in the inline input closes the popup while keeping the
  query and focus, rather than immediately blurring.
- `aria-expanded` on the inline input now reflects popup visibility, including
  the loading, empty and error popups, instead of whether results happen to exist.
- Inputs have real accessible names via a visually hidden `<label>` rather than
  relying on the placeholder.
- Results retained while the next query loads are highlighted against the query
  that produced them (`resolvedQuery`), not the query being typed.
- `Enter` pressed on the dialog's Clear or Retry button activates that button.
  Result-navigation keys were previously handled for the whole dialog, so Enter
  anywhere inside it opened the active result instead.
- Focus is pulled back into the dialog if something outside it takes focus; a
  Tab pressed after focus escaped never reached the dialog's own handler.
- The body scroll lock is reference counted, so two open dialogs no longer
  unlock the page early or leave `overflow: hidden` behind, and an existing
  `!important` priority is preserved.
- Inline results are selected on `click` rather than on any `pointerdown`, so a
  right-click no longer navigates and a touch drag can still scroll.
- While the inline popup is closed, `aria-controls` and `aria-activedescendant`
  are omitted instead of referencing elements that are not in the DOM, and the
  popup no longer opens below `minQueryLength` with nothing to show.
- Live regions announce settled outcomes only. Announcing each debounced change
  queued one utterance per keystroke, and the error state was read twice —
  once by the status region and once by its `role="alert"` panel.
- `searchsocket add` refuses to write through a symlink or over a directory, so
  `--overwrite` cannot follow a link out of the target directory.
- Breadcrumbs use only the path of an absolute result URL, rather than turning
  the scheme and host into segments.
- A response that resolves after its request was aborted no longer overwrites
  newer state. This is reachable only through a custom `fetchImpl` that ignores
  its `AbortSignal`; with the platform `fetch`, an aborted request rejects and
  never reached this path. Previously a superseded request could replace the
  results of the query that succeeded it.

### Changed

- `searchsocket add` prints the entry component explicitly (with the `$lib`
  alias where applicable) plus theme and customization hints, instead of
  guessing from the first file written. It says so when existing files were
  kept, and does not describe a template it did not write.
- The template copier handles `.ts`, `.css` and `.svg` assets and nested
  directories, not just top-level `.svelte` files. Existing files are still
  skipped unless `--overwrite` is passed, per file — so adding a second
  component preserves any edits made to the shared files.

## [0.8.0] - 2026-08-19

A stabilization release on the road to 1.0. Every change below fixes something
that was observably wrong, not merely untidy — several could destroy a
production index or expose unpublished content.

**Upgrading requires a full reindex.** Record identity changed, so 0.7.x records
are invisible to 0.8 rather than misread. Nothing is deleted: the new generation
is written alongside the old one, and `searchsocket migrate cleanup-legacy`
removes the old records once you are satisfied. See
[docs/migration-0.8.md](docs/migration-0.8.md).

### Changed

- **Breaking:** A full reindex is required. Record IDs now carry the schema
  version, project id, scope name, and record type, and all four are verified on
  every read.
- **Breaking:** The MCP endpoint requires an API key. Its auth check was
  previously skipped entirely when none was configured, so it served anyone. Set
  `mcp.handle.apiKey` or `mcp.handle.apiKeyEnv`, or it answers 503.
- **Breaking:** `mcp.enable` is now honoured. It defaults to
  `NODE_ENV !== "production"`, so a production deployment relying on the
  endpoint must set it explicitly.
- **Breaking:** Browser requests can no longer choose their scope. `?scope=`,
  and `scope` in a POST body, are refused with 403 unless listed in
  `api.allowedScopes`.
- **Breaking:** Browser search responses omit `routeFile` and `chunkText`, and
  page responses omit `routeFile`. Enable `api.exposeInternalFields` to restore
  them. `SearchResult.routeFile` is now optional.
- **Breaking:** `POST /api/search` requires `Content-Type: application/json`.
- **Breaking:** Filter values containing a quote or backslash are rejected with
  400. Upstash's filter syntax defines no escape sequence for either, so
  escaping them was a guess that could widen a query across tenants.
- **Breaking:** Project ids and scope names are restricted to
  `[A-Za-z0-9._-]`, up to 80 characters. Relevant if you set
  `scope.sanitize: false`.
- **Breaking:** `searchsocket index` exits 5 when no vector backend is
  configured, instead of exiting 0. Pass `--allow-unconfigured` for the old
  behaviour.
- **Breaking:** `searchsocket clean --remote` is a dry run until `--apply`, and
  deletes a single scope. Project-wide deletion needs
  `--all-scopes --confirm-project <id>`.
- **Breaking:** Node 22.12 is the minimum. Node 20 reached end of life in March
  2026, and the CommonJS build needs unflagged `require(ESM)`.
- Per-page weights (`searchsocket-weight`, frontmatter) and
  `ranking.enableAnchorTextBoost` now affect ranking. Both were documented but
  inert in the default search path, so enabling them may shift your results.
- Chunk keys no longer depend on a chunk's position, so editing one section stops
  re-embedding the whole page.
- Search issues a bounded number of backend requests regardless of `topK`.

### Removed

- **Breaking:** `search.dualSearch`, `search.pageSearchWeight`,
  `ranking.aggregationCap`, `ranking.aggregationDecay`,
  `ranking.minChunkScoreRatio`, `ranking.weights.aggregation`,
  `embedding.batchSize`, `embedding.images.enable`, and
  `chunking.weightHeadings`. All were tunable and documented; none had any
  runtime effect. Setting one now produces a migration error naming its
  replacement rather than being silently ignored.
- **Breaking:** `UpstashSearchStore` is no longer exported from the package
  root. Use `createUpstashStore(config)`.

### Added

- `searchsocket migrate cleanup-legacy` removes records written under an older
  index schema, dry-run by default.
- `api.allowedScopes` and `api.exposeInternalFields` for browser access policy.
- `upstash.batchSize` and `upstash.maxRetries` for request batching and
  transient-failure retry.
- `indexing.maxDeletionRatio`, plus `--allow-empty` and
  `--accept-large-deletion` on `searchsocket index`.
- `mcp.handle.apiKeyEnv`, so the MCP key need not be committed.
- `SECURITY.md` documenting the public/privileged split, and
  `CONTRIBUTING.md` documenting the test tiers.

### Fixed — data safety

- An indexing run truncated by `--max-pages`/`--max-chunks`, or one that failed
  to fetch or extract a page, or whose source unexpectedly returned nothing, no
  longer deletes the records it did not see. Any of these could previously erase
  a valid production index.
- `clean --remote --scope X` resolved the scope flag and then dropped the entire
  project.
- `prune` fails closed when the remote branch list cannot be trusted (shallow
  clone, no remotes, empty scopes file), no longer treats an unknown timestamp
  as old, and requires a scope to be both orphaned and inactive by default.
- `listScopes` stamped `new Date()` on every scope, making TTL pruning
  meaningless. It reports the newest real `indexedAt`, or `"unknown"`.
- Force mode wiped the page namespace before re-upserting, so a crash between
  the two served an empty index. It now upserts first and deletes after.
- Custom records supplied through `customRecords` are no longer deleted by a
  site-only indexing run that does not mention them.

### Fixed — isolation

- Page IDs were raw URLs and chunk keys omitted the project id, while all
  projects shared two namespaces. Two sites in one Upstash index both serving
  `/docs` wrote to the same record.
- `getPage()` returned whatever the backend gave it without checking ownership.
- Project ids and scope names were concatenated into filter expressions
  unescaped and unvalidated.
- `git rev-parse` ran without a working directory, so `--cwd` read one project's
  config while resolving another repository's branch as the scope.

### Fixed — reliability

- Sixteen `catch {}` blocks returned empty results for every backend failure, so
  an outage was indistinguishable from an empty index. Failures are now typed
  and only a genuinely absent namespace reads as empty.
- Error messages reaching callers no longer carry raw SDK text, which can
  contain credentials.
- `listPages` returned whatever survived filtering one backend page, so a
  request for 50 could return 3 with no way to tell that from the end of the
  list.

### Fixed — security

- Any caller could select any scope via `?scope=` or a POST body.
- Browser search responses carried `routeFile` and `chunkText` to every caller.
- The MCP endpoint's auth check was skipped entirely when no key was configured.
- Crawl requests gained timeouts, response size caps, an accepted content type,
  and a same-origin redirect policy.
- External links were counted as internal, inflating pages' incoming-link
  ranking with links pointing at other sites.

## [0.7.1] - 2026-04-11

### Fixed

- Reject GET and DELETE requests to MCP endpoint with 405 to prevent SSE reconnect storms on serverless
- Allow `SearchEngine` to operate without Upstash credentials — returns typed `SEARCH_NOT_CONFIGURED` error instead of crashing

## [0.7.0] - 2026-04-05

### Changed

- **Breaking:** Reduce MCP tool surface from 6 tools to 3 focused tools (`search`, `get_page`, `get_related_pages`)
- Remove `find_source_file` tool (redundant — `search` already returns `routeFile` in every result)
- Remove `list_pages` tool (LLMs should search, not browse; filesystem handles enumeration locally)
- Remove `get_site_structure` tool (same reasoning; too much context for LLM consumption)
- Rename `pathOrUrl` parameter to `path` in `get_page` and `get_related_pages` for LLM usability
- Rewrite all tool descriptions with cross-references, negative constraints, and parameter examples
- Add smart error recovery to `get_page` — suggests similar pages when requested page not found
- Return human-readable "no results" message from `search` instead of empty JSON
- Remove `outputSchema` from search tool to reduce token overhead in tool definitions

## [0.6.3] - 2026-04-04

### Changed

- Remove `markdown` field from page vector metadata to avoid exceeding Upstash's 48KB metadata limit on large pages
- Reconstruct page markdown on demand from chunks via new `getChunksForPage()` method
- Add 30,000-character hard cap on `chunkText` in chunk metadata as a safety net

## [0.6.2] - 2026-04-04

### Fixed

- Gracefully skip indexing when vector backend is unavailable instead of crashing
- Upgrade to Node 24 for npm v11 OIDC support in publish workflow
- Switch publish command to pnpm with provenance
- Remove broken `npm install -g npm@latest` from publish workflow

## [0.6.1] - 2026-04-03

### Fixed

- Use targeted `fetch()` for chunk content hashes instead of `range()` scan to avoid namespace cross-contamination on hybrid indexes
- Use `range()` scan for stale chunk ID detection (safe for deletion since removing non-existent IDs is idempotent)
- Reduce Upstash batch size from 100 to 90 to stay within API limits

## [0.6.0] - 2026-04-03

### Added

- **Hybrid search (dense + BM25)** — enables combined dense vector and BM25 keyword search with 512-token limit enforcement
- **Page-first search pipeline** — per-page chunk retrieval for better result grouping
- **Namespace support** — Upstash Vector namespace isolation for multi-tenant indexing
- **Structured metadata filtering** — filter search results by indexed metadata fields
- **Freshness scoring** — time-based ranking signal to boost recently updated content
- **Internal link anchor text ranking** — use anchor text from internal links as an additional relevance signal
- **Content-level heading weight** — heading context influences chunk embeddings for better semantic matching
- **Query-aware excerpts** — generate contextual excerpts highlighting query-relevant passages
- **Sub-results in MCP** — expose chunk-level sub-results with configurable `maxSubResults`
- **Custom record indexing API** — index non-HTML content (JSON, CSV, API data) programmatically
- **Interactive ranking tuner** — dev playground tool for tuning ranking parameters in real time
- **`get_related_pages` MCP tool** — find related pages using multi-signal scoring
- **`get_site_structure` MCP tool** — hierarchical page tree for site navigation
- **`list_pages` MCP tool** — enumerate indexed pages with path prefix filtering
- **`find_source_file` MCP tool** — locate source files for content editing workflows
- **MCP public/private access modes** — API key authentication for public MCP endpoints
- **MCP endpoint via `searchsocketHandle`** — serverless MCP access through SvelteKit hooks
- **Component indexing** — index Svelte component files alongside pages
- **`llms.txt` generation** — default `generateFull: true` and serve markdown variants
- **`.mcp.json` generation** — auto-generate MCP config during `searchsocket init`
- **Interactive CLI setup** — `searchsocket init` with auto-config injection
- **Copy-paste component recipes** — `searchsocket add` command for UI components
- **Search playground UI** — interactive search testing during dev mode
- **Search quality CLI** — `searchsocket test` command for MRR-based quality assertions
- **GET API endpoints** — REST endpoints for search, health, and page retrieval
- **Opt-in search analytics** — analytics tracking with CLI report command
- **Lifecycle hooks** — `transformPage`, `transformChunk`, `beforeIndex`, `afterIndex` pipeline hooks
- **Incremental page records** — content hashing for efficient re-indexing
- **Reactive Svelte 5 search primitives** — `createSearch` and `SearchSocket.svelte` for frontend

### Changed

- **Switched to Upstash built-in embedding** — use Upstash's native embedding via `data` field, removing external embedding dependency
- **Removed Gemini embedder** — dropped `@google/generative-ai` dependency and related config
- **Replaced absolute `minScore` with relative `minScoreRatio`** — score threshold is now relative to the top result for more consistent filtering
- **Migrated search UI to Tailwind 4** — updated template components to Tailwind 4 utility classes

### Fixed

- Prevent incoming link count inflation from anchor text deduplication
- Map `OutgoingLink[]` to `string[]` for `outgoingLinkUrls` compatibility
- Propagate score breakdown through `dualSearch` merge
- Handle missing Upstash credentials gracefully
- Prevent `apiPath` guard from bypassing `llms.txt` intercept

## [0.5.0] - 2026-03-02

### Added

- **Scroll-to-text navigation** — search result links now include `_sskt` (text target) and `_ssk` (section title) query params plus native `#:~:text=` fragments for smooth scroll-to-text on both SvelteKit client navigations and full page loads
- **Cross-node text matching** — TreeWalker-based text map concatenates all visible text nodes, enabling matches that span split DOM nodes (e.g. `<em>Install</em>ation`)
- **CSS Custom Highlight API** — non-destructive highlighting via `::highlight()` pseudo-element in modern browsers, with DOM mutation fallback for older browsers
- **Two-pass regex matching** — strict pass requires separators between tokens; lenient fallback allows zero-width separators for adjacent DOM nodes without whitespace
- **Dual page+chunk parallel search** — parallel vector search at both page and chunk granularity with score blending for improved relevance
- **Reranking, score-gap trimming, and title boost** — search quality improvements with configurable ranking pipeline

### Changed

- **Migrated vector backend from Jina + Turso to Upstash Search** — simplified infrastructure with a single managed search service
- Removed local markdown mirror feature

### Fixed

- Respect Upstash 4096-char content limit per document during indexing
- Fixed pnpm version in CI prune workflow

## [0.4.0] - 2026-02-25

### Added

- **NDJSON streaming search** — new streaming search endpoint with smart merge utility for combining partial results
- **Robots.txt support** — respects `robots.txt` directives during indexing
- **Meta-based page weighting** — extract and apply weight hints from page meta tags
- **Glob pattern filtering** — include/exclude pages by glob patterns in config
- **MCP rerank support** — the MCP `search` tool now supports reranking results
- **`SEARCHSOCKET_FORCE_REINDEX` env var** — set to `1`, `true`, or `yes` in CI/CD to trigger force rebuilds without CLI flag changes

### Changed

- Upgraded default embedding model to `jina-embeddings-v5-text-small`
- Upgraded default reranker to `jina-reranker-v3`

### Fixed

- Replaced fraction-based merge metric with single `maxDisplacement` check for more reliable result merging

## [0.3.3] - 2026-02-25

### Changed

- Reduced rerank API payload size for lower latency

## [0.3.2] - 2026-02-25

### Added

- Support `pageWeights: 0` as a no-index signal to exclude specific pages
- Prioritise `og:title` and `h1` over `<title>` tag during content extraction

## [0.3.1] - 2026-02-24

### Added

- Limit chunks per page sent to reranker for efficiency
- Include page description and keywords in reranker text for better relevance

## [0.3.0] - 2026-02-24

### Added

- **Page-level reranking** — reranker now receives assembled page documents (all matching chunks concatenated in document order) instead of individual chunk snippets, giving it a holistic view of each page's relevance
- **Stored chunk text** — full chunk markdown (up to 4000 chars) is now persisted alongside the snippet for richer reranking context
- **`ranking.minScore`** — configurable minimum absolute score threshold to filter out low-relevance results before they reach the client (default: `0`, disabled)
- **Link-discovery crawling for build mode** — `source.build.discover` enables automatic page discovery by crawling internal links from seed URLs, with configurable `maxPages` and `maxDepth` limits
- **Direct credential passing** — `embeddings.apiKey`, `vector.turso.url`, and `vector.turso.authToken` allow passing credentials directly in config instead of through environment variables
- **Dimension mismatch auto-recovery** — automatically detects and recreates the chunks table when switching to an embedding model with a different vector dimension

### Changed

- Replaced OpenAI embedding provider with Jina AI (`jina-embeddings-v3`) as the default and only provider; uses task-specific LoRA adapters (`retrieval.passage` for indexing, `retrieval.query` for search)
- Reranker uses Jina AI (`jina-reranker-v2-base-multilingual`), sharing the same API key as embeddings
- Removed `openai` dependency

### Fixed

- Fixed TypeScript errors in test mocks (missing `dropAllTables` implementations)

## [0.2.1] - 2026-02-24

### Changed

- Exclude source maps from published package (8.6 MB → 2.8 MB unpacked)

## [0.2.0] - 2026-02-24

Initial public release.

### Added

- **Indexing pipeline** with incremental updates, content hashing, and cost tracking
- **Four source modes**: `static-output`, `build`, `crawl`, and `content-files`
- **Semantic search** with Jina AI embeddings (`jina-embeddings-v3`) with task-specific LoRA adapters
- **Vector storage** via Turso/libSQL (local and remote)
- **Reranking** with Jina AI for improved result relevance
- **Page-level score aggregation** with score-weighted decay
- **Synthetic page summary chunks** with meta extraction
- **MCP server** (stdio and HTTP transport) with `search` and `get_page` tools
- **SvelteKit integration**: Vite plugin for build-triggered indexing and server hook for search API
- **Browser client** (`searchsocket/client`) for frontend search integration
- **CLI commands**: `init`, `index`, `status`, `dev`, `clean`, `prune`, `doctor`, `mcp`, `search`
- **Markdown mirror** of indexed pages for content workflows (git-trackable)
- **Multi-scope support** using git branches for environment isolation
- **Noindex support** for excluding pages from indexing
- **Gzip sitemap support** for crawl source mode
- **Auto-loading of `.env`** file on CLI startup
- **Structured error handling** with typed error codes
- **Request validation** with Zod schemas
- **Rate limiting** and CORS configuration for the search API

[Unreleased]: https://github.com/gregpriday/searchsocket/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/gregpriday/searchsocket/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/gregpriday/searchsocket/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/gregpriday/searchsocket/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/gregpriday/searchsocket/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/gregpriday/searchsocket/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/gregpriday/searchsocket/compare/v0.6.3...v0.7.0
[0.6.3]: https://github.com/gregpriday/searchsocket/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/gregpriday/searchsocket/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/gregpriday/searchsocket/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/gregpriday/searchsocket/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/gregpriday/searchsocket/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/gregpriday/searchsocket/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/gregpriday/searchsocket/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/gregpriday/searchsocket/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/gregpriday/searchsocket/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/gregpriday/searchsocket/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/gregpriday/searchsocket/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/gregpriday/searchsocket/releases/tag/v0.2.0
