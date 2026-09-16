import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { extractFromHtmlResult } from "../src/indexing/extractor";

const config = createDefaultConfig("test");

describe("prerendered redirect stubs", () => {
  it("excludes SvelteKit's exact redirect stub instead of failing extraction", () => {
    const html =
      '<script>location.href="/docs/copytree/cli";</script>' +
      '<meta http-equiv="refresh" content="0;url=/docs/copytree/cli">';

    expect(extractFromHtmlResult("/copytree", html, config)).toEqual({
      status: "excluded",
      reason: "redirect",
      detail: "redirects to /docs/copytree/cli"
    });
  });

  it("recognises a conventional stub with a delay, spacing and quoting", () => {
    const html =
      '<html><head><META HTTP-EQUIV="Refresh" CONTENT="5; URL=\'https://example.com/new\'"></head>' +
      "<body><main></main></body></html>";

    const result = extractFromHtmlResult("/old", html, config);
    expect(result).toMatchObject({ status: "excluded", reason: "redirect" });
  });

  it("still indexes a real page that carries a meta refresh alongside content", () => {
    const html =
      '<html><head><title>Status</title><meta http-equiv="refresh" content="30;url=/status"></head>' +
      "<body><main><h1>Status</h1><p>All systems operational.</p></main></body></html>";

    const result = extractFromHtmlResult("/status", html, config);
    expect(result.status).toBe("indexed");
  });

  it("keeps an empty page without a redirect target an extraction failure", () => {
    // A refresh with no URL reloads the page; it is not a redirect, and an
    // empty body is still the signature of a selector regression.
    const html =
      '<html><head><meta http-equiv="refresh" content="60"></head><body><main></main></body></html>';

    expect(extractFromHtmlResult("/reload", html, config).status).toBe("failed");
    expect(
      extractFromHtmlResult("/empty", "<html><body><main></main></body></html>", config).status
    ).toBe("failed");
  });
});

describe("redirect stubs are judged on the original document", () => {
  it("reports a drop rule that empties a real page as a failure, not a redirect", () => {
    const local = createDefaultConfig("test");
    local.extract.dropSelectors = [...local.extract.dropSelectors, ".content"];
    const html =
      '<html><head><title>Live</title><meta http-equiv="refresh" content="60;url=/next"></head>' +
      '<body><main><div class="content"><h1>Live</h1><p>Real content.</p></div></main></body></html>';

    expect(extractFromHtmlResult("/live", html, local).status).toBe("failed");
  });

  it("reports a drop rule matching the root of a refreshing page as a failure", () => {
    const local = createDefaultConfig("test");
    local.extract.dropSelectors = [...local.extract.dropSelectors, "main"];
    const html =
      '<html><head><meta http-equiv="refresh" content="0;url=/elsewhere"></head>' +
      "<body><main><p>Real content.</p></main></body></html>";

    expect(extractFromHtmlResult("/live", html, local).status).toBe("failed");
  });

  it("reports mainSelector text outside the content root as a failure, not a redirect", () => {
    const html =
      '<html><head><meta http-equiv="refresh" content="60;url=/next"></head>' +
      "<body><main></main><article><p>Content outside main.</p></article></body></html>";

    expect(extractFromHtmlResult("/live", html, config).status).toBe("failed");
  });

  it("does not treat a stub redirecting to its own normalized URL as an exclusion", () => {
    // docs.html and docs/index.html both map to /docs.
    const html = '<meta http-equiv="refresh" content="0;url=/docs/">';
    expect(extractFromHtmlResult("/docs", html, config)).toEqual({
      status: "skipped",
      reason: "self-redirect",
      detail: "redirects to /docs/"
    });

    const relative = '<meta http-equiv="refresh" content="0;url=docs/">';
    expect(extractFromHtmlResult("/docs", relative, config).status).toBe("skipped");
  });

  it("recognises a self-redirect through the configured base URL", () => {
    const local = createDefaultConfig("test");
    local.project.baseUrl = "https://example.com";
    const html = '<meta http-equiv="refresh" content="0;url=https://example.com/docs/">';
    expect(extractFromHtmlResult("/docs", html, local).status).toBe("skipped");

    const external = '<meta http-equiv="refresh" content="0;url=https://other.example/docs/">';
    expect(extractFromHtmlResult("/docs", external, local)).toMatchObject({
      status: "excluded",
      reason: "redirect"
    });
  });
});

describe("content exclusions apply before metadata is derived", () => {
  it("does not take the title from an h1 removed by dropSelectors", () => {
    const local = createDefaultConfig("test");
    local.extract.dropSelectors = [...local.extract.dropSelectors, ".private"];
    const html =
      "<html><head><title>Fallback Title</title></head><body><main>" +
      '<h1 class="private">Confidential</h1><p>Public</p></main></body></html>';

    const result = extractFromHtmlResult("/page", html, local);
    expect(result.status).toBe("indexed");
    if (result.status !== "indexed") return;
    expect(result.page.title).toBe("Fallback Title");
    expect(result.page.markdown).not.toContain("Confidential");
  });

  it("does not take the title from an h1 inside an ignored region", () => {
    const html =
      "<html><head><title>Fallback Title</title></head><body><main>" +
      "<div data-search-ignore><h1>Hidden Heading</h1></div><h1>Visible Heading</h1><p>Body</p>" +
      "</main></body></html>";

    const result = extractFromHtmlResult("/page", html, config);
    expect(result.status === "indexed" && result.page.title).toBe("Visible Heading");
  });

  it("honours the ignore attribute on the content root itself", () => {
    const html =
      "<html><head><title>Secret</title></head><body>" +
      "<main data-search-ignore><h1>Secret</h1><p>Do not index this.</p></main></body></html>";

    expect(extractFromHtmlResult("/secret", html, config)).toEqual({
      status: "excluded",
      reason: "ignored"
    });
  });

  it("treats a drop selector that matches the root as an extraction failure", () => {
    const local = createDefaultConfig("test");
    local.extract.dropSelectors = [...local.extract.dropSelectors, "main"];
    const html = "<html><body><main><h1>Title</h1><p>Body</p></main></body></html>";

    expect(extractFromHtmlResult("/page", html, local).status).toBe("failed");
  });
});
