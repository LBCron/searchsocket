<!--
  SearchDialog — Cmd+K command palette for SearchSocket.

  Self-contained: styling lives in ./search-theme.css, so this works in any
  SvelteKit project with or without Tailwind. Customize by overriding the
  --ss-search-* tokens (see search-theme.css) or by editing this file — it is
  your code once copied.

  For non-SvelteKit apps, drop the `$app/navigation` import and pass your own
  `navigate` prop, e.g. navigate={(url) => (window.location.href = url)}.
-->
<script lang="ts">
  import { createSearch } from "searchsocket/svelte";
  import { buildResultUrl } from "searchsocket/client";
  import type { SearchResult } from "searchsocket";
  import { goto } from "$app/navigation";
  import SearchResultRow from "./SearchResultRow.svelte";
  import {
    focusableWithin,
    lockBodyScroll,
    matchesShortcut,
    optionId,
    platformShortcutLabel,
    wrapIndex,
  } from "./search-ui";
  import "./search-theme.css";

  let {
    // Behavior
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
    idleMessage = "Search pages and documentation",
    emptyMessage = "Try fewer words or a broader phrase.",
    showSnippets = true,
    showBreadcrumbs = true,
    showSectionTitle = true,
    showFooter = true,
    class: className = "",
    style = "",
    id = undefined,

    // Dialog behavior
    shortcut = "mod+k",
    closeOnBackdrop = true,
    clearOnNavigate = true,
    clearOnClose = false,
    autoSelectFirst = true,
    onSelect = undefined,
    onSelectError = undefined,
    navigate = (url: string) => goto(url),
  }: {
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
    idleMessage?: string;
    emptyMessage?: string;
    showSnippets?: boolean;
    showBreadcrumbs?: boolean;
    showSectionTitle?: boolean;
    showFooter?: boolean;
    class?: string;
    style?: string;
    id?: string;
    /** `false` disables the global listener; a string sets the binding, e.g. "mod+k". */
    shortcut?: boolean | string;
    closeOnBackdrop?: boolean;
    clearOnNavigate?: boolean;
    clearOnClose?: boolean;
    autoSelectFirst?: boolean;
    /** Called before navigation. Return `false` to handle the result yourself. */
    onSelect?: (result: SearchResult) => unknown;
    /** Called when `onSelect` or `navigate` rejects, instead of an unhandled rejection. */
    onSelectError?: (error: Error) => unknown;
    navigate?: (url: string) => unknown;
  } = $props();

  // Options are read through getters so scope/filter changes take effect
  // without recreating the store — the search re-runs when they change.
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
  let dialogEl = $state<HTMLDivElement | null>(null);
  let optionEls = $state<Array<HTMLLIElement | null>>([]);
  let shortcutLabel = $state("Ctrl K");
  let composing = false;
  let wasOpen = false;
  let selecting = false;

  const shortcutSpec = $derived(
    shortcut === false ? null : shortcut === true ? "mod+k" : shortcut
  );
  const results = $derived(search.results);
  const activeOptionId = $derived(
    activeIndex >= 0 && activeIndex < results.length ? optionId(baseId, activeIndex) : undefined
  );

  const statusMessage = $derived.by(() => {
    const q = search.resolvedQuery;
    switch (search.status) {
      case "success":
        return `${results.length} ${results.length === 1 ? "result" : "results"} for “${q}”`;
      case "empty":
        return `No results for “${q}”`;
      default:
        // Nothing while typing or loading: the spinner carries that, and
        // announcing each keystroke queues an utterance per character. The
        // error state is announced by its own role="alert" panel.
        return "";
    }
  });

  // The shortcut hint depends on the platform, so it is resolved after mount
  // rather than during SSR where navigator does not exist.
  $effect(() => {
    shortcutLabel = platformShortcutLabel();
  });

  // Select the first result as soon as results settle, so Enter is immediately useful.
  $effect(() => {
    const count = search.results.length;
    activeIndex = autoSelectFirst && count > 0 ? 0 : -1;
  });

  // Keep the keyboard selection inside the scroll viewport.
  $effect(() => {
    if (activeIndex < 0) return;
    optionEls[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  });

  // Remember and restore the element that had focus before the dialog opened.
  $effect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    return () => previouslyFocused?.focus?.();
  });

  $effect(() => {
    if (open) inputEl?.focus();
  });

  // Lock body scroll. The lock is reference counted so two open dialogs cannot
  // unlock the page early or leave it locked afterwards.
  $effect(() => {
    if (!open) return;
    return lockBodyScroll();
  });

  $effect(() => {
    if (!open) return;

    function onFocusIn(event: FocusEvent) {
      const target = event.target as Node | null;
      if (!dialogEl || !target || dialogEl.contains(target)) return;
      // Something outside the modal took focus — pull it back.
      (focusableWithin(dialogEl)[0] ?? dialogEl).focus();
    }

    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  });

  $effect(() => {
    if (open) {
      wasOpen = true;
      return;
    }
    if (wasOpen) {
      wasOpen = false;
      if (clearOnClose) search.clear();
    }
  });

  $effect(() => {
    const spec = shortcutSpec;
    if (!spec) return;

    function onKeydown(event: KeyboardEvent) {
      // Another dialog already claimed this press.
      if (event.defaultPrevented || event.isComposing) return;
      if (!matchesShortcut(event, spec!)) return;
      event.preventDefault();
      // Re-pressing while open focuses the input instead of closing unpredictably.
      if (open) inputEl?.focus();
      else open = true;
    }

    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
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

  /** Modal-wide keys: these apply wherever focus sits inside the dialog. */
  function handleDialogKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      open = false;
    } else if (event.key === "Tab") {
      trapFocus(event);
    }
  }

  /** Result navigation, bound to the input so it never swallows Enter on a button. */
  function handleInputKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Home":
        if (results.length === 0) break;
        event.preventDefault();
        activeIndex = 0;
        break;
      case "End":
        if (results.length === 0) break;
        event.preventDefault();
        activeIndex = results.length - 1;
        break;
      case "PageDown":
        if (results.length === 0) break;
        event.preventDefault();
        activeIndex = Math.min(results.length - 1, Math.max(activeIndex, 0) + 5);
        break;
      case "PageUp":
        if (results.length === 0) break;
        event.preventDefault();
        activeIndex = Math.max(0, Math.max(activeIndex, 0) - 5);
        break;
      case "Enter": {
        // Never act on the Enter that commits an IME composition.
        if (composing || event.isComposing) break;
        const result = results[activeIndex];
        // Only claim the key when it will actually do something.
        if (!result) break;
        event.preventDefault();
        select(result);
        break;
      }
    }
  }

  function trapFocus(event: KeyboardEvent): void {
    if (!dialogEl) return;
    const focusable = focusableWithin(dialogEl);
    if (focusable.length === 0) return;

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const current = document.activeElement;

    if (event.shiftKey && (current === first || !dialogEl.contains(current))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (current === last || !dialogEl.contains(current))) {
      event.preventDefault();
      first.focus();
    }
  }

  async function selectResult(result: SearchResult): Promise<void> {
    // An async onSelect or navigate leaves a window in which Enter or a click
    // could fire again and navigate twice.
    if (selecting) return;
    selecting = true;
    try {
      if (onSelect && (await onSelect(result)) === false) return;
      const url = buildResultUrl(result);
      // "" means the result URL failed the safe-link check (an executable
      // scheme, or one obfuscated with control characters). Never hand that to
      // the router; leave the dialog open so the selection visibly did nothing.
      if (!url) return;
      if (clearOnNavigate) search.clear();
      open = false;
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

  function handleBackdropClick(event: MouseEvent): void {
    if (!closeOnBackdrop) return;
    if (event.target !== event.currentTarget) return;
    open = false;
  }

  function clearQuery(): void {
    search.clear();
    inputEl?.focus();
  }
</script>

{#if open}
  <div
    class="ss-search ss-search--dialog {className}"
    data-theme={theme}
    data-density={density}
    data-state={search.status}
    {style}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="ss-search__backdrop" onclick={handleBackdropClick}>
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        bind:this={dialogEl}
        class="ss-search__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabindex="-1"
        onkeydown={handleDialogKeydown}
      >
        <div class="ss-search__header">
          <svg class="ss-search__search-icon" viewBox="0 0 20 20" fill="none"
            stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
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
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            aria-expanded="true"
            aria-haspopup="listbox"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
            {placeholder}
            value={search.query}
            oninput={(event) => (search.query = event.currentTarget.value)}
            onkeydown={handleInputKeydown}
            oncompositionstart={() => (composing = true)}
            oncompositionend={() => (composing = false)}
          />

          {#if search.loading}
            <span class="ss-search__spinner" aria-hidden="true"></span>
          {:else if search.query}
            <button type="button" class="ss-search__clear" aria-label="Clear search" onclick={clearQuery}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          {/if}

          <kbd class="ss-search__kbd">Esc</kbd>
        </div>

        <div class="ss-search__body" aria-busy={search.loading}>
          <!-- The listbox always exists so aria-controls always resolves. -->
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
                onclick={() => select(result)}
                onmousemove={() => (activeIndex = index)}
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
              <span class="ss-search__state-description">
                Check your connection and try again.
              </span>
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
          {:else if search.status === "idle" && results.length === 0}
            <div class="ss-search__state ss-search__state--idle">
              <span class="ss-search__state-description">{idleMessage}</span>
            </div>
          {/if}
        </div>

        {#if showFooter}
          <div class="ss-search__footer">
            <span class="ss-search__footer-shortcuts">
              <span class="ss-search__footer-shortcut">
                <kbd class="ss-search__kbd">↑</kbd><kbd class="ss-search__kbd">↓</kbd> Navigate
              </span>
              <span class="ss-search__footer-shortcut">
                <kbd class="ss-search__kbd">↵</kbd> Open
              </span>
              <span class="ss-search__footer-shortcut">
                <kbd class="ss-search__kbd">{shortcutLabel}</kbd> Search
              </span>
            </span>
            <span class="ss-search__count">
              {#if results.length > 0}
                {results.length} {results.length === 1 ? "result" : "results"}
              {/if}
            </span>
          </div>
        {/if}

        <span class="ss-search__sr-only" role="status" aria-live="polite">{statusMessage}</span>
      </div>
    </div>
  </div>
{/if}
