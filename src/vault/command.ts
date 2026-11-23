import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { bitwardenDataDir, bwEnv, defaultBwRunner, INSTALL_HINT, type BwRunner } from "./bitwarden.js";

// `frely vault login|status|lock`: the one terminal step of Bitwarden site login. `login` points bw at the dedicated account's data directory
// (inside the folders the command sandbox hides from the AI) and lets the owner sign in there; the master password is typed into bw itself.

export interface VaultCommandIo {
  out: (text: string) => void;
  /** Runs bw attached to the owner's terminal (prompts and answers go straight to them). Resolves with the exit code, or null when bw is missing. */
  interactive?: (args: string[], env: Record<string, string>) => Promise<number | null>;
  run?: BwRunner;
}

const USAGE = "Usage: frely vault login [--server <url>] | frely vault status | frely vault lock";

const attached = (args: string[], env: Record<string, string>): Promise<number | null> => new Promise((resolve) => {
  try { mkdirSync(env.BITWARDENCLI_APPDATA_DIR ?? bitwardenDataDir(), { recursive: true, mode: 0o700 }); } catch { /* bw reports a folder it cannot use */ }
  const child = spawn("bw", args, { stdio: "inherit", env });
  child.on("error", () => resolve(null));
  child.on("close", (code) => resolve(code));
});

export async function runVaultCommand(args: readonly string[], io: VaultCommandIo): Promise<number> {
  const [sub, ...rest] = args;
  const run = io.run ?? defaultBwRunner;
  if (sub === "login") {
    let server: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--server") server = rest[++i];
      else throw new Error(`Unknown option ${rest[i]}. ${USAGE}`);
    }
    if (rest.includes("--server") && !server) throw new Error("--server needs a URL.");
    if (server) {
      let url: URL;
      try { url = new URL(server); } catch { throw new Error("--server must be an https URL."); }
      if (url.protocol !== "https:") throw new Error("--server must be an https URL.");
    }
    const interactive = io.interactive ?? attached;
    // The terminal is needed for the prompts, so this is the one bw call that is not --nointeraction; TERM is passed for that reason only.
    const env = bwEnv(process.env.TERM ? { TERM: process.env.TERM } : {});
    io.out(`Signing in to the dedicated Bitwarden account. Data folder: ${bitwardenDataDir()}\n`);
    if (server && await interactive(["config", "server", server], env) !== 0) return failed(io, "bw could not set the server.");
    const code = await interactive(["login"], env);
    if (code === null) { io.out(`${INSTALL_HINT}\n`); return 1; }
    // `bw login` prints a session key to the terminal; lock right away so the one that was shown no longer opens anything.
    await run(["lock", "--nointeraction"], bwEnv(), 30_000).catch(() => undefined);
    if (code !== 0) return failed(io, "bw login did not finish.");
    io.out("Signed in. Now ask your AI to unlock the vault (secret_drop with target kind vault_unlock) and use site_login.\n");
    return 0;
  }
  if (sub === "status") {
    const result = await run(["status", "--nointeraction"], bwEnv(), 30_000);
    if (result.missing) { io.out(`${INSTALL_HINT}\n`); return 1; }
    let state = "unknown";
    try { const parsed = JSON.parse(result.stdout) as { status?: unknown }; if (typeof parsed.status === "string") state = parsed.status; } catch { /* reported as unknown */ }
    io.out(`Bitwarden account: ${state === "unauthenticated" ? "not logged in (run frely vault login)" : "logged in"}\nData folder: ${bitwardenDataDir()}\nThe unlock itself lives in the running service's memory and is not shown here; it ends 8 hours after the owner unlocked.\n`);
    return result.code === 0 ? 0 : 1;
  }
  if (sub === "lock") {
    io.out("frely vault lock cannot reach the running service yet. The vault locks itself 8 hours after it was unlocked; stopping the service (frely mcp service stop) forgets it at once.\n");
    return 1;
  }
  io.out(`${USAGE}\n`);
  return sub === undefined ? 0 : 1;
}

function failed(io: VaultCommandIo, message: string): number { io.out(`${message}\n`); return 1; }
