import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  addManualEntry, assertLoopbackUrl, discoverLoopbackMcps, loadManualEntries, LocalMcpHub, nameDiscovered, parseLoopbackListeners,
  probeHttpMcp, removeManualEntry, shapeToolResult, slugName, LOCAL_MCP_TEXT_LIMIT, type LocalMcpEntry,
} from "./local-mcp.js";
import { RelayMcpSession } from "./relay-mcp.js";

/** A loopback HTTP MCP server like a browser-extension bridge: stateless streamable HTTP on /mcp with one `echo` tool. */
async function fakeHttpMcp(name = "Browser Bridge"): Promise<{ port: number; close: () => Promise<void> }> {
  const http: HttpServer = createServer((request, response) => {
    if (request.url !== "/mcp" || request.method !== "POST") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const server = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }));
        server.setRequestHandler(CallToolRequestSchema, async (call) => ({ content: [{ type: "text", text: `echo:${String((call.params.arguments as { text?: unknown })?.text)}` }] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
        response.on("close", () => { void transport.close(); void server.close(); });
        await server.connect(transport as unknown as Parameters<Server["connect"]>[0]);
        await transport.handleRequest(request, response, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      })();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  return { port: address.port, close: () => new Promise<void>((resolve) => { http.closeAllConnections(); http.close(() => resolve()); }) };
}

const stdioServer = () => `
import { Server } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))};
const server = new Server({ name: "notes", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "shout", inputSchema: { type: "object" } }] }));
server.setRequestHandler(CallToolRequestSchema, async (call) => ({ content: [{ type: "text", text: String(call.params.arguments?.text).toUpperCase() + ":" + (process.env.LOCAL_MCP_TEST ?? "") }] }));
await server.connect(new StdioServerTransport());
`;

async function stdioEntry(env?: Record<string, string>): Promise<LocalMcpEntry> {
  const script = join(await mkdtemp(join(tmpdir(), "frely-local-mcp-")), "server.mjs");
  await writeFile(script, stdioServer());
  return { name: "notes", source: "manual", transport: "stdio", command: process.execPath, args: [script], ...(env ? { env } : {}) };
}

const noDiscovery = { listPorts: async () => [] as number[] };

test("probeHttpMcp recognizes a loopback MCP server and ignores everything else", async () => {
  const mcp = await fakeHttpMcp();
  const other = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/plain" }).end("hello"); });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  try {
    assert.deepEqual(await probeHttpMcp(mcp.port), { url: `http://127.0.0.1:${mcp.port}/mcp`, flavor: "streamable", serverName: "Browser Bridge" });
    assert.equal(await probeHttpMcp((other.address() as { port: number }).port), null);
  } finally {
    await mcp.close();
    other.closeAllConnections();
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }
});

test("hub discovers a loopback server, names it from the server and serves enabled calls only", async () => {
  const mcp = await fakeHttpMcp();
  const hub = new LocalMcpHub({ discovery: { listPorts: async () => [mcp.port] }, loadManual: async () => [] });
  try {
    await hub.refresh();
    assert.deepEqual(hub.capabilities(), [{ name: "browser-bridge", transport: "http" }]);
    assert.deepEqual(await hub.list(["browser-bridge"]), { servers: [{ name: "browser-bridge", transport: "http", available: true }] });
    const listed = await hub.list(["browser-bridge"], "browser-bridge") as { tools: Array<{ name: string }> };
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["echo"]);
    const result = await hub.call(["browser-bridge"], "browser-bridge", "echo", { text: "hi" });
    assert.deepEqual(result, { content: [{ type: "text", text: "echo:hi" }] });
    await assert.rejects(() => hub.call([], "browser-bridge", "echo", {}), /not enabled on this device/);
    await assert.rejects(() => hub.call(["other"], "browser-bridge", "echo", {}), /not enabled on this device/);
    await assert.rejects(() => hub.call(["ghost"], "ghost", "echo", {}), /not running on this device/);
  } finally {
    await hub.close();
    await mcp.close();
  }
});

test("hub forwards a manually added stdio server with its own environment", async () => {
  const entry = await stdioEntry({ LOCAL_MCP_TEST: "yes" });
  const hub = new LocalMcpHub({ discovery: noDiscovery, loadManual: async () => [entry] });
  try {
    await hub.refresh();
    assert.deepEqual(hub.capabilities(), [{ name: "notes", transport: "stdio" }]);
    const result = await hub.call(["notes"], "notes", "shout", { text: "abc" });
    assert.deepEqual(result, { content: [{ type: "text", text: "ABC:yes" }] });
  } finally { await hub.close(); }
});

test("a discovered server that stops listening is no longer callable after a rescan", async () => {
  const mcp = await fakeHttpMcp();
  let ports = [mcp.port];
  const hub = new LocalMcpHub({ discovery: { listPorts: async () => ports }, loadManual: async () => [] });
  try {
    await hub.refresh();
    await hub.call(["browser-bridge"], "browser-bridge", "echo", { text: "x" });
    ports = [];
    await hub.refresh();
    await assert.rejects(() => hub.call(["browser-bridge"], "browser-bridge", "echo", {}), /not running on this device/);
  } finally { await hub.close(); await mcp.close(); }
});

test("discovery names clashes deterministically and skips ports a manual entry already covers", async () => {
  const hits = [
    { url: "http://127.0.0.1:3001/mcp", flavor: "streamable" as const, serverName: "Notes", port: 3001 },
    { url: "http://127.0.0.1:3002/mcp", flavor: "streamable" as const, serverName: "Notes", port: 3002 },
    { url: "http://127.0.0.1:3003/sse", flavor: "sse" as const, port: 3003 },
  ];
  assert.deepEqual(nameDiscovered(hits, ["notes"]).map((entry) => entry.name), ["notes-2", "notes-3", "local-3003"]);
  const probed: number[] = [];
  const found = await discoverLoopbackMcps({ listPorts: async () => [3001, 3002], probe: async (port) => { probed.push(port); return null; } }, new Set([3001]));
  assert.deepEqual(probed, [3002]);
  assert.deepEqual(found, []);
});

test("only loopback addresses are accepted for HTTP servers", () => {
  for (const ok of ["http://127.0.0.1:8080/mcp", "http://localhost:3000/mcp", "http://[::1]:9/mcp", "https://127.0.0.2/x"]) assert.doesNotThrow(() => assertLoopbackUrl(ok));
  for (const bad of ["http://192.168.1.10/mcp", "http://example.com/mcp", "http://0.0.0.0:80/mcp", "ftp://127.0.0.1/mcp", "http://user:pw@127.0.0.1/mcp", "not a url"]) assert.throws(() => assertLoopbackUrl(bad));
});

test("listener parsing keeps loopback-only listeners on each platform", () => {
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue",
    "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 0 0 1",
    "   1: 00000000:0050 00000000:0000 0A 00000000:00000000 0 0 2",
    "   2: 0100007F:2328 0100007F:9999 01 00000000:00000000 0 0 3",
  ].join("\n");
  const tcp6 = "   0: 00000000000000000000000001000000:1B58 00000000000000000000000000000000:0000 0A 0 0 0 4\n";
  assert.deepEqual(parseLoopbackListeners("linux", [tcp, tcp6]), [7000, 8080]);
  assert.deepEqual(parseLoopbackListeners("darwin", ["p1\nn127.0.0.1:4000\nn*:5000\nn[::1]:4001\nnlocalhost:4002\n"]), [4000, 4001, 4002]);
  assert.deepEqual(parseLoopbackListeners("win32", ["  TCP    127.0.0.1:6000    0.0.0.0:0    LISTENING    12\n  TCP    0.0.0.0:6001    0.0.0.0:0    LISTENING    13\n"]), [6000]);
});

test("tool results are bounded for the relay frame", () => {
  const big = "x".repeat(LOCAL_MCP_TEXT_LIMIT + 10);
  const shaped = shapeToolResult({ content: [{ type: "text", text: big }, { type: "text", text: "dropped" }], isError: true });
  assert.equal(shaped.isError, true);
  assert.equal(shaped.content.length, 1);
  assert.match((shaped.content[0] as { text: string }).text, /\[truncated\]$/u);
  const images = shapeToolResult({ content: [{ type: "image", data: "a".repeat(5 * 1024 * 1024), mimeType: "image/png" }, { type: "image", data: "b".repeat(2 * 1024 * 1024), mimeType: "image/png" }] });
  assert.equal((images.content[0] as { type: string }).type, "image");
  assert.match((images.content[1] as { text: string }).text, /omitted/u);
  assert.equal(slugName("  Chrome / Bridge!! "), "chrome-bridge");
  assert.equal(slugName(undefined), "mcp");
});

test("the manual list round-trips and rejects duplicates and non-loopback URLs", async () => {
  await addManualEntry({ name: "bridge", transport: "http", url: "http://127.0.0.1:9000/mcp", headers: { authorization: "Bearer t" } });
  await assert.rejects(() => addManualEntry({ name: "bridge", transport: "http", url: "http://127.0.0.1:9001/mcp" }), /already exists/);
  await assert.rejects(() => addManualEntry({ name: "lan", transport: "http", url: "http://192.168.0.2/mcp" }), /loopback|127\.0\.0\.1/);
  await assert.rejects(() => addManualEntry({ name: "Bad Name", transport: "stdio", command: "x", args: [] }), /lowercase/);
  const loaded = await loadManualEntries();
  assert.deepEqual(loaded.map((entry) => [entry.name, entry.source]), [["bridge", "manual"]]);
  await removeManualEntry("bridge");
  assert.deepEqual(await loadManualEntries(), []);
  await assert.rejects(() => removeManualEntry("bridge"), /No manually added/);
});

test("the MCP runtime exposes local_mcp_* only while a name is enabled and forwards the call", async () => {
  const mcp = await fakeHttpMcp();
  const hub = new LocalMcpHub({ discovery: { listPorts: async () => [mcp.port] }, loadManual: async () => [] });
  await hub.refresh();
  let enabled: string[] = [];
  const workspace = await mkdtemp(join(tmpdir(), "frely-local-mcp-ws-"));
  const session = await RelayMcpSession.create(workspace, { localMcp: hub });
  const rpc = (id: number, method: string, params: unknown, names: string[]) => session.execute({ jsonrpc: "2.0", id, method, params }, `relay_request_${id}_xxxxxxxx`, undefined, names) as Promise<{ result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } }>;
  try {
    await session.execute({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, "relay_request_init_xxxxxxxx");
    const names = (reply: { result?: { tools?: Array<{ name: string }> } }) => (reply.result?.tools ?? []).map((tool) => tool.name);
    assert.ok(!names(await rpc(2, "tools/list", {}, enabled)).includes("local_mcp_call"));
    const denied = await rpc(3, "tools/call", { name: "local_mcp_call", arguments: { server: "browser-bridge", tool: "echo" } }, enabled);
    assert.equal(denied.result?.isError, true);
    assert.match(denied.result?.content?.[0]?.text ?? "", /not enabled/u);

    enabled = ["browser-bridge"];
    const listed = names(await rpc(4, "tools/list", {}, enabled));
    assert.ok(listed.includes("local_mcp_list") && listed.includes("local_mcp_call"));
    const servers = await rpc(5, "tools/call", { name: "local_mcp_list", arguments: {} }, enabled);
    assert.deepEqual(JSON.parse(servers.result!.content![0]!.text), { servers: [{ name: "browser-bridge", transport: "http", available: true }] });
    const called = await rpc(6, "tools/call", { name: "local_mcp_call", arguments: { server: "browser-bridge", tool: "echo", arguments: { text: "via relay" } } }, enabled);
    assert.equal(called.result?.content?.[0]?.text, "echo:via relay");

    // Revoking on the web omits the field on the next frame: access ends immediately.
    const revoked = await rpc(7, "tools/call", { name: "local_mcp_call", arguments: { server: "browser-bridge", tool: "echo" } }, []);
    assert.equal(revoked.result?.isError, true);
  } finally {
    await session.close();
    await hub.close();
    await mcp.close();
  }
});
