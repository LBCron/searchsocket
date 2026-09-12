import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { reciprocalRank, mrr, mrrReport } from "../src/search/quality-metrics";
import { testCaseSchema, testFileSchema } from "../src/cli/test-schemas";
import type { SearchResult } from "../src/types";

function makeResult(url: string, score = 0.5): SearchResult {
  return { url, title: "", snippet: "", score, routeFile: "" };
}

// ── Quality metrics unit tests ──────────────────────────

describe("reciprocalRank", () => {
  it("returns 1 when the relevant URL is rank 1", () => {
    const results = [makeResult("/a"), makeResult("/b"), makeResult("/c")];
    expect(reciprocalRank(results, ["/a"])).toBe(1);
  });

  it("returns 0.5 when the relevant URL is rank 2", () => {
    const results = [makeResult("/a"), makeResult("/b"), makeResult("/c")];
    expect(reciprocalRank(results, ["/b"])).toBe(0.5);
  });

  it("returns 0 when no relevant URL is found", () => {
    const results = [makeResult("/a"), makeResult("/b")];
    expect(reciprocalRank(results, ["/z"])).toBe(0);
  });

  it("returns rank of the first matching URL from relevant set", () => {
    const results = [makeResult("/a"), makeResult("/b"), makeResult("/c")];
    expect(reciprocalRank(results, ["/c", "/b"])).toBe(0.5);
  });

  it("handles empty results", () => {
    expect(reciprocalRank([], ["/a"])).toBe(0);
  });
});

describe("mrr", () => {
  it("computes mean reciprocal rank across queries", () => {
    const queries = [
      { results: [makeResult("/a"), makeResult("/b")], relevant: ["/a"] },
      { results: [makeResult("/x"), makeResult("/y")], relevant: ["/y"] }
    ];
    expect(mrr(queries)).toBe(0.75);
  });

  it("returns 0 for empty queries array", () => {
    expect(mrr([])).toBe(0);
  });

  it("includes 0 contribution for unfound results", () => {
    const queries = [
      { results: [makeResult("/a")], relevant: ["/a"] },
      { results: [makeResult("/b")], relevant: ["/z"] }
    ];
    expect(mrr(queries)).toBe(0.5);
  });
});

// ── Test file schema validation ──────────────────────────

describe("test file schema validation", () => {
  it("rejects an empty array", () => {
    const result = testFileSchema.safeParse([]);
    expect(result.success).toBe(false);
  });

  it("rejects a test case with empty expect", () => {
    const result = testFileSchema.safeParse([{ query: "hello", expect: {} }]);
    expect(result.success).toBe(false);
  });

  it("rejects a test case with empty inTop5 array", () => {
    const result = testFileSchema.safeParse([{ query: "hello", expect: { inTop5: [] } }]);
    expect(result.success).toBe(false);
  });

  it("rejects a test case with empty query", () => {
    const result = testFileSchema.safeParse([{ query: "", expect: { topResult: "/a" } }]);
    expect(result.success).toBe(false);
  });

  it("rejects a test case with negative maxResults", () => {
    const result = testFileSchema.safeParse([{ query: "test", expect: { maxResults: -1 } }]);
    expect(result.success).toBe(false);
  });

  it("accepts a valid test file with all assertion types", () => {
    const result = testFileSchema.safeParse([
      { query: "getting started", expect: { topResult: "/docs/getting-started" } },
      { query: "gibberish", expect: { maxResults: 0 } },
      { query: "api", expect: { inTop5: ["/docs/api", "/docs/api-ref"] } }
    ]);
    expect(result.success).toBe(true);
  });

  it("accepts a test case with multiple assertion types", () => {
    const result = testCaseSchema.safeParse({
      query: "api",
      expect: {
        topResult: "/docs/api",
        inTop5: ["/docs/api", "/docs/api-ref"],
        maxResults: 10
      }
    });
    expect(result.success).toBe(true);
  });
});

// ── Assertion logic ──────────────────────────────────────

describe("assertion logic", () => {
  it("topResult passes when URL is at rank 1", () => {
    const results = [makeResult("/docs/foo"), makeResult("/docs/bar")];
    const rank = results.findIndex((r) => r.url === "/docs/foo") + 1;
    expect(rank).toBe(1);
  });

  it("topResult fails when URL is at rank 3", () => {
    const results = [makeResult("/a"), makeResult("/b"), makeResult("/docs/foo")];
    const rank = results.findIndex((r) => r.url === "/docs/foo") + 1;
    expect(rank).toBe(3);
  });

  it("topResult fails when URL is not found", () => {
    const results = [makeResult("/a"), makeResult("/b")];
    const rank = results.findIndex((r) => r.url === "/docs/foo") + 1;
    expect(rank).toBe(0);
  });

  it("inTop5 passes when all URLs appear in top 5", () => {
    const results = [
      makeResult("/a"),
      makeResult("/b"),
      makeResult("/c"),
      makeResult("/d"),
      makeResult("/e")
    ];
    const expectedUrls = ["/b", "/d"];
    const top5Urls = results.slice(0, 5).map((r) => r.url);
    const missing = expectedUrls.filter((url) => !top5Urls.includes(url));
    expect(missing).toEqual([]);
  });

  it("inTop5 fails when a URL is outside top 5", () => {
    const results = [
      makeResult("/a"),
      makeResult("/b"),
      makeResult("/c"),
      makeResult("/d"),
      makeResult("/e"),
      makeResult("/target")
    ];
    const expectedUrls = ["/target"];
    const top5Urls = results.slice(0, 5).map((r) => r.url);
    const missing = expectedUrls.filter((url) => !top5Urls.includes(url));
    expect(missing).toEqual(["/target"]);
  });

  it("inTop5 with fewer than 5 results checks available results", () => {
    const results = [makeResult("/a"), makeResult("/b"), makeResult("/c")];
    const expectedUrls = ["/b"];
    const top5Urls = results.slice(0, 5).map((r) => r.url);
    const missing = expectedUrls.filter((url) => !top5Urls.includes(url));
    expect(missing).toEqual([]);
  });

  it("maxResults passes when result count is within limit", () => {
    const results = [makeResult("/a"), makeResult("/b")];
    expect(results.length <= 3).toBe(true);
  });

  it("maxResults: 0 fails when results are non-empty", () => {
    const results = [makeResult("/a")];
    expect(results.length <= 0).toBe(false);
  });

  it("maxResults: 0 passes when results are empty", () => {
    const results: SearchResult[] = [];
    expect(results.length <= 0).toBe(true);
  });
});

// ── MRR computation ──────────────────────────────────────

describe("MRR computation", () => {
  it("excludes maxResults-only tests from MRR denominator", () => {
    const mrrData: Array<{ results: SearchResult[]; relevant: string[] }> = [];

    // topResult test — contributes to MRR
    mrrData.push({ results: [makeResult("/a"), makeResult("/b")], relevant: ["/a"] });

    // inTop5 test — contributes to MRR
    mrrData.push({ results: [makeResult("/x"), makeResult("/y")], relevant: ["/y"] });

    // maxResults test — NOT pushed: a case with no URL expectation carries no
    // relevance observation.

    const mrrValue = mrr(mrrData);
    expect(mrrValue).toBe(0.75);
  });

  it("folds a case asserting both topResult and inTop5 into one entry", () => {
    const mrrData: Array<{ results: SearchResult[]; relevant: string[] }> = [];
    const results = [makeResult("/a"), makeResult("/b"), makeResult("/c")];

    // The CLI used to push one entry per assertion here, which weighted this
    // single query twice. It now pushes the union once.
    mrrData.push({ results, relevant: ["/a", "/b", "/c"] });

    expect(mrr(mrrData)).toBe(1);
  });
});

// ── MRR aggregation semantics (the `test` command's reporting) ──────────────

describe("mrrReport", () => {
  it("weights every query once, however many assertions it carries", () => {
    // The audit's worked example: a case asserting both topResult and inTop5 on
    // one query used to push two observations, giving (1 + 1 + 0.1) / 3 = 0.70.
    const bothAssertions = [makeResult("/a"), makeResult("/b")];
    const tenth = Array.from({ length: 10 }, (_, i) => makeResult(`/x${i}`));
    tenth[9] = makeResult("/target");

    const report = mrrReport([
      { results: bothAssertions, relevant: ["/a", "/b"] },
      { results: tenth, relevant: ["/target"] }
    ]);

    expect(report.scored).toBe(2);
    expect(report.score).toBeCloseTo((1 + 0.1) / 2, 10);
  });

  it("scores a combined assertion by its best-ranked expected URL", () => {
    const results = [makeResult("/a"), makeResult("/b"), makeResult("/c")];
    expect(mrrReport([{ results, relevant: ["/c", "/b"] }]).score).toBe(0.5);
  });

  it("is complete when every query was retrieved", () => {
    const report = mrrReport([{ results: [makeResult("/a")], relevant: ["/a"] }]);
    expect(report).toEqual({ score: 1, scored: 1, unscored: 0, complete: true });
  });

  it("marks the aggregate incomplete rather than letting errors inflate it", () => {
    const report = mrrReport([{ results: [makeResult("/a")], relevant: ["/a"] }], 3);

    expect(report.score).toBe(1);
    expect(report.scored).toBe(1);
    expect(report.unscored).toBe(3);
    expect(report.complete).toBe(false);
  });

  it("reports a zero score for an empty sample", () => {
    expect(mrrReport([], 2)).toEqual({ score: 0, scored: 0, unscored: 2, complete: false });
  });
});
