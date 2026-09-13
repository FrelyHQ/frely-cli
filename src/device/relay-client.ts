import WebSocket, { type RawData } from "ws";
import { connectionGrant, ensureDevice } from "./control.js";
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
import { RelayMcpSession } from "../runtime/relay-mcp.js";
import { openLocalProviderRequest, readLocalProviderBody } from "../provider/local.js";

export interface RelayServeOptions {
  workspace?: string;
  signal: AbortSignal;
  log?: (message: string) => void;
}

interface InflightRequest {
  request: DeviceRelayRequest;
  controller: AbortController;
}

export async function serveDeviceRelay(options: RelayServeOptions): Promise<void> {
  const device = await ensureDevice();
  const session = options.workspace ? await RelayMcpSession.create(options.workspace) : null;
  const log = options.log ?? (() => undefined);
  let delayMs = 1000;
  try {
    while (!options.signal.aborted) {
      try {
        const grant = await connectionGrant(device);
        await serveConnection(grant.websocketUrl, grant.accessToken, device.deviceId, session, options.signal, log);
        delayMs = 1000;
      } catch (error) {
        if (options.signal.aborted) break;
        log(`Device Relay disconnected: ${safeMessage(error)}. Reconnecting.`);
        await wait(delayMs, options.signal);
        delayMs = Math.min(delayMs * 2, 15_000);
      }
    }
  } finally {
    await session?.close();
  }
}

async function serveConnection(
  websocketUrl: string,
  accessToken: string,
  deviceId: string,
  session: RelayMcpSession | null,
  signal: AbortSignal,
  log: (message: string) => void,
): Promise<void> {
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
    const heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.ping(); }, 30_000);
    heartbeat.unref?.();

    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      for (const item of inflight.values()) item.controller.abort();
      signal.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish();
    signal.addEventListener("abort", onAbort, { once: true });

    socket.once("open", () => log(`Device Relay connected for device ${deviceId}.`));
    socket.once("error", (error) => finish(error));
    socket.once("close", (code, reason) => {
      if (signal.aborted) finish();
      else finish(new Error(`WebSocket closed (${code}${reason.length ? `: ${reason.toString()}` : ""})`));
    });
    socket.on("message", (data) => {
      // WebSocket peers may deliver the same JSON envelope as either a text
      // or a binary frame. `rawDataBuffer` normalizes both forms before the
      // protocol validator parses the JSON.
      void handleFrame(rawDataBuffer(data), socket, inflight, cancelled, session).catch((error) => finish(error));
    });
  });
}

async function handleFrame(
  data: Buffer,
  socket: WebSocket,
  inflight: Map<string, InflightRequest>,
  cancelled: Set<string>,
  session: RelayMcpSession | null,
): Promise<void> {
  const envelope = decodeDeviceRelayEnvelope(data);
  if (envelope.type === "cancel") {
    const item = inflight.get(envelope.id);
    if (item) {
      cancelled.add(envelope.id);
      item.controller.abort();
      if (item.request.method === "mcp") session?.cancel(item.request.payload);
    }
    return;
  }
  if (envelope.type !== "request") return;
  if (inflight.has(envelope.id)) { send(socket, errorResponse(envelope.id, "duplicate_request", "Duplicate Device Relay request id.")); return; }
  if (inflight.size >= DEVICE_RELAY_DEFAULT_MAX_INFLIGHT) { send(socket, errorResponse(envelope.id, "inflight_limit", "Device Relay request window is full.")); return; }
  const controller = new AbortController();
  inflight.set(envelope.id, { request: envelope, controller });
  const operation = envelope.method === "provider"
    ? executeProviderRequest(envelope, socket, controller.signal, cancelled)
    : executeMcpRequest(envelope, session).then((payload) => {
        if (!cancelled.has(envelope.id)) send(socket, { protocol: DEVICE_RELAY_PROTOCOL, type: "response", id: envelope.id, ok: true, payload });
      });
  void operation.catch((error) => {
    if (!cancelled.has(envelope.id)) send(socket, errorResponse(envelope.id, envelope.method === "mcp" ? "mcp_execution_failed" : "provider_execution_failed", safeMessage(error)));
  }).finally(() => {
    inflight.delete(envelope.id);
    cancelled.delete(envelope.id);
  });
}

async function executeMcpRequest(request: DeviceRelayRequest, session: RelayMcpSession | null): Promise<unknown> {
  if (!session) throw new Error("MCP workspace is not configured on this device.");
  return session.execute(request.payload);
}

async function executeProviderRequest(request: DeviceRelayRequest, socket: WebSocket, signal: AbortSignal, cancelled: Set<string>): Promise<void> {
  const opened = await openLocalProviderRequest(request.payload, signal);
  if (opened.contentType !== "text/event-stream") {
    const body = await readLocalProviderBody(opened.response);
    if (!cancelled.has(request.id)) send(socket, {
      protocol: DEVICE_RELAY_PROTOCOL, type: "response", id: request.id, ok: true,
      payload: { status: opened.status, contentType: opened.contentType, body },
    });
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

function send(socket: WebSocket, envelope: DeviceRelayEnvelope): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try { socket.send(encodeDeviceRelayEnvelope(envelope)); }
  catch {
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
