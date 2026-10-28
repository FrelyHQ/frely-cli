import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { credentialStore as secureCredentialStore, type CredentialStore } from "../../credential-store.js";
import { sandboxCommandDetailed, sandboxViolationLines } from "../../runtime/sandbox.js";
import { MODEL_HOST } from "./model-proxy.js";

export const API_KEY_SERVICE = "frely-cli-local-agent-key-v1";

/** Where the Agent's model calls go: the public gateway for frely.cloud, the relay itself elsewhere (development). */
export function gatewayOrigin(relayUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FRELY_GATEWAY_URL?.trim();
  const url = new URL(override || relayUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) throw new Error("The Frely gateway must use HTTPS outside loopback development.");
  if (!override && url.hostname === "frely.cloud") return "https://api.frely.cloud";
  return url.origin;
}

/** The key for the Agent's model calls: FRELY_API_KEY when set, else the one saved with `frely agent local key`. */
export async function readApiKey(origin: string, env: NodeJS.ProcessEnv = process.env, store: CredentialStore = secureCredentialStore): Promise<string | undefined> {
  const fromEnv = env.FRELY_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return (await store.getPassword(API_KEY_SERVICE, origin).catch(() => null)) ?? undefined;
}

const PASS_THROUGH = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TZ", "TMPDIR", "SystemRoot"] as const;

/**
 * The environment of the Agent's program. Not the caller's environment: a key or token exported in the shell must not reach code
 * from a repository. Package managers get caches inside the Agent's folder, the only place besides the temp folder they may write.
 */
export function agentEnv(workspace: string, hosts: { model: boolean }, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASS_THROUGH) if (base[name] !== undefined) env[name] = base[name];
  const cache = join(workspace, ".cache");
  Object.assign(env, { XDG_CACHE_HOME: cache, UV_CACHE_DIR: join(cache, "uv"), PIP_CACHE_DIR: join(cache, "pip"), npm_config_cache: join(cache, "npm"), BUN_INSTALL_CACHE_DIR: join(cache, "bun") });
  if (hosts.model) {
    const base = `http://${MODEL_HOST}`;
    Object.assign(env, {
      FRELY_MODEL_BASE_URL: `${base}/v1`,
      OPENAI_BASE_URL: `${base}/v1`, OPENAI_API_BASE: `${base}/v1`, OPENAI_API_KEY: "frely-local-placeholder",
      ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: "frely-local-placeholder",
    });
  }
  return env;
}

export interface Confined { child: ChildProcess; violations(): string[] }

/** Starts `command` inside the sandbox, in the Agent's own folder. Refused, never run bare, when this computer cannot sandbox it. */
export async function spawnConfined(command: string, workspace: string, env: NodeJS.ProcessEnv): Promise<Confined> {
  const wrapped = await sandboxCommandDetailed(command, workspace);
  const child = spawn(wrapped.command, { cwd: workspace, env, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  return { child, violations: () => sandboxViolationLines(wrapped.commandId) };
}
