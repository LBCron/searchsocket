export function normalizeText(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

export function normalizeMarkdown(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim() + "\n";
}

export function sanitizeScopeName(scopeName: string): string {
  return scopeName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Plain display text from indexed markdown, for snippets and excerpts.
 *
 * Removes markdown *syntax* and nothing else, so the result is text a reader
 * can find on the rendered page — a stored snippet becomes the browser's
 * scroll-to-text target. Line-level markers are only recognised at the start
 * of a line, table pipes only on table rows, emphasis only as a delimiter pair,
 * and code-span contents and backslash-escaped punctuation are set aside
 * before any of that runs, so `__init__`, `a || b` and `max\_results` come back
 * as written on the page.
 *
 * Indexed text is attacker-influenced and can be large, so every pass is linear:
 * the line-level work runs per trimmed line, the paired delimiters and code
 * spans are matched by index rather than by backtracking regexes, and the
 * remaining regexes use character classes that exclude their own delimiters.
 */
export function markdownToPlain(markdown: string): string {
  const stash: string[] = [];
  const hold = (value: string) => `${PLACEHOLDER_OPEN}${stash.push(value) - 1}${PLACEHOLDER_CLOSE}`;

  const restore = (value: string) => value.replace(PLACEHOLDER_RE, (_m, index: string) => stash[Number(index)] ?? "");

  // Real placeholder characters are themselves set aside, so they survive and
  // cannot be mistaken for a placeholder; code spans restore them in place.
  let text = dropFencedCode(markdown.replace(/\r\n?/g, "\n").replace(/[\uE000\uE001]/g, hold));
  text = holdCodeSpans(text, hold, restore);
  // Backslash escapes, including the hard line break `\` at end of line.
  text = text
    .replace(/\\\n/g, "\n")
    .replace(/\\([!-/:-@[-`{-~])/g, (_m, ch: string) => hold(ch));

  // Images before links, so `[![alt](src)](href)` keeps its alt text.
  text = unwrapInlineLinks(text, true);
  text = unwrapInlineLinks(text, false);
  text = text
    .replace(/\[([^[\]]+)\]\[[^[\]]*\]/g, "$1")
    .replace(/<(https?:\/\/[^<>\s]+)>/g, "$1");

  text = stripLineSyntax(text);

  // Nested runs such as `****foo****` or `**_foo_**` unwrap one layer per
  // pass, so repeat until nothing changes, up to a fixed number of linear passes.
  for (let pass = 0; pass < MAX_EMPHASIS_PASSES; pass++) {
    const before = text;
    text = unwrapPairs(text, "**", false);
    text = unwrapPairs(text, "__", true);
    text = unwrapPairs(text, "~~", false);
    text = text
      // Single delimiters cannot contain their own delimiter or a newline, so
      // each attempt stops at the next one.
      .replace(/(^|[^\p{L}\p{N}*])\*(?=\S)([^*\n]*?\S)\*(?![\p{L}\p{N}*])/gu, "$1$2")
      .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu, "$1$2");
    if (text === before) break;
  }

  return restore(text.replace(/\s+/g, " ").trim());
}

/** Private-use delimiters for text set aside from the formatting passes. */
const PLACEHOLDER_OPEN = "\uE000";
const PLACEHOLDER_CLOSE = "\uE001";
const PLACEHOLDER_RE = /\uE000(\d+)\uE001/g;

/** Emphasis layers unwrapped before giving up; each pass is linear. */
const MAX_EMPHASIS_PASSES = 8;

/** Parenthesis nesting allowed inside a link destination before the link is left as text. */
const MAX_DESTINATION_DEPTH = 32;

/**
 * Replace inline links `[text](dest "title")` (or images `![alt](src)`) with
 * their text. A destination has no whitespace and balanced parentheses nested
 * at most MAX_DESTINATION_DEPTH deep. Parentheses are matched once up front
 * with a stack, and the text between brackets excludes brackets, so neither a
 * successful nor a failed attempt rescans what an earlier one covered.
 */
function unwrapInlineLinks(text: string, images: boolean): string {
  if (!text.includes("](")) return text;
  const parens = matchParentheses(text);

  let out = "";
  let pos = 0;
  let i = text.indexOf("[");
  while (i !== -1) {
    let end = i + 1;
    while (end < text.length && text[end] !== "[" && text[end] !== "]") end++;
    const isImage = i > 0 && text[i - 1] === "!";
    const labelOk = images ? isImage : end > i + 1;
    const close = labelOk && text[end] === "]" && text[end + 1] === "(" ? linkClose(text, end + 1, parens) : -1;
    if (close === -1) {
      // No bracket lies between i and end, so the next candidate is at or after end.
      i = text.indexOf("[", end);
      continue;
    }
    out += text.slice(pos, images ? i - 1 : i) + text.slice(i + 1, end);
    pos = close + 1;
    i = text.indexOf("[", pos);
  }
  return out + text.slice(pos);
}

interface ParenMatch {
  /** For a `(`, the index of its matching `)` within the same whitespace-free run, else -1. */
  close: Int32Array;
  /** For a `(` still open and innermost when whitespace ends its run, that whitespace's index, else -1. */
  openAtSpace: Int32Array;
  /** For a `(`, the deepest nesting of parentheses inside it. */
  depth: Int32Array;
}

/** Match parentheses within each whitespace-free run in one linear pass. */
function matchParentheses(text: string): ParenMatch {
  const close = new Int32Array(text.length).fill(-1);
  const openAtSpace = new Int32Array(text.length).fill(-1);
  const depth = new Int32Array(text.length);
  const stack: number[] = [];
  for (let k = 0; k <= text.length; k++) {
    const ch = text[k];
    if (ch === "(") {
      stack.push(k);
    } else if (ch === ")") {
      const open = stack.pop();
      if (open === undefined) continue;
      close[open] = k;
      const parent = stack[stack.length - 1];
      if (parent !== undefined) depth[parent] = Math.max(depth[parent]!, depth[open]! + 1);
    } else if (ch === undefined || /\s/.test(ch)) {
      if (ch !== undefined && stack.length > 0) openAtSpace[stack[stack.length - 1]!] = k;
      stack.length = 0;
    }
  }
  return { close, openAtSpace, depth };
}

/** Index of the `)` ending a link whose destination opens with the `(` at `open`, or -1. */
function linkClose(text: string, open: number, parens: ParenMatch): number {
  if (parens.depth[open]! > MAX_DESTINATION_DEPTH) return -1;
  if (parens.close[open] !== -1) return parens.close[open]!;

  // `(dest "title")`: the destination ends at whitespace with its parentheses balanced.
  let k = parens.openAtSpace[open]!;
  if (k === -1) return -1;
  while (k < text.length && /\s/.test(text[k]!)) k++;
  if (text[k] !== '"') return -1;
  for (k++; k < text.length && text[k] !== '"'; k++) {
    if (text[k] === "\n") return -1;
  }
  return text[k] === '"' && text[k + 1] === ")" ? k + 1 : -1;
}

/**
 * Blank out fenced code blocks (an unclosed fence runs to the end, as in
 * CommonMark 0.31.2 §4.5). An opener is three or more backticks or tildes
 * after at most three spaces; a backtick opener's info string may not contain
 * a backtick, so a line starting with a code span like ```` ```a``` ```` is not
 * a fence. A closer uses the same character, is at least as long, and has only
 * whitespace after it.
 */
function dropFencedCode(text: string): string {
  const lines = text.split("\n");
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    const rest = match ? line.slice(match[0].length) : "";
    if (fence === null) {
      if (match && !(match[1]![0] === "`" && rest.includes("`"))) {
        fence = match[1]!;
        lines[i] = "";
      }
      continue;
    }
    if (match && match[1]![0] === fence[0] && match[1]!.length >= fence.length && rest.trim() === "") {
      fence = null;
    }
    lines[i] = "";
  }
  return lines.join("\n");
}

/**
 * Replace each code span with a placeholder holding its literal contents.
 *
 * A span opens on a backtick run not escaped by a backslash and closes on the
 * next run of exactly the same length. Runs are indexed by length up front and
 * each length's cursor only moves forward, so matching is linear however many
 * runs go unmatched.
 */
function holdCodeSpans(
  text: string,
  hold: (value: string) => string,
  restore: (value: string) => string
): string {
  if (!text.includes("`")) return text;

  const runs: Array<{ start: number; length: number }> = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && text[i] === "`") i++;
    runs.push({ start, length: i - start });
  }

  const byLength = new Map<number, number[]>();
  runs.forEach((run, index) => {
    const list = byLength.get(run.length);
    if (list) list.push(index);
    else byLength.set(run.length, [index]);
  });
  const cursors = new Map<number, number>();
  const nextRun = (length: number, after: number): number => {
    const list = byLength.get(length);
    if (!list) return -1;
    let cursor = cursors.get(length) ?? 0;
    while (cursor < list.length && list[cursor]! <= after) cursor++;
    cursors.set(length, cursor);
    return cursor < list.length ? list[cursor]! : -1;
  };

  let out = "";
  let pos = 0;
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!;
    if (run.start < pos) continue;

    let open = run.start;
    let length = run.length;
    let backslashes = 0;
    while (open - backslashes - 1 >= pos && text[open - backslashes - 1] === "\\") backslashes++;
    if (backslashes % 2 === 1) {
      // The first backtick is escaped text; the rest of the run may still open.
      open++;
      length--;
      if (length === 0) continue;
    }

    const close = nextRun(length, index);
    if (close === -1) continue;

    let code = restore(text.slice(open + length, runs[close]!.start)).replace(/\n/g, " ");
    if (code.length > 1 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") {
      code = code.slice(1, -1);
    }
    out += text.slice(pos, open) + hold(code);
    pos = runs[close]!.start + length;
  }
  return out + text.slice(pos);
}

/** A GFM table delimiter row, e.g. `| --- | :---: |`, tested on a trimmed line. */
function isTableDivider(trimmed: string): boolean {
  return trimmed.includes("|") && trimmed.includes("---") && /^[|: \t-]+$/.test(trimmed);
}

/** A thematic break (`---`, `* * *`, `___`), tested on a trimmed line. */
function isThematicBreak(trimmed: string): boolean {
  const ch = trimmed[0];
  if (ch !== "-" && ch !== "*" && ch !== "_") return false;
  let count = 0;
  for (const c of trimmed) {
    if (c === ch) count++;
    else if (c !== " " && c !== "\t") return false;
  }
  return count >= 3;
}

/**
 * Remove line-level syntax: table dividers and thematic breaks, cell pipes on
 * table rows, then blockquote, heading and list markers. Works per line with
 * anchored, non-overlapping patterns.
 */
function stripLineSyntax(text: string): string {
  const lines = text.split("\n");
  const trimmed = lines.map((line) => line.trim());

  // A table row is a line in a block that has a delimiter row, or a line that
  // both starts and ends with a pipe.
  // One forward pass: a delimiter row opens (or continues) a block that runs
  // through the following non-blank lines containing a pipe.
  const tableRow = new Array<boolean>(lines.length).fill(false);
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const t = trimmed[i]!;
    if (isTableDivider(t)) {
      if (i > 0 && trimmed[i - 1]!.includes("|")) tableRow[i - 1] = true;
      inTable = true;
    } else if (inTable && t !== "" && t.includes("|")) {
      tableRow[i] = true;
    } else {
      inTable = false;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const t = trimmed[i]!;
    if (isTableDivider(t) || isThematicBreak(t)) {
      lines[i] = "";
      continue;
    }
    let line = lines[i]!;
    if (tableRow[i] || (t.length >= 2 && t.startsWith("|") && t.endsWith("|"))) {
      line = line.split("|").join(" ");
    }
    line = line
      .replace(/^ {0,3}(?:>[ \t]?)+/, "")
      .replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, "")
      .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, "");
    lines[i] = line;
  }
  return lines.join("\n");
}

/**
 * Unwrap `delimiter`-delimited spans (`**strong**`, `__strong__`, `~~del~~`).
 *
 * An opener is followed by non-whitespace and a closer preceded by it; each
 * opener pairs with the next closer. For `__`, intraword delimiters do not
 * count, so `snake__case__name` is left alone. The next-closer table is built
 * right to left, so the pass is linear rather than rescanning from each opener.
 */
function unwrapPairs(text: string, delimiter: string, flankingWords: boolean): string {
  if (!text.includes(delimiter)) return text;

  const hits: number[] = [];
  for (let i = text.indexOf(delimiter); i !== -1; i = text.indexOf(delimiter, i + delimiter.length)) {
    hits.push(i);
  }

  const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
  const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
  const canOpen = (at: number) =>
    !isSpace(text[at + delimiter.length]) && !(flankingWords && isWord(text[at - 1]));
  const canClose = (at: number) =>
    !isSpace(text[at - 1]) && !(flankingWords && isWord(text[at + delimiter.length]));

  const nextCloser = new Array<number>(hits.length + 1).fill(-1);
  for (let k = hits.length - 1; k >= 0; k--) {
    nextCloser[k] = k + 1 < hits.length && canClose(hits[k + 1]!) ? k + 1 : nextCloser[k + 1]!;
  }

  let out = "";
  let pos = 0;
  for (let k = 0; k < hits.length; k++) {
    const open = hits[k]!;
    if (open < pos || !canOpen(open)) continue;
    const m = nextCloser[k]!;
    if (m === -1) continue;
    const close = hits[m]!;
    if (close <= open + delimiter.length) continue;
    out += text.slice(pos, open) + text.slice(open + delimiter.length, close);
    pos = close + delimiter.length;
    k = m;
  }
  return out + text.slice(pos);
}

export function toSnippet(markdown: string, maxLen = 220): string {
  const plain = markdownToPlain(markdown);

  if (plain.length <= maxLen) {
    return plain;
  }

  return `${plain.slice(0, Math.max(0, maxLen - 1)).trim()}…`;
}

/** Distinct query terms considered when choosing an excerpt window. */
const MAX_EXCERPT_TOKENS = 32;

export function queryAwareExcerpt(markdown: string, query: string, maxLen = 220): string {
  const plain = markdownToPlain(markdown);
  if (plain.length <= maxLen) return plain;

  // Deduplicated and capped: every token is a full regex scan of the section,
  // so a query of the same word repeated thousands of times used to cost
  // thousands of identical scans per result.
  const tokens = [
    ...new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length >= 2)
    )
  ].slice(0, MAX_EXCERPT_TOKENS);

  if (tokens.length === 0) return toSnippet(markdown, maxLen);

  // Find all match positions in the plain text, tagged by token index
  const positions: Array<{ start: number; end: number; tokenIdx: number }> = [];
  for (let ti = 0; ti < tokens.length; ti++) {
    const escaped = tokens[ti]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(plain)) !== null) {
      positions.push({ start: m.index, end: m.index + m[0].length, tokenIdx: ti });
    }
  }

  if (positions.length === 0) return toSnippet(markdown, maxLen);

  positions.sort((a, b) => a.start - b.start);

  // Two-pointer sliding window: find the window with most unique terms fitting in maxLen chars
  // Tie-break by total match count
  let bestUniqueCount = 0;
  let bestTotalCount = 0;
  let bestLeft = 0;
  let bestRight = 0;
  let left = 0;
  const tokenCounts = new Map<number, number>();

  for (let right = 0; right < positions.length; right++) {
    tokenCounts.set(positions[right]!.tokenIdx, (tokenCounts.get(positions[right]!.tokenIdx) ?? 0) + 1);

    // Shrink from left while the window span exceeds maxLen
    while (positions[right]!.end - positions[left]!.start > maxLen && left < right) {
      const leftToken = positions[left]!.tokenIdx;
      const cnt = tokenCounts.get(leftToken)! - 1;
      if (cnt === 0) tokenCounts.delete(leftToken);
      else tokenCounts.set(leftToken, cnt);
      left++;
    }

    const uniqueCount = tokenCounts.size;
    const totalCount = right - left + 1;
    if (uniqueCount > bestUniqueCount || (uniqueCount === bestUniqueCount && totalCount > bestTotalCount)) {
      bestUniqueCount = uniqueCount;
      bestTotalCount = totalCount;
      bestLeft = left;
      bestRight = right;
    }
  }

  // Center the excerpt around the midpoint of the best window
  const mid = Math.floor((positions[bestLeft]!.start + positions[bestRight]!.end) / 2);
  let start = Math.max(0, mid - Math.floor(maxLen / 2));
  let end = Math.min(plain.length, start + maxLen);
  // Re-adjust start if end hit the boundary
  start = Math.max(0, end - maxLen);

  // Snap to word boundaries
  if (start > 0) {
    const spaceIdx = plain.lastIndexOf(" ", start);
    if (spaceIdx > start - 30) {
      start = spaceIdx + 1;
    }
  }
  if (end < plain.length) {
    const spaceIdx = plain.indexOf(" ", end);
    if (spaceIdx !== -1 && spaceIdx < end + 30) {
      end = spaceIdx;
    }
  }

  let excerpt = plain.slice(start, end);

  // Hard-trim if word-boundary snapping expanded beyond limit
  if (excerpt.length > Math.ceil(maxLen * 1.2)) {
    excerpt = excerpt.slice(0, maxLen);
    const lastSpace = excerpt.lastIndexOf(" ");
    if (lastSpace > maxLen * 0.5) {
      excerpt = excerpt.slice(0, lastSpace);
    }
  }

  const prefix = start > 0 ? "…" : "";
  const suffix = end < plain.length ? "…" : "";
  return `${prefix}${excerpt}${suffix}`;
}

export function extractFirstParagraph(markdown: string): string {
  const lines = markdown.split("\n");
  let inFence = false;
  const collected: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      if (collected.length > 0) break;
      continue;
    }

    if (inFence) continue;

    // Skip headings
    if (/^#{1,6}\s/.test(trimmed)) {
      if (collected.length > 0) break;
      continue;
    }

    // Empty line ends a paragraph
    if (!trimmed) {
      if (collected.length > 0) break;
      continue;
    }

    collected.push(trimmed);
  }

  return collected.join(" ");
}

export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
