import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

/**
 * `web_fetch`: an HTTP request made from this device, so a hosted Agent's web access leaves from the owner's own network
 * instead of Frely's servers (plan mcp/云Agent借用户本机磁盘与网络).
 *
 * The request reaches only the public internet. Every address the host name resolves to is checked, the connection is pinned to
 * the checked address, ports are limited to 80/443, and each redirect is checked again. Loopback, private, link-local, CGNAT,
 * cloud-metadata and other special-purpose ranges are refused, so a prompt-injected Agent cannot use the owner's machine to
 * reach their router, NAS, local services or cloud metadata endpoint.
 */

export const WEB_FETCH_DEFAULT_BYTES = 256 * 1024;
export const WEB_FETCH_MAX_BYTES = 1024 * 1024;
export const WEB_FETCH_MAX_REQUEST_BODY = 256 * 1024;
const MAX_REDIRECTS = 5;
const ALLOWED_PORTS = new Set([80, 443]);
const METHODS = ["GET", "HEAD", "POST"] as const;
type WebFetchMethod = (typeof METHODS)[number];
const FORBIDDEN_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "upgrade", "proxy-authorization", "te", "expect"]);

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(network, prefix, "ipv6");

/** True when the address is not a plain public internet address. IPv4-mapped and NAT64 IPv6 forms are judged by the IPv4 address inside. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family !== 6) return true;
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/iu.exec(address);
  if (mapped?.[1]) return blocked.check(mapped[1], "ipv4");
  const hexMapped = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(address);
  if (hexMapped) {
    const high = Number.parseInt(hexMapped[1]!, 16), low = Number.parseInt(hexMapped[2]!, 16);
    return blocked.check(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, "ipv4");
  }
  return blocked.check(address, "ipv6");
}

export interface WebFetchArgs {
  url: string;
  method?: WebFetchMethod;
  headers?: Record<string, string>;
  body?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface WebFetchResult {
  url: string;
  status: number;
  contentType: string | null;
  redirects: number;
  truncated: boolean;
  /** UTF-8 text; non-text responses are replaced by a one-line description. */
  body: string;
}

export interface WebFetchOptions {
  signal?: AbortSignal;
  /** Test seam: replaces DNS. Production always resolves through the system resolver. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Test seam: host names exempt from the address and port checks so a loopback test server can answer. Never set in production. */
  trustedTestHosts?: readonly string[];
}

async function resolveHost(hostname: string, options: WebFetchOptions): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  if (options.resolve) return options.resolve(hostname);
  return (await dnsLookup(hostname, { all: true })).map((entry) => entry.address);
}

async function checkedTarget(url: URL, options: WebFetchOptions): Promise<{ address: string }> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs can be fetched.");
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed.");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const trusted = options.trustedTestHosts?.includes(hostname) === true;
  if (!trusted && !ALLOWED_PORTS.has(port)) throw new Error("Only ports 80 and 443 can be fetched.");
  const addresses = await resolveHost(hostname, options);
  if (addresses.length === 0) throw new Error(`Could not resolve ${hostname}.`);
  if (!trusted && addresses.some(isBlockedAddress)) {
    throw new Error("This address is on a private or local network, which web_fetch does not reach.");
  }
  return { address: addresses[0]! };
}

function readText(contentType: string | null, bytes: Buffer): string {
  const text = !contentType || /^(?:text\/|application\/(?:json|xml|xhtml\+xml|javascript|x-www-form-urlencoded|ld\+json|rss\+xml|atom\+xml)|image\/svg\+xml)|\+(?:json|xml)\b/iu.test(contentType);
  return text ? bytes.toString("utf8") : `[${contentType} response, ${bytes.length} bytes, not shown as text]`;
}

function once(url: URL, method: WebFetchMethod, headers: Record<string, string>, body: string | undefined, address: string, maxBytes: number, timeoutMs: number, signal: AbortSignal | undefined): Promise<{ status: number; location: string | null; contentType: string | null; bytes: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    const family = isIP(address) === 6 ? 6 : 4;
    const request = (secure ? httpsRequest : httpRequest)({
      protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/gu, ""), port: url.port || undefined, path: `${url.pathname}${url.search}`, method, headers,
      // Pin the connection to the address that was checked; the system resolver is never asked again.
      lookup: (_host, _options, callback) => (_options as { all?: boolean }).all ? (callback as unknown as (error: null, list: Array<{ address: string; family: number }>) => void)(null, [{ address, family }]) : callback(null, address, family),
      ...(secure && !isIP(url.hostname.replace(/^\[|\]$/gu, "")) ? { servername: url.hostname } : {}),
      agent: false,
      timeout: timeoutMs,
      ...(signal ? { signal } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      response.on("data", (chunk: Buffer) => {
        if (truncated) return;
        const room = maxBytes - size;
        if (chunk.length > room) { chunks.push(chunk.subarray(0, room)); size = maxBytes; truncated = true; response.destroy(); return; }
        chunks.push(chunk); size += chunk.length;
      });
      const done = () => resolve({ status: response.statusCode ?? 0, location: typeof response.headers.location === "string" ? response.headers.location : null, contentType: typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : null, bytes: Buffer.concat(chunks), truncated });
      response.once("end", done);
      response.once("close", done);
      response.once("error", reject);
    });
    request.once("timeout", () => request.destroy(new Error("The request timed out.")));
    request.once("error", reject);
    if (body !== undefined && method === "POST") request.write(body);
    request.end();
  });
}

export async function webFetch(args: WebFetchArgs, options: WebFetchOptions = {}): Promise<WebFetchResult> {
  const method = args.method ?? "GET";
  if (!METHODS.includes(method)) throw new Error("method must be GET, HEAD or POST.");
  if (args.body !== undefined && Buffer.byteLength(args.body) > WEB_FETCH_MAX_REQUEST_BODY) throw new Error("The request body is too large.");
  const maxBytes = Math.min(Math.max(1, args.maxBytes ?? WEB_FETCH_DEFAULT_BYTES), WEB_FETCH_MAX_BYTES);
  const timeoutMs = Math.min(Math.max(100, args.timeoutMs ?? 30_000), 120_000);
  const headers: Record<string, string> = { "user-agent": "Mozilla/5.0 (compatible; FrelyAgent/1.0)", accept: "*/*", "accept-encoding": "identity" };
  for (const [name, value] of Object.entries(args.headers ?? {})) {
    if (typeof value !== "string" || FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase()) || /[\r\n]/u.test(name + value)) throw new Error(`Header ${JSON.stringify(name.slice(0, 40))} is not allowed.`);
    headers[name.toLowerCase()] = value;
  }
  if (args.body !== undefined && method === "POST") headers["content-length"] = String(Buffer.byteLength(args.body));

  let url: URL;
  try { url = new URL(args.url); } catch { throw new Error("url is not a valid URL."); }
  let currentMethod: WebFetchMethod = method;
  let currentBody = args.body;
  for (let redirects = 0; ; redirects += 1) {
    options.signal?.throwIfAborted();
    const target = await checkedTarget(url, options);
    const sameOriginHeaders = { ...headers, host: url.host };
    const response = await once(url, currentMethod, sameOriginHeaders, currentBody, target.address, maxBytes, timeoutMs, options.signal);
    if (response.status >= 300 && response.status < 400 && response.location) {
      if (redirects >= MAX_REDIRECTS) throw new Error("Too many redirects.");
      const next = new URL(response.location, url);
      // Credentials the Agent attached belong to the first origin only.
      if (next.origin !== url.origin) for (const name of ["authorization", "cookie"]) delete headers[name];
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) { currentMethod = "GET"; currentBody = undefined; delete headers["content-length"]; }
      url = next;
      continue;
    }
    return { url: url.toString(), status: response.status, contentType: response.contentType, redirects, truncated: response.truncated, body: readText(response.contentType, response.bytes) };
  }
}
