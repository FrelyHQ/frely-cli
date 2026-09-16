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

test("run_command executes independent commands concurrently by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-cli-mcp-parallel-"));
  await writeFile(join(root, "barrier.cjs"), `
const fs = require("node:fs");
const [mine, other] = process.argv.slice(2);
fs.writeFileSync(mine, "");
const deadline = Date.now() + 2000;
const timer = setInterval(() => {
  if (fs.existsSync(other)) {
    clearInterval(timer);
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    clearInterval(timer);
    process.exit(2);
  }
}, 10);
`);
  const server = await createMcpServer(root);
  const client = new Client({ name: "frely-cli-parallel-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const [first, second] = await Promise.all([
      client.callTool({ name: "run_command", arguments: { command: "node barrier.cjs a.ready b.ready", timeoutMs: 5000 } }),
      client.callTool({ name: "run_command", arguments: { command: "node barrier.cjs b.ready a.ready", timeoutMs: 5000 } }),
    ]);
    assert.equal(first.isError, undefined, JSON.stringify(first.content));
    assert.equal(second.isError, undefined, JSON.stringify(second.content));
  } finally {
    await client.close();
    await server.close();
  }
});

test("run_command exclusive mode serializes commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-cli-mcp-exclusive-"));
  await writeFile(join(root, "exclusive.cjs"), `
const fs = require("node:fs");
try {
  fs.writeFileSync("exclusive.lock", String(process.pid), { flag: "wx" });
} catch {
  process.exit(3);
}
setTimeout(() => {
  fs.unlinkSync("exclusive.lock");
}, 150);
`);
  const server = await createMcpServer(root);
  const client = new Client({ name: "frely-cli-exclusive-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const [first, second] = await Promise.all([
      client.callTool({ name: "run_command", arguments: { command: "node exclusive.cjs", timeoutMs: 5000, concurrency: "exclusive" } }),
      client.callTool({ name: "run_command", arguments: { command: "node exclusive.cjs", timeoutMs: 5000, concurrency: "exclusive" } }),
    ]);
    assert.equal(first.isError, undefined, JSON.stringify(first.content));
    assert.equal(second.isError, undefined, JSON.stringify(second.content));
  } finally {
    await client.close();
    await server.close();
  }
});
