# Using SearchSocket MCP with Claude Code

SearchSocket can serve its index to Claude Code (and any other MCP client) in two ways:

- **Over HTTP from your deployed site.** `searchsocketHandle()` can mount an MCP route
  at `/api/mcp`. The index refreshes with every deploy and nothing runs locally.
- **Over stdio from a local process.** `searchsocket mcp` reads your Upstash
  credentials and answers on stdin/stdout. Nothing has to be deployed.

Neither is on without configuration. In particular, the HTTP route is **not**
available on a deployed site by default:

- `mcp.enable` defaults to `NODE_ENV !== "production"`, so a production build does not
  mount the route at all until you set `mcp.enable: true`.
- Once mounted, the route **fails closed**. With `mcp.handle.access: "private"` (the
  default) and no key configured, every call answers **503**. MCP results include
  repository paths (`routeFile`), indexed section text, and any scope the caller names,
  so an unauthenticated route is never served by accident.
- `mcp.handle.access: "public"` is the deliberate opt-out: anonymous callers get a
  redacted result set instead of a 503.

Pick one of the complete setups below. All three assume the index has already been
built (`searchsocket index`, or the Vite plugin with `SEARCHSOCKET_AUTO_INDEX=1` in
your build environment — the plugin does not index unless it is enabled).

## Setup A: local stdio

The simplest setup, and the one `searchsocket init` writes for you. Claude Code starts
`searchsocket mcp` itself; there is no route to deploy and no key to manage.

`.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "searchsocket": {
      "command": "npx",
      "args": ["searchsocket", "mcp"],
      "env": {
        "UPSTASH_VECTOR_REST_URL": "${UPSTASH_VECTOR_REST_URL}",
        "UPSTASH_VECTOR_REST_TOKEN": "${UPSTASH_VECTOR_REST_TOKEN}"
      }
    }
  }
}
```

Claude Code expands `${VAR}` from the environment it was started in, so export both
Upstash variables in your shell. The standalone server runs on loopback and returns
full, unredacted results — it is your own machine talking to your own index.
`mcp.transport` in config (default `stdio`) is used when `--transport` is not passed.

## Setup B: deployed, private (API key)

Use this when the agents connecting are your own: they get full results, including
`routeFile`, and anyone without the key is refused.

**1. Config.** `searchsocket.config.ts`:

```ts
import type { SearchSocketConfig } from "searchsocket";

export default {
  project: { id: "my-site", baseUrl: "https://your-site.com" },
  source: { mode: "build" },
  mcp: {
    enable: true, // required: the default is off in production
    handle: {
      path: "/api/mcp", // default
      access: "private", // default
      apiKeyEnv: "SEARCHSOCKET_MCP_API_KEY"
    }
  }
} satisfies SearchSocketConfig;
```

**2. Hook.** `src/hooks.server.ts`:

```ts
import { searchsocketHandle } from "searchsocket/sveltekit";
import config from "../searchsocket.config";

export const handle = searchsocketHandle({ rawConfig: config });
```

Passing the config object in bundles it with the server, which is what serverless
hosts need — they cannot read `searchsocket.config.ts` from disk at runtime.

**3. Secret.** Generate a key and add it to your hosting platform's environment, next
to the Upstash credentials:

```bash
openssl rand -hex 32
# then, e.g. on Vercel:
vercel env add SEARCHSOCKET_MCP_API_KEY production
```

`apiKeyEnv` reads `process.env`. Under `vite dev`, `.env` files are not loaded into
`process.env`; to test locally either export the variable in your shell or pass
`mcp.handle.apiKey: env.SEARCHSOCKET_MCP_API_KEY` using `$env/dynamic/private`.

**4. Client.** `.mcp.json`:

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "http",
      "url": "https://your-site.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${SEARCHSOCKET_MCP_API_KEY}"
      }
    }
  }
}
```

Each developer exports `SEARCHSOCKET_MCP_API_KEY` in the shell that launches Claude
Code, so the key is never committed. A missing or wrong key is a **401**; a deployment
with no key configured is a **503**.

## Setup C: deployed, anonymous public

Use this when the indexed pages are public documentation and you want any agent to
query them without a credential.

`searchsocket.config.ts`:

```ts
import type { SearchSocketConfig } from "searchsocket";

export default {
  project: { id: "my-site", baseUrl: "https://your-site.com" },
  source: { mode: "build" },
  mcp: {
    enable: true,
    handle: {
      access: "public",
      // Optional. When set, a caller presenting this key still gets full results.
      apiKeyEnv: "SEARCHSOCKET_MCP_API_KEY"
    }
  }
} satisfies SearchSocketConfig;
```

`src/hooks.server.ts` is the same as in Setup B. `.mcp.json` needs no headers:

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "http",
      "url": "https://your-site.com/api/mcp"
    }
  }
}
```

What public access changes:

- A caller sending **no** `Authorization` header is served, but `routeFile`,
  `chunkText` and `breakdown` are stripped from every tool result and any `scope`
  argument is ignored — the same fields the browser search API withholds.
- A caller sending a **valid** bearer key gets full results, so your own editing
  agents can keep using Setup B's `.mcp.json` against the same route.
- A caller sending a **wrong** key still gets a 401, not a silent downgrade.

## Transport details

The route uses `WebStandardStreamableHTTPServerTransport` from
`@modelcontextprotocol/sdk` with `mcp.handle.enableJsonResponse: true` (the default).
Each request is an independent JSON-RPC POST with a JSON response — no session and no
persistent connection — so it works on serverless hosts. GET and DELETE answer 405.

All route options are listed under [MCP in the config reference](config.md#mcp).

## Approving the server in Claude Code

Claude Code asks before it first uses a server from a project `.mcp.json`. To approve
it for the project, and to let its tools run without a prompt each time, add to
`.claude/settings.json`:

```json
{
  "enabledMcpjsonServers": ["searchsocket"],
  "permissions": {
    "allow": ["mcp__searchsocket"]
  }
}
```

## Available MCP tools

Three focused tools. Earlier versions documented six; `list_pages`,
`get_site_structure`, and `find_source_file` no longer exist — `search` with a
`pathPrefix` covers listing, and its `routeFile` field covers source lookup.

### `search`

Semantic search across indexed content. Returns ranked results with URL, title,
snippet, score, and `routeFile` (the SvelteKit source file path). The
highest-ranked results also carry a `chunks` array of section-level sub-results;
lower-ranked results carry a page summary only.

Parameters:
- `query` (string, required) — search query
- `scope` (string) — index scope
- `topK` (number, 1-100) — max results
- `pathPrefix` (string) — filter to a path segment and its subtree (e.g. `"/docs"`, which
  matches `/docs` and `/docs/api` but not `/docsmith`)
- `tags` (string[]) — filter by tags
- `filters` (object) — structured metadata filters (e.g. `{"version": 2}`).
  Values may not contain a quote or backslash; Upstash's filter syntax defines
  no way to escape them, so such values are rejected with a 400.
- `groupBy` (`"page"` | `"chunk"`) — result grouping mode

### `get_page`

Fetch a page's indexed markdown, including frontmatter and `routeFile` mapping.

The markdown is reassembled from the indexed chunks, so it is complete enough to
read and reason about but is **not byte-exact source**: it can contain overlap
between adjacent sections, and a very long page may be truncated at the storage
metadata cap. Read the file at `routeFile` when exact content matters.

Parameters:
- `path` (string, required) — URL path of the page, e.g. `/docs/auth`. This was
  called `pathOrUrl` in earlier versions.
- `scope` (string) — index scope

### `get_related_pages`

Find pages related to a given URL using link graph, semantic similarity, and
structural proximity. Returns related pages ranked by a composite relatedness
score.

Parameters:
- `path` (string, required) — the page URL to find related content for. This was
  called `pathOrUrl` in earlier versions.
- `scope` (string) — index scope
- `topK` (number, 1-25) — max related pages to return

## Running the standalone server over HTTP

`searchsocket mcp --transport http` serves the same tools from a local process instead
of your SvelteKit app. Port and path come from `--port` / `--path`, falling back to
`mcp.http.port` (default `3338`) and `mcp.http.path` (default `/mcp`). It binds to
loopback unless `mcp.access` is `"public"`, which requires a key from
`mcp.http.apiKey`, `mcp.http.apiKeyEnv`, or `--api-key`:

```bash
pnpm searchsocket mcp --transport http
pnpm searchsocket mcp --transport http --access public --api-key "$SEARCHSOCKET_MCP_API_KEY"
```

Put a reverse proxy terminating HTTPS in front of a public standalone server.

## Verifying the connection

After configuring `.mcp.json`, restart Claude Code and check the server is connected:

```bash
claude mcp list
```

You should see `searchsocket` with its three tools. If it fails to connect:

- **503** from the HTTP route — no key is configured and access is private. Set
  `mcp.handle.apiKeyEnv` in config *and* the variable in the deployment environment,
  or use Setup C.
- **404** from the HTTP route — `mcp.enable` is not `true` in production, or the hook
  is not installed.
- **401** — the `Authorization` header is missing or does not match the deployed key.
