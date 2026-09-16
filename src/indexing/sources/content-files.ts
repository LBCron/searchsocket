import fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import fg from "fast-glob";
import matter from "gray-matter";
import { Logger } from "../../core/logger";
import type { PageSourceRecord, ResolvedSearchSocketConfig } from "../../types";
import { normalizeUrlPath } from "../../utils/path";
import { applyMaxPagesByUrl, sourceResult, type SourceFailure, type SourceLoadResult } from "./result";

function filePathToUrl(filePath: string, baseDir: string): string {
  const relative = path.relative(baseDir, filePath).replace(/\\/g, "/");
  const segments = relative.split("/").filter(Boolean);

  if (/(^|\/)\+page\.svelte$/.test(relative)) {
    const routeSegments = segments.slice();

    if ((routeSegments[0] ?? "").toLowerCase() === "src" && (routeSegments[1] ?? "").toLowerCase() === "routes") {
      routeSegments.splice(0, 2);
    } else if ((routeSegments[0] ?? "").toLowerCase() === "routes") {
      routeSegments.splice(0, 1);
    }

    const routePath = routeSegments
      .filter((segment) => segment !== "+page.svelte")
      .filter((segment) => segment && !segment.startsWith("("))
      .map((segment) =>
        segment
          .replace(/^\[\[[^\]]+\]\]$/, "optional")
          .replace(/^\[\.\.\.[^\]]+\]$/, "splat")
          .replace(/^\[[^\]]+\]$/, "param")
      )
      .join("/");

    return normalizeUrlPath(routePath || "/");
  }

  const noExt = relative
    .replace(/\.md$/i, "")
    .replace(/\/index$/i, "");

  return normalizeUrlPath(noExt || "/");
}

/** SvelteKit route file pattern — these are pages, not components. */
const ROUTE_FILE_RE = /\+(page|layout|error)(@[^.]+)?\.svelte$/;

/**
 * Returns true for `.svelte` files that are reusable components (not route files).
 */
export function isSvelteComponentFile(filePath: string): boolean {
  if (!filePath.endsWith(".svelte")) return false;
  return !ROUTE_FILE_RE.test(filePath);
}

export interface SveltePropMeta {
  name: string;
  type?: string;
  default?: string;
}

export interface SvelteComponentMeta {
  description?: string;
  props: SveltePropMeta[];
}

/**
 * Extract `<!-- @component ... -->` description and `$props()` metadata from raw Svelte source.
 */
export function extractSvelteComponentMeta(source: string): SvelteComponentMeta {
  // Extract @component description from HTML comment
  const componentMatch = source.match(/<!--\s*@component\s*([\s\S]*?)\s*-->/);
  const description = componentMatch?.[1]?.trim() || undefined;

  // Extract $props() destructuring
  const propsMatch = source.match(
    /let\s+\{([\s\S]*?)\}\s*(?::\s*([^=;{][\s\S]*?))?\s*=\s*\$props\(\)/
  );

  const props: SveltePropMeta[] = [];

  if (propsMatch) {
    const destructureBlock = propsMatch[1]!;
    const typeAnnotation = propsMatch[2]?.trim();

    // Try to resolve type from interface/type alias if it's a reference name
    let resolvedTypeMap: Map<string, string> | undefined;
    if (typeAnnotation && /^[A-Z]\w*$/.test(typeAnnotation)) {
      resolvedTypeMap = resolveTypeReference(source, typeAnnotation);
    } else if (typeAnnotation && typeAnnotation.startsWith("{")) {
      // Inline type annotation: `{ a: string; b: number }`
      resolvedTypeMap = parseInlineTypeAnnotation(typeAnnotation);
    }

    // Parse the destructure block into individual props
    const propEntries = splitDestructureBlock(destructureBlock);

    for (const entry of propEntries) {
      const trimmed = entry.trim();
      if (!trimmed || trimmed.startsWith("...")) continue;

      // Handle renamed props: `originalName: localName` or `originalName: localName = default`
      // Also handle props with defaults: `name = defaultValue`
      let propName: string;
      let defaultValue: string | undefined;

      const renameMatch = trimmed.match(/^(\w+)\s*:\s*\w+\s*(?:=\s*([\s\S]+))?$/);
      if (renameMatch) {
        propName = renameMatch[1]!;
        defaultValue = renameMatch[2]?.trim();
      } else {
        const defaultMatch = trimmed.match(/^(\w+)\s*=\s*([\s\S]+)$/);
        if (defaultMatch) {
          propName = defaultMatch[1]!;
          defaultValue = defaultMatch[2]?.trim();
        } else {
          propName = trimmed.match(/^(\w+)/)?.[1] ?? trimmed;
        }
      }

      const propType = resolvedTypeMap?.get(propName);

      props.push({
        name: propName,
        ...(propType ? { type: propType } : {}),
        ...(defaultValue ? { default: defaultValue } : {})
      });
    }
  }

  return { description, props };
}

/**
 * Split a destructure block on commas, respecting nested braces/brackets/parens.
 */
function splitDestructureBlock(block: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let current = "";

  for (const ch of block) {
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      current += ch;
    } else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      entries.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  if (current.trim()) entries.push(current);
  return entries;
}

/**
 * Resolve an interface or type alias definition to a map of prop name → type string.
 */
function resolveTypeReference(source: string, typeName: string): Map<string, string> | undefined {
  // Find the opening brace for the interface or type alias
  const startRe = new RegExp(`(?:interface\\s+${typeName}\\s*|type\\s+${typeName}\\s*=\\s*)\\{`);
  const startMatch = source.match(startRe);
  if (!startMatch || startMatch.index === undefined) return undefined;

  // Walk from after the opening brace, tracking brace depth
  const bodyStart = startMatch.index + startMatch[0].length;
  let depth = 1;
  let i = bodyStart;
  while (i < source.length && depth > 0) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }
  if (depth !== 0) return undefined;

  // Extract body between the braces (excluding closing brace)
  const body = source.slice(bodyStart, i - 1);
  return parseTypeMembers(body);
}

/**
 * Parse an inline type annotation like `{ a: string; b: number }`.
 */
function parseInlineTypeAnnotation(annotation: string): Map<string, string> | undefined {
  // Strip outer braces
  const inner = annotation.replace(/^\{/, "").replace(/\}$/, "");
  return parseTypeMembers(inner);
}

/**
 * Parse type members from the body of an interface or inline type.
 */
function parseTypeMembers(body: string): Map<string, string> {
  const map = new Map<string, string>();
  // Split on semicolons or newlines
  const members = body.split(/[;\n]/).map((m) => m.trim()).filter(Boolean);

  for (const member of members) {
    const memberMatch = member.match(/^(\w+)\??\s*:\s*(.+)$/);
    if (memberMatch) {
      map.set(memberMatch[1]!, memberMatch[2]!.replace(/,\s*$/, "").trim());
    }
  }

  return map;
}

/**
 * Build structured markdown prose for a component, optimized for semantic search embedding.
 */
export function buildComponentMarkdown(
  componentName: string,
  meta: SvelteComponentMeta
): string {
  if (!meta.description && meta.props.length === 0) return "";

  const parts: string[] = [`${componentName} component.`];

  if (meta.description) {
    parts.push(meta.description);
  }

  if (meta.props.length > 0) {
    const propEntries = meta.props.map((p) => {
      let entry = p.name;
      if (p.type) entry += ` (${p.type})`;
      if (p.default) entry += ` default: ${p.default}`;
      return entry;
    });
    parts.push(`Props: ${propEntries.join(", ")}.`);
  }

  return parts.join(" ");
}

/**
 * Reasons the raw-Svelte scanner can refuse to publish a page. They mirror the
 * exclusion reasons the HTML extractor produces for the same signals.
 */
type SvelteExclusionReason = "noindex" | "zero-weight";

export interface SvelteSourceAnalysis {
  /** Set when a statically decidable signal asks for the page to be withheld. */
  excluded?: SvelteExclusionReason;
  /** Literal per-page weight read from a weight signal in the source. */
  weight?: number;
  /**
   * Protective signals that were present but not decidable from source text
   * alone. Each one also forces `excluded`: an unresolvable protection is
   * honoured rather than guessed away, and reported to the operator.
   */
  unresolved: string[];
  /** How many `{#...}` control-flow blocks contributed text unconditionally. */
  conditionalBlocks: number;
  /** Whether an ignore-attributed subtree actually had its text dropped. */
  droppedIgnoredText: boolean;
  /** Plain text of the template, with ignored subtrees dropped. */
  text: string;
}

// --- Expression masking ----------------------------------------------------
//
// A `.svelte` file is not HTML, and the difference is concentrated in its brace
// expressions: they may contain `<`, `>`, and quotes (`title={a > b}`), which
// silently wreck the surrounding attributes when handed to an HTML parser. So
// every brace group is replaced by an inert sentinel before parsing, and what
// it actually said is kept beside the text. Nothing about a group is left in
// the markup for the parser to misread.

/** What a masked brace group turned out to be. */
type MaskedGroup =
  | { kind: "spread"; source: string }
  | { kind: "shorthand"; name: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "expression" };

interface MaskedSource {
  masked: string;
  groups: MaskedGroup[];
}

const SENTINEL_RE = /\{~(\d+)\}/g;
const LITERAL_NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
/** A quoted string with nothing that needs interpreting: no escapes, no `${}`. */
const SIMPLE_STRING_RE = /^(['"])([^'"\\`$]*)\1$/;
const SHORTHAND_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Regions copied through untouched. Braces inside a comment, a `<script>`, or a
 * `<style>` are not template expressions, and masking them merges the region
 * with whatever follows — which would swallow real markup, protections
 * included.
 */
const RAW_REGIONS: { open: string; close: string; rawText: boolean }[] = [
  { open: "<!--", close: "-->", rawText: false },
  { open: "<script", close: "</script", rawText: true },
  { open: "<style", close: "</style", rawText: true }
];

/**
 * Find a raw region starting at `i`, returning the index just past it.
 *
 * `<script`/`<style` only open a raw-text region when spelled in lower case and
 * not self-closed: `<Script />` is a Svelte component, and treating it as raw
 * text would consume the rest of the file.
 */
function skipRawRegion(source: string, i: number): number | undefined {
  for (const region of RAW_REGIONS) {
    if (!source.startsWith(region.open, i)) continue;

    if (region.rawText) {
      const tagEnd = source.indexOf(">", i);
      if (tagEnd === -1) return source.length;
      if (source[tagEnd - 1] === "/") return tagEnd + 1;
      const close = source.indexOf(region.close, tagEnd);
      return close === -1 ? source.length : close + region.close.length;
    }

    const close = source.indexOf(region.close, i + region.open.length);
    return close === -1 ? source.length : close + region.close.length;
  }
  return undefined;
}

/** Index of the `}` closing the group opened at `start`, or -1. */
function findBraceGroupEnd(source: string, start: number): number {
  // Cheap bail-out so a run of stray `{` cannot make this quadratic.
  if (source.indexOf("}", start) === -1) return -1;

  let depth = 0;
  let quote: string | undefined;

  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;

    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = undefined;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function classifyBraceGroup(inner: string): MaskedGroup {
  if (inner.startsWith("...")) return { kind: "spread", source: inner.slice(3).trim() };
  // Literals first: `true` and `false` also look like shorthand prop names.
  if (inner === "true" || inner === "false") return { kind: "boolean", value: inner === "true" };
  if (LITERAL_NUMBER_RE.test(inner)) return { kind: "number", value: Number(inner) };
  const quoted = inner.match(SIMPLE_STRING_RE);
  if (quoted) return { kind: "string", value: quoted[2]! };
  if (SHORTHAND_RE.test(inner)) return { kind: "shorthand", name: inner };
  return { kind: "expression" };
}

/**
 * Replace every Svelte brace group with an inert sentinel, keeping control-flow
 * markers visible as `{#}` / `{/}` / `{:}` / `{@}` so block nesting can still
 * be tracked.
 */
export function maskSvelteExpressions(source: string): MaskedSource {
  const groups: MaskedGroup[] = [];
  let out = "";
  let i = 0;

  while (i < source.length) {
    const rawEnd = skipRawRegion(source, i);
    if (rawEnd !== undefined) {
      out += source.slice(i, rawEnd);
      i = rawEnd;
      continue;
    }

    if (source[i] !== "{") {
      out += source[i];
      i++;
      continue;
    }

    const end = findBraceGroupEnd(source, i);
    if (end === -1) {
      // Unbalanced brace: not a group at all. Emit it and move on rather than
      // swallowing the rest of the file.
      out += source[i];
      i++;
      continue;
    }

    const inner = source.slice(i + 1, end).trim();
    const marker = inner[0];
    if (marker === "#" || marker === "/" || marker === ":" || marker === "@") {
      out += `{${marker}}`;
    } else {
      out += `{~${groups.length}}`;
      groups.push(classifyBraceGroup(inner));
    }
    i = end + 1;
  }

  return { masked: out, groups };
}

// --- Attribute resolution --------------------------------------------------

/**
 * A resolved attribute value. JS types are preserved because Svelte truthiness
 * depends on them: `noindex={"false"}` passes a truthy string, while
 * `noindex={false}` passes a boolean.
 */
type SvelteAttrValue =
  | { kind: "dynamic" }
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  /** Present with an empty value — the bare `<SearchSocket noindex />` form. */
  | { kind: "empty" };

/** How the value would be rendered into HTML; `undefined` when unresolvable. */
function attrAsString(value: SvelteAttrValue): string | undefined {
  switch (value.kind) {
    case "dynamic":
      return undefined;
    case "empty":
      return "";
    case "string":
      return value.value;
    default:
      return String(value.value);
  }
}

/**
 * JS truthiness as the component would see it; `undefined` when unresolvable.
 *
 * A bare attribute and an explicitly empty one are indistinguishable after
 * parsing, so both read as true. The bare form is the documented one, and
 * reading it as false would publish a page someone asked to withhold.
 */
function attrIsTruthy(value: SvelteAttrValue): boolean | undefined {
  switch (value.kind) {
    case "dynamic":
      return undefined;
    case "empty":
      return true;
    case "boolean":
      return value.value;
    case "number":
      return value.value !== 0;
    case "string":
      return value.value.length > 0;
  }
}

function groupAsAttrValue(group: MaskedGroup): SvelteAttrValue {
  switch (group.kind) {
    case "boolean":
    case "number":
    case "string":
      return group;
    default:
      return { kind: "dynamic" };
  }
}

/**
 * Resolve one raw attribute value, substituting masked groups back in. A value
 * built only from literals resolves to the string Svelte would render; one that
 * touches any expression is dynamic.
 */
function resolveAttrValue(raw: string, groups: MaskedGroup[]): SvelteAttrValue {
  SENTINEL_RE.lastIndex = 0;
  const matches = [...raw.matchAll(SENTINEL_RE)];
  if (matches.length === 0) return raw === "" ? { kind: "empty" } : { kind: "string", value: raw };

  if (matches.length === 1 && matches[0]![0] === raw) {
    return groupAsAttrValue(groups[Number(matches[0]![1])]!);
  }

  // Mixed text and expressions, e.g. `content="no{'index'}"`.
  let out = "";
  let last = 0;
  for (const match of matches) {
    const group = groups[Number(match[1])]!;
    const asString = attrAsString(groupAsAttrValue(group));
    if (asString === undefined) return { kind: "dynamic" };
    out += raw.slice(last, match.index) + asString;
    last = match.index + match[0].length;
  }
  return { kind: "string", value: out + raw.slice(last) };
}

/** An element's attributes after shorthand and spreads are put back together. */
interface ResolvedAttrs {
  values: Map<string, SvelteAttrValue>;
  /** Source text of each `{...spread}`, for the little that can be said about it. */
  spreads: string[];
}

function resolveAttrs(attribs: Record<string, string>, groups: MaskedGroup[]): ResolvedAttrs {
  const values = new Map<string, SvelteAttrValue>();
  const spreads: string[] = [];

  for (const [rawName, rawValue] of Object.entries(attribs)) {
    const sentinel = rawName.match(/^\{~(\d+)\}$/);
    if (sentinel) {
      const group = groups[Number(sentinel[1])]!;
      if (group.kind === "spread") spreads.push(group.source);
      // `{prop}` shorthand is `prop={prop}` — the name is known, the value is not.
      else if (group.kind === "shorthand") values.set(group.name.toLowerCase(), { kind: "dynamic" });
      continue;
    }
    values.set(rawName.toLowerCase(), resolveAttrValue(rawValue, groups));
  }

  return { values, spreads };
}

// --- Signal detection ------------------------------------------------------

/**
 * The subset of a parsed node this scanner needs. Cheerio does not re-export
 * domhandler's node types, and depending on domhandler directly would be a
 * phantom dependency.
 */
interface ParsedNode {
  type: string;
  data?: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: ParsedNode[];
}

interface SvelteScanContext {
  /** Lowercased, because attribute names are lowercased by the parser. */
  noindexAttr: string;
  ignoreAttr: string;
  respectRobotsNoindex: boolean;
  groups: MaskedGroup[];
  /** Local names the search metadata component was imported under. */
  componentAliases: Set<string>;
  controlDepth: number;
  conditionalBlocks: number;
  droppedIgnoredText: boolean;
  excluded?: SvelteExclusionReason;
  weight?: number;
  unresolved: string[];
  textParts: string[];
}

/**
 * Local names bound to this package's metadata component. Imports are
 * JavaScript, not markup, so they are read the same way the component prop
 * scanner above reads them.
 */
function findComponentAliases(source: string): Set<string> {
  const aliases = new Set<string>();
  const importRe = /import\s+([\s\S]*?)\s+from\s+["']([^"']*searchsocket[^"']*)["']/g;

  for (const match of source.matchAll(importRe)) {
    const clause = match[1]!;
    const defaultName = clause.match(/^([A-Za-z_$][\w$]*)/);
    if (defaultName) aliases.add(defaultName[1]!);
    const named = clause.match(/\{([\s\S]*)\}/);
    if (!named) continue;
    for (const entry of named[1]!.split(",")) {
      const renamed = entry.match(/SearchSocket\s+as\s+([A-Za-z_$][\w$]*)/);
      if (renamed) aliases.add(renamed[1]!);
      else if (entry.trim() === "SearchSocket") aliases.add("SearchSocket");
    }
  }

  return aliases;
}

/**
 * Component elements, as Svelte distinguishes them: capitalised, namespaced, or
 * `<svelte:component>`. Any of them may be the metadata component under a local
 * name, so a `noindex` prop on one is taken at face value.
 */
function isComponentTag(name: string): boolean {
  return /^[A-Z]/.test(name) || name.includes(".") || name === "svelte:component";
}

function isSearchSocketTag(name: string, aliases: Set<string>): boolean {
  if (/(?:^|\.)SearchSocket$/.test(name)) return true;
  return aliases.has(name) || aliases.has(name.split(".")[0]!);
}

function excludePage(ctx: SvelteScanContext, reason: SvelteExclusionReason): void {
  // First verdict wins; every reason withholds the page either way.
  ctx.excluded ??= reason;
}

function markUnresolved(ctx: SvelteScanContext, detail: string): void {
  const suffix = ctx.controlDepth > 0 ? " inside a control-flow block" : "";
  ctx.unresolved.push(`${detail}${suffix}`);
  excludePage(ctx, "noindex");
}

/**
 * Record a protective signal that resolved to "withhold", warning instead when
 * it sits on one branch of a conditional and so may not render at all.
 */
function applyProtectiveSignal(
  ctx: SvelteScanContext,
  reason: SvelteExclusionReason,
  detail: string
): void {
  if (ctx.controlDepth > 0) {
    markUnresolved(ctx, detail);
    return;
  }
  excludePage(ctx, reason);
}

/** A spread may hide a protective attribute; only its source text can hint. */
function inspectSpreads(node: ParsedNode, attrs: ResolvedAttrs, ctx: SvelteScanContext): void {
  const name = node.name ?? "";
  const protective = [ctx.noindexAttr, ctx.ignoreAttr, "noindex", "weight"];
  const relevant = isSearchSocketTag(name, ctx.componentAliases) || name.toLowerCase() === "meta";

  for (const spread of attrs.spreads) {
    if (relevant || protective.some((attr) => spread.includes(attr))) {
      markUnresolved(ctx, `<${name} {...${spread}}>`);
      return;
    }
  }
}

function inspectComponentElement(node: ParsedNode, attrs: ResolvedAttrs, ctx: SvelteScanContext): void {
  const name = node.name ?? "";

  const noindex = attrs.values.get("noindex");
  if (noindex) {
    const truthy = attrIsTruthy(noindex);
    if (truthy === undefined) markUnresolved(ctx, `<${name} noindex={expression} />`);
    else if (truthy) applyProtectiveSignal(ctx, "noindex", `<${name} noindex />`);
  }

  if (!isSearchSocketTag(name, ctx.componentAliases)) return;

  const weight = attrs.values.get("weight");
  if (!weight) return;
  if (weight.kind === "dynamic") {
    markUnresolved(ctx, `<${name} weight={expression} />`);
    return;
  }
  applyWeight(ctx, attrAsString(weight), `<${name} weight={0} />`);
}

/** Shared by the weight prop and the weight meta — both render the same value. */
function applyWeight(ctx: SvelteScanContext, raw: string | undefined, detail: string): void {
  if (raw === undefined) return;
  const parsed = Number(raw);
  // A malformed weight is ignored on the HTML path too.
  if (!Number.isFinite(parsed) || parsed < 0) return;
  if (parsed === 0) {
    applyProtectiveSignal(ctx, "zero-weight", detail);
    return;
  }
  // A weight that only applies on one branch cannot be asserted, but it is a
  // ranking hint rather than a protection: drop it instead of withholding.
  if (ctx.controlDepth === 0) ctx.weight ??= parsed;
}

function inspectMetaElement(attrs: ResolvedAttrs, ctx: SvelteScanContext): void {
  const nameAttr = attrs.values.get("name");
  if (!nameAttr) return;
  const rendered = attrAsString(nameAttr);
  if (rendered === undefined) {
    markUnresolved(ctx, "<meta name={expression}>");
    return;
  }

  const metaName = rendered.toLowerCase();
  const content = attrs.values.get("content");
  const contentText = content ? attrAsString(content) : undefined;
  const contentUnresolvable = content !== undefined && contentText === undefined;

  if (metaName === "robots" && ctx.respectRobotsNoindex) {
    if (contentUnresolvable) markUnresolved(ctx, '<meta name="robots" content={expression}>');
    else if (contentText && /\bnoindex\b/i.test(contentText)) {
      applyProtectiveSignal(ctx, "noindex", '<meta name="robots" content="noindex">');
    }
    return;
  }

  if (metaName === "searchsocket:noindex") {
    if (contentUnresolvable) {
      markUnresolved(ctx, '<meta name="searchsocket:noindex" content={expression}>');
    } else if (contentText === "true") {
      applyProtectiveSignal(ctx, "noindex", '<meta name="searchsocket:noindex" content="true">');
    }
    return;
  }

  if (metaName !== "searchsocket-weight") return;
  if (contentUnresolvable) {
    markUnresolved(ctx, '<meta name="searchsocket-weight" content={expression}>');
    return;
  }
  applyWeight(ctx, contentText, '<meta name="searchsocket-weight" content="0">');
}

/**
 * The tag this element renders as. `<svelte:element this={'meta'}>` is a meta
 * tag whenever the literal says so; a computed one is not decidable here.
 */
function renderedTagName(node: ParsedNode, attrs: ResolvedAttrs): string {
  const name = node.name ?? "";
  if (name !== "svelte:element") return name;
  const thisAttr = attrs.values.get("this");
  const rendered = thisAttr ? attrAsString(thisAttr) : undefined;
  return rendered ?? name;
}

/**
 * Inspect one element for the exclusion and weight signals the HTML extractor
 * honours. Only statically decidable forms are recognised — this deliberately
 * does not emulate a Svelte runtime.
 */
function inspectSvelteElement(node: ParsedNode, attrs: ResolvedAttrs, ctx: SvelteScanContext): void {
  inspectSpreads(node, attrs, ctx);

  // The page-level opt-out attribute is presence-only on the HTML path.
  if (attrs.values.has(ctx.noindexAttr)) {
    applyProtectiveSignal(ctx, "noindex", `[${ctx.noindexAttr}]`);
  }

  const name = renderedTagName(node, attrs);
  if (isComponentTag(node.name ?? "")) {
    inspectComponentElement(node, attrs, ctx);
    return;
  }

  if (name.toLowerCase() === "meta") inspectMetaElement(attrs, ctx);
}

// --- Walking ---------------------------------------------------------------

/** Exact lower-case spelling only: `<Script />` is a component, not a script. */
const NON_TEMPLATE_TAGS = new Set(["script", "style"]);

interface WalkFrame {
  node: ParsedNode;
  collectText: boolean;
}

/**
 * Walk the parsed template in document order. Iterative rather than recursive:
 * a deeply nested template must not overflow the stack while the whole point of
 * the pass is to keep a page from leaking.
 */
function walkSvelteNodes(roots: ParsedNode[], ctx: SvelteScanContext): void {
  const stack: WalkFrame[] = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i]!, collectText: true });

  while (stack.length > 0) {
    const { node, collectText } = stack.pop()!;

    if (node.type === "text") {
      if (collectText && node.data) ctx.textParts.push(node.data);
      applyControlFlow(node.data ?? "", ctx);
      continue;
    }

    if (node.type === "comment") {
      // The Markdown escape hatch, written straight into the Svelte template.
      if (/^\s*noindex\s*$/i.test(node.data ?? "")) {
        applyProtectiveSignal(ctx, "noindex", "<!-- noindex -->");
      }
      continue;
    }

    if (node.type !== "tag" && node.type !== "script" && node.type !== "style") continue;

    const attrs = resolveAttrs(node.attribs ?? {}, ctx.groups);
    // Element-level protections are read before deciding whether to descend, so
    // `<script data-search-noindex>` still withholds the page.
    inspectSvelteElement(node, attrs, ctx);
    if (NON_TEMPLATE_TAGS.has(node.name ?? "")) continue;

    // An ignored element loses its body text, not merely its attribute — but
    // the HTML extractor still sees page-level signals inside it, so the walk
    // continues with text collection off.
    const ignored = attrs.values.has(ctx.ignoreAttr);
    const children = node.children;
    if (!children?.length) continue;
    // Remember that text was deliberately discarded. A page whose whole body
    // was ignored otherwise looks indistinguishable from one we failed to read.
    if (ignored && collectText) ctx.droppedIgnoredText = true;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i]!, collectText: collectText && !ignored });
    }
  }
}

/** Track `{#...}` / `{/...}` nesting across one text node. */
function applyControlFlow(text: string, ctx: SvelteScanContext): void {
  for (const match of text.matchAll(/\{([#/])\}/g)) {
    if (match[1] === "#") {
      ctx.conditionalBlocks++;
      ctx.controlDepth++;
    } else {
      ctx.controlDepth = Math.max(0, ctx.controlDepth - 1);
    }
  }
}

/**
 * htmlparser2 rather than the default parse5: raw Svelte is not a document, and
 * HTML tree repair actively hurts here. parse5 renests siblings under a
 * self-closing `<Widget />`, moves `{#if}` markers out of a `<table>`, and
 * lowercases `<Script />` into a raw-text element that swallows the rest of the
 * file — each one hiding a signal or losing text.
 */
const SVELTE_PARSER_OPTIONS = {
  xml: {
    xmlMode: false,
    recognizeSelfClosing: true,
    lowerCaseTags: false,
    lowerCaseAttributeNames: true
  }
} as const;

/**
 * Read the statically decidable exclusion and weight signals out of raw Svelte
 * source, and render the remaining template text.
 *
 * Raw source is not a rendered page: `{#if}` branches contribute text whatever
 * they would render, and a signal behind an expression cannot be evaluated.
 * Rather than silently equating the two, anything undecidable is reported in
 * `unresolved` and withholds the page.
 */
export function analyzeSvelteSource(
  source: string,
  config: ResolvedSearchSocketConfig
): SvelteSourceAnalysis {
  const { masked, groups } = maskSvelteExpressions(source);
  const $ = load(masked, SVELTE_PARSER_OPTIONS, false);
  const ctx: SvelteScanContext = {
    noindexAttr: config.extract.noindexAttr.toLowerCase(),
    ignoreAttr: config.extract.ignoreAttr.toLowerCase(),
    respectRobotsNoindex: config.extract.respectRobotsNoindex,
    groups,
    componentAliases: findComponentAliases(source),
    controlDepth: 0,
    conditionalBlocks: 0,
    droppedIgnoredText: false,
    unresolved: [],
    textParts: []
  };

  const root = $.root()[0] as unknown as ParsedNode | undefined;
  walkSvelteNodes(root?.children ?? [], ctx);

  const text = ctx.textParts
    .join(" ")
    // Prose that *displays* markup (`<pre>&lt;!-- noindex --&gt;</pre>` in this
    // project's own docs) decodes back into the marker the extractor obeys.
    // These are text nodes, not markup, so a shown comment is only ever noise.
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    ...(ctx.excluded ? { excluded: ctx.excluded } : {}),
    ...(ctx.weight !== undefined ? { weight: ctx.weight } : {}),
    unresolved: ctx.unresolved,
    conditionalBlocks: ctx.conditionalBlocks,
    droppedIgnoredText: ctx.droppedIgnoredText,
    text
  };
}

/**
 * Re-encode an analysis as markdown the extractor already understands.
 *
 * A source loader has no channel for an exclusion verdict — the pipeline gets
 * that from the extractor — so the two Markdown escape hatches carry it: the
 * `<!-- noindex -->` comment and `searchsocket` frontmatter. Excluded pages
 * carry no body, so withheld content cannot leak through a later stage.
 */
function svelteAnalysisToMarkdown(analysis: SvelteSourceAnalysis, body: string): string {
  if (analysis.excluded === "zero-weight") {
    return matter.stringify("", { searchsocket: { weight: 0 } });
  }
  if (analysis.excluded) {
    return "<!-- noindex -->";
  }
  if (analysis.weight !== undefined) {
    return matter.stringify(body, { searchsocket: { weight: analysis.weight } });
  }
  // Everything the page had to say was inside an ignored subtree. Returning an
  // empty body would read as an extraction failure, which makes the run
  // non-authoritative and leaves whatever was indexed before this element was
  // ignored sitting in the index forever. The operator asked for that content
  // not to be indexed, so say so plainly and let the stale records be removed.
  if (!body.trim() && analysis.droppedIgnoredText) {
    return "<!-- noindex -->";
  }
  return body;
}

/**
 * Tell the operator what the raw-source approximation could not settle. A
 * withheld page is the safe outcome, but only if someone can see it happen.
 */
function reportSvelteAnalysis(
  analysis: SvelteSourceAnalysis,
  relativePath: string,
  logger: Logger
): void {
  if (analysis.unresolved.length > 0) {
    logger.warn(
      `${relativePath}: raw Svelte source carries ${analysis.unresolved.length} exclusion ` +
        `signal${analysis.unresolved.length === 1 ? "" : "s"} that cannot be resolved without ` +
        `rendering (${analysis.unresolved.join("; ")}). The page is being withheld from the index; ` +
        "index the rendered output, or add a source-level exclude rule, if that is wrong."
    );
  }

  if (analysis.conditionalBlocks > 0 && !analysis.excluded) {
    logger.debug(
      `${relativePath}: ${analysis.conditionalBlocks} control-flow block(s) contributed text ` +
        "unconditionally — raw Svelte source is indexed as written, not as rendered."
    );
  }
}

export async function loadContentFilesPages(
  cwd: string,
  config: ResolvedSearchSocketConfig,
  maxPages?: number,
  logger: Logger = new Logger()
): Promise<SourceLoadResult> {
  const contentConfig = config.source.contentFiles;
  if (!contentConfig) {
    throw new Error("content-files config is missing");
  }

  const baseDir = path.resolve(cwd, contentConfig.baseDir);
  const files = await fg(contentConfig.globs, {
    cwd: baseDir,
    absolute: true,
    onlyFiles: true
  });

  // Deterministic order before limiting — see static-output for why.
  files.sort();
  // Limited by URL, not by file: `guide.md` and `guide/index.md` can both
  // serve one URL. See applyMaxPagesByUrl.
  const { selected, limitedBy } = applyMaxPagesByUrl(files, maxPages, (filePath) =>
    filePathToUrl(filePath, baseDir)
  );
  const pages: PageSourceRecord[] = [];
  const failures: SourceFailure[] = [];

  for (const filePath of selected) {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      failures.push({
        target: path.relative(cwd, filePath).replace(/\\/g, "/"),
        reason: error instanceof Error ? error.message : String(error),
        url: filePathToUrl(filePath, baseDir)
      });
      continue;
    }
    let markdown: string;
    let tags: string[] | undefined;

    if (filePath.endsWith(".md")) {
      markdown = raw;
    } else {
      const relativePath = path.relative(cwd, filePath).replace(/\\/g, "/");
      const analysis = analyzeSvelteSource(raw, config);
      reportSvelteAnalysis(analysis, relativePath, logger);

      let body = analysis.text;
      if (isSvelteComponentFile(filePath)) {
        // Component metadata lives in <script>, which the scanner drops.
        const componentName = path.basename(filePath, ".svelte");
        const meta = extractSvelteComponentMeta(raw);
        const componentMarkdown = buildComponentMarkdown(componentName, meta);
        if (componentMarkdown) {
          body = [componentMarkdown, body].filter(Boolean).join("\n\n");
        }
        tags = ["component"];
      }

      markdown = svelteAnalysisToMarkdown(analysis, body);
    }

    const sourceRelativePath = path.relative(cwd, filePath).replace(/\\/g, "/");

    pages.push({
      url: filePathToUrl(filePath, baseDir),
      markdown,
      sourcePath: sourceRelativePath,
      // This loader already knows the file behind the URL, so record it as an
      // exact match rather than letting the route mapper guess at it.
      routeFile: sourceRelativePath,
      routeResolution: "exact",
      outgoingLinks: [],
      ...(tags ? { tags } : {})
    });
  }

  return sourceResult({
    records: pages,
    discoveredCount: files.length,
    failures,
    limitedBy
  });
}
