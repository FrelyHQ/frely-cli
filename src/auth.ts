import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { credentialStore } from "./credential-store.js";

const SERVICE = "frely-cli";
const SESSION_COOKIE_NAME = "friday_session_token";
const CONFIG_VERSION = 2;
const LEGACY_CONFIG_VERSION = 1;
const OAUTH_CLIENT_ID = "frely-cli";
const OAUTH_SCOPE = "openid profile profile:read email offline_access device-relay:enroll device-relay:connect device-relay:revoke";
const DEFAULT_RELAY = "https://app.frely.cloud";
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
}

export interface AuthCredential {
  scheme: "bearer" | "cookie";
  value: string;
  refreshToken?: string;
  expiresAt?: number;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface StoredOAuthCredential {
  version: 1;
  type: "oauth";
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface AuthSnapshot {
  configured: boolean;
  relayUrl?: string;
  user?: PublicUser;
  credentialStored: boolean;
  configPath: string;
  configMode?: number;
  authMethod?: "bearer" | "cookie";
}

export function authConfigPath(): string {
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(root, "frely", "config.json");
}

function accountKey(relayUrl: string): string {
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
  if (legacyPassword !== undefined) return legacyPasswordLogin(relayOrEmail ?? "", legacyPassword, legacyRelayInput);
  return (await loginDevice(relayOrEmail)).user;
}

export async function loginDevice(relayInput?: string, notify?: (details: { verificationUri: string; userCode: string }) => void): Promise<{ user: PublicUser; verificationUri: string; userCode: string }> {
  const relayUrl = normalizeRelayUrl(relayInput);
  const device = await requestDeviceCode(relayUrl);
  const verificationUri = validateVerificationUrl(device.verification_uri_complete || `${device.verification_uri}?user_code=${encodeURIComponent(device.user_code)}`, relayUrl);
  notify?.({ verificationUri, userCode: device.user_code });
  openVerificationUrl(verificationUri);
  const token = await pollDeviceToken(relayUrl, device);
  const user = await fetchUser(relayUrl, { scheme: "bearer", value: token.accessToken, ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}), expiresAt: token.expiresAt });
  const key = accountKey(relayUrl);
  await credentialStore.setPassword(SERVICE, key, JSON.stringify({
    version: 1,
    type: "oauth",
    accessToken: token.accessToken,
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    expiresAt: token.expiresAt,
  } satisfies StoredOAuthCredential));
  try {
    await writeConfig({ version: CONFIG_VERSION, relayUrl, user });
  } catch (error) {
    await credentialStore.deletePassword(SERVICE, key).catch(() => false);
    throw error;
  }
  return { user, verificationUri, userCode: device.user_code };
}

async function legacyPasswordLogin(email: string, password: string, relayInput?: string): Promise<PublicUser> {
  if (!email.trim() || !password) throw new Error("Email and password are required.");
  const relayUrl = normalizeRelayUrl(relayInput);
  const response = await fetchWithTimeout(`${relayUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "origin": relayUrl,
      "accept": "application/json",
    },
    body: JSON.stringify({ email: email.trim(), password }),
    redirect: "error",
  });
  const payload = await safeJson(response);
  if (!response.ok) throw new Error(publicError(payload, response.status));
  const user = parseUser(payload);
  const cookie = sessionCookie(response.headers);
  if (!cookie) throw new Error("Frely login succeeded without a usable session cookie.");
  const key = accountKey(relayUrl);
  await credentialStore.setPassword(SERVICE, key, cookie);
  try {
    await writeConfig({ version: CONFIG_VERSION, relayUrl, user });
  } catch (error) {
    await credentialStore.deletePassword(SERVICE, key).catch(() => false);
    throw error;
  }
  return user;
}

export async function whoami(): Promise<PublicUser> {
  const config = await readConfig();
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
  await credentialStore.deletePassword(SERVICE, key).catch(() => false);
  await unlink(authConfigPath()).catch(() => undefined);
}

export async function inspectAuth(): Promise<AuthSnapshot> {
  const path = authConfigPath();
  const config = await readConfig().catch(() => null);
  if (!config) return { configured: false, credentialStored: false, configPath: path };
  const credentialStored = Boolean(await credentialStore.getPassword(SERVICE, accountKey(config.relayUrl)));
  const fileStat = await stat(path).catch(() => null);
  const storedCredential = credentialStored ? await loadCredential(config, false) : null;
  return {
    configured: true,
    relayUrl: config.relayUrl,
    user: config.user,
    credentialStored,
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
  if (raw.startsWith(`${SESSION_COOKIE_NAME}=`)) return { scheme: "cookie", value: raw };
  try {
    const stored = JSON.parse(raw) as Partial<StoredOAuthCredential>;
    if (stored.version !== 1 || stored.type !== "oauth" || !isString(stored.accessToken)) {
      return { scheme: "bearer", value: raw };
    }
    return {
      scheme: "bearer",
      value: stored.accessToken,
      ...(isString(stored.refreshToken) ? { refreshToken: stored.refreshToken } : {}),
      ...(typeof stored.expiresAt === "number" ? { expiresAt: stored.expiresAt } : {}),
    };
  } catch {
    // Presence remains the routing signal. The remote adapter will surface a
    // stable authorization failure for an unreadable configured credential.
    return { scheme: "bearer", value: raw };
  }
}

export async function probeCredentialStore(): Promise<void> {
  const account = `doctor:${randomUUID()}`;
  const value = randomUUID();
  await credentialStore.setPassword(SERVICE, account, value);
  try {
    if (await credentialStore.getPassword(SERVICE, account) !== value) throw new Error("Credential store readback failed.");
  } finally {
    await credentialStore.deletePassword(SERVICE, account).catch(() => false);
  }
}

async function readConfig(): Promise<CliConfig> {
  const raw = await readFile(authConfigPath(), "utf8").catch(() => null);
  if (!raw) throw new Error("No Frely login is configured. Run `frely login`.");
  let value: Partial<CliConfig>;
  try {
    value = JSON.parse(raw) as Partial<CliConfig>;
  } catch {
    throw new Error("Frely CLI configuration is invalid.");
  }
  if (value.version !== CONFIG_VERSION && value.version !== LEGACY_CONFIG_VERSION) throw new Error("Frely CLI configuration is invalid.");
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

async function pollDeviceToken(relayUrl: string, device: DeviceCodeResponse): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number }> {
  const deadline = Date.now() + device.expires_in * 1000;
  let intervalMs = device.interval * 1000;
  while (Date.now() < deadline) {
    const response = await fetchWithTimeout(`${relayUrl}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: relayUrl, accept: "application/json" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: OAUTH_CLIENT_ID, resource: `${relayUrl}/api` }).toString(),
      redirect: "error",
    });
    const payload = await safeJson(response);
    debugAuth(`stage=token status=${response.status}`);
    const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    if (response.ok && isString(record.access_token) && (!record.token_type || String(record.token_type).toLowerCase() === "bearer")) {
      const expiresIn = numberPayload(record.expires_in, 1, 86_400);
      return { accessToken: record.access_token, ...(isString(record.refresh_token) ? { refreshToken: record.refresh_token } : {}), expiresAt: Date.now() + expiresIn * 1000 };
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

async function loadCredential(config: CliConfig, refresh: boolean): Promise<AuthCredential | null> {
  const raw = await credentialStore.getPassword(SERVICE, accountKey(config.relayUrl));
  if (!raw) return null;
  if (raw.startsWith(`${SESSION_COOKIE_NAME}=`)) return { scheme: "cookie", value: raw };
  try {
    const stored = JSON.parse(raw) as Partial<StoredOAuthCredential>;
    if (stored.version !== 1 || stored.type !== "oauth" || !isString(stored.accessToken) || typeof stored.expiresAt !== "number") return null;
    if (refresh && stored.refreshToken && stored.expiresAt <= Date.now() + 30_000) {
      const next = await refreshOAuthCredential(config.relayUrl, stored.refreshToken);
      if (next.expiresAt === undefined) return null;
      await credentialStore.setPassword(SERVICE, accountKey(config.relayUrl), JSON.stringify({ version: 1, type: "oauth", accessToken: next.value, ...(next.refreshToken ? { refreshToken: next.refreshToken } : {}), expiresAt: next.expiresAt } satisfies StoredOAuthCredential));
      return next;
    }
    return { scheme: "bearer", value: stored.accessToken, ...(stored.refreshToken ? { refreshToken: stored.refreshToken } : {}), expiresAt: stored.expiresAt };
  } catch {
    return null;
  }
}

async function refreshOAuthCredential(relayUrl: string, refreshToken: string): Promise<AuthCredential> {
  const response = await fetchWithTimeout(`${relayUrl}/api/auth/oauth2/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: relayUrl, accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: OAUTH_CLIENT_ID, resource: `${relayUrl}/api` }).toString(), redirect: "error",
  });
  const payload = await safeJson(response);
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  if (!response.ok || !isString(record.access_token)) throw new Error("Frely login expired. Run `frely login`.");
  const expiresIn = numberPayload(record.expires_in, 1, 86_400);
  return { scheme: "bearer", value: record.access_token, ...(isString(record.refresh_token) ? { refreshToken: record.refresh_token } : { refreshToken }), expiresAt: Date.now() + expiresIn * 1000 };
}

function openVerificationUrl(url: string): void {
  if (process.env.FRELY_NO_BROWSER === "1") return;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
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

async function writeConfig(config: CliConfig): Promise<void> {
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
