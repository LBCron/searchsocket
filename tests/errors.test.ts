import { describe, expect, it } from "vitest";
import { SearchSocketError, toErrorPayload } from "../src/errors";

describe("SearchSocketError", () => {
  it("sets code, message, and status", () => {
    const error = new SearchSocketError("CONFIG_MISSING", "Config not found", 404);
    expect(error.code).toBe("CONFIG_MISSING");
    expect(error.message).toBe("Config not found");
    expect(error.status).toBe(404);
  });

  it("defaults status to 500", () => {
    const error = new SearchSocketError("INTERNAL_ERROR", "Something broke");
    expect(error.status).toBe(500);
  });

  it("extends Error", () => {
    const error = new SearchSocketError("RATE_LIMITED", "slow down", 429);
    expect(error instanceof Error).toBe(true);
  });
});

describe("toErrorPayload", () => {
  it("formats SearchSocketError", () => {
    const error = new SearchSocketError("INVALID_REQUEST", "bad input", 400);
    const payload = toErrorPayload(error);
    expect(payload.error.code).toBe("INVALID_REQUEST");
    expect(payload.error.message).toBe("bad input");
  });

  it("does not leak an unexpected error's message", () => {
    // An unexpected error's text is not a deliberate public string — it can
    // carry a credential, a filesystem path, or an internal URL. Typed errors
    // say what they mean and pass through; everything else is generic.
    const payload = toErrorPayload(new Error("connect ECONNREFUSED 10.0.0.5:6379 token=sk-secret"));
    expect(payload.error.code).toBe("INTERNAL_ERROR");
    expect(payload.error.message).toBe("Internal error");
    expect(payload.error.message).not.toContain("sk-secret");
  });

  it("handles non-Error values", () => {
    const payload = toErrorPayload("string error");
    expect(payload.error.code).toBe("INTERNAL_ERROR");
    expect(payload.error.message).toBe("Internal error");
  });
});

describe("SearchSocketError across bundles", () => {
  it("recognises an instance created by another copy of the class", async () => {
    // Each published entry point bundles its own copy of the class. A fresh
    // module instance stands in for a second bundle.
    const { vi } = await import("vitest");
    vi.resetModules();
    // @ts-expect-error -- the query string only forces a second module instance.
    const other: typeof import("../src/errors/index") = await import("../src/errors/index?copy=2");
    const foreign = new other.SearchSocketError("RATE_LIMITED", "Retry later", 429);

    expect(other.SearchSocketError).not.toBe(SearchSocketError);
    expect(foreign instanceof SearchSocketError).toBe(true);
    expect(new SearchSocketError("CONFIG_INVALID", "x") instanceof other.SearchSocketError).toBe(true);
    expect(toErrorPayload(foreign)).toEqual({ error: { code: "RATE_LIMITED", message: "Retry later" } });
  });

  it("does not claim plain errors or look-alikes", () => {
    const lookalike = Object.assign(new Error("x"), { name: "SearchSocketError", code: "CONFIG_INVALID" });
    expect(lookalike instanceof SearchSocketError).toBe(false);
    expect(new Error("x") instanceof SearchSocketError).toBe(false);
    expect((null as unknown) instanceof SearchSocketError).toBe(false);
  });

  it("keeps ordinary semantics for subclasses", () => {
    class Special extends SearchSocketError {}
    expect(new Special("INTERNAL_ERROR", "x") instanceof Special).toBe(true);
    expect(new SearchSocketError("INTERNAL_ERROR", "x") instanceof Special).toBe(false);
    expect(new Special("INTERNAL_ERROR", "x") instanceof SearchSocketError).toBe(true);
  });
});
