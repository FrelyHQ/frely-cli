/**
 * `frely app key`: provision a device-scoped Frely API key for agent tasks
 * (plan frely-app-agent-toolset §9.3). The key is shown once and never stored
 * by the CLI; it is bound to a device the caller owns and capped at a
 * lifetime spend limit enforced by the relay backend.
 */
import { requireLogin } from "../auth.js";
import { ensureDevice, relayFetch } from "../device/control.js";

const ENDPOINT = "/api/user/device-relay/agent-key";
export const DEFAULT_LIFETIME_USD = 50;
export const MAX_LIFETIME_USD = 500;

export class AppKeyError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "AppKeyError";
  }
}

export interface ProvisionedAppKey {
  keyId: string;
  rawKey: string;
  name: string;
  lifetimeUsd: number | null;
}

export async function provisionAgentKey(lifetimeUsd: number = DEFAULT_LIFETIME_USD): Promise<ProvisionedAppKey> {
  if (!Number.isFinite(lifetimeUsd) || lifetimeUsd <= 0 || lifetimeUsd > MAX_LIFETIME_USD) {
    throw new Error(`--lifetime-usd must be a positive amount of at most ${MAX_LIFETIME_USD}.`);
  }
  const auth = await requireLogin();
  const device = await ensureDevice();
  const response = await relayFetch(auth.config.relayUrl, auth.credential, ENDPOINT, {
    method: "POST",
    body: JSON.stringify({ deviceId: device.deviceId, lifetimeUsd }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new AppKeyError(body?.error?.code ?? "agent_key_failed", response.status, body?.error?.message ?? `Agent key provisioning failed (${response.status}).`);
  }
  const created = await response.json() as { apiKey?: { id?: string; name?: string }; rawKey?: string; limits?: { lifetimeAmount?: number | null } };
  if (typeof created.apiKey?.id !== "string" || typeof created.rawKey !== "string" || created.rawKey.length === 0) throw new AppKeyError("agent_key_invalid", response.status, "Agent key response was invalid.");
  return {
    keyId: created.apiKey.id,
    rawKey: created.rawKey,
    name: created.apiKey.name ?? `frely-app ${device.deviceId.slice(-8)}`,
    lifetimeUsd: created.limits?.lifetimeAmount ?? null,
  };
}
