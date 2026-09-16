import type { Chunk, IndexedPage, ResolvedSearchSocketConfig, Scope } from "../types";
import { sha1, sha256 } from "../utils/hash";
import { humanizeUrlPath } from "../utils/path";
import { extractFirstParagraph, normalizeText, toSnippet } from "../utils/text";
import { chunkIdentityBase, chunkLogicalKey } from "../vector/ids";

interface Section {
  sectionTitle?: string;
  headingLevel?: number;
  headingPath: string[];
  text: string;
}

const FENCE_LINE_RE = /^(```|~~~)/;

function parseHeadingSections(markdown: string, headingPathDepth: number): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];

  const headingStack: Array<string | undefined> = [];
  let inFence = false;

  let current: Section = {
    sectionTitle: undefined,
    headingPath: [],
    text: ""
  };

  const flush = (): void => {
    if (normalizeText(current.text)) {
      sections.push({
        sectionTitle: current.sectionTitle,
        headingLevel: current.headingLevel,
        headingPath: current.headingPath,
        text: current.text.trim()
      });
    }
  };

  for (const line of lines) {
    if (FENCE_LINE_RE.test(line.trim())) {
      inFence = !inFence;
    }

    const headingMatch = !inFence ? line.match(/^(#{1,6})\s+(.+)$/) : null;
    if (headingMatch) {
      flush();

      const level = (headingMatch[1] ?? "#").length;
      const title = (headingMatch[2] ?? "").trim();
      headingStack[level - 1] = title;
      headingStack.length = level;

      current = {
        sectionTitle: title,
        headingLevel: level,
        headingPath: headingStack.filter((entry): entry is string => Boolean(entry)).slice(0, headingPathDepth),
        text: `${line}\n`
      };
      continue;
    }

    current.text += `${line}\n`;
  }

  flush();

  if (sections.length === 0 && normalizeText(markdown)) {
    sections.push({
      sectionTitle: undefined,
      headingPath: [],
      text: markdown.trim()
    });
  }

  return sections;
}

function blockify(text: string, config: ResolvedSearchSocketConfig["chunking"]): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];

  let inFence = false;
  let current: string[] = [];

  const flush = (): void => {
    const value = current.join("\n").trim();
    if (value) {
      blocks.push(value);
    }
    current = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (FENCE_LINE_RE.test(trimmed)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }

    if (inFence) {
      current.push(line);
      continue;
    }

    const isTableLine = /^\|.*\|$/.test(trimmed) || /^\|?\s*:?-+:?\s*\|/.test(trimmed);
    const isQuoteLine = /^>/.test(trimmed);

    if (isTableLine && config.dontSplitInside.includes("table")) {
      current.push(line);
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (!next || !/^\|/.test(next.trim())) {
          break;
        }
        i += 1;
        current.push(lines[i] ?? "");
      }
      continue;
    }

    if (isQuoteLine && config.dontSplitInside.includes("blockquote")) {
      current.push(line);
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (!next || !/^>/.test(next.trim())) {
          break;
        }
        i += 1;
        current.push(lines[i] ?? "");
      }
      continue;
    }

    if (!trimmed) {
      flush();
      continue;
    }

    current.push(line);
  }

  flush();
  return blocks;
}

function isProtectedBlock(block: string, config: ResolvedSearchSocketConfig["chunking"]): boolean {
  const lines = block.trim().split("\n");
  const first = (lines[0] ?? "").trim();
  const last = (lines[lines.length - 1] ?? "").trim();

  const isCodeBlock = FENCE_LINE_RE.test(first) && FENCE_LINE_RE.test(last);
  if (isCodeBlock && config.dontSplitInside.includes("code")) {
    return true;
  }

  const isTableBlock = lines.every((line) => {
    const trimmed = line.trim();
    return trimmed.length === 0 || /^\|.*\|$/.test(trimmed) || /^\|?\s*:?-+:?\s*\|/.test(trimmed);
  });
  if (isTableBlock && config.dontSplitInside.includes("table")) {
    return true;
  }

  const isQuoteBlock = lines.every((line) => {
    const trimmed = line.trim();
    return trimmed.length === 0 || trimmed.startsWith(">");
  });
  return isQuoteBlock && config.dontSplitInside.includes("blockquote");
}

function splitOversizedBlock(block: string, config: ResolvedSearchSocketConfig["chunking"]): string[] {
  const trimmed = block.trim();
  if (trimmed.length <= config.maxChars || isProtectedBlock(trimmed, config)) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < trimmed.length) {
    let end = Math.min(start + config.maxChars, trimmed.length);

    if (end < trimmed.length) {
      const boundary = trimmed.lastIndexOf(" ", end);
      if (boundary > start + Math.floor(config.maxChars * 0.6)) {
        end = boundary;
      }
    }

    const chunk = trimmed.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= trimmed.length) {
      break;
    }

    const nextStart = Math.max(0, end - config.overlapChars);
    start = nextStart > start ? nextStart : end;
  }

  return chunks.length > 0 ? chunks : [trimmed];
}

function splitSection(section: Section, config: ResolvedSearchSocketConfig["chunking"]): Array<Pick<Chunk, "sectionTitle" | "headingLevel" | "headingPath" | "chunkText">> {
  const text = section.text.trim();
  if (!text) {
    return [];
  }

  if (text.length <= config.maxChars) {
    return [
      {
        sectionTitle: section.sectionTitle,
        headingLevel: section.headingLevel,
        headingPath: section.headingPath,
        chunkText: text
      }
    ];
  }

  const blocks = blockify(text, config);
  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    const pieces = splitOversizedBlock(block, config);

    for (const piece of pieces) {
      if (!current) {
        current = piece;
        continue;
      }

      const candidate = `${current}\n\n${piece}`;
      if (candidate.length <= config.maxChars) {
        current = candidate;
        continue;
      }

      chunks.push(current);

      const overlap = current.slice(Math.max(0, current.length - config.overlapChars)).trim();
      const withOverlap = overlap ? `${overlap}\n\n${piece}` : piece;
      current = withOverlap.length <= config.maxChars ? withOverlap : piece;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  const merged: string[] = [];
  for (const chunk of chunks) {
    if (merged.length === 0) {
      merged.push(chunk);
      continue;
    }

    const canMerge =
      chunk.length < config.minChars &&
      merged[merged.length - 1] !== undefined &&
      (merged[merged.length - 1]?.length ?? 0) + 2 + chunk.length <= config.maxChars;

    if (canMerge) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}\n\n${chunk}`;
    } else {
      merged.push(chunk);
    }
  }

  return merged.map((chunkText) => ({
    sectionTitle: section.sectionTitle,
    headingLevel: section.headingLevel,
    headingPath: section.headingPath,
    chunkText
  }));
}

export function buildSummaryChunkText(page: IndexedPage): string {
  const parts: string[] = [page.title];

  const humanized = humanizeUrlPath(page.url);
  if (humanized) parts.push(humanized);

  const body = page.description ?? extractFirstParagraph(page.markdown);
  if (body) parts.push(body);

  if (page.keywords && page.keywords.length > 0) {
    parts.push(page.keywords.join(", "));
  }

  return parts.join("\n\n");
}

/** Marker mixed into a chunk's hash so provenance changes invalidate it. */
function provenanceTag(page: { custom?: boolean }): string {
  return page.custom ? "|custom" : "|site";
}

/**
 * Fingerprint of everything that decides the *embedding* of a chunk.
 *
 * Deliberately kept byte-identical to the hash this module has always written,
 * so upgrading does not re-embed an index that has not actually changed. It
 * covers the normalized embedding text, the structured meta block, and
 * provenance — the last because provenance is persisted and decides whether a
 * site-only run may delete the record, so a page moving between
 * custom-supplied and site-owned must re-upsert even when its text is
 * identical.
 *
 * Everything else that is persisted is covered by the *metadata* fingerprint
 * the pipeline computes from the final payload; see buildChunkMetadataHash().
 * The split is what lets a tag edit refresh metadata without paying to
 * re-embed unchanged prose.
 *
 * Takes a Chunk rather than a page so it can be recomputed after
 * `transformChunk`/`beforeIndex` have had their say: hooks may rewrite the very
 * text that is embedded, and a hash taken before they run describes a payload
 * that is never stored.
 */
export function buildChunkEmbeddingHash(chunk: Chunk, prependTitle: boolean): string {
  const embeddingText = buildEmbeddingText(chunk, prependTitle);
  const metaSuffix = chunk.meta ? JSON.stringify(chunk.meta, Object.keys(chunk.meta).sort()) : "";
  return sha256(normalizeText(embeddingText) + metaSuffix + provenanceTag(chunk));
}

export function buildEmbeddingTitle(chunk: Chunk): string | undefined {
  if (!chunk.sectionTitle || chunk.headingLevel === undefined) return undefined;

  if (chunk.headingPath.length > 1) {
    const path = chunk.headingPath.join(" > ");
    const lastInPath = chunk.headingPath[chunk.headingPath.length - 1];
    if (lastInPath !== chunk.sectionTitle) {
      return `${chunk.title} — ${path} > ${chunk.sectionTitle}`;
    }
    return `${chunk.title} — ${path}`;
  }

  return `${chunk.title} — ${chunk.sectionTitle}`;
}

export function buildEmbeddingText(chunk: Chunk, prependTitle: boolean): string {
  if (!prependTitle) return chunk.chunkText;
  const prefix = chunk.sectionTitle
    ? `${chunk.title} — ${chunk.sectionTitle}`
    : chunk.title;
  return `${prefix}\n\n${chunk.chunkText}`;
}

/**
 * Recover the section body from a stored `chunkText`.
 *
 * Chunk records store the *embedding* text as `chunkText`, which with
 * `chunking.prependTitle` (the default) begins with the prefix
 * buildEmbeddingText() adds. That prefix helps retrieval and nothing else:
 * excerpted into a snippet it produced "Page Title — Section Section …", and
 * the deep-link text target built from that snippet named a phrase no page
 * contains. It is deterministic from the record's own title and section title,
 * so it is removed at read time — existing indexes benefit without a re-embed.
 *
 * Only call this when the index was written with `prependTitle` on: the match
 * is on text alone, so without the prefix a section whose body genuinely opens
 * with its page title ("Intro\n\nActual content" under a page titled "Intro")
 * would lose that paragraph.
 */
export function stripEmbeddingPrefix(chunkText: string, title: string, sectionTitle?: string): string {
  if (!chunkText || !title) return chunkText;
  const prefix = sectionTitle ? `${title} — ${sectionTitle}\n\n` : `${title}\n\n`;
  return chunkText.startsWith(prefix) ? chunkText.slice(prefix.length) : chunkText;
}

/**
 * The logical key of a page's summary chunk.
 *
 * Fixed by the page URL alone, and never shared with a body chunk: chunkPage()
 * claims this identity before numbering body sections, so a section that
 * happens to hash the same gets a different collision ordinal. That makes the
 * key a reliable way to recognise a stored summary record, which carries no
 * type flag of its own.
 */
export function pageSummaryChunkKey(url: string): string {
  return chunkLogicalKey(pageSummaryIdentity(url));
}

function pageSummaryIdentity(url: string) {
  return { url, headingPath: ["__summary__"], text: "__summary__", collisionOrdinal: 0 };
}

/**
 * The text of a stored chunk worth showing a reader: the body without the
 * embedding prefix (when the index prepends one) and, for a page-summary
 * record, without the retrieval scaffolding buildSummaryChunkText() puts around
 * the description — the page title, the humanized URL path, and the keyword
 * list. Those made a summary snippet read "Title Title docs / guides / …".
 *
 * `isPageSummary` must come from the record's identity (see
 * pageSummaryChunkKey()), not its shape: an ordinary headingless chunk can
 * legitimately begin with the page title. Falls back to the body whenever
 * removing the scaffolding would leave nothing.
 */
export function chunkDisplayText(
  metadata: {
    chunkText: string;
    title: string;
    sectionTitle?: string;
    url?: string;
    keywords?: string[];
  },
  options: { prependTitle: boolean; isPageSummary: boolean }
): string {
  const body = options.prependTitle
    ? stripEmbeddingPrefix(metadata.chunkText, metadata.title, metadata.sectionTitle)
    : metadata.chunkText;
  if (!options.isPageSummary || !metadata.title) return body;

  let text = body;
  const humanized = metadata.url ? humanizeUrlPath(metadata.url) : "";
  // The root page's summary has no path line.
  const scaffold = humanized ? `${metadata.title}\n\n${humanized}\n\n` : `${metadata.title}\n\n`;
  if (!text.startsWith(scaffold)) return body;
  text = text.slice(scaffold.length);

  if (metadata.keywords && metadata.keywords.length > 0) {
    const keywordLine = `\n\n${metadata.keywords.join(", ")}`;
    if (text.endsWith(keywordLine)) text = text.slice(0, -keywordLine.length);
  }

  return text.trim() ? text : body;
}

export function chunkPage(
  page: IndexedPage,
  config: ResolvedSearchSocketConfig,
  scope: Scope
): Chunk[] {
  const sections = parseHeadingSections(page.markdown, config.chunking.headingPathDepth);
  const rawChunks = sections.flatMap((section) => splitSection(section, config.chunking));

  const chunks: Chunk[] = [];

  // Counts identical (heading path, text) pairs within one page so a repeated
  // section still gets distinct keys.
  const collisionCounts = new Map<string, number>();

  if (config.chunking.pageSummaryChunk) {
    const summaryText = buildSummaryChunkText(page);
    // Scope is no longer part of the logical key: isolation now lives in the
    // physical record ID (see src/vector/ids.ts), so the same page in two
    // scopes produces the same logical key and different records.
    const summaryIdentity = pageSummaryIdentity(page.url);
    const summaryChunkKey = chunkLogicalKey(summaryIdentity);

    // The summary's synthetic identity is not reserved: a page can genuinely
    // contain a section whose heading and body are both `__summary__`, and it
    // would hash to the same key. Claim the slot so such a body chunk is
    // counted as a collision and gets the next ordinal, rather than two records
    // fighting over one ID. Claimed rather than renamed because the summary's
    // key is a stored record ID that must not change under existing indexes.
    collisionCounts.set(chunkIdentityBase(summaryIdentity), 1);

    const summaryChunk: Chunk = {
      chunkKey: summaryChunkKey,
      ordinal: 0,
      url: page.url,
      path: page.url,
      title: page.title,
      sectionTitle: undefined,
      headingPath: [],
      chunkText: summaryText,
      snippet: toSnippet(summaryText),
      depth: page.depth,
      incomingLinks: page.incomingLinks,
      routeFile: page.routeFile,
      tags: page.tags,
      contentHash: "",
      description: page.description,
      keywords: page.keywords,
      publishedAt: page.publishedAt,
      incomingAnchorText: page.incomingAnchorText,
      custom: page.custom,
      meta: page.meta
    };

    // Provisional: the pipeline recomputes this from the final post-hook
    // payload. Set here so callers that chunk a page directly still get a
    // usable fingerprint.
    summaryChunk.contentHash = buildChunkEmbeddingHash(summaryChunk, config.chunking.prependTitle);
    chunks.push(summaryChunk);
  }

  const ordinalOffset = config.chunking.pageSummaryChunk ? 1 : 0;

  for (let index = 0; index < rawChunks.length; index++) {
    const entry = rawChunks[index]!;
    // The logical key deliberately excludes the ordinal. Keying on position
    // meant inserting a paragraph near the top of a page changed the key of
    // every chunk below it, so a one-line edit re-embedded the whole page and
    // deleted and recreated all of its records.
    // Derived from the exact identity the key hashes, so two chunks that
    // normalise to the same key are always counted as colliding — a
    // case-sensitive grouping key would give both ordinal 0.
    const identity = chunkIdentityBase({
      url: page.url,
      headingPath: entry.headingPath,
      text: entry.chunkText,
      collisionOrdinal: 0
    });
    const collisionOrdinal = collisionCounts.get(identity) ?? 0;
    collisionCounts.set(identity, collisionOrdinal + 1);

    const chunkKey = chunkLogicalKey({
      url: page.url,
      headingPath: entry.headingPath,
      text: entry.chunkText,
      collisionOrdinal
    });

    const chunk: Chunk = {
      chunkKey,
      ordinal: index + ordinalOffset,
      url: page.url,
      path: page.url,
      title: page.title,
      sectionTitle: entry.sectionTitle,
      headingLevel: entry.headingLevel,
      headingPath: entry.headingPath,
      chunkText: entry.chunkText,
      snippet: toSnippet(entry.chunkText),
      depth: page.depth,
      incomingLinks: page.incomingLinks,
      routeFile: page.routeFile,
      tags: page.tags,
      contentHash: "",
      description: page.description,
      keywords: page.keywords,
      publishedAt: page.publishedAt,
      incomingAnchorText: page.incomingAnchorText,
      custom: page.custom,
      meta: page.meta
    };

    chunk.contentHash = buildChunkEmbeddingHash(chunk, config.chunking.prependTitle);
    chunks.push(chunk);
  }

  return chunks;
}
