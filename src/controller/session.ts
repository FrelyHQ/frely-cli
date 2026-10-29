import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir, hostname, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { credentialStore, type CredentialStore } from "../credential-store.js";
import { createEncryptedCredentialStore } from "../credential-file.js";
import { normalizeRelayUrl, openVerificationUrl, requireLogin } from "../auth.js";
import { ensureDevice } from "../device/control.js";
import { VERSION } from "../version.js";
import { createDpopProof, dpopKeyFromPem, generateDpopKey, type DpopKey } from "./dpop.js";

export const CONTROLLER_CLIENT_ID = "frely-cli-controller";
const SCOPE = "mcp:invoke offline_access";
const SERVICE = "frely-cli-controller-v1";
const TIMEOUT_MS = 15_000;

/** The exit codes of the controller commands. */
export const EXIT = { ok: 0, cli: 1, tool: 2, approval: 3, auth: 4, offline: 5, limit: 6 } as const;

/** A failure with the exit code the command ends with. */
export class ControllerError extends Error {
  constructor(message: string, readonly exitCode: number) { super(message); this.name = "ControllerError"; }
}

export interface ControllerSession {
  version: 1;
  relayUrl: string;
  mcpUrl: string;
  /** The relay device id of this computer: the connection is this computer's. */
  deviceId: string;
  privateKeyPem: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds the access token stops working. */
  expiresAt: number;
}

/** The address of FrelyMCP, the resource the controller token is for (mirrors the server: the dedicated MCP host for Frely's own sites). */
export function controllerMcpUrl(relayUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.FRELY_MCP_URL) return new URL(env.FRELY_MCP_URL).toString();
  const url = new URL(relayUrl);
  if (url.hostname === "frely.cloud" || url.hostname === "app.frely.cloud") return "https://mcp.frely.cloud/mcp";
  return `${url.origin}/mcp/devices`;
}

/**
 * Where the session lives: the OS credential store, or on a headless Linux (no Secret Service) an encrypted file whose key sits in a
 * separate state file. The file only keeps a copied vault unreadable; the same user's processes can still read both, which is why the
 * tokens are also bound to the DPoP key and why Claude Code is told not to read this folder.
 */
export function sessionStore(env: NodeJS.ProcessEnv = process.env): CredentialStore {
  const config = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const fallback = () => {
    const keyFile = resolve(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "frely", "controller.key");
    const key = async () => {
      try { return (await readFile(keyFile, "utf8")).trim(); } catch { /* Created below. */ }
      const fresh = randomBytes(32).toString("hex");
      await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
      await writeFile(keyFile, fresh + "\n", { mode: 0o600, flag: "wx" }).catch(async () => undefined);
      await chmod(keyFile, 0o600).catch(() => undefined);
      return (await readFile(keyFile, "utf8")).trim();
    };
    const vault = async () => createEncryptedCredentialStore(resolve(config, "frely", "controller-vault-v1"), await key());
    return { getPassword: async (s: string, a: string) => (await vault()).getPassword(s, a), setPassword: async (s: string, a: string, v: string) => (await vault()).setPassword(s, a, v), deletePassword: async (s: string, a: string) => (await vault()).deletePassword(s, a) } satisfies CredentialStore;
  };
  const headless = process.platform === "linux" && env.FRELY_CREDENTIAL_KEY === undefined && (env.FRELY_CREDENTIAL_STORE ?? "auto") === "auto";
  if (!headless) return credentialStore;
  const file = fallback();
  // The OS store first; only a machine without one keeps the session in the encrypted file.
  return {
    async getPassword(service, account) { return (await file.getPassword(service, account)) ?? await credentialStore.getPassword(service, account).catch(() => null); },
    async setPassword(service, account, password) {
      if (await file.getPassword(service, account) === null) { try { await credentialStore.setPassword(service, account, password); return; } catch { /* No Secret Service. */ } }
      await file.setPassword(service, account, password);
    },
    async deletePassword(service, account) { const removed = await file.deletePassword(service, account); return await credentialStore.deletePassword(service, account).catch(() => false) || removed; },
  };
}

const accountOf = (relayUrl: string, userId: string) => `${new URL(relayUrl).origin}|${userId}`;

async function ownerOf(): Promise<{ relayUrl: string; userId: string }> {
  const account = await requireLogin().catch(() => { throw new ControllerError("Not signed in. Run frely login first.", EXIT.auth); });
  return { relayUrl: account.config.relayUrl, userId: account.user.id };
}

export async function readSession(store = sessionStore()): Promise<ControllerSession | null> {
  const { relayUrl, userId } = await ownerOf();
  const raw = await store.getPassword(SERVICE, accountOf(relayUrl, userId));
  if (!raw) return null;
  const value = JSON.parse(raw) as ControllerSession;
  if (value.version !== 1 || value.relayUrl !== relayUrl) return null;
  return value;
}

async function writeSession(session: ControllerSession, store = sessionStore()): Promise<void> {
  const { userId } = await ownerOf();
  await store.setPassword(SERVICE, accountOf(session.relayUrl, userId), JSON.stringify(session));
}

export async function deleteSession(store = sessionStore()): Promise<boolean> {
  const { relayUrl, userId } = await ownerOf();
  await store.deletePassword(PENDING_SERVICE, accountOf(relayUrl, userId)).catch(() => false);
  return store.deletePassword(SERVICE, accountOf(relayUrl, userId));
}

const formHeaders = (relayUrl: string, dpop: string) => ({ "content-type": "application/x-www-form-urlencoded", origin: relayUrl, accept: "application/json", dpop });

async function tokenRequest(relayUrl: string, key: DpopKey, body: URLSearchParams): Promise<Response> {
  const url = `${relayUrl}/api/auth/oauth2/token`;
  return fetch(url, { method: "POST", headers: formHeaders(relayUrl, createDpopProof(key, { method: "POST", url })), body: body.toString(), redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
}

interface TokenPayload { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown }

function parseTokens(payload: TokenPayload): { accessToken: string; refreshToken: string; expiresAt: number } {
  if (typeof payload.access_token !== "string" || !payload.access_token.startsWith("fmcp_at_") || typeof payload.refresh_token !== "string" || typeof payload.expires_in !== "number") {
    throw new ControllerError("Frely returned an invalid controller token.", EXIT.auth);
  }
  return { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresAt: Date.now() + payload.expires_in * 1000 };
}

/** Maps a refused token request to the exit code a script can act on. */
function tokenFailure(response: Response, payload: TokenPayload): ControllerError {
  const detail = typeof payload.error_description === "string" ? payload.error_description : typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
  if (response.status === 403 && payload.error === "access_denied") return new ControllerError(detail, EXIT.limit);
  return new ControllerError(detail, EXIT.auth);
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export interface LoginOptions { notify?: (text: string) => void; openBrowser?: boolean }

/** A device-code request that was shown to the owner and not yet approved; kept so a later command can pick it up when the process that started it is gone. */
interface PendingLogin {
  version: 1;
  relayUrl: string;
  mcpUrl: string;
  deviceId: string;
  /** The key the tokens will be bound to: the approval is only usable with the key that asked for it. */
  privateKeyPem: string;
  deviceCode: string;
  userCode: string;
  link: string;
  /** Epoch milliseconds the code stops working. */
  expiresAt: number;
  intervalMs: number;
}

const PENDING_SERVICE = "frely-cli-controller-pending-v1";

async function readPending(relayUrl: string, store = sessionStore()): Promise<PendingLogin | null> {
  const { userId } = await ownerOf();
  const raw = await store.getPassword(PENDING_SERVICE, accountOf(relayUrl, userId)).catch(() => null);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PendingLogin;
    return value.version === 1 && value.relayUrl === relayUrl && value.expiresAt - 5_000 > Date.now() ? value : null;
  } catch { return null; }
}

async function writePending(pending: PendingLogin | null, relayUrl: string, store = sessionStore()): Promise<void> {
  const { userId } = await ownerOf();
  if (pending) await store.setPassword(PENDING_SERVICE, accountOf(relayUrl, userId), JSON.stringify(pending));
  else await store.deletePassword(PENDING_SERVICE, accountOf(relayUrl, userId)).catch(() => false);
}

/** Asks Frely for a device code, tells it which computer is asking (the approval page repeats that beside the address the request came from) and keeps the request. */
async function startLogin(relayUrl: string): Promise<PendingLogin> {
  const device = await ensureDevice();
  const mcpUrl = controllerMcpUrl(relayUrl);
  const key = generateDpopKey();
  const codeResponse = await fetch(`${relayUrl}/api/auth/device/code`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: relayUrl, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
    body: new URLSearchParams({ client_id: CONTROLLER_CLIENT_ID, scope: SCOPE, resource: mcpUrl }).toString(),
  });
  const code = await codeResponse.json().catch(() => ({})) as { device_code?: unknown; user_code?: unknown; verification_uri_complete?: unknown; expires_in?: unknown; interval?: unknown; error_description?: unknown };
  if (!codeResponse.ok || typeof code.device_code !== "string" || typeof code.user_code !== "string" || typeof code.verification_uri_complete !== "string") {
    throw new ControllerError(typeof code.error_description === "string" ? code.error_description : `Frely refused the controller request (HTTP ${codeResponse.status}).`, EXIT.auth);
  }
  const claim = await fetch(`${relayUrl}/api/auth/device/controller`, {
    method: "POST", headers: { "content-type": "application/json", origin: relayUrl, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({ action: "put", userCode: code.user_code, controller: { deviceId: device.deviceId, hostname: hostname(), platform: platform(), cliVersion: VERSION } }),
  });
  if (!claim.ok) throw new ControllerError(`Frely would not take this computer's details (HTTP ${claim.status}). Update Frely CLI and try again.`, EXIT.auth);
  const link = new URL(code.verification_uri_complete);
  if (link.origin !== relayUrl) throw new ControllerError("Frely returned an unexpected approval link.", EXIT.auth);
  const pending: PendingLogin = {
    version: 1, relayUrl, mcpUrl, deviceId: device.deviceId, privateKeyPem: key.privateKeyPem, deviceCode: code.device_code, userCode: code.user_code, link: link.toString(),
    expiresAt: Date.now() + (typeof code.expires_in === "number" ? code.expires_in : 900) * 1000, intervalMs: (typeof code.interval === "number" ? code.interval : 5) * 1000,
  };
  await writePending(pending, relayUrl);
  return pending;
}

const approvalNotice = (pending: PendingLogin) => `Approve this computer to control your Frely devices.\nCode: ${pending.userCode}\nOpen: ${pending.link}\n(You will be asked to type the code and confirm with a passkey or authenticator code.)\n`;

/**
 * Trades the approved device code for tokens, once or until the code expires. Returns null when `wait` is false and the owner has not
 * decided yet; an expired or denied request is forgotten and throws.
 */
async function pollLogin(pending: PendingLogin, wait: boolean): Promise<ControllerSession | null> {
  const key = dpopKeyFromPem(pending.privateKeyPem);
  let interval = pending.intervalMs;
  while (Date.now() < pending.expiresAt) {
    if (wait) await delay(interval);
    const response = await tokenRequest(pending.relayUrl, key, new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: pending.deviceCode, client_id: CONTROLLER_CLIENT_ID, resource: pending.mcpUrl, controller_device_id: pending.deviceId,
    }));
    const payload = await response.json().catch(() => ({})) as TokenPayload;
    if (response.ok) {
      const session: ControllerSession = { version: 1, relayUrl: pending.relayUrl, mcpUrl: pending.mcpUrl, deviceId: pending.deviceId, privateKeyPem: pending.privateKeyPem, ...parseTokens(payload) };
      await writeSession(session);
      await writePending(null, pending.relayUrl);
      return session;
    }
    if (payload.error === "authorization_pending" || payload.error === "slow_down") {
      if (payload.error === "slow_down") interval += 5000;
      if (!wait) return null;
      continue;
    }
    await writePending(null, pending.relayUrl);
    if (payload.error === "expired_token") throw new ControllerError("The approval request expired. Run the command again.", EXIT.auth);
    if (payload.error === "access_denied" && response.status !== 403) throw new ControllerError("The request was denied.", EXIT.auth);
    throw tokenFailure(response, payload);
  }
  await writePending(null, pending.relayUrl);
  throw new ControllerError("The approval request expired. Run the command again.", EXIT.auth);
}

/**
 * Signs this computer in as a controller: a device-code authorization the owner approves in a browser (with a passkey or authenticator code),
 * which issues tokens bound to a new key kept here. Waits for the approval and takes it by itself; a request an earlier command left
 * unapproved is continued instead of asking for a new code.
 */
export async function controllerLogin(options: LoginOptions = {}): Promise<ControllerSession> {
  const notify = options.notify ?? ((text: string) => { process.stderr.write(text); });
  const { relayUrl } = await ownerOf();
  const pending = await readPending(relayUrl) ?? await startLogin(relayUrl);
  notify(approvalNotice(pending));
  if (options.openBrowser !== false && process.env.FRELY_NO_BROWSER !== "1") openVerificationUrl(pending.link);
  return (await pollLogin(pending, true))!;
}

/**
 * The sign-in for a command nobody can type into (a script, an AI tool): never waits. It picks up an approval the owner has given since the last
 * run; otherwise it shows the approval link and ends with the "approval needed" exit code, and the same command run again continues from the same request.
 */
export async function requestControllerLogin(): Promise<ControllerSession> {
  const { relayUrl } = await ownerOf();
  const pending = await readPending(relayUrl) ?? await startLogin(relayUrl);
  const session = await pollLogin(pending, false);
  if (session) return session;
  throw new ControllerError(`${approvalNotice(pending)}After approving, run the same command again. To wait for the approval instead: frely controller login\n`, EXIT.approval);
}

/** Exchanges the refresh token; a session that another process already renewed is taken from the store instead of spent twice. */
export async function refreshSession(session: ControllerSession): Promise<ControllerSession> {
  const key = dpopKeyFromPem(session.privateKeyPem);
  const response = await tokenRequest(session.relayUrl, key, new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken, client_id: CONTROLLER_CLIENT_ID, resource: session.mcpUrl }));
  const payload = await response.json().catch(() => ({})) as TokenPayload;
  if (!response.ok) {
    const stored = await readSession().catch(() => null);
    if (stored && stored.refreshToken !== session.refreshToken) return stored;
    if (payload.error === "invalid_grant") await deleteSession().catch(() => false);
    throw new ControllerError("This computer's controller authorization has ended. Run the command again to approve it in your browser.", EXIT.auth);
  }
  const next: ControllerSession = { ...session, ...parseTokens(payload) };
  await writeSession(next);
  return next;
}

/** Signs the controller session out: revokes the refresh token on the server (the connection stays listed until disconnected on the web) and forgets it here. */
export async function controllerLogout(): Promise<boolean> {
  const session = await readSession();
  if (!session) return false;
  const key = dpopKeyFromPem(session.privateKeyPem);
  const url = `${session.relayUrl}/api/auth/oauth2/revoke`;
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: session.relayUrl, dpop: createDpopProof(key, { method: "POST", url }) }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
    body: new URLSearchParams({ client_id: CONTROLLER_CLIENT_ID, token: session.refreshToken, token_type_hint: "refresh_token" }).toString(),
  }).catch(() => null);
  if (!response?.ok) throw new ControllerError("The controller authorization could not be revoked. Try again, or disconnect this computer in My Devices on the web.", EXIT.auth);
  await deleteSession();
  return true;
}
