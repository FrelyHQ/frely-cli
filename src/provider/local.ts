import { DEVICE_RELAY_MAX_FRAME_BYTES } from "../device/protocol.js";
import { getLocalProvider, isSupportedLocalModelName, normalizeLoopbackOpenAiBaseUrl } from "./state.js";

const PROVIDER_RESPONSE_LIMIT = DEVICE_RELAY_MAX_FRAME_BYTES - 64 * 1024;
const ALLOWED_PATHS = new Set(["/v1/models", "/v1/chat/completions", "/v1/embeddings", "/v1/responses"]);

export async function discoverLocalModels(baseUrlInput: string): Promise<string[]> {
  const baseUrl = normalizeLoopbackOpenAiBaseUrl(baseUrlInput);
  const response = await fetch(`${baseUrl}/models`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
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
  const unique = [...new Set(models)].sort();
  if (unique.length === 0) throw new Error("Local Provider did not report any models.");
  if (unique.length > 256) throw new Error("Local Provider reported too many models.");
  return unique;
}

export interface LocalProviderResponse {
  status: number;
  contentType: "application/json" | "text/event-stream";
  response: Response;
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
  const baseUrl = normalizeLoopbackOpenAiBaseUrl(provider.baseUrl);
  const target = `${baseUrl}${path.slice(3)}`;
  const response = await fetch(target, {
    method,
    headers: method === "POST" ? { accept: "application/json, text/event-stream", "content-type": "application/json" } : { accept: "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(request.body ?? {}) } : {}),
    redirect: "error",
    ...(signal ? { signal } : {}),
  });
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "application/json";
  if (contentType !== "application/json" && contentType !== "text/event-stream") throw new Error("Local Provider returned an unsupported content type.");
  return { status: response.status, contentType, response };
}

export async function executeLocalProviderRequest(payload: unknown, signal?: AbortSignal): Promise<{ status: number; contentType: string; body: string }> {
  const opened = await openLocalProviderRequest(payload, signal);
  return { status: opened.status, contentType: opened.contentType, body: await readLocalProviderBody(opened.response) };
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
