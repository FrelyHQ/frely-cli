import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tasksDir } from "./definition.js";
import type { TaskWorkspace } from "./run-store.js";

/** What the owner approved when sharing a task. Kept outside the definition so a changed definition cannot carry its approval along. */
export interface TaskShare {
  readonly name: string;
  /** The definition hash the owner approved; a different hash delists the share. */
  readonly approvedHash: string;
  readonly workspace: TaskWorkspace;
  /** The owner accepted that each call may use the Frely gateway and deduct model fees from their Credit. */
  readonly allowCredit: boolean;
  readonly description: string;
  readonly serviceShareId: string;
  /** The loopback port the daemon serves this share's A2A endpoint on. */
  port: number;
  readonly sharedAt: string;
}

const path = (): string => join(tasksDir(), "shares.json");

export async function listTaskShares(): Promise<TaskShare[]> {
  try {
    const value = JSON.parse(await readFile(path(), "utf8")) as { shares?: TaskShare[] };
    return Array.isArray(value.shares) ? value.shares : [];
  } catch { return []; }
}

export async function writeTaskShares(shares: readonly TaskShare[]): Promise<void> {
  await mkdir(tasksDir(), { recursive: true, mode: 0o700 });
  const temp = `${path()}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: 1, shares }, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600).catch(() => undefined);
  await rename(temp, path());
}

export async function getTaskShare(name: string): Promise<TaskShare | undefined> {
  return (await listTaskShares()).find((share) => share.name === name);
}
