/**
 * SvelteKit scroll-to-text helper for search result navigation.
 *
 * When a visitor arrives on a page via a search result link that contains
 * a `_sskt` (text target) or `_ssk` (section title) query parameter, this
 * hook finds matching text in the document, scrolls it into view, and briefly
 * highlights it.
 *
 * Uses a TreeWalker-based text map to match across split DOM nodes (e.g.
 * `<em>Install</em>ation`), and the CSS Custom Highlight API when available
 * for non-destructive highlighting that avoids DOM mutation.
 *
 * Usage in a SvelteKit layout:
 * ```svelte
 * <script>
 *   import { afterNavigate } from '$app/navigation';
 *   import { searchsocketScrollToText } from 'searchsocket/scroll';
 *   afterNavigate(searchsocketScrollToText);
 * </script>
 * ```
 */

/** Minimal representation of SvelteKit's `AfterNavigate` parameter. */
export interface AfterNavigateParam {
  to: {
    url: URL;
  } | null;
}

/** CSS class applied to the matched element during the highlight flash. */
const HIGHLIGHT_CLASS = "ssk-highlight";

/** Duration in milliseconds for the highlight animation. */
const HIGHLIGHT_DURATION = 2000;

/** Marker attribute used for temporary inline text wrappers. */
const HIGHLIGHT_MARKER_ATTR = "data-ssk-highlight-marker";

/** Name for the CSS Custom Highlight API registry entry. */
const HIGHLIGHT_NAME = "ssk-search-match";

// ---------- Style injection ----------

let styleInjected = false;
function ensureHighlightStyle(): void {
  if (styleInjected || typeof document === "undefined") return;
  styleInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    @keyframes ssk-highlight-fade {
      0%   { background-color: rgba(16, 185, 129, 0.18); }
      100% { background-color: transparent; }
    }
    .${HIGHLIGHT_CLASS} {
      animation: ssk-highlight-fade ${HIGHLIGHT_DURATION}ms ease-out forwards;
      border-radius: 4px;
    }
    ::highlight(${HIGHLIGHT_NAME}) {
      background-color: rgba(16, 185, 129, 0.18);
    }
  `;
  document.head.appendChild(style);
}

// ---------- Text map ----------

interface TextChunk {
  node: Text;
  start: number;
  end: number;
}

interface TextMap {
  text: string;
  chunks: TextChunk[];
}

const IGNORED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

function buildTextMap(root: Node): TextMap {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || IGNORED_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const chunks: TextChunk[] = [];
  let text = "";
  let current: Node | null;

  while ((current = walker.nextNode())) {
    const value = (current as Text).nodeValue ?? "";
    if (!value) continue;
    chunks.push({ node: current as Text, start: text.length, end: text.length + value.length });
    text += value;
  }

  return { text, chunks };
}

// ---------- Matching ----------

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildNeedleRegex(needle: string): RegExp | null {
  const tokenParts = needle.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  if (tokenParts.length > 1) {
    const pattern = tokenParts.map(escapeRegExp).join("[^\\p{L}\\p{N}]+");
    return new RegExp(pattern, "iu");
  }

  if (tokenParts.length === 1) {
    return new RegExp(escapeRegExp(tokenParts[0]!), "iu");
  }

  if (!needle) return null;
  return new RegExp(escapeRegExp(needle).replace(/\s+/g, "\\s+"), "i");
}

function buildLenientRegex(needle: string): RegExp | null {
  const tokenParts = needle.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (tokenParts.length <= 1) return null;
  const pattern = tokenParts.map(escapeRegExp).join("[^\\p{L}\\p{N}]*");
  return new RegExp(pattern, "iu");
}

interface MatchOffsets {
  start: number;
  end: number;
}

/**
 * The first match of `needle` at or after `from` that `accept` allows, in
 * document order. The strict pattern is used when it matches anywhere; the
 * lenient one (zero separators between tokens, for adjacent DOM nodes) only
 * when it does not. Stops at the first accepted match rather than collecting
 * every occurrence on the page.
 */
function findMatch(
  fullText: string,
  needle: string,
  from = 0,
  accept: (match: MatchOffsets) => boolean = () => true
): MatchOffsets | null {
  for (const source of [buildNeedleRegex(needle), buildLenientRegex(needle)]) {
    if (!source) continue;
    const regex = new RegExp(source.source, source.flags.includes("g") ? source.flags : `${source.flags}g`);
    regex.lastIndex = from;
    let first: MatchOffsets | null = null;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(fullText))) {
      if (m[0].length === 0) {
        regex.lastIndex++;
        continue;
      }
      const match = { start: m.index, end: m.index + m[0].length };
      if (accept(match)) return match;
      first ??= match;
    }
    // Nothing acceptable, but the pattern did match: fall back to its first
    // occurrence rather than trying the lenient pattern.
    if (first) return first;
  }
  return null;
}

/**
 * Text inside navigation chrome. A documentation page's "On this page" list
 * repeats every heading ahead of the content, so the first occurrence of a
 * section title in document order is usually a table-of-contents link, not the
 * section.
 */
const NAVIGATION_SELECTOR = 'nav, aside, [role="navigation"]';

/**
 * The text node containing `offset`. Chunks are contiguous and in offset order,
 * so this is a binary search — it runs once per candidate match, and a linear
 * scan made a common phrase on a long page quadratic.
 */
function chunkIndexAt(map: TextMap, offset: number): number {
  let low = 0;
  let high = map.chunks.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const chunk = map.chunks[mid]!;
    if (offset < chunk.start) high = mid - 1;
    else if (offset >= chunk.end) low = mid + 1;
    else return mid;
  }
  return -1;
}

function chunkAt(map: TextMap, offset: number): TextChunk | undefined {
  const index = chunkIndexAt(map, offset);
  return index === -1 ? undefined : map.chunks[index];
}

function isInNavigation(map: TextMap, offset: number): boolean {
  return Boolean(chunkAt(map, offset)?.node.parentElement?.closest(NAVIGATION_SELECTOR));
}

/**
 * Text offset of the first heading whose text is the section title, skipping
 * headings inside navigation chrome.
 */
function findHeadingOffset(map: TextMap, sectionTitle: string): number | null {
  const wanted = normalize(sectionTitle);
  for (const heading of Array.from(document.body.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
    if (heading.closest(NAVIGATION_SELECTOR)) continue;
    if (normalize(heading.textContent ?? "") !== wanted) continue;
    const first = map.chunks.find((chunk) => heading.contains(chunk.node));
    if (first) return first.start;
  }
  return null;
}

// ---------- Range resolution ----------

function resolveRange(map: TextMap, offsets: MatchOffsets): Range | null {
  const startChunk = chunkAt(map, offsets.start);
  // The chunk holding the last matched character, i.e. end is in (start, end].
  const endChunk = offsets.end > 0 ? chunkAt(map, offsets.end - 1) : undefined;

  if (!startChunk || !endChunk) return null;

  const range = document.createRange();
  range.setStart(startChunk.node, offsets.start - startChunk.start);
  range.setEnd(endChunk.node, offsets.end - endChunk.start);
  return range;
}

// ---------- Highlighting ----------

function hasCustomHighlightAPI(): boolean {
  return typeof CSS !== "undefined" && typeof (CSS as any).highlights !== "undefined";
}

let highlightTimer: ReturnType<typeof setTimeout> | null = null;

function highlightWithCSS(range: Range): void {
  ensureHighlightStyle();
  const hl = new (globalThis as any).Highlight(range);
  (CSS as any).highlights.set(HIGHLIGHT_NAME, hl);

  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    (CSS as any).highlights.delete(HIGHLIGHT_NAME);
    highlightTimer = null;
  }, HIGHLIGHT_DURATION);
}

function unwrapMarker(marker: HTMLElement): void {
  if (!marker.isConnected) return;
  const parent = marker.parentNode;
  if (!parent) return;
  while (marker.firstChild) parent.insertBefore(marker.firstChild, marker);
  parent.removeChild(marker);
  if (parent instanceof Element) parent.normalize();
}

function highlightWithDOM(range: Range): Element {
  ensureHighlightStyle();
  try {
    const marker = document.createElement("span");
    marker.classList.add(HIGHLIGHT_CLASS);
    marker.setAttribute(HIGHLIGHT_MARKER_ATTR, "true");
    range.surroundContents(marker);
    setTimeout(() => unwrapMarker(marker), HIGHLIGHT_DURATION);
    return marker;
  } catch {
    // surroundContents fails on cross-element ranges — highlight the ancestor
    const ancestor = range.commonAncestorContainer;
    const el = ancestor instanceof Element ? ancestor : ancestor.parentElement;
    if (el) {
      el.classList.add(HIGHLIGHT_CLASS);
      setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_DURATION);
      return el;
    }
    return document.body;
  }
}

// ---------- Scrolling ----------

function scrollToRange(range: Range): void {
  const rect = range.getBoundingClientRect();
  window.scrollTo({
    top: window.scrollY + rect.top - window.innerHeight / 3,
    behavior: "smooth"
  });
}

function scrollIntoViewIfPossible(el: Element): void {
  if (typeof (el as any).scrollIntoView === "function") {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// ---------- Main ----------

/**
 * A function compatible with SvelteKit's `afterNavigate` callback.
 *
 * Reads `_sskt` (preferred, falling back to `_ssk` when it does not match) from
 * the destination URL, walks text nodes in document order via a TreeWalker text
 * map, and scrolls/highlights the match. When a heading on the page matches
 * `_ssk`, the first match at or after that heading is used; otherwise the first
 * match outside `nav`/`aside` chrome. Matches can span multiple DOM text nodes.
 *
 * Uses the CSS Custom Highlight API when available for non-destructive
 * highlighting, with a DOM mutation fallback for older browsers.
 *
 * Silent no-op when no target parameter is present or no match is found.
 */
export function searchsocketScrollToText(navigation: AfterNavigateParam): void {
  if (typeof document === "undefined") return;

  const params = navigation.to?.url.searchParams;
  const sectionTitle = params?.get("_ssk") ?? "";
  // The text target is tried first and the section heading second. A text
  // target is only a phrase lifted from a search snippet, and a snippet is not
  // guaranteed to be verbatim page text — markdown punctuation is flattened,
  // and older indexes excerpted a synthetic "Title — Section" prefix no page
  // contains. The heading is still a reliable landmark when the phrase misses.
  const needles = [params?.get("_sskt"), params?.get("_ssk")]
    .map((value) => (value ? normalize(value) : ""))
    .filter((value, index, all) => value !== "" && all.indexOf(value) === index);
  if (needles.length === 0) return;

  const map = buildTextMap(document.body);
  // When the section heading is on the page, the target is the occurrence at or
  // after it: a phrase that also appears earlier (in a table of contents, an
  // intro, a previous section) belongs to that section. Without an anchor, the
  // first match outside navigation chrome wins, then the first match at all.
  const anchor = sectionTitle.trim() ? findHeadingOffset(map, sectionTitle) : null;
  let offsets: MatchOffsets | null = null;
  if (anchor !== null) {
    for (const needle of needles) {
      offsets = findMatch(map.text, needle, anchor);
      if (offsets) break;
    }
  }
  if (!offsets) {
    for (const needle of needles) {
      offsets = findMatch(map.text, needle, 0, (match) => !isInNavigation(map, match.start));
      if (offsets) break;
    }
  }
  if (!offsets) return;

  const range = resolveRange(map, offsets);
  if (!range) return;

  if (hasCustomHighlightAPI()) {
    highlightWithCSS(range);
    scrollToRange(range);
  } else {
    const marker = highlightWithDOM(range);
    const target =
      typeof (marker as any).scrollIntoView === "function" ? marker : marker.parentElement;
    if (target) scrollIntoViewIfPossible(target);
  }
}
