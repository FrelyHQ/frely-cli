import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { discoverLocalModels } from "./local.js";
import { deleteProviderKey, saveProviderKey } from "./key.js";
import {
  isLanBaseUrl, isSupportedLocalModelName, listLocalProviders, normalizeLocalOpenAiBaseUrl, removeLocalProvider, saveLocalProvider, type LocalProviderBinding,
} from "./state.js";

export interface RegisterIo {
  err(text: string): void;
  /** A person is at the terminal and can be asked. */
  interactive: boolean;
  /** Reads the answer to a yes/no question; the terminal in production. */
  ask?(question: string): Promise<string>;
}

/**
 * A LAN address is opened to this computer's background service (and, for a shared Provider, to the callers it serves), so the owner
 * confirms it in person: at the terminal, by typing yes. A remote session cannot answer, and the remote `local_models` tool never gets here.
 */
export async function confirmLanEndpoint(baseUrl: string, io: RegisterIo): Promise<void> {
  if (!isLanBaseUrl(baseUrl)) return;
  const question = `${baseUrl} is a network address, not this computer. Frely will send model calls there from this computer, and only to this exact address and port. Type "yes" to register it: `;
  if (!io.interactive) throw new Error(`${baseUrl} is a network address, so the owner must register it in a terminal on this computer (the confirmation cannot be answered remotely).`);
  const answer = io.ask ? await io.ask(question) : await askTerminal(question);
  if (answer.trim().toLowerCase() !== "yes") throw new Error("Not registered: the address was not confirmed.");
}

async function askTerminal(question: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try { return await reader.question(question); } finally { reader.close(); }
}

export interface RegisterInput {
  readonly driver: "ollama" | "openai-compatible";
  readonly url?: string;
  readonly models?: readonly string[];
  readonly name?: string;
  readonly key?: string;
  readonly maxConcurrent?: number;
}

export function defaultProviderUrl(driver: "ollama" | "openai-compatible"): string {
  return driver === "ollama" ? "http://127.0.0.1:11434/v1" : "http://127.0.0.1:8080/v1";
}

/** Registers a model endpoint for this computer's own tasks: no Provider on Frely's servers, no slot used, nobody else can reach it. */
export async function registerLocalOnlyProvider(input: RegisterInput, io: RegisterIo): Promise<LocalProviderBinding> {
  const baseUrl = normalizeLocalOpenAiBaseUrl(input.url ?? defaultProviderUrl(input.driver));
  await confirmLanEndpoint(baseUrl, io);
  const selected = input.models?.map((value) => value.trim()).filter(Boolean);
  const models = selected?.length ? [...new Set(selected)] : await discoverLocalModels(baseUrl, { lan: true, ...(input.key ? { key: input.key } : {}) });
  if (models.length < 1 || models.length > 256 || models.some((model) => !isSupportedLocalModelName(model))) throw new Error("At least one valid model is required; model names cannot contain whitespace, start or end with `/`, or contain `//`.");
  if ((await listLocalProviders()).some((provider) => provider.baseUrl === baseUrl && provider.localOnly)) throw new Error(`${baseUrl} is already registered. Remove it first with frely provider remove <id>.`);
  const providerId = `lcl_${randomBytes(12).toString("hex")}`;
  const binding: LocalProviderBinding = {
    providerId, name: (input.name ?? `${input.driver === "ollama" ? "Ollama" : "Local"}: ${models[0]}`).slice(0, 128), driver: input.driver, baseUrl, providerBaseUrl: "",
    models, createdAt: new Date().toISOString(), localOnly: true, ...(input.key ? { hasKey: true } : {}), ...(input.maxConcurrent === undefined ? {} : { maxConcurrent: input.maxConcurrent }),
  };
  if (input.key) await saveProviderKey(providerId, input.key);
  try { await saveLocalProvider(binding); } catch (error) { await deleteProviderKey(providerId); throw error; }
  return binding;
}

/** Removes a registration kept on this computer; a Provider that was shared also lives on Frely's servers and is removed there. */
export async function removeLocalOnlyProvider(providerId: string): Promise<void> {
  const found = (await listLocalProviders()).find((provider) => provider.providerId === providerId);
  if (!found) throw new Error(`No local Provider ${providerId} on this computer. See frely provider list.`);
  if (!found.localOnly) throw new Error(`${providerId} is shared through Frely. Remove it in the Frely console first; this command removes only registrations kept on this computer.`);
  await removeLocalProvider(providerId);
  await deleteProviderKey(providerId);
}

/** Saves or clears the upstream key of a registration. */
export async function setProviderKey(providerId: string, key: string | undefined): Promise<void> {
  const found = (await listLocalProviders()).find((provider) => provider.providerId === providerId);
  if (!found) throw new Error(`No local Provider ${providerId} on this computer. See frely provider list.`);
  if (key === undefined) await deleteProviderKey(providerId); else await saveProviderKey(providerId, key);
  const { hasKey: _old, ...rest } = found;
  await saveLocalProvider({ ...rest, ...(key === undefined ? {} : { hasKey: true }) });
}
