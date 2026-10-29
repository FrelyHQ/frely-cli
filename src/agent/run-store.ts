import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CallerItem } from "../skill/router.js";
import type { FileRead } from "./workspace-read.js";

/** Finished runs are kept this long on this computer, then removed the next time a run starts. */
export const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface RunRound {
  readonly n: number;
  readonly requestId?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly toolCalls: readonly string[];
  readonly usage?: Readonly<{ input_tokens: number; output_tokens: number; total_tokens: number }>;
}

/** Local record of one `frely agent run`. Full input and output stay on this computer (file mode 0600). */
export interface RunRecord {
  readonly version: 1;
  readonly runId: string;
  readonly distributionId: string;
  readonly modelId?: string;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The detached worker that owns the run while it is `running`. */
  readonly workerPid?: number;
  readonly task: string;
  /** Workspace root of `--read`; absent for a plain single call. */
  readonly readRoot?: string;
  readonly limits?: Readonly<{ totalBytes: number; maxRounds: number }>;
  readonly bridge?: Readonly<{ usedBytes: number; roundsAnswered: number }>;
  readonly items: readonly CallerItem[];
  readonly rounds: readonly RunRound[];
  readonly filesRead: readonly FileRead[];
  readonly usage: Readonly<{ input_tokens: number; output_tokens: number; total_tokens: number }>;
  readonly resumeCount: number;
  readonly text?: string;
  /** The Agent could not take local tools, so the run was done as one plain call. */
  readonly toolsUnsupported?: boolean;
  readonly error?: Readonly<{ code: string; message: string }>;
}

export function runsDirectory(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "agent-runs");
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

function runPath(runId: string): string {
  if (!isRunId(runId)) throw new Error("Invalid run id.");
  return join(runsDirectory(), `${runId}.json`);
}

export async function createRun(input: { readonly distributionId: string; readonly task: string; readonly readRoot?: string; readonly limits?: { totalBytes: number; maxRounds: number } }): Promise<RunRecord> {
  await mkdir(runsDirectory(), { recursive: true, mode: 0o700 });
  await chmod(runsDirectory(), 0o700).catch(() => undefined);
  await pruneRuns().catch(() => undefined);
  const now = new Date().toISOString();
  const record: RunRecord = {
    version: 1,
    runId: randomUUID(),
    distributionId: input.distributionId,
    status: "running",
    createdAt: now,
    updatedAt: now,
    task: input.task,
    ...(input.readRoot === undefined ? {} : { readRoot: input.readRoot }),
    ...(input.limits === undefined ? {} : { limits: input.limits }),
    items: [],
    rounds: [],
    filesRead: [],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    resumeCount: 0,
  };
  await writeRun(record);
  return record;
}

/** Atomic write: a reader never sees half a record. */
export async function writeRun(record: RunRecord): Promise<RunRecord> {
  const next = { ...record, updatedAt: new Date().toISOString() };
  const path = runPath(record.runId);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  // On Windows a rename onto a file another process is reading fails briefly (EPERM/EBUSY/EACCES): retry.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, path);
      return next;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 50 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) { await rm(temp, { force: true }); throw error; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

export async function readRun(runId: string): Promise<RunRecord | null> {
  let raw: string | undefined;
  for (let attempt = 0; attempt < 5 && raw === undefined; attempt += 1) {
    try {
      raw = await readFile(runPath(runId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (raw === undefined) return null;
  try {
    const value = JSON.parse(raw) as RunRecord;
    return value.version === 1 && value.runId === runId ? value : null;
  } catch {
    return null;
  }
}

export async function listRuns(): Promise<RunRecord[]> {
  let names: string[];
  try {
    names = await readdir(runsDirectory());
  } catch {
    return [];
  }
  const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readRun(name.slice(0, -5))));
  return records.filter((record): record is RunRecord => record !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function pruneRuns(now = Date.now()): Promise<void> {
  for (const record of await listRuns()) {
    if (record.status !== "running" && now - Date.parse(record.updatedAt) > RUN_RETENTION_MS) await rm(runPath(record.runId), { force: true });
  }
}

export function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `running` only counts while its worker is alive; otherwise the run was cut off (killed, rebooted) and is `interrupted`. */
export function effectiveStatus(record: RunRecord, now = Date.now()): RunStatus {
  if (record.status !== "running") return record.status;
  // The worker records its pid as its first act; until then the run is only just starting.
  if (record.workerPid === undefined) return now - Date.parse(record.updatedAt) < WORKER_START_GRACE_MS ? "running" : "interrupted";
  return processAlive(record.workerPid) ? "running" : "interrupted";
}

const WORKER_START_GRACE_MS = 20_000;

/** A run can continue when a failed or interrupted run still has its Agent and (for `--read`) rounds to resume from. */
export function resumable(record: RunRecord): boolean {
  const status = effectiveStatus(record);
  return (status === "interrupted" || status === "failed") && (record.error?.code ?? "") !== "input_invalid";
}

/** `<id>` or `--last`. */
export async function resolveRun(target: string | undefined): Promise<RunRecord> {
  if (target === undefined || target === "--last") {
    const [latest] = await listRuns();
    if (latest === undefined) throw new Error("There are no agent runs on this computer.");
    return latest;
  }
  if (!isRunId(target)) throw new Error("Use a run id from `frely agent runs`, or --last.");
  const record = await readRun(target);
  if (record === null) throw new Error("This run is not on this computer (runs are removed after 7 days).");
  return record;
}

export function addUsage(total: RunRecord["usage"], usage: RunRecord["usage"] | undefined): RunRecord["usage"] {
  if (usage === undefined) return total;
  return {
    input_tokens: total.input_tokens + usage.input_tokens,
    output_tokens: total.output_tokens + usage.output_tokens,
    total_tokens: total.total_tokens + usage.total_tokens,
  };
}
