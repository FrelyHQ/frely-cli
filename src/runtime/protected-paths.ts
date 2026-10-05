import { homedir } from "node:os";
import { join, sep } from "node:path";
import { realpathSync } from "node:fs";
import { SENSITIVE_PATH_GROUPS, sensitiveReadPaths } from "./sandbox.js";

/** Shell start-up files: a remote file tool must not plant commands that run at the owner's next login. */
const SHELL_STARTUP_FILES = [".zshrc", ".zshenv", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".bash_login", ".profile", ".config/fish/config.fish"].map((name) => `~/${name}`);

function expand(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** The lexical path plus its canonical form, so a symlinked home directory does not hide a match. */
function variants(path: string): string[] {
  const lexical = expand(path);
  const set = new Set([lexical]);
  const real = (() => { try { return realpathSync(lexical); } catch { return undefined; } })();
  if (real) set.add(real);
  const home = (() => { try { return realpathSync(homedir()); } catch { return undefined; } })();
  if (home && path.startsWith("~/")) set.add(join(home, path.slice(2)));
  return [...set];
}

function under(path: string, base: string): boolean {
  if (process.platform === "win32") { path = path.toLowerCase(); base = base.toLowerCase(); }
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

export interface PathProtection {
  /** Credential stores that were not approved for this call (and the never-openable ones). */
  readBlocked(path: string): boolean;
  /** Everything readBlocked covers, approved credential stores included, plus shell start-up files. */
  writeBlocked(path: string): boolean;
}

/**
 * File tools share the command sandbox's credential list (`sandbox.ts`), so a workspace that contains the
 * home directory does not turn read_file into a way around the sandbox. `grants` are the group names the
 * relay approved for this call.
 */
export function pathProtection(grants: readonly string[] = []): PathProtection {
  const readRoots = sensitiveReadPaths(grants).flatMap(variants);
  const writeRoots = [...Object.values(SENSITIVE_PATH_GROUPS).flat(), ...sensitiveReadPaths(), ...SHELL_STARTUP_FILES].flatMap(variants);
  return {
    readBlocked: (path) => readRoots.some((root) => under(path, root)),
    writeBlocked: (path) => writeRoots.some((root) => under(path, root)),
  };
}
