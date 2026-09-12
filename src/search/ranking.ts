import { matchUrlPattern } from "../utils/pattern";
import type { PageHit, ResolvedSearchSocketConfig, ScoreBreakdown, VectorHit } from "../types";

export interface RankedHit {
  hit: VectorHit;
  finalScore: number;
  breakdown?: ScoreBreakdown;
}

function nonNegativeOrZero(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, value);
}

/**
 * Whether incoming anchor text counts as a match for the query.
 *
 * Shared by both rankers: the page-first path previously required the anchor to
 * contain the whole query while the chunk path accepted either containing the
 * other, so anchor "authentication" and query "authentication guide" boosted
 * one mode and not the other.
 */
function anchorTextMatches(anchorText: string | undefined, normalizedQuery: string): boolean {
  if (!anchorText || !normalizedQuery) return false;
  const normalizedAnchor = normalizeForTitleMatch(anchorText);
  if (normalizedAnchor.length === 0) return false;
  return normalizedAnchor.includes(normalizedQuery) || normalizedQuery.includes(normalizedAnchor);
}

/**
 * Fold a title, anchor or query down to the letters, digits and spaces that
 * lexical matching compares.
 *
 * The class is Unicode-aware (`\p{L}`/`\p{N}`) rather than `a-z0-9`: the ASCII
 * form deleted every non-ASCII letter, so a Japanese, Cyrillic, Greek or
 * accented-Latin title collapsed to the empty string or to a fragment that
 * matched the wrong query, leaving the title and anchor boosts dead on
 * multilingual content.
 *
 * NFC runs after lowercasing so both spellings of a precomposed character
 * (`é` vs `e` + combining acute) fold together, and marks NFC cannot compose
 * away are kept: they are meaningful letters in Devanagari, Thai, Hebrew and
 * Arabic, and dropping them would normalize `दिन` and `दान` alike and boost the
 * wrong word. Accents are preserved rather than folded — accent-insensitive
 * recall would be a separate, script-aware policy. Variation selectors are
 * marks that carry no text, so they go before the class runs.
 */
function normalizeForTitleMatch(text: string): string {
  const normalized = text
    .toLowerCase()
    .normalize("NFC")
    .replace(/[\uFE00-\uFE0F]/g, "")
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(normalized) ? normalized : "";
}

export function rankHits(hits: VectorHit[], config: ResolvedSearchSocketConfig, query?: string, debug?: boolean): RankedHit[] {
  const normalizedQuery = query ? normalizeForTitleMatch(query) : "";
  const titleMatchWeight = config.ranking.weights.titleMatch;

  return hits
    .map((hit) => {
      const baseScore = Number.isFinite(hit.score) ? hit.score : Number.NEGATIVE_INFINITY;
      let score = baseScore;

      let incomingLinkBoostValue = 0;
      if (config.ranking.enableIncomingLinkBoost) {
        const incomingBoost = Math.log(1 + nonNegativeOrZero(hit.metadata.incomingLinks));
        incomingLinkBoostValue = incomingBoost * config.ranking.weights.incomingLinks;
        score += incomingLinkBoostValue;
      }

      let depthBoostValue = 0;
      if (config.ranking.enableDepthBoost) {
        const depthBoost = 1 / (1 + nonNegativeOrZero(hit.metadata.depth));
        depthBoostValue = depthBoost * config.ranking.weights.depth;
        score += depthBoostValue;
      }

      let titleMatchBoostValue = 0;
      if (normalizedQuery && titleMatchWeight > 0) {
        const normalizedTitle = normalizeForTitleMatch(hit.metadata.title);
        if (normalizedQuery.length > 0 && normalizedTitle.length > 0 &&
            (normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle))) {
          titleMatchBoostValue = titleMatchWeight;
          score += titleMatchBoostValue;
        }
      }

      let freshnessBoostValue = 0;
      if (config.ranking.enableFreshnessBoost) {
        const publishedAt = hit.metadata.publishedAt;
        if (typeof publishedAt === "number" && Number.isFinite(publishedAt)) {
          const daysSince = Math.max(0, (Date.now() - publishedAt) / 86_400_000);
          const decay = 1 / (1 + nonNegativeOrZero(daysSince) * config.ranking.freshnessDecayRate);
          freshnessBoostValue = decay * config.ranking.weights.freshness;
          score += freshnessBoostValue;
        }
      }

      let anchorTextMatchBoostValue = 0;
      if (config.ranking.enableAnchorTextBoost && normalizedQuery && config.ranking.weights.anchorText > 0) {
        if (anchorTextMatches(hit.metadata.incomingAnchorText, normalizedQuery)) {
          anchorTextMatchBoostValue = config.ranking.weights.anchorText;
          score += anchorTextMatchBoostValue;
        }
      }

      const result: RankedHit = {
        hit,
        finalScore: Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY
      };

      if (debug) {
        result.breakdown = {
          baseScore,
          incomingLinkBoost: incomingLinkBoostValue,
          depthBoost: depthBoostValue,
          titleMatchBoost: titleMatchBoostValue,
          freshnessBoost: freshnessBoostValue,
          anchorTextMatchBoost: anchorTextMatchBoostValue
        };
      }

      return result;
    })
    .sort((a, b) => {
      const delta = b.finalScore - a.finalScore;
      return Number.isNaN(delta) ? 0 : delta;
    });
}

export function findPageWeight(url: string, pageWeights: Record<string, number>): number {
  // Try each pattern — most specific match wins (longest pattern)
  let bestPattern = "";
  let bestWeight = 1;

  for (const [pattern, weight] of Object.entries(pageWeights)) {
    if (matchUrlPattern(url, pattern) && pattern.length > bestPattern.length) {
      bestPattern = pattern;
      bestWeight = weight;
    }
  }

  return bestWeight;
}

/**
 * Page-first ranking: rank pages by their page-level embedding similarity,
 * then apply page-level boosts (pageWeights, depth, incoming links, title match, etc.)
 */
export interface RankedPage {
  url: string;
  title: string;
  description: string;
  routeFile: string;
  depth: number;
  incomingLinks: number;
  tags: string[];
  baseScore: number;
  finalScore: number;
  publishedAt?: number;
  /** Effective weight applied, resolved from the page itself or config. */
  pageWeight: number;
  breakdown?: PageScoreBreakdown;
}

export interface PageScoreBreakdown {
  baseScore: number;
  pageWeight: number;
  anchorTextMatchBoost?: number;
  incomingLinkBoost: number;
  depthBoost: number;
  titleMatchBoost: number;
  freshnessBoost: number;
}

export function rankPageHits(
  pageHits: PageHit[],
  config: ResolvedSearchSocketConfig,
  query?: string,
  debug?: boolean
): RankedPage[] {
  const normalizedQuery = query ? normalizeForTitleMatch(query) : "";
  const titleMatchWeight = config.ranking.weights.titleMatch;

  return pageHits
    .map((hit) => {
      const baseScore = Number.isFinite(hit.score) ? hit.score : Number.NEGATIVE_INFINITY;
      let score = baseScore;

      let incomingLinkBoostValue = 0;
      if (config.ranking.enableIncomingLinkBoost) {
        const incomingBoost = Math.log(1 + nonNegativeOrZero(hit.incomingLinks));
        incomingLinkBoostValue = incomingBoost * config.ranking.weights.incomingLinks;
        score += incomingLinkBoostValue;
      }

      let depthBoostValue = 0;
      if (config.ranking.enableDepthBoost) {
        const depthBoost = 1 / (1 + nonNegativeOrZero(hit.depth));
        depthBoostValue = depthBoost * config.ranking.weights.depth;
        score += depthBoostValue;
      }

      let titleMatchBoostValue = 0;
      if (normalizedQuery && titleMatchWeight > 0) {
        const normalizedTitle = normalizeForTitleMatch(hit.title);
        if (normalizedQuery.length > 0 && normalizedTitle.length > 0 &&
            (normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle))) {
          titleMatchBoostValue = titleMatchWeight;
          score += titleMatchBoostValue;
        }
      }

      let freshnessBoostValue = 0;
      if (config.ranking.enableFreshnessBoost) {
        const publishedAt = hit.publishedAt;
        if (typeof publishedAt === "number" && Number.isFinite(publishedAt)) {
          const daysSince = Math.max(0, (Date.now() - publishedAt) / 86_400_000);
          const decay = 1 / (1 + nonNegativeOrZero(daysSince) * config.ranking.freshnessDecayRate);
          freshnessBoostValue = decay * config.ranking.weights.freshness;
          score += freshnessBoostValue;
        }
      }

      let anchorTextMatchBoostValue = 0;
      if (config.ranking.enableAnchorTextBoost && normalizedQuery && config.ranking.weights.anchorText > 0) {
        if (anchorTextMatches(hit.incomingAnchorText, normalizedQuery)) {
          anchorTextMatchBoostValue = config.ranking.weights.anchorText;
          score += anchorTextMatchBoostValue;
        }
      }

      // A per-page weight declared on the page itself takes precedence over a
      // config pattern: it is the more specific statement about that page.
      // Only the config side was ever applied here, so `searchsocket-weight`
      // and frontmatter weights did nothing beyond dropping zero-weight pages.
      const configWeight = findPageWeight(hit.url, config.ranking.pageWeights);
      const declaredWeight =
        typeof hit.weight === "number" && Number.isFinite(hit.weight) && hit.weight >= 0
          ? hit.weight
          : undefined;
      // A zero from either source suppresses the page. Config zero is an
      // operator-level veto and must not be overridable by page markup;
      // otherwise the page's own weight is the more specific statement.
      const pageWeight =
        configWeight === 0 || declaredWeight === 0 ? 0 : declaredWeight ?? configWeight;
      if (pageWeight !== 1) {
        score *= pageWeight;
      }

      const result: RankedPage = {
        url: hit.url,
        title: hit.title,
        description: hit.description,
        routeFile: hit.routeFile,
        depth: hit.depth,
        incomingLinks: hit.incomingLinks,
        tags: hit.tags,
        baseScore,
        finalScore: Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY,
        publishedAt: hit.publishedAt,
        pageWeight
      };

      if (debug) {
        result.breakdown = {
          baseScore,
          pageWeight,
          incomingLinkBoost: incomingLinkBoostValue,
          depthBoost: depthBoostValue,
          titleMatchBoost: titleMatchBoostValue,
          freshnessBoost: freshnessBoostValue,
          anchorTextMatchBoost: anchorTextMatchBoostValue,
        };
      }

      return result;
    })
    .filter((p) => p.pageWeight !== 0)
    .sort((a, b) => {
      const delta = b.finalScore - a.finalScore;
      return Number.isNaN(delta) ? 0 : delta;
    });
}

/**
 * Trim ranked pages by score gap: drop pages scoring far below the best hit.
 */
export function trimPagesByScoreGap(
  results: RankedPage[],
  config: ResolvedSearchSocketConfig
): RankedPage[] {
  if (results.length === 0) return results;

  const threshold = config.ranking.scoreGapThreshold;
  const minScoreRatio = config.ranking.minScoreRatio;

  // Relative ratio thresholding: drop results scoring below X% of the top result
  if (minScoreRatio > 0 && results.length > 0) {
    const topScore = results[0]!.finalScore;
    if (Number.isFinite(topScore) && topScore > 0) {
      const minThreshold = topScore * minScoreRatio;
      results = results.filter((r) => r.finalScore >= minThreshold);
    }
  }

  // Score-gap trimming
  if (threshold > 0 && results.length > 1) {
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1]!.finalScore;
      const current = results[i]!.finalScore;
      if (prev > 0) {
        const gap = (prev - current) / prev;
        if (gap >= threshold) {
          return results.slice(0, i);
        }
      }
    }
  }

  return results;
}
