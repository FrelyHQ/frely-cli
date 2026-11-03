import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface LocalProviderBinding {
  providerId: string;
  name: string;
  driver: "ollama" | "openai-compatible";
  baseUrl: string;
  providerBaseUrl: string;
  models: string[];
  createdAt: string;
  /** Where the Provider counts: a personal Provider slot or the Creator Plan Provider limit. Absent on bindings saved by older versions. */
  slot?: "personal" | "creator";
  /** Prepared on the server but not finalized yet; `frely provider share` resumes it. */
  pending?: boolean;
  /** Registered on this computer only: nothing on Frely's servers, so nobody else can reach it and it takes no Provider slot. The id is `lcl_…`. */
  localOnly?: boolean;
  /** The endpoint wants a key (kept in the credential store, never in this file). */
  hasKey?: boolean;
  /** Calls the endpoint may serve at once, for local tasks and remote buyers together. Default: 1 on loopback, 6 elsewhere. */
  maxConcurrent?: number;
}

export const LOCAL_ONLY_PROVIDER_ID = /^lcl_[0-9a-f]{24}$/u;
export const SHARED_PROVIDER_ID = /^prv_[0-9a-f]{24}$/u;

interface LocalProviderState { version: 1; providers: LocalProviderBinding[] }

export function localProviderStatePath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "local-providers.json");
}

export async function listLocalProviders(): Promise<LocalProviderBinding[]> {
  return [...(await readState()).providers];
}

export async function getLocalProvider(providerId: string): Promise<LocalProviderBinding | null> {
  return (await readState()).providers.find((provider) => provider.providerId === providerId) ?? null;
}

export async function saveLocalProvider(provider: LocalProviderBinding): Promise<void> {
  validateProvider(provider);
  const state = await readState();
  const providers = state.providers.filter((candidate) => candidate.providerId !== provider.providerId);
  providers.push({ ...provider, models: [...provider.models] });
  providers.sort((left, right) => left.providerId.localeCompare(right.providerId));
  await writeState({ version: 1, providers });
}

export async function removeLocalProvider(providerId: string): Promise<boolean> {
  const state = await readState();
  const providers = state.providers.filter((provider) => provider.providerId !== providerId);
  if (providers.length === state.providers.length) return false;
  await writeState({ version: 1, providers });
  return true;
}

export function normalizeLoopbackOpenAiBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:") throw new Error("Local Provider URL must use HTTP on loopback.");
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) throw new Error("Local Provider URL must target loopback.");
  if (url.username || url.password || url.search || url.hash) throw new Error("Local Provider URL cannot contain credentials, query parameters, or a fragment.");
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/v1";
  if (url.pathname === "/") url.pathname = "/v1";
  if (url.pathname !== "/v1") throw new Error("Local Provider URL must point to an OpenAI-compatible /v1 endpoint.");
  return url.toString().replace(/\/$/u, "");
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];

/** Whether `host` (as `URL.hostname` prints it) is a loopback name or address. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host) || /^127\.\d+\.\d+\.\d+$/u.test(host);
}

/** An IP literal in a private range: 10/8, 172.16/12, 192.168/16, fd00::/8. Names never qualify, so the address cannot change under the registration. */
export function isPrivateLanHost(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([1, 2, 3, 4].some((index) => Number(v4[index]) > 255)) return false;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return /^\[fd[0-9a-f]{2}:[0-9a-f:]+\]$/u.test(host);
}

/**
 * The OpenAI-compatible `/v1` endpoint of a local Provider: plain http on this computer or an IP literal in a private network range
 * (a model gateway on the home or office LAN). The owner confirms a LAN address when registering it, and it is the only address that
 * remote callers can ever reach through this Provider.
 */
export function normalizeLocalOpenAiBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:") throw new Error("Local Provider URL must use HTTP on this computer or a private network address.");
  if (!isLoopbackHost(url.hostname) && !isPrivateLanHost(url.hostname)) throw new Error("Local Provider URL must be loopback or a private network IP address (10.x, 172.16-31.x, 192.168.x, fd00::), not a host name.");
  return normalizeOpenAiPath(url);
}

export function isLanBaseUrl(value: string): boolean {
  return !isLoopbackHost(new URL(value).hostname);
}

/** Whether calls to this endpoint are limited by default to one at a time: a model served by this very computer. */
export function defaultEndpointLimit(baseUrl: string): number {
  return isLanBaseUrl(baseUrl) ? 6 : 1;
}

function normalizeOpenAiPath(url: URL): string {
  if (url.username || url.password || url.search || url.hash) throw new Error("Local Provider URL cannot contain credentials, query parameters, or a fragment.");
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/v1";
  if (url.pathname === "/") url.pathname = "/v1";
  if (url.pathname !== "/v1") throw new Error("Local Provider URL must point to an OpenAI-compatible /v1 endpoint.");
  return url.toString().replace(/\/$/u, "");
}

export function isSupportedLocalModelName(value: string): boolean {
  // Hugging Face style ids (`org/model`) are fine; whitespace and a leading, trailing or doubled `/` are not.
  return value.length >= 1 && value.length <= 256 && !/\s/u.test(value) && !value.startsWith("/") && !value.endsWith("/") && !value.includes("//");
}

export function normalizeRelayProviderBaseUrl(value: string): string {
  const url = new URL(value);
  const loopbackHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) throw new Error("Frely local Provider relay URL must use HTTPS outside loopback development.");
  if (url.username || url.password || url.search || url.hash) throw new Error("Frely local Provider relay URL is invalid.");
  url.pathname = url.pathname.replace(/\/+$/u, "");
  if (url.pathname !== "/local-provider/v1") throw new Error("Frely local Provider relay URL is invalid.");
  return url.toString().replace(/\/$/u, "");
}

async function readState(): Promise<LocalProviderState> {
  const raw = await readFile(localProviderStatePath(), "utf8").catch(() => null);
  if (!raw) return { version: 1, providers: [] };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Frely local Provider configuration is invalid."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Frely local Provider configuration is invalid.");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.providers)) throw new Error("Frely local Provider configuration is invalid.");
  const providers = record.providers.map(parseProvider);
  if (new Set(providers.map((provider) => provider.providerId)).size !== providers.length) throw new Error("Frely local Provider configuration contains duplicate Provider IDs.");
  return { version: 1, providers };
}

function parseProvider(value: unknown): LocalProviderBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Frely local Provider configuration is invalid.");
  const record = value as Record<string, unknown>;
  if (record.driver !== "ollama" && record.driver !== "openai-compatible") throw new Error("Frely local Provider driver is invalid.");
  const provider: LocalProviderBinding = {
    providerId: String(record.providerId ?? ""),
    name: String(record.name ?? ""),
    driver: record.driver,
    baseUrl: String(record.baseUrl ?? ""),
    providerBaseUrl: String(record.providerBaseUrl ?? ""),
    models: Array.isArray(record.models) ? record.models.map(String) : [],
    createdAt: String(record.createdAt ?? ""),
    ...(record.slot === "personal" || record.slot === "creator" ? { slot: record.slot } : {}),
    ...(record.pending === true ? { pending: true } : {}),
    ...(record.localOnly === true ? { localOnly: true } : {}),
    ...(record.hasKey === true ? { hasKey: true } : {}),
    ...(typeof record.maxConcurrent === "number" ? { maxConcurrent: record.maxConcurrent } : {}),
  };
  validateProvider(provider);
  return provider;
}

function validateProvider(provider: LocalProviderBinding): void {
  if (provider.localOnly) {
    if (!LOCAL_ONLY_PROVIDER_ID.test(provider.providerId) || provider.providerBaseUrl !== "") throw new Error("Frely local Provider ID is invalid.");
  } else {
    if (!SHARED_PROVIDER_ID.test(provider.providerId)) throw new Error("Frely local Provider ID is invalid.");
    normalizeRelayProviderBaseUrl(provider.providerBaseUrl);
  }
  if (!provider.name || provider.name.length > 128) throw new Error("Frely local Provider name is invalid.");
  normalizeLocalOpenAiBaseUrl(provider.baseUrl);
  if (provider.maxConcurrent !== undefined && (!Number.isInteger(provider.maxConcurrent) || provider.maxConcurrent < 1 || provider.maxConcurrent > 64)) throw new Error("Frely local Provider concurrency limit is invalid.");
  if (provider.models.length < 1 || provider.models.length > 256 || provider.models.some((model) => !isSupportedLocalModelName(model))) throw new Error("Frely local Provider models are invalid.");
  if (!Number.isFinite(Date.parse(provider.createdAt))) throw new Error("Frely local Provider creation time is invalid.");
}

async function writeState(state: LocalProviderState): Promise<void> {
  const path = localProviderStatePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => undefined);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => undefined);
}
