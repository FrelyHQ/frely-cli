import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_OPS, executeAgentRequest, isAgentOp, RelayAgentError } from "./relay-agent.js";
import type { AgentService, StartTaskInput } from "../agent/agent-service.js";
import type { AgentTaskRecord } from "../agent/task-store.js";
import type { DeviceRelayRequest } from "../device/protocol.js";
import { newTaskId } from "../agent/protocol.js";

function request(payload: unknown): DeviceRelayRequest {
  return { protocol: "frely.device-relay.v1", type: "request", id: "req-1", method: "agent", payload };
}

function taskRecord(overrides: Partial<AgentTaskRecord> = {}): AgentTaskRecord {
  const id = newTaskId();
  return {
    id,
    source: { kind: "web" },
    workspace: "/tmp/ws",
    worktreePath: `/tmp/wt/${id}`,
    branch: `frely/task/${id}`,
    baseBranch: "main",
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    goal: "goal",
    model: null,
    maxCostUsd: 2,
    status: "completed",
    mergeStatus: "none",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    error: null,
    mergeRequest: null,
    approval: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    settledAt: "2026-10-01T00:01:00.000Z",
    ...overrides,
  };
}

function stubService(overrides: Partial<AgentService> = {}): AgentService {
  const record = taskRecord();
  const service = {
    startTask: async (input: StartTaskInput) => taskRecord({ goal: input.goal, status: "running" }),
    listTasks: async () => [record],
    getTask: async (id: string) => {
      if (id !== record.id) throw new (class extends Error { code = "task_not_found" })(id);
      return record;
    },
    getEvents: async (id: string, cursor: number) => ({ events: [{ ...({ type: "log", text: "e" } as const), seq: cursor + 1, at: "2026-10-01T00:00:00.000Z" }], nextCursor: cursor + 1 }),
    sendMessage: async () => undefined,
    getDiff: async () => ({ diff: "+hello", truncated: false }),
    requestMerge: async () => taskRecord({ mergeStatus: "merge_requested" }),
    approveMerge: async () => taskRecord({ mergeStatus: "merged" }),
    discardTask: async () => taskRecord({ mergeStatus: "discarded" }),
    cancelTask: async () => taskRecord({ status: "cancelled" }),
  } as unknown as AgentService;
  return Object.assign(service, overrides);
}

test("all ten ops are declared and validated", () => {
  assert.equal(AGENT_OPS.length, 10);
  assert.equal(isAgentOp("agent_start_task"), true);
  assert.equal(isAgentOp("agent_delete_everything"), false);
});

test("executeAgentRequest rejects malformed payloads", async () => {
  const service = stubService();
  await assert.rejects(() => executeAgentRequest(request(null), service, { workspace: "/ws" }), (error: unknown) => error instanceof RelayAgentError && error.code === "invalid_payload");
  await assert.rejects(() => executeAgentRequest(request({ op: 42 }), service, { workspace: "/ws" }), (error: unknown) => error instanceof RelayAgentError && error.code === "unknown_op");
  await assert.rejects(() => executeAgentRequest(request({ op: "agent_nope", args: {} }), service, { workspace: "/ws" }), (error: unknown) => error instanceof RelayAgentError && error.code === "unknown_op");
});

test("start task op maps args and defaults the workspace", async () => {
  let captured: StartTaskInput | null = null;
  const service = stubService({ startTask: async (input: StartTaskInput) => { captured = input; return taskRecord({ status: "running" }); } });
  const result = await executeAgentRequest(request({ op: "agent_start_task", args: { goal: "fix the bug" } }), service, { workspace: "/default/ws" });
  assert.equal(captured!.workspace, "/default/ws");
  assert.equal(captured!.goal, "fix the bug");
  assert.deepEqual(captured!.source, { kind: "web" });
  assert.equal((result as { task: { status: string } }).task.status, "running");
  // Public task payload must not leak the local worktree path.
  assert.equal("worktreePath" in (result as { task: object }).task, false);
});

test("service errors surface as relay errors with their codes", async () => {
  const service = stubService({ startTask: async () => { throw new (class extends Error { code = "remote_control_disabled"; })("disabled"); } });
  await assert.rejects(() => executeAgentRequest(request({ op: "agent_start_task", args: { goal: "x" } }), service, { workspace: "/ws" }), (error: unknown) => error instanceof RelayAgentError && error.code === "remote_control_disabled");
});

test("remaining ops round-trip through the service", async () => {
  const service = stubService();
  const workspace = "/ws";
  const record = await (service.listTasks(workspace) as Promise<AgentTaskRecord[]>); // sanity: stub works
  assert.equal(record.length, 1);

  const list = await executeAgentRequest(request({ op: "agent_list_tasks", args: {} }), service, { workspace });
  assert.equal((list as { tasks: unknown[] }).tasks.length, 1);

  const get = await executeAgentRequest(request({ op: "agent_get_task", args: { taskId: record[0]!.id } }), service, { workspace });
  assert.equal((get as { task: { id: string } }).task.id, record[0]!.id);

  const events = await executeAgentRequest(request({ op: "agent_get_events", args: { taskId: record[0]!.id, cursor: 3 } }), service, { workspace });
  assert.equal((events as { nextCursor: number }).nextCursor, 4);

  const diff = await executeAgentRequest(request({ op: "agent_get_diff", args: { taskId: record[0]!.id } }), service, { workspace });
  assert.equal((diff as { diff: string }).diff, "+hello");

  const merged = await executeAgentRequest(request({ op: "agent_approve_merge", args: { taskId: record[0]!.id } }), service, { workspace });
  assert.equal((merged as { task: { mergeStatus: string } }).task.mergeStatus, "merged");

  await assert.rejects(() => executeAgentRequest(request({ op: "agent_send_message", args: { taskId: "" } }), service, { workspace }), (error: unknown) => error instanceof RelayAgentError && error.code === "invalid_args");
  await executeAgentRequest(request({ op: "agent_discard_task", args: { taskId: record[0]!.id } }), service, { workspace });
  await executeAgentRequest(request({ op: "agent_cancel_task", args: { taskId: record[0]!.id } }), service, { workspace });
  await executeAgentRequest(request({ op: "agent_request_merge", args: { taskId: record[0]!.id, note: "n" } }), service, { workspace });
});
