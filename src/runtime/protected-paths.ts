import { homedir } from "node:os";
import { join, sep } from "node:path";
import { realpathSync } from "node:fs";
import { protectedWriteDenials, SENSITIVE_PATH_GROUPS, sensitiveReadPaths } from "./sandbox.js";

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
  /** Everything readBlocked covers, approved credential stores included, plus every protected path (start-up files, launch agents). */
  writeBlocked(path: string): boolean;
}

/**
 * File tools share the command sandbox's credential list (`sandbox.ts`), so a workspace that contains the
 * home directory does not turn read_file into a way around the sandbox. `grants` are the group names the
 * relay approved for this call.
 */
export function pathProtection(grants: readonly string[] = []): PathProtection {
  const readRoots = sensitiveReadPaths(grants).flatMap(variants);
  // Same protected list as the command sandbox. A `path:` grant (extra writable directory for commands) does not lift it for file
  // tools: they check readability before writing, and `path:` must not open reads. Reading a credential store (the `ssh` group)
  // never allows writing it. sensitiveReadPaths(all groups) leaves just the never-openable paths.
  const writeRoots = [...protectedWriteDenials([]), ...sensitiveReadPaths(Object.keys(SENSITIVE_PATH_GROUPS))].flatMap(variants);
  return {
    readBlocked: (path) => readRoots.some((root) => under(path, root)),
    writeBlocked: (path) => writeRoots.some((root) => under(path, root)),
  };
}
