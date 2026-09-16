import { SearchSocketError } from "../errors";
import type { ResolvedSearchSocketConfig } from "../types";
import type { SearchStore } from "./store";
import { UpstashSearchStore, createUpstashRequester } from "./upstash";

/**
 * Internal: the concrete store, for the CLI's administrative commands (scope
 * listing and deletion, legacy migration) that sit outside `SearchStore`.
 */
export async function openUpstashStore(config: ResolvedSearchSocketConfig): Promise<UpstashSearchStore> {
  const url = config.upstash.url ?? process.env[config.upstash.urlEnv];
  const token = config.upstash.token ?? process.env[config.upstash.tokenEnv];

  if (!url || !token) {
    throw new SearchSocketError(
      "VECTOR_BACKEND_UNAVAILABLE",
      `Missing Upstash Vector credentials. Set ${config.upstash.urlEnv} and ${config.upstash.tokenEnv} environment variables, ` +
        "or pass upstash.url and upstash.token in your config."
    );
  }

  const { Index } = await import("@upstash/vector");
  // Our requester rather than the SDK's default client, so an HTTP error keeps
  // its status and is retried or reported by what it is, not by its wording.
  const index = new Index(createUpstashRequester({ url, token }));

  return new UpstashSearchStore({
    index,
    pagesNamespace: config.upstash.namespaces.pages,
    chunksNamespace: config.upstash.namespaces.chunks,
    batchSize: config.upstash.batchSize,
    maxRetries: config.upstash.maxRetries
  });
}

/** Create the Upstash-backed store from a resolved config. */
export async function createUpstashStore(config: ResolvedSearchSocketConfig): Promise<SearchStore> {
  return openUpstashStore(config);
}
