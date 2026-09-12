/**
 * Quality metrics for search evaluation.
 */
import type { SearchResult } from "../types";

/**
 * Reciprocal rank — returns 1/rank of the first result whose URL appears in `relevant`.
 * Returns 0 if no relevant result is found.
 */
export function reciprocalRank(results: SearchResult[], relevant: string[]): number {
  const set = new Set(relevant);
  for (let i = 0; i < results.length; i++) {
    if (set.has(results[i]!.url)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Mean Reciprocal Rank across multiple queries.
 */
export function mrr(queries: Array<{ results: SearchResult[]; relevant: string[] }>): number {
  if (queries.length === 0) return 0;
  const sum = queries.reduce((acc, q) => acc + reciprocalRank(q.results, q.relevant), 0);
  return sum / queries.length;
}

/** One query's relevance observation. Exactly one per query — see `mrrReport`. */
export interface MrrObservation {
  results: SearchResult[];
  /**
   * Every URL the case expects to be retrieved. A case asserting both
   * `topResult` and `inTop5` contributes their union, once, so the reciprocal
   * rank is that of the best-ranked expected URL.
   */
  relevant: string[];
}

export interface MrrReport {
  score: number;
  /** Queries that produced results and were scored. */
  scored: number;
  /** Queries whose retrieval threw, so they could not be scored at all. */
  unscored: number;
  /** False when `unscored > 0`: the score describes only the queries that ran. */
  complete: boolean;
}

/**
 * Mean Reciprocal Rank plus the completeness of the sample it was taken over.
 *
 * The CLI used to append one entry per assertion, so a case asserting both a
 * top result and a top-5 set weighed twice as much as its neighbours, and a
 * query whose search threw silently left the denominator — making a broken run
 * score higher than a merely bad one. Callers must pass one observation per
 * query and the count of queries that never returned results.
 */
export function mrrReport(observations: MrrObservation[], unscored = 0): MrrReport {
  return {
    score: mrr(observations),
    scored: observations.length,
    unscored,
    complete: unscored === 0
  };
}
