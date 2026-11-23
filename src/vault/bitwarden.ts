import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The Bitwarden vault behind `site_login`: a dedicated account the owner logged in once with `frely vault login`. The master password
 * arrives through a secret drop (`vault_unlock`), is used for one `bw unlock` and is not kept. The session key lives only in this
 * module's variables (this process's memory): it is never written to disk, never put in the environment of a command the AI runs, and
 * dropped after VAULT_TTL_MS. Every bw call is non-interactive, has stdin on /dev/null and a timeout, so a locked vault cannot hang it.
 */
export const VAULT_TTL_MS = 8 * 60 * 60_000;
const BW_TIMEOUT_MS = 30_000;
export const INSTALL_HINT = "The Bitwarden CLI (bw) is not installed on this computer. Install it with: brew install bitwarden-cli";
export const LOGIN_HINT = "Bitwarden is not logged in on this computer. Ask the user to run `frely vault login` in a terminal on this computer once.";
export const LOCKED_HINT = "The vault is locked. Call secret_drop with target {\"kind\":\"vault_unlock\"} on this device and give the user the link.";

export class VaultLockedError extends Error {
  constructor() { super(LOCKED_HINT); this.name = "VaultLockedError"; }
}

export interface BwResult { code: number | null; stdout: string; stderr: string; missing?: boolean; timedOut?: boolean }
/** Runs `bw` with exactly this environment. Injected in tests; the real one never sees any other variable. */
export type BwRunner = (args: string[], env: Record<string, string>, timeoutMs: number) => Promise<BwResult>;

/** `~/.config/frely/bitwarden` (below the data directory when one is active), inside the folders the command sandbox hides from the AI. */
export function bitwardenDataDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "frely", "bitwarden");
}

/** The environment of every bw call: the data directory and nothing the AI or the service environment could have added. */
export function bwEnv(extra: Record<string, string> = {}, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME ?? homedir(), BITWARDENCLI_APPDATA_DIR: bitwardenDataDir(env) };
  if (env.NODE_EXTRA_CA_CERTS) out.NODE_EXTRA_CA_CERTS = env.NODE_EXTRA_CA_CERTS;
  return { ...out, ...extra };
}

export const defaultBwRunner: BwRunner = (args, env, timeoutMs) => new Promise((resolve) => {
  try { mkdirSync(env.BITWARDENCLI_APPDATA_DIR ?? bitwardenDataDir(), { recursive: true, mode: 0o700 }); } catch { /* bw reports a data directory it cannot use */ }
  const child = spawn("bw", args, { stdio: ["ignore", "pipe", "pipe"], env });
  let stdout = "", stderr = "", timedOut = false, done = false;
  const finish = (result: BwResult) => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 4_000_000) stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString("utf8"); });
  child.on("error", (error: NodeJS.ErrnoException) => finish({ code: null, stdout, stderr: error.message, missing: error.code === "ENOENT" }));
  child.on("close", (code) => finish({ code, stdout, stderr, timedOut }));
});

export interface VaultStatus { status: "locked" | "unlocked"; locksAt?: string }
export interface FoundLogin { status: "found"; username: string; password: string; totp?: string }
export type FindLoginResult = FoundLogin | { status: "no_login_found" } | { status: "ambiguous" };

export interface VaultDeps {
  run?: BwRunner;
  now?: () => number;
  /** Starts the auto-lock timer; returns its cancel. Tests drive this by hand. */
  schedule?: (fn: () => void, ms: number) => () => void;
  env?: NodeJS.ProcessEnv;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => { const timer = setTimeout(fn, ms); timer.unref(); return () => clearTimeout(timer); };
const SESSION_GONE = /locked|not logged in|unauthenticated|invalid session|session key/iu;

/** One vault in one process; `createVault` makes isolated ones for tests, the exported functions below use the real one. */
export function createVault(deps: VaultDeps = {}) {
  const run = deps.run ?? defaultBwRunner;
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? defaultSchedule;
  const env = deps.env ?? process.env;
  let session: string | null = null;
  let lockAt = 0;
  let cancelTimer: (() => void) | null = null;

  const drop = (): void => { session = null; lockAt = 0; cancelTimer?.(); cancelTimer = null; };
  const locksAt = (): string => new Date(lockAt).toISOString();

  async function lock(): Promise<void> {
    drop();
    await run(["lock", "--nointeraction"], bwEnv({}, env), BW_TIMEOUT_MS).catch(() => undefined);
  }

  async function unlock(master: Buffer): Promise<{ locksAt: string }> {
    const status = await run(["status", "--nointeraction"], bwEnv({}, env), BW_TIMEOUT_MS);
    if (status.missing) throw new Error(INSTALL_HINT);
    let state: unknown;
    try { state = (JSON.parse(status.stdout) as { status?: unknown }).status; } catch { state = undefined; }
    if (state === "unauthenticated") throw new Error(LOGIN_HINT);
    const result = await run(["unlock", "--passwordenv", "BW_PASSWORD", "--raw", "--nointeraction"], bwEnv({ BW_PASSWORD: master.toString("utf8") }, env), BW_TIMEOUT_MS);
    if (result.missing) throw new Error(INSTALL_HINT);
    const key = result.stdout.trim();
    if (result.code !== 0 || !key) {
      if (/not logged in|unauthenticated/iu.test(result.stderr)) throw new Error(LOGIN_HINT);
      throw new Error(result.timedOut ? "Bitwarden did not answer in time." : "Bitwarden did not unlock. The master password may be wrong.");
    }
    drop();
    session = key;
    lockAt = now() + VAULT_TTL_MS;
    cancelTimer = schedule(() => { void lock(); }, VAULT_TTL_MS);
    return { locksAt: locksAt() };
  }

  function status(): VaultStatus {
    if (session && now() >= lockAt) { void lock(); }
    return session ? { status: "unlocked", locksAt: locksAt() } : { status: "locked" };
  }

  /**
   * The one login saved for this exact https origin. `bw list items --url` matches loosely (any scheme, subdomains), so the match is
   * redone here: the page origin must be https and equal to the origin of one of the item's URIs. None or several is never guessed.
   */
  async function findLogin(origin: string): Promise<FindLoginResult> {
    if (status().status !== "unlocked") throw new VaultLockedError();
    let page: URL;
    try { page = new URL(origin); } catch { return { status: "no_login_found" }; }
    if (page.protocol !== "https:") return { status: "no_login_found" };
    const bwSession = { BW_SESSION: session! };
    const listed = await run(["list", "items", "--url", page.origin, "--nointeraction"], bwEnv(bwSession, env), BW_TIMEOUT_MS);
    if (listed.code !== 0) {
      if (SESSION_GONE.test(listed.stderr)) { drop(); throw new VaultLockedError(); }
      throw new Error(listed.timedOut ? "Bitwarden did not answer in time." : "Bitwarden could not list the saved logins.");
    }
    let items: unknown;
    try { items = JSON.parse(listed.stdout); } catch { throw new Error("Bitwarden returned a list this computer could not read."); }
    const matches = (Array.isArray(items) ? items : []).filter((item): item is BwItem => isLoginFor(item, page.origin));
    if (matches.length === 0) return { status: "no_login_found" };
    if (matches.length > 1) return { status: "ambiguous" };
    const item = matches[0]!;
    const { username, password, totp } = item.login;
    if (typeof username !== "string" || !username || typeof password !== "string" || !password) return { status: "no_login_found" };
    let code: string | undefined;
    if (typeof totp === "string" && totp) {
      const got = await run(["get", "totp", item.id, "--nointeraction"], bwEnv(bwSession, env), BW_TIMEOUT_MS);
      if (got.code === 0 && /^[0-9]{4,10}$/u.test(got.stdout.trim())) code = got.stdout.trim();
    }
    return { status: "found", username, password, ...(code ? { totp: code } : {}) };
  }

  return { unlock, lock, status, findLogin };
}

interface BwItem { id: string; type: number; login: { username?: unknown; password?: unknown; totp?: unknown; uris?: unknown } }

function isLoginFor(item: unknown, origin: string): item is BwItem {
  if (!item || typeof item !== "object") return false;
  const i = item as Partial<BwItem>;
  if (i.type !== 1 || typeof i.id !== "string" || !i.login || typeof i.login !== "object" || !Array.isArray(i.login.uris)) return false;
  return i.login.uris.some((entry: unknown) => {
    const uri = entry && typeof entry === "object" ? (entry as { uri?: unknown }).uri : undefined;
    try { return typeof uri === "string" && new URL(uri).origin === origin; } catch { return false; }
  });
}

const vault = createVault();
/** Unlocks with the master password (the buffer is the caller's to zero) and keeps the session key in memory for VAULT_TTL_MS. */
export const unlockVault = (master: Buffer): Promise<{ locksAt: string }> => vault.unlock(master);
export const lockVault = (): Promise<void> => vault.lock();
export const vaultStatus = (): VaultStatus => vault.status();
export const findLogin = (origin: string): Promise<FindLoginResult> => vault.findLogin(origin);
