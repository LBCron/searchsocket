import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { extractFromHtml } from "../src/indexing/extractor";
import { markdownToPlain, toSnippet } from "../src/utils/text";

describe("markdownToPlain", () => {
  it("keeps link and image text and drops their targets", () => {
    expect(markdownToPlain("See [MCP Server](/docs/mcp-server) and ![a diagram](/img/x.png).")).toBe(
      "See MCP Server and a diagram."
    );
    expect(markdownToPlain("Read [the guide][guide] or <https://example.com/a-b>.")).toBe(
      "Read the guide or https://example.com/a-b."
    );
  });

  it("keeps hyphens, underscores and hashes that belong to words", () => {
    expect(markdownToPlain("Right-click the card; set max_results in C# or F#.")).toBe(
      "Right-click the card; set max_results in C# or F#."
    );
  });

  it("removes line-level markers only at the start of a line", () => {
    expect(markdownToPlain("## Setup\n\n> Note: read this\n\n- first item\n2. second item\n- [x] done")).toBe(
      "Setup Note: read this first item second item done"
    );
  });

  it("unwraps emphasis, strikethrough and inline code", () => {
    expect(markdownToPlain("A **bold**, *em*, _under_, ~~gone~~ and `code_name` word.")).toBe(
      "A bold, em, under, gone and code_name word."
    );
    expect(markdownToPlain("2 * 3 * 4 and snake_case_name stay")).toBe("2 * 3 * 4 and snake_case_name stay");
  });

  it("flattens tables without their divider rows", () => {
    expect(markdownToPlain("| Action | Shortcut |\n| --- | :---: |\n| Open | Cmd-K |")).toBe(
      "Action Shortcut Open Cmd-K"
    );
  });

  it("drops fenced code blocks and horizontal rules", () => {
    expect(markdownToPlain("before\n```js\nconst x = 1;\n```\n---\nafter")).toBe("before after");
  });

  it("feeds toSnippet", () => {
    expect(toSnippet("Open [Settings](/docs/settings) — right-click to *pin*.")).toBe(
      "Open Settings — right-click to pin."
    );
  });
});

describe("markdownToPlain code spans", () => {
  it("keeps code-span contents verbatim through the emphasis passes", () => {
    expect(markdownToPlain("Define `__init__` and `**kwargs` here.")).toBe("Define __init__ and **kwargs here.");
    expect(markdownToPlain("Use `a || b` or ``x ` y``.")).toBe("Use a || b or x ` y.");
    expect(markdownToPlain("Literal `[link](/x)` stays.")).toBe("Literal [link](/x) stays.");
  });

  it("removes pipes only on table rows", () => {
    expect(markdownToPlain("Run cat file | grep x to filter.")).toBe("Run cat file | grep x to filter.");
    expect(markdownToPlain("| Op | Meaning |\n| --- | --- |\n| `a || b` | either |")).toBe("Op Meaning a || b either");
    expect(markdownToPlain("Name | Value\n--- | ---\nfoo | bar")).toBe("Name Value foo bar");
  });
});

describe("markdownToPlain escapes", () => {
  it("unescapes backslash-escaped punctuation outside code spans", () => {
    expect(markdownToPlain("Set max\\_results to 5 \\*not\\* emphasis; `a\\_b` stays.")).toBe(
      "Set max_results to 5 *not* emphasis; a\\_b stays."
    );
    expect(markdownToPlain("\\[not a link\\](/x) and \\# not a heading")).toBe("[not a link](/x) and # not a heading");
  });

  it("produces page text from turndown output", () => {
    const html = `<html><head><title>Search</title></head><body><main>
      <h1>Search</h1>
      <p>Set max_results to 10, use *wildcards*, [brackets] and a | b.</p>
      <p>Call <code>__init__</code> first.</p>
    </main></body></html>`;
    const page = extractFromHtml("/docs/search", html, createDefaultConfig("p"));
    expect(page).not.toBeNull();
    expect(page!.markdown).toContain("max\\_results");
    const snippet = toSnippet(page!.markdown, 500);
    expect(snippet).toContain("Set max_results to 10, use *wildcards*, [brackets] and a | b.");
    expect(snippet).toContain("Call __init__ first.");
    expect(snippet).not.toContain("\\");
  });
});

describe("markdownToPlain fences", () => {
  it("does not treat a line-leading code span as a fence", () => {
    expect(markdownToPlain("```a``` is inline\nafter")).toBe("a is inline after");
  });

  it("allows backticks in a tilde fence's info string", () => {
    expect(markdownToPlain("before\n~~~ js`x\ncode\n~~~\nafter")).toBe("before after");
  });

  it("closes only on a matching fence", () => {
    expect(markdownToPlain("````\ncode\n```\n~~~~\n```` x\nstill code\n`````  \nafter")).toBe("after");
  });
});

describe("markdownToPlain private-use characters", () => {
  it("keeps U+E000 and U+E001 in text and code spans", () => {
    expect(markdownToPlain("a \uE000x\uE001 `b\uE000\uE0010\uE001` c")).toBe("a \uE000x\uE001 b\uE000\uE0010\uE001 c");
    expect(markdownToPlain("\uE0000\uE001 **\uE000**")).toBe("\uE0000\uE001 \uE000");
  });
});

describe("markdownToPlain nested syntax", () => {
  it("unwraps nested emphasis runs completely", () => {
    expect(markdownToPlain("****foo**** and ***bar*** and **_baz_**")).toBe("foo and bar and baz");
  });

  it("keeps link text when the destination nests parentheses", () => {
    expect(markdownToPlain("See [x](/f(a(b))) and ![img](/p(1).png \"t\") end")).toBe("See x and img end");
    expect(markdownToPlain("Unbalanced [x](/f(a) stays")).toBe("Unbalanced [x](/f(a) stays");
    const deep = (n: number) => `[x](/${"(".repeat(n)}${")".repeat(n)})`;
    expect(markdownToPlain(deep(32))).toBe("x");
    expect(markdownToPlain(deep(33))).toBe(deep(33));
  });
});

describe("markdownToPlain on adversarial input", () => {
  const N = 200_000;
  const cases: Array<[string, string]> = [
    ["[", "[".repeat(N)],
    ["spaces", " ".repeat(N)],
    ["newlines", "\n".repeat(N)],
    ["*", "*".repeat(N)],
    ["_", "_".repeat(N)],
    ["~", "~".repeat(N)],
    ["`", "`".repeat(N)],
    ["backtick runs", "`` ` ".repeat(N / 5)],
    ["|", "|".repeat(N)],
    ["-", "-".repeat(N)],
    ["#", "#".repeat(N)],
    [">", ">".repeat(N)],
    ["\\", "\\".repeat(N)],
    ["spaced pipes", "a |".padEnd(N, " ") + "x"],
    ["unclosed links", "[a](".repeat(N / 4)],
    ["link texts", "[a".repeat(N / 2)],
    ["autolinks", "<http://".repeat(N / 8)],
    ["strong openers", "**x ".repeat(N / 4)],
    ["strike openers", "~~x ".repeat(N / 4)],
    ["underscore openers", "__x ".repeat(N / 4)],
    ["em openers", "*x ".repeat(N / 3)],
    ["dividers", "| --- ".repeat(N / 6) + "x"],
    ["divider lines", "| --- |\n".repeat(50_000)],
    ["header and divider lines", "| a |\n| --- |\n".repeat(25_000)],
    ["private-use chars", "\uE000\uE001`".repeat(N / 3)],
    ["nested parens", "[a](" + "(".repeat(N)],
    ["nested link attempts", "[a](x".repeat(N / 5)],
    ["balanced link attempts", "[a](x(y)".repeat(N / 8)],
    ["titled link attempts", '[a](x "'.repeat(N / 7)],
    ["emphasis runs", "****x**** ".repeat(N / 10)],
    ["fence lines", "```a`\n~~~\n".repeat(N / 10)],
    ["list markers", "- ".repeat(N / 2)],
    ["digits", "1".repeat(N)],
    ["mixed", "[*_`|\\ -#>~".repeat(N / 12)]
  ];

  it.each(cases)("is linear on 200k chars of %s", (_name, input) => {
    const started = performance.now();
    markdownToPlain(input);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
