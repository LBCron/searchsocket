import type { PageSourceRecord } from "../../types";

/**
 * Why a source loader stopped short of observing every available page.
 * Any value here makes the run non-authoritative.
 *
 * `max-sitemaps` is discovery-side rather than load-side: the loader never
 * enumerated some of the pages at all, so `discoveredCount` may understate the
 * site rather than merely exceeding `records.length`.
 */
export type SourceLimitReason = "max-pages" | "max-depth" | "timeout" | "max-sitemaps";

export interface SourceFailure {
  /** The route, URL, or file path that could not be loaded. */
  target: string;
  reason: string;
}

/**
 * The result of a source loader.
 *
 * `records` alone is not enough to drive stale-record deletion: the pipeline
 * must know whether the loader actually observed the complete source of truth.
 * A run that hit `--max-pages`, skipped a failed fetch, or aborted traversal
 * has only a partial view, and diffing that view against the remote index
 * would delete perfectly valid records.
 */
export interface SourceLoadResult {
  records: PageSourceRecord[];
  /**
   * True only when the loader enumerated every page the source exposes and
   * loaded each one successfully. False makes the run deletion-ineligible.
   */
  complete: boolean;
  /**
   * Pages the loader actually enumerated, before page selection. A
   * discovery-side limit (see `SourceLimitReason`) can cut this short too, so
   * it is not always the site's total.
   */
  discoveredCount: number;
  /** Pages that were discovered but could not be loaded. */
  failures: SourceFailure[];
  limitedBy?: SourceLimitReason;
}

/** A loader that saw everything and loaded it all. */
export function completeSource(records: PageSourceRecord[]): SourceLoadResult {
  return {
    records,
    complete: true,
    discoveredCount: records.length,
    failures: []
  };
}

/**
 * Build a result from a discovery count plus whatever actually loaded.
 * The run is complete only when nothing was truncated and nothing failed.
 */
export function sourceResult(opts: {
  records: PageSourceRecord[];
  discoveredCount: number;
  failures?: SourceFailure[];
  limitedBy?: SourceLimitReason;
}): SourceLoadResult {
  const failures = opts.failures ?? [];
  return {
    records: opts.records,
    complete: failures.length === 0 && opts.limitedBy === undefined,
    discoveredCount: opts.discoveredCount,
    failures,
    ...(opts.limitedBy ? { limitedBy: opts.limitedBy } : {})
  };
}

/**
 * Apply a `--max-pages` limit, recording the truncation so the pipeline can
 * refuse to delete. Sorting is the caller's responsibility — the slice must be
 * deterministic or repeated limited runs churn different subsets.
 */
export function applyMaxPages<T>(
  items: T[],
  maxPages: number | undefined
): { selected: T[]; limitedBy?: SourceLimitReason } {
  if (typeof maxPages !== "number") return { selected: items };
  const limit = Math.max(0, Math.floor(maxPages));
  if (items.length <= limit) return { selected: items };
  return { selected: items.slice(0, limit), limitedBy: "max-pages" };
}
