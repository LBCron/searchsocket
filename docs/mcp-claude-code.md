# Using SearchSocket MCP with Claude Code over HTTP

SearchSocket exposes an MCP endpoint through its SvelteKit hook handler. Once your site is deployed to Vercel, Cloudflare, Netlify, or any other platform, the MCP endpoint is available at `/api/mcp` — ready for Claude Code to connect to.

This is the recommended setup: deploy your site, index on build, and point Claude Code at the production endpoint. The index stays current with every deploy, and there's nothing to run locally.

## Why HTTP?

- **Always up to date** — the index refreshes on every deploy, so Claude Code always searches current content
- **No local process** — the MCP server runs inside your deployed SvelteKit app
- **Works everywhere** — connect to production, staging, or preview deployments
- **Serverless-compatible** — each request is a stateless JSON-RPC POST, no persistent connection needed
- **No env vars in MCP config** — credentials live in your hosting platform's environment, not in `.mcp.json`

## Server-side setup

The MCP endpoint is enabled automatically when you use `searchsocketHandle()` in your SvelteKit hooks. No additional configuration is required for local development.

In `src/hooks.server.ts`:

```ts
import { searchsocketHandle } from "searchsocket/sveltekit";

export const handle = searchsocketHandle();
```

The default MCP endpoint path is `/api/mcp`. You can customize it and add API key authentication via config:

```ts
export const handle = searchsocketHandle({
  rawConfig: {
    // ... other config
    mcp: {
      enable: true,                  // defaults to NODE_ENV !== 'production'
      handle: {
        path: '/api/mcp',            // default
        // Required. Without a key the endpoint answers 503 — it exposes
        // repository paths, indexed page markdown, and arbitrary scopes.
        apiKeyEnv: 'SEARCHSOCKET_MCP_API_KEY',
        enableJsonResponse: true     // default, required for serverless
      }
    }
  }
});
```

The transport uses `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` with `enableJsonResponse: true`, making it fully stateless and serverless-compatible. Each request is an independent JSON-RPC POST — no session or persistent connection is needed.

## Claude Code configuration

Claude Code supports remote HTTP MCP servers natively. Add a `.mcp.json` file to your project root.

### Deployed site (recommended)

Point to your deployed site:

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

The index stays current automatically — every deploy rebuilds the index via the Vite plugin.

### Local development

During development, you can point to your local dev server instead:

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "http",
      "url": "http://localhost:5173/api/mcp"
    }
  }
}
```

Make sure your dev server is running (`pnpm dev`) before starting Claude Code.

### With API key authentication

Pass the configured key via a Bearer token header:

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "http",
      "url": "https://your-site.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${SEARCHSOCKET_API_KEY}"
      }
    }
  }
}
```

The `${SEARCHSOCKET_API_KEY}` syntax references an environment variable so you don't hardcode secrets in `.mcp.json`.

### Auto-approving the MCP server

By default, Claude Code prompts for approval when an MCP tool is invoked. To skip the prompt, add the server to `.claude/settings.json`:

```json
{
  "allowedMcpServers": [
    { "serverName": "searchsocket" }
  ]
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

## Stdio alternative

For local development, you can also use stdio transport which spawns a local SearchSocket process:

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "stdio",
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

This approach requires Upstash credentials in the MCP config and runs a separate process. The HTTP approach avoids both of these requirements.

## Verifying the connection

After configuring `.mcp.json`, restart Claude Code and verify the tools are available:

```bash
claude mcp list
```

You should see `searchsocket` listed with its three tools. You can then use natural language to search your site content directly from Claude Code — for example, "search my docs for authentication" or "find the source file for the getting started page".
