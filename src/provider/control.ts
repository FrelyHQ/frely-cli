import { requireLogin, type AuthCredential } from "../auth.js";
import { normalizeRelayProviderBaseUrl } from "./state.js";

const TIMEOUT_MS = 20_000;

export interface PersonalProviderSlot { id: string; lifecycle: string; provider: unknown | null }

export async function listPersonalProviderSlots(): Promise<PersonalProviderSlot[]> {
  const auth = await requireLogin();
  const response = await relayFetch(auth.config.relayUrl, auth.credential, "/api/user/providers?page=1&pageSize=100", { method: "GET" });
  const payload = await responseJson(response);
  if (!response.ok) throw new Error(publicError(payload, response.status));
  const root = object(payload);
  if (!Array.isArray(root.items)) throw new Error("Frely returned an invalid Provider slot list.");
  return root.items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    return typeof record.id === "string" && typeof record.lifecycle === "string" ? [{ id: record.id, lifecycle: record.lifecycle, provider: record.provider ?? null }] : [];
  });
}

export async function prepareLocalProvider(input: { deviceId: string; slotId: string; name: string; models: string[] }): Promise<{ providerId: string; providerBaseUrl: string }> {
  const auth = await requireLogin();
  const response = await relayFetch(auth.config.relayUrl, auth.credential, "/api/user/local-providers/prepare", { method: "POST", body: JSON.stringify(input) });
  const payload = await responseJson(response);
  if (!response.ok) throw new Error(publicError(payload, response.status));
  const record = object(payload);
  if (typeof record.providerId !== "string" || !/^prv_[0-9a-f]{24}$/u.test(record.providerId)) throw new Error("Frely returned an invalid local Provider ID.");
  const providerBaseUrl = normalizeRelayProviderBaseUrl(String(record.providerBaseUrl ?? ""));
  return { providerId: record.providerId, providerBaseUrl };
}

export async function finalizeLocalProvider(input: { providerId: string; token: string }): Promise<void> {
  const auth = await requireLogin();
  const response = await relayFetch(auth.config.relayUrl, auth.credential, "/api/user/local-providers/finalize", { method: "POST", body: JSON.stringify(input) });
  const payload = await responseJson(response);
  if (!response.ok) throw new Error(publicError(payload, response.status));
}

export async function waitForLocalProviderRelay(providerBaseUrlInput: string, token: string, timeoutMs = 15_000): Promise<void> {
  const providerBaseUrl = normalizeRelayProviderBaseUrl(providerBaseUrlInput);
  const deadline = Date.now() + timeoutMs;
  let lastError = "Device Relay is not ready.";
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000); timer.unref?.();
    let response: Response | null = null;
    try {
      response = await fetch(`${providerBaseUrl}/models`, {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      lastError = controller.signal.aborted ? "Device Relay probe timed out." : error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
    if (response) {
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const payload = await responseJson(response);
      lastError = publicError(payload, response.status);
      if (response.status === 401 || response.status === 403 || response.status === 404) throw new Error(lastError);
    }
    await delay(250);
  }
  throw new Error(`Device Relay did not become ready: ${lastError}`);
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function relayFetch(relayUrl: string, credential: AuthCredential, path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS); timer.unref?.();
  try {
    return await fetch(`${relayUrl}${path}`, { ...init, signal: controller.signal, redirect: "error", headers: { accept: "application/json", origin: relayUrl, ...(credential.scheme === "bearer" ? { authorization: `Bearer ${credential.value}` } : { cookie: credential.value }), ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Frely local Provider request timed out.");
    throw error;
  } finally { clearTimeout(timer); }
}
async function responseJson(response: Response): Promise<unknown> { try { return await response.json(); } catch { return null; } }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Frely returned an invalid local Provider response."); return value as Record<string, unknown>; }
function publicError(payload: unknown, status: number): string { const root = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {}; const error = root.error && typeof root.error === "object" && !Array.isArray(root.error) ? root.error as Record<string, unknown> : root; return typeof error.message === "string" ? error.message : `Frely local Provider request failed with HTTP ${status}.`; }
