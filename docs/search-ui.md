# Building a Search UI

This guide walks through building a complete search experience with SearchSocket in a SvelteKit app. It covers the building blocks, common patterns, and practical examples — without prescribing any particular visual style.

## Quick start with templates

SearchSocket includes copy-paste Svelte 5 components you can add to your project and customize freely. They use `$props.id()`, so they need **Svelte 5.20 or newer**:

```bash
pnpm searchsocket add search-dialog     # Cmd+K command palette
pnpm searchsocket add search-input      # inline input with dropdown
pnpm searchsocket add search-results    # standalone result list
pnpm searchsocket add search-trigger    # the button that opens the dialog
```

Each command writes a self-contained kit into `src/lib/components/search/` (configurable with `--dir`):

```text
SearchDialog.svelte      the component you import
SearchResultRow.svelte   shared visual result row
search-ui.ts             pure helpers (highlighting, breadcrumbs, shortcuts)
search-theme.css         design tokens and part styles
```

The component source, markup and styling are yours once copied — nothing reaches back into the package for those. The templates do still import SearchSocket's runtime (`searchsocket/svelte`, `searchsocket/client`), which is what talks to your search API. Existing files are skipped unless you pass `--overwrite`, so adding a second component never clobbers edits you made to the shared files.

The default is styled with plain CSS driven by semantic variables, so it needs **no CSS framework** and looks finished without edits. It follows your app's light/dark convention by default, ships full keyboard navigation and ARIA wiring, and respects reduced-motion and forced-colors preferences.

A complete integration:

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { afterNavigate } from "$app/navigation";
  import { searchsocketScrollToText } from "searchsocket/scroll";
  import SearchDialog from "$lib/components/search/SearchDialog.svelte";
  import SearchTrigger from "$lib/components/search/SearchTrigger.svelte";

  let searchOpen = $state(false);
  afterNavigate(searchsocketScrollToText);
</script>

<SearchTrigger bind:open={searchOpen} label="Search docs" />

<SearchDialog
  bind:open={searchOpen}
  theme="inherit"
  label="Search documentation"
  placeholder="Search documentation…"
  pathPrefix="/docs"
  topK={10}
  maxSubResults={3}
  style="--ss-search-accent: #0f766e"
/>

<slot />
```

See [Theming the templates](#theming-the-templates) and [Template component props](#template-component-props) for the full customization surface. The rest of this guide explains the underlying building blocks so you can build from scratch or understand what the templates are doing.

## Building blocks

SearchSocket provides three layers for building search UIs:

### 1. `createSearch` — reactive Svelte 5 store

The easiest way to wire up search in a Svelte component. Handles debouncing, caching, abort control, and loading state.

```svelte
<script>
  import { createSearch } from "searchsocket/svelte";

  const search = createSearch({
    debounce: 250,      // ms before firing request (default)
    cache: true,         // LRU result caching (default)
    cacheSize: 50,       // max cached queries (default)
    topK: 10,
    groupBy: "page"
  });
</script>

<input bind:value={search.query} />

<!-- Reactive properties: -->
<!-- search.results       — SearchResult[] -->
<!-- search.loading       — boolean -->
<!-- search.error         — Error | null -->
<!-- search.status        — "idle" | "debouncing" | "loading" | "success" | "empty" | "error" -->
<!-- search.resolvedQuery — the query that produced the visible results -->
<!-- search.hasSearched   — true once any query has settled -->
<!-- search.clear()       — reset query, results and error -->
<!-- search.retry()       — re-run the current query, bypassing the cache -->
<!-- search.destroy()     — cleanup function -->
```

The store is reactive — updating `search.query` triggers a debounced search automatically. Previous in-flight requests are aborted when a new query comes in.

### Rendering states with `status`

`status` collapses the combinations you would otherwise have to reconstruct by hand:

```svelte
{#if search.status === "error"}
  <p role="alert">Search is unavailable.</p>
  <button onclick={() => search.retry()}>Retry</button>
{:else if search.status === "empty"}
  <p>No results for “{search.resolvedQuery}”</p>
{:else if search.status === "success"}
  <!-- results -->
{/if}
```

instead of:

```svelte
{#if search.query && !search.loading && !search.results.length && !search.error}
```

### `resolvedQuery` and stale results

By default the previous query's results stay visible while the next one loads, so the list does not flash empty on every keystroke. Highlight against `search.resolvedQuery`, **not** `search.query` — otherwise rows from the old query get marked up with terms that never matched them:

```svelte
{#each highlightParts(result.title, search.resolvedQuery) as part}
```

If you would rather clear results on each new query, pass `keepPreviousResults: false`.

### Other options

```ts
const search = createSearch({
  minQueryLength: 2,          // do not search below this length (default: 0)
  keepPreviousResults: false  // clear results when a new query starts (default: true)
});
```

The cache is keyed on the query exactly as typed, and the request carries it unchanged — a custom endpoint is free to treat `"deploy guide"` and `"deploy  guide"` differently.

`createSearch()` returns a `SearchStore`, which extends the original `SearchState` interface. Code annotated with `SearchState` keeps working unchanged.

### 2. `createSearchClient` — imperative client

For full control over when and how searches happen. Useful when you need custom debounce logic, want to trigger search on form submit, or are working outside Svelte components.

```ts
import { createSearchClient } from "searchsocket/client";

const client = createSearchClient({
  endpoint: "/api/search"   // default
});

const response = await client.search({
  q: "deployment guide",
  topK: 8,
  groupBy: "page",
  pathPrefix: "/docs",       // scope to a section
  tags: ["guide"],           // filter by tags
  maxSubResults: 3           // chunks per page result
});
```

### 3. `buildResultUrl` — scroll-to-text links

Builds a URL from a search result that includes scroll-to-text metadata. When the user navigates to the result, the page scrolls to the matching section and highlights the text.

```ts
import { buildResultUrl } from "searchsocket/client";

const href = buildResultUrl(result);
// "/docs/getting-started?_ssk=Installation&_sskt=Install+with+pnpm#:~:text=Install%20with%20pnpm"
```

Use this as the `href` for result links. If the result has no section title, the original URL is returned unchanged.

## Search modal (Cmd+K pattern)

The most common search UI pattern: a modal triggered by a keyboard shortcut.

### Basic structure

```svelte
<!-- SearchModal.svelte -->
<script lang="ts">
  import { createSearch } from "searchsocket/svelte";
  import { buildResultUrl } from "searchsocket/client";
  import { goto } from "$app/navigation";

  let { open = $bindable(false) }: { open?: boolean } = $props();

  const search = createSearch({ topK: 8, groupBy: "page" });

  let activeIndex = $state(-1);
  let inputEl = $state<HTMLInputElement | null>(null);

  // Focus input when modal opens
  $effect(() => {
    if (open && inputEl) inputEl.focus();
  });

  // Reset selection when results change
  $effect(() => {
    search.results;
    activeIndex = -1;
  });

  function navigateTo(result: (typeof search.results)[number]) {
    open = false;
    search.query = "";
    goto(buildResultUrl(result));
  }

  function handleKeydown(e: KeyboardEvent) {
    const count = search.results.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        activeIndex = count > 0 ? (activeIndex + 1) % count : -1;
        break;
      case "ArrowUp":
        e.preventDefault();
        activeIndex = count > 0 ? (activeIndex - 1 + count) % count : -1;
        break;
      case "Enter":
        e.preventDefault();
        if (activeIndex >= 0) navigateTo(search.results[activeIndex]);
        break;
      case "Escape":
        e.preventDefault();
        open = false;
        break;
    }
  }
</script>

{#if open}
  <div class="backdrop" onclick={() => (open = false)} onkeydown={handleKeydown}>
    <div class="dialog" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
      <input
        bind:this={inputEl}
        type="text"
        role="combobox"
        aria-expanded={search.results.length > 0}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        placeholder="Search..."
        value={search.query}
        oninput={(e) => (search.query = e.currentTarget.value)}
      />

      {#if search.loading}
        <div aria-live="polite">Searching...</div>
      {/if}

      {#if search.results.length > 0}
        <ul role="listbox">
          {#each search.results as result, i}
            <li
              role="option"
              aria-selected={i === activeIndex}
              onclick={() => navigateTo(result)}
              onmouseenter={() => (activeIndex = i)}
            >
              <strong>{result.title}</strong>
              {#if result.sectionTitle}
                <span>{result.sectionTitle}</span>
              {/if}
              {#if result.snippet}
                <p>{result.snippet}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if search.query && !search.loading && !search.results.length && !search.error}
        <div>No results found.</div>
      {/if}
    </div>
  </div>
{/if}
```

### Triggering with Cmd+K

Wire the keyboard shortcut in your root layout:

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { afterNavigate } from "$app/navigation";
  import { searchsocketScrollToText } from "searchsocket/scroll";
  import SearchModal from "$lib/components/SearchModal.svelte";

  let searchOpen = $state(false);

  afterNavigate(searchsocketScrollToText);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      searchOpen = !searchOpen;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<SearchModal bind:open={searchOpen} />

<slot />
```

### Preventing body scroll

Lock scrolling when the modal is open:

```svelte
$effect(() => {
  if (open) {
    document.body.style.overflow = "hidden";
  }
  return () => {
    document.body.style.overflow = "";
  };
});
```

## Scoped search

Scope search to a section of your site (e.g., only docs, only blog) by passing `pathPrefix`.

`pathPrefix` matches whole **path segments**, not raw string prefixes: `/docs` matches
`/docs` and `/docs/api`, and does not match `/docsmith`. `/` matches everything.

```svelte
<script>
  import { createSearch } from "searchsocket/svelte";

  let { pathPrefix = "" }: { pathPrefix?: string } = $props();

  const search = createSearch({
    topK: 8,
    groupBy: "page",
    pathPrefix: pathPrefix || undefined
  });
</script>
```

### Managing scope with a shared store

Create a lightweight state module so any component can open search with a specific scope:

```ts
// src/lib/search-state.svelte.ts
let open = $state(false);
let pathPrefix = $state("");
let placeholder = $state("Search...");

export function getSearchState() {
  return {
    get open() { return open; },
    set open(v: boolean) { open = v; },
    get pathPrefix() { return pathPrefix; },
    get placeholder() { return placeholder; },
    openGlobal() {
      pathPrefix = "";
      placeholder = "Search...";
      open = true;
    },
    openScoped(prefix: string, ph: string) {
      pathPrefix = prefix;
      placeholder = ph;
      open = true;
    }
  };
}
```

Then from a docs sidebar:

```svelte
<script>
  import { getSearchState } from "$lib/search-state.svelte";
  const search = getSearchState();
</script>

<button onclick={() => search.openScoped("/docs", "Search docs...")}>
  Search docs
</button>
```

And from the global nav:

```svelte
<button onclick={() => search.openGlobal()}>
  Search (Cmd+K)
</button>
```

## Result display patterns

### Query highlighting

Highlight matching terms in result titles and snippets:

```ts
function highlightParts(
  text: string,
  query: string
): Array<{ text: string; match: boolean }> {
  if (!query.trim()) return [{ text, match: false }];
  const escaped = query
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const splitter = new RegExp(`(${escaped})`, "gi");
  const tester = new RegExp(`^(?:${escaped})$`, "i");
  return text
    .split(splitter)
    .filter(Boolean)
    .map((part) => ({ text: part, match: tester.test(part) }));
}
```

Usage:

```svelte
{#each highlightParts(result.title, search.query) as part}
  {#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}
{/each}
```

### Breadcrumb paths

Turn a result URL into a readable breadcrumb:

```ts
function urlToBreadcrumb(url: string): string {
  return url
    .replace(/^\//, "")
    .replace(/\/$/, "")
    .split("/")
    .map((s) => s.replace(/-/g, " "))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" / ");
}
```

```svelte
<span class="breadcrumb">{urlToBreadcrumb(result.url)}</span>
```

### Section badges

Categorize results by URL prefix:

```svelte
{#if result.url.startsWith("/docs")}
  <span class="badge docs">Docs</span>
{:else if result.url.startsWith("/blog")}
  <span class="badge blog">Blog</span>
{/if}
```

### Sub-results (chunks)

When using `groupBy: "page"`, each result may include matching chunks from different sections of the page:

```svelte
{#each search.results as result}
  <div class="result">
    <a href={buildResultUrl(result)}>{result.title}</a>
    {#if result.chunks && result.chunks.length > 1}
      <ul class="sub-results">
        {#each result.chunks as chunk}
          <li>
            <a href={buildResultUrl({ ...result, sectionTitle: chunk.sectionTitle, snippet: chunk.snippet })}>
              {chunk.sectionTitle}
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/each}
```

## Scroll-to-text setup

For search result navigation to scroll to the matching section, add the handler to your root layout:

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { afterNavigate } from "$app/navigation";
  import { searchsocketScrollToText } from "searchsocket/scroll";

  afterNavigate(searchsocketScrollToText);
</script>
```

This reads the `_ssk` and `_sskt` query params from URLs generated by `buildResultUrl()` and:

1. Finds the matching text in the DOM using a TreeWalker
2. Scrolls smoothly to the match
3. Highlights the text using the CSS Custom Highlight API (with a DOM `<mark>` fallback)

Customize the highlight appearance:

```css
/* CSS Custom Highlight API (modern browsers) */
::highlight(ssk-search-match) {
  background-color: rgba(250, 204, 21, 0.4);
}

/* DOM fallback */
.ssk-highlight {
  background-color: rgba(250, 204, 21, 0.4);
  border-radius: 2px;
}
```

## Theming the templates

Design customization happens at three levels, in increasing order of effort:

1. **CSS variables** — accent, surfaces, radius, shadow. Covers most branding.
2. **Part classes** — stable `.ss-search__*` selectors for structural tweaks.
3. **Editing the source** — always available; it is your code.

### Theme modes

Every rendered template takes a `theme` prop:

```ts
type SearchTheme = "inherit" | "system" | "light" | "dark";
```

| Mode | Behavior |
| --- | --- |
| `inherit` (default) | Follows the host app's `.dark` or `[data-theme="dark"]` convention, and inherits any token overrides you set on an ancestor. |
| `system` | Follows `prefers-color-scheme` independently of the host app. |
| `light` | Always uses the light tokens. |
| `dark` | Always uses the dark tokens. |

Each mode also sets `color-scheme`, so native controls and scrollbars match.

SearchSocket does **not** manage your app's theme preference or persist anything — the host app owns that. `inherit` is right for normal integration; `system` suits standalone embeds and demos; `light`/`dark` are for forced contexts and side-by-side previews:

```svelte
<div class="preview">
  <SearchResults theme="light" {results} query="install" />
  <SearchResults theme="dark" {results} query="install" />
</div>
```

If your app marks dark mode some other way, add your selector to the inherit rule in `search-theme.css`:

```css
:where(.dark, [data-theme="dark"], .theme-night) .ss-search[data-theme="inherit"] {
  /* dark tokens */
}
```

### Design tokens

| Token | Purpose |
| --- | --- |
| `--ss-search-surface` | Dialog / dropdown background |
| `--ss-search-surface-raised` | Header and footer surface |
| `--ss-search-text` | Primary text |
| `--ss-search-text-strong` | Titles and the active result |
| `--ss-search-muted` | Snippets, breadcrumbs, helper text |
| `--ss-search-border` | Dividers |
| `--ss-search-border-strong` | Shell borders and key caps |
| `--ss-search-hover` | Pointer hover background |
| `--ss-search-active` | Keyboard-selected result background |
| `--ss-search-accent` | Focus ring, selection indicator, interactive accent |
| `--ss-search-mark` | Query-highlight background |
| `--ss-search-error` | Error text and icon |
| `--ss-search-backdrop` | Dialog backdrop |
| `--ss-search-radius` | Main shell radius |
| `--ss-search-shadow` | Main shell shadow |
| `--ss-search-font` | Font family (`inherit` by default) |

Layout tokens for finer control: `--ss-search-dialog-width`, `--ss-search-dialog-max-height`, `--ss-search-dialog-offset`, `--ss-search-popup-max-height`, `--ss-search-row-radius`, `--ss-search-row-padding`, `--ss-search-z-index`, `--ss-search-motion-duration`.

Set them per instance:

```svelte
<SearchDialog style="--ss-search-accent: #0f766e; --ss-search-radius: 18px" />
```

…or globally, including per theme:

```css
.product-search {
  --ss-search-accent: #0f766e;
  --ss-search-active: #ecfdf5;
  --ss-search-mark: #ccfbf1;
  --ss-search-radius: 20px;
  --ss-search-dialog-width: 44rem;
}

:where(.dark, [data-theme="dark"]) .product-search[data-theme="inherit"],
.product-search[data-theme="dark"] {
  --ss-search-accent: #5eead4;
  --ss-search-active: #123c38;
  --ss-search-mark: #134e4a;
}
```

```svelte
<SearchDialog class="product-search" />
```

### Part classes and data attributes

These class names are part of the public API — style them from outside the component. They will not change without a changelog entry, and are intended to stay stable through 1.x:

```text
.ss-search              .ss-search__backdrop        .ss-search__dialog
.ss-search__header      .ss-search__search-icon     .ss-search__input
.ss-search__clear       .ss-search__spinner         .ss-search__kbd
.ss-search__body        .ss-search__list            .ss-search__option
.ss-search__field       .ss-search__popup
.ss-search__result      .ss-search__result-main     .ss-search__result-title
.ss-search__result-meta .ss-search__result-section  .ss-search__result-breadcrumb
.ss-search__result-snippet                          .ss-search__result-action
.ss-search__results-list .ss-search__results-item   .ss-search__link
.ss-search__subresults  .ss-search__subresult-link  .ss-search__results-count
.ss-search__state       .ss-search__state-title     .ss-search__state-description
.ss-search__button      .ss-search__footer          .ss-search__footer-shortcuts
.ss-search__count       .ss-search__trigger         .ss-search__sr-only
```

Alongside data attributes for state-dependent styling:

```text
data-theme="inherit|system|light|dark"
data-density="comfortable|compact"
data-state="idle|debouncing|loading|success|empty|error"
data-variant="list|cards"          (search-results)
data-placement="bottom-start|bottom-end"  (search-input popup)
data-active="true|false"           (result options)
```

```css
.docs-search .ss-search__result-title {
  letter-spacing: -0.01em;
}
```

### Using Tailwind instead

The templates do not require Tailwind, but nothing stops you from using it: add utility classes through the `class` prop, or replace the markup wholesale. Deleting `search-theme.css` and its `import` removes the bundled styling entirely, leaving the behavior and ARIA wiring intact.

## Template component props

### Shared search options

Passed straight through to `createSearch()` on `SearchDialog` and `SearchInput`. Changing `scope`, `pathPrefix`, `tags` or `filters` re-runs the current query without recreating the store.

| Prop | Type | Default |
| --- | --- | --- |
| `endpoint` | `string` | `"/api/search"` |
| `debounce` | `number` | `250` |
| `cache` | `boolean` | `true` |
| `cacheSize` | `number` | `50` |
| `topK` | `number` | `8` |
| `scope` | `string` | — |
| `pathPrefix` | `string` | — |
| `tags` | `string[]` | — |
| `filters` | `Record<string, string \| number \| boolean>` | — |
| `groupBy` | `"page" \| "chunk"` | `"page"` |
| `maxSubResults` | `number` | `3` |
| `minQueryLength` | `number` | `1` |

### Shared appearance props

| Prop | Type | Default |
| --- | --- | --- |
| `theme` | `"inherit" \| "system" \| "light" \| "dark"` | `"inherit"` |
| `density` | `"comfortable" \| "compact"` | `"comfortable"` |
| `placeholder` | `string` | `"Search…"` |
| `label` | `string` | `"Search site"` — the accessible name |
| `emptyMessage` | `string` | `"Try fewer words or a broader phrase."` |
| `showSnippets` | `boolean` | `true` |
| `showBreadcrumbs` | `boolean` | `true` |
| `showSectionTitle` | `boolean` | `true` |
| `class` | `string` | `""` |
| `style` | `string` | `""` — the place for token overrides |
| `id` | `string` | auto — set it for deterministic DOM ids |

### `SearchDialog`

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `open` | bindable `boolean` | `false` | |
| `shortcut` | `boolean \| string` | `"mod+k"` | `false` disables the global listener; accepts `"ctrl+k"`, `"shift+/"`, `"/"` |
| `closeOnBackdrop` | `boolean` | `true` | |
| `clearOnNavigate` | `boolean` | `true` | Clear the query after choosing a result |
| `clearOnClose` | `boolean` | `false` | Escape and backdrop keep the query by default |
| `autoSelectFirst` | `boolean` | `true` | Makes Enter immediately useful |
| `showFooter` | `boolean` | `true` | Keyboard hints and result count |
| `idleMessage` | `string` | `"Search pages and documentation"` | |
| `onSelect` | `(result) => unknown` | — | Return `false` to cancel navigation |
| `onSelectError` | `(error: Error) => unknown` | — | Called when `onSelect` or `navigate` rejects |
| `navigate` | `(url: string) => unknown` | SvelteKit `goto` | Override for non-SvelteKit apps |

Pressing the shortcut while the dialog is already open focuses the input rather than closing it, and only one dialog responds to a given press. Result-navigation keys are bound to the input, so `Enter` on the Clear or Retry button activates that button instead of opening the active result.

Selection is guarded against re-entry: activating repeatedly while an async `onSelect` is pending navigates once.

### `SearchInput`

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `value` | bindable `string` | `""` | The query text |
| `open` | bindable `boolean` | `false` | Popup visibility |
| `placement` | `"bottom-start" \| "bottom-end"` | `"bottom-start"` | |
| `autoSelectFirst` | `boolean` | `true` | |
| `clearOnNavigate` | `boolean` | `true` | |
| `onSelect` / `onSelectError` / `navigate` | | | Same contract as the dialog |

Results are selected on `click`, with `pointerdown` used only to keep focus in the input — so a right-click opens a context menu and a touch drag scrolls instead of navigating. While the popup is closed, `aria-controls` and `aria-activedescendant` are omitted rather than pointing at elements that no longer exist.

The popup is positioned relative to the field, so an ancestor with `overflow: hidden` will clip it. On narrow layouts, consider opening the full dialog instead.

### `SearchResults`

| Prop | Type | Default |
| --- | --- | --- |
| `results` | `SearchResult[]` | `[]` |
| `query` | `string` | `""` |
| `loading` | `boolean` | `false` |
| `error` | `Error \| null` | `null` |
| `variant` | `"list" \| "cards"` | `"list"` |
| `showSubResults` | `boolean` | `true` |
| `maxVisibleSubResults` | `number` | `3` |
| `showCount` | `boolean` | `false` |

Because this is a plain list of links rather than a combobox listbox, it can render matching sections as their own links. The dialog and inline input deliberately keep each page as a single `role="option"` — nesting links inside a listbox option breaks screen reader navigation.

### `SearchTrigger`

| Prop | Type | Default |
| --- | --- | --- |
| `open` | bindable `boolean` | `false` |
| `label` | `string` | `"Search"` |
| `ariaLabel` | `string` | `"Open site search"` |
| `showShortcut` | `boolean` | `true` |
| `iconOnly` | `boolean` | `false` |

## Using the imperative client

For cases where the reactive store doesn't fit — server-side search, custom debounce, form-based search pages:

```ts
import { createSearchClient } from "searchsocket/client";

const client = createSearchClient();

// Search with all available parameters
const response = await client.search({
  q: "deployment",
  topK: 10,
  groupBy: "page",        // "page" (default) or "chunk"
  pathPrefix: "/docs",     // filter to this path segment and its subtree
  tags: ["guide"],         // filter by tags (AND logic)
  filters: { version: 2 }, // structured metadata filters
  maxSubResults: 5         // max chunks per page result
});

// Response shape
response.results     // SearchResult[]
response.q           // echoed query
response.scope       // resolved scope name
response.meta        // { timingsMs: { total: number } }
```

### Search result shape

```ts
interface SearchResult {
  url: string;
  title: string;
  sectionTitle?: string;        // heading of best-matching section
  snippet: string;              // text excerpt
  chunkText?: string;           // matched section's indexed text; omitted unless
                                //   api.exposeInternalFields is enabled
  score: number;                // relevance score. Comparable within one result
                                //   set only: additive boosts and the pageWeights
                                //   multiplier put it outside 0-1, and it is not
                                //   a confidence value
  routeFile?: string;           // SvelteKit source file path; omitted unless
                                //   api.exposeInternalFields is enabled
  chunks?: SearchResultChunk[]; // sub-results (page mode only)
}

interface SearchResultChunk {
  sectionTitle?: string;
  snippet: string;
  headingPath: string[];        // e.g. ["Getting Started", "Installation"]
  score: number;
}
```

### Response validation

Both the client and the `createSearch` store check the response shape before handing it
on. On a 2xx response, a JSON `null` body, an error page that happened to parse, or
`results: null` from a custom endpoint is rejected as `Invalid search response` — an
error state, not an empty result set. (A non-2xx response takes the earlier branch and
surfaces the endpoint's own error message, or `Search failed`.) Either way the client
throws and the store sets `search.error` and moves to `status: "error"`, rather than
showing "no matches" for what is actually a broken endpoint. A rejected response is never
written to the result cache.

## Accessibility

The template components ship with the wiring below. If building from scratch, these are the key attributes:

- Input: `role="combobox"`, `aria-expanded`, `aria-haspopup="listbox"`, `aria-autocomplete="list"`, `aria-controls`, `aria-activedescendant`
- Results list: `role="listbox"` with a unique `id`
- Each result: `role="option"`, `aria-selected`, unique `id`
- Modal: `role="dialog"`, `aria-modal="true"`, `aria-label`, `tabindex="-1"`
- Loading/error states: `aria-live="polite"` or `role="alert"`

### Keyboard

| Key | Behavior |
| --- | --- |
| `Cmd/Ctrl+K` | Open the dialog; focus the input if it is already open |
| `↓` / `↑` | Move to the next / previous result, wrapping at the ends |
| `Home` / `End` | First / last result |
| `PageDown` / `PageUp` | Move five results (dialog) |
| `Enter` | Open the active result — ignored while an IME composition is active |
| `Escape` | Close the dialog; in the inline input, close the popup first and clear on a second press |
| `Tab` / `Shift+Tab` | Stays inside the open dialog |

Focus returns to whatever was focused before the dialog opened, and the previous `body` overflow value is restored rather than cleared — so a page that sets its own `overflow` keeps it.

### Naming and identity

Every instance derives its element ids from a unique base, so two search inputs on one page — or a dialog and an inline input together — never produce duplicate DOM ids. Pass `id` when you want deterministic ids for integration tests. `label` sets the accessible name via a visually hidden `<label>`; a placeholder is not a durable label.

### Announcements

A visually hidden polite status region announces the settled result count and the empty state. Active-option changes rely on combobox semantics rather than duplicate live announcements, so arrow navigation is not read out twice.

### Interactive content inside options

Keep custom result markup non-interactive inside a `role="option"`. `SearchResultRow.svelte` renders text only for exactly this reason — the dialog and inline input wrap it in an option, while the standalone list wraps it in an `<a>`. Sub-result links belong to the standalone list, not the combobox.

### Preferences and contrast

The stylesheet honours `prefers-reduced-motion: reduce` (animation and transitions collapse) and `forced-colors: active` (borders, selection and marks stay visible using system colors). Selection is signalled by an inset accent bar and a trailing icon as well as background color, so it is never color alone.

## SvelteKit preloading

Speed up navigation by preloading page data when the user hovers a result:

```svelte
<script>
  import { preloadData } from "$app/navigation";
</script>

<a
  href={buildResultUrl(result)}
  onmouseenter={() => preloadData(result.url)}
>
  {result.title}
</a>
```

## API reference

### `POST /api/search`

The search endpoint accepts JSON:

```ts
{
  q: string;                    // required — search query
  topK?: number;                // max results (default: 10, max: 100)
  groupBy?: "page" | "chunk";  // result grouping (default: "page")
  pathPrefix?: string;          // filter to this path segment and its subtree
                                //   "/docs" matches /docs and /docs/api, not /docsmith
  tags?: string[];              // filter by tags (AND logic)
  filters?: Record<string, any>; // structured metadata filters
  maxSubResults?: number;       // chunks per page (default: 5, max: 20)
  scope?: string;               // index scope override
}
```

Also available as GET with query parameters:

```
GET /api/search?q=getting+started&topK=5&groupBy=page&pathPrefix=/docs
```

### `GET /api/search/health`

Returns backend health status:

```json
{ "ok": true }
```

An unhealthy backend answers `{ "ok": false, "details": "<category>" }` — a category, not
the raw backend message, which can carry a credential.

### `GET /api/search/pages/<path>`

Retrieve indexed markdown for a specific page. The route is nested under the
configured `api.path`, so with the default `/api/search` it is
`/api/search/pages/<path>`:

```
GET /api/search/pages/docs/getting-started
```

Returns the page's indexed markdown with frontmatter.

The markdown is reassembled from the indexed chunks, so it is complete enough to
read but is not byte-exact source: it can contain overlap between adjacent
sections, and a very long page may be truncated at the storage metadata cap.
