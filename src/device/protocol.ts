export const DEVICE_RELAY_PROTOCOL = "frely.device-relay.v1" as const;
export const DEVICE_RELAY_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEVICE_RELAY_DEFAULT_MAX_INFLIGHT = 64;

export type DeviceRelayRequest = {
  protocol: typeof DEVICE_RELAY_PROTOCOL;
  type: "request";
  id: string;
  method: "mcp" | "provider";
  authorizationId?: string;
  payload: unknown;
};

export type DeviceRelayResponse = {
  protocol: typeof DEVICE_RELAY_PROTOCOL;
  type: "response";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
};

export type DeviceRelayCancel = {
  protocol: typeof DEVICE_RELAY_PROTOCOL;
  type: "cancel";
  id: string;
};

export type DeviceRelayStreamStart = {
  protocol: typeof DEVICE_RELAY_PROTOCOL;
  type: "stream_start";
  id: string;
  status: number;
  contentType: string;
};

export type DeviceRelayStreamChunk = {
  protocol: typeof DEVICE_RELAY_PROTOCOL;
  type: "stream_chunk";
  id: string;
  data: string;
};

export type DeviceRelayStreamEnd = {
  protocol: typeof DEVICE_RELAY_PROTOCOL;
  type: "stream_end";
  id: string;
};

export type DeviceRelayMcpDisabled = { protocol: typeof DEVICE_RELAY_PROTOCOL; type: "mcp_disabled"; id: string };

export type DeviceRelayEnvelope = DeviceRelayMcpDisabled | DeviceRelayRequest | DeviceRelayResponse | DeviceRelayCancel | DeviceRelayStreamStart | DeviceRelayStreamChunk | DeviceRelayStreamEnd;

export class DeviceRelayProtocolError extends Error {
  constructor(readonly code: "frame_invalid" | "frame_too_large" | "duplicate_request" | "inflight_limit") {
    super(code);
    this.name = "DeviceRelayProtocolError";
  }
}

export function encodeDeviceRelayEnvelope(envelope: DeviceRelayEnvelope): string {
  validateDeviceRelayEnvelope(envelope);
  const encoded = JSON.stringify(envelope);
  if (Buffer.byteLength(encoded) > DEVICE_RELAY_MAX_FRAME_BYTES) throw new DeviceRelayProtocolError("frame_too_large");
  return encoded;
}

export function decodeDeviceRelayEnvelope(input: Buffer | string): DeviceRelayEnvelope {
  if (Buffer.byteLength(input) > DEVICE_RELAY_MAX_FRAME_BYTES) throw new DeviceRelayProtocolError("frame_too_large");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    throw new DeviceRelayProtocolError("frame_invalid");
  }
  validateDeviceRelayEnvelope(value);
  return value;
}

export function validateDeviceRelayEnvelope(value: unknown): asserts value is DeviceRelayEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DeviceRelayProtocolError("frame_invalid");
  const record = value as Record<string, unknown>;
  if (record.protocol !== DEVICE_RELAY_PROTOCOL || typeof record.type !== "string" || typeof record.id !== "string") throw new DeviceRelayProtocolError("frame_invalid");
  assertRequestId(record.id);
  if (record.type === "request") {
    exactKeys(record, ["protocol", "type", "id", "method", "payload", ...(record.authorizationId !== undefined ? ["authorizationId"] : [])]);
    if (record.authorizationId !== undefined && (record.method !== "mcp" || typeof record.authorizationId !== "string" || !/^mca_[a-f0-9]{32}$/u.test(record.authorizationId))) throw new DeviceRelayProtocolError("frame_invalid");
    if (record.method !== "mcp" && record.method !== "provider") throw new DeviceRelayProtocolError("frame_invalid");
    return;
  }
  if (record.type === "mcp_disabled") {
    exactKeys(record, ["protocol", "type", "id"]);
    if (!/^mca_[a-f0-9]{32}$/u.test(record.id)) throw new DeviceRelayProtocolError("frame_invalid");
    return;
  }
  if (record.type === "cancel") {
    exactKeys(record, ["protocol", "type", "id"]);
    return;
  }
  if (record.type === "stream_start") {
    exactKeys(record, ["protocol", "type", "id", "status", "contentType"]);
    if (!Number.isSafeInteger(record.status) || Number(record.status) < 100 || Number(record.status) > 599 || typeof record.contentType !== "string" || record.contentType.length < 1 || record.contentType.length > 128 || !/^[\x20-\x7e]+$/u.test(record.contentType)) throw new DeviceRelayProtocolError("frame_invalid");
    return;
  }
  if (record.type === "stream_chunk") {
    exactKeys(record, ["protocol", "type", "id", "data"]);
    if (typeof record.data !== "string" || record.data.length < 1 || record.data.length > 1024 * 1024) throw new DeviceRelayProtocolError("frame_invalid");
    return;
  }
  if (record.type === "stream_end") {
    exactKeys(record, ["protocol", "type", "id"]);
    return;
  }
  if (record.type === "response") {
    if (typeof record.ok !== "boolean") throw new DeviceRelayProtocolError("frame_invalid");
    exactKeys(record, record.ok ? ["protocol", "type", "id", "ok", "payload"] : ["protocol", "type", "id", "ok", "error"]);
    if (!record.ok) {
      if (!record.error || typeof record.error !== "object" || Array.isArray(record.error)) throw new DeviceRelayProtocolError("frame_invalid");
      const error = record.error as Record<string, unknown>;
      exactKeys(error, ["code", "message"]);
      if (typeof error.code !== "string" || error.code.length < 1 || error.code.length > 64 || typeof error.message !== "string" || error.message.length > 512) {
        throw new DeviceRelayProtocolError("frame_invalid");
      }
    }
    return;
  }
  throw new DeviceRelayProtocolError("frame_invalid");
}

function assertRequestId(id: string): void {
  if (!/^[A-Za-z0-9_-]{16,96}$/u.test(id)) throw new DeviceRelayProtocolError("frame_invalid");
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new DeviceRelayProtocolError("frame_invalid");
}
