# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.x | Yes |
| 0.11.x | Security fixes only, until three months after the 1.0.0 release |
| 0.8.x – 0.10.x | No — upgrade to 1.0 |
| ≤ 0.7.x | No — upgrade, see [docs/migration-0.8.md](docs/migration-0.8.md) |

## Reporting a vulnerability

Please report security issues privately, not as a public GitHub issue.

Use [GitHub's private vulnerability reporting](https://github.com/gregpriday/searchsocket/security/advisories/new),
or email <greg@siteorigin.com>.

Include the version, a description of the issue, and — where you can — steps to
reproduce it. You can expect an acknowledgement within a few days.

## Security model

SearchSocket splits its surfaces into public and privileged, and they are not
interchangeable.

**Public** — the browser search API mounted by `searchsocketHandle()`:

- Returns URLs, titles, and snippets. It omits `routeFile` (a path inside your
  repository) and `chunkText` (the matched section's indexed text) unless you
  set `api.exposeInternalFields: true`.
- Cannot choose which scope it reads. A `?scope=` parameter, or a `scope` field
  in a POST body, is refused with a 403 unless the scope appears in
  `api.allowedScopes`.
- Requires `Content-Type: application/json` on POST, so a cross-origin form post
  cannot bypass the CORS policy by avoiding a preflight.

**Privileged** — the MCP endpoint and the standalone MCP server:

- Return repository paths, a page's indexed markdown, and any scope the caller names.
- The SvelteKit MCP route fails closed. With neither `mcp.handle.apiKey` nor
  `mcp.handle.apiKeyEnv` set it answers 503 rather than serving unauthenticated,
  unless the deployment sets `mcp.handle.access: "public"`. Under public access an
  anonymous caller — one sending no `Authorization` header at all — is served a
  *redacted* result set: the same fields the browser API withholds are stripped, and
  a caller-supplied `scope` is ignored. A request that does send an `Authorization`
  header is still answered 401 when the credential is wrong, even under public
  access, rather than being downgraded to the anonymous result set.
- `mcp.enable: false` removes the route entirely.
- The standalone server binds to loopback unless `mcp.access: "public"`, which
  in turn requires `mcp.http.apiKey` or `mcp.http.apiKeyEnv`. Put it behind a
  reverse proxy terminating HTTPS before exposing it.

**Indexing and storage:**

- Records carry the project id, scope name, and schema version in both their ID
  and metadata, and every read verifies all three, so one project or scope
  cannot read or overwrite another's records in a shared Upstash index.
- Project ids and scope names are restricted to `[A-Za-z0-9._-]`. Filter values
  containing a quote or backslash are rejected rather than escaped, because
  Upstash's filter syntax defines no escape sequence and guessing one risks
  widening a query across tenants.
- Crawl requests have timeouts, response size caps, and a same-origin redirect
  policy, so a redirect in fetched content cannot send the crawler at an
  internal address.

## Things that are not vulnerabilities

- Indexed content being searchable. SearchSocket indexes what you point it at;
  exclude what should not be searchable via `exclude`, `robots.txt`,
  `<meta name="robots" content="noindex">`, or a zero page weight.
- The absence of built-in distributed rate limiting. The in-memory limiter is
  per-instance and disables itself on serverless; use your platform's limiter.
