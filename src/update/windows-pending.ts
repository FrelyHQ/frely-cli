import { createHash } from "node:crypto";
import { copyFile, readFile, rename, rm, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Installation } from "./installation.js";
import { installedVersion } from "./update.js";

/**
 * Windows fallback. When the running `frely.exe` cannot be renamed (security software, a handle another program holds), the verified
 * new executable is kept next to it as `frely.exe.new` and the next start of the background service finishes the swap: at that moment
 * nothing holds the file yet. Same idea as Chrome's `new_chrome.exe`, only without a versioned folder.
 */
export const pendingMarkerPath = (directory = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely")): string => join(directory, "update-pending");
const stagedPath = (installation: Installation): string => `${installation.entry}.new`;

interface Pending { version: string; sha256: string }
const sha256 = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");

/** Windows reports a file in use as one of these; anything else is a real failure and not worth waiting for a restart. */
export const isFileInUse = (error: unknown): boolean => ["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");

export async function stagePendingUpdate(installation: Installation, version: string, verified: string, marker = pendingMarkerPath()): Promise<void> {
  const target = stagedPath(installation);
  await copyFile(verified, target);
  await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
  await writeFile(marker, JSON.stringify({ version, sha256: await sha256(target) } satisfies Pending), { mode: 0o600 });
}

export async function pendingVersion(marker = pendingMarkerPath()): Promise<string | null> {
  try { return (JSON.parse(await readFile(marker, "utf8")) as Pending).version; } catch { return null; }
}

/** Finishes a staged update at service start. Returns the new version, or null when nothing was staged or it could not be applied. */
export async function applyPendingUpdate(installation: Installation, marker = pendingMarkerPath(), execute = installedVersion): Promise<string | null> {
  if (installation.platform !== "win32" || installation.method !== "standalone") return null;
  let pending: Pending;
  try { pending = JSON.parse(await readFile(marker, "utf8")) as Pending; } catch { return null; }
  const staged = stagedPath(installation);
  try {
    if (await sha256(staged) !== pending.sha256) throw new Error("Staged executable does not match its checksum.");
    if (await execute({ ...installation, entry: staged }) !== pending.version) throw new Error("Staged executable does not report the expected version.");
  } catch { await rm(staged, { force: true }).catch(() => {}); await rm(marker, { force: true }).catch(() => {}); return null; }
  const aside = `${installation.entry}.old-${Date.now()}`;
  try {
    await rename(installation.entry, aside);
    try { await rename(staged, installation.entry); } catch (error) { await rename(aside, installation.entry).catch(() => {}); throw error; }
  } catch { return null; } // Still held: the marker and the staged file stay for the next start.
  await rm(marker, { force: true }).catch(() => {});
  return pending.version;
}
