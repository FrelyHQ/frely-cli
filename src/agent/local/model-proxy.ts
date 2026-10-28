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

export interface ModelProxyOptions {
  socketPath: string;
  /** The gateway origin, for example https://api.frely.cloud. */
  upstream: string;
  /** The `Authorization` header value for one upstream call. Read per call so a renewed credential is used. */
  authorization(): Promise<string>;
  fetchFn?: typeof fetch;
}

export interface ModelProxy { close(): Promise<void> }

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

export async function startModelProxy(options: ModelProxyOptions): Promise<ModelProxy> {
  const fetchFn = options.fetchFn ?? fetch;
  const upstream = new URL(options.upstream);
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // The sandbox proxy sends an absolute URL; anything else did not come through it.
    let url: URL;
    try { url = new URL(request.url ?? ""); } catch { return reply(response, 404, "Unknown host."); }
    if (url.protocol !== "http:" || url.hostname !== MODEL_HOST) return reply(response, 404, "Unknown host.");
    const method = ROUTES.get(`${request.method} ${url.pathname}`);
    if (!method) return reply(response, 404, "This path is not available to a local Agent. It can call the model endpoints only.");
    const body = method === "POST" ? await readBody(request) : undefined;
    if (method === "POST" && body === undefined) return reply(response, 413, "The request is larger than 16 MiB.");
    const headers = new Headers();
    for (const name of FORWARD_REQUEST) { const value = request.headers[name]; if (typeof value === "string") headers.set(name, value); }
    try { headers.set("authorization", await options.authorization()); } catch (error) { return reply(response, 401, error instanceof Error ? error.message : "No Frely credential."); }
    const abort = new AbortController();
    response.once("close", () => abort.abort());
    let result: Response;
    try {
      result = await fetchFn(new URL(url.pathname + url.search, upstream), { method, headers, ...(body ? { body: new Uint8Array(body) } : {}), redirect: "error", signal: abort.signal });
    } catch {
      return reply(response, 502, "Frely could not be reached.");
    }
    const out: Record<string, string> = {};
    for (const name of FORWARD_RESPONSE) { const value = result.headers.get(name); if (value !== null) out[name] = value; }
    response.writeHead(result.status, out);
    if (!result.body) { response.end(); return; }
    const stream = Readable.fromWeb(result.body as never);
    stream.once("error", () => response.destroy());
    stream.pipe(response);
  };
  const server: Server = createServer((request, response) => { handle(request, response).catch(() => reply(response, 500, "The local model proxy failed.")); });
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
