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
  await runWorkspaceCommand({ args: ["link", "workspace", ...args], primary, write: (text) => { out += text; } });
  return out;
}

test("workspace commands require MCP to be enabled", async () => {
  await assert.rejects(() => run(null, "list"), /MCP is not enabled\. Run frely link on\./);
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

test("workspace remove forgets another folder; the last workspace cannot be removed", async () => {
  const primary = await dir("frely-ws-rm-primary-");
  const extra = await dir("frely-ws-rm-extra-");
  await run(primary, "add", extra);
  await run(primary, "remove", extra);
  assert.deepEqual(JSON.parse(await run(primary, "list", "--json")).workspaces, [primary]);
  await assert.rejects(() => run(primary, "remove", extra), /Workspace not registered/);
  await assert.rejects(() => run(primary, "remove", primary), /Cannot remove the only workspace/);
});

test("the primary workspace is the first one: add --primary moves an existing folder to the front, and removing the first promotes the next", async () => {
  const first = await dir("frely-ws-first-");
  const second = await dir("frely-ws-second-");
  const third = await dir("frely-ws-third-");
  await run(first, "add", second);
  await run(first, "add", third);
  await run(first, "add", third, "--primary");
  assert.deepEqual(JSON.parse(await run(first, "list", "--json")), { primary: third, workspaces: [third, first, second] });
  await assert.rejects(() => run(first, "add", second), /already registered/);
  await run(first, "remove", third);
  assert.deepEqual(JSON.parse(await run(first, "list", "--json")), { primary: first, workspaces: [first, second] });
});

test("workspace add --primary makes another directory primary, keeps the old one listed and prints the full list", async () => {
  const launch = await dir("frely-ws-launch-");
  const next = await dir("frely-ws-next-");
  const out = await run(launch, "add", next, "--primary");
  assert.match(out, new RegExp(`Primary workspace is now ${next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.deepEqual(JSON.parse(await run(launch, "list", "--json")), { primary: next, workspaces: [next, launch] });
  // The old launch workspace is now an ordinary one and can be removed.
  await run(launch, "remove", launch);
  assert.deepEqual(JSON.parse(await run(launch, "list", "--json")), { primary: next, workspaces: [next] });
});

test("workspace changes ask the confirm hook first and stop when it refuses", async () => {
  const launch = await dir("frely-ws-confirm-");
  const extra = await dir("frely-ws-confirm-extra-");
  await assert.rejects(() => runWorkspaceCommand({ args: ["link", "workspace", "add", extra], primary: launch, write: () => undefined, confirm: async () => { throw new Error("denied"); } }), /denied/);
  assert.deepEqual(JSON.parse(await run(launch, "list", "--json")), { primary: launch, workspaces: [launch] });
});
