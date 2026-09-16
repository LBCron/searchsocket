import http from "node:http";
import net from "node:net";
import type { AddressInfo, Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Host-header validation of the standalone HTTP MCP server, against the real
 * SDK Express app. Only the listen address is redirected (to an ephemeral
 * loopback port) so the test can reach the server; the options the app was
 * built with — which decide Host validation — are exactly what runMcpServer
 * passed.
 */

const captured = vi.hoisted(() => ({ servers: [] as Server[], loadConfig: undefined as unknown as ReturnType<typeof vi.fn> }));

vi.mock("@modelcontextprotocol/sdk/server/express.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@modelcontextprotocol/sdk/server/express.js")>();
  return {
    ...original,
    createMcpExpressApp: (options?: Parameters<typeof original.createMcpExpressApp>[0]) => {
      const app = original.createMcpExpressApp(options);
      const listen = app.listen.bind(app);
      (app as { listen: unknown }).listen = (_port: number, _host: string, cb: () => void) => {
        const server = listen(0, "127.0.0.1", cb);
        captured.servers.push(server);
        return server;
      };
      return app;
    }
  };
});

vi.mock("../src/search/engine", () => ({
  SearchEngine: {
    create: vi.fn().mockResolvedValue({
      search: vi.fn().mockResolvedValue({ q: "x", scope: "main", results: [], meta: { timingsMs: { search: 0, total: 0 } } })
    })
  }
}));

vi.mock("../src/config/load", () => {
  captured.loadConfig = vi.fn();
  return { loadConfig: captured.loadConfig };
});

import { runMcpServer } from "../src/mcp/server";

function post(server: Server, host: string, body: unknown, headers: Record<string, string> = {}) {
  const { port } = server.address() as AddressInfo;
  const payload = JSON.stringify(body);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(payload),
          ...headers
        }
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
      }
    );
    request.on("error", reject);
    request.end(payload);
  });
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }
};

async function start(access: "public" | "private"): Promise<Server> {
  captured.loadConfig.mockResolvedValue({
    mcp: {
      access,
      transport: "http",
      http: { port: 3338, path: "/mcp", ...(access === "public" ? { apiKey: "secret-key" } : {}) }
    }
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await runMcpServer({ transport: "http" });
  const server = captured.servers[captured.servers.length - 1]!;
  vi.mocked(process.stderr.write).mockRestore();
  return server;
}

afterEach(async () => {
  await Promise.all(captured.servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  vi.restoreAllMocks();
});

describe("standalone HTTP MCP server Host validation", () => {
  it("accepts a public hostname in public mode", async () => {
    const server = await start("public");
    const response = await post(server, "mcp.example.com", initialize, { authorization: "Bearer secret-key" });

    expect(response.status).toBe(200);
  });

  it("keeps DNS-rebinding protection in loopback mode", async () => {
    const server = await start("private");

    expect((await post(server, "attacker.example", initialize)).status).toBe(403);
    expect((await post(server, "localhost:3338", initialize)).status).toBe(200);
  });

  it("refuses a JSON-RPC batch", async () => {
    const server = await start("private");
    const response = await post(server, "localhost", [initialize]);

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: -32600 } });
  });
});

/**
 * Send a request byte-for-byte. Node's http client encodes header values as
 * UTF-8, so a lone 0xA0 byte (U+00A0 once Node decodes the header as latin1)
 * can only be produced on a raw socket.
 */
function rawPost(server: Server, contentType: Buffer, body: string) {
  const { port } = server.address() as AddressInfo;
  const head = Buffer.concat([
    Buffer.from(
      "POST /mcp HTTP/1.1\r\n" +
        "Host: localhost\r\n" +
        "Accept: application/json, text/event-stream\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "Connection: close\r\n" +
        "Content-Type: ",
      "latin1"
    ),
    contentType,
    Buffer.from("\r\n\r\n", "latin1")
  ]);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.end(Buffer.concat([head, Buffer.from(body)])));
    let text = "";
    socket.on("data", (chunk) => (text += chunk.toString("latin1")));
    socket.on("error", reject);
    socket.on("end", () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
      resolve({ status, body: text.slice(text.indexOf("\r\n\r\n") + 4) });
    });
  });
}

describe("standalone HTTP MCP server body handling", () => {
  it("refuses a batch whose Content-Type Express's JSON parser skips", async () => {
    const server = await start("private");
    // Express's type check fails on the trailing U+00A0 and leaves req.body
    // undefined; the SDK transport trims the header and would parse the raw
    // body itself, dispatching the unchecked batch.
    const response = await rawPost(
      server,
      Buffer.concat([Buffer.from("application/json", "latin1"), Buffer.from([0xa0])]),
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" }
      ])
    );

    expect(response.status).toBe(415);
    expect(response.body).not.toContain('"tools"');
  });

  it("refuses a POST with no parsed body", async () => {
    const server = await start("private");
    const response = await rawPost(server, Buffer.from("text/plain", "latin1"), JSON.stringify(initialize));

    expect(response.status).toBe(415);
    expect(response.body).not.toContain("serverInfo");
  });

  it("still serves a plain JSON POST", async () => {
    const server = await start("private");
    const response = await rawPost(server, Buffer.from("application/json; charset=utf-8", "latin1"), JSON.stringify(initialize));

    expect(response.status).toBe(200);
    expect(response.body).toContain("serverInfo");
  });
});
