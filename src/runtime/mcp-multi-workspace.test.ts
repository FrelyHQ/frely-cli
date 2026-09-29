import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp.js";
import { addWorkspace } from "./workspace-registry.js";

async function connect(root: string) {
  const server = await createMcpServer(root);
  const client = new Client({ name: "frely-cli-multi-workspace-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text: string }>)[0]!.text;

test("single workspace keeps relative paths and reports workspace_info root + workspaces", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "frely-mw-single-")));
  await writeFile(join(root, "a.txt"), "solo\n");
  const { client, close } = await connect(root);
  try {
    assert.equal(text(await client.callTool({ name: "read_file", arguments: { path: "a.txt" } })), "solo\n");
    const info = JSON.parse(text(await client.callTool({ name: "workspace_info", arguments: {} })));
    assert.deepEqual(info, { root, workspaces: [root] });
  } finally { await close(); }
});

test("multiple workspaces route absolute paths, reject relative/outside paths, keep process tools usable", async () => {
  const primary = await realpath(await mkdtemp(join(tmpdir(), "frely-mw-primary-")));
  const second = await realpath(await mkdtemp(join(tmpdir(), "frely-mw-second-")));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "frely-mw-outside-")));
  await mkdir(join(second, "src"));
  await writeFile(join(second, "src", "b.txt"), "from second\n");
  await addWorkspace(primary).catch(() => undefined);
  await addWorkspace(second);
  const { client, close } = await connect(primary);
  try {
    const info = JSON.parse(text(await client.callTool({ name: "workspace_info", arguments: {} })));
    assert.equal(info.root, primary);
    assert.deepEqual([...info.workspaces].sort(), [primary, second].sort());

    const routed = await client.callTool({ name: "read_file", arguments: { path: join(second, "src", "b.txt") } });
    assert.equal(routed.isError, undefined);
    assert.equal(text(routed), "from second\n");

    for (const path of [".", "src/b.txt"]) {
      const rejected = await client.callTool({ name: "list_directory", arguments: { path } });
      assert.equal(rejected.isError, true);
      assert.match(text(rejected), /Multiple workspaces are registered; give an absolute path/);
    }
    const missing = await client.callTool({ name: "list_directory", arguments: { path: outside } });
    assert.equal(missing.isError, true);
    assert.match(text(missing), /not inside any registered workspace/);
    assert.ok(text(missing).includes(primary) && text(missing).includes(second));

    const processes = await client.callTool({ name: "list_processes", arguments: {} });
    assert.equal(processes.isError, undefined);
  } finally { await close(); }
});
