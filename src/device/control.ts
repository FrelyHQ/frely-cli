import { hostname, platform } from "node:os";
import { requireLogin } from "../auth.js";
import { createConnectionProof, deleteDeviceIdentity, loadOrCreateDeviceIdentity } from "./identity.js";
import { clearDeviceBinding, readDeviceBinding, writeDeviceBinding, type DeviceBinding } from "./state.js";
import { VERSION } from "../version.js";
import { isDeviceTransportKind, type DeviceTransportGrant } from "./transport.js";

const CLIENT_VERSION = VERSION;
const TIMEOUT_MS = 15_000;

export interface ConnectionGrant {
  transports: readonly DeviceTransportGrant[];
}

export async function ensureDevice(): Promise<DeviceBinding> {
  const auth = await requireLogin();
  const existing = await readDeviceBinding();
  if (existing && existing.relayUrl === auth.config.relayUrl && existing.userId === auth.user.id) return existing;
  const identity = await loadOrCreateDeviceIdentity(auth.config.relayUrl, auth.user.id);
  const response = await relayFetch(auth.config.relayUrl, auth.credential, "/api/user/device-relay/enroll", {
    method: "POST",
    body: JSON.stringify({
      publicKeySpki: identity.publicKeySpki,
      keyThumbprint: identity.keyThumbprint,
      deviceName: hostname(),
      platform: platform(),
      cliVersion: CLIENT_VERSION,
    }),
  });
  if (response.status === 404 || response.status === 405) throw new Error("This Frely Relay does not provide MCP device enrollment yet.");
  const payload = await responseJson(response);
  if (!response.ok) throw new Error(publicError(payload, response.status));
  const record = object(payload);
  const deviceId = requiredString(record, "deviceId", 256);
  const binding: DeviceBinding = {
    version: 2,
    relayUrl: auth.config.relayUrl,
    userId: auth.user.id,
    deviceId,
    publicKeySpki: identity.publicKeySpki,
    keyThumbprint: identity.keyThumbprint,
    updatedAt: new Date().toISOString(),
  };
  await writeDeviceBinding(binding);
  return binding;
}

export async function currentDevice(): Promise<DeviceBinding | null> {
  const auth = await requireLogin();
  const binding = await readDeviceBinding();
  if (!binding || binding.relayUrl !== auth.config.relayUrl || binding.userId !== auth.user.id) return null;
  return binding;
}

export async function connectionGrant(binding?: DeviceBinding, mcp?: { authorizationId: string; sign(message: string): string }): Promise<ConnectionGrant> {
  const auth = await requireLogin();
  const device = binding ?? await ensureDevice();
  if (device.relayUrl !== auth.config.relayUrl || device.userId !== auth.user.id) throw new Error("Device binding does not belong to the current Frely login.");
  const identity = await loadOrCreateDeviceIdentity(auth.config.relayUrl, auth.user.id);
  if (identity.keyThumbprint !== device.keyThumbprint) throw new Error("Device key does not match the enrolled device.");
  const proof = createConnectionProof(identity, device.deviceId);
  const response = await relayFetch(auth.config.relayUrl, auth.credential, "/api/user/device-relay/connect", {
    method: "POST",
    body: JSON.stringify({ ...proof, ...(mcp ? {
      mcpAuthorizationId: mcp.authorizationId,
      mcpSignature: mcp.sign(["frely.mcp.connect.v1", device.deviceId, mcp.authorizationId, proof.issuedAt, proof.nonce].join("\n")),
    } : {}) }),
  });
  if (response.status === 404 || response.status === 405) throw new Error("This Frely Relay does not provide Device Relay connections yet.");
  const payload = await responseJson(response);
  if (!response.ok) throw new Error(publicError(payload, response.status));
  const record = object(payload);
  return { transports: parseConnectionTransports(record) };
}


function parseConnectionTransports(record: Record<string, unknown>): readonly DeviceTransportGrant[] {
  const topLevelExpiresAt = optionalExpiry(record.expiresAt);
  const raw = record.transports;
  if (raw !== undefined) {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) throw new Error("Frely Relay returned invalid Device transports.");
    const transports: DeviceTransportGrant[] = [];
    const seen = new Set<string>();
    for (const value of raw) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Frely Relay returned an invalid Device transport.");
      const candidate = value as Record<string, unknown>;
      if (!isDeviceTransportKind(candidate.kind)) continue;
      if (seen.has(candidate.kind)) throw new Error("Frely Relay returned duplicate Device transports.");
      seen.add(candidate.kind);
      transports.push({
        kind: candidate.kind,
        websocketUrl: validateWebSocketUrl(requiredString(candidate, "websocketUrl", 4096)),
        accessToken: requiredString(candidate, "accessToken", 8192),
        expiresAt: requiredExpiry(candidate.expiresAt, topLevelExpiresAt),
      });
    }
    if (transports.length > 0) return transports;
  }
  return [{
    kind: "relay",
    websocketUrl: validateWebSocketUrl(requiredString(record, "websocketUrl", 4096)),
    accessToken: requiredString(record, "accessToken", 8192),
    expiresAt: requiredExpiry(record.expiresAt),
  }];
}

function optionalExpiry(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !Number.isFinite(Date.parse(value))) {
    throw new Error("Frely Relay returned an invalid expiresAt.");
  }
  return value;
}

function requiredExpiry(value: unknown, fallback?: string): string {
  const expiry = value === undefined ? fallback : optionalExpiry(value);
  if (!expiry) throw new Error("Frely Relay returned an invalid expiresAt.");
  return expiry;
}

export async function revokeDevice(): Promise<void> {
  const auth = await requireLogin();
  const binding = await currentDevice();
  if (!binding) {
    await clearDeviceBinding();
    await deleteDeviceIdentity(auth.config.relayUrl, auth.user.id);
    return;
  }
  const response = await relayFetch(auth.config.relayUrl, auth.credential, "/api/user/device-relay/revoke", {
    method: "POST",
    body: JSON.stringify({ deviceId: binding.deviceId }),
  });
  if (response.status === 404 || response.status === 405) throw new Error("This Frely Relay does not provide Device Relay revocation yet.");
  if (!response.ok) {
    const payload = await responseJson(response);
    throw new Error(publicError(payload, response.status));
  }
  await clearDeviceBinding();
  await deleteDeviceIdentity(auth.config.relayUrl, auth.user.id);
}

export async function relayFetch(relayUrl: string, credential: { scheme: "bearer" | "cookie"; value: string }, path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetch(`${relayUrl}${path}`, {
      ...init,
      redirect: "error",
      signal: controller.signal,
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        ...(credential.scheme === "bearer" ? { authorization: `Bearer ${credential.value}` } : { cookie: credential.value }),
        "origin": relayUrl,
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Frely Device Relay request timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function validateWebSocketUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) throw new Error("Relay returned an invalid Device Relay WebSocket URL.");
  if (url.username || url.password) throw new Error("Device Relay WebSocket URL must not contain credentials.");
  return url.toString();
}

async function responseJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Frely Relay returned an invalid Device Relay response.");
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, max: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw new Error(`Frely Relay returned an invalid ${key}.`);
  return value;
}

function publicError(payload: unknown, status: number): string {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const error = record.error && typeof record.error === "object" && !Array.isArray(record.error) ? record.error as Record<string, unknown> : record;
  return typeof error.message === "string" ? error.message : `Frely Device Relay request failed with HTTP ${status}.`;
}
