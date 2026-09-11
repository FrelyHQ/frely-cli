import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import keytar from "keytar";

const SERVICE = "frely-cli";
const SESSION_COOKIE_NAME = "friday_session_token";
const CONFIG_VERSION = 1;
const DEFAULT_RELAY = "https://app.frely.cloud";

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

function configPath(): string {
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
  const relayUrl = normalizeRelayUrl(relayInput);
  const response = await fetch(`${relayUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "origin": relayUrl,
      "accept": "application/json"
    },
    body: JSON.stringify({ email, password }),
    redirect: "error"
  });
  const payload = await safeJson(response);
  if (!response.ok) throw new Error(publicError(payload, response.status));
  const user = parseUser(payload);
  const cookie = sessionCookie(response.headers);
  if (!cookie) throw new Error("Frely login succeeded without a usable session cookie.");
  await keytar.setPassword(SERVICE, accountKey(relayUrl), cookie);
  await writeConfig({ version: CONFIG_VERSION, relayUrl, user });
  return user;
}

export async function whoami(): Promise<PublicUser> {
  const config = await readConfig();
  const cookie = await keytar.getPassword(SERVICE, accountKey(config.relayUrl));
  if (!cookie) throw new Error("No Frely login is stored. Run `frely login`.");
  const response = await fetch(`${config.relayUrl}/api/auth/me`, {
    headers: { "cookie": cookie, "accept": "application/json" },
    redirect: "error"
  });
  const payload = await safeJson(response);
  if (!response.ok) throw new Error(response.status === 401 ? "Frely login expired. Run `frely login`." : publicError(payload, response.status));
  return parseUser(payload);
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
  if (!config) return;
  const cookie = await keytar.getPassword(SERVICE, accountKey(config.relayUrl));
  if (cookie) {
    await fetch(`${config.relayUrl}/api/auth/logout`, {
      method: "POST",
      headers: { "cookie": cookie, "origin": config.relayUrl, "content-type": "application/json" },
      body: "{}",
      redirect: "error"
    }).catch(() => undefined);
  }
  await keytar.deletePassword(SERVICE, accountKey(config.relayUrl));
}

async function readConfig(): Promise<CliConfig> {
  const raw = await readFile(configPath(), "utf8").catch(() => null);
  if (!raw) throw new Error("No Frely login is configured. Run `frely login`.");
  const value = JSON.parse(raw) as Partial<CliConfig>;
  if (value.version !== CONFIG_VERSION || typeof value.relayUrl !== "string" || !value.user) throw new Error("Frely CLI configuration is invalid.");
  return value as CliConfig;
}

async function writeConfig(config: CliConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => undefined);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => undefined);
}

async function safeJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

function parseUser(payload: unknown): PublicUser {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const candidate = root.user && typeof root.user === "object" ? root.user as Record<string, unknown> : root;
  if (typeof candidate.id !== "string" || typeof candidate.email !== "string") throw new Error("Frely returned an invalid user profile.");
  return { id: candidate.id, email: candidate.email, ...(typeof candidate.name === "string" ? { name: candidate.name } : {}) };
}

function sessionCookie(headers: Headers): string | null {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = extended.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
  for (const value of setCookies) {
    const pair = value.split(";", 1)[0]?.trim();
    if (pair?.startsWith(`${SESSION_COOKIE_NAME}=`)) return pair;
  }
  return null;
}

function publicError(payload: unknown, status: number): string {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const error = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : root;
  const message = typeof error.message === "string" ? error.message : null;
  return message || `Frely request failed with HTTP ${status}.`;
}
