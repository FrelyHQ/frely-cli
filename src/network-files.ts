import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { NetworkError } from "./network-errors.js";

export type NetworkHost = "chatgpt" | "claude-code" | "opencode" | "generic";
export interface NetworkConfig { version: 1; origin: string; host: NetworkHost; }
export const hashText = (value: string): string => createHash("sha256").update(value).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Reject ancestor symlinks, including dangling links. Never traverse a user-managed redirect. */
export async function assertSafePath(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    const stat = await lstat(current).catch((error: unknown) => { if (absent(error)) return null; throw error; });
    if (stat?.isSymbolicLink()) throw new NetworkError("UNSAFE_LOCAL_PATH");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
async function readOwnedFile(path: string, maxBytes = 512 * 1024): Promise<string | null> {
  await assertSafePath(path);
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (absent(error)) return null; throw new NetworkError("LOCAL_FILE_READ_FAILED"); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new NetworkError("LOCAL_FILE_INVALID");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}
async function atomicWrite(path: string, value: string): Promise<void> {
  await assertSafePath(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertSafePath(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(value, "utf8"); await file.sync(); }
  finally { await file.close(); }
  try { await assertSafePath(path); await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => undefined); }
}
export class NetworkFiles {
  readonly directory: string;
  constructor(private readonly home: string) { this.directory = join(home, ".config", "frely", "network"); }
  async readConfig(): Promise<NetworkConfig | null> {
    const text = await readOwnedFile(join(this.directory, "config.json"), 4096);
    if (text === null) return null;
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new NetworkError("LOCAL_CONFIG_INVALID"); }
    if (!record(value) || value.version !== 1 || typeof value.origin !== "string" ||
        !["chatgpt", "claude-code", "opencode", "generic"].includes(String(value.host))) throw new NetworkError("LOCAL_CONFIG_INVALID");
    return { version: 1, origin: value.origin, host: value.host as NetworkHost };
  }
  async writeConfig(value: NetworkConfig): Promise<void> { await atomicWrite(join(this.directory, "config.json"), JSON.stringify(value)); }

  /** Serialize local grant exchange so competing CLI calls cannot consume or delete each other's session. */
  async lock(): Promise<() => Promise<void>> {
    await assertSafePath(this.directory);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "command.lock");
    await assertSafePath(path);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(path, "wx", 0o600);
        const value = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
        await handle.writeFile(value); await handle.close();
        return async () => {
          // Do not remove a lock replaced by another process.
          if (await readOwnedFile(path, 512) === value) await unlink(path).catch(() => undefined);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new NetworkError("LOCAL_LOCK_FAILED");
        const text = await readOwnedFile(path, 512);
        let pid = 0;
        try { const item: unknown = JSON.parse(text ?? "null"); if (record(item) && Number.isSafeInteger(item.pid) && Number(item.pid) > 0) pid = Number(item.pid); }
        catch { /* Unknown lock ownership must not be overwritten. */ }
        if (!pid) throw new NetworkError("NETWORK_CLIENT_BUSY");
        let alive = true;
        try { process.kill(pid, 0); } catch (failure) { alive = (failure as NodeJS.ErrnoException).code !== "ESRCH"; }
        if (alive || attempt > 0) throw new NetworkError("NETWORK_CLIENT_BUSY");
        if (await readOwnedFile(path, 512) === text) await unlink(path);
      }
    }
    throw new NetworkError("NETWORK_CLIENT_BUSY");
  }

  async installSkill(host: NetworkHost, skill: string): Promise<{ instructionMode: "conversation" | "skill"; installed: boolean }> {
    if (host === "chatgpt") return { instructionMode: "conversation", installed: false };
    const root = host === "claude-code" ? join(this.home, ".claude", "skills") :
      host === "opencode" ? join(this.home, ".config", "opencode", "skills") : join(this.home, ".agents", "skills");
    const path = join(root, "frely-network", "SKILL.md");
    const metadata = join(root, "frely-network", ".frely-managed.json");
    const text = await readOwnedFile(path);
    const metadataText = await readOwnedFile(metadata, 4096);
    let marker: Record<string, unknown> | null = null;
    if (metadataText !== null) {
      try { const value: unknown = JSON.parse(metadataText); if (record(value)) marker = value; } catch { /* Fail closed below. */ }
      if (!marker || marker.version !== 1 || marker.owner !== "frely-network") throw new NetworkError("UNMANAGED_SKILL_EXISTS");
    }
    if (text !== null && (!marker || (hashText(text) !== marker.sha256 && hashText(text) !== marker.pendingSha256))) {
      throw new NetworkError("UNMANAGED_SKILL_EXISTS");
    }
    const hash = hashText(skill);
    // A pending hash recovers an interrupted managed-file replacement, not an unowned file.
    await atomicWrite(metadata, JSON.stringify({ version: 1, owner: "frely-network", sha256: text === null ? null : hashText(text), pendingSha256: hash }));
    await atomicWrite(path, skill);
    await atomicWrite(metadata, JSON.stringify({ version: 1, owner: "frely-network", sha256: hash }));
    return { instructionMode: "skill", installed: true };
  }
}
