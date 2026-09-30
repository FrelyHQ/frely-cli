/**
 * Shared agent-op dispatch (plan §5). The same op surface serves three
 * transports: device-relay `method: "agent"` (remote web), the MCP frely-app
 * toolset bridge, and the local GUI ops socket (M4). Each transport passes its
 * own task `source` and merge `approvedBy` identity; only the ops socket gets
 * the full task record (source, worktreePath, approval) because it never
 * leaves the device.
 */
import type { AgentService } from "./agent-service.js";
import type { AgentTaskRecord, AgentTaskSource } from "./task-store.js";

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

export class AgentOpError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "AgentOpError";
  }
}

export type AgentOpIdentity = { source: AgentTaskSource; approvedBy: "gui" | "web" };

export function isAgentOp(op: string): op is AgentOp {
  return (AGENT_OPS as readonly string[]).includes(op);
}

export async function dispatchAgentOp(
  op: AgentOp,
  args: Record<string, unknown>,
  agent: AgentService,
  defaults: { workspace: string },
  identity: AgentOpIdentity = { source: { kind: "web" }, approvedBy: "web" },
): Promise<unknown> {
  switch (op) {
    case "agent_start_task": {
      const task = await agent.startTask({
        workspace: optionalString(args.workspace) ?? defaults.workspace,
        goal: requiredString(args.goal, "goal"),
        ...(typeof args.model === "string" && args.model.length > 0 ? { model: args.model } : {}),
        ...(typeof args.maxCostUsd === "number" && Number.isFinite(args.maxCostUsd) ? { maxCostUsd: args.maxCostUsd } : {}),
        source: identity.source,
      });
      return { task };
    }
    case "agent_list_tasks": {
      const workspace = optionalString(args.workspace) ?? defaults.workspace;
      return { tasks: await agent.listTasks(workspace) };
    }
    case "agent_get_task":
      return { task: await agent.getTask(requiredTaskId(args)) };
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
      return { task: await agent.requestMerge(requiredTaskId(args), note) };
    }
    case "agent_approve_merge":
      return { task: await agent.approveMerge(requiredTaskId(args), identity.approvedBy) };
    case "agent_discard_task":
      return { task: await agent.discardTask(requiredTaskId(args)) };
    case "agent_cancel_task":
      return { task: await agent.cancelTask(requiredTaskId(args)) };
    default:
      throw new AgentOpError("unknown_op", op satisfies never);
  }
}

function requiredTaskId(args: Record<string, unknown>): string {
  return requiredString(args.taskId, "taskId");
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new AgentOpError("invalid_args", `${name} must be a non-empty string.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export type { AgentTaskRecord };
