import { describe, expect, expectTypeOf, it } from "vitest";
import * as root from "../src/index";
import * as client from "../src/client";
import type { IndexPipelineOptions, LoggerOptions, SearchEngineOptions } from "../src/index";

describe("public entry points", () => {
  it("exports the Logger that SearchEngineOptions and IndexPipelineOptions accept", () => {
    const options: LoggerOptions = { stderrOnly: true, quiet: true };
    const logger = new root.Logger(options);

    expectTypeOf(logger).toMatchTypeOf<NonNullable<SearchEngineOptions["logger"]>>();
    expectTypeOf(logger).toMatchTypeOf<NonNullable<IndexPipelineOptions["logger"]>>();
    expect(typeof logger.warn).toBe("function");
  });

  it("exports response validation from searchsocket/client", () => {
    const envelope = { q: "x", scope: "main", meta: { timingsMs: { search: 1, total: 1 } } };
    const payload = {
      ...envelope,
      results: [
        { url: "/ok", title: "Ok", snippet: "", score: 1, routeFile: "" },
        { url: "javascript:alert(1)", title: "Bad", snippet: "", score: 1, routeFile: "" }
      ]
    };

    expect(client.parseSearchResponse(payload)?.results.map((r) => r.url)).toEqual(["/ok"]);
    expect(client.isSearchResponse(payload)).toBe(false);
    expect(client.parseSearchResponse({ results: [] })).toBeNull();
    expect(client.isSafeResultUrl("/ok")).toBe(true);
  });
});
