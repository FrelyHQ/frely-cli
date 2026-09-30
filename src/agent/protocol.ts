/**
 * frely.agent-host.v1 — wire contract between the CLI (supervisor) and the
 * Pi Node agent host. See docs/agent-host.md for the public description.
 */
import { randomBytes } from "node:crypto";

export const AGENT_HOST_PROTOCOL = "frely.agent-host.v1";
export const AGENT_HOST_PROTOCOL_VERSION = 1;
export const AGENT_HOST_MAX_FRAME_BYTES = 1024 * 1024;
export const AGENT_HOST_CONNECTION_KEY_ENV = "FRELY_AGENT_HOST_KEY";

export type AgentHostTaskStatus = "running" | "waiting_input" | "completed" | "failed" | "cancelled";

export type AgentHostTaskEvent =
  | { type: "status"; status: AgentHostTaskStatus; detail?: string }
  | { type: "message"; role: "assistant" | "user" | "system"; text: string; partial?: boolean }
  | { type: "tool_call"; tool: string; summary: string; state: "started" | "finished" | "failed" }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: "log"; text: string };

export type JsonRpcId = number | string;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | { jsonrpc: "2.0"; method: string; params?: Record<string, unknown> };

export class AgentHostProtocolError extends Error {
  constructor(readonly code: "frame_invalid" | "frame_too_large" | "handshake_rejected" | "unexpected_frame") {
    super(code);
    this.name = "AgentHostProtocolError";
  }
}

export function newConnectionKey(): string {
  return randomBytes(32).toString("base64url");
}

export function isValidTaskId(id: string): boolean {
  return /^at_[a-z0-9]{24}$/u.test(id);
}

export function newTaskId(): string {
  return `at_${randomBytes(12).toString("hex")}`;
}

/** Encode one NDJSON frame. */
export function encodeAgentHostFrame(message: JsonRpcMessage): string {
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line) > AGENT_HOST_MAX_FRAME_BYTES) throw new AgentHostProtocolError("frame_too_large");
  return `${line}\n`;
}

/** Decode one NDJSON frame (without the trailing newline). */
export function decodeAgentHostFrame(line: Buffer | string): JsonRpcMessage {
  if (Buffer.byteLength(line) > AGENT_HOST_MAX_FRAME_BYTES) throw new AgentHostProtocolError("frame_too_large");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.isBuffer(line) ? line.toString("utf8") : line);
  } catch {
    throw new AgentHostProtocolError("frame_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentHostProtocolError("frame_invalid");
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0") throw new AgentHostProtocolError("frame_invalid");
  if ("method" in record) {
    if (typeof record.method !== "string" || record.method.length === 0) throw new AgentHostProtocolError("frame_invalid");
    if ("id" in record && record.id !== null && typeof record.id !== "number" && typeof record.id !== "string") {
      throw new AgentHostProtocolError("frame_invalid");
    }
    if ("params" in record && record.params !== undefined && (typeof record.params !== "object" || record.params === null)) {
      throw new AgentHostProtocolError("frame_invalid");
    }
    return value as JsonRpcRequest;
  }
  if (typeof record.id !== "number" && typeof record.id !== "string") throw new AgentHostProtocolError("frame_invalid");
  if (!("result" in record) && !("error" in record)) throw new AgentHostProtocolError("frame_invalid");
  if ("error" in record && record.error !== undefined) {
    const error = record.error as Record<string, unknown> | null;
    if (!error || typeof error !== "object" || typeof error.code !== "number" || typeof error.message !== "string") {
      throw new AgentHostProtocolError("frame_invalid");
    }
  }
  return value as JsonRpcResponse;
}

/** Validate and normalize a `task.event` notification params object. */
export function decodeTaskEvent(params: unknown): { taskId: string; event: AgentHostTaskEvent } {
  if (!params || typeof params !== "object") throw new AgentHostProtocolError("frame_invalid");
  const record = params as Record<string, unknown>;
  if (typeof record.taskId !== "string" || !isValidTaskId(record.taskId)) throw new AgentHostProtocolError("frame_invalid");
  const event = record.event;
  if (!event || typeof event !== "object") throw new AgentHostProtocolError("frame_invalid");
  const item = event as Record<string, unknown>;
  switch (item.type) {
    case "status":
      if (item.status !== "running" && item.status !== "waiting_input" && item.status !== "completed" && item.status !== "failed" && item.status !== "cancelled") {
        throw new AgentHostProtocolError("frame_invalid");
      }
      if (item.detail !== undefined && typeof item.detail !== "string") throw new AgentHostProtocolError("frame_invalid");
      return { taskId: record.taskId, event: item as AgentHostTaskEvent };
    case "message":
      if (item.role !== "assistant" && item.role !== "user" && item.role !== "system") throw new AgentHostProtocolError("frame_invalid");
      if (typeof item.text !== "string" || item.text.length > 64 * 1024) throw new AgentHostProtocolError("frame_invalid");
      if (item.partial !== undefined && typeof item.partial !== "boolean") throw new AgentHostProtocolError("frame_invalid");
      return { taskId: record.taskId, event: item as AgentHostTaskEvent };
    case "tool_call":
      if (typeof item.tool !== "string" || typeof item.summary !== "string" || item.summary.length > 2048) throw new AgentHostProtocolError("frame_invalid");
      if (item.state !== "started" && item.state !== "finished" && item.state !== "failed") throw new AgentHostProtocolError("frame_invalid");
      return { taskId: record.taskId, event: item as AgentHostTaskEvent };
    case "usage": {
      for (const key of ["inputTokens", "outputTokens", "costUsd"] as const) {
        const value = item[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new AgentHostProtocolError("frame_invalid");
      }
      return { taskId: record.taskId, event: item as AgentHostTaskEvent };
    }
    case "log":
      if (typeof item.text !== "string" || item.text.length > 4096) throw new AgentHostProtocolError("frame_invalid");
      return { taskId: record.taskId, event: item as AgentHostTaskEvent };
    default:
      throw new AgentHostProtocolError("frame_invalid");
  }
}

const TOOL_METHODS = new Set(["tool.read", "tool.write", "tool.edit", "tool.bash", "tool.grep", "tool.find", "tool.ls"]);

export function isToolMethod(method: string): boolean {
  return TOOL_METHODS.has(method);
}

/** Validate params of a `tool.*` request from the host. Returns normalized args. */
export function decodeToolParams(method: string, params: unknown): { taskId: string; args: Record<string, unknown> } {
  if (!params || typeof params !== "object") throw new AgentHostProtocolError("frame_invalid");
  const record = params as Record<string, unknown>;
  if (typeof record.taskId !== "string" || !isValidTaskId(record.taskId)) throw new AgentHostProtocolError("frame_invalid");
  const { taskId, ...args } = record;
  switch (method) {
    case "tool.read":
      requireString(args, "path");
      break;
    case "tool.write":
      requireString(args, "path");
      if (typeof args.content !== "string") throw new AgentHostProtocolError("frame_invalid");
      optionalBoolean(args, "overwrite");
      break;
    case "tool.edit":
      requireString(args, "path");
      if (!Array.isArray(args.edits) || args.edits.length === 0) throw new AgentHostProtocolError("frame_invalid");
      break;
    case "tool.bash":
      requireString(args, "command");
      optionalString(args, "cwd");
      if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== "number" || !Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 100 || args.timeoutMs > 120_000)) {
        throw new AgentHostProtocolError("frame_invalid");
      }
      break;
    case "tool.grep":
      requireString(args, "query");
      optionalString(args, "path");
      optionalBoolean(args, "regex");
      optionalBoolean(args, "caseSensitive");
      optionalInteger(args, "maxResults", 1, 200);
      optionalInteger(args, "contextLines", 0, 5);
      break;
    case "tool.find":
      requireString(args, "pattern");
      optionalString(args, "path");
      optionalInteger(args, "maxResults", 1, 500);
      break;
    case "tool.ls":
      optionalString(args, "path");
      break;
    default:
      throw new AgentHostProtocolError("frame_invalid");
  }
  return { taskId, args };
}

function requireString(args: Record<string, unknown>, key: string): void {
  if (typeof args[key] !== "string" || (args[key] as string).length === 0) throw new AgentHostProtocolError("frame_invalid");
}

function optionalString(args: Record<string, unknown>, key: string): void {
  if (args[key] !== undefined && typeof args[key] !== "string") throw new AgentHostProtocolError("frame_invalid");
}

function optionalBoolean(args: Record<string, unknown>, key: string): void {
  if (args[key] !== undefined && typeof args[key] !== "boolean") throw new AgentHostProtocolError("frame_invalid");
}

function optionalInteger(args: Record<string, unknown>, key: string, min: number, max: number): void {
  const value = args[key];
  if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)) {
    throw new AgentHostProtocolError("frame_invalid");
  }
}
