import { randomUUID } from "node:crypto";
import { diagnostic, mcpDiagnosticContext, type DiagnosticLog } from "./diagnostics.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpServer, type McpRuntimeOptions } from "./mcp.js";

type RequestId = string | number;

type Pending = {
  originalId: RequestId;
  relayId: string;
  resolve: (message: JSONRPCMessage | null) => void;
  reject: (error: unknown) => void;
};

export class RelayMcpSession {
  private readonly pending = new Map<RequestId, Pending>();
  private readonly relayRequests = new Map<string, string>();
  private readonly transport = new RelayMcpTransport(this.pending, this.relayRequests);

  private server: Awaited<ReturnType<typeof createMcpServer>> | undefined;
  private constructor(private readonly log?: DiagnosticLog) {}

  static async create(workspace: string, options: McpRuntimeOptions & { log?: DiagnosticLog } = {}): Promise<RelayMcpSession> {
    const session = new RelayMcpSession(options.log);
    const server = await createMcpServer(workspace, {
      ...options,
      onToolError: (requestId, tool, error) => {
        const pending = session.pending.get(requestId);
        if (pending) diagnostic(options.log, "mcp.tool_failed", { requestId: pending.relayId, tool }, error);
        options.onToolError?.(requestId, tool, error);
      },
    });
    session.server = server;
    await server.connect(session.transport);
    return session;
  }

  async execute(payload: unknown, relayId: string = randomUUID()): Promise<unknown> {
    const context = { requestId: relayId, ...mcpDiagnosticContext(payload) };
    const started = performance.now();
    diagnostic(this.log, "mcp.request_started", context);
    try {
      const response = await this.dispatch(payload, relayId);
      const result = response as { error?: { code?: number }; result?: { isError?: boolean } } | null;
      diagnostic(this.log, "mcp.request_completed", {
        ...context, durationMs: performance.now() - started,
        ...(typeof result?.error?.code === "number" ? { rpcErrorCode: result.error.code } : {}),
        outcome: result?.error ? "protocol_error" : result?.result?.isError ? "tool_error" : "ok",
      });
      return response;
    } catch (error) {
      diagnostic(this.log, "mcp.request_failed", { ...context, durationMs: performance.now() - started }, error);
      throw error;
    }
  }

  private async dispatch(payload: unknown, relayId: string): Promise<unknown> {
    const message = parseJsonRpcMessage(payload);
    const id = requestId(message);
    if (id === undefined) {
      // HTTP requests have no shared client namespace. Relay cancel envelopes
      // identify the exact HTTP request; raw client IDs cannot safely do so.
      if ((message as { method?: string }).method !== "notifications/cancelled") this.transport.deliver(message);
      return null;
    }
    if (isInvalidInitializeRequest(message)) {
      return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
    }
    if (this.relayRequests.has(relayId)) throw new Error("Duplicate Device Relay request id.");
    // A fresh internal ID also prevents a late cancelled response from settling
    // a later request, even if the outer Relay ID were ever reused.
    const internalId = randomUUID();
    return new Promise<JSONRPCMessage | null>((resolve, reject) => {
      this.pending.set(internalId, { originalId: id, relayId, resolve, reject });
      this.relayRequests.set(relayId, internalId);
      try {
        this.transport.deliver({ ...message, id: internalId });
      } catch (error) {
        this.pending.delete(internalId);
        this.relayRequests.delete(relayId);
        reject(error);
      }
    });
  }

  cancel(relayId: string): void {
    const internalId = this.relayRequests.get(relayId);
    if (internalId === undefined) return;
    const pending = this.pending.get(internalId);
    if (!pending) return;
    diagnostic(this.log, "mcp.request_cancelled", { requestId: relayId });
    this.pending.delete(internalId);
    this.relayRequests.delete(relayId);
    pending.reject(new Error("MCP request cancelled by Relay."));
    this.transport.deliver({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: internalId } });
  }

  async close(): Promise<void> {
    await this.server?.close();
    await this.transport.close();
  }
}

class RelayMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private started = false;

  constructor(private readonly pending: Map<RequestId, Pending>, private readonly relayRequests: Map<string, string>) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("Relay MCP transport already started.");
    this.started = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const id = requestId(message);
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.relayRequests.delete(pending.relayId);
    pending.resolve({ ...message, id: pending.originalId });
  }

  deliver(message: JSONRPCMessage): void {
    if (!this.started) throw new Error("Relay MCP transport is not started.");
    this.onmessage?.(message);
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const pending of this.pending.values()) pending.reject(new Error("Relay MCP transport closed."));
    this.pending.clear();
    this.relayRequests.clear();
    this.onclose?.();
  }
}

function parseJsonRpcMessage(value: unknown): JSONRPCMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP JSON-RPC payload.");
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0") throw new Error("Invalid MCP JSON-RPC version.");
  if ("id" in record && typeof record.id !== "string" && typeof record.id !== "number") throw new Error("Invalid MCP JSON-RPC request id.");
  return value as JSONRPCMessage;
}

function requestId(message: JSONRPCMessage): RequestId | undefined {
  const record = message as unknown as Record<string, unknown>;
  const id = record.id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

function isInvalidInitializeRequest(message: JSONRPCMessage): boolean {
  const record = message as unknown as Record<string, unknown>;
  if (record.method !== "initialize") return false;
  const params = record.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return true;
  const values = params as Record<string, unknown>;
  if (typeof values.protocolVersion !== "string") return true;
  if (!values.capabilities || typeof values.capabilities !== "object" || Array.isArray(values.capabilities)) return true;
  const clientInfo = values.clientInfo;
  if (!clientInfo || typeof clientInfo !== "object" || Array.isArray(clientInfo)) return true;
  const metadata = clientInfo as Record<string, unknown>;
  return typeof metadata.name !== "string" || typeof metadata.version !== "string";
}
