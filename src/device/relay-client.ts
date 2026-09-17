import { MaintenanceGate, serveMaintenance } from "../upgrade/maintenance.js";
import { requireMcpAuthorization } from "../mcp-authorization.js";
import { McpLease } from "../runtime/mcp-lease.js";
import WebSocket, { type RawData } from "ws";
import { connectionGrant, ensureDevice } from "./control.js";
import { connectionReporter, type ConnectionEvent } from "./connection-status.js";
import { randomBytes } from "node:crypto";
import {
  DEVICE_RELAY_DEFAULT_MAX_INFLIGHT,
  DEVICE_RELAY_MAX_FRAME_BYTES,
  DEVICE_RELAY_PROTOCOL,
  decodeDeviceRelayEnvelope,
  encodeDeviceRelayEnvelope,
  type DeviceRelayEnvelope,
  type DeviceRelayRequest,
  type DeviceRelayResponse,
} from "./protocol.js";
import { diagnostic, mcpDiagnosticContext, type DiagnosticLog } from "../runtime/diagnostics.js";
import { RelayMcpSession } from "../runtime/relay-mcp.js";
import { openLocalProviderRequest, readLocalProviderBody } from "../provider/local.js";

export interface RelayServeOptions {
  workspace?: string;
  managedService?: boolean;
  signal: AbortSignal;
  log?: (message: string) => void;
}

interface InflightRequest {
  request: DeviceRelayRequest;
  controller: AbortController;
}

export async function serveDeviceRelay(options: RelayServeOptions): Promise<void> {
  const log = options.log ?? (() => undefined);
  diagnostic(log, "relay.started");
  const device = await ensureDevice();
  const reporter = connectionReporter(device, options.workspace);
  const maintenance = options.managedService && process.platform !== "win32" ? new MaintenanceGate() : undefined;
  const closeMaintenance = maintenance ? await serveMaintenance(maintenance) : undefined;
  let delayMs = 1000;
  try {
    while (!options.signal.aborted) {
      let session: RelayMcpSession | null = null;
      let lease: McpLease | null = null;
      try {
        let authorization = null;
        if (options.workspace) {
          try {
            authorization = await requireMcpAuthorization(options.workspace);
            if (authorization.grant.deviceId !== device.deviceId) throw new Error("MCP device differs from the connected device.");
            lease = new McpLease(authorization.grant.id, Date.parse(authorization.grant.expiresAt!));
            const guard = lease;
            session = await RelayMcpSession.create(options.workspace, { assertAuthorized: () => guard.assert(), signal: guard.controller.signal, log, ...(maintenance ? { maintenance } : {}) });
            const activeSession = session;
            guard.controller.signal.addEventListener("abort", () => { void activeSession.close(); }, { once: true });
          } catch (error) {
            diagnostic(log, "relay.authorization_unavailable", {}, error);
            reporter.report({ type: "authorization_unavailable", error });
            authorization = null;
            lease?.close();
            await session?.close();
            session = null; lease = null;
          }
        }
        reporter.report({ type: "connecting", mcpEnabled: Boolean(authorization), authorizationId: authorization?.grant.id });
        const grant = await connectionGrant(device, authorization ? { authorizationId: authorization.grant.id, sign: authorization.sign } : undefined);
        await serveConnection(grant.websocketUrl, grant.accessToken, device.deviceId, session, lease, options.signal, log, reporter.report, maintenance);
        delayMs = 1000;
      } catch (error) {
        if (options.signal.aborted) break;
        diagnostic(log, "relay.disconnected", {}, error);
        reporter.report({ type: "disconnected", error });
        await wait(delayMs, options.signal);
        delayMs = Math.min(delayMs * 2, 15_000);
      } finally {
        lease?.close();
        await session?.close();
      }
    }
    reporter.report({ type: "stopped" });
    await reporter.flush();
  } finally { await closeMaintenance?.(); }
}

export async function serveConnection(
  websocketUrl: string,
  accessToken: string,
  deviceId: string,
  session: RelayMcpSession | null,
  lease: McpLease | null,
  signal: AbortSignal,
  log: (message: string) => void,
  report: (event: ConnectionEvent) => void = () => undefined,
  maintenance?: MaintenanceGate,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(websocketUrl, DEVICE_RELAY_PROTOCOL, {
      headers: { authorization: `Bearer ${accessToken}`, "x-frely-device-id": deviceId },
      maxPayload: DEVICE_RELAY_MAX_FRAME_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
    });
    const inflight = new Map<string, InflightRequest>();
    const cancelled = new Set<string>();
    let finished = false;
    let heartbeatNonce: Buffer | undefined;
    const ping = () => {
      if (socket.readyState === WebSocket.OPEN) { heartbeatNonce = randomBytes(16); socket.ping(heartbeatNonce); }
    };
    const heartbeat = setInterval(ping, 30_000);
    heartbeat.unref?.();

    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      for (const [id, item] of inflight) {
        cancelled.add(id);
        item.controller.abort();
        if (item.request.method === "mcp") session?.cancel(id);
      }
      signal.removeEventListener("abort", onAbort);
      lease?.controller.signal.removeEventListener("abort", onLeaseAbort);
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish();
    signal.addEventListener("abort", onAbort, { once: true });

    const onLeaseAbort = () => report({ type: "mcp_disabled" });
    lease?.controller.signal.addEventListener("abort", onLeaseAbort, { once: true });
    socket.once("open", () => {
      diagnostic(log, "relay.connected");
      report({ type: "connected" });
      if (lease?.controller.signal.aborted) report({ type: "mcp_disabled" });
      ping();
    });
    socket.on("pong", (data: Buffer) => {
      if (heartbeatNonce && data.equals(heartbeatNonce)) { heartbeatNonce = undefined; report({ type: "heartbeat" }); }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", (code, reason) => {
      if (signal.aborted) finish();
      else finish(new Error(`WebSocket closed (${code}${reason.length ? `: ${reason.toString()}` : ""})`));
    });
    socket.on("message", (data) => {
      // WebSocket peers may deliver the same JSON envelope as either a text
      // or a binary frame. `rawDataBuffer` normalizes both forms before the
      // protocol validator parses the JSON.
      void handleFrame(rawDataBuffer(data), socket, inflight, cancelled, session, lease, log, maintenance).catch((error) => { diagnostic(log, "relay.frame_failed", {}, error); finish(error); });
    });
  });
}

async function handleFrame(
  data: Buffer,
  socket: WebSocket,
  inflight: Map<string, InflightRequest>,
  cancelled: Set<string>,
  session: RelayMcpSession | null,
  lease: McpLease | null,
  log: DiagnosticLog,
  maintenance?: MaintenanceGate,
): Promise<void> {
  const envelope = decodeDeviceRelayEnvelope(data);
  if (envelope.type === "mcp_disabled") {
    if (lease?.authorizationId === envelope.id) { lease.close(); await session?.close(); }
    return;
  }
  if (envelope.type === "cancel") {
    const item = inflight.get(envelope.id);
    if (item) {
      cancelled.add(envelope.id);
      item.controller.abort();
      if (item.request.method === "mcp") session?.cancel(envelope.id);
    }
    return;
  }
  if (envelope.type !== "request") return;
  if (inflight.has(envelope.id)) { diagnostic(log, "relay.request_rejected", { requestId: envelope.id }, new Error("Duplicate Device Relay request id.")); send(socket, errorResponse(envelope.id, "duplicate_request", "Duplicate Device Relay request id."), log); return; }
  if (inflight.size >= DEVICE_RELAY_DEFAULT_MAX_INFLIGHT) { diagnostic(log, "relay.request_rejected", { requestId: envelope.id }); send(socket, errorResponse(envelope.id, "inflight_limit", "Device Relay request window is full."), log); return; }
  let release: (() => void) | undefined;
  try { release = maintenance?.enter(); }
  catch { send(socket, errorResponse(envelope.id, "upgrade_in_progress", "Frely is preparing an upgrade. Retry after it completes."), log); return; }
  const controller = new AbortController();
  inflight.set(envelope.id, { request: envelope, controller });
  const operation = envelope.method === "provider"
    ? executeProviderRequest(envelope, socket, controller.signal, cancelled, log)
    : executeMcpRequest(envelope, session, lease).then((payload) => {
        if (!cancelled.has(envelope.id)) send(socket, { protocol: DEVICE_RELAY_PROTOCOL, type: "response", id: envelope.id, ok: true, payload }, log);
      });
  void operation.catch((error) => {
    diagnostic(log, "relay.request_failed", { requestId: envelope.id, ...(envelope.method === "mcp" ? mcpDiagnosticContext(envelope.payload) : {}) }, error);
    if (!cancelled.has(envelope.id)) send(socket, errorResponse(envelope.id, envelope.method === "mcp" ? "mcp_execution_failed" : "provider_execution_failed", safeMessage(error)), log);
  }).finally(() => {
    release?.();
    inflight.delete(envelope.id);
    cancelled.delete(envelope.id);
  });
}

async function executeMcpRequest(request: DeviceRelayRequest, session: RelayMcpSession | null, lease: McpLease | null): Promise<unknown> {
  if (!session || !lease || request.authorizationId !== lease.authorizationId) throw new Error("MCP execution authorization is missing or mismatched.");
  lease.assert();
  return session.execute(request.payload, request.id);
}

async function executeProviderRequest(request: DeviceRelayRequest, socket: WebSocket, signal: AbortSignal, cancelled: Set<string>, log: DiagnosticLog): Promise<void> {
  const opened = await openLocalProviderRequest(request.payload, signal);
  if (opened.contentType !== "text/event-stream") {
    const body = await readLocalProviderBody(opened.response);
    if (!cancelled.has(request.id)) send(socket, {
      protocol: DEVICE_RELAY_PROTOCOL, type: "response", id: request.id, ok: true,
      payload: { status: opened.status, contentType: opened.contentType, body },
    }, log);
    return;
  }
  if (cancelled.has(request.id)) return;
  await sendAsync(socket, { protocol: DEVICE_RELAY_PROTOCOL, type: "stream_start", id: request.id, status: opened.status, contentType: opened.contentType });
  const reader = opened.response.body?.getReader();
  if (!reader) {
    await sendAsync(socket, { protocol: DEVICE_RELAY_PROTOCOL, type: "stream_end", id: request.id });
    return;
  }
  let completed = false;
  try {
    while (!cancelled.has(request.id)) {
      const part = await reader.read();
      if (part.done) {
        completed = true;
        break;
      }
      for (let offset = 0; offset < part.value.byteLength; offset += 256 * 1024) {
        const chunk = part.value.subarray(offset, Math.min(offset + 256 * 1024, part.value.byteLength));
        if (cancelled.has(request.id)) break;
        await sendAsync(socket, { protocol: DEVICE_RELAY_PROTOCOL, type: "stream_chunk", id: request.id, data: Buffer.from(chunk).toString("base64url") });
      }
    }
  } catch (error) {
    if (signal.aborted || cancelled.has(request.id)) return;
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (completed && !cancelled.has(request.id) && socket.readyState === WebSocket.OPEN) {
    await sendAsync(socket, { protocol: DEVICE_RELAY_PROTOCOL, type: "stream_end", id: request.id });
  }
}

function send(socket: WebSocket, envelope: DeviceRelayEnvelope, log: DiagnosticLog): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try { socket.send(encodeDeviceRelayEnvelope(envelope)); }
  catch (error) {
    diagnostic(log, "relay.response_failed", { requestId: envelope.id }, error);
    if (envelope.type !== "response") return;
    const fallback = errorResponse(envelope.id, "response_too_large", "Device Relay response exceeds the frame limit.");
    socket.send(encodeDeviceRelayEnvelope(fallback));
  }
}

async function sendAsync(socket: WebSocket, envelope: DeviceRelayEnvelope): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) throw new Error("Device Relay connection is not open.");
  const encoded = encodeDeviceRelayEnvelope(envelope);
  await new Promise<void>((resolve, reject) => {
    socket.send(encoded, (error) => error ? reject(error) : resolve());
  });
}

function errorResponse(id: string, code: string, message: string): DeviceRelayResponse {
  return { protocol: DEVICE_RELAY_PROTOCOL, type: "response", id, ok: false, error: { code: code.slice(0, 64), message: message.slice(0, 512) } };
}
function rawDataBuffer(data: RawData): Buffer { if (Buffer.isBuffer(data)) return data; if (data instanceof ArrayBuffer) return Buffer.from(data); return Buffer.concat(data); }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/gu, " ").slice(0, 240); }
async function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms); const onAbort = () => done();
    function done() { clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(); }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
