import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_HOST_MAX_FRAME_BYTES,
  AgentHostProtocolError,
  decodeAgentHostFrame,
  decodeTaskEvent,
  decodeToolParams,
  encodeAgentHostFrame,
  isValidTaskId,
  newConnectionKey,
  newTaskId,
} from "./protocol.js";

test("task ids round-trip validation", () => {
  const id = newTaskId();
  assert.match(id, /^at_[a-z0-9]{24}$/u);
  assert.equal(isValidTaskId(id), true);
  assert.equal(isValidTaskId("at_short"), false);
  assert.equal(isValidTaskId("xy_" + "a".repeat(24)), false);
});

test("connection keys are unguessable-ish and unique", () => {
  const a = newConnectionKey();
  const b = newConnectionKey();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
});

test("frame codec round-trips requests, notifications, responses", () => {
  const line = encodeAgentHostFrame({ jsonrpc: "2.0", id: 7, method: "task.start", params: { taskId: newTaskId() } });
  const decoded = decodeAgentHostFrame(line.trimEnd());
  assert.deepEqual(decoded, { jsonrpc: "2.0", id: 7, method: "task.start", params: { taskId: decoded && "params" in decoded ? (decoded.params as { taskId: string }).taskId : "" } });

  const notification = decodeAgentHostFrame(encodeAgentHostFrame({ jsonrpc: "2.0", method: "task.event", params: { taskId: newTaskId(), event: { type: "log", text: "hi" } } }).trimEnd());
  assert.equal("method" in notification && notification.method, "task.event");

  const response = decodeAgentHostFrame(encodeAgentHostFrame({ jsonrpc: "2.0", id: "abc", result: { ok: true } }).trimEnd());
  assert.deepEqual("result" in response ? response.result : null, { ok: true });
});

test("frame codec rejects garbage and oversize frames", () => {
  assert.throws(() => decodeAgentHostFrame("not-json"), AgentHostProtocolError);
  assert.throws(() => decodeAgentHostFrame('{"jsonrpc":"1.0","method":"x"}'), AgentHostProtocolError);
  assert.throws(() => decodeAgentHostFrame('{"jsonrpc":"2.0","id":1}'), AgentHostProtocolError);
  assert.throws(() => decodeAgentHostFrame(Buffer.alloc(AGENT_HOST_MAX_FRAME_BYTES + 2, 0x61)), AgentHostProtocolError);
  assert.throws(() => encodeAgentHostFrame({ jsonrpc: "2.0", method: "x", params: { big: "a".repeat(AGENT_HOST_MAX_FRAME_BYTES) } }), AgentHostProtocolError);
});

test("task event validation accepts known shapes and rejects malformed ones", () => {
  const taskId = newTaskId();
  const ok = decodeTaskEvent({ taskId, event: { type: "status", status: "running" } });
  assert.equal(ok.event.type, "status");
  assert.equal(decodeTaskEvent({ taskId, event: { type: "usage", inputTokens: 10, outputTokens: 5, costUsd: 0.01 } }).event.type, "usage");
  assert.throws(() => decodeTaskEvent({ taskId, event: { type: "status", status: "exploded" } }), AgentHostProtocolError);
  assert.throws(() => decodeTaskEvent({ taskId, event: { type: "message", role: "saboteur", text: "x" } }), AgentHostProtocolError);
  assert.throws(() => decodeTaskEvent({ taskId: "nope", event: { type: "log", text: "x" } }), AgentHostProtocolError);
  assert.throws(() => decodeTaskEvent({ taskId, event: { type: "usage", inputTokens: -1, outputTokens: 0, costUsd: 0 } }), AgentHostProtocolError);
});

test("tool params validation", () => {
  const taskId = newTaskId();
  const read = decodeToolParams("tool.read", { taskId, path: "a.txt" });
  assert.equal(read.taskId, taskId);
  assert.throws(() => decodeToolParams("tool.read", { taskId, path: "" }), AgentHostProtocolError);
  assert.throws(() => decodeToolParams("tool.bash", { taskId, command: "ls", timeoutMs: 1 }), AgentHostProtocolError);
  assert.throws(() => decodeToolParams("tool.bash", { taskId, command: "ls", timeoutMs: 999_999 }), AgentHostProtocolError);
  assert.throws(() => decodeToolParams("tool.write", { taskId, path: "a.txt", content: 42 }), AgentHostProtocolError);
  assert.throws(() => decodeToolParams("tool.grep", { taskId, query: "x", maxResults: 0 }), AgentHostProtocolError);
  assert.throws(() => decodeToolParams("tool.unknown", { taskId }), AgentHostProtocolError);
});
