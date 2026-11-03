import { spawn } from "node:child_process";
import { cliLaunchArguments } from "../cli-launch.js";
import { isSandboxDisabled, sandboxUnavailableReason } from "../runtime/sandbox.js";
import { approvedSites, getDefinition, type TaskDefinition } from "./definition.js";
import {
  createTaskRun, effectiveTaskStatus, isActive, listTaskRuns, logTail, processAlive, readTaskRun, resolveTaskRun, snapshotOf, writeTaskRun,
  type TaskRunRecord, type TaskTrigger,
} from "./run-store.js";

export class TaskError extends Error {
  constructor(readonly code: "unknown_task" | "busy" | "sandbox_unavailable" | "not_found" | "invalid", message: string) { super(message); this.name = "TaskError"; }
}

/** Whole-computer cap on runs at the same time. */
export const MAX_CONCURRENT_RUNS = 8;
/** `result --wait` and `status --wait` never hold a call longer than this: below the 120 s a remote forward allows. */
export const MAX_WAIT_MS = 100_000;

export function maxConcurrent(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.FRELY_TASK_MAX_CONCURRENT);
  return Number.isInteger(value) && value >= 1 && value <= 64 ? value : MAX_CONCURRENT_RUNS;
}

export interface ManagerDeps {
  /** Start the detached worker of a run. Detached so a closed terminal, a dropped connection or a stopped parent does not end the run. */
  spawnWorker(runId: string): void;
  /** Model-endpoint gates (step 2) add their own refusal reason here. */
  gate?: (definition: TaskDefinition) => Promise<string | undefined>;
}

export const defaultManagerDeps: ManagerDeps = {
  spawnWorker: (runId) => {
    const launch = cliLaunchArguments(process.argv[1] ?? "", ["task", "__worker", runId]);
    spawn(launch[0]!, launch.slice(1), { detached: true, stdio: "ignore", windowsHide: true, env: process.env }).unref();
  },
};

/**
 * Starts one run of a defined task and returns its record at once. The run belongs to its own detached worker process, so it keeps going
 * when whoever started it (a terminal, a remote session, the background service's connection) goes away or reconnects.
 */
export async function startTask(name: string, options: { trigger?: TaskTrigger; scheduledFor?: string } = {}, deps: ManagerDeps = defaultManagerDeps): Promise<TaskRunRecord> {
  const trigger = options.trigger ?? "manual";
  const definition = await getDefinition(name);
  if (!definition) throw new TaskError("unknown_task", `No task named ${name}. See frely task list.`);
  if (!isSandboxDisabled()) {
    const reason = sandboxUnavailableReason();
    if (reason) throw new TaskError("sandbox_unavailable", `Tasks run on this computer only inside the Frely sandbox, and it cannot run here (${reason}). On Linux install bubblewrap, socat and ripgrep; Windows is not supported.`);
  }
  const active = (await listTaskRuns()).filter(isActive);
  if (trigger === "schedule" && active.some((run) => run.snapshot.name === name)) throw new TaskError("busy", `${name} is still running from an earlier start.`);
  if (active.length >= maxConcurrent()) throw new TaskError("busy", `${active.length} tasks are running (the limit is ${maxConcurrent()}). Try again when one has finished.`);
  const refusal = await deps.gate?.(definition);
  if (refusal) throw new TaskError("busy", refusal);
  const record = await createTaskRun({ snapshot: snapshotOf(definition, approvedSites(definition)), trigger, ...(options.scheduledFor === undefined ? {} : { scheduledFor: options.scheduledFor }) });
  deps.spawnWorker(record.runId);
  return record;
}

/** Waits for the end of a run, at most `waitMs` (capped at MAX_WAIT_MS). Returns the record as it is then. */
export async function waitForTaskRun(runId: string, waitMs: number, pollMs = 300): Promise<TaskRunRecord> {
  const deadline = Date.now() + Math.min(Math.max(waitMs, 0), MAX_WAIT_MS);
  for (;;) {
    const record = await readTaskRun(runId);
    if (record === null) throw new TaskError("not_found", "The run record is no longer on this computer.");
    const status = effectiveTaskStatus(record);
    if (status !== "running" && status !== "queued") return { ...record, status };
    if (Date.now() >= deadline) return record;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}

/** Stops a run: its worker ends the program's whole process tree, or an orphaned record is marked. */
export async function cancelTaskRun(target: string | undefined, pollMs = 200): Promise<TaskRunRecord> {
  const record = await resolveTaskRun(target);
  if (!isActive(record)) return { ...record, status: effectiveTaskStatus(record) };
  if (processAlive(record.workerPid)) {
    try { process.kill(record.workerPid!, "SIGTERM"); } catch { /* it just ended */ }
    for (let waited = 0; waited < 8000; waited += pollMs) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const current = await readTaskRun(record.runId);
      if (current !== null && current.status !== "running" && current.status !== "queued") return current;
    }
  }
  const latest = (await readTaskRun(record.runId)) ?? record;
  if (latest.status !== "running" && latest.status !== "queued") return latest;
  return writeTaskRun({ ...latest, status: "cancelled", endedAt: new Date().toISOString() });
}

/** What `frely task status|result|runs` print for a run. The log tail and answer are included for a finished run only when asked. */
export async function describeRun(record: TaskRunRecord, options: { tail?: boolean } = {}): Promise<Record<string, unknown>> {
  const status = effectiveTaskStatus(record);
  const finished = status !== "running" && status !== "queued";
  return {
    ok: status === "running" || status === "queued" || status === "completed" || status === "skipped",
    runId: record.runId, task: record.snapshot.name, runner: record.snapshot.runner, status, trigger: record.trigger,
    createdAt: record.createdAt, ...(record.startedAt ? { startedAt: record.startedAt } : {}), ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    ...(record.scheduledFor ? { scheduledFor: record.scheduledFor } : {}),
    ...(finished && record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.modelUsed ? { model: record.modelUsed } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.blocked ? { blocked: record.blocked } : {}),
    ...(finished && record.answer !== undefined ? { answer: record.answer } : {}),
    ...(record.worktreePath ? { worktree: record.worktreePath, branch: record.branch } : {}),
    ...(record.diffSummary ? { diff: record.diffSummary } : {}),
    ...(finished && options.tail ? { logTail: await logTail(record.runId) } : {}),
    ...(!finished ? { note: "Still running. `frely task result <runId> --wait` waits up to 100 seconds for the end." } : {}),
  };
}
