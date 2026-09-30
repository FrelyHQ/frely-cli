/**
 * Device Relay `method: "agent"` bridge: translates `{op, args}` payloads
 * (plan §5) into AgentService calls for remote-control clients (web UI).
 * Remote sources are gated by `frely app remote enable` inside the service.
 */
import type { DeviceRelayRequest } from "../device/protocol.js";
import type { AgentService } from "../agent/agent-service.js";

export class RelayAgentError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "RelayAgentError";
  }
}

export const AGENT_OPS = [
  "agent_start_task",
  "agent_list_tasks",
  "agent_get_task",
  "agent_get_events",
  "agent_send_message",
  "agent_get_diff",
  "agent_request_merge",
  "agent_approve_merge",
  "agent_discard_task",
  "agent_cancel_task",
] as const;

export type AgentOp = (typeof AGENT_OPS)[number];

export function isAgentOp(op: string): op is AgentOp {
  return (AGENT_OPS as readonly string[]).includes(op);
}

export async function executeAgentRequest(request: DeviceRelayRequest, agent: AgentService, defaults: { workspace: string }): Promise<unknown> {
  const payload = request.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new RelayAgentError("invalid_payload", "Agent request payload must be an object with op and args.");
  const { op, args } = payload as { op?: unknown; args?: unknown };
  if (typeof op !== "string" || !isAgentOp(op)) throw new RelayAgentError("unknown_op", `Unknown agent op. Supported: ${AGENT_OPS.join(", ")}.`);
  const record = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  try {
    return await dispatchOp(op, record, agent, defaults);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "internal";
    const message = error instanceof Error ? error.message : String(error);
    throw new RelayAgentError(code, message);
  }
}

async function dispatchOp(op: AgentOp, args: Record<string, unknown>, agent: AgentService, defaults: { workspace: string }): Promise<unknown> {
  switch (op) {
    case "agent_start_task": {
      const task = await agent.startTask({
        workspace: optionalString(args.workspace) ?? defaults.workspace,
        goal: requiredString(args.goal, "goal"),
        ...(typeof args.model === "string" && args.model.length > 0 ? { model: args.model } : {}),
        ...(typeof args.maxCostUsd === "number" && Number.isFinite(args.maxCostUsd) ? { maxCostUsd: args.maxCostUsd } : {}),
        source: { kind: "web" },
      });
      return { task: publicTask(task) };
    }
    case "agent_list_tasks": {
      const workspace = optionalString(args.workspace) ?? defaults.workspace;
      const tasks = await agent.listTasks(workspace);
      return { tasks: tasks.map(publicTask) };
    }
    case "agent_get_task":
      return { task: publicTask(await agent.getTask(requiredTaskId(args))) };
    case "agent_get_events": {
      const cursor = optionalNumber(args.cursor) ?? 0;
      const page = await agent.getEvents(requiredTaskId(args), Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0);
      return { events: page.events, nextCursor: page.nextCursor };
    }
    case "agent_send_message":
      await agent.sendMessage(requiredTaskId(args), requiredString(args.message, "message"));
      return { sent: true };
    case "agent_get_diff": {
      const result = await agent.getDiff(requiredTaskId(args), optionalString(args.path));
      return { diff: result.diff, truncated: result.truncated };
    }
    case "agent_request_merge": {
      const note = optionalString(args.note);
      const task = await agent.requestMerge(requiredTaskId(args), note);
      return { task: publicTask(task) };
    }
    case "agent_approve_merge": {
      const task = await agent.approveMerge(requiredTaskId(args), "web");
      return { task: publicTask(task) };
    }
    case "agent_discard_task": {
      const task = await agent.discardTask(requiredTaskId(args));
      return { task: publicTask(task) };
    }
    case "agent_cancel_task": {
      const task = await agent.cancelTask(requiredTaskId(args));
      return { task: publicTask(task) };
    }
    default:
      throw new RelayAgentError("unknown_op", op satisfies never);
  }
}

/** Strip local-only fields before leaving the device. */
function publicTask(task: Parameters<typeof publicTaskImpl>[0]): ReturnType<typeof publicTaskImpl> {
  return publicTaskImpl(task);
}

function publicTaskImpl(task: {
  id: string;
  workspace: string;
  branch: string;
  baseBranch: string;
  goal: string;
  model: string | null;
  maxCostUsd: number;
  status: string;
  mergeStatus: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  error: string | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
}) {
  const { id, workspace, branch, baseBranch, goal, model, maxCostUsd, status, mergeStatus, usage, error, createdAt, updatedAt, settledAt } = task;
  return { id, workspace, branch, baseBranch, goal, model, maxCostUsd, status, mergeStatus, usage, error, createdAt, updatedAt, settledAt };
}

function requiredTaskId(args: Record<string, unknown>): string {
  return requiredString(args.taskId, "taskId");
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new RelayAgentError("invalid_args", `${name} must be a non-empty string.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
