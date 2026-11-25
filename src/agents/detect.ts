import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { AgentDetection } from "./types.js";

/** Places where user-installed programs usually are, on top of PATH (a background service starts with a short PATH). */
export function searchDirectories(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const extra = [
    "/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), join(home, ".bun", "bin"), join(home, ".npm-global", "bin"),
    join(home, "Library", "pnpm"), join(home, "Library", "pnpm", "bin"), join(home, ".local", "share", "pnpm"), join(home, ".claude", "local"),
  ];
  return [...new Set([...(env.PATH ?? "").split(delimiter).filter(Boolean), ...extra])];
}

async function executable(path: string): Promise<boolean> {
  try { await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return true; } catch { return false; }
}

/** The first `binary` on the search path, or undefined. */
export async function findBinary(binary: string, env: NodeJS.ProcessEnv = process.env, home?: string): Promise<string | undefined> {
  const names = process.platform === "win32" ? [`${binary}.cmd`, `${binary}.exe`, binary] : [binary];
  for (const directory of searchDirectories(env, home)) for (const name of names) {
    const candidate = join(directory, name);
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

function versionOf(path: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(path, ["--version"], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      const first = error ? undefined : stdout.split("\n").find((line) => line.trim() !== "")?.trim();
      resolve(first === undefined ? undefined : /(\d+\.\d+\.\d+[^\s]*)/u.exec(first)?.[1] ?? first.slice(0, 60));
    });
  });
}

/** Whether the program is installed and which version it reports. Never runs anything but `--version`. */
export async function detectBinary(binary: string, options: { env?: NodeJS.ProcessEnv; home?: string; timeoutMs?: number } = {}): Promise<AgentDetection> {
  const path = await findBinary(binary, options.env, options.home);
  if (path === undefined) return { installed: false };
  const version = await versionOf(path, options.timeoutMs ?? 5000);
  return { installed: true, path, ...(version === undefined ? {} : { version }) };
}
