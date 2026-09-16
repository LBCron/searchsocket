# Troubleshooting

## Common issues

### Search returns empty results

1. **Check that your index has data.** Run `pnpm searchsocket status` to see the document count and backend health.

2. **Run the doctor.** `pnpm searchsocket doctor` validates your config, environment variables, and Upstash connectivity. Its write check writes a file into the local state directory — it proves nothing about remote write permission or about the index being the hybrid type indexing needs. A token that reads fine and cannot upsert still passes doctor; `searchsocket index` is what proves that.

3. **Check the Upstash dashboard.** Log into [console.upstash.com](https://console.upstash.com) and verify your Vector index has documents in the correct namespace (`chunks` and `pages`).

4. **Try a broader query.** If a query returns *too few* results rather than none, the `minScoreRatio` threshold (default 0.70) may be trimming the tail. (It cannot produce an empty list: the top-scoring result always survives it.) Lower it temporarily to test:
   ```ts
   ranking: {
     minScoreRatio: 0.5
   }
   ```

5. **Check your scope.** If you indexed under one scope but are searching under another, results will be empty. Run `pnpm searchsocket status` to see the active scope, and verify it matches what your app uses.

### Pages aren't being indexed

- **`data-search-noindex` attribute.** If a page has `<meta name="searchsocket:noindex" content="true">` or uses `<SearchSocket noindex />`, it's excluded.

- **`searchsocket-weight` set to 0.** A weight of 0 skips the page entirely. Check for `<meta name="searchsocket-weight" content="0">`.

- **`robots.txt` blocking.** By default, SearchSocket respects `robots.txt`. If your robots.txt blocks the page, it won't be indexed. Disable with `respectRobotsTxt: false` in config.

- **`<meta name="robots" content="noindex">`** — SearchSocket respects this by default. Disable with `extract.respectRobotsNoindex: false`.

- **`exclude` patterns.** Check your config's `exclude` array for glob patterns that might match the page URL.

- **No `<main>` element.** SearchSocket extracts content from the `<main>` element by default. If your page doesn't have one, configure `extract.mainSelector` to match your content wrapper.

- **Build output missing.** For `static-output` mode, make sure you ran `vite build` before `searchsocket index`. For `build` mode, the build manifest must exist at `.svelte-kit/output`.

### Scroll-to-text isn't working

- **Missing `afterNavigate` hook.** Make sure your root layout includes:
  ```svelte
  <script>
    import { afterNavigate } from '$app/navigation';
    import { searchsocketScrollToText } from 'searchsocket/scroll';
    afterNavigate(searchsocketScrollToText);
  </script>
  ```

- **DOM text doesn't match indexed text.** Scroll-to-text works by finding exact text matches in the DOM using a TreeWalker. If your page heavily transforms content during hydration (e.g., replacing text nodes with interactive components), the indexed text may not match what's in the DOM.

- **Using `buildResultUrl`.** Make sure search result links use `buildResultUrl(result)` from `searchsocket/client`. Plain `result.url` links won't include the scroll parameters.

- **Full page loads vs client navigation.** On SvelteKit client-side navigation, the `afterNavigate` hook handles scrolling. On full page loads, the browser's native Text Fragment support (`#:~:text=`) handles it — this requires Chrome 80+, Safari 16.1+, or Firefox 131+.

### Health check reports the site as up while search is broken

`GET <api.path>/health` answers **503** when the backend is unhealthy and 200 only when
it is healthy. If your uptime monitor was written against the old behaviour — always
200, with `ok: false` in the body — it will now report the outage as a failing check
rather than a passing one. That is the intended reading; adjust the alert, not the
endpoint.

### SSR bundling errors

If you see errors like `Cannot find module 'searchsocket'` during SSR, mark SearchSocket as external:

```ts
// vite.config.ts
export default defineConfig({
  plugins: [sveltekit()],
  ssr: {
    external: ["searchsocket", "searchsocket/sveltekit", "searchsocket/client", "searchsocket/scroll"]
  }
});
```

### Indexing is slow or times out on Vercel

Vercel has build time limits (45 minutes on Pro, 10 minutes on Hobby). For large sites:

- **Use `--changed-only`** (the default). Only changed chunks are re-indexed, so most deploys are fast.
- **Move indexing to GitHub Actions.** Instead of indexing during the Vercel build, use a separate CI job. See [docs/ci.md](ci.md) for ready-to-use workflows.
- **Limit pages for testing.** Use `--max-pages` to index a subset while developing.

SearchSocket automatically detects serverless environments (Vercel, Netlify, Cloudflare Pages, AWS Lambda) and disables in-memory rate limiting, which doesn't work across ephemeral function instances.

### MCP tools not appearing in Claude Code

1. **Check your `.mcp.json`** is in the project root and has valid JSON.
2. **Restart Claude Code** after adding or changing `.mcp.json`.
3. **Verify with `claude mcp list`** — you should see `searchsocket` with three tools.
4. **For HTTP transport**, make sure your server is running (dev server or deployed site).
5. **For stdio transport**, make sure `npx searchsocket mcp` works in your terminal.

### `GEMINI_API_KEY` — do I need it?

No. SearchSocket does not use the Gemini API. Upstash handles all embeddings server-side. You only need the two Upstash environment variables (`UPSTASH_VECTOR_REST_URL` and `UPSTASH_VECTOR_REST_TOKEN`).

Images are made searchable by extracting their text descriptions (`data-search-description`, `alt` text, `figcaption`) during indexing — no separate embedding API is needed.

## Diagnostic commands

| Command | What it checks |
|---------|---------------|
| `pnpm searchsocket doctor` | Config, env vars, Upstash connectivity, **local** state-directory write access |
| `pnpm searchsocket status` | Index health, document count, scope, last indexed time |
| `pnpm searchsocket test` | Search quality assertions and MRR |
| `pnpm searchsocket search --q "test"` | Quick search to verify results |
| `pnpm searchsocket index --dry-run` | Preview indexing without writing |

## Getting help

- [GitHub Issues](https://github.com/gregpriday/searchsocket/issues) — bug reports and feature requests
- `pnpm searchsocket doctor` — always run this first when something isn't working
