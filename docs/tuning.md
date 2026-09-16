# Tuning Search Relevance

SearchSocket includes a visual playground for tuning ranking parameters and a test runner for measuring search quality. Use them together: tune with the playground, lock in your improvements with test assertions.

## Playground

The playground is a browser-based UI for experimenting with search queries and ranking parameters in real time.

### Starting the playground

```bash
pnpm searchsocket dev
```

Open `http://127.0.0.1:3337/_searchsocket` in your browser. The playground starts automatically alongside the file watcher (disable with `--no-playground`).

```bash
# Custom port
pnpm searchsocket dev --playground-port 4000

# With MCP server alongside
pnpm searchsocket dev --mcp
```

### What the playground does

The playground has two parts: a **search interface** and a **ranking tuner**.

**Search interface:**
- Type a query, see ranked results instantly (300ms debounce)
- Switch between page and chunk grouping
- Adjust top-K (5, 10, 20, 50)
- Each result shows its score, route file, section title, and snippet
- Expand results to see individual matching chunks with heading paths

**Ranking tuner** (collapsible panel):
- Adjust thresholds (`minScoreRatio`, `scoreGapThreshold`), the incoming-link and depth
  boost toggles, and the `incomingLinks`, `depth` and `titleMatch` weights via sliders
- Changes are applied to searches immediately — no restart needed
- Modified parameters are highlighted so you can see what you've changed
- Reset individual parameters or all at once

### Tuner parameters

#### Thresholds

| Parameter | Default | Description |
|-----------|---------|-------------|
| `minScoreRatio` | 0.70 | Drop results below this ratio of the best score |
| `scoreGapThreshold` | 0.40 | Page mode only: cut the list at the first *adjacent* pair whose score drops by this fraction |

`minScoreRatio` compares every result to the top one. `scoreGapThreshold` compares each
result to the one immediately above it and truncates the list at the first cliff, so a
long smooth tail survives it while a sudden drop does not. It applies to page mode only;
chunk mode (`groupBy: "chunk"`) uses `minScoreRatio` alone. Both are relative: final
scores include additive boosts and, in page mode, a `pageWeights` multiplier, so they are
not confined to 0–1 and are not confidence values. Neither threshold can empty a
non-empty result list — the top result always survives both.

#### Boost toggles

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enableIncomingLinkBoost` | true | Boost pages with more internal links pointing to them |
| `enableDepthBoost` | true | Boost shallower pages |

#### Weights

| Parameter | Default | Description |
|-----------|---------|-------------|
| `incomingLinks` | 0.05 | Weight for incoming link count boost |
| `depth` | 0.03 | Weight for URL depth boost |
| `titleMatch` | 0.15 | Weight for query-in-title boost |

The title and anchor-text boosts compare Unicode letters and digits (`\p{L}`/`\p{N}`),
not ASCII, so Japanese, Cyrillic, Greek and accented-Latin titles are matched instead of
being folded away to nothing. Text is lowercased and NFC-normalized, which unifies the
two spellings of a precomposed character (`é` versus `e` + combining acute). Accents are
**preserved, not stripped**: a query for `cafe` does not get the title boost on a page
called `café`. Accent-insensitive recall would need a script-aware policy, so it is
deliberately not done here.

### Score breakdowns

The playground enables debug mode automatically. Each result shows a breakdown of how its score was calculated:

- **Base score** — vector similarity from Upstash
- **Incoming link boost** — `log(1 + incomingLinks) * weight`
- **Depth boost** — `1 / (1 + depth) * weight`
- **Title match boost** — full weight if query appears in title
- **Anchor text boost** — full weight if query matches incoming link text
- **Freshness boost** — `1 / (1 + daysSince * decayRate) * weight`

Breakdowns and per-request ranking overrides come from the playground's own local
server, which calls the search engine directly. The public HTTP endpoint refuses
`debug` and `rankingOverrides` with a 403 for being present at all, so tune through
the playground or a direct `SearchEngine.search()` call — not through `/api/search`.

### Exporting your config

Once you're happy with the results, click **Export Config**. The playground generates a config snippet containing only the parameters you changed:

```ts
ranking: {
  minScoreRatio: 0.65,
  scoreGapThreshold: 0.3,
  weights: {
    incomingLinks: 0.06,
    titleMatch: 0.20,
  },
},
```

Paste this into your `searchsocket.config.ts`:

```ts
export default {
  // ... other config
  ranking: {
    minScoreRatio: 0.65,
    scoreGapThreshold: 0.3,
    weights: {
      incomingLinks: 0.06,
      titleMatch: 0.20
    }
  }
};
```

### Tips for tuning

- **Start with thresholds.** `minScoreRatio` has the biggest impact on result quality — it controls how many low-relevance results are trimmed. Higher values (0.75–0.85) give cleaner results but may miss relevant content.
- **Use gentle weight adjustments.** Weights compound with each other. Moving `titleMatch` from 0.15 to 0.20 has a noticeable effect.
- **Test with diverse queries.** Try broad queries ("getting started"), specific queries ("API rate limit"), and off-topic queries ("xyzzy gibberish nonsense"). The off-topic one will still return something — both thresholds are relative, so the best candidate always survives. Read it as a diagnostic: if the best guess for nonsense looks plausible, your snippets and titles are doing their job; if it looks absurd, that is a content problem, not a threshold you can turn up.
- **Watch the score breakdowns.** If `depthBoost` is dominating, shallow pages will always rank highest regardless of relevance. Reduce `depth` weight or disable it.

## Search quality testing

The `searchsocket test` command runs search queries against your live index and checks the results against expected outcomes. Use it to prevent search regressions.

### Writing test assertions

Create a `searchsocket.test.json` file in your project root:

```json
[
  {
    "query": "installation",
    "expect": {
      "topResult": "/docs/getting-started"
    }
  },
  {
    "query": "API authentication",
    "expect": {
      "inTop5": ["/docs/api/auth", "/docs/api/keys"]
    }
  },
  {
    "query": "pricing",
    "expect": {
      "maxResults": 5
    }
  }
]
```

`maxResults` is a ceiling on how far a result list is allowed to sprawl, not a way
to assert that a query returns nothing. Relative trimming cannot empty a non-empty
list — the top result always survives — so `"maxResults": 0` is not an assertion
that a query is off-topic. It passes only when nothing eligible came back at all:
an empty scope, filters that match no records, or a backend returning nothing.

### Available assertions

| Assertion | Description |
|-----------|-------------|
| `topResult` | Assert that a specific URL ranks at position 1 |
| `inTop5` | Assert that all listed URLs appear in the top 5 results |
| `maxResults` | Assert that the result count does not exceed this number |

Assertions can be combined in a single test case:

```json
{
  "query": "deployment guide",
  "expect": {
    "topResult": "/docs/deploy",
    "inTop5": ["/docs/deploy", "/docs/ci-cd"],
    "maxResults": 20
  }
}
```

### Running tests

```bash
# Default test file (searchsocket.test.json)
pnpm searchsocket test

# Custom file
pnpm searchsocket test --file tests/search-quality.json

# Custom scope and top-K
pnpm searchsocket test --scope staging --top-k 20
```

### Output

The test runner reports:

- Pass/fail for each assertion with details (e.g., "expected /docs/api at rank 1, got rank 3")
- For `inTop5` failures, the actual rank of each missing URL
- **MRR (Mean Reciprocal Rank)** across all queries that have `topResult` or `inTop5` assertions

MRR is a standard information retrieval metric: the average of `1/rank` for the first relevant result in each query. An MRR of 1.0 means every expected result ranked first. Lower values are the mean of the reciprocals, not the reciprocal of the mean rank — two results at rank 2 give 0.5, but so does one result at rank 1 paired with a query that missed entirely, since a miss contributes 0. Read it alongside the per-query output rather than on its own.

### Using tests in CI/CD

Add search quality checks to your CI pipeline:

```yaml
- run: pnpm searchsocket test
  env:
    UPSTASH_VECTOR_REST_URL: ${{ secrets.UPSTASH_VECTOR_REST_URL }}
    UPSTASH_VECTOR_REST_TOKEN: ${{ secrets.UPSTASH_VECTOR_REST_TOKEN }}
```

The command exits with code 1 if any assertion fails, so it works as a CI gate.

### Workflow

1. Run `pnpm searchsocket dev` and open the playground
2. Search for queries that matter to your users
3. Tune ranking parameters until the results look right
4. Export the config and update `searchsocket.config.ts`
5. Write test assertions for your key queries in `searchsocket.test.json`
6. Run `pnpm searchsocket test` locally to confirm
7. Add the test to CI to catch future regressions
