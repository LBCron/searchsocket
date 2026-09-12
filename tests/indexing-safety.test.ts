import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import type { UpstashSearchStore } from "../src/vector/upstash";
import type { PageRecord, ResolvedSearchSocketConfig } from "../src/types";

/**
 * Release-blocking invariant: an indexing run that did not observe the
 * complete source of truth must delete nothing.
 *
 * Every case here previously deleted live records, because the pipeline
 * diffed "pages this run happened to see" against "pages in the index" and
 * treated the difference as removals.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

/** A store that remembers what was written, so run 2 sees run 1's records. */
function createStatefulMockStore() {
  const pageHashes = new Map<string, { contentHash: string; custom: boolean }>();
  const chunkIds = new Set<string>();
  const chunkHashes = new Map<string, string>();
  // Provenance per chunk, so the store mock can answer the same question the
  // real one does — otherwise the custom-chunk protection is never exercised.
  const chunkCustom = new Map<string, boolean>();

  const store = {
    getPageHashes: vi.fn(async () => new Map(pageHashes)),
    upsertPages: vi.fn(async (docs: Array<{ id: string; metadata: { contentHash?: string; custom?: boolean } }>) => {
      for (const doc of docs) {
        pageHashes.set(doc.id, {
          contentHash: doc.metadata.contentHash ?? "",
          custom: doc.metadata.custom === true
        });
      }
    }),
    deletePagesByIds: vi.fn(async (ids: string[]) => {
      for (const id of ids) pageHashes.delete(id);
    }),
    deletePages: vi.fn(async () => pageHashes.clear()),
    scanChunkIds: vi.fn(async () => new Map([...chunkIds].map((k) => [k, chunkCustom.get(k) === true]))),
    fetchContentHashesForKeys: vi.fn(async (keys: string[]) => {
      const out = new Map<string, string>();
      for (const key of keys) {
        const hash = chunkHashes.get(key);
        if (hash !== undefined) out.set(key, hash);
      }
      return out;
    }),
    upsertChunks: vi.fn(async (docs: Array<{ id: string; metadata: { contentHash?: string; custom?: boolean } }>) => {
      for (const doc of docs) {
        chunkIds.add(doc.id);
        chunkHashes.set(doc.id, doc.metadata.contentHash ?? "");
        chunkCustom.set(doc.id, doc.metadata.custom === true);
      }
    }),
    deleteByIds: vi.fn(async (ids: string[]) => {
      for (const id of ids) {
        chunkIds.delete(id);
        chunkHashes.delete(id);
        chunkCustom.delete(id);
      }
    }),
    listPages: vi.fn(async (): Promise<PageRecord[]> => [])
  } as unknown as UpstashSearchStore;

  return { store, pageHashes, chunkIds };
}

async function createFixture(
  pages: Record<string, string>
): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-safety-"));
  tempDirs.push(cwd);

  for (const [pagePath, body] of Object.entries(pages)) {
    const dir = path.join(cwd, "build", pagePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<html><head><title>${pagePath}</title></head><body><main><h1>${pagePath}</h1><p>${body}</p></main></body></html>`,
      "utf8"
    );
  }

  const config = createDefaultConfig("searchsocket-safety");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.state.dir = ".searchsocket";
  return { cwd, config };
}

/** Index a full site, then re-run with `options` and report what was deleted. */
async function indexThenRerun(
  fixture: Record<string, string>,
  rerun: Parameters<IndexPipeline["run"]>[0],
  mutate?: (cwd: string) => Promise<void>
) {
  const { cwd, config } = await createFixture(fixture);
  const { store } = createStatefulMockStore();

  const first = await IndexPipeline.create({ cwd, config, store });
  await first.run({ changedOnly: true });

  vi.mocked(store.deletePagesByIds).mockClear();
  vi.mocked(store.deleteByIds).mockClear();
  vi.mocked(store.upsertPages).mockClear();
  vi.mocked(store.upsertChunks).mockClear();

  if (mutate) await mutate(cwd);

  const second = await IndexPipeline.create({ cwd, config, store });
  const stats = await second.run(rerun);
  return { stats, store, cwd };
}

const THREE_PAGES = {
  "docs/alpha": "Alpha content here.",
  "docs/beta": "Beta content here.",
  "docs/gamma": "Gamma content here."
};

describe("indexing safety — incomplete runs never delete", () => {
  it("--max-pages deletes nothing", async () => {
    const { stats, store } = await indexThenRerun(THREE_PAGES, {
      changedOnly: true,
      maxPages: 1
    });

    expect(stats.deletionEligible).toBe(false);
    expect(stats.pagesDeleted).toBe(0);
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(store.deleteByIds).not.toHaveBeenCalled();
    expect(stats.warnings.some((w) => w.kind === "source-limited")).toBe(true);
  });

  it("--max-chunks deletes nothing", async () => {
    const { stats, store } = await indexThenRerun(THREE_PAGES, {
      changedOnly: true,
      maxChunks: 1
    });

    expect(stats.deletionEligible).toBe(false);
    expect(store.deleteByIds).not.toHaveBeenCalled();
    expect(stats.warnings.some((w) => w.kind === "chunks-limited")).toBe(true);
  });

  it("an extraction failure deletes nothing", async () => {
    // Replace one page's body with markup that survives parsing but yields no
    // extractable text — the shape a mainSelector regression produces.
    const { stats, store } = await indexThenRerun(
      THREE_PAGES,
      { changedOnly: true },
      async (cwd) => {
        await fs.writeFile(
          path.join(cwd, "build", "docs", "beta", "index.html"),
          "<html><head><title>Beta</title></head><body><main></main></body></html>",
          "utf8"
        );
      }
    );

    expect(stats.deletionEligible).toBe(false);
    expect(stats.pagesDeleted).toBe(0);
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(stats.warnings.some((w) => w.kind === "extraction-failure")).toBe(true);
  });

  it("an unexpectedly empty source deletes nothing without --allow-empty", async () => {
    const { stats, store } = await indexThenRerun(
      THREE_PAGES,
      { changedOnly: true },
      async (cwd) => {
        await fs.rm(path.join(cwd, "build"), { recursive: true, force: true });
        await fs.mkdir(path.join(cwd, "build"), { recursive: true });
      }
    );

    expect(stats.deletionEligible).toBe(false);
    expect(stats.pagesDeleted).toBe(0);
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(stats.dangerousOperations.some((op) => op.startsWith("refused-empty-deletion"))).toBe(true);
  });

  it("a mass deletion is refused without --accept-large-deletion", async () => {
    // Removing 2 of 3 pages is 67%, over the 50% default ratio.
    const { stats, store } = await indexThenRerun(
      THREE_PAGES,
      { changedOnly: true },
      async (cwd) => {
        await fs.rm(path.join(cwd, "build", "docs", "beta"), { recursive: true, force: true });
        await fs.rm(path.join(cwd, "build", "docs", "gamma"), { recursive: true, force: true });
      }
    );

    expect(stats.deletionEligible).toBe(false);
    expect(stats.pagesDeleted).toBe(0);
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(stats.dangerousOperations.some((op) => op.startsWith("refused-large-deletion"))).toBe(true);
  });

  it("a refused mass deletion stays refused however often it is repeated", async () => {
    // Renaming the only page looks like a 100% deletion, which the guard
    // refuses. Writing the replacement anyway used to enlarge the inventory,
    // so the identical next run measured the same stale page as 50% of two
    // pages and deleted it — an unaccepted plan approving itself by retrying.
    const { cwd, config } = await createFixture({ "docs/alpha": "Alpha content here." });
    const { store, pageHashes, chunkIds } = createStatefulMockStore();

    await (await IndexPipeline.create({ cwd, config, store })).run({ changedOnly: true });
    const indexedPages = new Set(pageHashes.keys());
    const indexedChunks = new Set(chunkIds);
    expect(indexedPages).toEqual(new Set(["/docs/alpha"]));

    await fs.rename(path.join(cwd, "build", "docs", "alpha"), path.join(cwd, "build", "docs", "renamed"));

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const stats = await (await IndexPipeline.create({ cwd, config, store })).run({ changedOnly: true });

      expect(stats.deletionEligible).toBe(false);
      expect(stats.pagesDeleted).toBe(0);
      expect(stats.dangerousOperations.some((op) => op.startsWith("refused-large-deletion"))).toBe(true);
      // The accepted generation is still exactly what it was: the refused run
      // added nothing that a later run could measure its deletion against.
      expect(new Set(pageHashes.keys())).toEqual(indexedPages);
      expect(new Set(chunkIds)).toEqual(indexedChunks);
    }
  });

  it("a refused mass deletion writes no records at all", async () => {
    const { stats, store } = await indexThenRerun(
      THREE_PAGES,
      { changedOnly: true },
      async (cwd) => {
        await fs.rm(path.join(cwd, "build", "docs", "beta"), { recursive: true, force: true });
        await fs.rm(path.join(cwd, "build", "docs", "gamma"), { recursive: true, force: true });
        await fs.writeFile(
          path.join(cwd, "build", "docs", "alpha", "index.html"),
          "<html><head><title>alpha</title></head><body><main><h1>alpha</h1><p>Rewritten alpha body.</p></main></body></html>",
          "utf8"
        );
      }
    );

    expect(stats.deletionEligible).toBe(false);
    expect(store.upsertPages).not.toHaveBeenCalled();
    expect(store.upsertChunks).not.toHaveBeenCalled();
    expect(stats.documentsUpserted).toBe(0);
  });

  it("a mass deletion proceeds with --accept-large-deletion", async () => {
    const { stats, store } = await indexThenRerun(
      THREE_PAGES,
      { changedOnly: true, acceptLargeDeletion: true },
      async (cwd) => {
        await fs.rm(path.join(cwd, "build", "docs", "beta"), { recursive: true, force: true });
        await fs.rm(path.join(cwd, "build", "docs", "gamma"), { recursive: true, force: true });
      }
    );

    expect(stats.deletionEligible).toBe(true);
    expect(stats.pagesDeleted).toBe(2);
    expect(store.deletePagesByIds).toHaveBeenCalled();
  });

  it("a complete run still deletes a genuinely removed page", async () => {
    const { stats, store } = await indexThenRerun(
      THREE_PAGES,
      { changedOnly: true },
      async (cwd) => {
        await fs.rm(path.join(cwd, "build", "docs", "beta"), { recursive: true, force: true });
      }
    );

    expect(stats.deletionEligible).toBe(true);
    expect(stats.pagesDeleted).toBe(1);
    expect(store.deletePagesByIds).toHaveBeenCalledWith(["/docs/beta"], expect.anything());
  });

  it("a noindex page is an authoritative removal, not a failure", async () => {
    const { stats, store } = await indexThenRerun(
      THREE_PAGES,
      { changedOnly: true },
      async (cwd) => {
        await fs.writeFile(
          path.join(cwd, "build", "docs", "beta", "index.html"),
          '<html><head><title>Beta</title><meta name="robots" content="noindex"></head>' +
            "<body><main><h1>Beta</h1><p>Beta content here.</p></main></body></html>",
          "utf8"
        );
      }
    );

    expect(stats.warnings).toEqual([]);
    expect(stats.deletionEligible).toBe(true);
    expect(stats.pagesDeleted).toBe(1);
  });

  it("a dry run never writes or deletes", async () => {
    const { stats, store } = await indexThenRerun(
      THREE_PAGES,
      { changedOnly: true, dryRun: true },
      async (cwd) => {
        await fs.rm(path.join(cwd, "build", "docs", "beta"), { recursive: true, force: true });
      }
    );

    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(store.deleteByIds).not.toHaveBeenCalled();
    expect(store.upsertPages).not.toHaveBeenCalled();
    // The plan is still reported so the operator can inspect it.
    expect(stats.pagesDeleted).toBe(1);
  });

  it("re-running an unchanged complete site is a no-op", async () => {
    const { stats, store } = await indexThenRerun(THREE_PAGES, { changedOnly: true });

    expect(stats.deletionEligible).toBe(true);
    expect(stats.pagesDeleted).toBe(0);
    expect(stats.documentsUpserted).toBe(0);
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(store.deleteByIds).not.toHaveBeenCalled();
  });

  it("a beforeIndex hook that drops every chunk cannot wipe the chunk index", async () => {
    // beforeIndex defines the set of chunks the run intends to exist, so
    // dropping them all reads as "delete everything" — which is exactly what
    // the deletion-ratio guard exists to refuse.
    const { cwd, config } = await createFixture(THREE_PAGES);
    const { store } = createStatefulMockStore();

    const first = await IndexPipeline.create({ cwd, config, store });
    await first.run({ changedOnly: true });

    vi.mocked(store.deleteByIds).mockClear();
    vi.mocked(store.deletePagesByIds).mockClear();

    const second = await IndexPipeline.create({
      cwd,
      config,
      store,
      hooks: { beforeIndex: async () => [] }
    });
    const stats = await second.run({ changedOnly: false });

    expect(stats.deletionEligible).toBe(false);
    expect(store.deleteByIds).not.toHaveBeenCalled();
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(stats.dangerousOperations.some((op) => op.startsWith("refused-large-deletion"))).toBe(true);
  });

  it("a beforeIndex hook that renames chunks does not delete what it just wrote", async () => {
    // The hook used to run *after* the stale set was computed, so a renamed
    // chunk was upserted and then immediately deleted as stale.
    const { cwd, config } = await createFixture(THREE_PAGES);
    const { store } = createStatefulMockStore();

    const rename = {
      beforeIndex: async (chunks: Array<{ chunkKey: string }>) =>
        chunks.map((c) => ({ ...c, chunkKey: `renamed-${c.chunkKey}` }))
    } as never;

    const first = await IndexPipeline.create({ cwd, config, store, hooks: rename });
    await first.run({ changedOnly: true });

    const written = vi.mocked(store.upsertChunks).mock.calls.flatMap((call) =>
      (call[0] as Array<{ id: string }>).map((doc) => doc.id)
    );
    const deleted = vi.mocked(store.deleteByIds).mock.calls.flatMap((call) => call[0] as string[]);

    expect(written.length).toBeGreaterThan(0);
    expect(deleted.filter((id) => written.includes(id))).toEqual([]);
  });

  it("a hook-driven rename converges on the second run", async () => {
    const { cwd, config } = await createFixture(THREE_PAGES);
    const { store, chunkIds } = createStatefulMockStore();

    const rename = {
      beforeIndex: async (chunks: Array<{ chunkKey: string }>) =>
        chunks.map((c) => ({ ...c, chunkKey: `renamed-${c.chunkKey}` }))
    } as never;

    await (await IndexPipeline.create({ cwd, config, store, hooks: rename })).run({ changedOnly: true });
    const afterFirst = new Set(chunkIds);

    vi.mocked(store.upsertChunks).mockClear();
    vi.mocked(store.deleteByIds).mockClear();

    const stats = await (await IndexPipeline.create({ cwd, config, store, hooks: rename })).run({
      changedOnly: true
    });

    // Nothing further to write or remove: the stored keys already match.
    expect(stats.documentsUpserted).toBe(0);
    expect(stats.deletes).toBe(0);
    expect(new Set(chunkIds)).toEqual(afterFirst);
  });
});

describe("mutation ordering and custom-record authority", () => {
  it("performs every upsert before any delete", async () => {
    // Page deletion used to run before chunks were written, so a chunk-write
    // failure left fresh pages, deleted old pages, and stale chunks — a state
    // no run produced deliberately.
    const { cwd, config } = await createFixture(THREE_PAGES);
    const { store } = createStatefulMockStore();

    await (await IndexPipeline.create({ cwd, config, store })).run({ changedOnly: true });
    await fs.rm(path.join(cwd, "build", "docs", "beta"), { recursive: true, force: true });

    // Also change a surviving page, so the run genuinely upserts as well as
    // deletes. Without a real upsert the ordering assertion passes vacuously.
    await fs.writeFile(
      path.join(cwd, "build", "docs", "alpha", "index.html"),
      "<html><head><title>Alpha</title></head><body><main><h1>Alpha</h1>" +
        "<p>Alpha content, revised.</p></main></body></html>",
      "utf8"
    );

    const order: string[] = [];
    for (const name of ["upsertPages", "upsertChunks", "deletePagesByIds", "deleteByIds"] as const) {
      vi.mocked(store[name]).mockClear();
      vi.mocked(store[name]).mockImplementation(async () => {
        order.push(name);
      });
    }

    await (await IndexPipeline.create({ cwd, config, store })).run({ changedOnly: true });

    const firstDelete = order.findIndex((op) => op.startsWith("delete"));
    const lastUpsert = order.map((op) => op.startsWith("upsert")).lastIndexOf(true);

    expect(order).toContain("upsertPages");
    expect(order).toContain("upsertChunks");
    expect(order.some((op) => op.startsWith("delete"))).toBe(true);
    expect(lastUpsert).toBeGreaterThan(-1);
    expect(lastUpsert).toBeLessThan(firstDelete);
  });

  it("does not delete custom records when the run supplies none", async () => {
    // Custom records share the page namespace, so a site-only run saw them as
    // absent and deleted them — taking a provider's content with it whenever
    // that provider merely failed to run.
    const { cwd, config } = await createFixture(THREE_PAGES);
    const { store, pageHashes } = createStatefulMockStore();

    await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true,
      customRecords: [
        { url: "/from-cms/post", title: "CMS post", content: "Body text from the CMS." }
      ]
    });
    expect(pageHashes.has("/from-cms/post")).toBe(true);

    vi.mocked(store.deletePagesByIds).mockClear();

    // A later run that says nothing about custom records.
    const stats = await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true
    });

    expect(stats.pagesDeleted).toBe(0);
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(pageHashes.has("/from-cms/post")).toBe(true);
  });

  it("does not delete a custom record's chunks when the run supplies none", async () => {
    // Protecting only the page vector left the page present but its sections
    // deleted, so get_page returned empty markdown and the record vanished
    // from section search.
    const { cwd, config } = await createFixture(THREE_PAGES);
    const { store, chunkIds } = createStatefulMockStore();

    await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true,
      customRecords: [
        { url: "/from-cms/post", title: "CMS post", content: "Body text from the CMS." }
      ]
    });
    const chunksAfterFirst = new Set(chunkIds);
    expect(chunksAfterFirst.size).toBeGreaterThan(0);

    vi.mocked(store.deleteByIds).mockClear();
    const stats = await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true
    });

    expect(stats.deletes).toBe(0);
    expect(store.deleteByIds).not.toHaveBeenCalled();
    expect(new Set(chunkIds)).toEqual(chunksAfterFirst);
  });

  it("deletes a custom record when the run explicitly supplies an empty set", async () => {
    const { cwd, config } = await createFixture(THREE_PAGES);
    const { store, pageHashes } = createStatefulMockStore();

    await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true,
      customRecords: [
        { url: "/from-cms/post", title: "CMS post", content: "Body text from the CMS." }
      ]
    });

    // `customRecords: []` is an explicit assertion that there are none.
    const stats = await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true,
      customRecords: []
    });

    expect(stats.pagesDeleted).toBe(1);
    expect(pageHashes.has("/from-cms/post")).toBe(false);
  });

  it("carries a custom record's metadata into the index", async () => {
    // CustomRecord.metadata was documented and demonstrated but discarded, so
    // a caller could set it and never filter on it.
    const { cwd, config } = await createFixture(THREE_PAGES);
    const { store } = createStatefulMockStore();

    await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true,
      customRecords: [
        {
          url: "/from-cms/post",
          title: "CMS post",
          content: "Body text from the CMS.",
          metadata: { source: "cms" }
        }
      ]
    });

    const written = vi.mocked(store.upsertPages).mock.calls
      .flatMap((call) => call[0] as Array<{ id: string; metadata: Record<string, unknown> }>)
      .find((doc) => doc.id === "/from-cms/post");

    expect(written?.metadata.meta).toEqual({ source: "cms" });
    expect(written?.metadata.custom).toBe(true);
  });
});

describe("custom-record protection does not strand records", () => {
  it("replaces a custom record's chunks when its content changes", async () => {
    // The protection must not prevent a provider from updating its own
    // records: supplying customRecords at all means the caller is speaking
    // authoritatively about them.
    const { cwd, config } = await createFixture(THREE_PAGES);
    const { store, chunkIds } = createStatefulMockStore();

    await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true,
      customRecords: [
        { url: "/from-cms/post", title: "CMS post", content: "The original body text." }
      ]
    });

    // Only the custom record's own chunks; the site pages' chunks correctly
    // survive both runs.
    const originalCustomChunks = vi
      .mocked(store.upsertChunks)
      .mock.calls.flatMap((call) => call[0] as Array<{ id: string; metadata: { url?: string } }>)
      .filter((doc) => doc.metadata.url === "/from-cms/post")
      .map((doc) => doc.id);
    expect(originalCustomChunks.length).toBeGreaterThan(0);

    await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true,
      customRecords: [
        { url: "/from-cms/post", title: "CMS post", content: "Completely different body text now." }
      ]
    });

    const rewritten = vi
      .mocked(store.upsertChunks)
      .mock.calls.flatMap((call) => call[0] as Array<{ id: string; metadata: { url?: string } }>)
      .filter((doc) => doc.metadata.url === "/from-cms/post")
      .map((doc) => doc.id);

    // Body chunks are keyed by their own text, so changing the content
    // replaces them: the old keys must not linger.
    const stranded = originalCustomChunks.filter(
      (id) => chunkIds.has(id) && !rewritten.includes(id)
    );
    expect(stranded).toEqual([]);

    // The page-summary chunk keeps its key deliberately — it identifies the
    // page rather than a passage — and is re-upserted with the new content.
    expect(rewritten.length).toBeGreaterThan(0);
  });

  it("removes a custom record's chunks when the caller retracts it", async () => {
    const { cwd, config } = await createFixture(THREE_PAGES);
    const { store, chunkIds, pageHashes } = createStatefulMockStore();

    await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true,
      customRecords: [
        { url: "/from-cms/post", title: "CMS post", content: "Body text from the CMS." }
      ]
    });
    const withCustom = new Set(chunkIds);

    await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true,
      customRecords: []
    });

    expect(pageHashes.has("/from-cms/post")).toBe(false);
    expect(chunkIds.size).toBeLessThan(withCustom.size);
  });
});

describe("provenance transitions", () => {
  it("re-upserts chunks when a page changes from custom to site-owned", async () => {
    // Provenance decides whether a site-only run may delete a chunk. If a
    // transition does not change the hash, the stored flag stays stale: a
    // custom→site chunk keeps its protection and is stranded once the page
    // goes away, and a site→custom chunk stays deletable.
    const { cwd, config } = await createFixture({ "docs/alpha": "Alpha content here." });
    const { store } = createStatefulMockStore();

    const sharedBody = "Exactly the same body text in both runs.";

    await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true,
      customRecords: [{ url: "/shared", title: "Shared", content: sharedBody }]
    });

    vi.mocked(store.upsertChunks).mockClear();

    // Same URL, same content — now produced by the site rather than supplied.
    await fs.mkdir(path.join(cwd, "build", "shared"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "build", "shared", "index.html"),
      `<html><head><title>Shared</title></head><body><main><h1>Shared</h1><p>${sharedBody}</p></main></body></html>`,
      "utf8"
    );

    await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true,
      customRecords: []
    });

    const rewritten = vi
      .mocked(store.upsertChunks)
      .mock.calls.flatMap(
        (call) => call[0] as Array<{ id: string; metadata: { url?: string; custom?: boolean; ordinal?: number } }>
      )
      .filter((doc) => doc.metadata.url === "/shared");

    // The page-summary chunk's key is content-independent, so it is the same
    // record in both runs. Asserting it was rewritten proves the provenance
    // change alone invalidated the hash — a body chunk could have been
    // rewritten merely because its text or heading differed.
    const summary = rewritten.find((doc) => doc.metadata.ordinal === 0);
    expect(summary).toBeDefined();
    expect(summary!.metadata.custom).toBe(false);
    expect(rewritten.every((doc) => doc.metadata.custom === false)).toBe(true);
  });

  it("keeps provenance when beforeIndex rebuilds the chunk array", async () => {
    const { cwd, config } = await createFixture({ "docs/alpha": "Alpha content here." });
    const { store } = createStatefulMockStore();

    await (
      await IndexPipeline.create({
        cwd,
        config,
        store,
        hooks: {
          beforeIndex: async (chunks) =>
            chunks.map((chunk) => ({ ...chunk, custom: undefined }) as never)
        }
      })
    ).run({
      changedOnly: true,
      customRecords: [{ url: "/from-cms/post", title: "CMS", content: "Body from the CMS." }]
    });

    const written = vi
      .mocked(store.upsertChunks)
      .mock.calls.flatMap((call) => call[0] as Array<{ metadata: { url?: string; custom?: boolean } }>)
      .filter((doc) => doc.metadata.url === "/from-cms/post");

    expect(written.length).toBeGreaterThan(0);
    expect(written.every((doc) => doc.metadata.custom === true)).toBe(true);
  });

  it("cannot be marked custom by a transformPage hook on a site page", async () => {
    // Otherwise a hook could make an ordinary page, and its chunks, immune to
    // deletion by every later indexing run.
    const { cwd, config } = await createFixture({ "docs/alpha": "Alpha content here." });
    const { store } = createStatefulMockStore();

    await (
      await IndexPipeline.create({
        cwd,
        config,
        store,
        hooks: { transformPage: async (page) => ({ ...page, custom: true }) as never }
      })
    ).run({ changedOnly: true });

    const pagesWritten = vi
      .mocked(store.upsertPages)
      .mock.calls.flatMap((call) => call[0] as Array<{ metadata: { custom?: boolean } }>);

    expect(pagesWritten.length).toBeGreaterThan(0);
    expect(pagesWritten.every((doc) => doc.metadata.custom === false)).toBe(true);
  });

  it("drops a chunk a hook pointed at a page this run never indexed", async () => {
    // Such a chunk has no determinable provenance and getPage could never
    // return it, so guessing either strands it or leaves it deletable.
    const { cwd, config } = await createFixture({ "docs/alpha": "Alpha content here." });
    const { store } = createStatefulMockStore();

    const stats = await (
      await IndexPipeline.create({
        cwd,
        config,
        store,
        hooks: {
          beforeIndex: async (chunks) =>
            chunks.map((chunk) => ({ ...chunk, url: "/nowhere" }) as never)
        }
      })
    ).run({ changedOnly: true });

    expect(vi.mocked(store.upsertChunks)).not.toHaveBeenCalled();
    expect(stats.warnings.some((w) => w.kind === "hook-failure")).toBe(true);
    expect(stats.deletionEligible).toBe(false);
  });

  it("keeps provenance when a chunk hook rebuilds the chunk", async () => {
    // A hook returning newly constructed chunks would otherwise drop the
    // marker, leaving a custom record's sections deletable.
    const { cwd, config } = await createFixture({ "docs/alpha": "Alpha content here." });
    const { store } = createStatefulMockStore();

    await (
      await IndexPipeline.create({
        cwd,
        config,
        store,
        hooks: {
          transformChunk: async (chunk) => ({ ...chunk, custom: undefined }) as never
        }
      })
    ).run({
      changedOnly: true,
      customRecords: [{ url: "/from-cms/post", title: "CMS", content: "Body from the CMS." }]
    });

    const written = vi
      .mocked(store.upsertChunks)
      .mock.calls.flatMap((call) => call[0] as Array<{ metadata: { url?: string; custom?: boolean } }>)
      .filter((doc) => doc.metadata.url === "/from-cms/post");

    expect(written.length).toBeGreaterThan(0);
    expect(written.every((doc) => doc.metadata.custom === true)).toBe(true);
  });
});

describe("indexing safety — published artifacts", () => {
  /** Index a site with llms.txt generation on, then re-run and report the files. */
  async function indexWithLlms(
    rerun: Parameters<IndexPipeline["run"]>[0],
    mutate?: (cwd: string) => Promise<void>
  ) {
    const { cwd, config } = await createFixture(THREE_PAGES);
    config.llmsTxt.enable = true;
    config.llmsTxt.generateFull = true;
    const { store } = createStatefulMockStore();

    await (await IndexPipeline.create({ cwd, config, store })).run({ changedOnly: true });
    const before = await fs.readFile(path.join(cwd, "static", "llms.txt"), "utf8");
    const beforeFull = await fs.readFile(path.join(cwd, "static", "llms-full.txt"), "utf8");

    if (mutate) await mutate(cwd);
    const stats = await (await IndexPipeline.create({ cwd, config, store })).run(rerun);

    return {
      stats,
      before,
      beforeFull,
      after: await fs.readFile(path.join(cwd, "static", "llms.txt"), "utf8"),
      afterFull: await fs.readFile(path.join(cwd, "static", "llms-full.txt"), "utf8")
    };
  }

  it("a truncated run leaves the last complete llms artifacts in place", async () => {
    // The index is already protected from a partial run; the exported text
    // files had weaker semantics and there is no second copy to recover from.
    const { stats, before, beforeFull, after, afterFull } = await indexWithLlms({
      changedOnly: true,
      maxPages: 1
    });

    expect(stats.deletionEligible).toBe(false);
    expect(after).toBe(before);
    expect(afterFull).toBe(beforeFull);
    expect(after).toContain("/docs/gamma");
  });

  it("a chunk limit does not freeze the artifacts", async () => {
    // --max-chunks truncates chunks, not pages, so the exported page list is
    // still complete and stale exports would be the wrong answer.
    const { stats, after } = await indexWithLlms(
      { changedOnly: true, maxChunks: 1000 },
      async (cwd) => {
        await fs.rm(path.join(cwd, "build", "docs", "beta"), { recursive: true, force: true });
      }
    );

    expect(stats.warnings.some((w) => w.kind === "chunks-limited")).toBe(true);
    expect(after).not.toContain("/docs/beta");
  });

  it("keeps the artifacts when the run was not told about retained custom records", async () => {
    // The index still holds the custom record — deliberately, since a run
    // without `customRecords` has no opinion on it — so an export built from
    // this run's pages alone would silently drop it from the public list.
    const { cwd, config } = await createFixture(THREE_PAGES);
    config.llmsTxt.enable = true;
    const { store } = createStatefulMockStore();

    await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true,
      customRecords: [{ url: "/from-cms/post", title: "CMS", content: "Body from the CMS." }]
    });
    const before = await fs.readFile(path.join(cwd, "static", "llms.txt"), "utf8");
    expect(before).toContain("/from-cms/post");

    const stats = await (await IndexPipeline.create({ cwd, config, store })).run({ changedOnly: true });

    expect(stats.deletionEligible).toBe(true);
    expect(await fs.readFile(path.join(cwd, "static", "llms.txt"), "utf8")).toBe(before);
  });

  it("a complete run still refreshes the llms artifacts", async () => {
    const { stats, after } = await indexWithLlms({ changedOnly: true }, async (cwd) => {
      await fs.rm(path.join(cwd, "build", "docs", "beta"), { recursive: true, force: true });
    });

    expect(stats.deletionEligible).toBe(true);
    expect(after).not.toContain("/docs/beta");
  });
});
