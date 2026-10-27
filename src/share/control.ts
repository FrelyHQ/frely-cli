import { requireLogin, type AuthCredential } from "../auth.js";
import { ensureDevice } from "../device/control.js";
import { parseShareGrant, type ShareGrant } from "./frpc-config.js";

const TIMEOUT_MS = 20_000;
const SHARES_PATH = "/api/user/device-relay/shares";

export interface ShareHeartbeat { readonly active: boolean; readonly reason?: string; readonly remainingBytes: number; readonly expiresAt: string }

export interface ShareControl {
  create(input: { ttlSeconds?: number }): Promise<ShareGrant>;
  heartbeat(sessionId: string): Promise<ShareHeartbeat>;
  revoke(sessionId: string): Promise<void>;
}

/** Calls Frely's share route as the signed-in user; the device is this computer's enrolled device. */
export async function accountShareControl(): Promise<ShareControl> {
  const auth = await requireLogin();
  const device = await ensureDevice();
  const call = async (body: Record<string, unknown>): Promise<unknown> => {
    const response = await relayFetch(auth.config.relayUrl, auth.credential, { method: "POST", body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(publicError(payload, response.status));
    return payload;
  };
  return {
    async create(input) { return parseShareGrant(await call({ action: "create", deviceId: device.deviceId, ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}) })); },
    async heartbeat(sessionId) {
      const value = await call({ action: "heartbeat", sessionId });
      if (!value || typeof value !== "object" || typeof (value as { active?: unknown }).active !== "boolean") throw new Error("Frely returned an invalid share status.");
      return value as ShareHeartbeat;
    },
    async revoke(sessionId) { await call({ action: "revoke", sessionId }); },
  };
}

async function relayFetch(relayUrl: string, credential: AuthCredential, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS); timer.unref?.();
  try {
    return await fetch(`${relayUrl}${SHARES_PATH}`, { ...init, signal: controller.signal, redirect: "error", headers: { accept: "application/json", origin: relayUrl, "content-type": "application/json", ...(credential.scheme === "bearer" ? { authorization: `Bearer ${credential.value}` } : { cookie: credential.value }) } });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Frely share request timed out.");
    throw error;
  } finally { clearTimeout(timer); }
}

function publicError(payload: unknown, status: number): string {
  const root = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const error = root.error && typeof root.error === "object" && !Array.isArray(root.error) ? root.error as Record<string, unknown> : root;
  return typeof error.message === "string" ? error.message : `Frely share request failed with HTTP ${status}.`;
}
