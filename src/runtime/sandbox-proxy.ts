import { execFileSync } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The user's own HTTP(S) proxy (Clash and the like) as the upstream of the command sandbox's proxy.
 *
 * srt gives sandboxed commands its own proxy and dials the network from the CLI process. A user who reaches the internet only through
 * a local proxy has that setting in their shell, which a background service never sees, so downloads inside the sandbox fail. The
 * address is taken, first match wins, from: the value saved with `frely sandbox proxy <url>`, the proxy variables of this process,
 * and on macOS the system proxy (`scutil --proxy`). The user's own proxy settings are only read, never changed.
 *
 * srt 0.0.77 (`network.parentProxy`) takes `{ http, https, noProxy }`, accepts http:// and https:// proxy URLs only (a bare host:port
 * counts as http), always bypasses loopback destinations, and reads the value once, when the sandbox starts.
 */
export interface UpstreamProxy { http?: string; https?: string; noProxy?: string }

const SETTINGS_FILE = "sandbox.json";

export function sandboxSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", SETTINGS_FILE);
}

/** A proxy URL srt can use: http(s) scheme, or no scheme at all. Credentials in the URL are kept (srt sends them to the proxy). */
export function usableProxyUrl(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The value `frely sandbox proxy` saved, or undefined. */
export function readSavedProxy(path: string = sandboxSettingsPath()): UpstreamProxy | undefined {
  try {
    const value = (JSON.parse(readFileSync(path, "utf8")) as { proxy?: { url?: unknown; noProxy?: unknown } }).proxy;
    const url = typeof value?.url === "string" ? usableProxyUrl(value.url) : undefined;
    if (!url) return undefined;
    return { http: url, https: url, ...(typeof value?.noProxy === "string" && value.noProxy.trim() ? { noProxy: value.noProxy.trim() } : {}) };
  } catch {
    return undefined;
  }
}

/** Save (or with `undefined` remove) the proxy to use for the sandbox. Takes effect when the MCP service restarts. */
export async function saveProxy(proxy: { url: string; noProxy?: string } | undefined, path: string = sandboxSettingsPath()): Promise<void> {
  if (!proxy) {
    await rm(path, { force: true });
    return;
  }
  const url = usableProxyUrl(proxy.url);
  if (!url) throw new Error("The proxy must be an http:// or https:// URL (or host:port). SOCKS proxies are not supported by the sandbox.");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ proxy: { url, ...(proxy.noProxy?.trim() ? { noProxy: proxy.noProxy.trim() } : {}) } }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** The proxy variables of a process, including ALL_PROXY when it is an http(s) proxy (srt reads only HTTP_PROXY / HTTPS_PROXY itself). */
export function proxyFromEnv(env: NodeJS.ProcessEnv): UpstreamProxy | undefined {
  const pick = (...names: string[]): string | undefined => names.map((name) => usableProxyUrl(env[name])).find((value) => value !== undefined);
  const all = pick("ALL_PROXY", "all_proxy");
  const http = pick("HTTP_PROXY", "http_proxy") ?? all;
  const https = pick("HTTPS_PROXY", "https_proxy") ?? all ?? http;
  if (!http && !https) return undefined;
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "").trim();
  return { ...(http ? { http } : {}), ...(https ? { https } : {}), ...(noProxy ? { noProxy } : {}) };
}

/** The HTTP/HTTPS proxy of the macOS network settings, from the text of `scutil --proxy`. SOCKS and auto-config (PAC) entries are ignored. */
export function parseScutilProxy(text: string): UpstreamProxy | undefined {
  const field = (name: string): string | undefined => new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, "mu").exec(text)?.[1];
  const endpoint = (prefix: "HTTP" | "HTTPS"): string | undefined => {
    const host = field(`${prefix}Proxy`);
    const port = field(`${prefix}Port`);
    return field(`${prefix}Enable`) === "1" && host && port ? usableProxyUrl(`http://${host.includes(":") ? `[${host}]` : host}:${port}`) : undefined;
  };
  const http = endpoint("HTTP");
  const https = endpoint("HTTPS");
  if (!http && !https) return undefined;
  const exceptions = /ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/u.exec(text)?.[1];
  const noProxy = exceptions ? [...exceptions.matchAll(/^\s*\d+\s*:\s*(.+?)\s*$/gmu)].map((match) => match[1]!).join(",") : "";
  return { ...(http ? { http } : {}), ...(https ? { https } : {}), ...(noProxy ? { noProxy } : {}) };
}

function readSystemProxy(): UpstreamProxy | undefined {
  try {
    return parseScutilProxy(execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return undefined;
  }
}

/** The upstream proxy for the sandbox: saved value, then this process's environment, then (macOS) the system proxy. */
export function resolveUpstreamProxy(options: { saved?: UpstreamProxy | undefined; env?: NodeJS.ProcessEnv; platform?: string; system?: () => UpstreamProxy | undefined } = {}): UpstreamProxy | undefined {
  const saved = "saved" in options ? options.saved : readSavedProxy();
  if (saved) return saved;
  const fromEnv = proxyFromEnv(options.env ?? process.env);
  if (fromEnv) return fromEnv;
  return (options.platform ?? process.platform) === "darwin" ? (options.system ?? readSystemProxy)() : undefined;
}

/** `frely sandbox proxy [<url> [--no-proxy <list>] | --clear]`: show, save or remove the proxy used by the command sandbox. */
export async function runSandboxProxyCommand(args: readonly string[], write: (text: string) => void): Promise<void> {
  const noProxyIndex = args.indexOf("--no-proxy");
  const noProxy = noProxyIndex === -1 ? undefined : args[noProxyIndex + 1];
  if (noProxyIndex !== -1 && !noProxy) throw new Error("--no-proxy needs a comma-separated list.");
  const rest = noProxyIndex === -1 ? [...args] : args.filter((_, index) => index !== noProxyIndex && index !== noProxyIndex + 1);
  if (rest.includes("--clear")) {
    await saveProxy(undefined);
    write("Saved sandbox proxy removed. Restart the MCP service (frely mcp stop, then frely mcp start) for it to take effect.\n");
    return;
  }
  if (rest.length === 0) {
    const saved = readSavedProxy();
    const effective = resolveUpstreamProxy();
    write(saved ? `Saved sandbox proxy: ${redact(saved.http)}${saved.noProxy ? ` (no proxy for ${saved.noProxy})` : ""}\n` : "No sandbox proxy saved.\n");
    write(effective ? `In use when the sandbox starts: ${redact(effective.https ?? effective.http)}${saved ? "" : " (from this environment or the system settings)"}\n` : "In use when the sandbox starts: none (direct connections).\n");
    return;
  }
  if (rest.length !== 1) throw new Error("Usage: frely sandbox proxy [<http://host:port> [--no-proxy <list>] | --clear]");
  await saveProxy({ url: rest[0]!, ...(noProxy ? { noProxy } : {}) });
  write(`Sandbox proxy saved: ${redact(rest[0])}. Restart the MCP service (frely mcp stop, then frely mcp start) for it to take effect.\n`);
}

/** The proxy URL without its password, for display. */
function redact(value: string | undefined): string {
  if (!value) return "none";
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `http://${value}`);
    if (url.password) url.password = "***";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return "(invalid)";
  }
}
