import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import keytar from "keytar";

const SERVICE = "frely-cli";
const SESSION_COOKIE_NAME = "friday_session_token";
const CONFIG_VERSION = 1;
const DEFAULT_RELAY = "https://app.frely.cloud";
const REQUEST_TIMEOUT_MS = 15_000;

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

export interface AuthSnapshot {
  configured: boolean;
  relayUrl?: string;
  user?: PublicUser;
  credentialStored: boolean;
  configPath: string;
  configMode?: number;
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

export async function login(email: string, password: string, relayInput?: string): Promise<PublicUser> {
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
  await keytar.setPassword(SERVICE, key, cookie);
  try {
    await writeConfig({ version: CONFIG_VERSION, relayUrl, user });
  } catch (error) {
    await keytar.deletePassword(SERVICE, key).catch(() => false);
    throw error;
  }
  return user;
}

export async function whoami(): Promise<PublicUser> {
  const config = await readConfig();
  const cookie = await keytar.getPassword(SERVICE, accountKey(config.relayUrl));
  if (!cookie) throw new Error("No Frely login is stored. Run `frely login`.");
  const response = await fetchWithTimeout(`${config.relayUrl}/api/auth/me`, {
    headers: { "cookie": cookie, "accept": "application/json" },
    redirect: "error",
  });
  const payload = await safeJson(response);
  if (!response.ok) {
    if (response.status === 401) throw new Error("Frely login expired. Run `frely login`.");
    throw new Error(publicError(payload, response.status));
  }
  const user = parseUser(payload);
  if (user.id !== config.user.id || user.email !== config.user.email || user.name !== config.user.name) {
    await writeConfig({ ...config, user });
  }
  return user;
}

export async function requireLogin(): Promise<{ config: { relayUrl: string }; user: PublicUser; cookie: string }> {
  const config = await readConfig();
  const cookie = await keytar.getPassword(SERVICE, accountKey(config.relayUrl));
  if (!cookie) throw new Error("No Frely login is stored. Run `frely login`.");
  const user = await whoami();
  return { config: { relayUrl: config.relayUrl }, user, cookie };
}

export async function logout(): Promise<void> {
  const config = await readConfig().catch(() => null);
  if (!config) {
    await unlink(authConfigPath()).catch(() => undefined);
    return;
  }
  const key = accountKey(config.relayUrl);
  const cookie = await keytar.getPassword(SERVICE, key);
  if (cookie) {
    await fetchWithTimeout(`${config.relayUrl}/api/auth/logout`, {
      method: "POST",
      headers: { "cookie": cookie, "origin": config.relayUrl, "content-type": "application/json" },
      body: "{}",
      redirect: "error",
    }).catch(() => undefined);
  }
  await keytar.deletePassword(SERVICE, key).catch(() => false);
  await unlink(authConfigPath()).catch(() => undefined);
}

export async function inspectAuth(): Promise<AuthSnapshot> {
  const path = authConfigPath();
  const config = await readConfig().catch(() => null);
  if (!config) return { configured: false, credentialStored: false, configPath: path };
  const credentialStored = Boolean(await keytar.getPassword(SERVICE, accountKey(config.relayUrl)));
  const fileStat = await stat(path).catch(() => null);
  return {
    configured: true,
    relayUrl: config.relayUrl,
    user: config.user,
    credentialStored,
    configPath: path,
    ...(fileStat ? { configMode: fileStat.mode & 0o777 } : {}),
  };
}

export async function probeCredentialStore(): Promise<void> {
  const account = `doctor:${randomUUID()}`;
  const value = randomUUID();
  await keytar.setPassword(SERVICE, account, value);
  try {
    if (await keytar.getPassword(SERVICE, account) !== value) throw new Error("Credential store readback failed.");
  } finally {
    await keytar.deletePassword(SERVICE, account).catch(() => false);
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
  if (value.version !== CONFIG_VERSION || typeof value.relayUrl !== "string" || !value.user || typeof value.user.id !== "string" || typeof value.user.email !== "string") {
    throw new Error("Frely CLI configuration is invalid.");
  }
  return value as CliConfig;
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
  if (typeof candidate.id !== "string" || typeof candidate.email !== "string") throw new Error("Frely returned an invalid user profile.");
  return { id: candidate.id, email: candidate.email, ...(typeof candidate.name === "string" ? { name: candidate.name } : {}) };
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
  const message = typeof error.message === "string" ? error.message : null;
  return message || `Frely request failed with HTTP ${status}.`;
}
