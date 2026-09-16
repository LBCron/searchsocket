import type { PageHit, PageRecord, Scope, VectorHit } from "../types";
import type { ChunkHashEntry, ChunkInventoryEntry, PageHashEntry, RetrievalConstraints } from "./upstash";

/** A metadata-only update to one stored record. */
export interface StoreMetadataUpdate {
  id: string;
  metadata: Record<string, unknown>;
}

/** One record to write: its ID, the text Upstash embeds, and its metadata. */
export interface StoreRecord {
  id: string;
  data: string;
  metadata: Record<string, unknown>;
}

/** Options shared by the store's ranked queries. */
export type StoreQueryOptions = {
  limit: number;
  filter?: string;
} & RetrievalConstraints;

/**
 * The read side of a store: exactly what `SearchEngine` calls.
 *
 * Every method is scope-bound; an implementation must never return a record
 * that belongs to a different project or scope than the one it was given.
 */
export interface SearchStoreReader {
  search(data: string, opts: StoreQueryOptions, scope: Scope): Promise<VectorHit[]>;
  searchChunksByUrl(
    data: string,
    url: string,
    opts: { limit: number; filter?: string; tags?: string[] },
    scope: Scope
  ): Promise<VectorHit[]>;
  searchPagesByText(data: string, opts: StoreQueryOptions, scope: Scope): Promise<PageHit[]>;
  searchPagesByVector(vector: number[], opts: StoreQueryOptions, scope: Scope): Promise<PageHit[]>;
  listPages(
    scope: Scope,
    opts?: { cursor?: string; limit?: number; pathPrefix?: string }
  ): Promise<{
    pages: Array<{ url: string; title: string; description: string; routeFile: string }>;
    nextCursor?: string;
  }>;
  getPage(url: string, scope: Scope): Promise<PageRecord | null>;
  fetchPageWithVector(
    url: string,
    scope: Scope
  ): Promise<{ metadata: { outgoingLinkUrls?: string[]; [key: string]: unknown }; vector: number[] } | null>;
  fetchPagesBatch(
    urls: string[],
    scope: Scope
  ): Promise<Array<{ url: string; title: string; routeFile: string; outgoingLinkUrls: string[] }>>;
  health(): Promise<{ ok: boolean; details?: string }>;
}

/** The write side of a store: exactly what `IndexPipeline` calls. */
export interface SearchStoreWriter {
  getPageHashes(scope: Scope): Promise<Map<string, PageHashEntry>>;
  fetchContentHashesForKeys(keys: string[], scope: Scope): Promise<Map<string, ChunkHashEntry>>;
  scanChunkIds(scope: Scope): Promise<Map<string, boolean>>;
  /**
   * The scope's chunk inventory with each chunk's page URL. Optional: without
   * it, removing an excluded page can only find the chunks its record's
   * manifest names, so older generations and manifest-less pages keep theirs.
   */
  scanChunkInventory?(scope: Scope): Promise<Map<string, ChunkInventoryEntry>>;
  upsertChunks(chunks: StoreRecord[], scope: Scope): Promise<void>;
  /** Returns the keys of records that no longer exist, so the caller can re-upsert them. */
  updateChunkMetadata(items: StoreMetadataUpdate[], scope: Scope): Promise<string[]>;
  upsertPages(pages: StoreRecord[], scope: Scope): Promise<void>;
  /** Returns the keys of records that no longer exist, so the caller can re-upsert them. */
  updatePageMetadata(items: StoreMetadataUpdate[], scope: Scope): Promise<string[]>;
  deleteByIds(keys: string[], scope: Scope): Promise<void>;
  deletePagesByIds(urls: string[], scope: Scope): Promise<void>;
}

/**
 * The storage contract the public API accepts and returns.
 *
 * Deliberately narrower than the Upstash implementation: administrative
 * operations the CLI uses (scope listing and deletion, legacy-record
 * migration, dropping indexes) are not part of it, so they stay free to change.
 */
export interface SearchStore extends SearchStoreReader, SearchStoreWriter {}
