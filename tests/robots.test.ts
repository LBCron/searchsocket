import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRobotsTxt, isBlockedByRobots, fetchRobotsTxt } from "../src/indexing/robots";

describe("parseRobotsTxt", () => {
  it("parses basic disallow rules for wildcard agent", () => {
    const content = `
User-agent: *
Disallow: /admin
Disallow: /api/
`;
    const rules = parseRobotsTxt(content);
    expect(rules.disallow).toEqual(["/admin", "/api/"]);
    expect(rules.allow).toEqual([]);
  });

  it("prefers Searchsocket-specific rules over wildcard", () => {
    const content = `
User-agent: *
Disallow: /admin

User-agent: Searchsocket
Disallow: /internal
`;
    const rules = parseRobotsTxt(content);
    expect(rules.disallow).toEqual(["/internal"]);
  });

  it("falls back to wildcard when no specific agent rules exist", () => {
    const content = `
User-agent: *
Disallow: /admin
`;
    const rules = parseRobotsTxt(content);
    expect(rules.disallow).toEqual(["/admin"]);
  });

  it("handles allow rules", () => {
    const content = `
User-agent: *
Disallow: /private/
Allow: /private/public-page
`;
    const rules = parseRobotsTxt(content);
    expect(rules.disallow).toEqual(["/private/"]);
    expect(rules.allow).toEqual(["/private/public-page"]);
  });

  it("ignores comments and empty lines", () => {
    const content = `
# This is a comment
User-agent: *
Disallow: /admin # inline comment

# Another comment
Disallow: /secret
`;
    const rules = parseRobotsTxt(content);
    expect(rules.disallow).toEqual(["/admin", "/secret"]);
  });

  it("returns empty rules when no matching agent found", () => {
    const content = `
User-agent: Googlebot
Disallow: /admin
`;
    const rules = parseRobotsTxt(content);
    expect(rules.disallow).toEqual([]);
    expect(rules.allow).toEqual([]);
  });

  it("handles empty content", () => {
    const rules = parseRobotsTxt("");
    expect(rules.disallow).toEqual([]);
    expect(rules.allow).toEqual([]);
  });

  it("is case-insensitive for user-agent matching", () => {
    const content = `
User-agent: searchsocket
Disallow: /internal
`;
    const rules = parseRobotsTxt(content, "Searchsocket");
    expect(rules.disallow).toEqual(["/internal"]);
  });

  it("starts a new group when a user-agent line follows rule lines", () => {
    // The AI-crawler block below must not leak into the wildcard group.
    const content = `
User-agent: *
Disallow: /admin

User-agent: GPTBot
Disallow: /
`;
    expect(parseRobotsTxt(content, "Searchsocket").disallow).toEqual(["/admin"]);
    expect(parseRobotsTxt(content, "GPTBot").disallow).toEqual(["/"]);
  });

  it("shares one group across consecutive user-agent lines", () => {
    const content = `
User-agent: Searchsocket
User-agent: Googlebot
Disallow: /private
`;
    expect(parseRobotsTxt(content, "Searchsocket").disallow).toEqual(["/private"]);
    expect(parseRobotsTxt(content, "Googlebot").disallow).toEqual(["/private"]);
  });

  it("keeps the group intact across non-rule directives like crawl-delay", () => {
    const content = `
User-agent: *
Crawl-delay: 10
Disallow: /admin
Sitemap: https://example.com/sitemap.xml
`;
    expect(parseRobotsTxt(content, "Searchsocket").disallow).toEqual(["/admin"]);
  });
});

describe("isBlockedByRobots", () => {
  it("blocks paths matching disallow", () => {
    const rules = { disallow: ["/admin"], allow: [] };
    expect(isBlockedByRobots("/admin", rules)).toBe(true);
    expect(isBlockedByRobots("/admin/users", rules)).toBe(true);
  });

  it("does not block non-matching paths", () => {
    const rules = { disallow: ["/admin"], allow: [] };
    expect(isBlockedByRobots("/about", rules)).toBe(false);
    expect(isBlockedByRobots("/", rules)).toBe(false);
  });

  it("allow overrides disallow when more specific", () => {
    const rules = {
      disallow: ["/private/"],
      allow: ["/private/public-page"]
    };
    expect(isBlockedByRobots("/private/secret", rules)).toBe(true);
    expect(isBlockedByRobots("/private/public-page", rules)).toBe(false);
  });

  it("disallow wins when equally specific", () => {
    const rules = {
      disallow: ["/page"],
      allow: ["/page"]
    };
    // Equal length — allow wins
    expect(isBlockedByRobots("/page", rules)).toBe(false);
  });

  it("handles empty rules", () => {
    const rules = { disallow: [], allow: [] };
    expect(isBlockedByRobots("/anything", rules)).toBe(false);
  });

  it("handles disallow with trailing slash", () => {
    const rules = { disallow: ["/api/"], allow: [] };
    expect(isBlockedByRobots("/api/endpoint", rules)).toBe(true);
    expect(isBlockedByRobots("/api", rules)).toBe(false);
  });
});

describe("isBlockedByRobots — RFC 9309 pattern grammar", () => {
  it("treats * as a wildcard rather than a literal asterisk", () => {
    const rules = { disallow: ["/private/*"], allow: [] };
    expect(isBlockedByRobots("/private/draft", rules)).toBe(true);
    expect(isBlockedByRobots("/private/", rules)).toBe(true);
    expect(isBlockedByRobots("/public/draft", rules)).toBe(false);
  });

  it("matches a wildcard in the middle of a pattern", () => {
    const rules = { disallow: ["/docs/*/draft"], allow: [] };
    expect(isBlockedByRobots("/docs/v2/draft", rules)).toBe(true);
    expect(isBlockedByRobots("/docs/v2/final", rules)).toBe(false);
  });

  it("anchors the end of the path with $", () => {
    const rules = { disallow: ["/draft$"], allow: [] };
    expect(isBlockedByRobots("/draft", rules)).toBe(true);
    expect(isBlockedByRobots("/draft/page", rules)).toBe(false);
  });

  it("combines a wildcard with an end anchor", () => {
    const rules = { disallow: ["/*.pdf$"], allow: [] };
    expect(isBlockedByRobots("/files/report.pdf", rules)).toBe(true);
    expect(isBlockedByRobots("/files/report.pdf.html", rules)).toBe(false);
  });

  it("compares percent-encoded and decoded paths as the same bytes", () => {
    const rules = { disallow: ["/private space/"], allow: [] };
    expect(isBlockedByRobots("/private%20space/doc", rules)).toBe(true);
    expect(isBlockedByRobots("/private space/doc", rules)).toBe(true);
  });

  it("keeps an encoded slash distinct from a path separator", () => {
    const rules = { disallow: ["/a/b"], allow: [] };
    expect(isBlockedByRobots("/a%2Fb", rules)).toBe(false);
  });

  it("does not let an escaped asterisk act as a wildcard", () => {
    // `%2A` is a literal asterisk in the URL, so this allow rule exempts one
    // file — decoding it first turned it into "allow everything under /file".
    const rules = { disallow: ["/"], allow: ["/file%2A.html"] };
    expect(isBlockedByRobots("/fileSECRET.html", rules)).toBe(true);
    expect(isBlockedByRobots("/file%2A.html", rules)).toBe(false);
  });

  it("keeps a double-encoded slash distinct from an encoded one", () => {
    const rules = { disallow: ["/a%2Fb"], allow: ["/a%252Fb"] };
    expect(isBlockedByRobots("/a%2Fb", rules)).toBe(true);
  });

  it("compares an escaped non-ASCII path with its literal form", () => {
    const rules = { disallow: ["/%E3%83%84x"], allow: [] };
    expect(isBlockedByRobots("/\u30c4x", rules)).toBe(true);
    expect(isBlockedByRobots("/\u30c4", rules)).toBe(false);
  });

  it("stays fast on a pattern built to make a regex backtrack", () => {
    // robots.txt comes from the crawled site, so a rule compiled to a chain of
    // `.*` would let that site hang the run on one string comparison.
    const rules = { disallow: [`/${"*a".repeat(24)}b`], allow: [] };
    const started = Date.now();
    expect(isBlockedByRobots(`/${"a".repeat(200)}`, rules)).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("lets a longer allow rule beat a wildcard disallow", () => {
    const rules = { disallow: ["/private/*"], allow: ["/private/public-page"] };
    expect(isBlockedByRobots("/private/public-page", rules)).toBe(false);
    expect(isBlockedByRobots("/private/secret", rules)).toBe(true);
  });

  it("keeps allow winning on equal specificity", () => {
    const rules = { disallow: ["/page$"], allow: ["/page$"] };
    expect(isBlockedByRobots("/page", rules)).toBe(false);
  });
});

describe("fetchRobotsTxt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function respond(status: number, body = "", headers: Record<string, string> = {}): Response {
    return new Response(status >= 300 || status === 204 ? null : body, { status, headers });
  }

  it("returns the parsed rules on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(200, "User-agent: *\nDisallow: /admin\n", { "content-type": "text/plain" }))
    );

    const result = await fetchRobotsTxt("https://example.com/docs");
    expect(result).toEqual({ status: "rules", rules: { disallow: ["/admin"], allow: [] } });
  });

  it("treats 404 as a site that publishes no rules", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(404)));

    expect(await fetchRobotsTxt("https://example.com")).toEqual({ status: "absent" });
  });

  it("treats a 5xx as an unknown policy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(503)));

    const result = await fetchRobotsTxt("https://example.com");
    expect(result.status).toBe("unavailable");
  });

  it("treats a withheld policy (403) as unknown rather than absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(403)));

    expect((await fetchRobotsTxt("https://example.com")).status).toBe("unavailable");
  });

  it("treats a network failure as an unknown policy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );

    expect((await fetchRobotsTxt("https://example.com")).status).toBe("unavailable");
  });

  it("follows a same-origin redirect", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(respond(301, "", { location: "https://example.com/robots-v2.txt" }))
      .mockResolvedValueOnce(respond(200, "User-agent: *\nDisallow: /x\n"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchRobotsTxt("https://example.com");
    expect(result).toEqual({ status: "rules", rules: { disallow: ["/x"], allow: [] } });
  });

  it("fails closed when robots.txt redirects off the crawl origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(302, "", { location: "https://cdn.example.net/robots.txt" }))
    );

    const result = await fetchRobotsTxt("https://example.com");
    expect(result.status).toBe("unavailable");
  });

  it("treats an oversized robots.txt as an unknown policy", async () => {
    const huge = "User-agent: *\n".padEnd(600 * 1024, "#") + "\nDisallow: /\n";
    vi.stubGlobal("fetch", vi.fn(async () => respond(200, huge)));

    expect((await fetchRobotsTxt("https://example.com")).status).toBe("unavailable");
  });

  it("sends a bounded request rather than a bare fetch", async () => {
    const fetchMock = vi.fn(async () => respond(200, "User-agent: *\nDisallow: /a\n"));
    vi.stubGlobal("fetch", fetchMock);

    await fetchRobotsTxt("https://example.com");

    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe("https://example.com/robots.txt");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeDefined();
  });
});
