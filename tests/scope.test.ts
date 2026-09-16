import { describe, expect, it, vi } from "vitest";
import { resolveScope } from "../src/core/scope";
import { createDefaultConfig } from "../src/config/defaults";

describe("resolveScope", () => {
  it("uses fixed scope by default", () => {
    const config = createDefaultConfig("test-proj");
    const scope = resolveScope(config);
    expect(scope.scopeName).toBe("main");
    expect(scope.projectId).toBe("test-proj");
    expect(scope.scopeId).toBe("test-proj:main");
  });

  it("respects scope override", () => {
    const config = createDefaultConfig("test-proj");
    const scope = resolveScope(config, "feature-x");
    expect(scope.scopeName).toBe("feature-x");
    expect(scope.scopeId).toBe("test-proj:feature-x");
  });

  it("sanitizes scope name", () => {
    const config = createDefaultConfig("test-proj");
    const scope = resolveScope(config, "Feature/Branch Name");
    expect(scope.scopeName).toBe("feature-branch-name");
  });

  it("preserves raw scope names when sanitize is disabled", () => {
    const config = createDefaultConfig("test-proj");
    config.scope.sanitize = false;

    const scope = resolveScope(config, "Feature.Branch-Name_2");
    expect(scope.scopeName).toBe("Feature.Branch-Name_2");
  });

  it("rejects a raw scope name that cannot be embedded safely", () => {
    // With sanitize disabled the raw branch name reaches record IDs and
    // Upstash filter literals unchanged, so unsafe characters must be refused
    // rather than silently producing a malformed ID or escaping the filter.
    const config = createDefaultConfig("test-proj");
    config.scope.sanitize = false;

    expect(() => resolveScope(config, "Feature/Branch Name")).toThrow(/Invalid scope name/);
    expect(() => resolveScope(config, "main' OR '1'='1")).toThrow(/Invalid scope name/);
  });

  it("rejects an unsafe project id", () => {
    const config = createDefaultConfig("bad'project");
    expect(() => resolveScope(config)).toThrow(/Invalid project id/);
  });

  it("uses env var when mode is env", () => {
    const config = createDefaultConfig("test-proj");
    config.scope.mode = "env";
    config.scope.envVar = "TEST_SCOPE";

    vi.stubEnv("TEST_SCOPE", "staging");
    const scope = resolveScope(config);
    expect(scope.scopeName).toBe("staging");
    vi.unstubAllEnvs();
  });

  it("throws when env var is missing in env mode", () => {
    const config = createDefaultConfig("test-proj");
    config.scope.mode = "env";
    config.scope.envVar = "MISSING_VAR";
    delete process.env.MISSING_VAR;

    expect(() => resolveScope(config)).toThrow("MISSING_VAR");
    // A required value that is absent, not a malformed one.
    expect(() => resolveScope(config)).toThrow(expect.objectContaining({ code: "CONFIG_MISSING" }));
  });
});
