import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { basicCredentialStore as credentialStore, BASIC_CREDENTIAL_BACKEND } from "./credential-basic.js";

export const SERVICE = "frely-cli-basic-v1";
const SESSION_COOKIE_NAME = "friday_session_token";
export const CONFIG_VERSION = 3;
const LEGACY_CONFIG_VERSION = 1;
const OAUTH_CLIENT_ID = "frely-cli-basic";
const OAUTH_SCOPE = "openid profile profile:read email offline_access device-relay:provider";
const DEFAULT_RELAY = "https://frely.cloud";
// app.frely.cloud now belongs to the Frely App; logins saved against it must be redone on frely.cloud.
const RETIRED_RELAY_HOSTNAME = "app.frely.cloud";
const REQUEST_TIMEOUT_MS = 15_000;

function debugAuth(message: string): void {
  if (process.env.FRELY_DEBUG === "1") process.stderr.write(`[debug] auth ${message}\n`);
}

export interface PublicUser {
  id: string;
  email: string;
  name?: string | null;
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
}

export async function initEmailDeviceLogin(
  relayInput: string,
  email: string,
  invite?: string,
): Promise<EmailDeviceChallenge> {
  const relayUrl = normalizeRelayUrl(relayInput);
  await probeCredentialStore();

  // First, request device code from Better Auth
  const deviceCodeResponse = await fetch(`${relayUrl}/api/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!deviceCodeResponse.ok) {
    const body = await deviceCodeResponse.json().catch(() => ({})) as Record<string, unknown>;
    const message = typeof body.message === "string" ? body.message : `Failed to create device code (${deviceCodeResponse.status})`;
    throw new Error(message);
  }

  const deviceCodeData = await deviceCodeResponse.json() as Record<string, unknown>;
  const userCode = typeof deviceCodeData.user_code === "string" ? deviceCodeData.user_code : null;
  const deviceCode = typeof deviceCodeData.device_code === "string" ? deviceCodeData.device_code : null;
  const expiresIn = typeof deviceCodeData.expires_in === "number" ? deviceCodeData.expires_in : 900;

  if (!userCode || !deviceCode) {
    throw new Error("Failed to create device code: invalid response");
  }

  // Then, initiate email verification with the user code
  const response = await fetch(`${relayUrl}/api/auth/device/email/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, userCode, ...(invite ? { invite } : {}) }),
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

export async function loginDevice(
  relayInput?: string,
  notify?: (details: { verificationUri: string; userCode: string }) => void,
  options: { openBrowser?: boolean } = {},
): Promise<{ user: PublicUser; verificationUri: string; userCode: string; sessionBound: boolean }> {
  const relayUrl = normalizeRelayUrl(relayInput);
  await probeCredentialStore();
  const deviceId = localDeviceId((await readConfig().catch(() => null))?.deviceId);
  const device = await requestDeviceCode(relayUrl);
  const verificationUri = validateVerificationUrl(device.verification_uri_complete || `${device.verification_uri}?user_code=${encodeURIComponent(device.user_code)}`, relayUrl);
  notify?.({ verificationUri, userCode: device.user_code });
  if (options.openBrowser !== false) openVerificationUrl(verificationUri);
  const token = await pollDeviceToken(relayUrl, device, deviceId);
  const user = await fetchUser(relayUrl, { scheme: "bearer", value: token.accessToken, ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}), expiresAt: token.expiresAt, ...(token.sessionBindingId ? { sessionBindingId: token.sessionBindingId } : {}) });
  const key = accountKey(relayUrl);
  await credentialStore.setPassword(SERVICE, key, JSON.stringify({
    version: 1,
    type: "basic-oauth",
    accessToken: token.accessToken,
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    expiresAt: token.expiresAt,
    ...(token.sessionBindingId ? { sessionBindingId: token.sessionBindingId } : {}),
  } satisfies StoredOAuthCredential));
  try {
    await writeConfig({ version: CONFIG_VERSION, relayUrl, user, deviceId });
  } catch (error) {
    await credentialStore.deletePassword(SERVICE, key).catch(() => false);
    throw error;
  }
  return { user, verificationUri, userCode: device.user_code, sessionBound: Boolean(token.sessionBindingId) };
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
  const config = await readConfig();
  assertCurrentRelay(config);
  const credential = await loadCredential(config, true);
  if (!credential) throw new Error("No Frely login is stored. Run `frely login`.");
  const user = await fetchUser(config.relayUrl, credential);
  if (config.version !== CONFIG_VERSION || user.id !== config.user.id || user.email !== config.user.email || user.name !== config.user.name) {
    await writeConfig({ ...config, user });
  }
  return user;
}

export async function requireLogin(): Promise<{ config: { relayUrl: string }; user: PublicUser; credential: AuthCredential; cookie?: string }> {
  const config = await readConfig();
  assertCurrentRelay(config);
  const credential = await loadCredential(config, true);
  if (!credential) throw new Error("No Frely login is stored. Run `frely login`.");
  const user = await fetchUser(config.relayUrl, credential).catch((error) => {
    if (error instanceof Error && error.message === "Frely login expired. Run `frely login`.") throw error;
    throw error;
  });
  if (config.version !== CONFIG_VERSION || user.id !== config.user.id || user.email !== config.user.email || user.name !== config.user.name) await writeConfig({ ...config, version: CONFIG_VERSION, user });
  return { config: { relayUrl: config.relayUrl }, user, credential, ...(credential.scheme === "cookie" ? { cookie: credential.value } : {}) };
}

export async function logout(): Promise<void> {
  const config = await readConfig().catch(() => null);
  if (!config) {
    await unlink(authConfigPath()).catch(() => undefined);
    return;
  }
  const key = accountKey(config.relayUrl);
  const credential = await loadCredential(config, false);
  if (credential?.scheme === "cookie") {
    await fetchWithTimeout(`${config.relayUrl}/api/auth/logout`, {
      method: "POST", headers: { cookie: credential.value, origin: config.relayUrl, "content-type": "application/json" }, body: "{}", redirect: "error",
    }).catch(() => undefined);
  } else if (credential?.scheme === "bearer") {
    const revoke = async (token: string, hint: string) => fetchWithTimeout(`${config.relayUrl}/api/auth/oauth2/revoke`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: config.relayUrl },
      body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, token, token_type_hint: hint }).toString(), redirect: "error",
    }).catch(() => undefined);
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

function assertCurrentRelay(config: CliConfig): void {
  if (new URL(config.relayUrl).hostname === RETIRED_RELAY_HOSTNAME) {
    throw new Error("Frely moved to https://frely.cloud. Run `frely login` again.");
  }
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
  const response = await fetchWithTimeout(`${relayUrl}/api/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: relayUrl, accept: "application/json" },
    body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, scope: OAUTH_SCOPE, resource: `${relayUrl}/api` }).toString(),
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
): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number; sessionBindingId?: string }> {
  // Support both DeviceCodeResponse and EmailDeviceChallenge
  const deviceCode = "device_code" in device ? device.device_code : device.deviceCode;
  const expiresIn = "expires_in" in device ? device.expires_in : device.expiresIn;
  const interval = "interval" in device ? device.interval : 5;

  const deadline = Date.now() + expiresIn * 1000;
  let intervalMs = interval * 1000;
  while (Date.now() < deadline) {
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: OAUTH_CLIENT_ID, resource: `${relayUrl}/api` });
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
      return { accessToken: record.access_token, ...(isString(record.refresh_token) ? { refreshToken: record.refresh_token } : {}), expiresAt: Date.now() + expiresInSeconds * 1000, ...(isString(record[SESSION_BINDING_ID_FIELD]) ? { sessionBindingId: record[SESSION_BINDING_ID_FIELD] as string } : {}) };
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
  try {
    const stored = JSON.parse(raw) as Partial<StoredOAuthCredential>;
    if (stored.version !== 1 || stored.type !== "basic-oauth" || !isString(stored.accessToken) || typeof stored.expiresAt !== "number") return null;
    if (refresh && stored.refreshToken && stored.expiresAt <= Date.now() + 30_000) {
      const next = await refreshOAuthCredential(config.relayUrl, stored.refreshToken, config.deviceId);
      if (next.expiresAt === undefined) return null;
      const refreshed: StoredOAuthCredential = { version: 1, type: "basic-oauth", accessToken: next.value, ...(next.refreshToken ? { refreshToken: next.refreshToken } : {}), expiresAt: next.expiresAt };
      const sessionBindingId = next.sessionBindingId ?? stored.sessionBindingId;
      if (sessionBindingId) refreshed.sessionBindingId = sessionBindingId;
      await credentialStore.setPassword(SERVICE, accountKey(config.relayUrl), JSON.stringify(refreshed satisfies StoredOAuthCredential));
      return next;
    }
    return { scheme: "bearer", value: stored.accessToken, ...(stored.refreshToken ? { refreshToken: stored.refreshToken } : {}), expiresAt: stored.expiresAt, ...(stored.sessionBindingId ? { sessionBindingId: stored.sessionBindingId } : {}) };
  } catch {
    return null;
  }
}

async function refreshOAuthCredential(relayUrl: string, refreshToken: string, deviceId?: string | null): Promise<AuthCredential> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: OAUTH_CLIENT_ID, resource: `${relayUrl}/api` });
  appendSessionBinding(body, deviceId);
  const response = await fetchWithTimeout(`${relayUrl}/api/auth/oauth2/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: relayUrl, accept: "application/json" },
    body: body.toString(), redirect: "error",
  });
  const payload = await safeJson(response);
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  if (!response.ok || !isString(record.access_token)) throw new Error("Frely login expired. Run `frely login`.");
  const expiresIn = numberPayload(record.expires_in, 1, 86_400);
  return { scheme: "bearer", value: record.access_token, ...(isString(record.refresh_token) ? { refreshToken: record.refresh_token } : { refreshToken }), expiresAt: Date.now() + expiresIn * 1000, ...(isString(record[SESSION_BINDING_ID_FIELD]) ? { sessionBindingId: record[SESSION_BINDING_ID_FIELD] as string } : {}) };
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
  return { id: candidate.id, email: candidate.email, ...(typeof candidate.name === "string" ? { name: candidate.name } : {}) };
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
