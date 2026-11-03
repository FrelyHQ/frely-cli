import { DEVICE_RELAY_MAX_FRAME_BYTES } from "../device/protocol.js";
import { acquireEndpointSlot, type ReleaseSlot } from "./endpoint-slots.js";
import { readProviderKey } from "./key.js";
import { defaultEndpointLimit, getLocalProvider, isSupportedLocalModelName, normalizeLocalOpenAiBaseUrl, normalizeLoopbackOpenAiBaseUrl } from "./state.js";

const PROVIDER_RESPONSE_LIMIT = DEVICE_RELAY_MAX_FRAME_BYTES - 64 * 1024;
const ALLOWED_PATHS = new Set(["/v1/models", "/v1/chat/completions", "/v1/embeddings", "/v1/responses"]);

export async function discoverLocalModels(baseUrlInput: string, options: { key?: string; lan?: boolean } = {}): Promise<string[]> {
  const unique = await fetchLocalModelIds(baseUrlInput, 15_000, options);
  if (unique.length === 0) throw new Error("Local Provider did not report any models.");
  if (unique.length > 256) throw new Error("Local Provider reported too many models.");
  return unique;
}

/** The sorted, unique, shareable model ids a loopback OpenAI-compatible server reports on `GET /models`; empty when it reports none. */
export async function fetchLocalModelIds(baseUrlInput: string, timeoutMs: number, options: { key?: string; lan?: boolean } = {}): Promise<string[]> {
  // Only an owner at the terminal may name a LAN address (`lan: true`); a probe asked for by a remote caller stays on loopback.
  const baseUrl = options.lan === true ? normalizeLocalOpenAiBaseUrl(baseUrlInput) : normalizeLoopbackOpenAiBaseUrl(baseUrlInput);
  const response = await fetch(`${baseUrl}/models`, { headers: { accept: "application/json", ...(options.key ? { authorization: `Bearer ${options.key}` } : {}) }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  const text = await readBounded(response, 2 * 1024 * 1024);
  if (!response.ok) throw new Error(`Local Provider model discovery failed with HTTP ${response.status}.`);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Local Provider /v1/models returned invalid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Local Provider /v1/models returned an invalid catalog.");
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data)) throw new Error("Local Provider /v1/models returned an invalid catalog.");
  const models: string[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = (item as Record<string, unknown>).id;
    if (typeof id === "string" && isSupportedLocalModelName(id)) models.push(id);
  }
  return [...new Set(models)].sort();
}

export interface LocalProviderResponse {
  status: number;
  contentType: "application/json" | "text/event-stream";
  response: Response;
  /** Gives the endpoint's call slot back; call it when the response has been read (or the call was cancelled). */
  release?: ReleaseSlot;
}

export async function openLocalProviderRequest(payload: unknown, signal?: AbortSignal): Promise<LocalProviderResponse> {
  const record = object(payload, "Local Provider relay payload");
  const providerId = string(record.providerId, "providerId", 64);
  const request = object(record.request, "Local Provider request");
  const method = request.method === "GET" || request.method === "POST" ? request.method : null;
  const path = typeof request.path === "string" ? request.path : "";
  if (!method || !ALLOWED_PATHS.has(path) || (path === "/v1/models" ? method !== "GET" : method !== "POST")) throw new Error("Local Provider relay request is not allowed.");
  const provider = await getLocalProvider(providerId);
  if (!provider) throw new Error("Local Provider is not configured on this device.");
  // A registration that stays on this computer is for this computer's tasks; remote callers never reach it.
  if (provider.localOnly) throw new Error("Local Provider is not shared.");
  const baseUrl = normalizeLocalOpenAiBaseUrl(provider.baseUrl);
  const target = `${baseUrl}${path.slice(3)}`;
  // The endpoint's limit is shared with this computer's own tasks, which go first: a buyer is told "busy" instead of queueing behind them.
  const release = await acquireEndpointSlot(baseUrl, provider.maxConcurrent ?? defaultEndpointLimit(baseUrl), { kind: "remote" });
  if (!release) {
    return { status: 429, contentType: "application/json", response: new Response(JSON.stringify({ error: { message: "This model endpoint is busy. Try again shortly.", type: "endpoint_busy" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "5" } }) };
  }
  try {
    const key = provider.hasKey ? await readProviderKey(provider.providerId) : undefined;
    if (provider.hasKey && !key) throw new Error("The upstream key of this Provider is missing on this computer.");
    const response = await fetch(target, {
      method,
      headers: {
        ...(method === "POST" ? { accept: "application/json, text/event-stream", "content-type": "application/json" } : { accept: "application/json" }),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(request.body ?? {}) } : {}),
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "application/json";
    if (contentType !== "application/json" && contentType !== "text/event-stream") { await response.body?.cancel().catch(() => undefined); throw new Error("Local Provider returned an unsupported content type."); }
    return { status: response.status, contentType, response, release };
  } catch (error) {
    await release();
    throw error;
  }
}

export async function executeLocalProviderRequest(payload: unknown, signal?: AbortSignal): Promise<{ status: number; contentType: string; body: string }> {
  const opened = await openLocalProviderRequest(payload, signal);
  try { return { status: opened.status, contentType: opened.contentType, body: await readLocalProviderBody(opened.response) }; } finally { await opened.release?.(); }
}

export async function readLocalProviderBody(response: Response): Promise<string> {
  return readBounded(response, PROVIDER_RESPONSE_LIMIT);
}

async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Local Provider response exceeds the Device Relay limit.");
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(output);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw new Error(`${label} is invalid.`);
  return value;
}
