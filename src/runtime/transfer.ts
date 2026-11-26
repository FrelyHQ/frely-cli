import { checkedTarget } from "./web-fetch.js";
import { Workspace } from "./workspace.js";
import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

export const TRANSFER_MAX_BYTES = 100 * 1024 * 1024;
/** Request `_meta` key the relay sets on the hidden transfer_* calls; the relay removes it from whatever a client sent. */
export const TRANSFER_META_KEY = "frely/transfer";
export const TRANSFER_TOOLS = new Set(["transfer_check", "transfer_prepare", "transfer_upload", "transfer_download", "transfer_p2p_info", "transfer_p2p_listen", "transfer_p2p_send", "transfer_p2p_status", "transfer_p2p_cancel"]);

/** The object stores Frely signs links for (the same two the web app's CSP allows). Plan gap G4 is closed by this list: a link to any other host is refused. */
export const TRANSFER_STORE_HOST_SUFFIXES = [".r2.cloudflarestorage.com", ".s3.bitiful.net"] as const;

const TIMEOUT_MS = 10 * 60_000;
const HEADER_NAMES = /^(?:content-type|x-amz-[a-z0-9-]+)$/u;

export function transferAllowedFromMeta(meta: unknown): boolean {
  return Boolean(meta && typeof meta === "object" && (meta as Record<string, unknown>)[TRANSFER_META_KEY] === true);
}

export interface TransferTarget {
  url: string;
  headers?: Record<string, string>;
  /** Test seam; see WebFetchOptions. Never set in production. */
  resolve?: (hostname: string) => Promise<string[]>;
  trustedTestHosts?: readonly string[];
}

export function isTransferStoreHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return TRANSFER_STORE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

/**
 * The headers the relay signed for a link. content-length is signed too (the relay presigns the PUT with the exact size), but the CLI sets it from
 * the file it opened, so the relay's copy is dropped here instead of refused; the store rejects the upload if the two ever differ.
 */
export function checkedTransferHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const sent: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower === "content-length" && /^\d+$/u.test(value)) continue;
    if (!HEADER_NAMES.test(lower) || /[\r\n]/u.test(name + value)) throw new Error(`Header ${JSON.stringify(name.slice(0, 40))} is not allowed.`);
    sent[lower] = value;
  }
  return sent;
}

/** https only, only Frely's object stores, public addresses only, one connection pinned to the checked address, no redirects, no credentials in the URL. */
async function connect(target: TransferTarget, method: "PUT" | "GET", headers: Record<string, string>, signal: AbortSignal, body?: AsyncIterable<Buffer>): Promise<IncomingMessage> {
  let url: URL;
  try { url = new URL(target.url); } catch { throw new Error("The transfer URL is not valid."); }
  const trusted = target.trustedTestHosts?.includes(url.hostname) === true;
  if (url.protocol !== "https:") throw new Error("Transfers use https only.");
  if (!isTransferStoreHost(url.hostname)) throw new Error("Transfer links must point to Frely's file storage.");
  if (!trusted && url.port && url.port !== "443") throw new Error("Transfers use port 443 only.");
  const { address } = await checkedTarget(url, { signal, ...(target.resolve ? { resolve: target.resolve } : {}), ...(target.trustedTestHosts ? { trustedTestHosts: target.trustedTestHosts } : {}) });
  const family = isIP(address) === 6 ? 6 : 4;
  const sent = checkedTransferHeaders(target.headers);
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: url.hostname, port: url.port || undefined, path: `${url.pathname}${url.search}`, method,
      headers: { ...sent, ...headers, host: url.host, "accept-encoding": "identity" },
      lookup: (_host, options, callback) => (options as { all?: boolean }).all ? (callback as unknown as (error: null, list: Array<{ address: string; family: number }>) => void)(null, [{ address, family }]) : callback(null, address, family),
      ...(isIP(url.hostname) ? {} : { servername: url.hostname }),
      agent: false, timeout: TIMEOUT_MS, signal,
    }, (response) => {
      if ((response.statusCode ?? 0) >= 300) {
        response.resume();
        reject(new Error(`The storage service answered ${response.statusCode}.`));
        return;
      }
      resolve(response);
    });
    request.once("timeout", () => request.destroy(new Error("The transfer timed out.")));
    request.once("error", reject);
    if (!body) { request.end(); return; }
    (async () => { for await (const chunk of body) if (!request.write(chunk)) await new Promise<void>((done) => request.once("drain", done)); request.end(); })().catch((error) => request.destroy(error as Error));
  });
}

/** Whether a file could be written at `path` now; the relay asks before it hands anyone an upload link bound to that path. */
export async function transferCheck(workspace: Workspace, path: string, overwrite: boolean) {
  await workspace.checkWrite(path, overwrite);
  return { writable: true, path };
}

export async function transferPrepare(workspace: Workspace, path: string) {
  const { handle, bytes, name } = await workspace.openForTransfer(path, TRANSFER_MAX_BYTES);
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk as Buffer);
    return { name, bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

export async function transferUpload(workspace: Workspace, path: string, target: TransferTarget, expected: { bytes: number; sha256: string }, signal: AbortSignal) {
  const { handle, bytes } = await workspace.openForTransfer(path, TRANSFER_MAX_BYTES);
  try {
    if (bytes !== expected.bytes) throw new Error("The file changed after it was prepared.");
    const hash = createHash("sha256");
    async function* chunks() {
      for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) { hash.update(chunk as Buffer); yield chunk as Buffer; }
    }
    const response = await connect(target, "PUT", { "content-length": String(bytes) }, signal, chunks());
    response.resume();
    if (hash.digest("hex") !== expected.sha256) throw new Error("The file changed while it was uploading; the upload is not valid.");
    return { uploaded: true, bytes };
  } finally {
    await handle.close();
  }
}

export async function transferDownload(workspace: Workspace, path: string, target: TransferTarget, expected: { bytes: number; sha256: string }, overwrite: boolean, signal: AbortSignal) {
  if (expected.bytes < 1 || expected.bytes > TRANSFER_MAX_BYTES) throw new Error(`bytes must be between 1 and ${TRANSFER_MAX_BYTES}.`);
  const response = await connect(target, "GET", {}, signal);
  return workspace.writeStream(path, response as AsyncIterable<Buffer>, overwrite, expected);
}
