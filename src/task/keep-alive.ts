import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDefinition, listDefinitions, tasksDir, updateDefinitions, writeTaskJson, type TaskDefinition } from "./definition.js";
import { cancelTaskRun, defaultManagerDeps, startTask, TaskError, type ManagerDeps } from "./manager.js";
import { isActive, listTaskRuns, type TaskRunRecord } from "./run-store.js";

/** Restart delay: 1 s, doubling per quick exit, at most 5 minutes. A run that lived this long counts as stable and resets it. */
export const RESTART_MIN_MS = 1000;
export const RESTART_MAX_MS = 5 * 60_000;
export const STABLE_MS = 10 * 60_000;
/** A health check that fails this many times in a row restarts the service. */
export const HEALTH_FAILURES = 3;
/** A new run is given this long to open its port before health checks count. */
export const HEALTH_GRACE_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5000;

const statePath = (): string => join(tasksDir(), "keep-alive-state.json");

interface KeepAliveState { version: 1; fails: Record<string, number>; healthy: Record<string, boolean> }

export async function readKeepAliveState(): Promise<KeepAliveState> {
  const raw = await readFile(statePath(), "utf8").catch(() => null);
  if (raw === null) return { version: 1, fails: {}, healthy: {} };
  try { const value = JSON.parse(raw) as KeepAliveState; return value.version === 1 && value.fails && value.healthy ? value : { version: 1, fails: {}, healthy: {} }; } catch { return { version: 1, fails: {}, healthy: {} }; }
}

const endOf = (run: TaskRunRecord): number => Date.parse(run.endedAt ?? run.updatedAt);

/** How long to wait before starting again, from the run history alone: the quick exits in a row at the end of it. */
export function restartDelayMs(runsNewestFirst: readonly TaskRunRecord[]): number {
  let quick = 0;
  for (const run of runsNewestFirst) {
    if (isActive(run)) continue;
    const lived = endOf(run) - Date.parse(run.startedAt ?? run.createdAt);
    if (lived >= STABLE_MS) break;
    quick += 1;
  }
  return Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** Math.min(Math.max(quick - 1, 0), 10));
}

export async function checkHealth(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try { const response = await fetchImpl(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), redirect: "manual" }); return response.status >= 200 && response.status < 400; } catch { return false; }
}

/**
 * The resident-service half of the background service's clock: starts a service that is not running (after its restart delay), and
 * restarts one whose health URL failed three times in a row. A service the owner stopped is left alone.
 */
export async function tickKeepAlive(now = Date.now(), deps: ManagerDeps = defaultManagerDeps, log: (text: string) => void = () => undefined, fetchImpl: typeof fetch = fetch): Promise<{ started: string[]; restartedUnhealthy: string[] }> {
  const result = { started: [] as string[], restartedUnhealthy: [] as string[] };
  const definitions = (await listDefinitions().catch(() => [] as TaskDefinition[])).filter((item) => item.keepAlive && item.keepAlive.stopped !== true);
  if (definitions.length === 0) return result;
  const runs = await listTaskRuns();
  const state = await readKeepAliveState();
  let changed = false;
  for (const definition of definitions) {
    const mine = runs.filter((run) => run.snapshot.name === definition.name);
    const active = mine.find(isActive);
    const healthUrl = definition.keepAlive!.healthUrl;
    if (active) {
      if (healthUrl === undefined || now - Date.parse(active.startedAt ?? active.createdAt) < HEALTH_GRACE_MS) continue;
      const ok = await checkHealth(healthUrl, fetchImpl);
      const fails = ok ? 0 : (state.fails[definition.name] ?? 0) + 1;
      if (state.healthy[definition.name] !== ok || state.fails[definition.name] !== fails) changed = true;
      state.healthy[definition.name] = ok;
      state.fails[definition.name] = fails;
      if (fails >= HEALTH_FAILURES) {
        state.fails[definition.name] = 0;
        log(`Service ${definition.name}: ${healthUrl} failed ${HEALTH_FAILURES} times in a row; restarting it.`);
        await cancelTaskRun(active.runId).catch(() => undefined);
        result.restartedUnhealthy.push(definition.name);
      }
      continue;
    }
    const last = mine[0];
    if (last && now - endOf(last) < restartDelayMs(mine)) continue;
    try {
      await startTask(definition.name, { trigger: "schedule" }, deps);
      result.started.push(definition.name);
      if (state.fails[definition.name] !== 0 || state.healthy[definition.name] !== undefined) { state.fails[definition.name] = 0; delete state.healthy[definition.name]; changed = true; }
      log(`Service ${definition.name} started.`);
    } catch (error) {
      log(`Service ${definition.name} could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (changed) await writeTaskJson(statePath(), state);
  return result;
}

async function requireService(name: string): Promise<TaskDefinition> {
  const definition = await getDefinition(name);
  if (!definition) throw new TaskError("unknown_task", `No task named ${name}. See frely task local list.`);
  if (!definition.keepAlive) throw new TaskError("invalid", `${name} is not a keep-alive service.`);
  return definition;
}

const setStopped = (name: string, stopped: boolean): Promise<TaskDefinition[]> =>
  updateDefinitions((current) => current.map((item) => (item.name === name && item.keepAlive ? { ...item, keepAlive: { ...item.keepAlive, stopped }, updatedAt: new Date().toISOString() } : item)));

async function stopRuns(name: string): Promise<void> {
  for (const run of (await listTaskRuns()).filter((item) => item.snapshot.name === name && isActive(item))) await cancelTaskRun(run.runId);
}

/** Stops a service and keeps it stopped (also after the background service or the computer restarts) until `start`. */
export async function stopKeepAlive(name: string): Promise<void> {
  await requireService(name);
  await setStopped(name, true);
  await stopRuns(name);
}

/** Lets a stopped service run again and starts it now (unless it is already running). Returns the run, or undefined when one was already going. */
export async function startKeepAlive(name: string, deps: ManagerDeps = defaultManagerDeps): Promise<TaskRunRecord | undefined> {
  await requireService(name);
  await setStopped(name, false);
  if ((await listTaskRuns()).some((run) => run.snapshot.name === name && isActive(run))) return undefined;
  return startTask(name, { trigger: "manual" }, deps);
}

export async function restartKeepAlive(name: string, deps: ManagerDeps = defaultManagerDeps): Promise<TaskRunRecord | undefined> {
  await requireService(name);
  await stopRuns(name);
  return startKeepAlive(name, deps);
}

/** Numbers for the report: restarts in the last 24 hours (runs started minus the first), the last exit code, the last health result. */
export function keepAliveFacts(runsNewestFirst: readonly TaskRunRecord[], healthy: boolean | undefined, now = Date.now()): { running: boolean; restarts: number; lastExit?: number | null; healthy?: boolean } {
  const day = runsNewestFirst.filter((run) => now - Date.parse(run.createdAt) < 24 * 3_600_000 && run.status !== "skipped");
  const ended = runsNewestFirst.find((run) => !isActive(run) && run.status !== "skipped");
  return {
    running: runsNewestFirst.some(isActive), restarts: Math.max(0, day.length - 1),
    ...(ended && ended.exitCode !== undefined ? { lastExit: ended.exitCode } : {}), ...(healthy === undefined ? {} : { healthy }),
  };
}
