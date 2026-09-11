import WebSocket, { type RawData } from "ws";
import { connectionGrant, ensureDevice } from "./control.js";
import {
  DEVICE_RELAY_DEFAULT_MAX_INFLIGHT,
  DEVICE_RELAY_MAX_FRAME_BYTES,
  DEVICE_RELAY_PROTOCOL,
  decodeDeviceRelayEnvelope,
  encodeDeviceRelayEnvelope,
  type DeviceRelayRequest,
  type DeviceRelayResponse,
} from "./protocol.js";
import { RelayMcpSession } from "../runtime/relay-mcp.js";

export interface RelayServeOptions {
  workspace: string;
  signal: AbortSignal;
  log?: (message: string) => void;
}

export async function serveDeviceRelay(options: RelayServeOptions): Promise<void> {
  const device = await ensureDevice();
  const session = await RelayMcpSession.create(options.workspace);
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
    await session.close();
  }
}

async function serveConnection(
  websocketUrl: string,
  accessToken: string,
  deviceId: string,
  session: RelayMcpSession,
  signal: AbortSignal,
  log: (message: string) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(websocketUrl, DEVICE_RELAY_PROTOCOL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-frely-device-id": deviceId,
      },
      maxPayload: DEVICE_RELAY_MAX_FRAME_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
    });
    const inflight = new Map<string, DeviceRelayRequest>();
    const cancelled = new Set<string>();
    let finished = false;
    const heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 30_000);
    heartbeat.unref?.();

    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      signal.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish();
    signal.addEventListener("abort", onAbort, { once: true });

    socket.once("open", () => log(`MCP relay connected for device ${deviceId}.`));
    socket.once("error", (error) => finish(error));
    socket.once("close", (code, reason) => {
      if (signal.aborted) finish();
      else finish(new Error(`WebSocket closed (${code}${reason.length ? `: ${reason.toString()}` : ""})`));
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        finish(new Error("Device Relay sent an unsupported binary control frame."));
        return;
      }
      void handleFrame(rawDataBuffer(data), socket, inflight, cancelled, session).catch((error) => finish(error));
    });
  });
}

async function handleFrame(
  data: Buffer,
  socket: WebSocket,
  inflight: Map<string, DeviceRelayRequest>,
  cancelled: Set<string>,
  session: RelayMcpSession,
): Promise<void> {
  const envelope = decodeDeviceRelayEnvelope(data);
  if (envelope.type === "cancel") {
    const request = inflight.get(envelope.id);
    if (request) {
      cancelled.add(envelope.id);
      session.cancel(request.payload);
    }
    return;
  }
  if (envelope.type !== "request") return;
  if (inflight.has(envelope.id)) {
    send(socket, errorResponse(envelope.id, "duplicate_request", "Duplicate Device Relay request id."));
    return;
  }
  if (inflight.size >= DEVICE_RELAY_DEFAULT_MAX_INFLIGHT) {
    send(socket, errorResponse(envelope.id, "inflight_limit", "Device Relay request window is full."));
    return;
  }
  inflight.set(envelope.id, envelope);
  void session.execute(envelope.payload).then(
    (payload) => {
      if (!cancelled.has(envelope.id)) send(socket, { protocol: DEVICE_RELAY_PROTOCOL, type: "response", id: envelope.id, ok: true, payload });
    },
    (error) => {
      if (!cancelled.has(envelope.id)) send(socket, errorResponse(envelope.id, "mcp_execution_failed", safeMessage(error)));
    },
  ).finally(() => {
    inflight.delete(envelope.id);
    cancelled.delete(envelope.id);
  });
}

function send(socket: WebSocket, response: DeviceRelayResponse): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(encodeDeviceRelayEnvelope(response));
  } catch (error) {
    const fallback = errorResponse(response.id, "response_too_large", "MCP response exceeds the Device Relay frame limit.");
    socket.send(encodeDeviceRelayEnvelope(fallback));
  }
}

function errorResponse(id: string, code: string, message: string): DeviceRelayResponse {
  return {
    protocol: DEVICE_RELAY_PROTOCOL,
    type: "response",
    id,
    ok: false,
    error: { code: code.slice(0, 64), message: message.slice(0, 512) },
  };
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 240);
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
