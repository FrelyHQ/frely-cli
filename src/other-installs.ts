import { execFile as execFileCallback } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { IS_STANDALONE } from "./cli-launch.js";

const execFile = promisify(execFileCallback);

/**
 * The first version that refreshes the login under a lock and re-reads the saved login first. An older copy sharing this computer's
 * login can send a refresh token another copy already rotated, and the server then signs the login out.
 */
export const SAFE_REFRESH_VERSION = "0.23.34";

/** Every `frely` executable on PATH, resolved to its real file, in PATH order. */
export async function frelyOnPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const found: string[] = [];
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const suffix of platform === "win32" ? [".exe", ".cmd", ""] : [""]) {
      const path = join(directory, "frely" + suffix);
      if (await access(path, constants.X_OK).then(() => true, () => false)) {
        const real = await realpath(path).catch(() => path);
        if (!found.includes(real)) found.push(real);
      }
    }
  }
  return found;
}

export function olderThan(version: string, minimum: string): boolean {
  const parse = (value: string) => (/^(\d+)\.(\d+)\.(\d+)/u.exec(value.trim())?.slice(1).map(Number)) ?? null;
  const a = parse(version), b = parse(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  return false;
}

export interface OtherInstall { path: string; version: string | null; unsafeRefresh: boolean }

/** Other copies of frely this user can run, with their versions (null when `--version` did not answer). */
export async function otherInstalls(options: { current?: string; paths?: string[]; version?: (path: string) => Promise<string | null> } = {}): Promise<OtherInstall[]> {
  const current = options.current ?? await realpath(IS_STANDALONE ? process.execPath : process.argv[1] ?? "").catch(() => "");
  const version = options.version ?? (async (path: string) => {
    try { return (await execFile(path, ["--version"], { timeout: 3000, maxBuffer: 64 * 1024 })).stdout.trim() || null; } catch { return null; }
  });
  const others = (options.paths ?? await frelyOnPath()).filter((path) => path !== current);
  return Promise.all(others.map(async (path) => {
    const found = await version(path);
    return { path, version: found, unsafeRefresh: found !== null && olderThan(found, SAFE_REFRESH_VERSION) };
  }));
}

/**
 * The command that removes just that copy (never `frely uninstall`, which would also sign this computer out): an npm or bun global
 * package by its own package manager, a standalone file by deleting it. Null when the owner cannot be told from the path.
 */
export function removalCommand(path: string, platform: NodeJS.Platform = process.platform): string | null {
  const quote = (value: string) => platform === "win32" ? `"${value}"` : `'${value.replace(/'/gu, `'\\''`)}'`;
  const marker = `${sep}node_modules${sep}frely-cli${sep}`;
  const at = path.indexOf(marker);
  if (at >= 0) {
    if (path.includes(`${sep}.bun${sep}`)) return "bun remove -g frely-cli";
    // <prefix>/lib/node_modules on macOS and Linux (nvm, Homebrew node, system node); <prefix>\node_modules on Windows.
    const modules = path.slice(0, at);
    const prefix = platform === "win32" ? modules : dirname(modules);
    const npm = platform === "win32" ? "npm" : join(prefix, "bin", "npm");
    return `${quote(npm)} uninstall -g --prefix ${quote(prefix)} frely-cli`;
  }
  if (/[\\/]frely(?:\.exe)?$/u.test(path)) return platform === "win32" ? `del ${quote(path)}` : `rm ${quote(path)}`;
  return null;
}

/** One line per other copy, for `frely login` and `frely link on`; empty when this is the only one. */
export function otherInstallNotes(installs: OtherInstall[], platform: NodeJS.Platform = process.platform): string[] {
  return installs.map((install) => {
    const command = removalCommand(install.path, platform);
    const remove = command ? ` Remove it with: ${command}` : " Remove it with the tool that installed it.";
    return install.unsafeRefresh
      ? `Warning: an older frely ${install.version} is also installed at ${install.path}. It shares this computer's login and can sign it out.${remove}`
      : `Note: another frely${install.version ? ` ${install.version}` : ""} is installed at ${install.path}. Keep one copy so the background service and your shell run the same version.${remove}`;
  });
}
