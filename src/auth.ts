import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { basicCredentialStore as credentialStore, BASIC_CREDENTIAL_BACKEND } from "./credential-basic.js";

export const SERVICE = "frely-cli-basic-v1";
const SESSION_COOKIE_NAME = "friday_session_token";
export const CONFIG_VERSION = 3;
const LEGACY_CONFIG_VERSION = 1;
const OAUTH_CLIENT_ID = "frely-cli-basic";
const OAUTH_SCOPE = "openid profile profile:read email offline_access device-relay:provider cloud:read mcp:invoke gateway:invoke";

// One login, three audiences: the API resource for account/device calls, the Cloud resource for read-only Cloud tools (frely item install,
// frely api list), and this machine's FreyMCP connection (device tools, Cloud writes) — all approved by the single `frely login`.
function appendLoginResources(body: URLSearchParams, relayUrl: string): void {
  body.append("resource", `${relayUrl}/api`);
  body.append("resource", `${relayUrl}/mcp`);
  body.append("resource", frelyMcpUrl(relayUrl));
}

/** The address of FreyMCP, the resource the machine's side token is for (mirrors the server: the dedicated MCP host for Frely's own sites). */
export function frelyMcpUrl(relayUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.FRELY_MCP_URL) return new URL(env.FRELY_MCP_URL).toString();
  const url = new URL(relayUrl);
  if (url.hostname === "frely.cloud" || url.hostname === "app.frely.cloud") return "https://mcp.frely.cloud/mcp";
  return `${url.origin}/mcp/devices`;
}
const FRELY_MCP_TOKEN_FIELD = "frely_mcp_token";
/** Set by the relay when the account has no free slot for this computer to sign in as a controller; the login itself still succeeds. */
const FRELY_CONTROLLER_STATUS_FIELD = "frely_controller_status";
const DEFAULT_RELAY = "https://frely.cloud";
// app.frely.cloud now belongs to the Frely App; logins saved against it move to frely.cloud (see currentRelayConfig).
const RETIRED_RELAY_HOSTNAME = "app.frely.cloud";
const REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_ATTEMPTS = 3;
const REFRESH_RETRY_BASE_MS = 500;

function debugAuth(message: string): void {
  if (process.env.FRELY_DEBUG === "1") process.stderr.write(`[debug] auth ${message}\n`);
}

export interface PublicUser {
  id: string;
  email: string;
  name?: string | null;
  /** Public Frely username, when the profile endpoint reports one. */
  username?: string;
}

interface CliConfig {
  version: number;
  relayUrl: string;
  user: PublicUser;
  deviceId?: string;
}

export interface AuthCredential {
  scheme: "bearer" | "cookie";
  value: string;
  refreshToken?: string;
  expiresAt?: number;
  /** Bound Frely CLI session id returned by the Relay when per-device sessions are supported. */
  sessionBindingId?: string;
  /** This machine's FreyMCP side token, minted beside the login access token by the same device-code approval. */
  mcpToken?: string;
}

const SESSION_BINDING_DEVICE_ID_PARAM = "session_binding_device_id";
const SESSION_BINDING_ID_FIELD = "frely_cli_session_id";
const LOCAL_DEVICE_ID_PREFIX = "frd_local_";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface StoredOAuthCredential {
  version: 1;
  type: "basic-oauth";
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  /** Bound Frely CLI session id, when the Relay supported per-device sessions at issue time. */
  sessionBindingId?: string;
  /** This machine's FreyMCP side token; expires with the login access token and is replaced on every refresh. */
  mcpToken?: string;
}

export interface AuthSnapshot {
  configured: boolean;
  relayUrl?: string;
  user?: PublicUser;
  credentialStored: boolean;
  credentialBackend?: string;
  credentialError?: string;
  configPath: string;
  configMode?: number;
  authMethod?: "bearer" | "cookie";
}

export function authConfigPath(): string {
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(root, "frely", "config.json");
}

export function accountKey(relayUrl: string): string {
  return new URL(relayUrl).origin;
}

export function normalizeRelayUrl(value?: string): string {
  const url = new URL(value || process.env.FRELY_RELAY_URL || DEFAULT_RELAY);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
    throw new Error("Frely Relay must use HTTPS outside loopback development.");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

/** Device authorization is the default. The 3-argument form remains only for old callers/tests. */
export async function login(relayOrEmail?: string, legacyPassword?: string, legacyRelayInput?: string): Promise<PublicUser> {
  if (legacyPassword !== undefined) throw new Error("Password/cookie login is not supported by basic storage. Run `frely login` for a restricted session.");
  return (await loginDevice(relayOrEmail)).user;
}

/**
 * Email-based device authorization (two-step for CLI).
 * Step 1: initEmailDeviceLogin() sends code to email, returns challenge and device code.
 * Step 2: completeEmailDeviceLogin() verifies code, issues token.
 */
export interface EmailDeviceChallenge {
  challengeId: string;
  userCode: string;
  deviceCode: string;
  email: string;
  expiresIn: number;
  /** Short tag shown in the code mail, so the user can pick the right (latest) mail. Not part of the code. */
  reference?: string;
  /** The install this sign-in also confirms: the code mail names it, and entering the code is the owner's approval of exactly that install. */
  install?: { name: string; gift?: string };
  /** When the code mail was sent (ms), so a later run can tell whether this challenge is still alive. */
  savedAt?: number;
  /** The address as typed (the server only returns it masked), to tell whether a later run asks for the same sign-in. */
  emailInput?: string;
}

/** How long a command waits for the emailed code or its link: the mail code's lifetime. */
export const EMAIL_WAIT_SECONDS = 600;

export class EmailLoginTimeout extends Error {
  constructor() { super("The emailed code was not used in time. Run the same command again; it sends a new email."); this.name = "EmailLoginTimeout"; }
}

function emailChallengeSecondsLeft(challenge: EmailDeviceChallenge): number {
  const total = Math.min(EMAIL_WAIT_SECONDS, challenge.expiresIn);
  return typeof challenge.savedAt === "number" ? total - Math.floor((Date.now() - challenge.savedAt) / 1000) : 0;
}

/**
 * Sends a code mail, or reuses the pending one when it is still alive and asks for the same address and install
 * (a host that kills a long foreground command can run it again without a second email).
 */
export async function startOrResumeEmailLogin(relayInput: string, email: string, invite?: string, install?: { name: string; gift?: string }): Promise<{ challenge: EmailDeviceChallenge; resumed: boolean }> {
  const relayUrl = normalizeRelayUrl(relayInput);
  const input = email.trim().toLowerCase();
  const pending = await readPendingEmailChallenge(relayUrl);
  if (pending && pending.emailInput === input && JSON.stringify(pending.install ?? null) === JSON.stringify(install ?? null) && emailChallengeSecondsLeft(pending) > 5) {
    return { challenge: pending, resumed: true };
  }
  const challenge = await initEmailDeviceLogin(relayUrl, email, invite, install);
  const saved = { ...challenge, savedAt: Date.now(), emailInput: input };
  await savePendingEmailChallenge(relayUrl, saved);
  return { challenge: saved, resumed: false };
}

/** Waits until the code was entered (here with `login --code`, or on the page the mail links to), then stores the sign-in. */
export async function waitEmailDeviceLogin(relayInput: string, challenge: EmailDeviceChallenge): Promise<{ user: PublicUser; sessionBound: boolean }> {
  const relayUrl = normalizeRelayUrl(relayInput);
  const left = emailChallengeSecondsLeft(challenge);
  if (left <= 0) throw new EmailLoginTimeout();
  const deviceId = localDeviceId((await readConfig().catch(() => null))?.deviceId);
  try {
    const result = await finishDeviceLogin(relayUrl, { ...challenge, expiresIn: left }, deviceId);
    await deletePendingEmailChallenge(relayUrl);
    return result;
  } catch (error) {
    if (error instanceof Error && /expired/u.test(error.message)) throw new EmailLoginTimeout();
    throw error;
  }
}

/** Device MCP request prepared before an install token is redeemed; `privateKeyPem` never leaves this machine. */
export interface DeviceMcpRequest { privateKeyPem: string; keyThumbprint: string; workspace: string; days: number }

export async function initEmailDeviceLogin(
  relayInput: string,
  email: string,
  invite?: string,
  install?: { name: string; gift?: string },
): Promise<EmailDeviceChallenge> {
  const relayUrl = normalizeRelayUrl(relayInput);
  await probeCredentialStore();

  const device = await requestDeviceCode(relayUrl);
  const userCode = device.user_code;
  const deviceCode = device.device_code;
  const expiresIn = device.expires_in;

  // Then, initiate email verification with the user code
  const response = await fetch(`${relayUrl}/api/auth/device/email/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, userCode, ...(invite ? { invite } : {}), ...(install ? { install } : {}) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const message = typeof body.message === "string" ? body.message : `Failed to send verification code (${response.status})`;
    throw new Error(message);
  }

  const data = await response.json() as Record<string, unknown>;
  if (typeof data.challengeId !== "string") {
    throw new Error("Invalid response from verification endpoint");
  }

  return {
    challengeId: data.challengeId as string,
    userCode,
    deviceCode,
    email: typeof data.email === "string" ? data.email : email,
    expiresIn: expiresIn,
    ...(typeof data.reference === "string" ? { reference: data.reference } : {}),
    ...(install ? { install } : {}),
  };
}

export async function completeEmailDeviceLogin(
  relayInput: string,
  challenge: EmailDeviceChallenge,
  code: string,
): Promise<{ user: PublicUser; sessionBound: boolean }> {
  const relayUrl = normalizeRelayUrl(relayInput);

  const response = await fetch(`${relayUrl}/api/auth/device/email/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userCode: challenge.userCode,
      challengeId: challenge.challengeId,
      code,
      ...(challenge.install ? { install: challenge.install } : {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const message = typeof body.message === "string" ? body.message : `Verification failed (${response.status})`;
    throw new Error(message);
  }

  const data = await response.json() as Record<string, unknown>;
  if (typeof data.user !== "object" || data.user === null) {
    throw new Error("Invalid user in response");
  }

  const user = data.user as Record<string, unknown>;
  if (typeof user.id !== "string" || typeof user.email !== "string") {
    throw new Error("Invalid user data in response");
  }

  const publicUser: PublicUser = {
    id: user.id,
    email: user.email,
    name: typeof user.name === "string" ? user.name : null,
  };

  // After email verification, device code has been approved
  // Caller should poll /oauth2/token to get access token
  return { user: publicUser, sessionBound: false };
}

/**
 * Pre-login install command: a one-time install token gets this CLI's own device code approved, like
 * the email code does. The token is not a credential and is never stored; the caller polls with finishDeviceLogin.
 */
export async function redeemInstallToken(
  relayInput: string | undefined,
  token: string,
  mcp?: DeviceMcpRequest,
): Promise<{ relayUrl: string; device: DeviceCodeResponse; user: PublicUser; mcpPreapproval?: string }> {
  const relayUrl = normalizeRelayUrl(relayInput);
  await probeCredentialStore();
  const unreachable = (error: unknown): never => {
    if (error instanceof TypeError || (error instanceof Error && error.message === "Frely request timed out.")) {
      throw new Error(`Could not reach ${new URL(relayUrl).host}. Check this computer's internet connection (and proxy settings), then run the install command again.`);
    }
    throw error;
  };
  const device = await requestDeviceCode(relayUrl).catch(unreachable);
  const response = await fetchWithTimeout(`${relayUrl}/api/auth/device/install/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: relayUrl, accept: "application/json" },
    body: JSON.stringify({
      token,
      userCode: device.user_code,
      ...(mcp ? { mcp: { keyThumbprint: mcp.keyThumbprint, workspace: mcp.workspace, days: mcp.days } } : {}),
    }),
    redirect: "error",
  }).catch(unreachable);
  const payload = await safeJson(response);
  debugAuth(`stage=install-redeem status=${response.status}`);
  if (!response.ok) throw new Error(installTokenError(payload, response.status));
  const record = objectPayload(payload, "install command");
  const user = parseUser(record);
  return { relayUrl, device, user, ...(isString(record.mcpPreapproval) ? { mcpPreapproval: record.mcpPreapproval } : {}) };
}

/**
 * Asks the server to show a device MCP request on the approval page for this device code, so one browser approval signs the CLI in
 * and enables device MCP. False when the server does not support it (older deployment) or refuses; the caller then uses the separate MCP approval.
 */
export async function attachDeviceCodeMcp(relayUrl: string, userCode: string, mcp: { keyThumbprint: string; workspace: string; days: number }): Promise<boolean> {
  const response = await fetchWithTimeout(`${relayUrl}/api/auth/device/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: relayUrl, accept: "application/json" },
    body: JSON.stringify({ action: "put", userCode, mcp }),
    redirect: "error",
  }).catch(() => null);
  debugAuth(`stage=device-code-mcp-put status=${response?.status ?? "none"}`);
  return response?.ok === true;
}

/** Every install-token failure names the next step. */
export function installTokenError(payload: unknown, status: number): string {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const error = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : {};
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" && error.message ? error.message.replace(/\s*$/u, "") : `Frely rejected the install command (HTTP ${status}).`;
  const sentence = /[.!?]$/u.test(message) ? message : `${message}.`;
  if (code === "install_token_invalid") return `${sentence} The install command is invalid, expired or already used. Ask Claude (or the Frely console) for a new install command and run it again.`;
  if (status === 429 || /rate/u.test(code)) return `${sentence} Wait a few minutes, then ask Claude (or the Frely console) for a new install command if this one has expired.`;
  return `${sentence} Ask Claude (or the Frely console) for a new install command and run it again.`;
}

export async function loginDevice(
  relayInput?: string,
  notify?: (details: { verificationUri: string; userCode: string }) => void,
  options: { openBrowser?: boolean; /** Runs after the device code exists and before the link is shown, e.g. to attach a device MCP request to it. */ beforeNotify?: (details: { relayUrl: string; userCode: string }) => Promise<void> } = {},
): Promise<{ user: PublicUser; verificationUri: string; userCode: string; sessionBound: boolean }> {
  const relayUrl = normalizeRelayUrl(relayInput);
  await probeCredentialStore();
  const deviceId = localDeviceId((await readConfig().catch(() => null))?.deviceId);
  const device = await requestDeviceCode(relayUrl);
  await savePendingDeviceLogin(relayUrl, device);
  await options.beforeNotify?.({ relayUrl, userCode: device.user_code });
  // One approval link format everywhere (`/device?g=<eight letters>`), built from the relay's own verification page so a stale
  // server response cannot reintroduce another format.
  const approvalLink = new URL(device.verification_uri);
  approvalLink.searchParams.set("g", device.user_code);
  const verificationUri = validateVerificationUrl(approvalLink.toString(), relayUrl);
  notify?.({ verificationUri, userCode: device.user_code });
  if (options.openBrowser !== false) openVerificationUrl(verificationUri);
  const { user, sessionBound } = await finishDeviceLogin(relayUrl, device, deviceId);
  await deletePendingDeviceLogin();
  return { user, verificationUri, userCode: device.user_code, sessionBound };
}

/** Continues a browser login whose process ended before the owner approved (an agent shell can kill it): waits on the saved device code until it expires. */
export async function resumeDeviceLogin(relayInput?: string): Promise<{ user: PublicUser; sessionBound: boolean } | null> {
  const relayUrl = normalizeRelayUrl(relayInput);
  const pending = await readPendingDeviceLogin(relayUrl);
  if (!pending) return null;
  const deviceId = localDeviceId((await readConfig().catch(() => null))?.deviceId);
  const result = await finishDeviceLogin(relayUrl, { ...pending.device, expires_in: Math.max(1, pending.device.expires_in - Math.floor((Date.now() - pending.savedAt) / 1000)) }, deviceId);
  await deletePendingDeviceLogin();
  return result;
}

/** Poll the approved device code, then store the credentials and the signed-in user. */
export async function finishDeviceLogin(relayUrl: string, device: DeviceCodeResponse | EmailDeviceChallenge, deviceId: string): Promise<{ user: PublicUser; sessionBound: boolean }> {
  const token = await pollDeviceToken(relayUrl, device, deviceId);
  const user = await fetchUser(relayUrl, { scheme: "bearer", value: token.accessToken, ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}), expiresAt: token.expiresAt, ...(token.sessionBindingId ? { sessionBindingId: token.sessionBindingId } : {}), ...(token.mcpToken ? { mcpToken: token.mcpToken } : {}) });
  const key = accountKey(relayUrl);
  await credentialStore.setPassword(SERVICE, key, JSON.stringify({
    version: 1,
    type: "basic-oauth",
    accessToken: token.accessToken,
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    expiresAt: token.expiresAt,
    ...(token.sessionBindingId ? { sessionBindingId: token.sessionBindingId } : {}),
    ...(token.mcpToken ? { mcpToken: token.mcpToken } : {}),
  } satisfies StoredOAuthCredential));
  try {
    await writeConfig({ version: CONFIG_VERSION, relayUrl, user, deviceId });
  } catch (error) {
    await credentialStore.deletePassword(SERVICE, key).catch(() => false);
    throw error;
  }
  return { user, sessionBound: Boolean(token.sessionBindingId) };
}

/**
 * A stable local device identifier used to bind OAuth sessions to this machine.
 * It is generated once and persisted in the CLI config so re-login reuses the
 * same id, enabling per-device session management on Relay versions that support it.
 */
export function localDeviceId(existing?: string | null): string {
  if (typeof existing === "string" && existing.length > 0) return existing;
  return LOCAL_DEVICE_ID_PREFIX + randomUUID().replace(/-/g, "");
}

function appendSessionBinding(body: URLSearchParams, deviceId?: string | null): void {
  if (typeof deviceId === "string" && deviceId.length > 0) {
    body.set(SESSION_BINDING_DEVICE_ID_PARAM, deviceId);
  }
}

export async function whoami(): Promise<PublicUser> {
  const config = await currentRelayConfig(await readConfig());
  const credential = await loadCredential(config, true);
  if (!credential) throw new Error("No Frely login is stored. Run `frely login`.");
  const user = await fetchUser(config.relayUrl, credential);
  if (config.version !== CONFIG_VERSION || user.id !== config.user.id || user.email !== config.user.email || user.name !== config.user.name || user.username !== config.user.username) {
    await writeConfig({ ...config, user });
  }
  return user;
}

export async function requireLogin(): Promise<{ config: { relayUrl: string }; user: PublicUser; credential: AuthCredential; cookie?: string }> {
  const config = await currentRelayConfig(await readConfig());
  const credential = await loadCredential(config, true);
  if (!credential) throw new Error("No Frely login is stored. Run `frely login`.");
  const user = await fetchUser(config.relayUrl, credential).catch((error) => {
    if (error instanceof Error && error.message === "Frely login expired. Run `frely login`.") throw error;
    throw error;
  });
  if (config.version !== CONFIG_VERSION || user.id !== config.user.id || user.email !== config.user.email || user.name !== config.user.name || user.username !== config.user.username) await writeConfig({ ...config, version: CONFIG_VERSION, user });
  return { config: { relayUrl: config.relayUrl }, user, credential, ...(credential.scheme === "cookie" ? { cookie: credential.value } : {}) };
}

export async function logout(): Promise<void> {
  const config = await readConfig().catch(() => null);
  if (!config) {
    await unlink(authConfigPath()).catch(() => undefined);
    return;
  }
  const key = accountKey(config.relayUrl);
  unsavedRefresh.delete(key);
  const credential = await loadCredential(config, false);
  if (credential?.scheme === "cookie") {
    await fetchWithTimeout(`${config.relayUrl}/api/auth/logout`, {
      method: "POST", headers: { cookie: credential.value, origin: config.relayUrl, "content-type": "application/json" }, body: "{}", redirect: "error",
    }).catch(() => undefined);
  } else if (credential?.scheme === "bearer") {
    // The machine's binding rides along, so revoking this login disconnects only this computer's FreyMCP connection, not the user's other machines.
    const revoke = async (token: string, hint: string) => {
      const body = new URLSearchParams({ client_id: OAUTH_CLIENT_ID, token, token_type_hint: hint });
      appendSessionBinding(body, config.deviceId);
      return fetchWithTimeout(`${config.relayUrl}/api/auth/oauth2/revoke`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: config.relayUrl },
        body: body.toString(), redirect: "error",
      }).catch(() => undefined);
    };
    await revoke(credential.value, "access_token");
    if (credential.refreshToken) await revoke(credential.refreshToken, "refresh_token");
  }
  await credentialStore.deletePassword(SERVICE, key);
  await unlink(authConfigPath()).catch(() => undefined);
}

export async function inspectAuth(): Promise<AuthSnapshot> {
  const path = authConfigPath();
  let credentialBackend = "unavailable";
  let credentialError: string | undefined;
  try { credentialBackend = BASIC_CREDENTIAL_BACKEND; }
  catch (error) { credentialError = error instanceof Error ? error.message : "Credential store configuration failed."; }
  const config = await readConfig().catch(() => null);
  if (!config) return { configured: false, credentialStored: false, configPath: path, credentialBackend, ...(credentialError ? { credentialError } : {}) };
  const raw = await credentialStore.getPassword(SERVICE, accountKey(config.relayUrl)).catch((error: unknown) => {
    credentialError = error instanceof Error ? error.message : "Credential store access failed.";
    return null;
  });
  const credentialStored = Boolean(raw);
  const fileStat = await stat(path).catch(() => null);
  const storedCredential = credentialStored ? await loadCredential(config, false, raw) : null;
  return {
    configured: true,
    relayUrl: config.relayUrl,
    user: config.user,
    credentialStored,
    credentialBackend,
    ...(credentialError ? { credentialError } : {}),
    ...(storedCredential ? { authMethod: storedCredential.scheme } : {}),
    configPath: path,
    ...(fileStat ? { configMode: fileStat.mode & 0o777 } : {}),
  };
}

/**
 * Return whether a local credential is configured for the selected Relay.
 * This deliberately performs no expiry, scope, refresh, or remote validity
 * check. It is the only signal the Skill invocation router uses to choose the
 * remote Agent MCP path.
 */
export async function hasConfiguredLocalToken(relayInput?: string): Promise<boolean> {
  const relayUrl = normalizeRelayUrl(relayInput);
  const raw = await credentialStore.getPassword(SERVICE, accountKey(relayUrl));
  return typeof raw === "string" && raw.length > 0;
}

/** Load a configured credential without refreshing or validating it remotely. */
export async function readConfiguredLocalCredential(relayInput?: string): Promise<AuthCredential | null> {
  const relayUrl = normalizeRelayUrl(relayInput);
  const raw = await credentialStore.getPassword(SERVICE, accountKey(relayUrl));
  if (!raw) return null;
  if (raw.startsWith(`${SESSION_COOKIE_NAME}=`)) throw new Error("Legacy credentials require a new basic login.");
  try {
    const stored = JSON.parse(raw) as Partial<StoredOAuthCredential>;
    if (stored.version !== 1 || stored.type !== "basic-oauth" || !isString(stored.accessToken)) {
      throw new Error("Basic credential is invalid. Run `frely login`.");
    }
    return {
      scheme: "bearer",
      value: stored.accessToken,
      ...(isString(stored.refreshToken) ? { refreshToken: stored.refreshToken } : {}),
      ...(typeof stored.expiresAt === "number" ? { expiresAt: stored.expiresAt } : {}),
      ...(isString(stored.sessionBindingId) ? { sessionBindingId: stored.sessionBindingId } : {}),
    };
  } catch {
    // Presence remains the routing signal. The remote adapter will surface a
    // stable authorization failure for an unreadable configured credential.
    throw new Error("Basic credential is invalid. Run `frely login`.");
  }
}

export async function probeCredentialStore(): Promise<void> {
  const account = `doctor:${randomUUID()}`;
  const value = randomUUID();
  await credentialStore.setPassword(SERVICE, account, value);
  try {
    if (await credentialStore.getPassword(SERVICE, account) !== value) throw new Error("Credential store readback failed.");
  } finally {
    if (!await credentialStore.deletePassword(SERVICE, account)) throw new Error("Credential store deletion failed.");
  }
}

/**
 * A login saved against the retired relay host moves to frely.cloud: the stored credential is copied under the new
 * account key and the config rewritten. If frely.cloud rejects it, the caller reports an expired login as usual,
 * so a background service never fails on the host name alone.
 */
async function currentRelayConfig(config: CliConfig): Promise<CliConfig> {
  if (new URL(config.relayUrl).hostname !== RETIRED_RELAY_HOSTNAME) return config;
  const raw = await credentialStore.getPassword(SERVICE, accountKey(config.relayUrl)).catch(() => null);
  if (!raw) throw new Error("Frely moved to https://frely.cloud. Run `frely login` again.");
  const relayUrl = normalizeRelayUrl(DEFAULT_RELAY);
  await credentialStore.setPassword(SERVICE, accountKey(relayUrl), raw);
  const migrated = { ...config, relayUrl };
  await writeConfig(migrated);
  await credentialStore.deletePassword(SERVICE, accountKey(config.relayUrl)).catch(() => false);
  return migrated;
}

export async function readConfig(): Promise<CliConfig> {
  const raw = await readFile(authConfigPath(), "utf8").catch(() => null);
  if (!raw) throw new Error("No Frely login is configured. Run `frely login`.");
  let value: Partial<CliConfig>;
  try {
    value = JSON.parse(raw) as Partial<CliConfig>;
  } catch {
    throw new Error("Frely CLI configuration is invalid.");
  }
  if (value.version !== CONFIG_VERSION && value.version !== 2 && value.version !== LEGACY_CONFIG_VERSION) throw new Error("Frely CLI configuration is invalid.");
  if (typeof value.relayUrl !== "string" || !value.user || typeof value.user.id !== "string" || typeof value.user.email !== "string") {
    throw new Error("Frely CLI configuration is invalid.");
  }
  return value as CliConfig;
}

async function requestDeviceCode(relayUrl: string): Promise<DeviceCodeResponse> {
  const codeBody = new URLSearchParams({ client_id: OAUTH_CLIENT_ID, scope: OAUTH_SCOPE });
  appendLoginResources(codeBody, relayUrl);
  const response = await fetchWithTimeout(`${relayUrl}/api/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: relayUrl, accept: "application/json" },
    body: codeBody.toString(),
    redirect: "error",
  });
  const payload = await safeJson(response);
  debugAuth(`stage=device-code status=${response.status}`);
  if (!response.ok) throw new Error(publicError(payload, response.status));
  const record = objectPayload(payload, "device authorization");
  if (!isString(record.device_code) || !isString(record.user_code) || !isString(record.verification_uri) || !isString(record.verification_uri_complete)) throw new Error("Frely returned an invalid device authorization response.");
  const expiresIn = numberPayload(record.expires_in, 1, 86_400);
  const interval = numberPayload(record.interval, 1, 300);
  return { device_code: record.device_code, user_code: record.user_code, verification_uri: record.verification_uri, verification_uri_complete: record.verification_uri_complete, expires_in: expiresIn, interval };
}

export async function pollDeviceToken(
  relayUrl: string,
  device: DeviceCodeResponse | EmailDeviceChallenge,
  deviceId?: string | null,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number; sessionBindingId?: string; mcpToken?: string }> {
  // Support both DeviceCodeResponse and EmailDeviceChallenge
  const deviceCode = "device_code" in device ? device.device_code : device.deviceCode;
  const expiresIn = "expires_in" in device ? device.expires_in : device.expiresIn;
  const interval = "interval" in device ? device.interval : 5;

  const deadline = Date.now() + expiresIn * 1000;
  let intervalMs = interval * 1000;
  while (Date.now() < deadline) {
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: OAUTH_CLIENT_ID });
    appendLoginResources(body, relayUrl);
    appendSessionBinding(body, deviceId);
    const response = await fetchWithTimeout(`${relayUrl}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: relayUrl, accept: "application/json" },
      body: body.toString(),
      redirect: "error",
    });
    const payload = await safeJson(response);
    debugAuth(`stage=token status=${response.status}`);
    const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    if (response.ok && isString(record.access_token) && (!record.token_type || String(record.token_type).toLowerCase() === "bearer")) {
      const expiresInSeconds = numberPayload(record.expires_in, 1, 86_400);
      // Not an error: the computer works as a controlled device. It connects as a controller on a later sign-in once a slot is free.
      if (record[FRELY_CONTROLLER_STATUS_FIELD] === "slots_full") process.stderr.write("This computer is signed in, but your account has no free slot for it to act as a controller. Disconnect a device or controller in the Frely web console, or upgrade your plan, then run `frely login` again.\n");
      return { accessToken: record.access_token, ...(isString(record.refresh_token) ? { refreshToken: record.refresh_token } : {}), expiresAt: Date.now() + expiresInSeconds * 1000, ...(isString(record[SESSION_BINDING_ID_FIELD]) ? { sessionBindingId: record[SESSION_BINDING_ID_FIELD] as string } : {}), ...(isString(record[FRELY_MCP_TOKEN_FIELD]) ? { mcpToken: record[FRELY_MCP_TOKEN_FIELD] as string } : {}) };
    }
    const errorCode = typeof record.error === "string" ? record.error : "";
    if (errorCode === "authorization_pending") {
      await delay(intervalMs);
      continue;
    }
    if (errorCode === "slow_down") {
      intervalMs += 5_000;
      await delay(intervalMs);
      continue;
    }
    if (errorCode === "access_denied") throw new Error("Frely device authorization was denied.");
    if (errorCode === "expired_token") throw new Error("Frely device authorization expired. Run `frely login` again.");
    throw new Error(publicError(payload, response.status));
  }
  throw new Error("Frely device authorization expired. Run `frely login` again.");
}

async function fetchUser(relayUrl: string, credential: AuthCredential): Promise<PublicUser> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (credential.scheme === "cookie") headers.cookie = credential.value;
  else headers.authorization = `Bearer ${credential.value}`;
  const response = await fetchWithTimeout(`${relayUrl}/api/auth/me`, { headers, redirect: "error" });
  const payload = await safeJson(response);
  debugAuth(`stage=profile status=${response.status} shape=${payloadShape(payload)}`);
  if (!response.ok) {
    if (response.status === 401) throw new Error("Frely login expired. Run `frely login`.");
    throw new Error(publicError(payload, response.status));
  }
  return parseUser(payload);
}

async function loadCredential(config: CliConfig, refresh: boolean, input?: string | null): Promise<AuthCredential | null> {
  const raw = input === undefined ? await credentialStore.getPassword(SERVICE, accountKey(config.relayUrl)) : input;
  if (!raw) return null;
  if (raw.startsWith(`${SESSION_COOKIE_NAME}=`)) throw new Error("Legacy credentials require a new basic login.");
  let stored: Partial<StoredOAuthCredential>;
  try {
    stored = JSON.parse(raw) as Partial<StoredOAuthCredential>;
  } catch {
    return null;
  }
  if (stored.version !== 1 || stored.type !== "basic-oauth" || !isString(stored.accessToken) || typeof stored.expiresAt !== "number") return null;
  if (refresh && stored.refreshToken && stored.expiresAt <= Date.now() + 30_000) {
    // Refresh failures propagate: a network outage must not read as "No Frely login is stored".
    return await refreshStoredCredential(config, stored as StoredOAuthCredential, false);
  }
  return { scheme: "bearer", value: stored.accessToken, ...(stored.refreshToken ? { refreshToken: stored.refreshToken } : {}), expiresAt: stored.expiresAt, ...(stored.sessionBindingId ? { sessionBindingId: stored.sessionBindingId } : {}), ...(stored.mcpToken ? { mcpToken: stored.mcpToken } : {}) };
}

export const LOGIN_REFRESH_UNAVAILABLE = "Frely login refresh is temporarily unavailable; retrying later.";

class TransientRefreshError extends Error {
  constructor() {
    super(LOGIN_REFRESH_UNAVAILABLE);
    this.name = "Error";
  }
}

// Short retry for network errors, timeouts, 408/429 and 5xx; a rejected refresh token fails at once.
async function refreshOAuthCredential(relayUrl: string, refreshToken: string, deviceId?: string | null): Promise<AuthCredential> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await refreshOAuthCredentialOnce(relayUrl, refreshToken, deviceId);
    } catch (error) {
      if (!(error instanceof TransientRefreshError) || attempt >= REFRESH_ATTEMPTS) throw error;
      debugAuth(`stage=refresh attempt=${attempt} transient=1`);
      await delay(REFRESH_RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }
}

async function refreshOAuthCredentialOnce(relayUrl: string, refreshToken: string, deviceId?: string | null): Promise<AuthCredential> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: OAUTH_CLIENT_ID });
  appendLoginResources(body, relayUrl);
  appendSessionBinding(body, deviceId);
  let status: number;
  let payload: unknown;
  try {
    // The body is read under the same timeout: a response cut off half-way (the server has already rotated the token) must not hang.
    ({ status, payload } = await fetchJsonWithTimeout(`${relayUrl}/api/auth/oauth2/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: relayUrl, accept: "application/json" },
      body: body.toString(), redirect: "error",
    }));
  } catch (error) {
    debugAuth(`stage=refresh fetch_failed=${error instanceof Error ? `${error.name}:${(error.cause as { code?: string } | undefined)?.code ?? error.message}` : "unknown"}`);
    throw new TransientRefreshError();
  }
  if (status === 408 || status === 429 || status >= 500) {
    debugAuth(`stage=refresh status=${status}`);
    throw new TransientRefreshError();
  }
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  // Only the OAuth server itself saying no (400/401 with an OAuth `error` code) means the login is gone. A proxy page, a captive portal,
  // a 403/407 or a 200 without a token says nothing about the refresh token, so it is retried later instead of asking for `frely login`.
  if ((status === 400 || status === 401) && isString(record.error)) throw new Error("Frely login expired. Run `frely login`.");
  if (status < 200 || status >= 300 || !isString(record.access_token)) {
    debugAuth(`stage=refresh unexpected_status=${status}`);
    throw new TransientRefreshError();
  }
  const expiresIn = numberPayload(record.expires_in, 1, 86_400);
  return { scheme: "bearer", value: record.access_token, ...(isString(record.refresh_token) ? { refreshToken: record.refresh_token } : { refreshToken }), expiresAt: Date.now() + expiresIn * 1000, ...(isString(record[SESSION_BINDING_ID_FIELD]) ? { sessionBindingId: record[SESSION_BINDING_ID_FIELD] as string } : {}), ...(isString(record[FRELY_MCP_TOKEN_FIELD]) ? { mcpToken: record[FRELY_MCP_TOKEN_FIELD] as string } : {}) };
}

const inflightRefresh = new Map<string, Promise<AuthCredential>>();
const REFRESH_LOCK_WAIT_MS = 20_000;
const REFRESH_LOCK_STALE_MS = 60_000;

function refreshLockPath(): string {
  return join(dirname(authConfigPath()), "refresh.lock");
}

/** The server rotates the refresh token on every use and treats a reused old one as theft, so two processes must never refresh at once. */
async function withRefreshLock<T>(work: () => Promise<T>): Promise<T> {
  const path = refreshLockPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => undefined);
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  let held = false;
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(String(process.pid)).catch(() => undefined);
      await handle.close();
      held = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") break;
      const age = await stat(path).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > REFRESH_LOCK_STALE_MS) { await unlink(path).catch(() => undefined); continue; }
      if (Date.now() >= deadline) break;
      await delay(100);
    }
  }
  try {
    return await work();
  } finally {
    if (held) await unlink(path).catch(() => undefined);
  }
}

function parseStoredCredential(raw: string | null): StoredOAuthCredential | null {
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Partial<StoredOAuthCredential>;
    if (stored.version !== 1 || stored.type !== "basic-oauth" || !isString(stored.accessToken) || typeof stored.expiresAt !== "number") return null;
    return stored as StoredOAuthCredential;
  } catch {
    return null;
  }
}

function bearerFromStored(stored: StoredOAuthCredential): AuthCredential {
  return { scheme: "bearer", value: stored.accessToken, ...(stored.refreshToken ? { refreshToken: stored.refreshToken } : {}), expiresAt: stored.expiresAt, ...(stored.sessionBindingId ? { sessionBindingId: stored.sessionBindingId } : {}), ...(stored.mcpToken ? { mcpToken: stored.mcpToken } : {}) };
}

// Refreshed logins the credential store refused to save (headless host, locked keychain). The server has already rotated the refresh token,
// so the stale copy still in the store must never be sent again: it reads as a stolen token and the server revokes the whole login.
const unsavedRefresh = new Map<string, StoredOAuthCredential>();

async function saveRefreshedCredential(key: string, refreshed: StoredOAuthCredential): Promise<void> {
  const value = JSON.stringify(refreshed satisfies StoredOAuthCredential);
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { await credentialStore.setPassword(SERVICE, key, value); unsavedRefresh.delete(key); return; }
    catch (error) { failure = error; await delay(200 * (attempt + 1)); }
  }
  // The new token is already valid on the server: keep it in this process and say so, because other processes will read the stale copy.
  unsavedRefresh.set(key, refreshed);
  process.stderr.write(`Frely could not save the refreshed login (${failure instanceof Error ? failure.message : "unknown error"}); it is kept in memory only. Fix the credential store, or run \`frely login\` again after a restart.\n`);
}

/**
 * Refreshes the stored login once for everyone: callers in this process share one request, other processes wait on a file lock and then
 * reuse the tokens the first one saved (the token they started from has been rotated away and must not be sent again).
 * `force` refreshes even when the stored access token is still valid, for a request the server refused.
 */
async function refreshStoredCredential(config: CliConfig, started: StoredOAuthCredential, force: boolean): Promise<AuthCredential> {
  const key = accountKey(config.relayUrl);
  const pending = inflightRefresh.get(key);
  if (pending) return pending;
  const run = withRefreshLock(async () => {
    let latest = parseStoredCredential(await credentialStore.getPassword(SERVICE, key).catch(() => null));
    const unsaved = unsavedRefresh.get(key);
    if (unsaved && latest && latest.expiresAt >= unsaved.expiresAt) unsavedRefresh.delete(key);
    else if (unsaved) {
      // The store still holds the token the server rotated away; the in-memory login is the current one.
      if (!force && unsaved.expiresAt > Date.now() + 30_000) return bearerFromStored(unsaved);
      latest = unsaved;
    }
    if (latest && latest !== unsaved) {
      const rotated = Boolean(latest.refreshToken) && latest.refreshToken !== started.refreshToken;
      if (rotated || (!force && latest.expiresAt > Date.now() + 30_000)) return bearerFromStored(latest);
    }
    const current = latest?.refreshToken ? latest : started;
    const next = await refreshOAuthCredential(config.relayUrl, current.refreshToken!, config.deviceId);
    if (next.expiresAt === undefined) throw new Error("Frely login expired. Run `frely login`.");
    const refreshed: StoredOAuthCredential = { version: 1, type: "basic-oauth", accessToken: next.value, ...(next.refreshToken ? { refreshToken: next.refreshToken } : {}), expiresAt: next.expiresAt };
    const sessionBindingId = next.sessionBindingId ?? current.sessionBindingId;
    if (sessionBindingId) refreshed.sessionBindingId = sessionBindingId;
    const mcpToken = next.mcpToken ?? current.mcpToken;
    if (mcpToken) refreshed.mcpToken = mcpToken;
    await saveRefreshedCredential(key, refreshed);
    return { ...next, ...(sessionBindingId ? { sessionBindingId } : {}), ...(mcpToken ? { mcpToken } : {}) };
  }).finally(() => { inflightRefresh.delete(key); });
  inflightRefresh.set(key, run);
  return run;
}

/** Refreshes the login now, whatever its expiry, and returns it with the machine's FreyMCP side token — for a request the server refused. */
export async function refreshLoginCredential(): Promise<{ config: { relayUrl: string }; credential: AuthCredential }> {
  const config = await currentRelayConfig(await readConfig());
  const stored = await loadCredential(config, false);
  if (!stored?.refreshToken) throw new Error("Frely login expired. Run `frely login`.");
  const current = parseStoredCredential(await credentialStore.getPassword(SERVICE, accountKey(config.relayUrl)));
  if (!current?.refreshToken) throw new Error("Frely login expired. Run `frely login`.");
  const credential = await refreshStoredCredential(config, current, true);
  return { config: { relayUrl: config.relayUrl }, credential };
}

export function openVerificationUrl(url: string): void {
  if (process.env.FRELY_NO_BROWSER === "1") return;
  const command = process.platform === "darwin" ? "/usr/bin/open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false, windowsHide: true });
  child.once("error", () => debugAuth("browser=unavailable; use the displayed verification URL"));
  child.unref();
}

function validateVerificationUrl(value: string, relayUrl: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Frely returned an invalid device authorization URL."); }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.origin !== relayUrl || url.username || url.password || url.hash) {
    throw new Error("Frely returned a device authorization URL outside the configured Relay.");
  }
  return url.toString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function objectPayload(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Frely returned an invalid ${label} response.`);
  return value as Record<string, unknown>;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function numberPayload(value: unknown, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? Math.floor(value) : (() => { throw new Error("Frely returned an invalid OAuth response."); })();
}

export async function writeConfig(config: CliConfig): Promise<void> {
  const path = authConfigPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => undefined);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => undefined);
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Frely request timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(url: string, init: RequestInit): Promise<{ status: number; payload: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let payload: unknown = null;
    try { payload = JSON.parse(text); } catch { /* not JSON: a proxy or captive-portal page */ }
    return { status: response.status, payload };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Frely request timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseUser(payload: unknown): PublicUser {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const candidate = root.user && typeof root.user === "object" ? root.user as Record<string, unknown> : root;
  if (typeof candidate.id !== "string" || typeof candidate.email !== "string") {
    const missing = [typeof candidate.id !== "string" ? "id" : null, typeof candidate.email !== "string" ? "email" : null].filter(Boolean).join(",");
    debugAuth(`profile validation=failed missing=${missing}`);
    throw new Error(`Frely returned an invalid user profile: missing ${missing}. Run with FRELY_DEBUG=1 for redacted diagnostics.`);
  }
  return { id: candidate.id, email: candidate.email, ...(typeof candidate.name === "string" ? { name: candidate.name } : {}), ...(typeof candidate.username === "string" && candidate.username ? { username: candidate.username } : {}) };
}

function payloadShape(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return typeof payload;
  return Object.entries(payload as Record<string, unknown>).map(([key, value]) => `${key}:${value && typeof value === "object" ? "object" : typeof value}`).join(",") || "object";
}

function sessionCookie(headers: Headers): string | null {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = [
    ...(extended.getSetCookie?.() ?? []),
    ...(headers.get("set-cookie") ? [headers.get("set-cookie")!] : []),
  ].flatMap(splitSetCookie);
  for (const value of setCookies) {
    const pair = value.split(";", 1)[0]?.trim();
    if (pair?.startsWith(`${SESSION_COOKIE_NAME}=`)) return pair;
  }
  return null;
}

function splitSetCookie(value: string | null): string[] {
  return value
    ? value.split(/,(?=\s*[^;,=]+=[^;,]+)/g).map((cookie) => cookie.trim()).filter(Boolean)
    : [];
}

function publicError(payload: unknown, status: number): string {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const error = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : root;
  const message = typeof error.message === "string" ? error.message : typeof error.error_description === "string" ? error.error_description : null;
  return message || `Frely request failed with HTTP ${status}.`;
}

function pendingEmailChallengePath(): string {
  const root = process.env.XDG_RUNTIME_DIR || join(homedir(), ".cache");
  return join(root, "frely", "pending-email-challenge.json");
}

function pendingDeviceLoginPath(): string {
  const root = process.env.XDG_RUNTIME_DIR || join(homedir(), ".cache");
  return join(root, "frely", "pending-device-login.json");
}

async function savePendingDeviceLogin(relayUrl: string, device: DeviceCodeResponse): Promise<void> {
  const path = pendingDeviceLoginPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ relayUrl, device, savedAt: Date.now() }), { mode: 0o600 });
}

async function readPendingDeviceLogin(relayUrl: string): Promise<{ device: DeviceCodeResponse; savedAt: number } | null> {
  try {
    const data = JSON.parse(await readFile(pendingDeviceLoginPath(), "utf8")) as { relayUrl?: string; device?: DeviceCodeResponse; savedAt?: number };
    if (data.relayUrl !== relayUrl || !data.device || typeof data.savedAt !== "number") return null;
    return Date.now() < data.savedAt + data.device.expires_in * 1000 ? { device: data.device, savedAt: data.savedAt } : null;
  } catch {
    return null;
  }
}

async function deletePendingDeviceLogin(): Promise<void> {
  await unlink(pendingDeviceLoginPath()).catch(() => undefined);
}

export async function savePendingEmailChallenge(relayUrl: string, challenge: EmailDeviceChallenge): Promise<void> {
  const path = pendingEmailChallengePath();
  await mkdir(dirname(path), { recursive: true });
  const data = {
    relayUrl,
    challenge,
    savedAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(data), { mode: 0o600 });
}

export async function readPendingEmailChallenge(relayInput: string): Promise<EmailDeviceChallenge | null> {
  const relayUrl = normalizeRelayUrl(relayInput);
  const path = pendingEmailChallengePath();
  try {
    const content = await readFile(path, "utf8");
    const data = JSON.parse(content) as { relayUrl: string; challenge: EmailDeviceChallenge; savedAt: string };
    if (data.relayUrl === relayUrl && data.challenge) {
      return data.challenge as EmailDeviceChallenge;
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return null;
}

export async function deletePendingEmailChallenge(relayUrl: string): Promise<void> {
  const path = pendingEmailChallengePath();
  try {
    await unlink(path);
  } catch {
    // File doesn't exist, which is fine
  }
}
