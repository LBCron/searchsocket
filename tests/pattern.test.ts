import { describe, expect, it } from "vitest";
import { describeUnsupportedUrlPattern, matchUrlPattern, matchUrlPatterns } from "../src/utils/pattern";

describe("matchUrlPattern", () => {
  describe("exact match", () => {
    it("matches identical paths", () => {
      expect(matchUrlPattern("/blog", "/blog")).toBe(true);
    });

    it("does not match subpaths", () => {
      expect(matchUrlPattern("/blog/introducing-canopy", "/blog")).toBe(false);
    });

    it("matches root exactly", () => {
      expect(matchUrlPattern("/", "/")).toBe(true);
    });

    it("root does not match subpaths", () => {
      expect(matchUrlPattern("/about", "/")).toBe(false);
    });

    it("normalizes trailing slashes", () => {
      expect(matchUrlPattern("/blog/", "/blog")).toBe(true);
      expect(matchUrlPattern("/blog", "/blog/")).toBe(true);
    });
  });

  describe("single-level wildcard (*)", () => {
    it("matches direct children", () => {
      expect(matchUrlPattern("/blog/introducing-canopy", "/blog/*")).toBe(true);
      expect(matchUrlPattern("/blog/another-post", "/blog/*")).toBe(true);
    });

    it("does not match the parent itself", () => {
      expect(matchUrlPattern("/blog", "/blog/*")).toBe(false);
    });

    it("does not match deeper nested paths", () => {
      expect(matchUrlPattern("/blog/cat/nested", "/blog/*")).toBe(false);
    });

    it("root-level wildcard matches single segments", () => {
      expect(matchUrlPattern("/about", "/*")).toBe(true);
      expect(matchUrlPattern("/docs", "/*")).toBe(true);
    });

    it("root-level wildcard does not match deeper paths", () => {
      expect(matchUrlPattern("/docs/intro", "/*")).toBe(false);
    });

    it("root-level wildcard does not match root", () => {
      expect(matchUrlPattern("/", "/*")).toBe(false);
    });
  });

  describe("globstar (**)", () => {
    it("matches direct children", () => {
      expect(matchUrlPattern("/blog/introducing-canopy", "/blog/**")).toBe(true);
    });

    it("matches any depth", () => {
      expect(matchUrlPattern("/blog/cat/nested", "/blog/**")).toBe(true);
      expect(matchUrlPattern("/blog/a/b/c/d", "/blog/**")).toBe(true);
    });

    it("matches the parent itself", () => {
      expect(matchUrlPattern("/blog", "/blog/**")).toBe(true);
    });

    it("does not match unrelated paths", () => {
      expect(matchUrlPattern("/about", "/blog/**")).toBe(false);
    });

    it("root globstar matches everything", () => {
      expect(matchUrlPattern("/", "/**")).toBe(true);
      expect(matchUrlPattern("/anything", "/**")).toBe(true);
      expect(matchUrlPattern("/a/b/c", "/**")).toBe(true);
    });
  });
});

describe("matchUrlPatterns", () => {
  it("returns true if any pattern matches", () => {
    expect(matchUrlPatterns("/admin/users", ["/blog", "/admin/**"])).toBe(true);
  });

  it("returns false if no patterns match", () => {
    expect(matchUrlPatterns("/about", ["/blog", "/admin/**"])).toBe(false);
  });

  it("returns false for empty patterns", () => {
    expect(matchUrlPatterns("/about", [])).toBe(false);
  });
});

describe("describeUnsupportedUrlPattern", () => {
  it.each(["/", "/blog", "/blog/", "/blog/*", "/blog/**", "/*", "/**", "/a/b/c/**"])(
    "accepts %s",
    (pattern) => {
      expect(describeUnsupportedUrlPattern(pattern)).toBeNull();
    }
  );

  it.each([
    ["/**/private/**", "wildcard"],
    ["/draft-*.html", "wildcard"],
    ["/blog/*/comments", "wildcard"],
    ["/blog/***", "wildcard"],
    ["blog/**", "must start with"],
    ["https://example.com/blog", "must start with"],
    ["/page?.html", "\"?\""],
    ["/api/{a,b}", "\"{\""],
    ["/[slug]", "\"[\""],
    ["/docs//**", "empty path segment"],
    ["//docs", "empty path segment"],
    ["/docs//", "empty path segment"]
  ])("rejects %s", (pattern, fragment) => {
    expect(describeUnsupportedUrlPattern(pattern)).toContain(fragment);
  });
});
