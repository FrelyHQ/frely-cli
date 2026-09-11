import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpServer } from "./mcp.js";

type RequestId = string | number;

type Pending = {
  resolve: (message: JSONRPCMessage | null) => void;
  reject: (error: unknown) => void;
};

export class RelayMcpSession {
  private readonly pending = new Map<RequestId, Pending>();
  private readonly transport = new RelayMcpTransport(this.pending);

  private constructor() {}

  static async create(workspace: string): Promise<RelayMcpSession> {
    const session = new RelayMcpSession();
    const server = await createMcpServer(workspace);
    await server.connect(session.transport);
    return session;
  }

  async execute(payload: unknown): Promise<unknown> {
    const message = parseJsonRpcMessage(payload);
    const id = requestId(message);
    if (id === undefined) {
      this.transport.deliver(message);
      return null;
    }
    if (this.pending.has(id)) throw new Error("Duplicate MCP request id.");
    return new Promise<JSONRPCMessage | null>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.transport.deliver(message);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  cancel(payload: unknown): void {
    const message = parseJsonRpcMessage(payload);
    const id = requestId(message);
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.reject(new Error("MCP request cancelled by Relay."));
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

class RelayMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private started = false;

  constructor(private readonly pending: Map<RequestId, Pending>) {}

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
    pending.resolve(message);
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
