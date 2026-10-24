import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * What Frely knows about a Skill or Prompt folder it wrote. It lives under the
 * Frely config directory, never inside the folder, so an installed Skill is
 * byte-for-byte what a person would have copied there by hand.
 */
export interface InstallRecord {
  readonly version: 1;
  readonly kind: "skill" | "prompt" | "entry";
  readonly itemId: string;
  readonly path: string;
  /** Relative path to SHA-256 of every file Frely wrote. */
  readonly files: Readonly<Record<string, string>>;
  /** Digest of `files` the user (or their agent) reviewed, if any. */
  readonly trustedDigest?: string;
}

export function installsDir(home = homedir()): string { return join(home, ".config", "frely", "installs"); }
function recordFile(path: string, home: string): string { return join(installsDir(home), `${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 32)}.json`); }

export function filesDigest(files: Readonly<Record<string, string>>): string {
  const lines = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, sha256]) => `${path}:${sha256}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export async function readInstall(path: string, home = homedir()): Promise<InstallRecord | null> {
  const text = await readFile(recordFile(path, home), "utf8").catch((error: unknown) => { if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null; throw error; });
  return text === null ? null : parse(text, resolve(path));
}

export async function writeInstall(record: InstallRecord, home = homedir()): Promise<void> {
  const target = recordFile(record.path, home);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(`${JSON.stringify({ ...record, path: resolve(record.path) }, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temporary, target); }
  finally { await unlink(temporary).catch(() => undefined); }
}

export async function deleteInstall(path: string, home = homedir()): Promise<void> {
  await unlink(recordFile(path, home)).catch((error: unknown) => { if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error; });
}

export async function listInstalls(home = homedir()): Promise<InstallRecord[]> {
  const names = await readdir(installsDir(home)).catch(() => [] as string[]);
  const records: InstallRecord[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const text = await readFile(join(installsDir(home), name), "utf8").catch(() => null);
    const record = text === null ? null : parse(text, null);
    if (record) records.push(record);
  }
  return records;
}

/** True when every file Frely wrote is still there, unchanged. */
export async function untouched(record: InstallRecord): Promise<boolean> {
  for (const [path, sha256] of Object.entries(record.files)) {
    const content = await readFile(join(record.path, path)).catch(() => null);
    if (content === null || createHash("sha256").update(content).digest("hex") !== sha256) return false;
  }
  return true;
}

function parse(text: string, expectedPath: string | null): InstallRecord | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  const item = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const files = item?.files !== null && typeof item?.files === "object" && !Array.isArray(item?.files) ? item.files as Record<string, unknown> : null;
  if (!item || !files || item.version !== 1 || !["skill", "prompt", "entry"].includes(String(item.kind)) || typeof item.itemId !== "string" || typeof item.path !== "string") return null;
  if (expectedPath !== null && item.path !== expectedPath) return null;
  if (!Object.values(files).every((entry) => typeof entry === "string")) return null;
  return Object.freeze({ version: 1, kind: item.kind as InstallRecord["kind"], itemId: item.itemId, path: item.path, files: files as Record<string, string>, ...(typeof item.trustedDigest === "string" ? { trustedDigest: item.trustedDigest } : {}) });
}
