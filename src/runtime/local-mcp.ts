import { execFile } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ensureCredentialDirectory, readPrivateFile, writePrivateFile } from "../credential-file.js";
import { VERSION } from "../version.js";
import { safeEnv } from "./workspace.js";

/**
 * Device-local MCP servers (plan mcp/本机MCP转发-方案.md §9).
 *
 * The Relay never learns how a local server is reached: it only knows the
 * names the owner enabled on the web console. Everything here stays on the
 * device: discovery of loopback HTTP servers, the manual list (HTTP or stdio),
 * the MCP clients, and the policy that only enabled names are callable.
 */
export const LOCAL_MCP_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/u;
export const LOCAL_MCP_CAPABILITY_LIMIT = 24;
export const LOCAL_MCP_DEFAULT_TIMEOUT_MS = 60_000;
export const LOCAL_MCP_MAX_TIMEOUT_MS = 120_000;
export const LOCAL_MCP_TEXT_LIMIT = 1024 * 1024;
export const LOCAL_MCP_BINARY_LIMIT = 6 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 1_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_PROBED_PORTS = 64;
const PROBE_CONCURRENCY = 8;
const MAX_LIST_PAGES = 5;
const HTTP_PATHS = [{ path: "/mcp", flavor: "streamable" }, { path: "/sse", flavor: "sse" }] as const;

export type HttpFlavor = "streamable" | "sse";
export interface LocalMcpHttpEntry {
  name: string;
  source: "discovered" | "manual";
  transport: "http";
  url: string;
  flavor?: HttpFlavor;
  headers?: Record<string, string>;
}
export interface LocalMcpStdioEntry {
  name: string;
  source: "manual";
  transport: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** PATH captured when the entry was added, so a background service finds the same binaries. */
  path?: string;
}
export type LocalMcpEntry = LocalMcpHttpEntry | LocalMcpStdioEntry;
export type ManualLocalMcpEntry = Omit<LocalMcpHttpEntry, "source"> | Omit<LocalMcpStdioEntry, "source">;

export interface LocalMcpToolResult { content: unknown[]; isError?: boolean }

// ---------------------------------------------------------------- manual list

export function localMcpRegistryPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "mcp-v1", "local-mcps.json");
}

export async function loadManualEntries(path = localMcpRegistryPath()): Promise<LocalMcpEntry[]> {
  const raw = await readPrivateFile(path);
  if (!raw) return [];
  const value = JSON.parse(raw) as { version?: unknown; servers?: unknown };
  if (value.version !== 1 || !Array.isArray(value.servers)) throw new Error("Local MCP list is corrupted.");
  return value.servers.map((item) => normalizeManual(item as ManualLocalMcpEntry));
}

export async function addManualEntry(entry: ManualLocalMcpEntry, path = localMcpRegistryPath()): Promise<void> {
  const next = normalizeManual(entry);
  const current = await loadManualEntries(path);
  if (current.some((item) => item.name === next.name)) throw new Error(`A local MCP named ${next.name} already exists. Remove it first.`);
  await writeManual([...current, next], path);
}

export async function removeManualEntry(name: string, path = localMcpRegistryPath()): Promise<void> {
  const current = await loadManualEntries(path);
  if (!current.some((item) => item.name === name)) throw new Error(`No manually added local MCP named ${name}.`);
  await writeManual(current.filter((item) => item.name !== name), path);
}

async function writeManual(entries: LocalMcpEntry[], path: string): Promise<void> {
  await ensureCredentialDirectory(dirname(path), true);
  const servers = entries.map((entry) => { const { source: _source, ...rest } = entry; return rest; });
  await writePrivateFile(path, JSON.stringify({ version: 1, servers }) + "\n");
}

function normalizeManual(entry: ManualLocalMcpEntry): LocalMcpEntry {
  if (!entry || typeof entry !== "object" || !LOCAL_MCP_NAME.test(entry.name)) throw new Error("Local MCP names use 1-32 lowercase letters, digits or hyphens and start with a letter or digit.");
  if (entry.transport === "http") {
    assertLoopbackUrl(entry.url);
    return { ...entry, source: "manual" };
  }
  if (entry.transport === "stdio") {
    if (typeof entry.command !== "string" || entry.command.length === 0 || !Array.isArray(entry.args) || !entry.args.every((arg) => typeof arg === "string")) throw new Error("A stdio local MCP needs a command and string arguments.");
    return { ...entry, source: "manual" };
  }
  throw new Error("Local MCP transport must be http or stdio.");
}

// ------------------------------------------------------------------ loopback

/** Only loopback HTTP(S) targets are ever contacted (plan F5). */
export function assertLoopbackUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Local MCP URL is not valid."); }
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !loopback || url.username || url.password) {
    throw new Error("Local MCP URLs must be http(s) on 127.0.0.1, ::1 or localhost without credentials.");
  }
  return url;
}

const loopbackFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
  assertLoopbackUrl(String(input));
  const response = await fetch(input, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) throw new Error("The local MCP server redirected; redirects are not followed.");
  return response;
};

export function parseLoopbackListeners(platform: NodeJS.Platform, outputs: readonly string[]): number[] {
  const ports = new Set<number>();
  const add = (value: string | undefined) => { const port = Number(value); if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port); };
  for (const output of outputs) {
    for (const line of output.split(/\r?\n/u)) {
      if (platform === "linux") {
        const fields = line.trim().split(/\s+/u);
        const [address, port] = (fields[1] ?? "").split(":");
        if (fields[3] !== "0A" || !address || !port) continue;
        if (/^[0-9A-F]{6}7F$/u.test(address) || address === "00000000000000000000000001000000" || /^0000000000000000FFFF0000[0-9A-F]{6}7F$/u.test(address)) add(String(Number.parseInt(port, 16)));
      } else if (platform === "win32") {
        const match = /^\s*TCP\s+(?:127(?:\.\d+){3}|\[::1\]):(\d+)\s+\S+\s+LISTENING/u.exec(line);
        if (match) add(match[1]);
      } else {
        const match = /^n(?:127(?:\.\d+){3}|\[::1\]|localhost):(\d+)$/u.exec(line.trim());
        if (match) add(match[1]);
      }
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** TCP ports that only accept loopback connections, found without extra dependencies. */
export async function listLoopbackPorts(platform: NodeJS.Platform = process.platform): Promise<number[]> {
  try {
    if (platform === "linux") {
      const files = await Promise.all(["/proc/net/tcp", "/proc/net/tcp6"].map((file) => readFile(file, "utf8").catch(() => "")));
      return parseLoopbackListeners(platform, files);
    }
    const [command, args] = platform === "win32" ? ["netstat", ["-ano", "-p", "tcp"]] as const : ["lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"]] as const;
    const output = await new Promise<string>((resolve) => {
      execFile(command, [...args], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (_error, stdout) => resolve(stdout ?? ""));
    });
    return parseLoopbackListeners(platform, [output]);
  } catch {
    return [];
  }
}

export interface ProbeHit { url: string; flavor: HttpFlavor; serverName?: string }

/** One standard `initialize` (or SSE handshake) per port; nothing is sent beyond that and redirects are never followed. */
export async function probeHttpMcp(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeHit | null> {
  for (const { path, flavor } of HTTP_PATHS) {
    const url = `http://127.0.0.1:${port}${path}`;
    try {
      const hit = flavor === "streamable" ? await probeStreamable(url, timeoutMs) : await probeSse(url, timeoutMs);
      if (hit) return hit;
    } catch { /* Not an MCP endpoint on this path. */ }
  }
  return null;
}

async function probeStreamable(url: string, timeoutMs: number): Promise<ProbeHit | null> {
  const response = await fetch(url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "frely-discovery", version: VERSION } } }),
  });
  const session = response.headers.get("mcp-session-id");
  try {
    if (!response.ok) return null;
    const type = response.headers.get("content-type") ?? "";
    const text = (await response.text()).slice(0, 65_536);
    const body = type.includes("text/event-stream") ? text.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())[0] : text;
    const message = JSON.parse(body ?? "") as { result?: { protocolVersion?: unknown; serverInfo?: { name?: unknown } } };
    if (typeof message.result?.protocolVersion !== "string") return null;
    const serverName = typeof message.result.serverInfo?.name === "string" ? message.result.serverInfo.name : undefined;
    return { url, flavor: "streamable", ...(serverName ? { serverName } : {}) };
  } finally {
    if (session) void fetch(url, { method: "DELETE", redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "mcp-session-id": session } }).catch(() => undefined);
  }
}

async function probeSse(url: string, timeoutMs: number): Promise<ProbeHit | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: "manual", signal: controller.signal, headers: { accept: "text/event-stream" } });
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/event-stream") || !response.body) return null;
    const reader = response.body.getReader();
    let seen = "";
    while (seen.length < 4096 && !/^event:\s*endpoint\s*$/mu.test(seen)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += Buffer.from(chunk.value).toString("utf8");
    }
    void reader.cancel().catch(() => undefined);
    return /^event:\s*endpoint\s*$/mu.test(seen) ? { url, flavor: "sse" } : null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export interface DiscoveryDeps { listPorts?: () => Promise<number[]>; probe?: (port: number) => Promise<ProbeHit | null> }

export async function discoverLoopbackMcps(deps: DiscoveryDeps = {}, skipPorts: ReadonlySet<number> = new Set()): Promise<Array<ProbeHit & { port: number }>> {
  const ports = (await (deps.listPorts ?? listLoopbackPorts)()).filter((port) => !skipPorts.has(port)).slice(0, MAX_PROBED_PORTS);
  const probe = deps.probe ?? probeHttpMcp;
  const found: Array<ProbeHit & { port: number }> = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, ports.length) }, async () => {
    while (next < ports.length) {
      const port = ports[next++]!;
      const hit = await probe(port).catch(() => null);
      if (hit) found.push({ ...hit, port });
    }
  }));
  return found.sort((a, b) => a.port - b.port);
}

export function slugName(value: string | undefined): string {
  const slug = (value ?? "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 32).replace(/-+$/u, "");
  return slug || "mcp";
}

/** Stable names: manual entries keep theirs, discovered ones use the server's own name and get a numeric suffix on clashes. */
export function nameDiscovered(hits: Array<ProbeHit & { port: number }>, taken: Iterable<string>): LocalMcpHttpEntry[] {
  const used = new Set(taken);
  return hits.map((hit) => {
    const base = slugName(hit.serverName ?? `local-${hit.port}`);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base.slice(0, 32 - String(n).length - 1)}-${n}`;
    used.add(name);
    return { name, source: "discovered", transport: "http", url: hit.url, flavor: hit.flavor };
  });
}

// ----------------------------------------------------------------------- hub

interface Pooled { key: string; client: Client; lastUsed: number }

export interface LocalMcpHubOptions {
  discovery?: DiscoveryDeps;
  loadManual?: () => Promise<LocalMcpEntry[]>;
  idleMs?: number;
  refreshMs?: number;
  log?: (message: string) => void;
}

export class LocalMcpHub {
  private entries: LocalMcpEntry[] = [];
  private refreshedAt = 0;
  private refreshing: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly pool = new Map<string, Pooled>();
  private readonly connecting = new Map<string, Promise<Pooled>>();

  constructor(private readonly options: LocalMcpHubOptions = {}) {}

  /** Begin periodic discovery and idle cleanup; both timers are unref'd. */
  start(): void {
    if (this.timer) return;
    void this.refresh().catch(() => undefined);
    this.timer = setInterval(() => { void this.refresh().catch(() => undefined); void this.closeIdle(); }, this.options.refreshMs ?? 5 * 60_000);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.pool.values()].map((item) => item.client.close()));
    this.pool.clear();
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.scan().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async scan(): Promise<void> {
    const manual = await (this.options.loadManual ?? (() => loadManualEntries()))().catch((error: unknown) => {
      this.options.log?.(`local MCP list unreadable: ${error instanceof Error ? error.message : String(error)}`);
      return [] as LocalMcpEntry[];
    });
    const covered = new Set(manual.flatMap((entry) => entry.transport === "http" ? [Number(new URL(entry.url).port)] : []));
    const hits = await discoverLoopbackMcps(this.options.discovery, covered);
    this.entries = [...manual, ...nameDiscovered(hits, manual.map((entry) => entry.name))];
    this.refreshedAt = Date.now();
    const live = new Map(this.entries.map((entry) => [entry.name, connectionKey(entry)]));
    for (const [name, item] of [...this.pool]) if (live.get(name) !== item.key) { this.pool.delete(name); void item.client.close().catch(() => undefined); }
  }

  async ensureFresh(maxAgeMs = 30_000): Promise<void> {
    if (Date.now() - this.refreshedAt > maxAgeMs) await this.refresh();
  }

  snapshot(): readonly LocalMcpEntry[] { return this.entries; }

  /** Names and transports for the web console; commands, URLs and secrets never leave the device. */
  capabilities(): Array<{ name: string; transport: "http" | "stdio" }> {
    return this.entries.slice(0, LOCAL_MCP_CAPABILITY_LIMIT).map((entry) => ({ name: entry.name, transport: entry.transport }));
  }

  /** `local_mcp_list`: enabled servers, or one enabled server's tool definitions. */
  async list(enabled: readonly string[], server?: string, signal?: AbortSignal): Promise<unknown> {
    await this.ensureFresh();
    if (server === undefined) {
      const present = new Map(this.entries.map((entry) => [entry.name, entry]));
      return { servers: enabled.map((name) => ({ name, transport: present.get(name)?.transport ?? null, available: present.has(name) })) };
    }
    const entry = this.requireEnabled(enabled, server);
    const client = await this.client(entry);
    const tools: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await client.client.listTools(cursor ? { cursor } : {}, { timeout: LOCAL_MCP_DEFAULT_TIMEOUT_MS, ...(signal ? { signal } : {}) });
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    client.lastUsed = Date.now();
    return { server, tools };
  }

  /** `local_mcp_call`: forwards one tools/call to an enabled server and bounds the result. */
  async call(enabled: readonly string[], server: string, tool: string, args: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<LocalMcpToolResult> {
    await this.ensureFresh();
    const entry = this.requireEnabled(enabled, server);
    const timeout = Math.min(Math.max(options.timeoutMs ?? LOCAL_MCP_DEFAULT_TIMEOUT_MS, 100), LOCAL_MCP_MAX_TIMEOUT_MS);
    const pooled = await this.client(entry);
    try {
      const result = await pooled.client.callTool({ name: tool, arguments: args }, undefined, { timeout, ...(options.signal ? { signal: options.signal } : {}) });
      pooled.lastUsed = Date.now();
      return shapeToolResult(result as { content?: unknown; isError?: unknown });
    } catch (error) {
      pooled.lastUsed = Date.now();
      throw error;
    }
  }

  private requireEnabled(enabled: readonly string[], name: string): LocalMcpEntry {
    if (!enabled.includes(name)) {
      throw new Error(`Local MCP ${JSON.stringify(name)} is not enabled on this device. Enabled: ${enabled.length > 0 ? enabled.join(", ") : "none"}. Enable it on the Frely connections page.`);
    }
    const entry = this.entries.find((item) => item.name === name);
    if (!entry) throw new Error(`Local MCP ${JSON.stringify(name)} is enabled but not running on this device right now.`);
    return entry;
  }

  private async client(entry: LocalMcpEntry): Promise<Pooled> {
    const key = connectionKey(entry);
    const existing = this.pool.get(entry.name);
    if (existing?.key === key) return existing;
    const pending = this.connecting.get(entry.name);
    if (pending) return pending;
    const created = this.connect(entry, key).finally(() => this.connecting.delete(entry.name));
    this.connecting.set(entry.name, created);
    return created;
  }

  private async connect(entry: LocalMcpEntry, key: string): Promise<Pooled> {
    const stale = this.pool.get(entry.name);
    if (stale) { this.pool.delete(entry.name); void stale.client.close().catch(() => undefined); }
    const attempts: Array<() => Transport> = entry.transport === "stdio"
      ? [() => stdioTransport(entry) as Transport]
      : entry.flavor === "sse" ? [() => sseTransport(entry) as Transport] : entry.flavor === "streamable" ? [() => httpTransport(entry) as Transport] : [() => httpTransport(entry) as Transport, () => sseTransport(entry) as Transport];
    let lastError: unknown;
    for (const make of attempts) {
      const client = new Client({ name: "frely-cli", version: VERSION }, { capabilities: {} });
      try {
        await client.connect(make(), { timeout: CONNECT_TIMEOUT_MS });
        const pooled: Pooled = { key, client, lastUsed: Date.now() };
        client.onclose = () => { if (this.pool.get(entry.name) === pooled) this.pool.delete(entry.name); };
        this.pool.set(entry.name, pooled);
        return pooled;
      } catch (error) {
        lastError = error;
        await client.close().catch(() => undefined);
      }
    }
    throw new Error(`Could not connect to local MCP ${JSON.stringify(entry.name)}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private async closeIdle(): Promise<void> {
    const limit = Date.now() - (this.options.idleMs ?? 10 * 60_000);
    for (const [name, item] of [...this.pool]) {
      if (item.lastUsed < limit) { this.pool.delete(name); await item.client.close().catch(() => undefined); }
    }
  }
}

function connectionKey(entry: LocalMcpEntry): string {
  return entry.transport === "http" ? JSON.stringify([entry.url, entry.flavor ?? null, entry.headers ?? null]) : JSON.stringify([entry.command, entry.args, entry.env ?? null, entry.path ?? null]);
}

function httpTransport(entry: LocalMcpHttpEntry) {
  const url = assertLoopbackUrl(entry.url);
  return new StreamableHTTPClientTransport(url, { fetch: loopbackFetch, ...(entry.headers ? { requestInit: { headers: entry.headers } } : {}) });
}

function sseTransport(entry: LocalMcpHttpEntry) {
  const url = assertLoopbackUrl(entry.url);
  return new SSEClientTransport(url, { fetch: loopbackFetch, eventSourceInit: { fetch: loopbackFetch as never }, ...(entry.headers ? { requestInit: { headers: entry.headers } } : {}) });
}

function stdioTransport(entry: LocalMcpStdioEntry) {
  const env: Record<string, string> = { ...(safeEnv() as Record<string, string>), ...entry.env };
  if (entry.path) env.PATH = entry.path;
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env, cwd: homedir(), stderr: "pipe" });
  // An undrained stderr pipe can stall the child; its output is not forwarded.
  transport.stderr?.on("data", () => undefined);
  return transport;
}

/** Resolve a bare command against PATH so a background service with a different PATH still finds it. */
export async function resolveCommand(command: string, pathValue = process.env.PATH ?? ""): Promise<string> {
  if (isAbsolute(command)) return command;
  const extensions = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, command + extension);
      if (await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK).then(() => true, () => false)) return candidate;
    }
  }
  throw new Error(`Command not found on PATH: ${command}`);
}

/** Bounds what one local MCP call can put on the relay: 1 MiB of text, 6 MiB of binary content. */
export function shapeToolResult(result: { content?: unknown; isError?: unknown }): LocalMcpToolResult {
  const content: unknown[] = [];
  let text = 0;
  let binary = 0;
  for (const block of Array.isArray(result.content) ? result.content : []) {
    const item = block as { type?: unknown; text?: unknown; data?: unknown };
    if (item.type === "text" && typeof item.text === "string") {
      const room = LOCAL_MCP_TEXT_LIMIT - text;
      if (room <= 0) continue;
      const clipped = Buffer.byteLength(item.text) > room ? Buffer.from(item.text).subarray(0, room).toString("utf8") + "\n[truncated]" : item.text;
      text += Buffer.byteLength(item.text);
      content.push({ ...item, text: clipped });
    } else if (typeof item.data === "string") {
      binary += item.data.length;
      content.push(binary > LOCAL_MCP_BINARY_LIMIT ? { type: "text", text: `[${String(item.type)} content omitted: larger than ${LOCAL_MCP_BINARY_LIMIT / (1024 * 1024)} MiB relay budget]` } : item);
    } else {
      content.push(item);
    }
  }
  return { content, ...(result.isError === true ? { isError: true } : {}) };
}
