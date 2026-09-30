import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStoreError, agentStateDir, nextRuntimeStatus, TaskStore, type AgentTaskRecord } from "./task-store.js";
import { newTaskId } from "./protocol.js";

const windowsSkip = process.platform === "win32" ? "agentStateDir XDG override semantics are POSIX-only for now" : false;

function record(id = newTaskId()): AgentTaskRecord {
  const now = new Date().toISOString();
  return {
    id,
    source: { kind: "web" },
    workspace: "/tmp/ws",
    worktreePath: `/tmp/wt/${id}`,
    branch: `frely/task/${id}`,
    baseBranch: "main",
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    goal: "do the thing",
    model: null,
    maxCostUsd: 2,
    status: "queued",
    mergeStatus: "none",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    error: null,
    mergeRequest: null,
    approval: null,
    createdAt: now,
    updatedAt: now,
    settledAt: null,
  };
}

test("task store create/read/update/list lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-agent-store-"));
  try {
    const store = new TaskStore(join(root, "tasks"));
    const a = record();
    const b = record();
    await store.create(a);
    await store.create(b);
    await assert.rejects(() => store.create(a), /task_exists/);

    const read = await store.read(a.id);
    assert.equal(read.goal, "do the thing");
    await assert.rejects(() => store.read(newTaskId()), /task_not_found/);

    const updated = await store.update(a.id, (task) => ({ ...task, status: "running" }));
    assert.equal(updated.status, "running");
    assert.notEqual(updated.updatedAt, a.updatedAt);

    const ids = (await store.list()).map((task) => task.id).sort();
    assert.deepEqual(ids, [a.id, b.id].sort());

    await assert.rejects(() => store.update(a.id, (task) => ({ ...task, id: newTaskId() })), /invalid_task/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task store events append and cursor paging", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-agent-store-"));
  try {
    const store = new TaskStore(join(root, "tasks"));
    const a = record();
    await store.create(a);
    for (let index = 0; index < 5; index += 1) await store.appendEvent(a.id, { type: "log", text: `line-${index}` });

    const first = await store.readEvents(a.id, 0, 2);
    assert.equal(first.events.length, 2);
    assert.equal(first.events[0]?.seq, 1);
    assert.equal(first.nextCursor, 2);

    const second = await store.readEvents(a.id, first.nextCursor!, 2);
    assert.equal(second.events.length, 2);
    assert.equal(second.events[0]?.seq, 3);

    const rest = await store.readEvents(a.id, second.nextCursor!, 100);
    assert.equal(rest.events.length, 1);
    assert.equal(rest.nextCursor, null);

    const none = await store.readEvents(a.id, 999);
    assert.deepEqual(none, { events: [], nextCursor: null });

    await assert.rejects(() => store.readEvents(newTaskId(), 0), /task_not_found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime status state machine transitions", () => {
  const queued: AgentTaskRecord["status"] = "queued";
  assert.equal(nextRuntimeStatus(queued, { type: "status", status: "running" }), "running");
  assert.equal(nextRuntimeStatus(queued, { type: "status", status: "failed" }), "failed");
  assert.equal(nextRuntimeStatus(queued, { type: "status", status: "completed" }), "completed");
  assert.equal(nextRuntimeStatus("running", { type: "status", status: "waiting_input" }), "waiting_input");
  assert.equal(nextRuntimeStatus("waiting_input", { type: "status", status: "running" }), "running");
  assert.equal(nextRuntimeStatus("completed", { type: "status", status: "running" }), null);
  assert.equal(nextRuntimeStatus("running", { type: "message", role: "assistant", text: "x" }), null);
});

test("store rejects corrupt records", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-agent-store-"));
  try {
    const store = new TaskStore(join(root, "tasks"));
    const a = record();
    await store.create(a);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "tasks", a.id, "task.json"), "{invalid", "utf8");
    await assert.rejects(() => store.read(a.id), AgentStoreError);
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agentStateDir honors XDG_STATE_HOME", { skip: windowsSkip }, () => {
  assert.equal(agentStateDir({ XDG_STATE_HOME: "/xdg/state" } as NodeJS.ProcessEnv), "/xdg/state/frely/agent");
  assert.match(agentStateDir({} as NodeJS.ProcessEnv), /\.local\/state\/frely\/agent$/u);
});
