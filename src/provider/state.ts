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
}

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

export function isSupportedLocalModelName(value: string): boolean {
  return value.length >= 1 && value.length <= 256 && !/[\s/]/u.test(value);
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
  };
  validateProvider(provider);
  return provider;
}

function validateProvider(provider: LocalProviderBinding): void {
  if (!/^prv_[0-9a-f]{24}$/u.test(provider.providerId)) throw new Error("Frely local Provider ID is invalid.");
  if (!provider.name || provider.name.length > 128) throw new Error("Frely local Provider name is invalid.");
  normalizeLoopbackOpenAiBaseUrl(provider.baseUrl);
  normalizeRelayProviderBaseUrl(provider.providerBaseUrl);
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
