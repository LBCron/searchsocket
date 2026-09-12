import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import { SearchSocketError } from "../src/errors";
import { canonicalJson } from "../src/indexing/pipeline";
import { resolveScope } from "../src/core/scope";
import { sha256 } from "../src/utils/hash";
import { INDEX_SCHEMA_VERSION } from "../src/vector/ids";
import {
  METADATA_BYTE_BUDGET,
  metadataByteSize,
  truncateToUtf8Bytes,
  utf8ByteLength
} from "../src/utils/structured-meta";
import type { UpstashSearchStore } from "../src/vector/upstash";
import type { PageRecord, ResolvedSearchSocketConfig, Scope } from "../src/types";

/**
 * The per-record metadata budget is a BYTE budget, and these tests only ever
 * measure bytes.
 *
 * The bug being closed is a character cap standing in for one: 30,000 CJK
 * characters pass a `.slice(0, 30_000)` untouched and weigh ~90,000 UTF-8
 * bytes, so the payload the pipeline called safe is roughly twice the limit it
 * claimed to respect. Every assertion here is therefore made against the
 * serialized metadata the store is actually handed, before any network call.
 */

const tempDirs: string[] = [];

type Metadata = Record<string, unknown>;

/** True when no surrogate in the string is unpaired. */
function isWellFormedUtf16(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/**
 * The metadata as the BACKEND will see it.
 *
 * `UpstashSearchStore` stamps the scope identity onto every record after the
 * pipeline hands it over, and the mock store below deliberately does not. A
 * budget assertion made against the pipeline's projection alone would stay
 * green even if the enforcement stopped reserving room for the envelope, which
 * is precisely the failure this whole change exists to prevent — so the tests
 * add it back, from the same constants upstash.ts uses.
 */
function asStored(metadata: Metadata, scope: Scope, kind: "chunk" | "page"): Metadata {
  return {
    ...metadata,
    ...(kind === "chunk" ? { chunkKey: metadata.chunkKey ?? "" } : {}),
    projectId: scope.projectId,
    scopeName: scope.scopeName,
    schemaVersion: INDEX_SCHEMA_VERSION,
    type: kind
  };
}

/**
 * Recompute a record's metadata fingerprint from what was actually stored.
 *
 * Mirrors fingerprintMetadata() in pipeline.ts: the complete persisted
 * projection minus the three fields excluded from every fingerprint. Comparing
 * this against the stored `metadataHash` is what catches a hash taken over the
 * pre-trim payload — a second identical run alone cannot, since it would
 * recompute the same wrong hash and see no change.
 */
function recomputeMetadataHash(metadata: Metadata): string {
  const projection: Metadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "indexedAt" || key === "contentHash" || key === "metadataHash") continue;
    projection[key] = value;
  }
  return sha256(canonicalJson(projection));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

/**
 * A store that remembers the complete metadata of everything written, so a
 * second run sees exactly what the first left behind — which is what makes the
 * fingerprint/payload agreement observable.
 */
function createStatefulMockStore() {
  const chunks = new Map<string, Metadata>();
  const pages = new Map<string, Metadata>();

  const store = {
    getPageHashes: vi.fn(async () => {
      const out = new Map<string, { contentHash: string; metadataHash?: string; custom: boolean }>();
      for (const [url, metadata] of pages) {
        out.set(url, {
          contentHash: String(metadata.contentHash ?? ""),
          metadataHash: metadata.metadataHash as string | undefined,
          custom: metadata.custom === true
        });
      }
      return out;
    }),
    upsertPages: vi.fn(async (docs: Array<{ id: string; metadata: Metadata }>) => {
      for (const doc of docs) pages.set(doc.id, { ...doc.metadata });
    }),
    updatePageMetadata: vi.fn(async (items: Array<{ id: string; metadata: Metadata }>) => {
      const missing: string[] = [];
      for (const item of items) {
        if (!pages.has(item.id)) {
          missing.push(item.id);
          continue;
        }
        pages.set(item.id, { ...item.metadata });
      }
      return missing;
    }),
    deletePagesByIds: vi.fn(async (ids: string[]) => {
      for (const id of ids) pages.delete(id);
    }),
    deletePages: vi.fn(async () => pages.clear()),
    scanChunkIds: vi.fn(async () =>
      new Map([...chunks.entries()].map(([key, metadata]) => [key, metadata.custom === true]))
    ),
    fetchContentHashesForKeys: vi.fn(async (keys: string[]) => {
      const out = new Map<string, { contentHash: string; metadataHash?: string }>();
      for (const key of keys) {
        const metadata = chunks.get(key);
        if (!metadata) continue;
        out.set(key, {
          contentHash: String(metadata.contentHash ?? ""),
          metadataHash: metadata.metadataHash as string | undefined
        });
      }
      return out;
    }),
    upsertChunks: vi.fn(async (docs: Array<{ id: string; metadata: Metadata }>) => {
      for (const doc of docs) chunks.set(doc.id, { ...doc.metadata });
    }),
    updateChunkMetadata: vi.fn(async (items: Array<{ id: string; metadata: Metadata }>) => {
      const missing: string[] = [];
      for (const item of items) {
        if (!chunks.has(item.id)) {
          missing.push(item.id);
          continue;
        }
        chunks.set(item.id, { ...item.metadata });
      }
      return missing;
    }),
    deleteByIds: vi.fn(async (ids: string[]) => {
      for (const id of ids) chunks.delete(id);
    }),
    listPages: vi.fn(async (): Promise<PageRecord[]> => [])
  } as unknown as UpstashSearchStore;

  const spies = store as unknown as {
    upsertChunks: ReturnType<typeof vi.fn>;
    updateChunkMetadata: ReturnType<typeof vi.fn>;
    upsertPages: ReturnType<typeof vi.fn>;
    updatePageMetadata: ReturnType<typeof vi.fn>;
  };

  return {
    store,
    spies,
    chunks,
    pages,
    chunksFor(url: string): Metadata[] {
      return [...chunks.values()]
        .filter((metadata) => metadata.url === url)
        .sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
    },
    resetSpies() {
      spies.upsertChunks.mockClear();
      spies.updateChunkMetadata.mockClear();
      spies.upsertPages.mockClear();
      spies.updatePageMetadata.mockClear();
    }
  };
}

async function createFixture(
  pages: Record<string, { head?: string; body: string }>
): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-budget-"));
  tempDirs.push(cwd);

  for (const [pagePath, spec] of Object.entries(pages)) {
    const dir = path.join(cwd, "build", pagePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<html><head><title>${pagePath}</title>${spec.head ?? ""}</head>` +
        `<body><main>${spec.body}</main></body></html>`,
      "utf8"
    );
  }

  const config = createDefaultConfig("searchsocket-budget");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.state.dir = ".searchsocket";
  config.respectRobotsTxt = false;
  config.llmsTxt.enable = false;
  return { cwd, config };
}

/**
 * A fenced code block is a protected block: the chunker returns it whole
 * regardless of `maxChars`, which is exactly how a payload far larger than the
 * chunk target reaches the write path in the first place.
 */
function codeBlockPage(text: string): { body: string } {
  return { body: `<h1>Reference</h1><pre><code>${text}</code></pre>` };
}

describe("truncateToUtf8Bytes", () => {
  it("bounds bytes, not characters, for CJK text", () => {
    const text = "漢".repeat(10); // 30 UTF-8 bytes, 10 characters
    const trimmed = truncateToUtf8Bytes(text, 20);

    expect(utf8ByteLength(trimmed)).toBeLessThanOrEqual(20);
    expect(trimmed).toBe("漢".repeat(6));
  });

  it("never strands half a surrogate pair", () => {
    const text = "😀".repeat(5); // 4 UTF-8 bytes each

    for (let limit = 0; limit <= 20; limit += 1) {
      const trimmed = truncateToUtf8Bytes(text, limit);
      expect(utf8ByteLength(trimmed)).toBeLessThanOrEqual(limit);
      expect(isWellFormedUtf16(trimmed)).toBe(true);
      expect(trimmed).not.toContain("�");
      expect(text.startsWith(trimmed)).toBe(true);
    }
  });

  it("preserves text the caller never asked to have changed", () => {
    // An encode/decode round trip would rewrite both of these: the lone
    // surrogate becomes U+FFFD and the byte-order mark is eaten by TextDecoder.
    expect(truncateToUtf8Bytes("\uD800abc", 3)).toBe("\uD800");
    expect(truncateToUtf8Bytes("\uFEFFabc", 4)).toBe("\uFEFFa");
    expect(truncateToUtf8Bytes("a\uFFFDb", 32)).toBe("a\uFFFDb");
  });

  it("never returns more bytes than asked for, even for a fractional limit", () => {
    expect(utf8ByteLength(truncateToUtf8Bytes("😀", 2.5))).toBe(0);
    expect(utf8ByteLength(truncateToUtf8Bytes("漢漢", 5.9))).toBeLessThanOrEqual(5);
  });

  it("leaves text that already fits exactly as it was", () => {
    expect(truncateToUtf8Bytes("héllo", 32)).toBe("héllo");
    expect(truncateToUtf8Bytes("", 0)).toBe("");
  });
});

describe("IndexPipeline metadata byte budget", () => {
  it("trims a CJK chunk that the old character cap would have waved through", async () => {
    // 25,000 characters is under the retired 30,000-character cap, so this
    // payload used to be stored untouched — at 75,000 UTF-8 bytes.
    const body = "漢".repeat(25_000);
    const { cwd, config } = await createFixture({ docs: codeBlockPage(body) });
    const backing = createStatefulMockStore();
    const warn = vi.fn();

    const scope = resolveScope(config, undefined, cwd);
    const pipeline = await IndexPipeline.create({ cwd, config, store: backing.store });
    (pipeline as unknown as { logger: { warn: unknown } }).logger.warn = warn;
    await pipeline.run({ changedOnly: true });

    const stored = backing.chunksFor("/docs");
    expect(stored.length).toBeGreaterThan(0);

    const oversized = stored.find((metadata) => String(metadata.chunkText).includes("漢"));
    expect(oversized).toBeDefined();

    const chunkText = String(oversized!.chunkText);
    expect(utf8ByteLength(chunkText)).toBeGreaterThan(chunkText.length); // genuinely multi-byte
    expect(metadataByteSize(asStored(oversized!, scope, "chunk"))).toBeLessThanOrEqual(
      METADATA_BYTE_BUDGET
    );
    expect(isWellFormedUtf16(chunkText)).toBe(true);
    expect(chunkText).not.toContain("�");
    expect(body.startsWith(chunkText.slice(chunkText.indexOf("漢")))).toBe(true);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("chunkText"));
  });

  it("trims emoji without producing a lone surrogate", async () => {
    const body = "😀".repeat(20_000); // 80,000 UTF-8 bytes
    const { cwd, config } = await createFixture({ docs: codeBlockPage(body) });
    const backing = createStatefulMockStore();

    const pipeline = await IndexPipeline.create({ cwd, config, store: backing.store });
    await pipeline.run({ changedOnly: true });

    const oversized = backing
      .chunksFor("/docs")
      .find((metadata) => String(metadata.chunkText).includes("😀"));
    expect(oversized).toBeDefined();

    const chunkText = String(oversized!.chunkText);
    expect(isWellFormedUtf16(chunkText)).toBe(true);
    expect(chunkText).not.toContain("�");
    expect(metadataByteSize(oversized!)).toBeLessThanOrEqual(METADATA_BYTE_BUDGET);
  });

  it("trims a single oversized identifier that offers no boundary to cut on", async () => {
    const body = `identifier_${"x".repeat(60_000)}`;
    const { cwd, config } = await createFixture({ docs: codeBlockPage(body) });
    const backing = createStatefulMockStore();
    const scope = resolveScope(config, undefined, cwd);

    const pipeline = await IndexPipeline.create({ cwd, config, store: backing.store });
    await pipeline.run({ changedOnly: true });

    const stored = backing.chunksFor("/docs");
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.some((metadata) => String(metadata.chunkText).includes("identifier_"))).toBe(true);
    for (const metadata of stored) {
      expect(metadataByteSize(asStored(metadata, scope, "chunk"))).toBeLessThanOrEqual(
        METADATA_BYTE_BUDGET
      );
    }
  });

  it("keeps the metadata fingerprint describing the trimmed payload", async () => {
    const { cwd, config } = await createFixture({ docs: codeBlockPage("漢".repeat(25_000)) });
    const backing = createStatefulMockStore();

    const pipeline = await IndexPipeline.create({ cwd, config, store: backing.store });
    await pipeline.run({ changedOnly: true });

    // The load-bearing assertion: the hash stored alongside the record is the
    // hash OF the record, trimming included. Hashing before the trim produces a
    // stable-but-wrong digest that a second run would happily agree with.
    for (const metadata of backing.chunks.values()) {
      expect(metadata.metadataHash).toBe(recomputeMetadataHash(metadata));
    }
    for (const metadata of backing.pages.values()) {
      expect(metadata.metadataHash).toBe(recomputeMetadataHash(metadata));
    }

    const firstRun = new Map([...backing.chunks].map(([key, value]) => [key, { ...value }]));
    backing.resetSpies();

    // Nothing changed on disk, so a second run must recognise every record as
    // already correct. It can only do that if the stored metadataHash was taken
    // over the TRIMMED metadata: hashing before the trim leaves the two
    // disagreeing and this run rewrites (or worse, silently skips) the record.
    const second = await IndexPipeline.create({ cwd, config, store: backing.store });
    await second.run({ changedOnly: true });

    expect(backing.spies.upsertChunks).not.toHaveBeenCalled();
    expect(backing.spies.updateChunkMetadata).not.toHaveBeenCalled();
    expect(backing.spies.upsertPages).not.toHaveBeenCalled();
    expect(backing.spies.updatePageMetadata).not.toHaveBeenCalled();

    for (const [key, before] of firstRun) {
      expect(backing.chunks.get(key)).toEqual(before);
    }
  });

  it("trims a page summary when the page's own required metadata leaves no room", async () => {
    // The summary is already capped at 3,500 characters — as CJK that is ~10 KB,
    // which only overflows once the required metadata is itself large. This is
    // the page-side counterpart of the chunk case: the free text yields, the
    // required fields do not.
    const notes = "n".repeat(42_000);
    const { cwd, config } = await createFixture({
      docs: {
        head: `<meta name="searchsocket:notes" content="${notes}" data-type="string">`,
        body: `<h1>指南</h1><p>${"漢".repeat(6_000)}</p>`
      }
    });
    const backing = createStatefulMockStore();
    const scope = resolveScope(config, undefined, cwd);

    const pipeline = await IndexPipeline.create({ cwd, config, store: backing.store });
    await pipeline.run({ changedOnly: true });

    const page = backing.pages.get("/docs");
    expect(page).toBeDefined();
    expect(String(page!.summary).length).toBeGreaterThan(0);
    expect(utf8ByteLength(String(page!.summary))).toBeGreaterThan(String(page!.summary).length);
    expect(metadataByteSize(asStored(page!, scope, "page"))).toBeLessThanOrEqual(
      METADATA_BYTE_BUDGET
    );
    expect(page!.metadataHash).toBe(recomputeMetadataHash(page!));
    // The required fields survived intact; only the free text gave way.
    expect((page!.meta as Record<string, unknown>).notes).toBe(notes);
  });

  it("does not let a chunk hook grow a page payload that was already measured", async () => {
    // Page plans are built before the chunk hooks run, so anything a hook can
    // still reach afterwards escapes both the budget check and the fingerprint.
    // A spread copy of `meta` leaves its array values shared with the very
    // arrays the chunks carry, which is exactly such a reach.
    const { cwd, config } = await createFixture({
      docs: {
        head: `<meta name="searchsocket:frameworks" content="svelte,react" data-type="string[]">`,
        body: "<h1>Guide</h1><p>A short paragraph of ordinary prose.</p>"
      }
    });
    const backing = createStatefulMockStore();
    const scope = resolveScope(config, undefined, cwd);

    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store: backing.store,
      hooks: {
        transformChunk: (chunk) => {
          const frameworks = chunk.meta?.frameworks;
          if (Array.isArray(frameworks)) frameworks.push("x".repeat(12_000));
          return chunk;
        }
      }
    });
    await pipeline.run({ changedOnly: true });

    const page = backing.pages.get("/docs");
    expect(page).toBeDefined();
    expect((page!.meta as Record<string, unknown>).frameworks).toEqual(["svelte", "react"]);
    expect(metadataByteSize(asStored(page!, scope, "page"))).toBeLessThanOrEqual(
      METADATA_BYTE_BUDGET
    );
    expect(page!.metadataHash).toBe(recomputeMetadataHash(page!));
  });

  it("writes a batch of many individually large but valid records untouched", async () => {
    // Comfortably inside the budget, but large enough that a naive aggregate
    // check would reject the batch.
    const block = "console.log('example');\n".repeat(1_600); // ~38 KB of ASCII
    const pages: Record<string, { body: string }> = {};
    for (let i = 0; i < 12; i += 1) pages[`docs/page-${i}`] = codeBlockPage(block);

    const { cwd, config } = await createFixture(pages);
    const backing = createStatefulMockStore();
    const scope = resolveScope(config, undefined, cwd);

    const pipeline = await IndexPipeline.create({ cwd, config, store: backing.store });
    await pipeline.run({ changedOnly: true });

    expect(backing.pages.size).toBe(12);
    for (let i = 0; i < 12; i += 1) {
      const stored = backing.chunksFor(`/docs/page-${i}`);
      expect(stored.length).toBeGreaterThan(0);
      const code = stored.find((metadata) => String(metadata.chunkText).includes("console.log"));
      expect(code).toBeDefined();
      // Untrimmed: the whole block survived.
      expect(String(code!.chunkText)).toContain(block.trimEnd());
      expect(metadataByteSize(asStored(code!, scope, "chunk"))).toBeLessThanOrEqual(
        METADATA_BYTE_BUDGET
      );
    }
  });
});

describe("IndexPipeline metadata byte budget — unfittable records", () => {
  async function expectRejection(
    head: string,
    field: string,
    options: { dryRun?: boolean } = {}
  ): Promise<void> {
    const { cwd, config } = await createFixture({
      docs: { head, body: "<h1>Guide</h1><p>A short paragraph of ordinary prose.</p>" }
    });
    const backing = createStatefulMockStore();

    const pipeline = await IndexPipeline.create({ cwd, config, store: backing.store });
    const error = await pipeline.run({ changedOnly: true, dryRun: options.dryRun }).then(
      () => null,
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(SearchSocketError);
    const failure = error as SearchSocketError;
    expect(failure.code).toBe("INVALID_REQUEST");
    expect(failure.message).toContain("/docs");
    expect(failure.message).toContain(`"${field}"`);

    // The point of failing at plan time: not one record of the batch is written.
    expect(backing.spies.upsertPages).not.toHaveBeenCalled();
    expect(backing.spies.upsertChunks).not.toHaveBeenCalled();
    expect(backing.spies.updatePageMetadata).not.toHaveBeenCalled();
    expect(backing.spies.updateChunkMetadata).not.toHaveBeenCalled();
    expect(backing.pages.size).toBe(0);
    expect(backing.chunks.size).toBe(0);
  }

  it("rejects a page whose structured metadata alone exceeds the budget", async () => {
    await expectRejection(
      `<meta name="searchsocket:notes" content="${"n".repeat(60_000)}" data-type="string">`,
      "meta"
    );
  });

  it("rejects a page carrying more tags than the budget can hold", async () => {
    const tags = Array.from({ length: 4_000 }, (_, i) => `tag-number-${i}`).join(",");
    await expectRejection(`<meta name="searchsocket:tags" content="${tags}">`, "tags");
  });

  it("reports the rejection under --dry-run too, still without writing", async () => {
    await expectRejection(
      `<meta name="searchsocket:notes" content="${"n".repeat(60_000)}" data-type="string">`,
      "meta",
      { dryRun: true }
    );
  });

  it("refuses a chunk whose own required metadata cannot fit, before any page is written", async () => {
    // A section heading reaches chunk metadata (`sectionTitle`, `headingPath`)
    // but not page metadata, so this is oversized on the chunk side only — and chunks are
    // planned after pages. The run must still write nothing at all: planning is
    // complete before the first upsert precisely so a doomed record cannot be
    // discovered halfway through a batch.
    const heading = "H".repeat(60_000);
    const { cwd, config } = await createFixture({
      docs: { body: `<h1>Guide</h1><h2>${heading}</h2><p>Ordinary prose under a very long heading.</p>` }
    });
    const backing = createStatefulMockStore();

    const pipeline = await IndexPipeline.create({ cwd, config, store: backing.store });
    const error = await pipeline.run({ changedOnly: true }).then(
      () => null,
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(SearchSocketError);
    expect((error as SearchSocketError).code).toBe("INVALID_REQUEST");
    expect((error as SearchSocketError).message).toContain("/docs");
    expect((error as SearchSocketError).message).toContain('"headingPath"');

    expect(backing.spies.upsertPages).not.toHaveBeenCalled();
    expect(backing.spies.upsertChunks).not.toHaveBeenCalled();
    expect(backing.pages.size).toBe(0);
    expect(backing.chunks.size).toBe(0);
  });
});
