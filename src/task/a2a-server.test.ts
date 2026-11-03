import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createA2aServer } from "./a2a-server.js";
import { TaskError } from "./manager.js";
import type { TaskRunRecord } from "./run-store.js";
import { shareRefusal } from "./share.js";
import type { TaskShare } from "./share-store.js";
import type { TaskDefinition } from "./definition.js";

let root: string;
const previous = process.env.XDG_CONFIG_HOME;
before(async () => { root = await mkdtemp(join(tmpdir(), "frely-a2a-")); process.env.XDG_CONFIG_HOME = root; });
after(async () => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; await rm(root, { recursive: true, force: true }); });

const share: TaskShare = { name: "helper", approvedHash: "ab".repeat(32), workspace: "worktree", allowCredit: false, description: "Helps.", serviceShareId: "svcs_" + "0".repeat(24), port: 0, sharedAt: new Date().toISOString() };
const record = (extra: Partial<TaskRunRecord> = {}): TaskRunRecord => ({ version: 1, runId: "11111111-1111-1111-1111-111111111111", snapshot: { name: "helper", workspace: "worktree" } as never, trigger: "remote", status: "completed", createdAt: "", updatedAt: "", ...extra });

async function rpc(port: number, body: unknown): Promise<{ result?: any; error?: { message: string } }> {
  return (await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: JSON.stringify(body) })).json() as never;
}
const send = (text: string) => ({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text }], runner: "evil", command: "rm -rf /" } } });

test("a shared task serves its card and runs a call with only the caller's text", async () => {
  const starts: unknown[] = [];
  const server = createA2aServer(share, {
    start: (async (name: string, options: unknown) => { starts.push([name, options]); return record({ status: "running" }); }) as never,
    wait: (async () => record({ answer: "Fixed.", diffSummary: "1 file changed\na | +1 -0" })) as never,
  });
  const port = await server.listen(0);
  try {
    const card = await (await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`)).json() as { name: string; description: string };
    assert.equal(card.name, "helper");
    assert.equal(card.description, "Helps.");
    const result = await rpc(port, send("please fix"));
    assert.equal(result.result.status.state, "completed");
    assert.match(result.result.status.message.parts[0].text, /Fixed\.\n\nChanges \(kept on the owner's computer\):\n1 file changed/u);
    assert.deepEqual(starts, [["helper", { trigger: "remote", input: "please fix", workspace: "worktree" }]]);
  } finally { await server.close(); }
});

test("a shared task answers busy and charges nothing when its queue is full", async () => {
  const server = createA2aServer(share, {
    start: (async () => { throw new TaskError("busy", "full"); }) as never,
    waitMs: 0, retryMs: 60_000,
  });
  const port = await server.listen(0);
  try {
    for (let call = 0; call < 3; call += 1) assert.equal((await rpc(port, send("x"))).result.status.state, "submitted");
    const busy = await rpc(port, send("x"));
    assert.match(busy.error?.message ?? "", /^busy/u);
    assert.equal((await rpc(port, { jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: "nope" } })).error?.message, "Unknown task.");
  } finally { await server.close(); }
});

test("sharing allows only local models unless the owner accepts gateway fees", async () => {
  const definition = { runner: "pi", model: "qwen" } as TaskDefinition;
  const providers = async () => [{ models: ["qwen"], pending: false }] as never;
  assert.equal(await shareRefusal(definition, { chargeMyCredit: false, workspace: "none" }, providers), undefined);
  assert.match(await shareRefusal({ ...definition, model: "gpt-x" }, { chargeMyCredit: false, workspace: "none" }, providers) ?? "", /deduct model fees/u);
  assert.equal(await shareRefusal({ ...definition, model: "gpt-x" }, { chargeMyCredit: true, workspace: "none" }, providers), undefined);
});
