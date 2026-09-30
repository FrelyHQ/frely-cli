import { diagnostic, type DiagnosticLog } from "./diagnostics.js";

/**
 * A device-relay session bridges a remote client (through the relay transport)
 * to a local runtime.
 *
 * The relay transport (WebSocket, envelope, backpressure, heartbeat) lives in
 * `relay-client.ts`; a session only needs `execute` / `cancel` / `close`. This
 * small seam is what lets the SAME transport serve different local runtimes
 * without duplication:
 *
 * - `RelayMcpSession` (MCP, JSON-RPC) — the existing transport target.
 * - `RelayNodeSession` (Pi Node, raw frames) — the P4 daemon target.
 *
 * `serveDeviceRelay` accepts any `RelaySession` via an injectable factory, so
 * the relay never hard-codes MCP.
 */
export interface RelaySession {
  execute(payload: unknown, relayId: string, toolsets?: string[]): Promise<unknown>;
  cancel(relayId: string): void;
  close(): Promise<void>;
}

/**
 * Forwards raw Pi Node frames to the owning runtime (the frely-client daemon).
 * The runtime is reached over IPC from the relay bridge; this interface keeps
 * the relay decoupled from that transport. The [AbortSignal] lets the handler
 * abort an in-flight frame when the relay cancels the request or closes.
 */
export interface NodeFrameHandler {
  handleFrame(frame: Buffer, signal: AbortSignal): Promise<Buffer>;
  cancelFrame(relayId: string): void;
}

/**
 * A [RelaySession] that relays raw Pi Node frames to a [NodeFrameHandler].
 *
 * The relay envelope is JSON, so Pi frames are base64-encoded inside the
 * request/response `payload`. This session decodes inbound frames and re-encodes
 * outbound frames, keeping the relay transport transport-agnostic.
 */
export class RelayNodeSession implements RelaySession {
  private readonly pending = new Map<string, AbortController>();

  constructor(
    private readonly handler: NodeFrameHandler,
    private readonly log?: DiagnosticLog,
  ) {}

  async execute(payload: unknown, relayId: string, _toolsets?: string[]): Promise<unknown> {
    const frame = decodeNodeFrame(payload);
    const controller = new AbortController();
    this.pending.set(relayId, controller);
    diagnostic(this.log, "relay.node.request_started", { requestId: relayId });
    try {
      const response = await this.handler.handleFrame(frame, controller.signal);
      return { frame: response.toString("base64") };
    } catch (error) {
      diagnostic(this.log, "relay.node.request_failed", { requestId: relayId }, error);
      throw error;
    } finally {
      this.pending.delete(relayId);
    }
  }

  cancel(relayId: string): void {
    this.handler.cancelFrame(relayId);
    const controller = this.pending.get(relayId);
    if (controller) {
      this.pending.delete(relayId);
      controller.abort();
    }
  }

  async close(): Promise<void> {
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
  }
}

function decodeNodeFrame(payload: unknown): Buffer {
  if (!payload || typeof payload !== "object") throw new Error("Invalid node frame payload.");
  const record = payload as { frame?: unknown };
  if (typeof record.frame !== "string") throw new Error("Node frame payload is missing a base64 'frame'.");
  return Buffer.from(record.frame, "base64");
}
