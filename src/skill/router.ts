import {
  hasConfiguredLocalToken,
  normalizeRelayUrl,
  readConfiguredLocalCredential,
  type AuthCredential,
} from "../auth.js";

export type SkillCapabilityLevel = "base" | "advanced";
export type SkillEntrypoint = "model" | "mcp" | "a2a";

export interface SkillCapability {
  readonly id: string;
  readonly level: SkillCapabilityLevel;
  readonly entrypoints: readonly SkillEntrypoint[];
}

export type AgentTaskState = "running" | "completed" | "failed" | "canceled";

export interface SkillInvocationResult {
  readonly text: string;
  readonly usage?: Readonly<Record<string, unknown>>;
  /** Set by the Gateway for an Agent call: `running` means the task goes on and `taskId` reads it later. */
  readonly state?: AgentTaskState;
  readonly taskId?: string;
  /** The running Agent's newest one-line progress; absent when progress is off or nothing was reported yet. */
  readonly progressSummary?: string;
}

export class SkillInvocationError extends Error {
  constructor(
    readonly code: "payment_required" | "entitlement_required" | "remote_authorization_failed" | "capability_unavailable" | "remote_call_failed",
    readonly details: Readonly<{
      readonly capabilityId?: string;
      /** The remote `error.data.code` when this client does not know it. */
      readonly remoteCode?: string;
      readonly registrationUrl?: string;
    }> = {},
  ) {
    super(code);
    this.name = "SkillInvocationError";
  }
}

/** A function tool the caller runs locally (read-only workspace bridge), in the shape `invoke` accepts as `tools`. */
export interface CallerToolDefinition {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** One continuation entry of a tool round trip (`items` of `invoke`). */
export type CallerItem =
  | { readonly type: "function_call"; readonly call_id: string; readonly name: string; readonly arguments: string }
  | { readonly type: "function_call_output"; readonly call_id: string; readonly output: string };

export interface AgentTurnUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
}

/** One `invoke` round with caller tools: either the final answer or the local tool calls the Agent asked for. */
export type AgentTurnResult =
  | { readonly status: "completed"; readonly text: string; readonly requestId?: string; readonly usage?: AgentTurnUsage }
  | { readonly status: "tool_calls"; readonly calls: readonly { readonly callId: string; readonly name: string; readonly arguments: string }[]; readonly items: readonly CallerItem[]; readonly requestId?: string; readonly usage?: AgentTurnUsage };

export interface RemoteAgentMcpInvoker {
  /** One round with caller-executed tools. Absent on invokers that only support a single text round. */
  invokeTurn?(input: {
    readonly relayUrl: string;
    readonly modelId: string;
    readonly token: string;
    readonly credential?: AuthCredential;
    readonly task: string;
    readonly tools: readonly CallerToolDefinition[];
    readonly items: readonly CallerItem[];
    readonly signal?: AbortSignal;
  }): Promise<AgentTurnResult>;
  invoke(input: {
    readonly relayUrl: string;
    readonly modelId: string;
    readonly token: string;
    readonly credential?: AuthCredential;
    readonly task: string;
    readonly capabilityId?: string;
    /** Sent only when given; otherwise the Gateway uses the account's setting. */
    readonly progressSummary?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<SkillInvocationResult>;
}

export interface RemoteAgentTaskInput {
  readonly relayUrl: string;
  readonly modelId: string;
  readonly token: string;
  readonly credential?: AuthCredential;
  readonly taskId: string;
  readonly signal?: AbortSignal;
}

export interface RemoteAgentTaskClient {
  /** Reads a task (task_status); with `wait` the Gateway holds the request up to 50 seconds. Free. */
  status(input: RemoteAgentTaskInput & { readonly wait: boolean }): Promise<SkillInvocationResult>;
  /** Cancels a running task (task_cancel); what ran so far is billed. */
  cancel(input: RemoteAgentTaskInput): Promise<SkillInvocationResult>;
}

export interface SkillRouterOptions {
  readonly relayUrl?: string;
  readonly modelId: string;
  readonly task: string;
  readonly entrypoint?: SkillEntrypoint;
  readonly capability?: SkillCapability;
  readonly registrationUrl?: string;
  readonly baseSkill: () => Promise<SkillInvocationResult>;
  readonly remoteAgentMcp: RemoteAgentMcpInvoker;
  readonly signal?: AbortSignal;
}

/**
 * Route one Skill step according to the REQ-NEXT-SKILL-003 state machine.
 * Local token presence is checked once and is intentionally not validated.
 */
export async function invokeSkill(options: SkillRouterOptions): Promise<SkillInvocationResult> {
  const entrypoint = options.entrypoint ?? "model";
  const capability = options.capability;
  if (capability !== undefined && !capability.entrypoints.includes(entrypoint)) {
    throw new SkillInvocationError("capability_unavailable", { capabilityId: capability.id });
  }

  const relayUrl = normalizeRelayUrl(options.relayUrl);
  const tokenConfigured = await hasConfiguredLocalToken(relayUrl);
  if (!tokenConfigured) {
    if (capability?.level === "advanced") {
      if (options.registrationUrl === undefined || !isSafeRegistrationUrl(options.registrationUrl)) {
        throw new Error("registration_url_required");
      }
      throw new SkillInvocationError("payment_required", {
        capabilityId: capability.id,
        registrationUrl: options.registrationUrl,
      });
    }
    return options.baseSkill();
  }

  // Do not fall back to baseSkill when the remote invocation rejects: a
  // configured-but-expired/revoked token must remain on the remote route.
  const credential = await readConfiguredLocalCredential(relayUrl);
  if (credential === null || credential.value.length === 0) {
    throw new SkillInvocationError("remote_authorization_failed", {
      ...(capability === undefined ? {} : { capabilityId: capability.id }),
    });
  }
  try {
    return await options.remoteAgentMcp.invoke({
      relayUrl,
      modelId: options.modelId,
      token: credential.value,
      credential,
      task: options.task,
      ...(capability === undefined ? {} : { capabilityId: capability.id }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof SkillInvocationError) throw error;
    throw new SkillInvocationError("remote_authorization_failed", {
      ...(capability === undefined ? {} : { capabilityId: capability.id }),
    });
  }
}

/** Minimal stateless MCP client used by the router's remote path. */
export const remoteAgentMcpInvoker: RemoteAgentMcpInvoker = {
  async invoke(input) {
    return taskResult(await postInvoke(input, {
      input: input.task,
      ...(input.capabilityId === undefined ? {} : { capabilityId: input.capabilityId }),
      ...(input.progressSummary === undefined ? {} : { progressSummary: input.progressSummary }),
    }));
  },

  async invokeTurn(input) {
    const result = await postInvoke(input, { input: input.task, tools: input.tools, ...(input.items.length === 0 ? {} : { items: input.items }) });
    if (result === undefined || result.isError === true) throw new SkillInvocationError("remote_authorization_failed");
    const structured = isRecord(result.structuredContent) ? result.structuredContent : {};
    const requestId = typeof structured.request_id === "string" ? { requestId: structured.request_id.slice(0, 128) } : {};
    const usage = turnUsage(structured.usage);
    const extra = { ...requestId, ...(usage === undefined ? {} : { usage }) };
    if (structured.status === "tool_calls") {
      const calls = (Array.isArray(structured.calls) ? structured.calls : []).flatMap((call) =>
        isRecord(call) && typeof call.callId === "string" && typeof call.name === "string" && typeof call.arguments === "string"
          ? [{ callId: call.callId, name: call.name, arguments: call.arguments }]
          : []);
      const items = (Array.isArray(structured.items) ? structured.items : []).flatMap((item): CallerItem[] =>
        isRecord(item) && item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string" && typeof item.arguments === "string"
          ? [{ type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments }]
          : []);
      if (calls.length === 0 || items.length === 0) throw new SkillInvocationError("remote_call_failed");
      return Object.freeze({ status: "tool_calls" as const, calls, items, ...extra });
    }
    const text = resultText(result);
    if (text.length === 0) throw new SkillInvocationError("remote_authorization_failed");
    return Object.freeze({ status: "completed" as const, text, ...extra });
  },
};

export const remoteAgentTaskClient: RemoteAgentTaskClient = {
  async status(input) {
    return taskResult(await postInvoke(input, { taskId: input.taskId, ...(input.wait ? { wait: true } : {}) }, "task_status"));
  },
  async cancel(input) {
    return taskResult(await postInvoke(input, { taskId: input.taskId }, "task_cancel"));
  },
};

/** The text and, for an Agent task, its state, task id and newest progress line. */
function taskResult(result: Record<string, unknown> | undefined): SkillInvocationResult {
  const text = resultText(result);
  if (result === undefined || result.isError === true || text.length === 0) {
    throw new SkillInvocationError("remote_authorization_failed");
  }
  const structured = isRecord(result.structuredContent) ? result.structuredContent : {};
  const state = structured.state === "running" || structured.state === "completed" || structured.state === "failed" || structured.state === "canceled" ? structured.state : undefined;
  const taskId = typeof structured.taskId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(structured.taskId) ? structured.taskId : undefined;
  const progressSummary = typeof structured.progressSummary === "string" && structured.progressSummary.length > 0 ? structured.progressSummary.slice(0, 200) : undefined;
  return Object.freeze({
    text,
    ...(state === undefined ? {} : { state }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(progressSummary === undefined ? {} : { progressSummary }),
  });
}

/** POST one tools/call (`invoke` unless told otherwise) and return its JSON-RPC result, or throw the typed error the router callers expect. */
async function postInvoke(
  input: { readonly relayUrl: string; readonly modelId: string; readonly token: string; readonly credential?: AuthCredential; readonly signal?: AbortSignal },
  args: Record<string, unknown>,
  tool: "invoke" | "task_status" | "task_cancel" = "invoke",
): Promise<Record<string, unknown> | undefined> {
  const endpoint = new URL(`/mcp/${encodeURIComponent(input.modelId)}`, input.relayUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(input.credential?.scheme === "cookie"
        ? { cookie: input.credential.value }
        : { authorization: `Bearer ${input.token}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "skill-invoke",
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok || !isRecord(payload)) {
    throw new SkillInvocationError("remote_authorization_failed");
  }
  if (isRecord(payload.error)) {
    const data = isRecord(payload.error.data) ? payload.error.data : {};
    // Any other code is passed on as is; only a failed HTTP call or an empty result means the login was refused.
    if (data.code === "payment_required" || data.code === "entitlement_required" || data.code === "capability_unavailable") throw new SkillInvocationError(data.code);
    throw new SkillInvocationError("remote_call_failed", typeof data.code === "string" ? { remoteCode: data.code.slice(0, 64) } : {});
  }
  return isRecord(payload.result) ? payload.result : undefined;
}

function resultText(result: Record<string, unknown> | undefined): string {
  const content = result && Array.isArray(result.content) ? result.content : [];
  return content
    .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("");
}

function turnUsage(value: unknown): AgentTurnUsage | undefined {
  if (!isRecord(value)) return undefined;
  const { input_tokens: input, output_tokens: output, total_tokens: total } = value;
  return [input, output, total].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
    ? { input_tokens: input as number, output_tokens: output as number, total_tokens: total as number }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeRegistrationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}
