/**
 * One table of wire payloads, run through both browser entry points:
 * `tests/client.test.ts` feeds it to `createSearchClient`, and
 * `tests/svelte/response-validation.test.ts` feeds it to `createSearch`.
 *
 * The two share a validator today, but that is an implementation detail a future
 * edit could undo. The conformance suites are what actually pins them together,
 * so this table stays the single source of cases for both.
 */
export interface ResponseValidationCase {
  name: string;
  payload: unknown;
  /** Whether the response as a whole is accepted. Only a broken envelope is refused. */
  valid: boolean;
  /**
   * For an accepted response, the result URLs that survive — a malformed or
   * unsafe row is dropped rather than failing the response.
   */
  urls?: string[];
  /** For an accepted response, how many chunk rows each surviving result keeps. */
  chunkCounts?: number[];
}

export const RESPONSE_VALIDATION_CASES: ResponseValidationCase[] = [
  {
    name: "a well-formed response",
    payload: {
      q: "test",
      scope: "main",
      results: [
        {
          url: "/docs/intro",
          title: "Intro",
          snippet: "Welcome",
          score: 0.9,
          chunks: [{ sectionTitle: "Setup", snippet: "Install", headingPath: ["Docs"], score: 0.4 }]
        }
      ],
      meta: { timingsMs: { search: 1, total: 2 } }
    },
    valid: true,
    urls: ["/docs/intro"],
    chunkCounts: [1]
  },
  {
    name: "a response mixing valid and invalid rows, keeping only the valid ones",
    payload: {
      q: "test",
      scope: "main",
      results: [
        { url: "/good", title: "Good", snippet: "x", score: 0.9 },
        { url: "", title: "Empty URL", snippet: "x", score: 0.8 },
        null,
        {
          url: "/also-good",
          title: "Also good",
          snippet: "x",
          score: 0.7,
          chunks: [
            { snippet: "kept", headingPath: [], score: 0.5 },
            { snippet: 7, headingPath: [], score: 0.4 }
          ]
        }
      ],
      meta: { timingsMs: { search: 1, total: 2 } }
    },
    valid: true,
    urls: ["/good", "/also-good"],
    chunkCounts: [0, 1]
  },
  {
    name: "a results field that is not an array",
    payload: { q: "test", scope: "main", results: null, meta: { timingsMs: { search: 0, total: 0 } } },
    valid: false
  },
  {
    name: "chunks that are not an array, dropping the row",
    payload: {
      q: "test",
      scope: "main",
      results: [{ url: "/a", title: "A", snippet: "x", score: 1, chunks: "nope" }],
      meta: { timingsMs: { search: 0, total: 0 } }
    },
    valid: true,
    urls: []
  },
  {
    name: "a NaN result score, dropping the row",
    payload: {
      q: "test",
      scope: "main",
      results: [{ url: "/a", title: "A", snippet: "x", score: Number.NaN }],
      meta: { timingsMs: { search: 0, total: 0 } }
    },
    valid: true,
    urls: []
  },
  {
    name: "an Infinity result score, dropping the row",
    payload: {
      q: "test",
      scope: "main",
      results: [{ url: "/a", title: "A", snippet: "x", score: Number.POSITIVE_INFINITY }],
      meta: { timingsMs: { search: 0, total: 0 } }
    },
    valid: true,
    urls: []
  },
  {
    name: "a NaN chunk score, dropping the chunk",
    payload: {
      q: "test",
      scope: "main",
      results: [
        {
          url: "/a",
          title: "A",
          snippet: "x",
          score: 1,
          chunks: [{ snippet: "s", headingPath: [], score: Number.NaN }]
        }
      ],
      meta: { timingsMs: { search: 0, total: 0 } }
    },
    valid: true,
    urls: ["/a"],
    chunkCounts: [0]
  },
  {
    name: "a chunk that is an arbitrary object, dropping the chunk",
    payload: {
      q: "test",
      scope: "main",
      results: [{ url: "/a", title: "A", snippet: "x", score: 1, chunks: [{ nope: true }] }],
      meta: { timingsMs: { search: 0, total: 0 } }
    },
    valid: true,
    urls: ["/a"],
    chunkCounts: [0]
  },
  {
    name: "a chunk missing its snippet, dropping the chunk",
    payload: {
      q: "test",
      scope: "main",
      results: [
        { url: "/a", title: "A", snippet: "x", score: 1, chunks: [{ headingPath: [], score: 0.5 }] }
      ],
      meta: { timingsMs: { search: 0, total: 0 } }
    },
    valid: true,
    urls: ["/a"],
    chunkCounts: [0]
  },
  {
    name: "a chunk headingPath holding non-strings, dropping the chunk",
    payload: {
      q: "test",
      scope: "main",
      results: [
        {
          url: "/a",
          title: "A",
          snippet: "x",
          score: 1,
          chunks: [{ snippet: "s", headingPath: [7], score: 0.5 }]
        }
      ],
      meta: { timingsMs: { search: 0, total: 0 } }
    },
    valid: true,
    urls: ["/a"],
    chunkCounts: [0]
  },
  {
    name: "a missing timingsMs",
    payload: { q: "test", scope: "main", results: [], meta: {} },
    valid: false
  },
  {
    name: "a non-numeric timing field",
    payload: {
      q: "test",
      scope: "main",
      results: [],
      meta: { timingsMs: { search: "fast", total: 2 } }
    },
    valid: false
  },
  {
    name: "a NaN timing field",
    payload: {
      q: "test",
      scope: "main",
      results: [],
      meta: { timingsMs: { search: Number.NaN, total: 2 } }
    },
    valid: false
  },
  {
    name: "a javascript: result URL, dropping the row",
    payload: {
      q: "test",
      scope: "main",
      results: [{ url: "javascript:alert(1)", title: "A", snippet: "x", score: 1 }],
      meta: { timingsMs: { search: 0, total: 0 } }
    },
    valid: true,
    urls: []
  },
  {
    name: "a data: result URL, dropping the row",
    payload: {
      q: "test",
      scope: "main",
      results: [{ url: "data:text/html;base64,PHN2Zz4=", title: "A", snippet: "x", score: 1 }],
      meta: { timingsMs: { search: 0, total: 0 } }
    },
    valid: true,
    urls: []
  },
  {
    name: "a control-character-obfuscated result URL, dropping the row",
    payload: {
      q: "test",
      scope: "main",
      results: [{ url: "java\nscript:alert(1)", title: "A", snippet: "x", score: 1 }],
      meta: { timingsMs: { search: 0, total: 0 } }
    },
    valid: true,
    urls: []
  },
  {
    name: "a hostless http result URL, dropping the row",
    payload: {
      q: "test",
      scope: "main",
      results: [{ url: "http://", title: "A", snippet: "x", score: 1 }],
      meta: { timingsMs: { search: 0, total: 0 } }
    },
    valid: true,
    urls: []
  },
  {
    name: "an unparseable authority in a result URL, dropping the row",
    payload: {
      q: "test",
      scope: "main",
      results: [{ url: "https://example.com:70000/a", title: "A", snippet: "x", score: 1 }],
      meta: { timingsMs: { search: 0, total: 0 } }
    },
    valid: true,
    urls: []
  },
  {
    name: "a non-numeric timingsMs.total",
    payload: {
      q: "test",
      scope: "main",
      results: [],
      meta: { timingsMs: { search: 1, total: null } }
    },
    valid: false
  },
  {
    name: "a routeFile of the wrong type, dropping the row",
    payload: {
      q: "test",
      scope: "main",
      results: [{ url: "/a", title: "A", snippet: "x", score: 1, routeFile: 7 }],
      meta: { timingsMs: { search: 0, total: 0 } }
    },
    valid: true,
    urls: []
  },
  {
    name: "a breakdown that is not a score breakdown, dropping the row",
    payload: {
      q: "test",
      scope: "main",
      results: [
        { url: "/a", title: "A", snippet: "x", score: 1, breakdown: { baseScore: "wrong" } }
      ],
      meta: { timingsMs: { search: 0, total: 0 } }
    },
    valid: true,
    urls: []
  },
  {
    name: "a valid empty result list",
    payload: {
      q: "test",
      scope: "main",
      results: [],
      meta: { timingsMs: { search: 0, total: 0 } }
    },
    valid: true
  },
  {
    name: "a complete debug breakdown",
    payload: {
      q: "test",
      scope: "main",
      results: [
        {
          url: "/a",
          title: "A",
          snippet: "x",
          score: 1,
          breakdown: {
            baseScore: 1,
            incomingLinkBoost: 0,
            depthBoost: 0,
            titleMatchBoost: 0,
            freshnessBoost: 0,
            anchorTextMatchBoost: 0
          }
        }
      ],
      meta: { timingsMs: { search: 0, total: 0 } }
    },
    valid: true
  },
  {
    name: "an absolute https result URL",
    payload: {
      q: "test",
      scope: "main",
      results: [{ url: "https://example.com/docs", title: "A", snippet: "x", score: 1 }],
      meta: { timingsMs: { search: 0, total: 0 } }
    },
    valid: true
  }
];
