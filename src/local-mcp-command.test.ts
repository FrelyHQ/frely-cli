import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeMcpArgs } from "./mcp-command.js";
import { parseAdd, runLocalMcpCommand } from "./local-mcp-command.js";

async function run(...args: string[]): Promise<string> {
  let out = "";
  await runLocalMcpCommand({ args: normalizeMcpArgs(["mcp", "local", ...args]), write: (text) => { out += text; } });
  return out;
}

test("local MCP arguments normalize and validate", () => {
  assert.deepEqual(normalizeMcpArgs(["mcp", "local"]), ["mcp", "local"]);
  assert.deepEqual(normalizeMcpArgs(["mcp", "local", "list", "--json"]), ["mcp", "local", "list", "--json"]);
  assert.deepEqual(normalizeMcpArgs(["mcp", "local", "add", "n", "--", "node", "--flag", "x"]), ["mcp", "local", "add", "n", "--", "node", "--flag", "x"]);
  assert.throws(() => normalizeMcpArgs(["mcp", "local", "enable", "n"]), /Unknown local MCP command/);
  assert.throws(() => normalizeMcpArgs(["mcp", "local", "remove"]), /requires a name/);
  assert.throws(() => normalizeMcpArgs(["mcp", "local", "list", "extra"]), /Unsupported local list option/);
});

test("add parses loopback URLs with headers and stdio commands with environment", async () => {
  assert.deepEqual(await parseAdd(["bridge", "--url", "http://127.0.0.1:9000/mcp", "--header", "authorization=Bearer a=b"]),
    { name: "bridge", transport: "http", url: "http://127.0.0.1:9000/mcp", headers: { authorization: "Bearer a=b" } });
  const stdio = await parseAdd(["notes", "--env", "TOKEN=abc", "--", process.execPath, "server.js", "--flag"]);
  assert.deepEqual(stdio, { name: "notes", transport: "stdio", command: process.execPath, args: ["server.js", "--flag"], env: { TOKEN: "abc" }, path: process.env.PATH ?? "" });
  await assert.rejects(() => parseAdd(["x"]), /--url|command/);
  await assert.rejects(() => parseAdd(["x", "--url", "http://127.0.0.1:1/mcp", "--", "node"]), /cannot be combined/);
  await assert.rejects(() => parseAdd(["x", "--header", "a=b", "--", "node"]), /only applies to --url/);
  await assert.rejects(() => parseAdd(["x", "--bogus", "1", "--", "node"]), /Unsupported local MCP option/);
  await assert.rejects(() => parseAdd(["x", "--", "definitely-not-a-real-command-frely"]), /not found on PATH/);
});

test("add connects once before saving, list never prints secret values, remove deletes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frely-local-cmd-"));
  const script = join(dir, "server.mjs");
  await writeFile(script, `
import { Server } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
import { ListToolsRequestSchema } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))};
const server = new Server({ name: "notes", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "a", inputSchema: { type: "object" } }, { name: "b", inputSchema: { type: "object" } }] }));
await server.connect(new StdioServerTransport());
`);
  const added = await run("add", "notes", "--env", "SECRET=hunter2", "--", process.execPath, script);
  assert.match(added, /Added local MCP notes \(2 tools\)/);
  await assert.rejects(() => run("add", "notes", "--", process.execPath, script), /already exists/);
  await assert.rejects(() => run("add", "dead", "--url", "http://127.0.0.1:1/mcp"), /Could not connect/);
  const json = await run("list", "--json");
  assert.ok(!json.includes("hunter2"));
  assert.deepEqual((JSON.parse(json) as { servers: Array<{ name: string; env: string[] }> }).servers.find((server) => server.name === "notes")?.env, ["SECRET"]);
  assert.match(await run("remove", "notes"), /Removed local MCP notes/);
  assert.ok(!(await run("list", "--json")).includes('"name":"notes"'));
});
