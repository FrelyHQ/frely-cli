import { connect } from "node:net";
import type { Readable, Writable } from "node:stream";

/** The longest proxy reply header accepted before the tunnel is refused. */
const MAX_HEADER_BYTES = 16 * 1024;
const HANDSHAKE_TIMEOUT_MS = 30_000;

export interface ProxyEndpoint { host: string; port: number; authorization?: string }

/** The host, port and Basic credentials of an `http://[user:password@]host:port` proxy URL, as the sandbox exports it in HTTP_PROXY. */
export function parseProxyUrl(value: string): ProxyEndpoint {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("HTTP_PROXY is not a valid proxy URL."); }
  if (url.protocol !== "http:") throw new Error("HTTP_PROXY must be an http:// proxy URL.");
  const port = Number(url.port || 80);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("HTTP_PROXY has no usable host or port.");
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (!url.username && !url.password) return { host, port };
  const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return { host, port, authorization: `Basic ${Buffer.from(credentials).toString("base64")}` };
}

/**
 * Opens an HTTP CONNECT tunnel to `target` through the proxy and relays `input`/`output` over it, like `nc -X connect` but with
 * proxy authentication. It is what ssh runs as ProxyCommand inside the macOS sandbox, where the stock `nc` can only speak SOCKS5
 * without credentials. Nothing from the proxy reply header reaches `output`; the credentials are never printed.
 */
export function sshProxyConnect(options: { proxyUrl: string; host: string; port: number; input: Readable; output: Writable }): Promise<void> {
  const proxy = parseProxyUrl(options.proxyUrl);
  const authority = `${options.host.includes(":") ? `[${options.host}]` : options.host}:${options.port}`;
  return new Promise((resolve, reject) => {
    const socket = connect({ host: proxy.host, port: proxy.port });
    let header = Buffer.alloc(0);
    let tunnelled = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("The proxy did not answer the CONNECT request in time.")), HANDSHAKE_TIMEOUT_MS);
    socket.once("connect", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${proxy.authorization ? `Proxy-Authorization: ${proxy.authorization}\r\n` : ""}\r\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      if (tunnelled) { options.output.write(chunk); return; }
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf("\r\n\r\n");
      if (end === -1) {
        if (header.length > MAX_HEADER_BYTES) finish(new Error("The proxy reply is too large."));
        return;
      }
      const status = /^HTTP\/1\.[01] (\d{3})/u.exec(header.subarray(0, end).toString("latin1"));
      if (!status || !status[1]!.startsWith("2")) {
        finish(new Error(status ? `The proxy refused the tunnel (HTTP ${status[1]}).` : "The proxy sent an invalid reply."));
        return;
      }
      tunnelled = true;
      clearTimeout(timer);
      const rest = header.subarray(end + 4);
      if (rest.length > 0) options.output.write(rest);
      options.input.on("data", (data: Buffer) => socket.write(data));
      options.input.once("end", () => socket.end());
    });
    socket.once("end", () => { if (!tunnelled) finish(new Error("The proxy closed the connection before answering.")); else finish(); });
    socket.once("error", (error) => finish(new Error(`Cannot reach the proxy: ${error.message}`)));
    options.output.once("error", () => finish());
  });
}
