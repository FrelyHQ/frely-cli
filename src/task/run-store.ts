import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunnerId, TaskDefinition } from "./definition.js";
import { tasksDir } from "./definition.js";

/** Finished task runs and their logs stay on this computer this long. */
export const TASK_RUN_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const LOG_LIMIT_BYTES = 8 * 1024 * 1024;
export const RESULT_TAIL_BYTES = 8 * 1024;

export type TaskRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timeout" | "interrupted" | "skipped";
export type TaskTrigger = "manual" | "schedule" | "remote";

/** Everything a run needs, copied from the definition when it starts: changing the definition later does not change a run in flight. */
export interface TaskRunSnapshot {
  readonly name: string;
  readonly runner: RunnerId;
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutSec: number;
  readonly hash: string;
  /** Sites approved when the run started. */
  readonly sites: readonly string[];
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
  readonly worktree?: boolean;
  /** A remote caller's request text (a shared task): the script gets it as FRELY_TASK_INPUT, the pi agent as the request after its fixed instructions. */
  readonly input?: string;
  /** Shared pi tasks: `none` (a one-time empty folder), `read` (answer only, the project is not changed) or `worktree` (a worktree per call). */
  readonly workspace?: TaskWorkspace;
}
export type TaskWorkspace = "none" | "read" | "worktree";

export interface TaskRunRecord {
  readonly version: 1;
  readonly runId: string;
  readonly snapshot: TaskRunSnapshot;
  readonly trigger: TaskTrigger;
  readonly status: TaskRunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  /** The detached worker that owns the run while it is `running`. */
  readonly workerPid?: number;
  readonly exitCode?: number | null;
  /** The slot a schedule fired for (ISO). */
  readonly scheduledFor?: string;
  /** Model actually used (after any start-failure fallback). */
  readonly modelUsed?: string;
  /** Model calls this run made, counted on this computer only (nothing is reported anywhere). */
  readonly modelStats?: Readonly<{ requests: number; failures: number; byRoute: Readonly<Record<string, number>> }>;
  /** Pi: the last answer. */
  readonly answer?: string;
  /** Worktree runs: where the work is and what it changed. */
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly diffSummary?: string;
  /** The owner dealt with the worktree changes of a remote call (`frely task handled`); until then they count toward the unhandled limit. */
  readonly handledAt?: string;
  readonly error?: Readonly<{ code: string; message: string }>;
  /** The sandbox blocked these (a site the task needs but was not approved for). */
  readonly blocked?: readonly string[];
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const isTaskRunId = (value: string): boolean => RUN_ID.test(value);

export const runsDir = (): string => join(tasksDir(), "runs");
const recordPath = (runId: string): string => { if (!isTaskRunId(runId)) throw new Error("Invalid run id."); return join(runsDir(), `${runId}.json`); };
export const taskLogPath = (runId: string): string => { if (!isTaskRunId(runId)) throw new Error("Invalid run id."); return join(runsDir(), `${runId}.log`); };

export function snapshotOf(definition: TaskDefinition, sites: readonly string[], extra: { input?: string; workspace?: TaskWorkspace } = {}): TaskRunSnapshot {
  return {
    ...(extra.input === undefined ? {} : { input: extra.input }), ...(extra.workspace === undefined ? {} : { workspace: extra.workspace }),
    name: definition.name, runner: definition.runner, command: definition.command, cwd: definition.cwd, env: definition.env,
    timeoutSec: definition.timeoutSec, hash: definition.hash, sites: [...sites],
    ...(definition.model === undefined ? {} : { model: definition.model }),
    ...(definition.fallbackModels === undefined ? {} : { fallbackModels: definition.fallbackModels }),
    ...(definition.worktree === true ? { worktree: true } : {}),
  };
}

export async function createTaskRun(input: { snapshot: TaskRunSnapshot; trigger: TaskTrigger; status?: TaskRunStatus; scheduledFor?: string; error?: TaskRunRecord["error"] }): Promise<TaskRunRecord> {
  await mkdir(runsDir(), { recursive: true, mode: 0o700 });
  await chmod(runsDir(), 0o700).catch(() => undefined);
  await pruneTaskRuns().catch(() => undefined);
  const now = new Date().toISOString();
  const status = input.status ?? "running";
  const record: TaskRunRecord = {
    version: 1, runId: randomUUID(), snapshot: input.snapshot, trigger: input.trigger, status, createdAt: now, updatedAt: now,
    ...(status === "skipped" ? { endedAt: now } : {}),
    ...(input.scheduledFor === undefined ? {} : { scheduledFor: input.scheduledFor }),
    ...(input.error === undefined ? {} : { error: input.error }),
  };
  await writeTaskRun(record);
  return record;
}

export async function writeTaskRun(record: TaskRunRecord): Promise<TaskRunRecord> {
  const next = { ...record, updatedAt: new Date().toISOString() };
  const path = recordPath(record.runId);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(temp, path); return next; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 50 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) { await rm(temp, { force: true }); throw error; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

export async function readTaskRun(runId: string): Promise<TaskRunRecord | null> {
  let raw: string | undefined;
  for (let attempt = 0; attempt < 5 && raw === undefined; attempt += 1) {
    try { raw = await readFile(recordPath(runId), "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (raw === undefined) return null;
  try { const value = JSON.parse(raw) as TaskRunRecord; return value.version === 1 && value.runId === runId ? value : null; } catch { return null; }
}

export async function listTaskRuns(): Promise<TaskRunRecord[]> {
  const names = await readdir(runsDir()).catch(() => [] as string[]);
  const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readTaskRun(name.slice(0, -5)).catch(() => null)));
  return records.filter((record): record is TaskRunRecord => record !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function pruneTaskRuns(now = Date.now()): Promise<void> {
  for (const record of await listTaskRuns()) {
    if (record.status === "running" || record.status === "queued" || now - Date.parse(record.updatedAt) <= TASK_RUN_RETENTION_MS) continue;
    await rm(recordPath(record.runId), { force: true });
    await rm(taskLogPath(record.runId), { force: true });
  }
}

export function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

const WORKER_START_GRACE_MS = 20_000;

/** `running` only counts while its worker is alive; otherwise the run was cut off (killed, rebooted) and is `interrupted`. */
export function effectiveTaskStatus(record: TaskRunRecord, now = Date.now()): TaskRunStatus {
  if (record.status !== "running" && record.status !== "queued") return record.status;
  if (record.workerPid === undefined) return now - Date.parse(record.updatedAt) < WORKER_START_GRACE_MS ? record.status : "interrupted";
  return processAlive(record.workerPid) ? record.status : "interrupted";
}

export const isActive = (record: TaskRunRecord): boolean => { const status = effectiveTaskStatus(record); return status === "running" || status === "queued"; };

/** `<id>` or `--last` (optionally the newest run of one task). */
export async function resolveTaskRun(target: string | undefined, name?: string): Promise<TaskRunRecord> {
  if (target === undefined || target === "--last") {
    const latest = (await listTaskRuns()).find((record) => name === undefined || record.snapshot.name === name);
    if (latest === undefined) throw new Error("There are no task runs on this computer.");
    return latest;
  }
  if (!isTaskRunId(target)) throw new Error("Use a run id from `frely task runs`, or --last.");
  const record = await readTaskRun(target);
  if (record === null) throw new Error("This run is not on this computer (runs are removed after 14 days).");
  return record;
}

/** The last bytes of a run's log, as text. */
export async function logTail(runId: string, bytes = RESULT_TAIL_BYTES): Promise<string> {
  const path = taskLogPath(runId);
  const size = (await stat(path).catch(() => undefined))?.size ?? 0;
  if (size === 0) return "";
  const data = await readFile(path);
  const start = Math.max(0, data.length - bytes);
  return (start > 0 ? "…" : "") + data.subarray(start).toString("utf8");
}
