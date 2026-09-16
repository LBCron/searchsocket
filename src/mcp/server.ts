declare const __SEARCHSOCKET_VERSION__: string | undefined;

import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { Request, Response } from "express";
import { z } from "zod";
import { SearchEngine } from "../search/engine";
import { MAX_PATH_LENGTH, MAX_QUERY_LENGTH } from "../search/limits";
import { SearchSocketError } from "../errors";
import { loadConfig } from "../config/load";
import { toPublicPage, toPublicRelatedPages, toPublicResults } from "../utils/redact";
import type { ResolvedSearchSocketConfig } from "../types";

/**
 * Reported to MCP clients as the server version. Replaced at build time with
 * the package version by tsup's `define`.
 */
export const PACKAGE_VERSION: string =
  typeof __SEARCHSOCKET_VERSION__ === "string" ? __SEARCHSOCKET_VERSION__ : "0.0.0-dev";

export interface McpServerOptions {
  cwd?: string;
  configPath?: string;
  transport?: "stdio" | "http";
  httpPort?: number;
  httpPath?: string;
  access?: "public" | "private";
  apiKey?: string;
}

export interface CreateServerOptions {
  /**
   * Strip repository paths and indexed section text from every tool result,
   * and refuse a caller-supplied scope.
   *
   * Set by the SvelteKit handle route for an anonymous caller under
   * `mcp.handle.access: "public"`. Defaults to false so the standalone stdio
   * and HTTP servers — which are key-gated or loopback-bound — are unaffected.
   */
  redact?: boolean;
}

export function createServer(engine: SearchEngine, opts: CreateServerOptions = {}): McpServer {
  const redact = opts.redact ?? false;

  // An anonymous caller must not be able to name a scope. `resolveScope` takes
  // any override it is given, so a guessed "staging" or a branch name would
  // read content the site has not published — the same hole `api.allowedScopes`
  // closes for the browser endpoint. The field stays in the input shape so the
  // tool signature is stable across privilege levels; the value is dropped on
  // the way to the engine, which is what actually holds the line.
  const scopeInput = redact
    ? z
        .string()
        .optional()
        .describe("Ignored here: this endpoint serves the deployment's default scope only.")
    : z.string().optional();
  const requestedScope = (input: { scope?: string }): string | undefined =>
    redact ? undefined : input.scope;

  /**
   * Keep an engine failure from narrating itself to an anonymous caller.
   *
   * The SDK turns a thrown error into an `isError` result carrying
   * `error.message` verbatim, and those messages name internals — a missing
   * scope env var reports the variable's name, a backend failure can carry a
   * URL. That was fine while every caller held a key. A privileged caller still
   * gets the real error, which its clients rely on for diagnosis.
   */
  const guard = async <T>(
    operation: string,
    run: () => Promise<T>
  ): Promise<T | { isError: true; content: Array<{ type: "text"; text: string }> }> => {
    if (!redact) return run();
    try {
      return await run();
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `Could not complete '${operation}': ` +
              `${error instanceof SearchSocketError ? error.code : "INTERNAL_ERROR"}. ` +
              "This is a backend or configuration failure."
          }
        ]
      };
    }
  };

  const server = new McpServer({
    name: "searchsocket-mcp",
    // Was hardcoded at "0.2.0" and drifted from the package for five releases,
    // so clients could not tell which version they were talking to.
    version: PACKAGE_VERSION
  });

  // ---------------------------------------------------------------------------
  // Tool 1: search — Core discovery tool for both RAG and local file editing
  // ---------------------------------------------------------------------------
  server.registerTool(
    "search",
    {
      description: redact
        ? "Searches indexed site content using semantic similarity. Returns ranked results with url, title, snippet and score. The highest-ranked results include their best-matching sections; lower-ranked results carry a page summary only. Set groupBy to 'chunk' to search sections directly. If snippets lack detail, call get_page with the result URL for the page's indexed markdown."
        : "Searches indexed site content using semantic similarity. Returns ranked results with url, title, snippet, chunkText (the matched section's indexed text, capped in length), score, and routeFile (source file path for editing). The highest-ranked results include their best-matching sections; lower-ranked results carry a page summary only. Set groupBy to 'chunk' to search sections directly. Use routeFile, when present, to locate the source file for editing; custom-record results have none. If snippets lack detail, call get_page with the result URL for the page's indexed markdown.",
      inputSchema: {
        // Trimmed before the bounds, as the engine does, so a query the HTTP
        // endpoint accepts is not refused here over surrounding whitespace.
        query: z.string().trim().min(1).max(MAX_QUERY_LENGTH).describe("Search query. Use keywords or natural language, not full sentences."),
        topK: z.number().int().positive().max(100).optional().describe("Number of results to return (default: 10, max: 100)"),
        pathPrefix: z.string().max(MAX_PATH_LENGTH).optional().describe("Filter results to URLs starting with this prefix (e.g. '/docs')"),
        tags: z.array(z.string()).optional().describe("Filter results to pages matching all specified tags"),
        filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Filter by structured page metadata (e.g. {\"version\": 2})"),
        groupBy: z.enum(["page", "chunk"]).optional().describe("'page' (default) groups chunks by page with sub-results; 'chunk' returns individual chunks"),
        scope: scopeInput
      }
    },
    async (input) =>
      guard("search", async () => {
        const result = await engine.search({
          q: input.query,
          topK: input.topK,
          scope: requestedScope(input),
          pathPrefix: input.pathPrefix,
          tags: input.tags,
          filters: input.filters,
          groupBy: input.groupBy
        });

        if (result.results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No results found for "${input.query}". Try broader keywords or remove filters.`
              }
            ]
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...result, results: toPublicResults(result.results, redact) },
                null,
                2
              )
            }
          ]
        };
      })
  );

  // ---------------------------------------------------------------------------
  // Tool 2: get_page — page-level retrieval for RAG deep-dives
  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_page",
    {
      description: redact
        ? "Retrieves the indexed markdown and metadata for a page by its URL path. Use this after search when snippets lack the detail needed to answer a question. The markdown is reassembled from the indexed chunks: it is complete enough to read and reason about, but is NOT byte-exact source — it can contain section overlap and very long pages may be truncated. Do NOT use this for discovery — use search first."
        : "Retrieves the indexed markdown and metadata for a page by its URL path. Use this after search when snippets lack the detail needed to answer a question. The markdown is reassembled from the indexed chunks: it is complete enough to read and reason about, but is NOT byte-exact source — it can contain section overlap and very long pages may be truncated. Read the file at routeFile when exact content matters. Do NOT use this for discovery — use search first.",
      inputSchema: {
        path: z.string().min(1).max(MAX_PATH_LENGTH).describe("URL path of the page (e.g. '/docs/auth'). Use a URL from search results."),
        scope: scopeInput
      }
    },
    async (input) =>
      guard("get_page", async () => {
        try {
          const page = await engine.getPage(input.path, requestedScope(input));
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(toPublicPage(page, redact), null, 2)
              }
            ]
          };
        } catch (error) {
          // Only a genuine miss falls back to suggestions. A backend outage or a
          // rejected scope reported as "page not found" sent the client looking
          // for a spelling mistake instead of surfacing the real failure.
          // Suggestions are only meaningful for a genuine miss. Anything else —
          // a backend outage, a refused scope, an unexpected throw — is reported
          // as what it is, rather than sending the client hunting for a typo.
          const isNotFound =
            error instanceof SearchSocketError && error.code === "INVALID_REQUEST" && error.status === 404;
          if (!isNotFound) {
            return {
              isError: true as const,
              content: [
                {
                  type: "text" as const,
                  text:
                    `Could not retrieve '${input.path}': ` +
                    `${error instanceof SearchSocketError ? error.code : "INTERNAL_ERROR"}. ` +
                    "This is a backend or configuration failure, not a missing page."
                }
              ]
            };
          }

          // A path may legitimately be longer than a query, so the suggestion
          // search is cut to the query bound rather than refused outright.
          const suggestionQuery = input.path.slice(0, MAX_QUERY_LENGTH).trim();
          const suggestions = suggestionQuery
            ? await engine.search({ q: suggestionQuery, topK: 3, scope: requestedScope(input) })
            : { results: [] };
          const similar = suggestions.results.map((r) => r.url);
          return {
            content: [
              {
                type: "text" as const,
                text: similar.length > 0
                  ? `Page '${input.path}' not found. Similar pages: ${similar.join(", ")}`
                  : `Page '${input.path}' not found. Use search to find the correct URL.`
              }
            ]
          };
        }
      })
  );

  // ---------------------------------------------------------------------------
  // Tool 3: get_related_pages — Link graph + semantic relationship discovery
  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_related_pages",
    {
      description:
        "Finds pages related to a specific page using link graph analysis, semantic similarity, and URL structure. Returns related pages with relationship type (outgoing_link, incoming_link, sibling, semantic) and relevance score. Do NOT use this for general search — use search instead. Use this only when you already have a specific page URL and need to discover connected content.",
      inputSchema: {
        path: z.string().min(1).max(MAX_PATH_LENGTH).describe("URL path of the source page (e.g. '/docs/auth'). Use a URL from search results."),
        topK: z.number().int().positive().max(25).optional().describe("Number of related pages to return (default: 10, max: 25)"),
        scope: scopeInput
      }
    },
    async (input) =>
      guard("get_related_pages", async () => {
        const result = await engine.getRelatedPages(input.path, {
          topK: input.topK,
          scope: requestedScope(input)
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(toPublicRelatedPages(result, redact), null, 2)
            }
          ]
        };
      })
  );

  return server;
}

export function resolveApiKey(config: ResolvedSearchSocketConfig): string | undefined {
  return config.mcp.http.apiKey
    ?? (config.mcp.http.apiKeyEnv ? process.env[config.mcp.http.apiKeyEnv] : undefined);
}

export function verifyApiKey(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Keep stdout clean for the stdio JSON-RPC stream: anything a dependency logs
 * via console must go to stderr or it corrupts the MCP protocol framing.
 */
function redirectConsoleToStderr(): void {
  console.log = (...args: unknown[]) => {
    process.stderr.write(`[LOG] ${args.map(String).join(" ")}\n`);
  };

  console.warn = (...args: unknown[]) => {
    process.stderr.write(`[WARN] ${args.map(String).join(" ")}\n`);
  };
}

async function startHttpServer(serverFactory: () => McpServer, config: ResolvedSearchSocketConfig, opts: McpServerOptions): Promise<void> {
  const port = opts.httpPort ?? config.mcp.http.port;
  const endpointPath = opts.httpPath ?? config.mcp.http.path;
  const isPublic = config.mcp.access === "public";
  const host = isPublic ? "0.0.0.0" : "127.0.0.1";
  // The app must be told the address it will actually bind. Built with no
  // options it assumes 127.0.0.1 and installs localhost-only Host validation,
  // so a public server listening on 0.0.0.0 answered every request addressed
  // to its real hostname with 403. Loopback mode keeps that DNS-rebinding
  // protection; public mode is API-key gated instead (runMcpServer refuses to
  // start it without one), and its Host header is whatever name fronts it.
  const app = createMcpExpressApp({ host });
  const apiKey = isPublic ? resolveApiKey(config) : undefined;

  app.post(endpointPath, async (req: Request, res: Response) => {
    if (isPublic && apiKey) {
      const authHeader = req.headers["authorization"];
      const provided = (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined)
        ?? (req.headers["x-api-key"] as string | undefined)
        ?? "";
      if (!provided || !verifyApiKey(provided, apiKey)) {
        res.status(401).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null
        });
        return;
      }
    }

    // Only a body Express's JSON parser accepted — and therefore size-bounded —
    // reaches the transport. When the parser skips a request (its media-type
    // check is stricter than the SDK's: `application/json` followed by U+00A0
    // fails one and passes the other), `req.body` is undefined and the
    // transport would read the raw stream itself: unchecked for batching and
    // outside the parser's size limit.
    if (req.body === null || typeof req.body !== "object") {
      res.status(415).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Unsupported Media Type: Content-Type must be application/json" },
        id: null
      });
      return;
    }

    // Same refusal as the SvelteKit route: the transport dispatches every
    // message of a JSON-RPC batch concurrently, so one request could fan out
    // into an unbounded number of searches. MCP no longer defines batching.
    if (Array.isArray(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid Request: JSON-RPC batching is not supported" },
        id: null
      });
      return;
    }

    const server = serverFactory();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            // Not the raw exception: it can carry a credential or an internal
            // path, and this response goes to the client.
            message: "Internal server error"
          },
          id: null
        });
      }
    }
  });

  app.get(endpointPath, (_req: Request, res: Response) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed"
        },
        id: null
      })
    );
  });

  app.delete(endpointPath, (_req: Request, res: Response) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed"
        },
        id: null
      })
    );
  });

  await new Promise<void>((resolve, reject) => {
    const instance = app.listen(port, host, () => {
      process.stderr.write(`SearchSocket MCP HTTP server listening on http://${host}:${port}${endpointPath}\n`);
      if (isPublic) {
        process.stderr.write("WARNING: Server is in public mode. Ensure HTTPS is configured via a reverse proxy for production use.\n");
      }
      resolve();
    });
    instance.once("error", reject);

    process.on("SIGINT", async () => {
      await new Promise<void>((shutdownResolve) => instance.close(() => shutdownResolve()));
      process.exit(0);
    });
  });
}

export async function runMcpServer(options: McpServerOptions = {}): Promise<void> {
  // CLI flags are merged in before validation: the load-time check that a
  // public server has a key must see `--api-key`, not reject the config first.
  const config = await loadConfig({
    cwd: options.cwd,
    configPath: options.configPath,
    overrides: {
      mcp: {
        access: options.access,
        apiKey: options.apiKey || undefined
      }
    }
  });

  const resolvedTransport = options.transport ?? config.mcp.transport;

  // For stdio transport, redirect ALL output to stderr before server initialization
  // to prevent corrupting the JSON-RPC stream on stdout.
  if (resolvedTransport === "stdio") {
    redirectConsoleToStderr();
  }

  const engine = await SearchEngine.create({
    cwd: options.cwd,
    configPath: options.configPath,
    config
  });

  if (resolvedTransport === "http") {
    await startHttpServer(() => createServer(engine), config, options);
    return;
  }

  const server = createServer(engine);
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
}
