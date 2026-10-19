import { requireLogin } from "../auth.js";
import { ensureDevice } from "../device/control.js";
import { createLocalProviderToken, loadOrCreateDeviceIdentity } from "../device/identity.js";
import { installDeviceRelayService } from "../service.js";
import { finalizeLocalProvider, listPersonalProviderSlots, prepareLocalProvider, waitForLocalProviderRelay } from "./control.js";
import { discoverLocalModels } from "./local.js";
import { isSupportedLocalModelName, listLocalProviders, normalizeLoopbackOpenAiBaseUrl, saveLocalProvider, type LocalProviderBinding } from "./state.js";

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
  /** False inside the running daemon: reinstalling its own service would restart the process serving this call. */
  installService?: boolean;
}

export interface ShareLocalProviderResult {
  provider: LocalProviderBinding;
  slot: "personal" | "creator";
  /** True when a Provider prepared earlier was finished instead of preparing a new one. */
  resumed: boolean;
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
    const ready = await activateLocalProvider(auth, device.deviceId, pending, log, installService);
    return { provider: ready, slot: pending.slot ?? "personal", resumed: true };
  }
  const driver = input.driver;
  const defaultUrl = driver === "ollama" ? "http://127.0.0.1:11434/v1" : "http://127.0.0.1:8080/v1";
  const baseUrl = normalizeLoopbackOpenAiBaseUrl(input.url ?? defaultUrl);
  const selected = input.models?.map((value) => value.trim()).filter(Boolean);
  const models = selected?.length ? [...new Set(selected)] : await discoverLocalModels(baseUrl);
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
  const provider = { providerId: prepared.providerId, name, driver, baseUrl, providerBaseUrl: prepared.providerBaseUrl, models, createdAt: new Date().toISOString(), slot: kind, pending: true } as const;
  await saveLocalProvider(provider);
  const ready = await activateLocalProvider(auth, device.deviceId, provider, log, installService);
  return { provider: ready, slot: kind, resumed: false };
}

async function activateLocalProvider(auth: Awaited<ReturnType<typeof requireLogin>>, deviceId: string, provider: LocalProviderBinding, log: Log, installService: boolean): Promise<LocalProviderBinding> {
  const service = installService ? await installDeviceRelayService() : null;
  const identity = await loadOrCreateDeviceIdentity(auth.config.relayUrl, auth.user.id);
  const token = createLocalProviderToken(identity, deviceId, auth.user.id, provider.providerId);
  try {
    await waitForLocalProviderRelay(provider.providerBaseUrl, token);
    await finalizeLocalProvider({ providerId: provider.providerId, token });
  } catch (error) {
    throw new Error(`Provider ${provider.providerId} is prepared but not ready. Run \`frely provider share\` again to resume. ${error instanceof Error ? error.message : String(error)}`);
  }
  const { pending: _pending, ...ready } = provider;
  await saveLocalProvider(ready);
  log(`Provider: ${provider.providerId}\n`);
  log(`Models: ${provider.models.join(", ")}\n`);
  log(`Device Relay: ${service ? (service.active ? "running" : "installed") : "running"}\n`);
  log("The Provider is ready for Access Point creation in Frely.\n");
  return ready;
}
