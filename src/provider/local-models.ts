import { DEFAULT_LOCAL_MODEL_URLS, fetchLocalModelIds, LocalModelAuthError, probeLocalEndpoints } from "./local.js";
import { shareLocalProvider } from "./share.js";
import { isSupportedLocalModelName, listLocalProviders, normalizeLoopbackOpenAiBaseUrl } from "./state.js";
import { readConfig } from "../auth.js";

/** The daemon's side of the `local_models` device tool: it probes and shares from the daemon process, never from the command sandbox. */
export interface LocalModelsHub {
  list(url: string | undefined, signal: AbortSignal): Promise<unknown>;
  share(input: { url: string; models?: string[]; name?: string }, signal: AbortSignal): Promise<unknown>;
}

const PROBE_TIMEOUT_MS = 2_000;
const MAX_LISTED_MODELS = 256;

/** What the tool says when an endpoint wants an API key: the key is typed at a terminal on the device, never passed through this tool. */
export function authRequiredHint(url: string): string {
  return `${url} needs an API key. Share it from a terminal on this computer: frely service share model --url ${url}  (the key is typed there; it never goes through this tool).`;
}

export const SHARE_NOTICE = "Uses one personal Provider slot; without a free slot it counts against the Creator Plan Provider limit.";

/** The call name a shared model gets: the model id, or its last `/` segment for ids such as `org/model`; mirrors the platform's self-use names. */
export function localCallName(modelId: string): string | null {
  const name = modelId.slice(modelId.lastIndexOf("/") + 1);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(name) ? name : null;
}

export interface LocalModelsHubOptions {
  /** The signed-in user's Frely username, when known; the account profile the CLI reads does not carry one today. */
  username?: () => Promise<string | null>;
  /** The share itself; the CLI's own `shareLocalProvider` unless a test replaces it. */
  share?: typeof shareLocalProvider;
}

export function createLocalModelsHub(options: LocalModelsHubOptions = {}): LocalModelsHub {
  return {
    async list(url, signal) {
      const shared = (await listLocalProviders()).map((provider) => ({ providerId: provider.providerId, name: provider.name, url: provider.baseUrl, models: provider.models, ...(provider.pending ? { pending: true } : {}) }));
      if (url) {
        const normalized = normalizeLoopbackOpenAiBaseUrl(url);
        try {
          return { servers: [{ url: normalized, models: (await fetchLocalModelIds(normalized, PROBE_TIMEOUT_MS)).slice(0, MAX_LISTED_MODELS) }], shared };
        } catch (error) {
          if (error instanceof LocalModelAuthError) return { servers: [{ url: normalized, authRequired: true, hint: authRequiredHint(normalized) }], shared };
          throw error;
        }
      }
      const urls = [...new Set([...DEFAULT_LOCAL_MODEL_URLS, ...shared.map((provider) => provider.url)])];
      const servers = (await probeLocalEndpoints(urls, PROBE_TIMEOUT_MS, signal)).map((probe) => probe.authRequired ? { url: probe.url, authRequired: true, hint: authRequiredHint(probe.url) } : probe);
      return { servers, shared };
    },
    async share(input, signal) {
      signal.throwIfAborted();
      const invalid = input.models?.find((model) => !isSupportedLocalModelName(model));
      if (invalid !== undefined) throw new Error(`Model name "${invalid}" is not supported: no whitespace, no leading or trailing "/", no "//".`);
      const result = await (options.share ?? shareLocalProvider)({ driver: "openai-compatible", url: input.url, ...(input.models?.length ? { models: input.models } : {}), ...(input.name ? { name: input.name } : {}), installService: false, accessPoints: true }, () => undefined)
        .catch((error: unknown) => { throw error instanceof LocalModelAuthError ? new Error(authRequiredHint(input.url)) : error; });
      const username = await (options.username ?? configUsername)().catch(() => null);
      const callNames = username ? [...new Set(result.provider.models.flatMap((model) => localCallName(model) ?? []))].map((name) => `${username}/${name}`) : null;
      return {
        providerId: result.provider.providerId, slot: result.slot, models: result.provider.models, ...(result.resumed ? { resumed: true } : {}),
        ...(result.accessPoints.length > 0 ? { accessPoints: result.accessPoints.map((item) => item.name) } : {}),
        ...(result.accessPointNote ? { accessPointNote: result.accessPointNote } : {}),
        ...(callNames ? { callNames } : { note: "The call names are <your Frely username>/<model>; call models_list (look for local: true) to find them." }),
        notice: SHARE_NOTICE,
      };
    },
  };
}

async function configUsername(): Promise<string | null> {
  return (await readConfig()).user.username ?? null;
}
