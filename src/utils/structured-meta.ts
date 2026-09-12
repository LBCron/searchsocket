/**
 * Utilities for structured per-page metadata: validation, serialization,
 * HTML meta tag parsing, and Upstash Vector filter string construction.
 */

export type MetaValue = string | number | boolean | string[] | Date;
export type PageMeta = Record<string, MetaValue>;

/** Stored metadata values — Date is converted to epoch ms (number) */
export type StoredMetaValue = string | number | boolean | string[];
export type StoredPageMeta = Record<string, StoredMetaValue>;

const VALID_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function validateMetaKey(key: string): boolean {
  return VALID_KEY_RE.test(key);
}

export function serializeMetaValue(value: MetaValue): { content: string; dataType: string } {
  if (value instanceof Date) {
    return { content: String(value.getTime()), dataType: "date" };
  }
  if (Array.isArray(value)) {
    return { content: value.join(","), dataType: "string[]" };
  }
  if (typeof value === "boolean") {
    return { content: String(value), dataType: "boolean" };
  }
  if (typeof value === "number") {
    return { content: String(value), dataType: "number" };
  }
  return { content: value, dataType: "string" };
}

export function parseMetaValue(content: string, dataType: string): StoredMetaValue {
  switch (dataType) {
    case "number": {
      const n = Number(content);
      return Number.isFinite(n) ? n : content;
    }
    case "boolean":
      return content === "true";
    case "string[]":
      return content ? content.split(",").map((s) => s.trim()) : [];
    case "date": {
      const ms = Number(content);
      return Number.isFinite(ms) ? ms : content;
    }
    default:
      return content;
  }
}

/**
 * Convert a MetaValue to its stored form (Date → epoch ms number).
 */
export function toStoredValue(value: MetaValue): StoredMetaValue {
  if (value instanceof Date) return value.getTime();
  return value;
}

/**
 * Convert a full PageMeta (which may contain Date values) to StoredPageMeta.
 */
export function toStoredMeta(meta: PageMeta): StoredPageMeta {
  const result: StoredPageMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!validateMetaKey(key)) continue;
    result[key] = toStoredValue(value);
  }
  return result;
}

/**
 * Thrown when a filter value cannot be represented in Upstash's filter syntax.
 * Kept local so this module stays importable from the browser bundle, which is
 * why it does not use SearchSocketError.
 */
export class UnsafeFilterValueError extends Error {}

/**
 * Validate a string for use as a single-quoted literal in the Upstash Vector
 * filter DSL.
 *
 * Upstash documents single-quoted literals but specifies **no escape sequence**
 * for an embedded quote or backslash. This function previously doubled quotes
 * SQL-style, which is a guess: if the backend instead treats `\'` as the escape,
 * a value like `x' OR projectId = 'other` survives as filter syntax and widens
 * the query across tenants.
 *
 * Rather than guess, reject. A caller gets a clear error instead of silently
 * wrong — or silently over-broad — results.
 */
export function assertSafeFilterValue(value: string): string {
  if (value.includes("'") || value.includes("\\")) {
    throw new UnsafeFilterValueError(
      "Filter values may not contain a quote or backslash: Upstash Vector's filter " +
        "syntax defines no way to escape them."
    );
  }
  return value;
}

/**
 * Build an Upstash Vector filter string from user-supplied metadata filters.
 * Keys are auto-prefixed with `meta.` for the nested storage layout.
 * Uses `CONTAINS` for string values (works with both scalar and array fields)
 * and `=` for numbers and booleans.
 */
export function buildMetaFilterString(
  filters: Record<string, string | number | boolean>
): string {
  const clauses: string[] = [];

  for (const [key, value] of Object.entries(filters)) {
    if (!validateMetaKey(key)) continue;

    const field = `meta.${key}`;

    if (typeof value === "string") {
      clauses.push(`${field} CONTAINS '${assertSafeFilterValue(value)}'`);
    } else if (typeof value === "boolean") {
      clauses.push(`${field} = ${value}`);
    } else {
      clauses.push(`${field} = ${value}`);
    }
  }

  return clauses.join(" AND ");
}

/**
 * Serialized-metadata budget for a single vector record, in UTF-8 bytes.
 *
 * Upstash documents a 48 KB metadata limit per vector. That is a documented
 * figure rather than one this project has confirmed against a live index,
 * which is precisely why it is a named constant: if the real limit turns out
 * to differ, or a caller wants a safety margin, one edit moves every user of
 * it instead of a magic number scattered through the write path.
 */
export const METADATA_BYTE_BUDGET = 48 * 1024;

/**
 * `TextEncoder` rather than `Buffer.byteLength`: this module is reachable from
 * the browser bundle (SearchSocket.svelte imports it) where `Buffer` does not
 * exist. It is stateless, so a module-level instance is safe to share.
 */
const TEXT_ENCODER = new TextEncoder();

/** Length of a string once encoded as UTF-8, in bytes. */
export function utf8ByteLength(text: string): number {
  return TEXT_ENCODER.encode(text).length;
}

/**
 * Size of a metadata object as it will actually go over the wire.
 *
 * Measured from `JSON.stringify` output, not from the field values: JSON
 * escaping inflates newlines, quotes and control characters, and the braces,
 * commas and key names are part of the payload the backend counts.
 */
export function metadataByteSize(metadata: Record<string, unknown>): number {
  return utf8ByteLength(JSON.stringify(metadata));
}

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes, never mid-character.
 *
 * Slicing by JavaScript characters is what this replaces: a `.slice()` bounds
 * UTF-16 code units, so 30,000 CJK characters still weigh ~90,000 bytes. Here
 * the string is walked a code point at a time, accumulating the UTF-8 width of
 * each, and the cut lands on a code-point boundary — so a multi-byte character
 * is kept whole or dropped whole, and an astral character (a surrogate pair in
 * UTF-16, one four-byte sequence in UTF-8) can never be left half-written.
 *
 * The result is a `slice` of the original rather than an encode/decode round
 * trip, which is not lossless: decoding would silently replace a lone surrogate
 * with U+FFFD and eat a leading byte-order mark, both of which would change
 * text the caller never asked to have changed.
 */
export function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  // Floored: a fractional limit would otherwise let the boundary check pass on
  // a character whose last byte sits past it.
  const limit = Math.floor(maxBytes);
  if (limit <= 0) return "";

  let used = 0;
  let end = 0;
  // `for...of` iterates code points, so a surrogate pair arrives as one unit.
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    // Matches TextEncoder, which emits the 3-byte replacement character for an
    // unpaired surrogate — so this stays consistent with utf8ByteLength().
    const width = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (used + width > limit) break;
    used += width;
    end += char.length;
  }
  return end === text.length ? text : text.slice(0, end);
}
