import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runWorkspaceCommand } from "./workspace-command.js";

async function dir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function run(primary: string | null, ...args: string[]): Promise<string> {
  let out = "";
  await runWorkspaceCommand({ args: ["mcp", "workspace", ...args], primary, write: (text) => { out += text; } });
  return out;
}

test("workspace commands require MCP to be enabled", async () => {
  await assert.rejects(() => run(null, "list"), /MCP is not enabled\. Run frely mcp url\./);
});

test("workspace add registers a directory and list reports primary plus additions", async () => {
  const primary = await dir("frely-ws-primary-");
  const extra = await dir("frely-ws-extra-");
  assert.ok((await run(primary, "add", extra)).includes(`Added workspace ${extra}`));
  const listed = JSON.parse(await run(primary, "list", "--json")) as { primary: string; workspaces: string[] };
  assert.deepEqual(listed, { primary, workspaces: [primary, extra] });
  assert.match(await run(primary, "list"), /\(primary\)/);
});

test("workspace list works before any extra workspace is registered", async () => {
  const primary = await dir("frely-ws-solo-");
  assert.deepEqual(JSON.parse(await run(primary, "list", "--json")), { primary, workspaces: [primary] });
});

test("workspace add accepts nested and containing directories", async () => {
  const primary = await dir("frely-ws-nest-");
  const child = join(primary, "child");
  await mkdir(child);
  assert.ok((await run(primary, "add", child)).includes(`Added workspace ${child}`));
  const other = await dir("frely-ws-other-");
  const inner = join(other, "inner");
  await mkdir(inner);
  await run(primary, "add", inner);
  await run(primary, "add", other);
  const listed = JSON.parse(await run(primary, "list", "--json")) as { workspaces: string[] };
  assert.deepEqual([...listed.workspaces].sort(), [primary, child, inner, other].sort());
  await run(primary, "remove", other);
  assert.ok((JSON.parse(await run(primary, "list", "--json")) as { workspaces: string[] }).workspaces.includes(inner));
});

test("workspace remove refuses the primary and removes other workspaces", async () => {
  const primary = await dir("frely-ws-rm-primary-");
  const extra = await dir("frely-ws-rm-extra-");
  await run(primary, "add", extra);
  await assert.rejects(() => run(primary, "remove", primary), /Cannot remove the primary workspace .*frely mcp remove/);
  await run(primary, "remove", extra);
  assert.deepEqual(JSON.parse(await run(primary, "list", "--json")).workspaces, [primary]);
  await assert.rejects(() => run(primary, "remove", extra), /Workspace not registered/);
});
