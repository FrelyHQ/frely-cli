import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * One limit per model endpoint, shared by every process on this computer: the local tasks (each in its own worker) and the remote
 * callers served by the background service. A slot is a file named for its number; it holds the owner's process id, so a slot whose
 * owner died is taken over. A local task waits for a slot; a remote caller is refused at once while a local task waits ("local first").
 */
export type SlotKind = "task" | "remote";

export interface SlotOptions {
  readonly kind: SlotKind;
  /** How long a `task` caller may wait. A `remote` caller never waits. */
  readonly waitMs?: number;
  readonly signal?: AbortSignal;
  readonly pollMs?: number;
}

export type ReleaseSlot = () => Promise<void>;

const root = (): string => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "endpoint-slots");
const dirFor = (key: string): string => join(root(), createHash("sha256").update(key).digest("hex").slice(0, 24));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function ownerAlive(path: string): Promise<boolean> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return false;
  try { return alive((JSON.parse(raw) as { pid: number }).pid); } catch { return false; }
}

async function tryTake(dir: string, limit: number, token: string): Promise<string | undefined> {
  for (let index = 0; index < limit; index += 1) {
    const path = join(dir, `slot-${index}`);
    try { await writeFile(path, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 }); return path; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await ownerAlive(path))) {
        // The owner is gone: take the slot over. Two takers may race; the one whose token is in the file after the write keeps it.
        await rm(path, { force: true });
        try { await writeFile(path, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 }); return path; } catch { /* someone else took it */ }
      }
    }
  }
  return undefined;
}

async function liveWaiters(dir: string): Promise<number> {
  const names = await readdir(join(dir, "waiting")).catch(() => [] as string[]);
  let count = 0;
  for (const name of names) {
    if (await ownerAlive(join(dir, "waiting", name))) count += 1; else await rm(join(dir, "waiting", name), { force: true });
  }
  return count;
}

/** Takes one of `limit` slots of `key`, or returns undefined when none became free (a remote caller at once, a task after `waitMs`). */
export async function acquireEndpointSlot(key: string, limit: number, options: SlotOptions): Promise<ReleaseSlot | undefined> {
  const dir = dirFor(key);
  await mkdir(join(dir, "waiting"), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const release = (path: string): ReleaseSlot => async () => {
    const raw = await readFile(path, "utf8").catch(() => null);
    if (raw !== null && (JSON.parse(raw) as { token?: string }).token === token) await rm(path, { force: true });
  };
  if (options.kind === "remote") {
    if ((await liveWaiters(dir)) > 0) return undefined;
    const path = await tryTake(dir, limit, token);
    return path === undefined ? undefined : release(path);
  }
  const first = await tryTake(dir, limit, token);
  if (first !== undefined) return release(first);
  const marker = join(dir, "waiting", token);
  await writeFile(marker, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
  const deadline = Date.now() + (options.waitMs ?? 120_000);
  try {
    while (Date.now() < deadline && !options.signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 150));
      const path = await tryTake(dir, limit, token);
      if (path !== undefined) return release(path);
    }
    return undefined;
  } finally {
    await rm(marker, { force: true });
  }
}
