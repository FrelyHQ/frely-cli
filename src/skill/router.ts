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

export interface SkillInvocationResult {
  readonly text: string;
  readonly usage?: Readonly<Record<string, unknown>>;
}

export class SkillInvocationError extends Error {
  constructor(
    readonly code: "payment_required" | "entitlement_required" | "remote_authorization_failed" | "capability_unavailable",
    readonly details: Readonly<{
      readonly capabilityId?: string;
      readonly registrationUrl?: string;
    }> = {},
  ) {
    super(code);
    this.name = "SkillInvocationError";
  }
}

export interface RemoteAgentMcpInvoker {
  invoke(input: {
    readonly relayUrl: string;
    readonly modelId: string;
    readonly token: string;
    readonly credential?: AuthCredential;
    readonly task: string;
    readonly capabilityId?: string;
    readonly signal?: AbortSignal;
  }): Promise<SkillInvocationResult>;
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
      if (options.registrationUrl === undefined) {
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
        params: {
          name: "invoke",
          arguments: {
            input: input.task,
            ...(input.capabilityId === undefined ? {} : { capabilityId: input.capabilityId }),
          },
        },
      }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok || !isRecord(payload)) {
      throw new SkillInvocationError("remote_authorization_failed");
    }
    if (isRecord(payload.error)) {
      const data = isRecord(payload.error.data) ? payload.error.data : {};
      const code = data.code === "entitlement_required"
        ? "entitlement_required"
        : data.code === "capability_unavailable" ? "capability_unavailable" : "remote_authorization_failed";
      throw new SkillInvocationError(code);
    }
    const result = isRecord(payload.result) ? payload.result : undefined;
    const content = result && Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("");
    if (result === undefined || result.isError === true || text.length === 0) {
      throw new SkillInvocationError("remote_authorization_failed");
    }
    return Object.freeze({ text });
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
