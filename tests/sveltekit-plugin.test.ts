import { afterEach, describe, expect, it, vi } from "vitest";
import { searchsocketVitePlugin } from "../src/sveltekit/plugin";
import { IndexPipeline } from "../src/indexing/pipeline";
import { SearchSocketError } from "../src/errors";
import { Logger } from "../src/core/logger";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

type Plugin = ReturnType<typeof searchsocketVitePlugin>;
type HookContext = {
  environment?: {
    name?: string;
    config?: { build?: { ssr?: unknown } };
  };
};

const SSR_CONTEXT: HookContext = { environment: { name: "ssr" } };

/**
 * Invoke `closeBundle` the way Rollup does: an object hook whose `handler` is
 * called with a hook context. Defaults to the SSR pass, the only pass the
 * plugin acts on.
 */
function closeBundle(plugin: Plugin, ctx: HookContext = SSR_CONTEXT): Promise<void> {
  return Promise.resolve(plugin.closeBundle?.handler.call(ctx));
}

describe("searchsocketVitePlugin", () => {
  it("declares closeBundle as a sequential post hook", () => {
    // Load-bearing: without these the hook races the SvelteKit adapter and can
    // fire before the adapter has written its build output.
    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });

    expect(plugin.closeBundle?.sequential).toBe(true);
    expect(plugin.closeBundle?.order).toBe("post");
  });

  it("runs indexing when explicitly triggered by env var", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";

    const run = vi.fn().mockResolvedValue({
      pagesProcessed: 1,
      chunksTotal: 1,
      chunksChanged: 1,
      documentsUpserted: 1,
      deletes: 0,
      routeExact: 1,
      routeBestEffort: 0,
      stageTimingsMs: {}
    });

    vi.spyOn(IndexPipeline, "create").mockResolvedValue({
      run
    } as unknown as IndexPipeline);

    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });
    await closeBundle(plugin);

    expect(IndexPipeline.create).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries on subsequent closeBundle calls if a previous run failed", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";

    const create = vi
      .spyOn(IndexPipeline, "create")
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce({
        run: vi.fn().mockResolvedValue({
          pagesProcessed: 1,
          chunksTotal: 1,
          chunksChanged: 1,
          documentsUpserted: 1,
          deletes: 0,
          routeExact: 1,
          routeBestEffort: 0,
          stageTimingsMs: {}
        })
      } as unknown as IndexPipeline);

    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });

    await expect(closeBundle(plugin)).rejects.toThrow("transient failure");
    await expect(closeBundle(plugin)).resolves.toBeUndefined();

    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not trigger indexing when only CI=true is set", async () => {
    process.env.CI = "true";
    delete process.env.SEARCHSOCKET_AUTO_INDEX;

    vi.spyOn(IndexPipeline, "create").mockResolvedValue({
      run: vi.fn()
    } as unknown as IndexPipeline);

    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });
    await closeBundle(plugin);

    expect(IndexPipeline.create).not.toHaveBeenCalled();
  });

  it("skips the client pass and only indexes on the SSR pass", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";

    const create = vi.spyOn(IndexPipeline, "create").mockResolvedValue({
      run: vi.fn().mockResolvedValue({
        pagesProcessed: 1,
        chunksTotal: 1,
        chunksChanged: 1,
        documentsUpserted: 1,
        deletes: 0,
        routeExact: 1,
        routeBestEffort: 0,
        stageTimingsMs: {}
      })
    } as unknown as IndexPipeline);

    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });

    // SvelteKit runs its adapter only on the SSR pass; on the client pass the
    // build output doesn't exist yet.
    await closeBundle(plugin, { environment: { name: "client" } });
    expect(create).not.toHaveBeenCalled();

    await closeBundle(plugin, { environment: { name: "ssr" } });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("falls back to the configResolved ssr flag when environment is unavailable", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";

    const create = vi.spyOn(IndexPipeline, "create").mockResolvedValue({
      run: vi.fn().mockResolvedValue({
        pagesProcessed: 1,
        chunksTotal: 1,
        chunksChanged: 1,
        documentsUpserted: 1,
        deletes: 0,
        routeExact: 1,
        routeBestEffort: 0,
        stageTimingsMs: {}
      })
    } as unknown as IndexPipeline);

    // Vite <6 has no `this.environment`, so the plugin relies on the ssr flag
    // captured during configResolved.
    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });
    plugin.configResolved?.({ build: { ssr: true } });

    await closeBundle(plugin, {});

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not start duplicate indexing runs when closeBundle is invoked concurrently", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn().mockReturnValue(
      gate.then(() => ({
        pagesProcessed: 1,
        chunksTotal: 1,
        chunksChanged: 1,
        documentsUpserted: 1,
        deletes: 0,
        routeExact: 1,
        routeBestEffort: 0,
        stageTimingsMs: {}
      }))
    );

    const create = vi.spyOn(IndexPipeline, "create").mockResolvedValue({
      run
    } as unknown as IndexPipeline);

    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });
    const p1 = closeBundle(plugin);
    const p2 = closeBundle(plugin);

    release();
    await Promise.all([p1, p2]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("fails the build by default when the index mutation was refused", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";
    const run = vi.fn().mockResolvedValue({
      pagesProcessed: 1,
      chunksTotal: 1,
      chunksChanged: 0,
      documentsUpserted: 0,
      writesRefused: { reason: "max-deletion-ratio", detail: "would delete 9 of 10 pages" }
    });
    vi.spyOn(IndexPipeline, "create").mockResolvedValue({ run } as unknown as IndexPipeline);

    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });

    const failure = closeBundle(plugin);
    await expect(failure).rejects.toThrow(/would delete 9 of 10 pages.*acceptLargeDeletion/);
    await expect(failure).rejects.toMatchObject({ code: "INDEX_WRITES_REFUSED" });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ acceptLargeDeletion: false }));
  });

  it("fails the build with the same code when robots.txt is unavailable", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";
    const run = vi.fn().mockResolvedValue({
      pagesProcessed: 1,
      chunksTotal: 1,
      chunksChanged: 0,
      documentsUpserted: 0,
      writesRefused: { reason: "robots-unavailable", detail: "robots.txt could not be read" }
    });
    vi.spyOn(IndexPipeline, "create").mockResolvedValue({ run } as unknown as IndexPipeline);

    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });

    await expect(closeBundle(plugin)).rejects.toMatchObject({
      name: "SearchSocketError",
      code: "INDEX_WRITES_REFUSED"
    });
  });

  it("only warns about a refused mutation when failOnRefusedWrites is false", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";
    const run = vi.fn().mockResolvedValue({
      pagesProcessed: 1,
      chunksTotal: 1,
      chunksChanged: 0,
      documentsUpserted: 0,
      writesRefused: { reason: "robots-unavailable", detail: "robots.txt could not be read" }
    });
    vi.spyOn(IndexPipeline, "create").mockResolvedValue({ run } as unknown as IndexPipeline);
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

    const plugin = searchsocketVitePlugin({
      cwd: process.cwd(),
      verbose: false,
      failOnRefusedWrites: false,
      acceptLargeDeletion: true
    });

    await expect(closeBundle(plugin)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("index left unchanged"));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ acceptLargeDeletion: true }));
  });

  it("skips indexing without failing the build when credentials are missing", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";

    const create = vi
      .spyOn(IndexPipeline, "create")
      .mockRejectedValue(
        new SearchSocketError("VECTOR_BACKEND_UNAVAILABLE", "Missing Upstash Vector credentials.")
      );

    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });

    // A contributor without credentials must still be able to build the site.
    await expect(closeBundle(plugin)).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("fails the build on missing credentials when allowUnconfigured is false", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";

    vi.spyOn(IndexPipeline, "create").mockRejectedValue(
      new SearchSocketError("VECTOR_BACKEND_UNAVAILABLE", "Missing Upstash Vector credentials.")
    );

    const plugin = searchsocketVitePlugin({
      cwd: process.cwd(),
      verbose: false,
      allowUnconfigured: false
    });

    await expect(closeBundle(plugin)).rejects.toThrow("Missing Upstash Vector credentials.");
  });

  it("still fails the build when a configured run fails mid-index", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";

    // A missing credential is a skip; a configured backend going away mid-run
    // is not, even though it carries the same error code.
    vi.spyOn(IndexPipeline, "create").mockResolvedValue({
      run: vi
        .fn()
        .mockRejectedValue(new SearchSocketError("VECTOR_BACKEND_UNAVAILABLE", "upsert failed"))
    } as unknown as IndexPipeline);

    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });

    await expect(closeBundle(plugin)).rejects.toThrow("upsert failed");
  });

  it("names the project's own credential variables when it skips", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";

    vi.spyOn(IndexPipeline, "create").mockRejectedValue(
      new SearchSocketError(
        "VECTOR_BACKEND_UNAVAILABLE",
        "Missing Upstash Vector credentials. Set MY_VECTOR_URL and MY_VECTOR_TOKEN environment variables."
      )
    );
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });
    await closeBundle(plugin);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("MY_VECTOR_URL"));
  });

  it("can skip and then index on a later closeBundle once credentials appear", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";

    const create = vi
      .spyOn(IndexPipeline, "create")
      .mockRejectedValueOnce(
        new SearchSocketError("VECTOR_BACKEND_UNAVAILABLE", "Missing Upstash Vector credentials.")
      )
      .mockResolvedValueOnce({
        run: vi.fn().mockResolvedValue({
          pagesProcessed: 1,
          chunksTotal: 1,
          chunksChanged: 1,
          documentsUpserted: 1,
          deletes: 0,
          routeExact: 1,
          routeBestEffort: 0,
          stageTimingsMs: {}
        })
      } as unknown as IndexPipeline);

    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });

    await expect(closeBundle(plugin)).resolves.toBeUndefined();
    await expect(closeBundle(plugin)).resolves.toBeUndefined();

    expect(create).toHaveBeenCalledTimes(2);
  });
});
