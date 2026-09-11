import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp.js";

test("MCP client can list and call frely-cli tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-cli-mcp-"));
  await writeFile(join(root, "hello.txt"), "hello from frely\n");
  const server = await createMcpServer(root);
  const client = new Client({ name: "frely-cli-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "read_file"));
    assert.ok(tools.tools.some((tool) => tool.name === "start_process"));
    const result = await client.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [{ type: "text", text: "hello from frely\n" }]);
  } finally {
    await client.close();
    await server.close();
  }
});
