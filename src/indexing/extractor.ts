import { load, type CheerioAPI } from "cheerio";
import matter from "gray-matter";
import TurndownService from "turndown";
import { gfm, highlightedCodeBlock, strikethrough, tables, taskListItems } from "turndown-plugin-gfm";
import type { ExtractedPage, OutgoingLink, ResolvedSearchSocketConfig } from "../types";
import { normalizeMarkdown, normalizeText } from "../utils/text";
import { normalizeUrlPath } from "../utils/path";
import { validateMetaKey, parseMetaValue } from "../utils/structured-meta";
import type { StoredPageMeta } from "../utils/structured-meta";

export function normalizeDateToMs(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isFinite(ts) ? ts : undefined;
  }
  if (typeof value === "string") {
    const ts = new Date(value).getTime();
    return Number.isFinite(ts) ? ts : undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

const FRONTMATTER_DATE_FIELDS = ["date", "publishedAt", "updatedAt", "published_at", "updated_at"] as const;

export function extractPublishedAtFromFrontmatter(data: Record<string, unknown>): number | undefined {
  for (const field of FRONTMATTER_DATE_FIELDS) {
    const val = normalizeDateToMs(data[field]);
    if (val !== undefined) return val;
  }
  return undefined;
}

export function extractPublishedAtFromHtml($: CheerioAPI): number | undefined {
  // 1. JSON-LD
  const jsonLdScripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < jsonLdScripts.length; i++) {
    try {
      const raw = $(jsonLdScripts[i]).html();
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Handle top-level object, arrays, and @graph patterns
      const candidates: Record<string, unknown>[] = [];
      if (Array.isArray(parsed)) {
        candidates.push(...(parsed as Record<string, unknown>[]));
      } else if (parsed && typeof parsed === "object") {
        candidates.push(parsed);
        if (Array.isArray((parsed as Record<string, unknown>)["@graph"])) {
          candidates.push(...((parsed as Record<string, unknown>)["@graph"] as Record<string, unknown>[]));
        }
      }
      for (const candidate of candidates) {
        const val = normalizeDateToMs(candidate.datePublished);
        if (val !== undefined) return val;
      }
    } catch {
      // malformed JSON-LD — fall through
    }
  }

  // 2. Open Graph article:published_time
  const ogTime = $('meta[property="article:published_time"]').attr("content")?.trim();
  if (ogTime) {
    const val = normalizeDateToMs(ogTime);
    if (val !== undefined) return val;
  }

  // 3. Schema.org itemprop
  const itempropDate = $('meta[itemprop="datePublished"]').attr("content")?.trim()
    || $('time[itemprop="datePublished"]').attr("datetime")?.trim();
  if (itempropDate) {
    const val = normalizeDateToMs(itempropDate);
    if (val !== undefined) return val;
  }

  // 4. <time datetime> fallback
  const timeEl = $("time[datetime]").first().attr("datetime")?.trim();
  if (timeEl) {
    const val = normalizeDateToMs(timeEl);
    if (val !== undefined) return val;
  }

  return undefined;
}

function hasTopLevelNoindexComment(markdown: string): boolean {
  const lines = markdown.split(/\r?\n/);
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }

    if (!inFence && /<!--\s*noindex\s*-->/i.test(line)) {
      return true;
    }
  }

  return false;
}

const GARBAGE_ALT_WORDS = new Set([
  "image", "photo", "picture", "icon", "logo", "banner",
  "screenshot", "thumbnail", "img", "graphic", "illustration",
  "spacer", "pixel", "placeholder", "avatar", "background"
]);

const IMAGE_EXT_RE = /\.(jpg|jpeg|png|gif|svg|webp|avif|bmp|ico)(\?.*)?$/i;

function isMeaningfulAlt(alt: string): boolean {
  const trimmed = alt.trim();
  if (!trimmed || trimmed.length < 5) return false;
  if (IMAGE_EXT_RE.test(trimmed)) return false;
  if (GARBAGE_ALT_WORDS.has(trimmed.toLowerCase())) return false;
  return true;
}

function resolveImageText(
  img: ReturnType<CheerioAPI>,
  $: CheerioAPI,
  imageDescAttr: string
): string | null {
  // Priority 1: data-search-description on the img itself
  const imgDesc = img.attr(imageDescAttr)?.trim();
  if (imgDesc) return imgDesc;

  // Priority 2: data-search-description on the closest <figure>
  const figure = img.closest("figure");
  if (figure.length) {
    const figDesc = figure.attr(imageDescAttr)?.trim();
    if (figDesc) return figDesc;
  }

  const alt = img.attr("alt")?.trim() ?? "";
  const caption = figure.length
    ? figure.find("figcaption").first().text().trim()
    : "";

  // Priority 3: meaningful alt + figcaption
  if (isMeaningfulAlt(alt) && caption) {
    return `${alt} — ${caption}`;
  }

  // Priority 4: meaningful alt alone
  if (isMeaningfulAlt(alt)) {
    return alt;
  }

  // Priority 5: figcaption alone (no meaningful alt)
  if (caption) {
    return caption;
  }

  // No useful text — remove
  return null;
}

const STOP_ANCHORS = new Set([
  "here", "click", "click here", "read more", "link", "this", "more"
]);

export function normalizeAnchorText(raw: string): string {
  const normalized = raw.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized.length < 3) return "";
  if (STOP_ANCHORS.has(normalized)) return "";
  if (normalized.length > 100) return normalized.slice(0, 100);
  return normalized;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function preprocessImages(
  root: ReturnType<CheerioAPI>,
  $: CheerioAPI,
  imageDescAttr: string
): void {
  // Pass 1: <picture> elements — process inner <img>, replace whole <picture>
  root.find("picture").each((_i, el) => {
    const picture = $(el);
    const img = picture.find("img").first();
    const parentFigure = picture.closest("figure");
    const text = img.length ? resolveImageText(img, $, imageDescAttr) : null;
    if (text) {
      if (parentFigure.length) parentFigure.find("figcaption").remove();
      picture.replaceWith(`<span>${escapeHtml(text)}</span>`);
    } else {
      picture.remove();
    }
  });

  // Pass 2: bare <img> elements (not already removed with <picture>)
  root.find("img").each((_i, el) => {
    const img = $(el);
    const parentFigure = img.closest("figure");
    const text = resolveImageText(img, $, imageDescAttr);
    if (text) {
      if (parentFigure.length) parentFigure.find("figcaption").remove();
      img.replaceWith(`<span>${escapeHtml(text)}</span>`);
    } else {
      img.remove();
    }
  });
}

/**
 * Why a page was deliberately kept out of the index.
 * Exclusions are authoritative removal signals: in a complete run the page
 * genuinely should not be there, so deleting its old records is correct.
 */
/**
 * Origin used to resolve relative hrefs. Any href resolving to it came from a
 * relative or root-relative link and is therefore same-site by construction.
 */
const SYNTHETIC_ORIGIN = "https://searchsocket.local";

/**
 * - `noindex` / `zero-weight`: the author asked for the page to be absent.
 * - `ignored`: the whole content root carries the ignore attribute.
 * - `redirect`: a prerendered redirect stub — a meta refresh with no content.
 */
export type ExclusionReason = "noindex" | "zero-weight" | "ignored" | "redirect";

/**
 * The target of a `<meta http-equiv="refresh" content="N; url=…">`, or null
 * when the document has none. A refresh without a URL reloads the same page and
 * is not a redirect, so it does not count.
 */
function findMetaRefreshTarget($: CheerioAPI): string | null {
  let target: string | null = null;
  $("meta[http-equiv]").each((_i, el) => {
    if (target !== null) return;
    if (($(el).attr("http-equiv") ?? "").trim().toLowerCase() !== "refresh") return;
    const content = $(el).attr("content") ?? "";
    const match = /^\s*\d*(?:\.\d*)?\s*[;,]?\s*url\s*=\s*['"]?([^'"\s]+)/i.exec(content);
    if (match?.[1]) target = match[1];
  });
  return target;
}

/**
 * Why extraction could not produce a page.
 * Failures are NOT removal signals — a selector regression or malformed input
 * must never be mistaken for "the author deleted this page", or one bad
 * `mainSelector` change would wipe the entire index.
 */
export interface ExtractionFailure {
  reason: "empty-content";
  detail: string;
}

/**
 * Why a document was passed over without saying anything about its URL.
 *
 * - `self-redirect`: a redirect stub whose target is the page's own URL once
 *   normalized — `docs.html` redirecting to `/docs/`, whose content lives in
 *   `docs/index.html`. Both files map to `/docs`, so reading the stub as an
 *   exclusion of `/docs` would delete the live page it points at. It is not a
 *   failure either: a site that emits such a stub on every build would
 *   otherwise never be allowed to prune.
 */
export type SkipReason = "self-redirect";

export type ExtractionResult =
  | { status: "indexed"; page: ExtractedPage }
  | { status: "excluded"; reason: ExclusionReason; detail?: string }
  | { status: "skipped"; reason: SkipReason; detail?: string }
  | { status: "failed"; error: ExtractionFailure };

/**
 * Tags whose text is never page content, so a document holding nothing else
 * has no meaningful body.
 */
const NON_CONTENT_TAGS = "script, style, noscript, template";

/**
 * Whether the ORIGINAL document, before any configured drop or ignore rule,
 * carries body text.
 *
 * A redirect stub is recognised from this rather than from the extraction
 * result. Deciding it after `dropSelectors` had run meant a selector mistake
 * that emptied a real page carrying `<meta http-equiv="refresh" content="60;url=/next">`
 * turned an extraction failure — which protects the index — into a redirect
 * exclusion that deleted the page.
 */
function documentHasBodyText($: CheerioAPI): boolean {
  const body = $("body").first().clone();
  body.find(NON_CONTENT_TAGS).remove();
  return normalizeText(body.text() || "").length > 0;
}

/**
 * The normalized same-site path a redirect target resolves to, or null when it
 * leaves the site or cannot be parsed. Relative targets resolve against the
 * page's own URL, as a browser would.
 */
function resolveInternalRedirectPath(
  target: string,
  pageBaseUrl: URL,
  internalOrigins: Set<string>
): string | null {
  try {
    const resolved = new URL(target, pageBaseUrl);
    if (!internalOrigins.has(resolved.origin)) return null;
    return normalizeUrlPath(resolved.pathname);
  } catch {
    return null;
  }
}

export function extractFromHtmlResult(
  url: string,
  html: string,
  config: ResolvedSearchSocketConfig
): ExtractionResult {
  const $ = load(html);
  const normalizedUrl = normalizeUrlPath(url);
  const pageBaseUrl = new URL(`${SYNTHETIC_ORIGIN}${normalizedUrl}`);

  // Origins that count as "this site". A relative or root-relative href
  // resolves against the synthetic origin; an absolute href must match the
  // configured base URL to be treated as internal.
  const internalOrigins = new Set<string>([SYNTHETIC_ORIGIN]);
  if (config.project.baseUrl) {
    try {
      internalOrigins.add(new URL(config.project.baseUrl).origin);
    } catch {
      // A malformed baseUrl simply contributes no extra origin.
    }
  }

  if (config.extract.respectRobotsNoindex) {
    const robots = $("meta[name='robots']").attr("content") ?? "";
    if (/\bnoindex\b/i.test(robots)) {
      return { status: "excluded", reason: "noindex" };
    }
  }

  if ($(`[${config.extract.noindexAttr}]`).length > 0) {
    return { status: "excluded", reason: "noindex" };
  }

  // Read per-page search weight from <meta name="searchsocket-weight" content="...">
  const weightRaw = $("meta[name='searchsocket-weight']").attr("content")?.trim();
  let weight: number | undefined;
  if (weightRaw !== undefined) {
    const parsed = Number(weightRaw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      weight = parsed;
    }
  }

  // If weight is 0, skip indexing entirely — save extraction/chunking/embedding cost
  if (weight === 0) {
    return { status: "excluded", reason: "zero-weight" };
  }

  // Check for searchsocket:noindex meta tag (emitted by <SearchSocket noindex />)
  if ($('meta[name="searchsocket:noindex"]').attr("content") === "true") {
    return { status: "excluded", reason: "noindex" };
  }

  // Reserved searchsocket: meta names that are not user metadata
  const RESERVED_META_KEYS = new Set(["noindex", "tags"]);

  // Read structured metadata from <meta name="searchsocket:KEY" content="VALUE" data-type="TYPE">
  const meta: StoredPageMeta = {};
  $('meta[name^="searchsocket:"]').each((_i, el) => {
    const name = $(el).attr("name") ?? "";
    const key = name.slice("searchsocket:".length);
    if (!key || RESERVED_META_KEYS.has(key) || !validateMetaKey(key)) return;
    const content = $(el).attr("content") ?? "";
    const dataType = $(el).attr("data-type") ?? "string";
    meta[key] = parseMetaValue(content, dataType);
  });

  // Read tags from searchsocket:tags meta tag (emitted by <SearchSocket tags={[...]} />)
  const componentTags = $('meta[name="searchsocket:tags"]').attr("content")?.trim();

  const description =
    $("meta[name='description']").attr("content")?.trim() ||
    $("meta[property='og:description']").attr("content")?.trim() ||
    undefined;

  const keywordsRaw = $("meta[name='keywords']").attr("content")?.trim();
  const keywords = keywordsRaw
    ? keywordsRaw.split(",").map((k) => k.trim()).filter(Boolean)
    : undefined;

  const mainMatched = $(config.extract.mainSelector).first().length > 0;
  const root = mainMatched
    ? $(config.extract.mainSelector).first().clone()
    : $("body").first().clone();

  // Author markup on the content root itself. `find()` only searches
  // descendants, so `<main data-search-ignore>` used to keep every word of the
  // region its author asked to be ignored. Ignoring the whole content root is a
  // deliberate statement that the page has nothing to index — an exclusion, not
  // a failure that would make the run non-authoritative.
  if (root.is(`[${config.extract.ignoreAttr}]`)) {
    return { status: "excluded", reason: "ignored" };
  }

  // Drops that match the root itself empty it: that is a selector
  // misconfiguration, and the empty-content failure below reports it as one.
  const dropsRoot =
    config.extract.dropTags.some((tagName) => root.is(tagName)) ||
    config.extract.dropSelectors.some((selector) => root.is(selector));
  if (dropsRoot) {
    root.empty();
  }

  for (const tagName of config.extract.dropTags) {
    root.find(tagName).remove();
  }

  for (const selector of config.extract.dropSelectors) {
    root.find(selector).remove();
  }

  root.find(`[${config.extract.ignoreAttr}]`).remove();

  // Derived only now, from the cleaned root. Reading the `h1` before the drops
  // ran made a heading inside a dropSelectors/ignore region the page's public
  // title. Taken before image preprocessing so alt text replacing an `<img>`
  // inside the heading does not leak into it — the same text the heading had.
  // Only a matched mainSelector supplies a heading, as before: the body
  // fallback would otherwise promote any stray `h1` in site chrome.
  const title =
    $("meta[property='og:title']").attr("content")?.trim() ||
    (mainMatched ? normalizeText(root.find("h1").first().text() || "") : "") ||
    $("meta[name='twitter:title']").attr("content")?.trim() ||
    normalizeText($("title").first().text() || "") ||
    normalizedUrl;

  // Replace <img> elements with descriptive text before Turndown
  preprocessImages(root, $, config.extract.imageDescAttr);

  const outgoingLinks: OutgoingLink[] = [];
  const seenLinkKeys = new Set<string>();
  root.find("a[href]").each((_index, node) => {
    const href = $(node).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      return;
    }

    try {
      const parsed = new URL(href, pageBaseUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return;
      }

      // Only the pathname used to be kept, so `https://other.example/docs`
      // was recorded as an internal link to the local `/docs` — inflating its
      // incoming-link count and its ranking with someone else's links.
      if (!internalOrigins.has(parsed.origin)) {
        return;
      }

      const url = normalizeUrlPath(parsed.pathname);
      let anchorText = normalizeAnchorText($(node).text());
      if (!anchorText) {
        const imgAlt = $(node).find("img").first().attr("alt") ?? "";
        if (isMeaningfulAlt(imgAlt)) {
          anchorText = normalizeAnchorText(imgAlt);
        }
      }

      const key = `${url}|${anchorText}`;
      if (!seenLinkKeys.has(key)) {
        seenLinkKeys.add(key);
        outgoingLinks.push({ url, anchorText });
      }
    } catch {
      // ignore malformed links
    }
  });

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced"
  });

  if (config.transform.preserveCodeBlocks && config.transform.preserveTables) {
    turndown.use(gfm);
  } else {
    // Always apply strikethrough and task list items
    turndown.use(strikethrough);
    turndown.use(taskListItems);

    if (config.transform.preserveTables) {
      turndown.use(tables);
    }
    if (config.transform.preserveCodeBlocks) {
      turndown.use(highlightedCodeBlock);
    }
  }

  const markdown = normalizeMarkdown(turndown.turndown(root.html() ?? ""));

  if (!normalizeText(markdown)) {
    // A prerendered redirect has no content by design. SvelteKit writes a
    // `redirect()` from a prerendered route as exactly
    // `<script>location.href="…";</script><meta http-equiv="refresh" content="0;url=…">`,
    // and treating that as a failed extraction made one redirect route disable
    // stale-record pruning for the whole site. Recognised only here — after
    // extraction produced nothing — so a real page that merely carries a meta
    // refresh alongside its content is still indexed as a page.
    //
    // Stub-ness is judged on the original document, independently of the
    // extraction config: only a document with no body text at all is a stub.
    // A page that became empty because a drop rule removed its content is a
    // failed extraction whatever meta refresh it carries.
    const redirectTarget = findMetaRefreshTarget($);
    if (redirectTarget !== null && !documentHasBodyText($)) {
      const detail = `redirects to ${redirectTarget}`;
      const targetPath = resolveInternalRedirectPath(redirectTarget, pageBaseUrl, internalOrigins);
      if (targetPath === normalizedUrl) {
        return { status: "skipped", reason: "self-redirect", detail };
      }
      return { status: "excluded", reason: "redirect", detail };
    }

    // Not an exclusion: the page exists but nothing survived extraction.
    // Most often a mainSelector/dropSelectors regression.
    return {
      status: "failed",
      error: {
        reason: "empty-content",
        detail: `no text extracted using mainSelector "${config.extract.mainSelector}"`
      }
    };
  }

  const tags = normalizeUrlPath(url)
    .split("/")
    .filter(Boolean)
    .slice(0, 1);

  const publishedAt = extractPublishedAtFromHtml($);

  // Merge tags from searchsocket:tags meta tag
  if (componentTags) {
    const extraTags = componentTags.split(",").map((t) => t.trim()).filter(Boolean);
    for (const t of extraTags) {
      if (!tags.includes(t)) tags.push(t);
    }
  }

  return {
    status: "indexed",
    page: {
      url: normalizeUrlPath(url),
      title,
      markdown,
      outgoingLinks,
      noindex: false,
      tags,
      description,
      keywords,
      weight,
      publishedAt,
      meta: Object.keys(meta).length > 0 ? meta : undefined
    }
  };
}

/**
 * Convenience wrapper collapsing every non-indexed outcome to `null`.
 * The pipeline must use {@link extractFromHtmlResult} instead — it needs to
 * tell an intentional exclusion apart from a failure before deciding whether
 * stale records may be deleted.
 */
export function extractFromHtml(
  url: string,
  html: string,
  config: ResolvedSearchSocketConfig
): ExtractedPage | null {
  const result = extractFromHtmlResult(url, html, config);
  return result.status === "indexed" ? result.page : null;
}

export function extractFromMarkdownResult(url: string, markdown: string, title?: string): ExtractionResult {
  // Check for <!-- noindex --> comments outside fenced code blocks.
  if (hasTopLevelNoindexComment(markdown)) {
    return { status: "excluded", reason: "noindex" };
  }

  // Parse frontmatter and check for noindex flag
  const parsed = matter(markdown);
  const frontmatter = parsed.data as Record<string, unknown>;

  const searchsocketMeta = frontmatter.searchsocket as Record<string, unknown> | undefined;
  if (frontmatter.noindex === true || searchsocketMeta?.noindex === true) {
    return { status: "excluded", reason: "noindex" };
  }

  // Read per-page weight from frontmatter: searchsocket.weight or weight
  let mdWeight: number | undefined;
  const rawWeight = searchsocketMeta?.weight ?? frontmatter.searchsocketWeight;
  if (typeof rawWeight === "number" && Number.isFinite(rawWeight) && rawWeight >= 0) {
    mdWeight = rawWeight;
  }
  if (mdWeight === 0) {
    return { status: "excluded", reason: "zero-weight" };
  }

  // Read structured metadata from searchsocket.meta in frontmatter
  let mdMeta: StoredPageMeta | undefined;
  const rawMeta = searchsocketMeta?.meta;
  if (rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)) {
    const metaObj: StoredPageMeta = {};
    for (const [key, val] of Object.entries(rawMeta as Record<string, unknown>)) {
      if (!validateMetaKey(key)) continue;
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
        metaObj[key] = val;
      } else if (Array.isArray(val) && val.every((v) => typeof v === "string")) {
        metaObj[key] = val as string[];
      } else if (val instanceof Date) {
        metaObj[key] = val.getTime();
      }
    }
    if (Object.keys(metaObj).length > 0) {
      mdMeta = metaObj;
    }
  }

  const content = parsed.content;
  const normalized = normalizeMarkdown(content);
  if (!normalizeText(normalized)) {
    return {
      status: "failed",
      error: { reason: "empty-content", detail: "markdown body is empty after normalization" }
    };
  }

  const resolvedTitle = title ?? (typeof frontmatter.title === "string" ? frontmatter.title : undefined) ?? normalizeUrlPath(url);

  const fmDescription = typeof frontmatter.description === "string" ? frontmatter.description.trim() || undefined : undefined;
  let fmKeywords: string[] | undefined;
  if (Array.isArray(frontmatter.keywords)) {
    fmKeywords = frontmatter.keywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim());
  } else if (typeof frontmatter.keywords === "string" && frontmatter.keywords.trim()) {
    fmKeywords = frontmatter.keywords.split(",").map((k) => k.trim()).filter(Boolean);
  }
  if (fmKeywords && fmKeywords.length === 0) fmKeywords = undefined;

  const publishedAt = extractPublishedAtFromFrontmatter(frontmatter);

  return {
    status: "indexed",
    page: {
      url: normalizeUrlPath(url),
      title: resolvedTitle,
      markdown: normalized,
      outgoingLinks: [],
      noindex: false,
      tags: normalizeUrlPath(url)
        .split("/")
        .filter(Boolean)
        .slice(0, 1),
      description: fmDescription,
      keywords: fmKeywords,
      weight: mdWeight,
      publishedAt,
      meta: mdMeta
    }
  };
}

/**
 * Convenience wrapper collapsing every non-indexed outcome to `null`.
 * The pipeline must use {@link extractFromMarkdownResult} instead — it needs to
 * tell an intentional exclusion apart from a failure before deciding whether
 * stale records may be deleted.
 */
export function extractFromMarkdown(url: string, markdown: string, title?: string): ExtractedPage | null {
  const result = extractFromMarkdownResult(url, markdown, title);
  return result.status === "indexed" ? result.page : null;
}
