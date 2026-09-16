// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchsocketScrollToText } from "../src/sveltekit/scroll-to-text";
import type { AfterNavigateParam } from "../src/sveltekit/scroll-to-text";

function makeNavigation(searchParams?: Record<string, string>): AfterNavigateParam {
  const url = new URL("http://localhost/page");
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }
  }
  return { to: { url } };
}

function makeHeading(tag: string, text: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text;
  el.scrollIntoView = vi.fn();
  return el;
}

describe("searchsocketScrollToText", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("is a no-op when navigation.to is null", () => {
    searchsocketScrollToText({ to: null });
  });

  it("is a no-op when no scroll params are present", () => {
    searchsocketScrollToText(makeNavigation());
  });

  it("is a no-op when _sskt is whitespace only", () => {
    const h1 = makeHeading("h1", "Should Not Scroll");
    document.body.appendChild(h1);

    searchsocketScrollToText(makeNavigation({ _sskt: "   " }));

    expect(h1.scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls to an exact heading text match via _ssk", () => {
    const h2 = makeHeading("h2", "Installation");
    document.body.appendChild(makeHeading("h1", "Docs"));
    document.body.appendChild(h2);

    searchsocketScrollToText(makeNavigation({ _ssk: "Installation" }));

    expect(h2.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start"
    });
  });

  it("matches case-insensitively", () => {
    const h3 = makeHeading("h3", "Quick Start Guide");
    document.body.appendChild(h3);

    searchsocketScrollToText(makeNavigation({ _ssk: "quick start guide" }));

    expect(h3.scrollIntoView).toHaveBeenCalled();
  });

  it("normalizes whitespace when matching", () => {
    const h2 = makeHeading("h2", "Getting   Started");
    document.body.appendChild(h2);

    searchsocketScrollToText(makeNavigation({ _ssk: "Getting Started" }));

    expect(h2.scrollIntoView).toHaveBeenCalled();
  });

  it("finds a body text match and highlights the relevant substring", () => {
    const p = document.createElement("p");
    p.textContent = "This paragraph mentions the Installation process for local development.";
    p.scrollIntoView = vi.fn();
    document.body.appendChild(p);

    searchsocketScrollToText(makeNavigation({ _sskt: "Installation process" }));

    expect(p.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start"
    });

    const marker = p.querySelector(".ssk-highlight");
    expect(marker).not.toBeNull();
    expect(marker?.textContent?.toLowerCase()).toContain("installation process");
  });

  it("prefers _sskt over _ssk when both are present", () => {
    const h2 = makeHeading("h2", "Configuration");
    document.body.appendChild(h2);

    const p = document.createElement("p");
    p.textContent = "Install SearchSocket with pnpm add searchsocket.";
    p.scrollIntoView = vi.fn();
    document.body.appendChild(p);

    searchsocketScrollToText(
      makeNavigation({
        _ssk: "Configuration",
        _sskt: "pnpm add searchsocket"
      })
    );

    expect(p.scrollIntoView).toHaveBeenCalled();
    expect(h2.scrollIntoView).not.toHaveBeenCalled();
  });

  it("falls back to the _ssk heading when the _sskt phrase is not on the page", () => {
    // The shape older indexes produced: a snippet excerpted from the embedding
    // prefix, naming a phrase the page never contains.
    const h2 = makeHeading("h2", "Creating worktrees from issues");
    document.body.appendChild(makeHeading("h1", "Create and Link Worktrees"));
    document.body.appendChild(h2);

    searchsocketScrollToText(
      makeNavigation({
        _ssk: "Creating worktrees from issues",
        _sskt: "Create and Link Worktrees Daintree Docs — Creating worktrees from issues Creating"
      })
    );

    expect(h2.scrollIntoView).toHaveBeenCalled();
  });

  it("falls back to _ssk when _sskt is blank", () => {
    const h2 = makeHeading("h2", "Configuration");
    document.body.appendChild(h2);

    searchsocketScrollToText(makeNavigation({ _ssk: "Configuration", _sskt: "   " }));

    expect(h2.scrollIntoView).toHaveBeenCalled();
  });

  it("does nothing when no match exists", () => {
    const h1 = makeHeading("h1", "Unrelated Title");
    document.body.appendChild(h1);

    searchsocketScrollToText(makeNavigation({ _sskt: "Nonexistent Section" }));

    expect(h1.scrollIntoView).not.toHaveBeenCalled();
  });

  it("handles all heading levels (h1-h6)", () => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      document.body.innerHTML = "";
      const heading = makeHeading(`h${level}`, "Target Heading");
      document.body.appendChild(heading);

      searchsocketScrollToText(makeNavigation({ _ssk: "Target Heading" }));

      expect(heading.scrollIntoView).toHaveBeenCalled();
    }
  });

  it("ignores text inside script and style elements", () => {
    const script = document.createElement("script");
    script.textContent = "const installation = true;";
    document.body.appendChild(script);

    const style = document.createElement("style");
    style.textContent = ".installation { color: red; }";
    document.body.appendChild(style);

    const h2 = makeHeading("h2", "Visible heading");
    document.body.appendChild(h2);

    searchsocketScrollToText(makeNavigation({ _sskt: "installation" }));

    expect(h2.scrollIntoView).not.toHaveBeenCalled();
  });

  // --- Cross-node matching tests ---

  it("matches text that spans across child elements", () => {
    const p = document.createElement("p");
    p.scrollIntoView = vi.fn();
    p.appendChild(document.createTextNode("Install "));
    const strong = document.createElement("strong");
    strong.textContent = "SearchSocket";
    p.appendChild(strong);
    p.appendChild(document.createTextNode(" with pnpm"));
    document.body.appendChild(p);

    searchsocketScrollToText(makeNavigation({ _sskt: "Install SearchSocket" }));

    expect(p.scrollIntoView).toHaveBeenCalled();
    // Cross-node: either a highlight span or the ancestor element is highlighted
    const hasHighlight =
      p.querySelector(".ssk-highlight") !== null || p.classList.contains("ssk-highlight");
    expect(hasHighlight).toBe(true);
  });

  it("matches text split across multiple inline elements", () => {
    const p = document.createElement("p");
    p.scrollIntoView = vi.fn();

    const em = document.createElement("em");
    em.textContent = "Getting";
    p.appendChild(em);
    p.appendChild(document.createTextNode(" "));
    const strong = document.createElement("strong");
    strong.textContent = "Started";
    p.appendChild(strong);
    p.appendChild(document.createTextNode(" guide"));
    document.body.appendChild(p);

    searchsocketScrollToText(makeNavigation({ _sskt: "Getting Started" }));

    expect(p.scrollIntoView).toHaveBeenCalled();
  });

  it("matches adjacent elements with no whitespace separator via lenient fallback", () => {
    const p = document.createElement("p");
    p.scrollIntoView = vi.fn();

    const span1 = document.createElement("span");
    span1.textContent = "Deploy";
    p.appendChild(span1);
    const span2 = document.createElement("span");
    span2.textContent = "SearchSocket";
    p.appendChild(span2);
    document.body.appendChild(p);

    searchsocketScrollToText(makeNavigation({ _sskt: "Deploy SearchSocket" }));

    expect(p.scrollIntoView).toHaveBeenCalled();
  });

  it("handles deeply nested text nodes", () => {
    const div = document.createElement("div");
    div.scrollIntoView = vi.fn();

    const p = document.createElement("p");
    const span = document.createElement("span");
    const em = document.createElement("em");
    em.textContent = "deeply nested target";
    span.appendChild(em);
    p.appendChild(span);
    div.appendChild(p);
    document.body.appendChild(div);

    searchsocketScrollToText(makeNavigation({ _sskt: "deeply nested target" }));

    // The match is within a single text node inside <em>, so surroundContents works
    const marker = div.querySelector(".ssk-highlight");
    expect(marker).not.toBeNull();
    expect(marker?.textContent?.toLowerCase()).toContain("deeply nested target");
  });

  // --- Ignored element tests ---

  it("ignores text inside noscript elements", () => {
    const noscript = document.createElement("noscript");
    noscript.textContent = "Enable JavaScript to search";
    document.body.appendChild(noscript);

    const p = document.createElement("p");
    p.textContent = "Visible content";
    p.scrollIntoView = vi.fn();
    document.body.appendChild(p);

    searchsocketScrollToText(makeNavigation({ _sskt: "Enable JavaScript" }));

    expect(p.scrollIntoView).not.toHaveBeenCalled();
  });

  it("ignores text inside template elements", () => {
    const template = document.createElement("template");
    // template.content is a DocumentFragment; text set via innerHTML lands there
    // but setting textContent directly puts a text node as a child of <template>
    template.textContent = "template search target";
    document.body.appendChild(template);

    const h2 = makeHeading("h2", "Real heading");
    document.body.appendChild(h2);

    searchsocketScrollToText(makeNavigation({ _sskt: "template search target" }));

    expect(h2.scrollIntoView).not.toHaveBeenCalled();
  });

  // --- Unicode matching tests ---

  it("matches Unicode text with accented characters", () => {
    const h2 = makeHeading("h2", "Überblick der Dokumentation");
    document.body.appendChild(h2);

    searchsocketScrollToText(makeNavigation({ _sskt: "Überblick der Dokumentation" }));

    expect(h2.scrollIntoView).toHaveBeenCalled();
  });

  it("matches Unicode text case-insensitively", () => {
    const p = document.createElement("p");
    p.textContent = "Die Ärzte empfehlen tägliche Übungen für bessere Gesundheit.";
    p.scrollIntoView = vi.fn();
    document.body.appendChild(p);

    searchsocketScrollToText(makeNavigation({ _sskt: "die ärzte empfehlen" }));

    expect(p.scrollIntoView).toHaveBeenCalled();
    const marker = p.querySelector(".ssk-highlight");
    expect(marker).not.toBeNull();
  });

  it("matches CJK characters", () => {
    const h2 = makeHeading("h2", "日本語ドキュメント");
    document.body.appendChild(h2);

    searchsocketScrollToText(makeNavigation({ _sskt: "日本語ドキュメント" }));

    expect(h2.scrollIntoView).toHaveBeenCalled();
  });

  it("matches text with mixed scripts", () => {
    const p = document.createElement("p");
    p.textContent = "Use the SearchSocket API для поиска на сайте.";
    p.scrollIntoView = vi.fn();
    document.body.appendChild(p);

    searchsocketScrollToText(makeNavigation({ _sskt: "SearchSocket API для поиска" }));

    expect(p.scrollIntoView).toHaveBeenCalled();
  });

  // --- Punctuation and special characters ---

  it("matches text containing punctuation between words", () => {
    const p = document.createElement("p");
    p.textContent = "Use the command-line interface (CLI) for indexing.";
    p.scrollIntoView = vi.fn();
    document.body.appendChild(p);

    searchsocketScrollToText(makeNavigation({ _sskt: "command-line interface" }));

    expect(p.scrollIntoView).toHaveBeenCalled();
    const marker = p.querySelector(".ssk-highlight");
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toContain("command-line interface");
  });

  it("matches when needle has apostrophe", () => {
    const p = document.createElement("p");
    p.textContent = "The plugin won't modify your build output directly.";
    p.scrollIntoView = vi.fn();
    document.body.appendChild(p);

    searchsocketScrollToText(makeNavigation({ _sskt: "won't modify" }));

    expect(p.scrollIntoView).toHaveBeenCalled();
  });

  // --- Edge cases ---

  it("matches the very first text in the document", () => {
    const p = document.createElement("p");
    p.textContent = "First words on the page followed by more content.";
    p.scrollIntoView = vi.fn();
    document.body.appendChild(p);

    searchsocketScrollToText(makeNavigation({ _sskt: "First words on the page" }));

    expect(p.scrollIntoView).toHaveBeenCalled();
  });

  it("matches the very last text in the document", () => {
    document.body.appendChild(makeHeading("h1", "Title"));

    const p = document.createElement("p");
    p.textContent = "Final paragraph content here.";
    p.scrollIntoView = vi.fn();
    document.body.appendChild(p);

    searchsocketScrollToText(makeNavigation({ _sskt: "content here" }));

    expect(p.scrollIntoView).toHaveBeenCalled();
  });

  it("picks the first occurrence when text appears multiple times", () => {
    const p1 = document.createElement("p");
    p1.textContent = "Repeated phrase appears here.";
    p1.scrollIntoView = vi.fn();
    document.body.appendChild(p1);

    const p2 = document.createElement("p");
    p2.textContent = "Repeated phrase appears again.";
    p2.scrollIntoView = vi.fn();
    document.body.appendChild(p2);

    searchsocketScrollToText(makeNavigation({ _sskt: "Repeated phrase" }));

    expect(p1.scrollIntoView).toHaveBeenCalled();
    expect(p2.scrollIntoView).not.toHaveBeenCalled();
  });

  it("handles an empty document body gracefully", () => {
    searchsocketScrollToText(makeNavigation({ _sskt: "anything" }));
    // No error thrown — silent no-op
  });

  it("handles a second call replacing the previous highlight", () => {
    const p1 = document.createElement("p");
    p1.textContent = "Alpha target text in paragraph one.";
    p1.scrollIntoView = vi.fn();
    document.body.appendChild(p1);

    const p2 = document.createElement("p");
    p2.textContent = "Beta target text in paragraph two.";
    p2.scrollIntoView = vi.fn();
    document.body.appendChild(p2);

    searchsocketScrollToText(makeNavigation({ _sskt: "Alpha target" }));
    expect(p1.querySelector(".ssk-highlight")).not.toBeNull();

    searchsocketScrollToText(makeNavigation({ _sskt: "Beta target" }));
    expect(p2.querySelector(".ssk-highlight")).not.toBeNull();
  });
});

// A documentation page repeats every heading in its table of contents, ahead of
// the content. The first occurrence in document order is then a TOC link, and a
// search result for that section scrolled to the list instead of the section.
describe("searchsocketScrollToText with a table of contents", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  function tocLink(text: string): HTMLAnchorElement {
    const a = document.createElement("a");
    a.textContent = text;
    (a as any).scrollIntoView = vi.fn();
    return a;
  }

  it("prefers the section heading over an earlier table-of-contents entry outside nav", () => {
    // An inline "On this page" list is often a <details>, not a <nav>.
    const details = document.createElement("details");
    const link = tocLink("The confirm button");
    details.appendChild(link);
    const heading = makeHeading("h3", "The confirm button");
    document.body.append(details, makeHeading("h2", "Deleting a Worktree"), heading);

    searchsocketScrollToText(makeNavigation({ _ssk: "The confirm button", _sskt: "The confirm button" }));

    expect(heading.scrollIntoView).toHaveBeenCalled();
    expect(link.scrollIntoView).not.toHaveBeenCalled();
  });

  it("finds body text under the section heading rather than an earlier mention", () => {
    const intro = document.createElement("p");
    intro.textContent = "Open the dialog from the card menu.";
    (intro as any).scrollIntoView = vi.fn();
    const section = makeHeading("h2", "Deleting");
    const body = document.createElement("p");
    body.textContent = "Open the dialog from the card menu.";
    (body as any).scrollIntoView = vi.fn();
    document.body.append(intro, section, body);

    searchsocketScrollToText(makeNavigation({ _ssk: "Deleting", _sskt: "Open the dialog from the card menu" }));

    expect(body.scrollIntoView).toHaveBeenCalled();
    expect(intro.scrollIntoView).not.toHaveBeenCalled();
  });

  it("skips a nav match when the heading is not on the page", () => {
    const nav = document.createElement("nav");
    const link = tocLink("Configuration options");
    nav.appendChild(link);
    const para = document.createElement("p");
    para.textContent = "Configuration options live in one file.";
    (para as any).scrollIntoView = vi.fn();
    document.body.append(nav, para);

    searchsocketScrollToText(makeNavigation({ _sskt: "Configuration options" }));

    expect(para.scrollIntoView).toHaveBeenCalled();
    expect(link.scrollIntoView).not.toHaveBeenCalled();
  });

  it("falls back to a nav match when it is the only one", () => {
    const nav = document.createElement("nav");
    const link = tocLink("Only in navigation");
    nav.appendChild(link);
    document.body.append(nav);

    searchsocketScrollToText(makeNavigation({ _sskt: "Only in navigation" }));

    expect(link.scrollIntoView).toHaveBeenCalled();
  });

  it("does not treat a heading inside nav as the section anchor", () => {
    const nav = document.createElement("nav");
    const navHeading = makeHeading("h2", "Setup");
    nav.appendChild(navHeading);
    const heading = makeHeading("h2", "Setup");
    document.body.append(nav, heading);

    searchsocketScrollToText(makeNavigation({ _ssk: "Setup" }));

    expect(heading.scrollIntoView).toHaveBeenCalled();
    expect(navHeading.scrollIntoView).not.toHaveBeenCalled();
  });

  it("stays fast when a phrase repeats across thousands of text nodes in navigation", () => {
    const nav = document.createElement("nav");
    nav.innerHTML = "<span>common phrase </span>".repeat(60_000);
    const para = document.createElement("p");
    para.textContent = "The common phrase in the body.";
    para.scrollIntoView = vi.fn();
    document.body.append(nav, para);

    const started = performance.now();
    searchsocketScrollToText(makeNavigation({ _sskt: "common phrase" }));
    const elapsed = performance.now() - started;

    expect(para.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(2000);
  });
});

