import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";

/**
 * The local gate of a share: frpc points only at this loopback server, never at the user's service. It serves a request only when the Host
 * is the share's own name, refuses `CONNECT` and absolute-form targets (so the share cannot be used as a proxy), drops Frely's and frp's
 * internal headers, and forwards to the one registered loopback port without following redirects. WebSocket upgrades are passed through
 * as bytes. The link token is checked at the edge (the share Caddy), this is the second layer.
 */
export interface GatewayOptions {
  /** The share's public host name, e.g. `s0123456789abcd.share.example`. */
  readonly host: string;
  /** The user's service on 127.0.0.1. */
  readonly targetPort: number;
  /** Send `Host: localhost:<port>` upstream; dev servers such as Vite refuse unknown host names. */
  readonly rewriteHost?: boolean;
  readonly maxConnections?: number;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
const INTERNAL = /^(x-frely-|x-frp-|x-forwarded-(host|proto|port|server))/u;

export function hostOnly(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/:\d+$/u, "");
}

/** The headers forwarded upstream: no hop-by-hop or internal headers, and the forwarding facts set here. */
export function upstreamHeaders(headers: IncomingHttpHeaders, options: GatewayOptions, keepUpgrade = false): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || INTERNAL.test(name)) continue;
    if (HOP_BY_HOP.has(name) && !(keepUpgrade && (name === "upgrade" || name === "connection"))) continue;
    out[name] = value;
  }
  out["x-forwarded-host"] = options.host;
  out["x-forwarded-proto"] = "https";
  if (options.rewriteHost) out.host = `localhost:${options.targetPort}`;
  return out;
}

function refuse(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end(`${message}\n`);
}

/** A request for another host, an absolute-form target or a path that is not a path is not served. */
export function admissible(request: Pick<IncomingMessage, "headers" | "url" | "method">, host: string): string | null {
  if (hostOnly(request.headers.host) !== host) return "wrong host";
  if (!request.url || !request.url.startsWith("/") || request.url.startsWith("//")) return "bad target";
  if (request.method === "CONNECT") return "method not allowed";
  return null;
}

export function startGateway(options: GatewayOptions): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const host = options.host.toLowerCase();
  const server = createServer((request, response) => {
    const problem = admissible(request, host);
    if (problem) return refuse(response, problem === "method not allowed" ? 405 : 404, "Not found");
    const upstream = httpRequest({ host: "127.0.0.1", port: options.targetPort, method: request.method, path: request.url, headers: upstreamHeaders(request.headers, options) }, (reply) => {
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(reply.headers)) if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
      response.writeHead(reply.statusCode ?? 502, reply.statusMessage, headers);
      reply.pipe(response);
    });
    upstream.once("error", () => refuse(response, 502, "The shared service is not reachable on this computer."));
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on("connect", (_request, socket) => { socket.end("HTTP/1.1 405 Method Not Allowed\r\nconnection: close\r\n\r\n"); });
  server.on("upgrade", (request, socket: Socket, head) => {
    if (admissible(request, host)) { socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n"); return; }
    const upstream = netConnect({ host: "127.0.0.1", port: options.targetPort });
    const close = () => { socket.destroy(); upstream.destroy(); };
    upstream.once("error", () => { if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n"); upstream.destroy(); });
    socket.once("error", close);
    upstream.once("connect", () => {
      const headers = upstreamHeaders(request.headers, options, true);
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) for (const item of Array.isArray(value) ? value : [value]) if (!/[\r\n]/u.test(item)) lines.push(`${name}: ${item}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.once("close", close);
    socket.once("close", close);
  });
  server.maxConnections = options.maxConnections ?? 256;
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("The share gateway has no port."));
      resolve({ server, port: address.port, close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }) });
    });
  });
}
