import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { unlinkSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deviceStatePath } from "./state.js";

/** The relay service of one device key: one per data directory, next to `device-basic-v1.json`. */
export function relayInstanceLockPath(): string {
  return join(dirname(deviceStatePath()), "relay-service.lock");
}

export interface RelayInstanceOwner { pid: number; startedAt: string; entry: string; version: string }

export class RelayInstanceBusyError extends Error {
  constructor(readonly owner: RelayInstanceOwner | null) {
    super(owner
      ? `Another Frely device relay (pid ${owner.pid}, ${owner.entry}, version ${owner.version}, started ${owner.startedAt}) already serves this computer. Stop it first: run only one \`frely link\` service per computer.`
      : "Another Frely device relay already serves this computer. Stop it first: run only one `frely link` service per computer.");
    this.name = "Error";
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function parseOwner(text: string | null): RelayInstanceOwner | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<RelayInstanceOwner>;
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return null;
    return { pid: Number(value.pid), startedAt: String(value.startedAt ?? "unknown"), entry: String(value.entry ?? "unknown"), version: String(value.version ?? "unknown") };
  } catch { return null; }
}

/**
 * Takes the device relay lock for this data directory. Two relays with one device key make the relay close the older connection (4409),
 * and the two then take turns cancelling each other's commands and run every scheduled task twice.
 * Waits up to `waitMs` for a holder that is shutting down (a service restart starts the next process before the old one has exited).
 * A lock left by a process that no longer exists is taken over.
 */
export async function acquireRelayInstanceLock(info: { entry: string; version: string }, options: { waitMs?: number; path?: string; isAlive?: (pid: number) => boolean } = {}): Promise<() => void> {
  const path = options.path ?? relayInstanceLockPath();
  const isAlive = options.isAlive ?? alive;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const value = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), entry: info.entry, version: info.version } satisfies RelayInstanceOwner);
  const deadline = Date.now() + (options.waitMs ?? 15_000);
  let unreadableSince: number | undefined;
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(value); } finally { await handle.close(); }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.off("exit", release);
        // Never remove a lock another process took over.
        try { if (readFileSync(path, "utf8") === value) unlinkSync(path); } catch { /* already gone */ }
      };
      process.once("exit", release);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) continue; // released while we looked
    const owner = parseOwner(text);
    if (owner && owner.pid !== process.pid && isAlive(owner.pid)) {
      if (Date.now() >= deadline) throw new RelayInstanceBusyError(owner);
      await delay(250);
      continue;
    }
    // Unreadable content may be a holder still writing it: give it a second before treating the lock as abandoned.
    if (!owner) {
      unreadableSince ??= Date.now();
      if (Date.now() - unreadableSince < 1000) { await delay(100); continue; }
    }
    // A holder that no longer exists (crash, kill -9): take the lock over, unless it changed while we looked.
    if (await readFile(path, "utf8").catch(() => null) === text) await unlink(path).catch(() => undefined);
    unreadableSince = undefined;
  }
}
