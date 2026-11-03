import { createHash } from "node:crypto";
import { join } from "node:path";
import { requireLogin } from "../auth.js";
import { gatewayOrigin, readApiKey } from "../agent/local/confine.js";
import { MODEL_HOST, startModelProxy, type ProxyCall, type ProxyRoute } from "../agent/local/model-proxy.js";
import { isSandboxDisabled } from "../runtime/sandbox.js";
import { acquireEndpointSlot } from "../provider/endpoint-slots.js";
import { readProviderKey } from "../provider/key.js";
import { defaultEndpointLimit, listLocalProviders, type LocalProviderBinding } from "../provider/state.js";
import { tasksDir } from "./definition.js";
import type { TaskRunRecord } from "./run-store.js";

/** Calls to the Frely gateway that may run at once from this computer. */
export const GATEWAY_LIMIT = 6;
const PROBE_TIMEOUT_MS = 5_000;
/** A task waits this long for a free call slot of an endpoint before the call is answered "busy". */
const SLOT_WAIT_MS = 10 * 60_000;

export interface OpenedModel {
  readonly baseUrl: string;
  readonly name: string;
  readonly close: () => Promise<void>;
  readonly allowedDomains: readonly string[];
  readonly mitmProxy?: { socketPath: string; domains: readonly string[] };
  /** What the proxy served, for the local record. */
  readonly stats: () => ModelStats;
}

export interface ModelStats { readonly requests: number; readonly failures: number; readonly byRoute: Readonly<Record<string, number>> }

export interface RouteDeps {
  readonly providers?: () => Promise<LocalProviderBinding[]>;
  readonly fetchFn?: typeof fetch;
  /** The gateway origin and API key, or the reason there is none. */
  readonly gateway?: () => Promise<{ origin: string; key: string } | { reason: string }>;
  readonly socketDir?: string;
}

async function defaultGateway(): Promise<{ origin: string; key: string } | { reason: string }> {
  const login = await requireLogin().catch(() => null);
  if (!login) return { reason: "not signed in to Frely (run frely login)" };
  const origin = gatewayOrigin(login.config.relayUrl);
  const key = await readApiKey(origin);
  return key ? { origin, key } : { reason: `no Frely API key (create one at ${login.config.relayUrl}/user/keys, then run frely agent local key --api-key-stdin)` };
}

interface Probe { readonly ok: boolean; readonly reason?: string }

/** The three start failures that fall back to the next model: unreachable, unknown model, rejected key. Anything else (slow, poor answers) does not. */
async function probe(url: string, key: string | undefined, model: string, fetchFn: typeof fetch): Promise<Probe> {
  let response: Response;
  try {
    response = await fetchFn(`${url}/models`, { headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, redirect: "error", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (error) {
    return { ok: false, reason: `cannot connect (${error instanceof Error ? error.message : String(error)})` };
  }
  if (response.status === 401 || response.status === 403) { await response.body?.cancel().catch(() => undefined); return { ok: false, reason: "the key was rejected" }; }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); return { ok: false, reason: `the endpoint answered HTTP ${response.status}` }; }
  try {
    const body = await response.json() as { data?: Array<{ id?: unknown }> };
    const ids = Array.isArray(body.data) ? body.data.flatMap((item) => (typeof item.id === "string" ? [item.id] : [])) : [];
    if (ids.length > 0 && !ids.includes(model)) return { ok: false, reason: "the model is not offered there" };
  } catch { /* A server that lists no models in a form we can read: take the model as offered. */ }
  return { ok: true };
}

function localRoute(provider: LocalProviderBinding): ProxyRoute {
  const base = provider.baseUrl;
  return {
    label: provider.providerId,
    url: (path) => new URL(base + path.slice(3)),
    authorization: async () => {
      if (!provider.hasKey) return undefined;
      const key = await readProviderKey(provider.providerId);
      if (!key) throw new Error("The upstream key of this model endpoint is missing on this computer.");
      return `Bearer ${key}`;
    },
    acquire: () => acquireEndpointSlot(base, provider.maxConcurrent ?? defaultEndpointLimit(base), { kind: "task", waitMs: SLOT_WAIT_MS }),
  };
}

function gatewayRoute(origin: string, key: string): ProxyRoute {
  return {
    label: "gateway",
    url: (path) => new URL(path, origin),
    authorization: async () => `Bearer ${key}`,
    acquire: () => acquireEndpointSlot(`gateway:${origin}`, GATEWAY_LIMIT, { kind: "task", waitMs: SLOT_WAIT_MS }),
  };
}

/**
 * Starts the model proxy for one run and picks the model: the first of the task's model and its fallbacks that can be started.
 * A model that a local Provider on this computer offers is called directly (no relay, no Credit, works without Frely); any other model
 * goes to the Frely gateway with the account's API key. The program only ever sees a placeholder key.
 */
export async function openTaskModel(record: TaskRunRecord, log: (text: string) => void, deps: RouteDeps = {}): Promise<OpenedModel | undefined> {
  const requested = record.snapshot.model;
  if (requested === undefined) return undefined;
  const fetchFn = deps.fetchFn ?? fetch;
  const providers = (await (deps.providers ?? listLocalProviders)()).filter((provider) => !provider.pending);
  const ownerOf = (model: string): LocalProviderBinding | undefined => providers.find((provider) => provider.models.includes(model));
  const gateway = await (deps.gateway ?? defaultGateway)();
  const failures: string[] = [];
  let chosen: { model: string; route: ProxyRoute } | undefined;
  for (const model of [requested, ...(record.snapshot.fallbackModels ?? [])]) {
    const local = ownerOf(model);
    if (local) {
      const key = local.hasKey ? await readProviderKey(local.providerId) : undefined;
      if (local.hasKey && !key) { failures.push(`${model}: the upstream key is missing on this computer`); continue; }
      const result = await probe(local.baseUrl, key, model, fetchFn);
      if (result.ok) { chosen = { model, route: localRoute(local) }; break; }
      failures.push(`${model} at ${local.baseUrl}: ${result.reason}`);
      log(`Model ${model} cannot be started (${result.reason}).`);
      continue;
    }
    if ("reason" in gateway) { failures.push(`${model}: ${gateway.reason}`); log(`Model ${model} cannot be started (${gateway.reason}).`); continue; }
    const result = await probe(`${gateway.origin}/v1`, gateway.key, model, fetchFn);
    if (result.ok) { chosen = { model, route: gatewayRoute(gateway.origin, gateway.key) }; break; }
    failures.push(`${model} at Frely: ${result.reason}`);
    log(`Model ${model} cannot be started (${result.reason}).`);
  }
  if (!chosen) throw new Error(`No model could be started. ${failures.join("; ")}`);
  if (chosen.model !== requested) log(`Using ${chosen.model} instead of ${requested}.`);

  const stats = { requests: 0, failures: 0, byRoute: {} as Record<string, number> };
  const onCall = (call: ProxyCall): void => {
    stats.requests += 1;
    if (call.status >= 400) stats.failures += 1;
    stats.byRoute[call.route] = (stats.byRoute[call.route] ?? 0) + 1;
  };
  const route = async (request: { model: string | undefined }) => {
    if (request.model === undefined || request.model === chosen!.model) return chosen!.route;
    const local = ownerOf(request.model);
    if (local) return localRoute(local);
    if ("reason" in gateway) return { status: 502, message: `The model ${request.model} is not on this computer and Frely cannot be used: ${gateway.reason}.` };
    return gatewayRoute(gateway.origin, gateway.key);
  };
  const socketPath = join(deps.socketDir ?? process.env.XDG_RUNTIME_DIR ?? tasksDir(), `t-${createHash("sha256").update(record.runId).digest("hex").slice(0, 10)}.sock`);
  // With the sandbox on, the sandbox proxy hands the model host's requests to the socket. With it off there is no such proxy: listen on loopback.
  const direct = isSandboxDisabled();
  const proxy = await startModelProxy({ socketPath, route, onCall, ...(direct ? { tcp: true } : {}), ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}) });
  return {
    baseUrl: proxy.baseUrl ?? `http://${MODEL_HOST}/v1`,
    name: chosen.model,
    close: proxy.close,
    allowedDomains: direct ? [] : [MODEL_HOST],
    ...(direct ? {} : { mitmProxy: { socketPath, domains: [MODEL_HOST] } }),
    stats: () => stats,
  };
}
