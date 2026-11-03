import WebSocket from "ws";
import type { McpLease } from "../runtime/mcp-lease.js";
import type { RelaySession } from "../runtime/relay-session.js";
import { diagnostic, type DiagnosticLog } from "../runtime/diagnostics.js";
import {
  DEVICE_RELAY_DEFAULT_MAX_INFLIGHT,
  DEVICE_RELAY_PROTOCOL,
  encodeDeviceRelayEnvelope,
  type DeviceRelayEnvelope,
  type DeviceRelayRequest,
} from "./protocol.js";

/**
 * How long a dropped connection's MCP commands may keep running, and how long their results are kept,
 * waiting for the next connection. The relay holds the caller for 60 s, so a little longer than that is enough:
 * after this the relay has failed the caller and a result would only be dropped.
 */
export const RELAY_RESUME_RETAIN_MS = 90_000;
/** Results kept for the next connection are bounded by count (the in-flight window) and by bytes, so a burst of large results cannot fill memory. */
export const RELAY_RESUME_QUEUE_MAX_BYTES = 16 * 1024 * 1024;

export interface InflightRequest {
  request: DeviceRelayRequest;
  controller: AbortController;
  /** The session that runs the request; it may belong to an earlier connection, so a cancel goes to this one. */
  session: RelaySession | null;
}

interface Retired { session: RelaySession | null; lease: McpLease | null }

/**
 * State that outlives one websocket connection (plan: keep in-flight commands alive across reconnects).
 * MCP commands keep running after a network drop; their results wait here and go out first on the next connection,
 * where the relay matches them to the caller by the original request id. Provider streams are never resumed.
 * With `enabled` false (a caller that does not pass this object to `serveConnection`) a drop cancels everything, as before.
 */
export class RelayResume {
  readonly inflight = new Map<string, InflightRequest>();
  readonly cancelled = new Set<string>();
  private readonly queue = new Map<string, { frame: string; at: number }>();
  private queuedBytes = 0;
  private socket: WebSocket | undefined;
  private detachTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly retired = new Set<Retired>();

  constructor(
    readonly enabled: boolean,
    private readonly log: DiagnosticLog = () => undefined,
    private readonly retainMs: number = RELAY_RESUME_RETAIN_MS,
  ) {}

  /** The new connection is open: it takes over, and results that waited for it go out before anything else. */
  attach(socket: WebSocket): void {
    this.socket = socket;
    if (this.detachTimer) { clearTimeout(this.detachTimer); this.detachTimer = undefined; }
    this.flush(socket);
  }

  /**
   * The connection ended. With `keep`, MCP commands continue and wait for the next connection (up to `retainMs`);
   * otherwise (and for Provider streams always) they are cancelled.
   */
  detach(socket: WebSocket, keep: boolean): void {
    if (this.socket !== socket) {
      if (!this.socket && !(this.enabled && keep)) this.abortAll();
      return;
    }
    this.socket = undefined;
    if (!this.enabled || !keep) { this.abortAll(); return; }
    for (const [id, item] of this.inflight) if (item.request.method !== "mcp") this.abort(id, item);
    if (this.inflight.size > 0 || this.queue.size > 0) {
      diagnostic(this.log, "relay.inflight_retained", { inflight: this.inflight.size });
      this.detachTimer ??= setTimeout(() => {
        this.detachTimer = undefined;
        diagnostic(this.log, "relay.resume_expired", { inflight: this.inflight.size });
        this.abortAll();
      }, this.retainMs);
      this.detachTimer.unref?.();
    }
  }

  /** Sends a frame now, or (for the result of an MCP command, while disconnected) keeps it for the next connection. */
  deliver(envelope: DeviceRelayEnvelope): void {
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try { socket.send(encodeDeviceRelayEnvelope(envelope)); return; }
      catch (error) {
        diagnostic(this.log, "relay.response_failed", { requestId: envelope.id }, error);
        if (envelope.type !== "response") return;
        try { socket.send(encodeDeviceRelayEnvelope(tooLarge(envelope.id))); } catch { /* socket closing */ }
        return;
      }
    }
    if (!this.enabled || envelope.type !== "response" || this.inflight.get(envelope.id)?.request.method !== "mcp" || this.cancelled.has(envelope.id)) return;
    let frame: string;
    try { frame = encodeDeviceRelayEnvelope(envelope); }
    catch { frame = encodeDeviceRelayEnvelope(tooLarge(envelope.id)); }
    if (this.queue.size >= DEVICE_RELAY_DEFAULT_MAX_INFLIGHT || this.queuedBytes + Buffer.byteLength(frame) > RELAY_RESUME_QUEUE_MAX_BYTES) {
      // No room: a small error still lets the caller finish instead of waiting for the relay's timeout.
      diagnostic(this.log, "relay.resume_queue_full", { requestId: envelope.id });
      frame = encodeDeviceRelayEnvelope({ protocol: DEVICE_RELAY_PROTOCOL, type: "response", id: envelope.id, ok: false, error: { code: "response_not_retained", message: "The result could not be kept while the connection was down." } });
    }
    this.dropQueued(envelope.id);
    this.queue.set(envelope.id, { frame, at: Date.now() });
    this.queuedBytes += Buffer.byteLength(frame);
  }

  /** The relay cancelled a request (or told us it gave up on it): its queued result, if any, is not wanted. */
  dropQueued(id: string): void {
    const entry = this.queue.get(id);
    if (!entry) return;
    this.queuedBytes -= Buffer.byteLength(entry.frame);
    this.queue.delete(id);
  }

  /**
   * Called when a connection ends and its session and lease are about to be closed. If commands of that session are
   * still running they must keep both, so they are parked here and closed once the last of them finishes. Returns true when parked.
   */
  retire(session: RelaySession | null, lease: McpLease | null): boolean {
    if (!session || ![...this.inflight.values()].some((item) => item.session === session)) return false;
    this.retired.add({ session, lease });
    return true;
  }

  /** A request finished: parked sessions with nothing left to run are closed. */
  settled(): void {
    for (const entry of [...this.retired]) {
      if ([...this.inflight.values()].some((item) => item.session === entry.session)) continue;
      this.retired.delete(entry);
      entry.lease?.close();
      void entry.session?.close();
    }
  }

  /** Cancels everything still running or waiting; used when the connection is gone for good and when the service stops. */
  abortAll(): void {
    if (this.detachTimer) { clearTimeout(this.detachTimer); this.detachTimer = undefined; }
    for (const [id, item] of [...this.inflight]) this.abort(id, item);
    this.queue.clear();
    this.queuedBytes = 0;
    this.settled();
  }

  /** The service is stopping: nothing is kept. */
  async closeAll(): Promise<void> {
    this.socket = undefined;
    this.abortAll();
    for (const entry of [...this.retired]) { this.retired.delete(entry); entry.lease?.close(); await entry.session?.close(); }
  }

  private abort(id: string, item: InflightRequest): void {
    this.cancelled.add(id);
    item.controller.abort();
    if (item.request.method === "mcp") item.session?.cancel(id);
  }

  private flush(socket: WebSocket): void {
    const expired = Date.now() - this.retainMs;
    for (const [id, entry] of [...this.queue]) {
      if (entry.at < expired) { this.dropQueued(id); continue; }
      if (socket.readyState !== WebSocket.OPEN) return;
      try { socket.send(entry.frame); } catch { return; }
      this.dropQueued(id);
    }
  }
}

function tooLarge(id: string): DeviceRelayEnvelope {
  return { protocol: DEVICE_RELAY_PROTOCOL, type: "response", id, ok: false, error: { code: "response_too_large", message: "Device Relay response exceeds the frame limit." } };
}
