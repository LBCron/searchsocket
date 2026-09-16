import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import {
  buildEmbeddingText,
  chunkDisplayText,
  chunkPage,
  pageSummaryChunkKey,
  stripEmbeddingPrefix
} from "../src/indexing/chunker";
import { SearchEngine } from "../src/search/engine";
import { buildResultUrl } from "../src/client";
import type { Chunk, IndexedPage, PageHit, Scope, VectorHit } from "../src/types";
import type { UpstashSearchStore } from "../src/vector/upstash";

/**
 * Stored `chunkText` is the embedding text, prefix and all. Everything a reader
 * sees — snippets, `chunkText` on a result, and the deep-link text target built
 * from a snippet — must come from the section body instead.
 */

const scope: Scope = { projectId: "p", scopeName: "main", scopeId: "p:main" };

const page: IndexedPage = {
  url: "/docs/worktrees/create",
  title: "Create and Link Worktrees",
  scope: "main",
  routeFile: "src/routes/docs/worktrees/create/+page.svelte",
  routeResolution: "exact",
  generatedAt: "2026-01-01T00:00:00.000Z",
  incomingLinks: 1,
  outgoingLinks: 0,
  depth: 3,
  tags: [],
  description: "Worktrees give each agent its own checkout.",
  keywords: ["worktree", "branch"],
  markdown:
    "## Creating worktrees from issues\n\nThe quickest way to start is from an issue: pick it and a worktree is created on a new branch."
};

/** The metadata a record is written with, as the store reads it back. */
function storedMetadata(chunk: Chunk, prependTitle: boolean) {
  return {
    url: chunk.url,
    title: chunk.title,
    sectionTitle: chunk.sectionTitle ?? "",
    headingPath: chunk.headingPath,
    keywords: chunk.keywords,
    chunkText: buildEmbeddingText(chunk, prependTitle)
  };
}

describe.each([true, false])("chunkDisplayText with prependTitle %s", (prependTitle) => {
  const config = createDefaultConfig("p");
  config.chunking.prependTitle = prependTitle;
  const chunks = chunkPage(page, config, scope);
  const summary = chunks.find((c) => c.headingPath.length === 0)!;
  const section = chunks.find((c) => c.sectionTitle === "Creating worktrees from issues")!;

  it("returns a section's body exactly", () => {
    expect(chunkDisplayText(storedMetadata(section, prependTitle), { prependTitle, isPageSummary: false })).toBe(
      section.chunkText
    );
  });

  it("reduces a page summary to its description", () => {
    expect(summary.chunkKey).toBe(pageSummaryChunkKey(page.url));
    expect(chunkDisplayText(storedMetadata(summary, prependTitle), { prependTitle, isPageSummary: true })).toBe(
      page.description
    );
  });

  it("never strips title-leading text from a record that is not a summary", () => {
    const humanizedLead = `${page.title}\n\ndocs / worktrees / create\n\nReal paragraph.`;
    const metadata = { url: page.url, title: page.title, sectionTitle: "", keywords: [], chunkText: humanizedLead };
    const stored = prependTitle ? { ...metadata, chunkText: `${page.title}\n\n${humanizedLead}` } : metadata;
    expect(chunkDisplayText(stored, { prependTitle, isPageSummary: false })).toBe(humanizedLead);
  });
});

describe("stripEmbeddingPrefix", () => {
  it("leaves text that does not carry the exact prefix alone", () => {
    expect(stripEmbeddingPrefix("Intro — Setup is easy", "Intro", "Setup")).toBe("Intro — Setup is easy");
    expect(stripEmbeddingPrefix("Body", "", undefined)).toBe("Body");
  });
});

describe("search results never expose the embedding prefix", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  function asHit(chunk: Chunk, score: number, prependTitle = true): VectorHit {
    return {
      id: chunk.chunkKey,
      score,
      metadata: {
        projectId: "p",
        scopeName: "main",
        path: chunk.path,
        snippet: chunk.snippet,
        ordinal: chunk.ordinal,
        contentHash: chunk.contentHash,
        depth: chunk.depth,
        incomingLinks: chunk.incomingLinks,
        routeFile: chunk.routeFile,
        tags: chunk.tags,
        ...storedMetadata(chunk, prependTitle)
      }
    };
  }

  async function engineFor(hits: VectorHit[], prependTitle = true) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-display-"));
    tempDirs.push(cwd);
    const pageHit: PageHit = {
      id: page.url,
      score: 0.9,
      title: page.title,
      url: page.url,
      description: page.description ?? "",
      tags: [],
      depth: page.depth,
      incomingLinks: page.incomingLinks,
      routeFile: page.routeFile
    };
    const store = {
      searchPagesByText: vi.fn(async () => [pageHit]),
      searchChunksByUrl: vi.fn(async () => hits),
      search: vi.fn(async () => hits)
    };
    const config = createDefaultConfig("p");
    config.chunking.prependTitle = prependTitle;
    return SearchEngine.create({ cwd, config, store: store as unknown as UpstashSearchStore });
  }

  const chunks = chunkPage(page, createDefaultConfig("p"), scope);
  const section = chunks.find((c) => c.sectionTitle === "Creating worktrees from issues")!;
  const summary = chunks.find((c) => c.headingPath.length === 0)!;

  it("builds page-first snippets, chunkText and the deep link from the body", async () => {
    const engine = await engineFor([asHit(section, 0.8)]);
    const response = await engine.search({ q: "worktrees issues", groupBy: "page" });
    const result = response.results[0]!;

    expect(result.snippet).not.toContain(page.title);
    expect(result.snippet).toContain("The quickest way");
    expect(result.chunkText).toBe(section.chunkText);
    expect(result.chunks?.[0]?.snippet).not.toContain(page.title);

    const url = new URL(buildResultUrl(result), "https://site.example");
    expect(url.searchParams.get("_sskt")).not.toContain(page.title);
    expect(url.searchParams.get("_ssk")).toBe("Creating worktrees from issues");
  });

  it("does not repeat the title in a page-summary snippet", async () => {
    const engine = await engineFor([asHit(summary, 0.8)]);
    const response = await engine.search({ q: "worktrees", groupBy: "chunk" });

    expect(response.results[0]!.snippet).toBe(page.description);
  });

  it("keeps a body that opens with the page title when titles are not prepended", async () => {
    const introPage: IndexedPage = { ...page, title: "Intro", markdown: "Intro\n\nActual content lives here." };
    const config = createDefaultConfig("p");
    config.chunking.prependTitle = false;
    const body = chunkPage(introPage, config, scope).find((c) => c.chunkKey !== pageSummaryChunkKey(introPage.url))!;
    expect(body.chunkText.startsWith("Intro\n\n")).toBe(true);

    const hit = asHit({ ...body, title: "Intro" }, 0.8, false);
    const engine = await engineFor([hit], false);
    const response = await engine.search({ q: "zzz", groupBy: "chunk" });
    expect(response.results[0]!.chunkText).toBe(body.chunkText);
    expect(response.results[0]!.snippet).toBe("Intro Actual content lives here.");
  });

  it("keeps title-leading text in a headingless body chunk", async () => {
    const leadPage: IndexedPage = {
      ...page,
      markdown: `${page.title}\n\ndocs / worktrees / create\n\nReal paragraph.`
    };
    const config = createDefaultConfig("p");
    const body = chunkPage(leadPage, config, scope).find((c) => c.chunkKey !== pageSummaryChunkKey(leadPage.url))!;
    const engine = await engineFor([asHit(body, 0.8)]);
    const response = await engine.search({ q: "zzz", groupBy: "chunk" });
    expect(response.results[0]!.snippet).toBe(`${page.title} docs / worktrees / create Real paragraph.`);
  });
});
