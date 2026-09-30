/**
 * Device Relay `method: "agent"` bridge: translates `{op, args}` payloads
 * (plan §5) into AgentService calls for remote-control clients (web UI).
 * Remote sources are gated by `frely app remote enable` inside the service.
 *
 * Op dispatch lives in `../agent/ops.ts` (shared with the MCP toolset bridge
 * and the local GUI ops socket). This module keeps the relay-facing error
 * type and strips local-only task fields (source, worktreePath, approval)
 * before anything leaves the device.
 */
import type { DeviceRelayRequest } from "../device/protocol.js";
import type { AgentService } from "../agent/agent-service.js";
import type { AgentTaskRecord } from "../agent/task-store.js";
import { AGENT_OPS, dispatchAgentOp, isAgentOp } from "../agent/ops.js";

export { AGENT_OPS, isAgentOp } from "../agent/ops.js";
export type { AgentOp } from "../agent/ops.js";

export class RelayAgentError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "RelayAgentError";
  }
}

/** MCP toolset bridge: expose agent ops as agent_* tools (plan §5) when the frely-app toolset is enabled. */
export function createAgentCallBridge(agent: AgentService, defaults: { workspace: string }): (op: string, args: Record<string, unknown>) => Promise<unknown> {
  return async (op, args) => {
    if (!isAgentOp(op) || op === "agent_approve_merge") throw new RelayAgentError("unknown_op", `Agent tool not available over MCP: ${op}.`);
    try {
      return redact(await dispatchAgentOp(op, args, agent, defaults));
    } catch (error) {
      if (error instanceof RelayAgentError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new RelayAgentError("agent_tool_failed", message);
    }
  };
}

export async function executeAgentRequest(request: DeviceRelayRequest, agent: AgentService, defaults: { workspace: string }): Promise<unknown> {
  const payload = request.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new RelayAgentError("invalid_payload", "Agent request payload must be an object with op and args.");
  const { op, args } = payload as { op?: unknown; args?: unknown };
  if (typeof op !== "string" || !isAgentOp(op)) throw new RelayAgentError("unknown_op", `Unknown agent op. Supported: ${AGENT_OPS.join(", ")}.`);
  const record = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  try {
    return redact(await dispatchAgentOp(op, record, agent, defaults, { source: { kind: "web" }, approvedBy: "web" }));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "internal";
    const message = error instanceof Error ? error.message : String(error);
    throw new RelayAgentError(code, message);
  }
}

/** Map task records to the public view inside op results. */
function redact(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  if ("task" in result && result.task) {
    const view = result as { task: unknown };
    return { ...view, task: publicTask(view.task as AgentTaskRecord) };
  }
  if ("tasks" in result && Array.isArray(result.tasks)) {
    const view = result as { tasks: unknown[] };
    return { ...view, tasks: view.tasks.map((task) => publicTask(task as AgentTaskRecord)) };
  }
  return result;
}

/** Strip local-only fields before leaving the device. */
function publicTask(task: AgentTaskRecord): Record<string, unknown> {
  const { id, workspace, branch, baseBranch, goal, model, maxCostUsd, status, mergeStatus, usage, error, createdAt, updatedAt, settledAt } = task;
  return { id, workspace, branch, baseBranch, goal, model, maxCostUsd, status, mergeStatus, usage, error, createdAt, updatedAt, settledAt };
}
