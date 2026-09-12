import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { Logger } from "../src/core/logger";
import { extractFromHtmlResult, extractFromMarkdownResult } from "../src/indexing/extractor";
import { analyzeSvelteSource, loadContentFilesPages } from "../src/indexing/sources/content-files";
import type { ExtractionResult } from "../src/indexing/extractor";
import type { ResolvedSearchSocketConfig } from "../src/types";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function testConfig(): ResolvedSearchSocketConfig {
  const config = createDefaultConfig("svelte-exclusion-test");
  config.source.mode = "content-files";
  return config;
}

/**
 * Write a single `+page.svelte`, load it through the content-files source, and
 * run the result through the same extractor the pipeline uses. This is the
 * whole path a raw-Svelte page takes to an indexing decision.
 */
async function indexSvelte(
  source: string,
  config: ResolvedSearchSocketConfig = testConfig()
): Promise<{ result: ExtractionResult; warnings: string[] }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-svelte-exclusion-"));
  tempDirs.push(cwd);
  await fs.mkdir(path.join(cwd, "src", "routes", "secret"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "routes", "secret", "+page.svelte"), source, "utf8");

  config.source.contentFiles = { globs: ["src/routes/**/*.svelte"], baseDir: cwd };

  const warnings: string[] = [];
  const logger = new Logger();
  vi.spyOn(logger, "warn").mockImplementation((message: string) => {
    warnings.push(message);
  });

  const pages = (await loadContentFilesPages(cwd, config, undefined, logger)).records;
  expect(pages).toHaveLength(1);

  return {
    result: extractFromMarkdownResult(pages[0]!.url, pages[0]!.markdown ?? ""),
    warnings
  };
}

describe("raw Svelte exclusion signals", () => {
  it("agrees with the HTML and Markdown modes on a noindex page", async () => {
    const config = testConfig();

    const html = extractFromHtmlResult(
      "/secret",
      '<html><head><meta name="robots" content="noindex"></head><body><main><h1>Secret</h1></main></body></html>',
      config
    );
    const markdown = extractFromMarkdownResult("/secret", "<!-- noindex -->\n\n# Secret\n");
    const { result: svelte } = await indexSvelte(
      '<svelte:head><meta name="robots" content="noindex"></svelte:head>\n<main><h1>Secret</h1></main>',
      config
    );

    expect(html).toEqual({ status: "excluded", reason: "noindex" });
    expect(markdown).toEqual({ status: "excluded", reason: "noindex" });
    expect(svelte).toEqual({ status: "excluded", reason: "noindex" });
  });

  it("agrees with the HTML and Markdown modes on a zero-weight page", async () => {
    const config = testConfig();

    const html = extractFromHtmlResult(
      "/secret",
      '<html><head><meta name="searchsocket-weight" content="0"></head><body><main><h1>Cheap</h1></main></body></html>',
      config
    );
    const markdown = extractFromMarkdownResult(
      "/secret",
      "---\nsearchsocket:\n  weight: 0\n---\n\n# Cheap\n"
    );
    const { result: svelte } = await indexSvelte(
      '<svelte:head><meta name="searchsocket-weight" content="0"></svelte:head>\n<main><h1>Cheap</h1></main>',
      config
    );

    expect(html).toEqual({ status: "excluded", reason: "zero-weight" });
    expect(markdown).toEqual({ status: "excluded", reason: "zero-weight" });
    expect(svelte).toEqual({ status: "excluded", reason: "zero-weight" });
  });

  it("honours <SearchSocket noindex />", async () => {
    const { result, warnings } = await indexSvelte(
      '<script>\n  import { SearchSocket } from "searchsocket/svelte";\n</script>\n\n<SearchSocket noindex />\n<main><h1>Draft</h1><p>Not for the index.</p></main>'
    );

    expect(result).toEqual({ status: "excluded", reason: "noindex" });
    expect(warnings).toEqual([]);
  });

  it("honours <SearchSocket weight={0} />", async () => {
    const { result } = await indexSvelte(
      "<SearchSocket weight={0} />\n<main><h1>Cheap</h1><p>Body text.</p></main>"
    );

    expect(result).toEqual({ status: "excluded", reason: "zero-weight" });
  });

  it("honours the component under a local alias or namespace", async () => {
    const aliased = await indexSvelte(
      '<script>\n  import { SearchSocket as SS } from "searchsocket/svelte";\n</script>\n\n<SS noindex />\n<main><h1>Draft</h1></main>'
    );
    const namespaced = await indexSvelte("<UI.SearchSocket noindex />\n<main><h1>Draft</h1></main>");

    expect(aliased.result).toEqual({ status: "excluded", reason: "noindex" });
    expect(namespaced.result).toEqual({ status: "excluded", reason: "noindex" });
  });

  it("treats a truthy string prop the way Svelte does", async () => {
    const stringFalse = await indexSvelte(
      '<SearchSocket noindex={"false"} />\n<main><h1>Draft</h1></main>'
    );
    const booleanFalse = await indexSvelte(
      "<SearchSocket noindex={false} />\n<main><h1>Public</h1><p>Plenty of prose to extract.</p></main>"
    );

    // `"false"` is a non-empty string, which the component's `{#if noindex}` sees as true.
    expect(stringFalse.result).toEqual({ status: "excluded", reason: "noindex" });
    expect(booleanFalse.result.status).toBe("indexed");
    expect(booleanFalse.warnings).toEqual([]);
  });

  it("honours the configured page-level noindex attribute", async () => {
    const config = testConfig();
    const { result } = await indexSvelte(
      `<main ${config.extract.noindexAttr}><h1>Private</h1></main>`,
      config
    );

    expect(result).toEqual({ status: "excluded", reason: "noindex" });
  });

  it("still sees the noindex attribute past an expression containing '>'", async () => {
    const config = testConfig();
    const { result } = await indexSvelte(
      `<main title={total > 0} ${config.extract.noindexAttr}><h1>Private</h1></main>`,
      config
    );

    expect(result).toEqual({ status: "excluded", reason: "noindex" });
  });

  it("honours a <!-- noindex --> comment written into the template", async () => {
    const { result } = await indexSvelte("<!-- noindex -->\n<main><h1>Withheld</h1></main>");

    expect(result).toEqual({ status: "excluded", reason: "noindex" });
  });

  it("does not treat a noindex comment inside <script> as a page signal", async () => {
    const { result, warnings } = await indexSvelte(
      '<script>\n  const marker = "<!-- noindex -->";\n</script>\n\n<main><h1>Public</h1><p>Ordinary prose that should be indexed.</p></main>'
    );

    expect(result.status).toBe("indexed");
    expect(warnings).toEqual([]);
  });

  it("does not treat markup shown as prose as a page signal", async () => {
    const inExpression = await indexSvelte(
      `<main><p>{'<meta name="robots" content="noindex">'}</p><p>Documentation about exclusion.</p></main>`
    );
    const escaped = await indexSvelte(
      "<main><pre>&lt;!-- noindex --&gt;</pre><p>Documentation about exclusion.</p></main>"
    );

    expect(inExpression.result.status).toBe("indexed");
    expect(escaped.result.status).toBe("indexed");
  });

  it("forwards a literal non-zero weight meta", async () => {
    const { result } = await indexSvelte(
      '<svelte:head><meta name="searchsocket-weight" content="2.5"></svelte:head>\n<main><h1>Boosted</h1><p>Body text for the index.</p></main>'
    );

    expect(result.status).toBe("indexed");
    if (result.status !== "indexed") return;
    expect(result.page.weight).toBe(2.5);
  });

  it("drops the body text of an element carrying the ignore attribute", async () => {
    const config = testConfig();
    const { result } = await indexSvelte(
      `<main><p>Keep this sentence.</p><aside ${config.extract.ignoreAttr}><p>Ignore this secret sentence.</p></aside></main>`,
      config
    );

    expect(result.status).toBe("indexed");
    if (result.status !== "indexed") return;
    expect(result.page.markdown).toContain("Keep this sentence.");
    expect(result.page.markdown).not.toContain("secret sentence");
  });

  it("does not let a self-closing component swallow its following siblings", async () => {
    const config = testConfig();
    const { result } = await indexSvelte(
      `<Widget ${config.extract.ignoreAttr} />\n<main><p>Public prose that must survive.</p></main>`,
      config
    );

    expect(result.status).toBe("indexed");
    if (result.status !== "indexed") return;
    expect(result.page.markdown).toContain("Public prose that must survive.");
  });

  it("does not lose a signal to a component named like a raw-text element", async () => {
    const { result } = await indexSvelte(
      "<p>Private</p>\n<Script />\n<SearchSocket noindex />"
    );

    expect(result).toEqual({ status: "excluded", reason: "noindex" });
  });
});

describe("raw Svelte signals that cannot be resolved statically", () => {
  it("withholds and warns when a noindex signal is behind an expression", async () => {
    const { result, warnings } = await indexSvelte(
      "<SearchSocket noindex={isDraft} />\n<main><h1>Maybe draft</h1></main>"
    );

    expect(result).toEqual({ status: "excluded", reason: "noindex" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("cannot be resolved without rendering");
    expect(warnings[0]).toContain("noindex={expression}");
  });

  it("withholds and warns when a robots meta interpolates an expression", async () => {
    const { result, warnings } = await indexSvelte(
      '<svelte:head><meta name="robots" content="follow, {directive}"></svelte:head>\n<main><h1>Maybe</h1></main>'
    );

    expect(result).toEqual({ status: "excluded", reason: "noindex" });
    expect(warnings).toHaveLength(1);
  });

  it("withholds and warns on a spread that could carry protective metadata", async () => {
    const { result, warnings } = await indexSvelte(
      "<svelte:head><meta {...robotsAttrs}></svelte:head>\n<main><h1>Maybe</h1></main>"
    );

    expect(result).toEqual({ status: "excluded", reason: "noindex" });
    expect(warnings).toHaveLength(1);
  });

  it("withholds and warns when a noindex signal sits inside a control-flow block", async () => {
    const { result, warnings } = await indexSvelte(
      "{#if isDraft}\n  <SearchSocket noindex />\n{/if}\n<main><h1>Maybe draft</h1></main>"
    );

    expect(result).toEqual({ status: "excluded", reason: "noindex" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("inside a control-flow block");
  });

  it("is not fooled by a block marker inside a string literal", async () => {
    const { result, warnings } = await indexSvelte(
      '{#if isDraft}\n  {"{/if}"}\n  <SearchSocket noindex />\n{/if}\n<main><h1>Maybe draft</h1></main>'
    );

    expect(result).toEqual({ status: "excluded", reason: "noindex" });
    expect(warnings[0]).toContain("inside a control-flow block");
  });

  it("keeps a conditional signal conditional inside a table", async () => {
    const { result, warnings } = await indexSvelte(
      "<table>\n  {#if isDraft}\n    <tr><td><SearchSocket noindex /></td></tr>\n  {/if}\n</table>"
    );

    expect(result).toEqual({ status: "excluded", reason: "noindex" });
    expect(warnings[0]).toContain("inside a control-flow block");
  });

  it("indexes conditional text as written, not as rendered — a documented approximation", async () => {
    const { result, warnings } = await indexSvelte(
      "<main>\n  {#if loggedIn}<p>Welcome back friend.</p>{:else}<p>Please sign in first.</p>{/if}\n</main>"
    );

    expect(result.status).toBe("indexed");
    if (result.status !== "indexed") return;
    // Both branches contribute: raw source is not a rendered page.
    expect(result.page.markdown).toContain("Welcome back friend.");
    expect(result.page.markdown).toContain("Please sign in first.");
    // Text-only divergence is not an unresolved protection, so it does not warn.
    expect(warnings).toEqual([]);
  });

  it("survives a template wide enough to overflow a recursive walker", () => {
    const source = `${"<Widget />".repeat(20000)}<main><p>Still here.</p></main>`;

    const analysis = analyzeSvelteSource(source, testConfig());

    expect(analysis.excluded).toBeUndefined();
    expect(analysis.text).toContain("Still here.");
  });

  it("honours noindex in a component file too", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-svelte-exclusion-"));
    tempDirs.push(cwd);
    await fs.mkdir(path.join(cwd, "src", "lib"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "src", "lib", "Internal.svelte"),
      '<!-- @component Internal-only widget. -->\n<div data-search-noindex><p>Internal notes.</p></div>',
      "utf8"
    );

    const config = testConfig();
    config.source.contentFiles = { globs: ["src/lib/**/*.svelte"], baseDir: cwd };

    const pages = (await loadContentFilesPages(cwd, config)).records;
    expect(pages).toHaveLength(1);
    expect(extractFromMarkdownResult(pages[0]!.url, pages[0]!.markdown ?? "")).toEqual({
      status: "excluded",
      reason: "noindex"
    });
    // A withheld page carries no body, so nothing can leak downstream.
    expect(pages[0]!.markdown).not.toContain("Internal notes");
  });
});

/**
 * Shapes that hide a protection from a naive scan: expressions carrying `>` or
 * quotes, braces inside comments and code, interpolation, aliases, spreads, and
 * elements whose rendered identity is not their tag name. Each one is valid
 * Svelte that the rendered-HTML path already excludes.
 */
describe("raw Svelte protections that survive an adversarial template", () => {
  const withheld: [string, string][] = [
    ["an expression containing '>'", `<main title={'a > b'} data-search-noindex>Secret</main>`],
    [
      "an unquoted expression containing a space",
      `<svelte:head><meta name={'robots'} content={'follow, noindex'} /></svelte:head><p>Secret</p>`
    ],
    [
      "a stray brace inside an HTML comment",
      "<!-- { -->\n<main data-search-noindex>Secret</main>\n<!-- } -->\n<p>Also secret</p>"
    ],
    [
      "an apostrophe inside a script comment",
      "<p>Secret</p>\n<script>\n  function f() { // don't\n    return 1;\n  }\n</script>\n<main data-search-noindex>Private</main>"
    ],
    [
      "an apostrophe inside a style comment",
      "<style>\n  .a { /* don't */ color: red; }\n</style>\n<main data-search-noindex>Secret</main>"
    ],
    [
      "a literal interpolated into an attribute",
      `<svelte:head><meta name="robots" content="no{'index'}" /></svelte:head><p>Secret</p>`
    ],
    [
      "a zero weight on an aliased component",
      "<script>import { SearchSocket as SS } from 'searchsocket/svelte';</script>\n<SS weight={0} />\n<p>Secret</p>"
    ],
    [
      "a spread that names a protective attribute",
      `<main {...{'data-search-noindex': true}}>Secret</main>`
    ],
    [
      "a rendered meta behind svelte:element",
      `<svelte:head><svelte:element this={'meta'} name="robots" content="noindex" /></svelte:head><p>Secret</p>`
    ],
    [
      "a boolean content attribute the DOM would stringify",
      `<svelte:head><meta name="searchsocket:noindex" content={true} /></svelte:head><p>Body</p>`
    ],
    [
      "an empty weight, which is zero once numeric",
      `<svelte:head><meta name="searchsocket-weight" content="" /></svelte:head><p>Body</p>`
    ],
    [
      "an entity-encoded prop that is a truthy string",
      "<SearchSocket noindex=\"&#123;false&#125;\" />\n<p>Secret</p>"
    ],
    [
      "an alias that collides with a raw-text tag name",
      "<script>import { SearchSocket as Script } from 'searchsocket/svelte';</script>\n<Script noindex />\n<p>Secret</p>"
    ],
    [
      "a page attribute on a real script element",
      '<svelte:head><script data-search-noindex src="/x.js"></script></svelte:head><p>Secret</p>'
    ]
  ];

  it.each(withheld)("withholds a page carrying %s", (_label, source) => {
    expect(analyzeSvelteSource(source, testConfig()).excluded).toBeDefined();
  });

  it("still publishes pages that only look protected", () => {
    const config = testConfig();

    // Prop shorthand for an unrelated prop is not a signal.
    expect(analyzeSvelteSource("<SearchSocket {tags} />\n<p>Public.</p>", config).excluded).toBeUndefined();
    // Documentation that displays the component is not using it.
    expect(
      analyzeSvelteSource(`{'<SearchSocket noindex />'}<p>Public.</p>`, config).excluded
    ).toBeUndefined();
  });

  it("does not stall on a long run of unmatched braces", () => {
    const started = Date.now();
    analyzeSvelteSource(`<main>${"{".repeat(16000)}</main>`, testConfig());
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
