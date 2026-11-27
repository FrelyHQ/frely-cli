import { createHash } from "node:crypto";
import { nextCronTime, parseCron } from "./cron.js";
import { buildSchedule, getDefinition, listDefinitions, updateDefinitions, type TaskDefinition } from "./definition.js";
import { defaultManagerDeps, startTask, type ManagerDeps } from "./manager.js";
import { keepAliveFacts, readKeepAliveState, restartKeepAlive, startKeepAlive, stopKeepAlive } from "./keep-alive.js";
import { effectiveTaskStatus, listTaskRuns } from "./run-store.js";

/**
 * What this computer tells the web Tasks page about its local tasks (`frely task local`). The field list below is the whole report:
 * never the command, script, environment values, sites, folder, logs or output. `tests` pin it.
 */
export const LOCAL_TASK_REPORT_FIELDS = ["name", "description", "runner", "mode", "cron", "timezone", "enabled", "nextRunAt", "editedAt", "hash", "runs", "running", "restarts", "lastExit", "healthy"] as const;
export const LOCAL_TASK_RUN_FIELDS = ["startedAt", "endedAt", "status", "exitCode"] as const;
const MAX_REPORTED = 50;
const RECENT_RUNS = 5;

export interface LocalTaskReport {
  name: string;
  description?: string;
  runner: string;
  mode: "cron" | "manual" | "keep_alive";
  cron?: string;
  timezone?: string;
  enabled: boolean;
  nextRunAt?: string;
  editedAt: string;
  /** First 8 hex digits of the definition hash: tells the owner a definition changed, reveals nothing about it. */
  hash: string;
  /** Resident services only: running now, starts in the last 24 hours after the first, exit code of the last run, last health-URL result. */
  running?: boolean;
  restarts?: number;
  lastExit?: number | null;
  healthy?: boolean;
  runs: { startedAt?: string; endedAt?: string; status: string; exitCode?: number | null }[];
}

export async function localTasksReport(now = Date.now()): Promise<LocalTaskReport[]> {
  const [definitions, runs, health] = await Promise.all([listDefinitions(), listTaskRuns(), readKeepAliveState()]);
  return definitions.slice(0, MAX_REPORTED).map((definition) => {
    const schedule = definition.schedule;
    let nextRunAt: string | undefined;
    if (schedule?.enabled) {
      try { const next = nextCronTime(parseCron(schedule.cron), schedule.timezone, now); if (next !== undefined) nextRunAt = new Date(next).toISOString(); } catch { /* unreadable schedule: no next run */ }
    }
    const recent = runs.filter((run) => run.snapshot.name === definition.name).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, RECENT_RUNS)
      .map((run) => ({ ...(run.startedAt ? { startedAt: run.startedAt } : {}), ...(run.endedAt ? { endedAt: run.endedAt } : {}), status: effectiveTaskStatus(run, now), ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}) }));
    const service = definition.keepAlive
      ? keepAliveFacts(runs.filter((run) => run.snapshot.name === definition.name), definition.keepAlive.healthUrl === undefined ? undefined : health.healthy[definition.name], now)
      : undefined;
    return {
      name: definition.name, ...(definition.description ? { description: definition.description } : {}), runner: definition.runner,
      mode: definition.keepAlive ? "keep_alive" as const : schedule ? "cron" as const : "manual" as const, ...(schedule ? { cron: schedule.cron, timezone: schedule.timezone } : {}),
      enabled: definition.keepAlive ? definition.keepAlive.stopped !== true : schedule?.enabled === true, ...(service ?? {}),
      ...(nextRunAt ? { nextRunAt } : {}), editedAt: definition.updatedAt, hash: createHash("sha256").update(definition.hash).digest("hex").slice(0, 8), runs: recent,
    };
  });
}

/** Relay-made hidden tool: the owner's web actions on a local task. Only the schedule changes; the definition (command, sites, folder) never does, so no new approval is needed. */
export const LOCAL_TASK_CONTROL_TOOL = "task_local_control";

export async function controlLocalTask(args: Record<string, unknown>, deps: ManagerDeps = defaultManagerDeps): Promise<Record<string, unknown>> {
  const action = args.action;
  const name = typeof args.name === "string" ? args.name : "";
  const definition: TaskDefinition | undefined = name ? await getDefinition(name) : undefined;
  if (!definition) throw new Error("No task with that name on this computer.");
  if (action === "stop" || action === "start" || action === "restart" || (action === "run" && definition.keepAlive)) {
    if (!definition.keepAlive) throw new Error(`${name} is not a keep-alive service.`);
    if (action === "stop") { await stopKeepAlive(name); return { status: "stopped" }; }
    const run = await (action === "start" || action === "run" ? startKeepAlive(name, deps) : restartKeepAlive(name, deps));
    return { status: run ? "started" : "already_running", ...(run ? { runId: run.runId } : {}) };
  }
  if (definition.keepAlive && (action === "pause" || action === "resume" || action === "schedule")) throw new Error(`${name} is a keep-alive service: use stop, start or restart.`);
  if (action === "run") {
    const run = await startTask(name, { trigger: "remote" }, deps);
    return { status: "started", runId: run.runId };
  }
  if (action !== "pause" && action !== "resume" && action !== "schedule") throw new Error("action must be one of run, pause, resume, schedule, stop, start, restart.");
  const now = new Date();
  let next: TaskDefinition;
  if (action === "schedule") {
    if (typeof args.cron !== "string") throw new Error("cron is required.");
    next = { ...definition, schedule: buildSchedule(args.cron, typeof args.timezone === "string" && args.timezone ? args.timezone : undefined, now) };
  } else {
    if (!definition.schedule) throw new Error(`${name} has no schedule.`);
    next = { ...definition, schedule: { ...definition.schedule, enabled: action === "resume", ...(action === "resume" ? { since: now.toISOString() } : {}) } };
  }
  await updateDefinitions((current) => current.map((item) => (item.name === name ? { ...next, updatedAt: now.toISOString() } : item)));
  return { status: "updated" };
}
