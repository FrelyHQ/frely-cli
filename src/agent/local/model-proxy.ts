import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";

/**
 * The name the Agent's program uses for model access, as plain http:// (`OPENAI_BASE_URL=http://frely-model.local/v1`).
 * The sandbox's own proxy hands every request for this name to the Unix socket below, so the request reaches this file and nothing else.
 * The program therefore never holds a Frely credential: it sends a placeholder key, and the real one is added here, outside the sandbox.
 */
export const MODEL_HOST = "frely-model.local";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Only the model calls: nothing about the account, keys or billing. */
const ROUTES: ReadonlyMap<string, string> = new Map([
  ["POST /v1/chat/completions", "POST"], ["POST /v1/responses", "POST"], ["POST /v1/embeddings", "POST"],
  ["POST /v1/messages", "POST"], ["POST /v1/messages/count_tokens", "POST"], ["GET /v1/models", "GET"],
]);
/** Request headers passed on. Everything else, above all anything that authenticates, is dropped. */
const FORWARD_REQUEST = ["content-type", "accept", "anthropic-version", "anthropic-beta", "openai-beta"] as const;
const FORWARD_RESPONSE = ["content-type", "cache-control", "retry-after", "x-request-id"] as const;

/** Where one call goes: an endpoint's URL for a path, the credential it takes, and the call slot it holds while it runs. */
export interface ProxyRoute {
  /** Short name for the local record ("gateway", or the Provider's id). */
  readonly label: string;
  /** The upstream URL for a request path such as `/v1/chat/completions?x=1`. */
  url(pathAndQuery: string): URL;
  /** The `Authorization` header value; undefined sends none (an endpoint without a key). */
  authorization(): Promise<string | undefined>;
  /** Takes the endpoint's call slot; undefined means the endpoint is busy and the caller is told so. */
  acquire?(): Promise<(() => Promise<void>) | undefined>;
}

export interface ProxyCall { readonly route: string; readonly model?: string; readonly status: number; readonly durationMs: number }

export interface ModelProxyOptions {
  /** The Unix socket the sandbox proxy hands the model host's requests to. Unused with `tcp`. */
  socketPath: string;
  /** Listen on 127.0.0.1 instead, for a program that runs without the sandbox (the owner turned it off): nothing can rewrite its requests to the model host. */
  tcp?: boolean;
  /** The gateway origin, for example https://api.frely.cloud. Used when no `route` is given. */
  upstream?: string;
  /** The `Authorization` header value for one upstream call. Read per call so a renewed credential is used. Used when no `route` is given. */
  authorization?(): Promise<string>;
  /** Picks the endpoint per call, by the model the program asked for; a refusal is sent to the program as is. */
  route?(request: { model: string | undefined; path: string }): Promise<ProxyRoute | { status: number; message: string }>;
  /** Called once per finished call, for the local record. Never carries a request or response body. */
  onCall?(call: ProxyCall): void;
  fetchFn?: typeof fetch;
}

export interface ModelProxy {
  close(): Promise<void>;
  /** Set when the proxy listens on loopback TCP (`tcp: true`): the base URL a program on this computer calls. */
  readonly baseUrl?: string;
}

function reply(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message, type: "frely_local_proxy" } }));
}

/** The body, or undefined when it is over the limit. An oversize body is still read to its end (not kept) so the sender gets the refusal instead of a broken pipe. */
async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 4 * MAX_BODY_BYTES) { request.destroy(); break; }
    if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer);
  }
  return size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks);
}

function requestedModel(body: Buffer): string | undefined {
  try {
    const value = JSON.parse(body.toString("utf8")) as { model?: unknown };
    return typeof value.model === "string" && value.model.length <= 256 ? value.model : undefined;
  } catch { return undefined; }
}

export async function startModelProxy(options: ModelProxyOptions): Promise<ModelProxy> {
  const fetchFn = options.fetchFn ?? fetch;
  if (!options.route && (options.upstream === undefined || options.authorization === undefined)) throw new Error("A model proxy needs a route or an upstream with its credential.");
  const fixed: ProxyRoute | undefined = options.route ? undefined : { label: "gateway", url: (path) => new URL(path, new URL(options.upstream!)), authorization: options.authorization! };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // The sandbox proxy sends an absolute URL; anything else did not come through it.
    let url: URL;
    try { url = new URL(request.url ?? "", options.tcp && request.url?.startsWith("/") ? `http://${MODEL_HOST}` : undefined); } catch { return reply(response, 404, "Unknown host."); }
    if (url.protocol !== "http:" || url.hostname !== MODEL_HOST) return reply(response, 404, "Unknown host.");
    const method = ROUTES.get(`${request.method} ${url.pathname}`);
    if (!method) return reply(response, 404, "This path is not available to a local Agent. It can call the model endpoints only.");
    const body = method === "POST" ? await readBody(request) : undefined;
    if (method === "POST" && body === undefined) return reply(response, 413, "The request is larger than 16 MiB.");
    const headers = new Headers();
    for (const name of FORWARD_REQUEST) { const value = request.headers[name]; if (typeof value === "string") headers.set(name, value); }
    const model = body ? requestedModel(body) : undefined;
    const chosen = fixed ?? await options.route!({ model, path: url.pathname });
    if (!("url" in chosen)) return reply(response, chosen.status, chosen.message);
    const release = await chosen.acquire?.();
    if (chosen.acquire && !release) { response.setHeader("retry-after", "5"); return reply(response, 429, "The model endpoint is busy. Try again shortly."); }
    const abort = new AbortController();
    const started = Date.now();
    const finish = (status: number): void => { options.onCall?.({ route: chosen.label, ...(model === undefined ? {} : { model }), status, durationMs: Date.now() - started }); void release?.(); };
    response.once("close", () => abort.abort());
    try {
      const credential = await chosen.authorization();
      if (credential !== undefined) headers.set("authorization", credential);
    } catch (error) { finish(401); return reply(response, 401, error instanceof Error ? error.message : "No Frely credential."); }
    let result: Response;
    try {
      result = await fetchFn(chosen.url(url.pathname + url.search), { method, headers, ...(body ? { body: new Uint8Array(body) } : {}), redirect: "error", signal: abort.signal });
    } catch {
      finish(502);
      return reply(response, 502, chosen.label === "gateway" ? "Frely could not be reached." : "The model endpoint could not be reached.");
    }
    const out: Record<string, string> = {};
    for (const name of FORWARD_RESPONSE) { const value = result.headers.get(name); if (value !== null) out[name] = value; }
    response.writeHead(result.status, out);
    if (!result.body) { response.end(); finish(result.status); return; }
    const stream = Readable.fromWeb(result.body as never);
    stream.once("error", () => response.destroy());
    response.once("close", () => finish(result.status));
    stream.pipe(response);
  };
  const server: Server = createServer((request, response) => { handle(request, response).catch(() => reply(response, 500, "The local model proxy failed.")); });
  if (options.tcp) {
    await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { baseUrl: `http://127.0.0.1:${port}/v1`, close: async () => { await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }); } };
  }
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  await rm(options.socketPath, { force: true });
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(options.socketPath, done); });
  await chmod(options.socketPath, 0o600).catch(() => undefined);
  return {
    close: async () => {
      await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
      await rm(options.socketPath, { force: true });
    },
  };
}
