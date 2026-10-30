import { requireLogin, type AuthCredential } from "../auth.js";
import { isInteractiveTerminal, permissionHint, rerunAfterApproval } from "../cloud.js";
import { openController, type Controller } from "../controller/client.js";
import { waitForApproval } from "../controller/approval-wait.js";
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

type CallResult = { isError?: boolean; content?: unknown; structuredContent?: unknown; [key: string]: unknown };

/**
 * Opens the public link through the account operation `shares.create`: like every confirm-level operation it needs the owner's one-time
 * approval, so the first call answers with an approval code and link, and this waits for the decision with the shared approval wait and then
 * repeats the call once. Heartbeat and revoke of the running session use Frely's share route as the signed-in user.
 */
export async function createShareViaApproval(controller: Pick<Controller, "call">, input: { deviceId: string; ttlSeconds?: number }, write: (text: string) => void = (text) => { process.stderr.write(text); }): Promise<ShareGrant> {
  const args: Record<string, unknown> = { deviceId: input.deviceId, ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}) };
  const call = (arguments_: Record<string, unknown>) => controller.call("frely_call", { tool: "shares.create", arguments: arguments_ }) as Promise<CallResult>;
  let result = await call(args);
  const hint = permissionHint(result);
  if (hint) {
    write(hint + "\nWaiting for your approval (up to 10 minutes); the share starts by itself once you approve.\n");
    result = await rerunAfterApproval(result, call, args, (ref, timeoutMs) => waitForApproval(controller, ref, timeoutMs));
  }
  if (result.isError === true) throw new Error(shareFailure(result));
  const text = Array.isArray(result.content) ? (result.content as Array<{ type?: unknown; text?: unknown }>).find((part) => part.type === "text")?.text : undefined;
  return parseShareGrant(result.structuredContent ?? (typeof text === "string" ? JSON.parse(text) : null));
}

function shareFailure(result: CallResult): string {
  const text = Array.isArray(result.content) ? (result.content as Array<{ type?: unknown; text?: unknown }>).find((part) => part.type === "text")?.text : undefined;
  try {
    const error = (JSON.parse(String(text)) as { error?: { code?: unknown; message?: unknown } }).error;
    if (error?.code === "confirmation_required") return "The share was not approved. Run frely share again and approve it in your browser.";
    if (typeof error?.message === "string") return error.message;
    if (typeof error?.code === "string") return `Frely could not open the share (${error.code}).`;
  } catch { /* Not a JSON failure. */ }
  return "Frely could not open the share.";
}

export async function accountShareControl(): Promise<ShareControl> {
  const device = await ensureDevice();
  const call = await accountRelayCaller(SHARES_PATH);
  return {
    async create(input) {
      const controller = await openController({ interactive: isInteractiveTerminal() });
      try { return await createShareViaApproval(controller, { deviceId: device.deviceId, ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}) }); }
      finally { await controller.close().catch(() => undefined); }
    },
    async heartbeat(sessionId) {
      const value = await call({ action: "heartbeat", sessionId });
      if (!value || typeof value !== "object" || typeof (value as { active?: unknown }).active !== "boolean") throw new Error("Frely returned an invalid share status.");
      return value as ShareHeartbeat;
    },
    async revoke(sessionId) { await call({ action: "revoke", sessionId }); },
  };
}

/** A POST helper for one of Frely's device-relay routes, signed in as the user. */
export async function accountRelayCaller(path: string): Promise<(body: Record<string, unknown>) => Promise<unknown>> {
  const auth = await requireLogin();
  return async (body) => {
    const response = await relayFetch(auth.config.relayUrl, auth.credential, path, { method: "POST", body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(publicError(payload, response.status));
    return payload;
  };
}

async function relayFetch(relayUrl: string, credential: AuthCredential, path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS); timer.unref?.();
  try {
    return await fetch(`${relayUrl}${path}`, { ...init, signal: controller.signal, redirect: "error", headers: { accept: "application/json", origin: relayUrl, "content-type": "application/json", ...(credential.scheme === "bearer" ? { authorization: `Bearer ${credential.value}` } : { cookie: credential.value }) } });
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
