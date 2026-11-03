import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { nextCronTime, parseCron } from "./cron.js";
import { listDefinitions, tasksDir, writeTaskJson, type TaskDefinition } from "./definition.js";
import { defaultManagerDeps, startTask, TaskError, type ManagerDeps } from "./manager.js";
import { createTaskRun, snapshotOf } from "./run-store.js";
import { approvedSites } from "./definition.js";

const TICK_MS = 20_000;
/** A slot missed while the computer was off or asleep still runs once, if it is at most this old; older ones are dropped. */
export const CATCH_UP_MS = 24 * 3_600_000;

const statePath = (): string => join(tasksDir(), "schedule-state.json");

interface ScheduleState { version: 1; lastFired: Record<string, string> }

async function readState(): Promise<ScheduleState> {
  const raw = await readFile(statePath(), "utf8").catch(() => null);
  if (raw === null) return { version: 1, lastFired: {} };
  try { const value = JSON.parse(raw) as ScheduleState; return value.version === 1 && value.lastFired ? value : { version: 1, lastFired: {} }; } catch { return { version: 1, lastFired: {} }; }
}

export interface TickResult { readonly started: string[]; readonly skipped: string[]; readonly dropped: string[] }

/**
 * Starts every scheduled task whose slot has come. The slot is counted from the last time the schedule fired (or was saved), so the
 * slots missed while nothing was running collapse into one run. A task still running from the last slot is skipped, not doubled.
 */
export async function tickSchedules(now = Date.now(), deps: ManagerDeps = defaultManagerDeps, log: (text: string) => void = () => undefined): Promise<TickResult> {
  const result = { started: [] as string[], skipped: [] as string[], dropped: [] as string[] };
  const definitions = (await listDefinitions().catch((error: unknown) => { log(`Tasks: ${error instanceof Error ? error.message : String(error)}`); return [] as TaskDefinition[]; })).filter((item) => item.schedule?.enabled);
  if (definitions.length === 0) return result;
  const state = await readState();
  let changed = false;
  for (const definition of definitions) {
    const schedule = definition.schedule!;
    let slot: number | undefined;
    try { slot = nextCronTime(parseCron(schedule.cron), schedule.timezone, Date.parse(state.lastFired[definition.name] ?? schedule.since)); } catch (error) { log(`Task ${definition.name}: ${error instanceof Error ? error.message : String(error)}`); continue; }
    if (slot === undefined || slot > now) continue;
    state.lastFired[definition.name] = new Date(now).toISOString();
    changed = true;
    if (now - slot > CATCH_UP_MS) { result.dropped.push(definition.name); log(`Task ${definition.name}: the slot ${new Date(slot).toISOString()} was missed by more than a day; it is not run.`); continue; }
    try {
      await startTask(definition.name, { trigger: "schedule", scheduledFor: new Date(slot).toISOString() }, deps);
      result.started.push(definition.name);
      log(`Task ${definition.name} started (slot ${new Date(slot).toISOString()}).`);
    } catch (error) {
      if (error instanceof TaskError && (error.code === "busy" || error.code === "sandbox_unavailable")) {
        await createTaskRun({ snapshot: snapshotOf(definition, approvedSites(definition)), trigger: "schedule", status: "skipped", scheduledFor: new Date(slot).toISOString(), error: { code: error.code, message: error.message } }).catch(() => undefined);
        result.skipped.push(definition.name);
        log(`Task ${definition.name} skipped: ${error.message}`);
      } else log(`Task ${definition.name} could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (changed) await writeTaskJson(statePath(), state);
  return result;
}

/** The background service's clock for tasks. Runs are detached workers, so stopping the service (or losing its connection) does not end a run in flight. */
export async function superviseTasks(options: { signal: AbortSignal; log: (text: string) => void; tickMs?: number }): Promise<void> {
  while (!options.signal.aborted) {
    await tickSchedules(Date.now(), defaultManagerDeps, options.log).catch((error: unknown) => options.log(`Tasks: ${error instanceof Error ? error.message : String(error)}`));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.tickMs ?? TICK_MS);
      options.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
