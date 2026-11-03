import { requireLogin } from "../auth.js";
import { ensureDevice } from "../device/control.js";
import { createLocalProviderToken, loadOrCreateDeviceIdentity } from "../device/identity.js";
import { installDeviceRelayService } from "../service.js";
import { relayAllowanceLines } from "../share/allowance.js";
import { fetchRelayUsage, finalizeLocalProvider, type FinalizeResult, listPersonalProviderSlots, prepareLocalProvider, waitForLocalProviderRelay } from "./control.js";
import { discoverLocalModels } from "./local.js";
import { saveProviderKey } from "./key.js";
import { isSupportedLocalModelName, listLocalProviders, normalizeLocalOpenAiBaseUrl, normalizeLoopbackOpenAiBaseUrl, saveLocalProvider, type LocalProviderBinding } from "./state.js";

export interface ShareLocalProviderInput {
  driver: "ollama" | "openai-compatible";
  /** Loopback `/v1` URL; defaults by driver. */
  url?: string;
  /** Model ids to publish; omitted means every model the server reports. */
  models?: string[];
  /** A specific empty personal Provider slot. */
  slot?: string;
  /** Skip the personal slot and publish as a Creator Provider. */
  creator?: boolean;
  name?: string;
  /** The endpoint may be a private network address. Set only by the CLI after the owner confirmed it at the terminal, never from a remote request. */
  lan?: boolean;
  /** The upstream key of the endpoint; saved in the credential store, never in the Provider file. */
  key?: string;
  maxConcurrent?: number;
  /** Also make the AccessPoints the models are sold and planned through (`frely service share model`). */
  accessPoints?: boolean;
  /** False inside the running daemon: reinstalling its own service would restart the process serving this call. */
  installService?: boolean;
}

export interface ShareLocalProviderResult {
  provider: LocalProviderBinding;
  slot: "personal" | "creator";
  /** True when a Provider prepared earlier was finished instead of preparing a new one. */
  resumed: boolean;
  /** The AccessPoints made for the models; empty when none were asked for or the account may not create them (see `accessPointNote`). */
  accessPoints: FinalizeResult["accessPoints"];
  accessPointNote?: string;
}

type Log = (text: string) => void;

let inflight: Promise<void> = Promise.resolve();

/** Prepares (or resumes) a local Provider, waits for the Device Relay to reach it and finalizes it. One share runs at a time per process. */
export async function shareLocalProvider(input: ShareLocalProviderInput, log: Log): Promise<ShareLocalProviderResult> {
  const run = inflight.then(() => shareOnce(input, log));
  inflight = run.then(() => undefined, () => undefined);
  return run;
}

async function shareOnce(input: ShareLocalProviderInput, log: Log): Promise<ShareLocalProviderResult> {
  const auth = await requireLogin();
  const device = await ensureDevice();
  const installService = input.installService !== false;
  const pending = (await listLocalProviders()).find((provider) => provider.pending);
  if (pending) {
    log(`Resuming prepared Provider ${pending.providerId}.\n`);
    const ready = await activateLocalProvider(auth, device.deviceId, pending, log, installService, input.accessPoints === true);
    return { provider: ready.provider, slot: pending.slot ?? "personal", resumed: true, accessPoints: ready.result.accessPoints, ...(ready.result.accessPointNote ? { accessPointNote: ready.result.accessPointNote } : {}) };
  }
  const driver = input.driver;
  const defaultUrl = driver === "ollama" ? "http://127.0.0.1:11434/v1" : "http://127.0.0.1:8080/v1";
  const baseUrl = input.lan === true ? normalizeLocalOpenAiBaseUrl(input.url ?? defaultUrl) : normalizeLoopbackOpenAiBaseUrl(input.url ?? defaultUrl);
  const selected = input.models?.map((value) => value.trim()).filter(Boolean);
  const models = selected?.length ? [...new Set(selected)] : await discoverLocalModels(baseUrl, { lan: input.lan === true, ...(input.key ? { key: input.key } : {}) });
  if (models.length < 1 || models.length > 256 || models.some((model) => !isSupportedLocalModelName(model))) throw new Error("At least one valid model is required; model names cannot contain whitespace, start or end with `/`, or contain `//`.");
  if (input.creator && input.slot) throw new Error("Use either --slot or --creator, not both.");
  const slots = input.creator ? [] : await listPersonalProviderSlots();
  const slot = input.slot ? slots.find((candidate) => candidate.id === input.slot) : slots.find((candidate) => candidate.lifecycle === "active" && candidate.provider === null);
  if (input.slot && !slot) throw new Error("The requested personal Provider slot is unavailable.");
  if (slot && (slot.lifecycle !== "active" || slot.provider !== null)) throw new Error("The selected personal Provider slot is not empty and active.");
  const name = (input.name ?? `${driver === "ollama" ? "Ollama" : "Local"}: ${models[0]}`).slice(0, 128);
  // Without an empty personal slot the Provider counts against the Creator Plan Provider limit.
  const prepared = await prepareLocalProvider(slot ? { deviceId: device.deviceId, slotId: slot.id, name, models } : { deviceId: device.deviceId, source: "creator", name, models });
  if (!slot) log("Created as a Creator Provider. Pick these models when you create a Frely Agent; buyers call the Agent, and this device must stay online.\n");
  const kind = slot ? "personal" : "creator";
  const provider: LocalProviderBinding = {
    providerId: prepared.providerId, name, driver, baseUrl, providerBaseUrl: prepared.providerBaseUrl, models, createdAt: new Date().toISOString(), slot: kind, pending: true,
    ...(input.key ? { hasKey: true } : {}), ...(input.maxConcurrent === undefined ? {} : { maxConcurrent: input.maxConcurrent }),
  };
  if (input.key) await saveProviderKey(prepared.providerId, input.key);
  await saveLocalProvider(provider);
  const ready = await activateLocalProvider(auth, device.deviceId, provider, log, installService, input.accessPoints === true);
  return { provider: ready.provider, slot: kind, resumed: false, accessPoints: ready.result.accessPoints, ...(ready.result.accessPointNote ? { accessPointNote: ready.result.accessPointNote } : {}) };
}

async function activateLocalProvider(auth: Awaited<ReturnType<typeof requireLogin>>, deviceId: string, provider: LocalProviderBinding, log: Log, installService: boolean, accessPoints: boolean): Promise<{ provider: LocalProviderBinding; result: FinalizeResult }> {
  const service = installService ? await installDeviceRelayService() : null;
  const identity = await loadOrCreateDeviceIdentity(auth.config.relayUrl, auth.user.id);
  const token = createLocalProviderToken(identity, deviceId, auth.user.id, provider.providerId);
  let result: FinalizeResult;
  try {
    await waitForLocalProviderRelay(provider.providerBaseUrl, token);
    result = await finalizeLocalProvider({ providerId: provider.providerId, token, ...(accessPoints ? { accessPoints: true } : {}) });
  } catch (error) {
    throw new Error(`The model share ${provider.providerId} is prepared but not ready. Run \`frely service share model\` again to resume. ${error instanceof Error ? error.message : String(error)}`);
  }
  const { pending: _pending, ...ready } = provider;
  await saveLocalProvider(ready);
  log(`Share: ${provider.providerId}\n`);
  log(`Models: ${provider.models.join(", ")}\n`);
  log(`Device Relay: ${service ? (service.active ? "running" : "installed") : "running"}\n`);
  log(accessPoints ? "The models are shared.\n" : "The Provider is ready for Access Point creation in Frely.\n");
  for (const line of await relayAllowanceLines(async () => (await fetchRelayUsage()).remainingBytes)) log(`${line}\n`);
  return { provider: ready, result };
}
