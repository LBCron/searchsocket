<!--
  SearchInput — inline search field with a dropdown of results.

  Same visual language as SearchDialog, driven by the same --ss-search-* tokens
  in ./search-theme.css. No Tailwind required.

  For non-SvelteKit apps, drop the `$app/navigation` import and pass your own
  `navigate` prop, e.g. navigate={(url) => (window.location.href = url)}.
-->
<script lang="ts">
  import { createSearch } from "searchsocket/svelte";
  import { buildResultUrl } from "searchsocket/client";
  import type { SearchResult } from "searchsocket";
  import { goto } from "$app/navigation";
  import SearchResultRow from "./SearchResultRow.svelte";
  import { optionId, wrapIndex } from "./search-ui";
  import "./search-theme.css";

  let {
    // Behavior
    value = $bindable(""),
    open = $bindable(false),
    endpoint = "/api/search",
    debounce = 250,
    cache = true,
    cacheSize = 50,
    topK = 8,
    scope = undefined,
    pathPrefix = undefined,
    tags = undefined,
    filters = undefined,
    groupBy = "page",
    maxSubResults = 3,
    minQueryLength = 1,

    // Appearance
    theme = "inherit",
    density = "comfortable",
    placeholder = "Search…",
    label = "Search site",
    emptyMessage = "Try fewer words or a broader phrase.",
    showSnippets = true,
    showBreadcrumbs = true,
    showSectionTitle = true,
    placement = "bottom-start",
    class: className = "",
    style = "",
    id = undefined,

    // Selection
    autoSelectFirst = true,
    clearOnNavigate = true,
    onSelect = undefined,
    onSelectError = undefined,
    navigate = (url: string) => goto(url),
  }: {
    value?: string;
    open?: boolean;
    endpoint?: string;
    debounce?: number;
    cache?: boolean;
    cacheSize?: number;
    topK?: number;
    scope?: string;
    pathPrefix?: string;
    tags?: string[];
    filters?: Record<string, string | number | boolean>;
    groupBy?: "page" | "chunk";
    maxSubResults?: number;
    minQueryLength?: number;
    theme?: "inherit" | "system" | "light" | "dark";
    density?: "comfortable" | "compact";
    placeholder?: string;
    label?: string;
    emptyMessage?: string;
    showSnippets?: boolean;
    showBreadcrumbs?: boolean;
    showSectionTitle?: boolean;
    placement?: "bottom-start" | "bottom-end";
    class?: string;
    style?: string;
    id?: string;
    autoSelectFirst?: boolean;
    clearOnNavigate?: boolean;
    /** Called before navigation. Return `false` to handle the result yourself. */
    onSelect?: (result: SearchResult) => unknown;
    /** Called when `onSelect` or `navigate` rejects, instead of an unhandled rejection. */
    onSelectError?: (error: Error) => unknown;
    navigate?: (url: string) => unknown;
  } = $props();

  // Every option is read through a getter: the connection settings are read
  // once when the store is created, and the query options are re-read on each
  // request, so changing `scope`/`pathPrefix`/`filters` re-runs the search
  // without recreating the store.
  const search = createSearch({
    get endpoint() { return endpoint; },
    get debounce() { return debounce; },
    get cache() { return cache; },
    get cacheSize() { return cacheSize; },
    get minQueryLength() { return minQueryLength; },
    get topK() { return topK; },
    get scope() { return scope; },
    get pathPrefix() { return pathPrefix; },
    get tags() { return tags; },
    get filters() { return filters; },
    get groupBy() { return groupBy; },
    get maxSubResults() { return maxSubResults; },
  });

  // $props.id() produces the same value on the server and the client, so the
  // generated ids survive hydration; `id` pins them for integration tests.
  const uid = $props.id();
  const baseId = $derived(id ?? uid);
  const inputId = $derived(`${baseId}-input`);
  const listboxId = $derived(`${baseId}-listbox`);

  let activeIndex = $state(-1);
  let inputEl = $state<HTMLInputElement | null>(null);
  let containerEl = $state<HTMLDivElement | null>(null);
  let optionEls = $state<Array<HTMLLIElement | null>>([]);
  let composing = false;
  let selecting = false;

  const results = $derived(search.results);

  // The popup is visible whenever there is something to show — including the
  // loading, empty and error panels, which are still expanded popups.
  const popupVisible = $derived(
    open && search.query.trim().length >= Math.max(minQueryLength, 1)
  );

  const activeOptionId = $derived(
    popupVisible && activeIndex >= 0 && activeIndex < results.length
      ? optionId(baseId, activeIndex)
      : undefined
  );

  const statusMessage = $derived.by(() => {
    if (!popupVisible) return "";
    const q = search.resolvedQuery;
    switch (search.status) {
      case "success":
        return `${results.length} ${results.length === 1 ? "result" : "results"} for “${q}”`;
      case "empty":
        return `No results for “${q}”`;
      default:
        // The error panel is a role="alert"; announcing it here as well would
        // read it twice.
        return "";
    }
  });

  // Seed synchronously so a server-rendered <SearchInput value="…" /> shows the
  // value immediately; effects do not run during SSR.
  if (value) search.query = value;

  // Then keep the bindable `value` prop and the store's query in sync, so a
  // parent can reset or replace the field later.
  $effect(() => {
    if (value !== search.query) search.query = value;
  });

  $effect(() => {
    const count = search.results.length;
    activeIndex = autoSelectFirst && count > 0 ? 0 : -1;
  });

  $effect(() => {
    if (activeIndex < 0) return;
    optionEls[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  });

  $effect(() => () => search.destroy());

  function move(delta: number): void {
    const count = results.length;
    if (count === 0) {
      activeIndex = -1;
      return;
    }
    activeIndex = activeIndex < 0 ? (delta > 0 ? 0 : count - 1) : wrapIndex(activeIndex + delta, count);
  }

  function handleKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) open = true;
        else move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) open = true;
        else move(-1);
        break;
      case "Home":
        if (!popupVisible || results.length === 0) break;
        event.preventDefault();
        activeIndex = 0;
        break;
      case "End":
        if (!popupVisible || results.length === 0) break;
        event.preventDefault();
        activeIndex = results.length - 1;
        break;
      case "Enter": {
        if (composing || event.isComposing) break;
        if (!popupVisible) break;
        const result = results[activeIndex];
        if (!result) break;
        event.preventDefault();
        select(result);
        break;
      }
      case "Escape":
        // First Escape closes the popup but keeps the query and focus. Pressing
        // it again on a closed popup clears the field.
        event.preventDefault();
        if (popupVisible) open = false;
        else if (search.query) setQuery("");
        break;
    }
  }

  function handleFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget as Node | null;
    if (containerEl && next && containerEl.contains(next)) return;
    open = false;
  }

  function setQuery(next: string): void {
    value = next;
    search.query = next;
  }

  async function selectResult(result: SearchResult): Promise<void> {
    if (selecting) return;
    selecting = true;
    try {
      if (onSelect && (await onSelect(result)) === false) return;
      const url = buildResultUrl(result);
      // "" means the result URL failed the safe-link check (an executable
      // scheme, or one obfuscated with control characters). Never hand that to
      // the router; leave the list open so the selection visibly did nothing.
      if (!url) return;
      open = false;
      if (clearOnNavigate) setQuery("");
      await navigate(url);
    } finally {
      selecting = false;
    }
  }

  /** Discards the promise deliberately, but reports a failure instead of losing it. */
  function select(result: SearchResult): void {
    void selectResult(result).catch((error: unknown) => {
      onSelectError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }
</script>

<div
  bind:this={containerEl}
  class="ss-search ss-search--input {className}"
  data-theme={theme}
  data-density={density}
  data-state={search.status}
  {style}
  onfocusout={handleFocusOut}
>
  <div class="ss-search__field">
    <svg class="ss-search__search-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <circle cx="9" cy="9" r="5.5" />
      <path d="M13.2 13.2 17 17" />
    </svg>

    <label class="ss-search__sr-only" for={inputId}>{label}</label>
    <input
      bind:this={inputEl}
      id={inputId}
      class="ss-search__input"
      type="text"
      role="combobox"
      autocomplete="off"
      aria-expanded={popupVisible}
      aria-haspopup="listbox"
      aria-controls={popupVisible ? listboxId : undefined}
      aria-autocomplete="list"
      aria-activedescendant={activeOptionId}
      {placeholder}
      value={search.query}
      oninput={(event) => setQuery(event.currentTarget.value)}
      onfocus={() => (open = true)}
      onkeydown={handleKeydown}
      oncompositionstart={() => (composing = true)}
      oncompositionend={() => (composing = false)}
    />

    {#if search.loading}
      <span class="ss-search__spinner" aria-hidden="true"></span>
    {:else if search.query}
      <button
        type="button"
        class="ss-search__clear"
        aria-label="Clear search"
        onclick={() => {
          setQuery("");
          inputEl?.focus();
        }}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"
          stroke-linecap="round" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    {/if}
  </div>

  {#if popupVisible}
    <div class="ss-search__popup" data-placement={placement}>
      <div class="ss-search__body" aria-busy={search.loading}>
        <ul class="ss-search__list" role="listbox" id={listboxId} aria-label="Search results">
          {#each results as result, index (index)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <li
              bind:this={optionEls[index]}
              class="ss-search__option"
              role="option"
              id={optionId(baseId, index)}
              aria-selected={index === activeIndex}
              data-active={index === activeIndex}
              onmousemove={() => (activeIndex = index)}
              onpointerdown={(event) => {
                // Preventing the default on a primary mouse press keeps focus in
                // the input, so focusout cannot close the popup before the click
                // arrives. Selection itself happens on click, so a right-click
                // does not navigate and a touch drag can still scroll away.
                if (event.pointerType !== "touch" && event.button === 0) {
                  event.preventDefault();
                }
              }}
              onclick={(event) => {
                if (event.button !== 0) return;
                select(result);
              }}
            >
              <SearchResultRow
                {result}
                query={search.resolvedQuery}
                active={index === activeIndex}
                {showSnippets}
                {showBreadcrumbs}
                {showSectionTitle}
              />
            </li>
          {/each}
        </ul>

        {#if search.status === "error"}
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
            <span class="ss-search__state-actions">
              <button type="button" class="ss-search__button" onclick={() => search.retry()}>
                Retry
              </button>
            </span>
          </div>
        {:else if search.status === "empty"}
          <div class="ss-search__state">
            <span class="ss-search__state-title">No results for “{search.resolvedQuery}”</span>
            <span class="ss-search__state-description">{emptyMessage}</span>
          </div>
        {:else if search.loading && results.length === 0}
          <div class="ss-search__state ss-search__state--idle">
            <span class="ss-search__state-description">Searching…</span>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <span class="ss-search__sr-only" role="status" aria-live="polite">{statusMessage}</span>
</div>
