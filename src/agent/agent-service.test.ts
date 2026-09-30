import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { AgentService, AgentServiceError, DEFAULT_AGENT_CONFIG, type AgentRuntimeConfig } from "./agent-service.js";
import { TaskStore } from "./task-store.js";
import { AgentHostSupervisor } from "./supervisor.js";
import { newTaskId } from "./protocol.js";

const exec = promisify(execFile);

// The agent host bridge speaks JSON-RPC over the spawned host's fd 3 pipe.
// Windows cannot open fd>2 pipes as a socket (net.Socket({fd: 3})), so the
// end-to-end service tests are skipped there until the bridge gains a
// Windows-capable transport.
const windowsSkip = process.platform === "win32" ? "agent host fd3 IPC has no Windows transport yet" : false;

const fakeHostSource = `
import net from "node:net";

const socket = new net.Socket({ fd: 3, readable: true, writable: true });
const output = { write: (chunk) => socket.write(chunk) };
let nextId = 1;
const pending = new Map();
function send(message) { output.write(JSON.stringify(message) + "\\n"); }
function request(method, params) {
  return new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });
}
let buffer = "";
socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});
function event(taskId, payload) { send({ jsonrpc: "2.0", method: "task.event", params: { taskId, event: payload } }); }

async function handle(message) {
  if (!message.method) {
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
    return;
  }
  switch (message.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, hostVersion: "fake", capabilities: ["tasks", "tools"] } });
      break;
    case "initialized":
      break;
    case "task.start":
      send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
      void runTask(message.params);
      break;
    case "task.cancel":
      send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
      event(message.params.taskId, { type: "status", status: "cancelled" });
      break;
    default:
      send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
  }
}

async function runTask(params) {
  const taskId = params.taskId;
  try {
    event(taskId, { type: "status", status: "running" });
    if (params.goal === "use-tools") {
      const write = await request("tool.write", { taskId, path: "feature.txt", content: "made by agent\\n" });
      if (!write.result || write.result.ok !== true) throw new Error("tool.write failed: " + JSON.stringify(write.result));
      const bash = await request("tool.bash", { taskId, command: "pwd", cwd: "." });
      if (bash.result.ok !== true || !bash.result.result.stdout.includes(params.worktreePath)) throw new Error("tool.bash not inside worktree");
      const escape = await request("tool.write", { taskId, path: "../escape.txt", content: "bad", overwrite: true });
      if (escape.result.ok === true) throw new Error("path escape unexpectedly allowed");
    } else if (params.goal === "budget-burn") {
      event(taskId, { type: "usage", inputTokens: 1000, outputTokens: 1000, costUsd: 99 });
      await new Promise((resolve) => setTimeout(resolve, 2000)); // CLI cancels us meanwhile.
      return; // terminal status comes from the cancel flow
    } else if (params.goal === "sleep-forever") {
      await new Promise(() => {});
    }
    event(taskId, { type: "status", status: "completed" });
  } catch (error) {
    event(taskId, { type: "status", status: "failed", detail: String(error && error.message) });
  }
}
`;

async function gitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "frely-agent-e2e-"));
  await exec("git", ["init", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "test@frely.test"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "hello\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-m", "init"], { cwd: root });
  return root;
}

type Harness = {
  service: AgentService;
  store: TaskStore;
  repo: string;
  dataHome: string;
  fakeHostPath: string;
  cleanup: () => Promise<void>;
};

async function harness(configOverrides: Partial<AgentRuntimeConfig> = {}): Promise<Harness> {
  const repo = await gitRepo();
  const stateHome = await mkdtemp(join(tmpdir(), "frely-agent-state-"));
  const dataHome = await mkdtemp(join(tmpdir(), "frely-agent-data-"));
  const fakeHostDir = await mkdtemp(join(tmpdir(), "frely-agent-host-"));
  const fakeHostPath = join(fakeHostDir, "fake-host.mjs");
  await writeFile(fakeHostPath, fakeHostSource, "utf8");

  const previousData = process.env.XDG_DATA_HOME;
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  process.env.XDG_STATE_HOME = stateHome;

  const store = new TaskStore(join(stateHome, "tasks"));
  const config: AgentRuntimeConfig = { ...DEFAULT_AGENT_CONFIG, remoteControlEnabled: true, ...configOverrides };
  const facts = {
    manifest: { schemaVersion: 3, capsuleKind: "pi-node-executable", sourceCommit: "0".repeat(40), target: { id: "test", platform: process.platform, architecture: "x64" }, versions: { piNode: "0", protocol: "0" }, runtime: { executable: "pi-node", agentHostArguments: ["agent-host"] } },
    // The fake host is a Node script, so the "executable" is Node running it.
    executable: process.execPath,
    agentHostArguments: [fakeHostPath],
  };
  let service: AgentService | null = null;
  const supervisor = new AgentHostSupervisor({
    resolveFacts: async () => facts,
    onEvent: (taskId, event) => service?.onTaskEvent(taskId, event),
    onToolRequest: (request, args, taskId) => service!.onToolRequest(request, args, taskId),
    onHostLost: (error) => service?.onHostLost(error),
    isIdle: () => true,
  });
  service = new AgentService({
    store,
    resolveSupervisor: () => supervisor,
    config: async () => config,
  });

  return {
    service,
    store,
    repo,
    dataHome,
    fakeHostPath,
    cleanup: async () => {
      await service!.stopHost().catch(() => undefined);
      if (previousData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previousData;
      if (previousState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousState;
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
      await rm(stateHome, { recursive: true, force: true }).catch(() => undefined);
      await rm(dataHome, { recursive: true, force: true }).catch(() => undefined);
      await rm(fakeHostDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("condition not reached within timeout");
}

test("agent service end-to-end: task with tools, merge request and approval", { skip: windowsSkip }, async () => {
  const h = await harness();
  try {
    const task = await h.service.startTask({ workspace: h.repo, goal: "use-tools", source: { kind: "web" } });
    assert.match(task.id, /^at_[a-z0-9]{24}$/u);
    assert.ok(!task.worktreePath.startsWith(h.repo));

    await waitFor(async () => (await h.service.getTask(task.id)).status === "completed");
    const done = await h.service.getTask(task.id);
    assert.equal(done.mergeStatus, "none");
    assert.equal(await readFile(join(done.worktreePath, "feature.txt"), "utf8"), "made by agent\n");
    // The escape write must not have landed next to the repo.
    assert.equal((await stat(join(h.repo, "..", "escape.txt")).then(() => true, () => false)), false);

    // The events feed can lag the task status store; wait for it to catch up.
    await waitFor(async () => {
      const feed = await h.service.getEvents(task.id, 0);
      return feed.events.some((item) => item.type === "status" && item.status === "running")
        && feed.events.some((item) => item.type === "status" && item.status === "completed");
    });
    const events = await h.service.getEvents(task.id, 0);
    assert.ok(events.events.some((item) => item.type === "status" && item.status === "running"));
    assert.ok(events.events.some((item) => item.type === "status" && item.status === "completed"));

    const diff = await h.service.getDiff(task.id);
    assert.match(diff.diff, /\+made by agent/u);

    const requested = await h.service.requestMerge(task.id, "please merge");
    assert.equal(requested.mergeStatus, "merge_requested");
    // Double request is rejected.
    await assert.rejects(() => h.service.requestMerge(task.id), (error: unknown) => error instanceof AgentServiceError && error.code === "invalid_state");

    const merged = await h.service.approveMerge(task.id, "web");
    assert.equal(merged.mergeStatus, "merged");
    assert.equal(await readFile(join(h.repo, "feature.txt"), "utf8"), "made by agent\n");
    await waitFor(async () => (await stat(merged.worktreePath).then(() => true, () => false)) === false);
  } finally {
    await h.cleanup();
  }
});

test("agent service rejects remote tasks when remote control is disabled", { skip: windowsSkip }, async () => {
  const h = await harness({ remoteControlEnabled: false });
  try {
    await assert.rejects(() => h.service.startTask({ workspace: h.repo, goal: "anything", source: { kind: "web" } }), (error: unknown) => error instanceof AgentServiceError && error.code === "remote_control_disabled");
    // GUI source is always allowed.
    const task = await h.service.startTask({ workspace: h.repo, goal: "quick", source: { kind: "gui" } });
    await waitFor(async () => (await h.service.getTask(task.id)).status === "completed");
  } finally {
    await h.cleanup();
  }
});

test("agent service enforces the budget by cancelling the task", { skip: windowsSkip }, async () => {
  const h = await harness();
  try {
    const task = await h.service.startTask({ workspace: h.repo, goal: "budget-burn", maxCostUsd: 0.01, source: { kind: "web" } });
    await waitFor(async () => {
      const record = await h.service.getTask(task.id);
      return record.status === "cancelled";
    }, 15_000);
    const done = await h.service.getTask(task.id);
    assert.equal(done.status, "cancelled");
    assert.ok(done.usage.costUsd >= 0.01);
  } finally {
    await h.cleanup();
  }
});

test("agent service marks running tasks failed when the host crashes", { skip: windowsSkip }, async () => {
  const h = await harness();
  try {
    const task = await h.service.startTask({ workspace: h.repo, goal: "sleep-forever", source: { kind: "web" } });
    await waitFor(async () => (await h.service.getTask(task.id)).status === "running");
    const connection = await h.service.supervisor().ensureHost();
    connection.kill();
    await waitFor(async () => (await h.service.getTask(task.id)).status === "failed");
    const failed = await h.service.getTask(task.id);
    assert.match(failed.error ?? "", /exit/iu);
  } finally {
    await h.cleanup();
  }
});

test("agent service rejects messages to finished tasks and unknown task ids", { skip: windowsSkip }, async () => {
  const h = await harness();
  try {
    const task = await h.service.startTask({ workspace: h.repo, goal: "quick", source: { kind: "gui" } });
    await waitFor(async () => (await h.service.getTask(task.id)).status === "completed");
    await assert.rejects(() => h.service.sendMessage(task.id, "hi"), (error: unknown) => error instanceof AgentServiceError && error.code === "invalid_state");
    await assert.rejects(() => h.service.getTask(newTaskId()), /task_not_found/u);
    await assert.rejects(() => h.service.startTask({ workspace: h.repo, goal: "", source: { kind: "gui" } }), (error: unknown) => error instanceof AgentServiceError && error.code === "invalid_args");
  } finally {
    await h.cleanup();
  }
});

test("agent service rejects non-git and dirty workspaces", { skip: windowsSkip }, async () => {
  const h = await harness();
  const plain = await mkdtemp(join(tmpdir(), "frely-agent-plain-"));
  try {
    await assert.rejects(() => h.service.startTask({ workspace: plain, goal: "x", source: { kind: "gui" } }), (error: unknown) => error instanceof AgentServiceError && error.code === "workspace_not_git_repo");
    await writeFile(join(h.repo, "uncommitted.txt"), "x");
    await assert.rejects(() => h.service.startTask({ workspace: h.repo, goal: "x", source: { kind: "gui" } }), (error: unknown) => error instanceof AgentServiceError && error.code === "workspace_dirty");
  } finally {
    await rm(plain, { recursive: true, force: true });
    await h.cleanup();
  }
});

test("agent service cancels a running task through the host", { skip: windowsSkip }, async () => {
  const h = await harness();
  try {
    const task = await h.service.startTask({ workspace: h.repo, goal: "sleep-forever", source: { kind: "web" } });
    await waitFor(async () => (await h.service.getTask(task.id)).status === "running");
    const cancelled = await h.service.cancelTask(task.id);
    // cancelTask resolves after host acknowledged; the terminal event may race ahead of the read.
    await waitFor(async () => (await h.service.getTask(task.id)).status === "cancelled");
    assert.equal(cancelled.status === "cancelled" || cancelled.status === "running", true);
  } finally {
    await h.cleanup();
  }
});
