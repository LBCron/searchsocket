# Migrating an index from 0.7.x to 0.8

**A full reindex is required.** 0.8 changes how records are identified, and an
0.7.x index cannot be upgraded in place.

## Why

In 0.7.x a page's vector ID was its raw URL, and a chunk's key contained the
scope name but not the project id — while every project shared the same two
Upstash namespaces. Two sites indexed into one Upstash index, both serving
`/docs`, wrote to the same record: the second run silently overwrote the first,
and a lookup could return either. `getPage()` fetched by raw URL and returned
whatever it found without checking which project or scope owned it.

0.8 gives every record an ID that carries the schema version, project id, scope
name, and record type, and verifies all four after any direct fetch.

## What happens on first run

0.8 records carry `schemaVersion: 1`. Every read filters on it, so 0.7.x records
are invisible to 0.8 rather than being misread. Your first 0.8 index run writes
a complete new set of records **beside** the old ones. Nothing is deleted, and
the old records remain available if you need to roll back to 0.7.x.

That means the index temporarily holds both generations, so expect roughly
double the vector count until you run the cleanup below.

## Steps

```bash
# 1. Reindex on the new schema. Nothing is deleted.
pnpm searchsocket index --force

# 2. Confirm the new generation is complete and searching correctly.
pnpm searchsocket status
pnpm searchsocket search --q "a query you know the answer to"

# 3. Inspect what the old generation still holds.
pnpm searchsocket migrate cleanup-legacy

# 4. Delete it, once you are satisfied and past your rollback window.
pnpm searchsocket migrate cleanup-legacy --apply --confirm-project <your-project-id>
```

Step 4 is permanent. Do not run it until step 2 passes — it is the only thing
standing between you and a re-index if something is wrong.

## Breaking changes to check before you migrate

**Project ids and scope names are now validated.** Both may contain only
`a-z`, `A-Z`, `0-9`, `.`, `_`, and `-`, up to 80 characters, because both are
embedded in record IDs and in Upstash filter literals. If you set
`scope.sanitize: false` and rely on branch names containing `/` or spaces, either
re-enable sanitisation or rename the affected scopes. An unsafe name now throws
at config resolution rather than producing a malformed ID.

**Chunk keys no longer depend on chunk position.** A chunk's key is derived from
its page URL, heading path, and a fingerprint of its own text. Previously the key
hashed the chunk's ordinal, so inserting a paragraph near the top of a page
changed the key of every chunk below it and forced the whole page to be
re-embedded. This is why the migration cannot reuse existing chunk records.

**Per-page weights now outrank config patterns, and actually affect ranking.**
A page declaring `searchsocket-weight` (HTML meta) or `searchsocket.weight`
(frontmatter) uses that value; otherwise `ranking.pageWeights` patterns apply.
Previously indexing used a per-page precedence but ranking used *only* the
config patterns, so the two disagreed. They now agree, and they agree on a
**zero veto**: a `0` from *either* source suppresses the page, at index time and
at query time alike. A config `pageWeights` pattern of `0` is an operator-level
veto that page markup cannot override, so `searchsocket-weight="1"` does not
rescue a page a `0` pattern matches. Above zero, the page's own weight is the
more specific statement and wins.

For the same reason, a non-zero per-page weight now changes ranking. It was read
at index time only to drop zero-weight pages, so a page asking to rank higher
had no effect.

**`ranking.enableAnchorTextBoost` now does something.** Page results carry the
anchor text of links pointing at them, so the documented boost applies to the
default page-first search. It was previously inert there — the data was never
loaded — and only affected `groupBy: "chunk"`.

**Config options that never affected anything are removed.** Each was tunable —
documented, typed, exposed in the playground — while having no effect on the
running search. Setting any of them now fails with a migration error naming the
replacement rather than being silently ignored:

| Removed | Use instead |
| --- | --- |
| `search.dualSearch` | nothing — search is page-first |
| `search.pageSearchWeight` | `ranking.weights` |
| `ranking.aggregationCap` | nothing — chunk aggregation is gone |
| `ranking.aggregationDecay` | nothing — chunk aggregation is gone |
| `ranking.minChunkScoreRatio` | the `maxSubResults` request option |
| `ranking.weights.aggregation` | nothing — chunk aggregation is gone |
| `embedding.batchSize` | `upstash.batchSize` |
| `embedding.images.enable` | nothing — SearchSocket is text-only |
| `chunking.weightHeadings` | `chunking.prependTitle` |

The same keys are also rejected in `rankingOverrides` on a search request, which
previously stripped them silently.

**Removed after 0.8 — the rest of the `embedding` section.** These went the same way,
in a later release, and produce the same migration error (which links here). There is
now no `embedding` config section at all:

| Removed | Use instead |
| --- | --- |
| `embedding.model` | nothing — the model belongs to the Upstash index and is chosen when you create it |
| `embedding.dimensions` | nothing — dimensions follow from that model; SearchSocket never generates an embedding itself |
| `embedding.taskType` | nothing — Upstash-hosted embedding takes no task-type parameter |

To change embedding model, create a new Upstash Vector index with it, point
`upstash.url`/`upstash.token` at that index, and reindex.

**The MCP endpoint now requires an API key, and `mcp.enable` is honoured.**
Two changes, both of which can take a working deployment offline if ignored:

1. `searchsocketHandle()` used to mount `/api/mcp` regardless of `mcp.enable`,
   which was documented but never read. `mcp.enable` defaults to
   `NODE_ENV !== "production"`, so a production deployment that relied on the
   endpoint without setting the flag will lose it. Set `mcp.enable: true`.
2. The endpoint's auth check was wrapped in `if (apiKey)`, so a deployment
   without a configured key served MCP to anyone. MCP is privileged — its tools
   return repository paths, a page's indexed markdown, and any scope the caller names —
   so it now refuses to serve at all (503) without a key. Set
   `mcp.handle.apiKey`, or the new `mcp.handle.apiKeyEnv` to read it from the
   environment rather than committing it.

```ts
mcp: {
  enable: true,
  handle: { apiKeyEnv: "SEARCHSOCKET_MCP_API_KEY" }
}
```

**Browser search responses no longer include `routeFile` or `chunkText`.**
`routeFile` is a path inside your repository and `chunkText` is the indexed text
of each matched section; both went to every public caller. They are now opt-in via
`api.exposeInternalFields: true`. `routeFile` is also stripped from the page
endpoint's frontmatter. The `SearchResult.routeFile` type is now optional to
match — code reading it must handle its absence.

**A browser request can no longer choose its scope.** `?scope=` (and `scope` in
a POST body) is refused with a 403 unless the deployment lists it in
`api.allowedScopes`. Any caller could previously read a preview or staging scope
by naming it. Preview deployments should set `api.allowedScopes` explicitly.

**POST /api/search requires `Content-Type: application/json`.** A missing or
different type is a 415. Without this the endpoint accepted a form POST, which a
browser sends cross-origin without a preflight — so the CORS policy was never
consulted. The bundled client already sends the correct header.

**`UpstashSearchStore` is no longer exported from the package root.** It was
public by accident, which made its internals part of the compatibility surface.
Use `createUpstashStore(config)`. `SearchSocketError`, `INDEX_SCHEMA_VERSION`,
and the result types (`SearchResult`, `PageRecord`, `RelatedPagesResult`,
`RunWarning`, …) are now exported instead, so consumer code can name what public
methods return without importing from internal paths.

**Node 22.12 is the minimum.** Node 20 reached end of life in March 2026, and the
CommonJS build requires an ESM-only dependency, which needs unflagged
`require(ESM)` — available from 22.12. CI tests 22 and 24.

**Filter values may not contain a quote or backslash.** Upstash Vector's filter
syntax documents single-quoted string literals but defines no escape sequence for
an embedded quote or backslash, so SearchSocket now rejects such values in
structured metadata filters (HTTP `filters`, MCP `filters`) with a 400 rather
than guessing at an escaping rule that could silently widen a query across
tenants. Page URLs containing those characters still index and search normally —
the URL match falls back to local filtering.

**Indexing runs refuse to delete when incomplete.** A run truncated by
`--max-pages`/`--max-chunks`, or one that failed to fetch or extract a page, now
reports `deletionEligible: false` and deletes nothing. If you relied on
`--max-pages` runs pruning the index, that never worked safely — it deleted every
page beyond the limit.

**`clean --remote` is a dry run** until you add `--apply`, and deletes a single
scope rather than the whole project. Project-wide deletion needs
`--all-scopes --confirm-project <id>`.

**`prune` fails closed.** It refuses to run when the remote branch list cannot be
trusted — a shallow clone, no configured remotes, or an empty `--scopes-file`.
In CI, check out with `fetch-depth: 0`. It also now requires a scope to be *both*
orphaned and inactive when `--older-than` is given; pass `--match any` for the
old behaviour.

**`searchsocket index` exits 5 when no vector backend is configured** instead of
exiting 0. Pass `--allow-unconfigured` to keep the old behaviour in builds where
indexing is optional.
