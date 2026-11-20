// `frely key setup <agent>`: create a Frely API key and write it straight into another AI application's own settings, so the AI that
// runs this command never sees the key. The key is made by the existing `keys.create` Cloud tool (which needs the owner's approval on the
// web each time), held only in this process, and written to the agent's file with mode 0600. The command prints the key's id and prefix,
// never the key. Frely's server has no special import logic: this is `frely api call keys.create` plus a local file edit.
import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

export const KEY_SETUP_AGENTS = ["codex", "claude-code"] as const;
export type KeySetupAgent = (typeof KEY_SETUP_AGENTS)[number];
export const DEFAULT_GATEWAY_URL = "https://api.frely.cloud";

type Call = (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
export interface KeySetupIo { out: (text: string) => void; call: Call; home?: string; hostName?: string }

const USAGE = "Usage: frely key setup codex|claude-code [--name <text>] [--gateway <url>] [--json]";

/** Only Frely's own gateway (or a loopback one for tests) may receive this key: the agent will send it there on every request. */
export function checkedGatewayUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("--gateway must be a URL."); }
  const frely = url.protocol === "https:" && (url.hostname === "frely.cloud" || url.hostname.endsWith(".frely.cloud"));
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !(frely || loopback)) throw new Error("--gateway must be a frely.cloud address without credentials.");
  return url.origin;
}

export interface WrittenSettings { path: string; backup: string | null }

/**
 * Points Claude Code at the gateway: `env.ANTHROPIC_BASE_URL` and `env.ANTHROPIC_AUTH_TOKEN` in ~/.claude/settings.json. Other settings are
 * kept; the previous file is copied to settings.json.frely-backup first; a file that is not a JSON object is left untouched and refused.
 */
export async function writeClaudeCodeSettings(input: { home: string; gatewayUrl: string; apiKey: string }): Promise<WrittenSettings> {
  if (!input.apiKey) throw new Error("No key to write.");
  const path = join(input.home, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  let existed = false;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    settings = parsed as Record<string, unknown>;
    existed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${path} is not a JSON object, so it was not changed.`);
  }
  const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env) ? settings.env as Record<string, unknown> : {};
  await mkdir(dirname(path), { recursive: true });
  const backup = existed ? `${path}.frely-backup` : null;
  if (backup) { await copyFile(path, backup); await chmod(backup, 0o600); }
  const next = { ...settings, env: { ...env, ANTHROPIC_BASE_URL: input.gatewayUrl, ANTHROPIC_AUTH_TOKEN: input.apiKey } };
  const temporary = `${path}.frely-tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
  await stat(path);
  return { path, backup };
}

/** Sets the top-level `openai_base_url` of a Codex config.toml text (replacing the line, or adding it before the first table). */
export function withCodexBaseUrl(toml: string, baseUrl: string): string {
  const line = `openai_base_url = ${JSON.stringify(baseUrl)}`;
  const lines = toml === "" ? [] : toml.split("\n");
  const firstTable = lines.findIndex((text) => /^\s*\[/u.test(text));
  const top = firstTable === -1 ? lines.length : firstTable;
  const existing = lines.slice(0, top).findIndex((text) => /^\s*openai_base_url\s*=/u.test(text));
  if (existing !== -1) { lines[existing] = line; return lines.join("\n"); }
  const head = lines.slice(0, top);
  while (head.length > 0 && head[head.length - 1]!.trim() === "") head.pop();
  const rest = lines.slice(top);
  return [...head, line, ...(rest.length > 0 ? ["", ...rest] : [""])].join("\n");
}

/** Runs `codex login --with-api-key` (through the shell on Windows, where Codex is a .cmd shim; the arguments are fixed), handing it the key on stdin only: Codex itself saves it, so no argument or output carries the key. */
function codexLogin(codexHome: string, apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["login", "--with-api-key"], { env: { ...process.env, CODEX_HOME: codexHome }, stdio: ["pipe", "ignore", "ignore"], shell: process.platform === "win32" });
    child.on("error", (error) => reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error("Codex is not installed (no `codex` on PATH).") : error));
    child.on("close", (status) => status === 0 ? resolve() : reject(new Error(`codex login exited with ${status ?? "a signal"}.`)));
    child.stdin.on("error", () => undefined);
    child.stdin.end(`${apiKey}\n`);
  });
}

/**
 * Points Codex at the gateway and saves the key with Codex's own `codex login --with-api-key`. The config's top-level `openai_base_url`
 * is written first (so the key is never used against OpenAI's address); if saving the key fails, the config is put back. The previous
 * config.toml and auth.json (which may hold a ChatGPT login) are copied to `*.frely-backup` first; copying them back undoes this.
 * `$CODEX_HOME` is honoured.
 */
export async function writeCodexSettings(input: { home: string; gatewayUrl: string; apiKey: string; codexHome?: string }): Promise<WrittenSettings & { authBackup: string | null }> {
  if (!input.apiKey) throw new Error("No key to write.");
  const dir = input.codexHome ?? join(input.home, ".codex");
  const configPath = join(dir, "config.toml");
  const authPath = join(dir, "auth.json");
  await mkdir(dir, { recursive: true });
  let before: string | null = null;
  try { before = await readFile(configPath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const configBackup = before === null ? null : `${configPath}.frely-backup`;
  if (configBackup) { await copyFile(configPath, configBackup); await chmod(configBackup, 0o600); }
  let authBackup: string | null = null;
  try { await stat(authPath); authBackup = `${authPath}.frely-backup`; await copyFile(authPath, authBackup); await chmod(authBackup, 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeFile(configPath, withCodexBaseUrl(before ?? "", `${input.gatewayUrl}/v1`), { mode: before === null ? 0o600 : undefined });
  try {
    await codexLogin(dir, input.apiKey);
  } catch (error) {
    if (before === null) await rename(configPath, `${configPath}.frely-failed`).catch(() => undefined); else await writeFile(configPath, before);
    throw error;
  }
  return { path: configPath, backup: configBackup, authBackup };
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value. ${USAGE}`);
  return value;
}

/** Runs one `frely key` command; returns the exit code. */
export async function runKeyCommand(args: readonly string[], io: KeySetupIo): Promise<number> {
  if (args[0] !== "setup" || !args[1]) throw new Error(USAGE);
  const agent = args[1];
  if (!(KEY_SETUP_AGENTS as readonly string[]).includes(agent)) throw new Error(`Unsupported agent "${agent}". Supported: ${KEY_SETUP_AGENTS.join(", ")}. ${USAGE}`);
  for (const arg of args.slice(2)) if (arg.startsWith("--") && !["--name", "--gateway", "--json"].includes(arg)) throw new Error(`Unknown option ${arg}. ${USAGE}`);
  const gatewayUrl = checkedGatewayUrl(option(args, "--gateway") ?? DEFAULT_GATEWAY_URL);
  const name = option(args, "--name") ?? `Claude Code on ${io.hostName ?? hostname()}`;
  const json = args.includes("--json");

  const created = await io.call("keys.create", { name });
  const rawKey = created.rawKey;
  const apiKey = created.apiKey && typeof created.apiKey === "object" ? created.apiKey as Record<string, unknown> : {};
  if (typeof rawKey !== "string" || !rawKey) throw new Error("Frely did not return a key, so nothing was written.");
  let written: WrittenSettings & { authBackup?: string | null };
  try {
    const home = io.home ?? homedir();
    written = agent === "codex"
      ? await writeCodexSettings({ home, gatewayUrl, apiKey: rawKey, ...(process.env.CODEX_HOME ? { codexHome: process.env.CODEX_HOME } : {}) })
      : await writeClaudeCodeSettings({ home, gatewayUrl, apiKey: rawKey });
  } catch (error) {
    const keyId = typeof apiKey.id === "string" ? apiKey.id : "";
    throw new Error(`${(error as Error).message} The new key${keyId ? ` ${keyId}` : ""} was created but not saved; delete it on the Keys page or with frely api call keys.revoke.`);
  }
  const label = agent === "codex" ? "Codex" : "Claude Code";
  const summary = { agent, keyId: apiKey.id ?? null, prefix: apiKey.prefix ?? null, settingsPath: written.path, backupPath: written.backup, ...(written.authBackup === undefined ? {} : { authBackupPath: written.authBackup }), gateway: gatewayUrl };
  io.out(json ? `${JSON.stringify(summary)}\n` : `${label} now uses a new Frely key${summary.prefix ? ` (${summary.prefix}…)` : ""} through ${gatewayUrl}.\nSettings: ${written.path}${written.backup ? `\nPrevious settings saved to ${written.backup}` : ""}${written.authBackup ? `\nPrevious login saved to ${written.authBackup}` : ""}\nRestart ${label} to apply it. The key is not shown here.\n`);
  return 0;
}
