import type { ResolvedSearchSocketConfig } from "../types";

export const DEFAULT_DROP_SELECTORS = [
  ".sidebar",
  ".toc",
  ".table-of-contents",
  ".breadcrumbs",
  ".breadcrumb",
  "[role='navigation']"
];

export function createDefaultConfig(projectId: string): ResolvedSearchSocketConfig {
  return {
    project: {
      id: projectId
    },
    scope: {
      mode: "fixed",
      fixed: "main",
      envVar: "SEARCHSOCKET_SCOPE",
      sanitize: true
    },
    exclude: [],
    respectRobotsTxt: true,
    source: {
      mode: "static-output",
      staticOutputDir: "build",
      strictRouteMapping: false
    },
    extract: {
      mainSelector: "main",
      dropTags: ["header", "nav", "footer", "aside"],
      dropSelectors: DEFAULT_DROP_SELECTORS,
      ignoreAttr: "data-search-ignore",
      noindexAttr: "data-search-noindex",
      imageDescAttr: "data-search-description",
      respectRobotsNoindex: true
    },
    transform: {
      preserveCodeBlocks: true,
      preserveTables: true
    },
    chunking: {
      maxChars: 1500,
      overlapChars: 200,
      minChars: 250,
      headingPathDepth: 3,
      dontSplitInside: ["code", "table", "blockquote"],
      prependTitle: true,
      pageSummaryChunk: true,
    },
    upstash: {
      urlEnv: "UPSTASH_VECTOR_REST_URL",
      tokenEnv: "UPSTASH_VECTOR_REST_TOKEN",
      namespaces: {
        pages: "pages",
        chunks: "chunks"
      },
      batchSize: 90,
      maxRetries: 2
    },
    indexing: {
      maxDeletionRatio: 0.5
    },
    ranking: {
      enableIncomingLinkBoost: true,
      enableDepthBoost: true,
      enableFreshnessBoost: false,
      freshnessDecayRate: 0.001,
      enableAnchorTextBoost: false,
      pageWeights: {},
      minScoreRatio: 0.70,
      scoreGapThreshold: 0.4,
      weights: {
        incomingLinks: 0.05,
        depth: 0.03,
        titleMatch: 0.15,
        freshness: 0.1,
        anchorText: 0.10
      }
    },
    api: {
      path: "/api/search",
      cors: {
        allowOrigins: []
      },
      allowedScopes: [],
      exposeInternalFields: false
    },
    mcp: {
      enable: process.env.NODE_ENV !== "production",
      access: "private",
      transport: "stdio",
      http: {
        port: 3338,
        path: "/mcp"
      },
      handle: {
        path: "/api/mcp",
        access: "private",
        enableJsonResponse: true
      }
    },
    llmsTxt: {
      enable: false,
      outputPath: "static/llms.txt",
      generateFull: true,
      serveMarkdownVariants: false
    },
    state: {
      dir: ".searchsocket"
    }
  };
}
