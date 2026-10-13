import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Parent of the named data directories: `--data-dir work` means `~/.config/frely/accounts/work`. */
export function accountsRoot(home = homedir()): string { return join(home, ".config", "frely", "accounts"); }

/** The data directory a `--data-dir` / `FRELY_HOME` value names: absolute paths as given, anything else a name below `accountsRoot`. */
export function resolveDataDir(value: string, home = homedir()): string {
  const trimmed = value.trim();
  if (!trimmed || /[\x00-\x1f\x7f]/u.test(trimmed)) throw new Error("--data-dir must be a non-empty path or name.");
  if (isAbsolute(trimmed)) return resolve(trimmed);
  if (trimmed.split(/[\\/]/u).includes("..")) throw new Error("--data-dir names cannot contain '..'.");
  return resolve(accountsRoot(home), trimmed);
}

/**
 * Isolate this process in one data directory (development use: several accounts on one machine).
 * Strips `--data-dir <value>` from the arguments and points every XDG location at the directory,
 * so credentials, device identity, MCP authorization and state all live there.
 */
export function applyDataDir(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const args: string[] = [];
  let value = env.FRELY_HOME;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--data-dir") {
      value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error("--data-dir needs a path or name.");
    } else if (arg.startsWith("--data-dir=")) value = arg.slice("--data-dir=".length);
    else args.push(arg);
  }
  if (value === undefined || value === "") return args;
  const dir = resolveDataDir(value, home);
  env.FRELY_DATA_DIR = dir;
  env.XDG_CONFIG_HOME = dir;
  env.XDG_STATE_HOME = join(dir, "state");
  env.XDG_RUNTIME_DIR = join(dir, "run");
  return args;
}

/** The active data directory, or undefined when running with the default locations. */
export function activeDataDir(env: NodeJS.ProcessEnv = process.env): string | undefined { return env.FRELY_DATA_DIR || undefined; }
