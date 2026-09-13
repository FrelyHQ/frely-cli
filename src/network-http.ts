import { NetworkError } from "./network-errors.js";
export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export function normalizeNetworkOrigin(input: string, allowLoopback: boolean): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new NetworkError("NETWORK_ORIGIN_INVALID"); }
  if ((url.protocol !== "https:" && !(allowLoopback && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new NetworkError("NETWORK_ORIGIN_INVALID");
  return url.origin;
}
export interface NetworkHttpResponse { status: number; text: string; headers: Headers; }
export class NetworkHttp {
  constructor(private readonly fetcher: typeof fetch, private readonly timeoutMs: number) {}
  async request(origin: string, path: string, options: { body?: unknown; token?: string; method?: string; requestId?: string } = {}): Promise<NetworkHttpResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const run = async (): Promise<NetworkHttpResponse> => {
      const response = await this.fetcher(`${origin}${path}`, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"), redirect: "error",
        signal: controller.signal,
        headers: { accept: path === "/SKILL.md" ? "text/markdown" : "application/json",
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.requestId ? { "idempotency-key": options.requestId } : {}) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      if (response.redirected || (response.status >= 300 && response.status < 400) ||
          (response.url && new URL(response.url).origin !== origin)) throw new NetworkError("NETWORK_REDIRECT_REJECTED");
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let total = 0;
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            total += chunk.value.byteLength;
            if (total > 512 * 1024) { await reader.cancel(); throw new NetworkError("NETWORK_RESPONSE_TOO_LARGE"); }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
      }
      return { status: response.status, text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), headers: response.headers };
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new NetworkError("NETWORK_TIMEOUT")); }, this.timeoutMs);
    });
    try { return await Promise.race([run(), timeout]); }
    catch (error) { throw error instanceof NetworkError ? error : new NetworkError("NETWORK_REQUEST_FAILED"); }
    finally { clearTimeout(timer!); }
  }
  parse(response: NetworkHttpResponse, secrets: string[] = []): Record<string, unknown> {
    // No authenticated service response may reflect a credential to the host.
    if (secrets.some((secret) => secret.length >= 16 && response.text.includes(secret))) throw new NetworkError("NETWORK_RESPONSE_INVALID");
    let value: unknown;
    try { value = JSON.parse(response.text); } catch { throw new NetworkError("NETWORK_RESPONSE_INVALID"); }
    if (!isRecord(value)) throw new NetworkError("NETWORK_RESPONSE_INVALID");
    return value;
  }
}
