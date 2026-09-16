<!--
  SearchResults — standalone result list for SearchSocket.

  Use this when you own the search state (a /search page, a filtered listing)
  and only need the display. It is a plain list of links, not a combobox
  listbox, so sub-results can be links of their own.

  Styling comes from ./search-theme.css and the --ss-search-* tokens. Framework
  agnostic — nothing here imports SvelteKit.
-->
<script lang="ts">
  import { buildResultUrl } from "searchsocket/client";
  import type { SearchResult } from "searchsocket";
  import SearchResultRow from "./SearchResultRow.svelte";
  import { chunkAsResult, subResultsFor } from "./search-ui";
  import "./search-theme.css";

  let {
    results = [],
    query = "",
    loading = false,
    error = null,
    theme = "inherit",
    density = "comfortable",
    variant = "list",
    showSnippets = true,
    showBreadcrumbs = true,
    showSectionTitle = true,
    showSubResults = true,
    maxVisibleSubResults = 3,
    showCount = false,
    emptyMessage = "Try fewer words or a broader phrase.",
    class: className = "",
    style = "",
  }: {
    results?: SearchResult[];
    query?: string;
    loading?: boolean;
    error?: Error | null;
    theme?: "inherit" | "system" | "light" | "dark";
    density?: "comfortable" | "compact";
    variant?: "list" | "cards";
    showSnippets?: boolean;
    showBreadcrumbs?: boolean;
    showSectionTitle?: boolean;
    showSubResults?: boolean;
    maxVisibleSubResults?: number;
    showCount?: boolean;
    emptyMessage?: string;
    class?: string;
    style?: string;
  } = $props();

  const state = $derived(
    error ? "error" : loading ? "loading" : results.length > 0 ? "success" : query ? "empty" : "idle"
  );
</script>

<div
  class="ss-search ss-search--results {className}"
  data-theme={theme}
  data-density={density}
  data-variant={variant}
  data-state={state}
  {style}
>
  {#if error}
    <div class="ss-search__state ss-search__state--error" role="alert">
      <span class="ss-search__state-title">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"
          stroke-linecap="round" aria-hidden="true">
          <circle cx="10" cy="10" r="7.5" />
          <path d="M10 6v5M10 13.6v.1" />
        </svg>
        Search is temporarily unavailable
      </span>
      <span class="ss-search__state-description">Check your connection and try again.</span>
    </div>
  {/if}

  {#if results.length > 0}
    {#if showCount}
      <p class="ss-search__results-count">
        {results.length} {results.length === 1 ? "result" : "results"}
        {#if query}for “{query}”{/if}
      </p>
    {/if}

    <ul class="ss-search__results-list" aria-busy={loading}>
      {#each results as result, index (index)}
        {@const subResults = showSubResults ? subResultsFor(result, maxVisibleSubResults) : []}
        {@const href = buildResultUrl(result)}
        <li class="ss-search__results-item">
          <!--
            `buildResultUrl` returns "" for a URL that is not safe to navigate to
            (an executable scheme, or one obfuscated with control characters).
            Such a row still renders, so nothing silently disappears, but it is
            plain text rather than a link.
          -->
          {#if href}
            <a class="ss-search__link" href={href}>
              <SearchResultRow
                {result}
                {query}
                {showSnippets}
                {showBreadcrumbs}
                {showSectionTitle}
              />
            </a>
          {:else}
            <span class="ss-search__link ss-search__link--unavailable">
              <SearchResultRow
                {result}
                {query}
                {showSnippets}
                {showBreadcrumbs}
                {showSectionTitle}
              />
            </span>
          {/if}

          {#if href && subResults.length > 0}
            <ul class="ss-search__subresults">
              {#each subResults as chunk}
                {@const subHref = buildResultUrl(chunkAsResult(result, chunk))}
                {#if subHref}
                  <li>
                    <a class="ss-search__subresult-link" href={subHref}>
                      {chunk.sectionTitle}
                    </a>
                  </li>
                {/if}
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if loading}
    <div class="ss-search__state ss-search__state--idle" aria-live="polite">
      <span class="ss-search__state-description">Searching…</span>
    </div>
  {:else if query && !error}
    <div class="ss-search__state">
      <span class="ss-search__state-title">No results for “{query}”</span>
      <span class="ss-search__state-description">{emptyMessage}</span>
    </div>
  {/if}
</div>
