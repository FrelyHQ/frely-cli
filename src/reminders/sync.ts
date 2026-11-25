import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tasksDir, writeTaskJson } from "../task/definition.js";
import { nextFireOf, planSync, REMINDER_LIST, type ReminderFacts, type SyncAction, type TodoFacts } from "./plan.js";

type Call = (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
export type Reminders = (args: readonly string[]) => Promise<string>;

const CLI_TIMEOUT_MS = 30_000;
const LIVE = ["open", "in_progress"] as const;
const TICK_MS = 5 * 60_000;
const configPath = (): string => join(tasksDir(), "reminders.json");

/** `reminders` (keith/reminders-cli, `brew install keith/formulae/reminders-cli`). A hung call means macOS is waiting for Reminders access. */
export const remindersCli: Reminders = (args) => new Promise((resolve, reject) => {
  execFile("reminders", [...args], { timeout: CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` } }, (error, stdout, stderr) => {
    if (!error) { resolve(stdout); return; }
    const timedOut = (error as { killed?: boolean }).killed === true;
    reject(new Error(timedOut ? "The reminders tool did not answer. macOS is probably asking for Reminders access: allow it on this computer's screen, then run `frely reminders setup` again." : (stderr || error.message).trim().slice(0, 300)));
  });
});

export async function readEnabled(): Promise<boolean> {
  try { return (JSON.parse(await readFile(configPath(), "utf8")) as { enabled?: boolean }).enabled === true; } catch { return false; }
}
export const writeEnabled = (enabled: boolean): Promise<void> => writeTaskJson(configPath(), { enabled });

/** Creates the "Frely" list when it is missing. Fails with a readable message when the tool is missing or access is not given. */
export async function setupReminders(run: Reminders = remindersCli): Promise<{ created: boolean }> {
  if (process.platform !== "darwin") throw new Error("Apple Reminders works on macOS only.");
  const lists = JSON.parse(await run(["show-lists", "--format", "json"]).catch((error: Error) => { if (/ENOENT/u.test(error.message)) throw new Error("The reminders tool is not installed. Run: brew install keith/formulae/reminders-cli"); throw error; })) as string[];
  if (lists.includes(REMINDER_LIST)) return { created: false };
  await run(["new-list", REMINDER_LIST]);
  return { created: true };
}

async function readReminders(run: Reminders): Promise<ReminderFacts[]> {
  const rows = JSON.parse(await run(["show", REMINDER_LIST, "--include-completed", "--format", "json"]) || "[]") as Array<Record<string, unknown>>;
  return rows.map((row) => ({ externalId: String(row.externalId ?? ""), title: String(row.title ?? ""), isCompleted: row.isCompleted === true,
    dueDate: typeof row.dueDate === "string" ? row.dueDate : null, notes: typeof row.notes === "string" ? row.notes : null })).filter((row) => row.externalId !== "");
}

async function readTodos(call: Call): Promise<TodoFacts[]> {
  const out: TodoFacts[] = [];
  for (const status of LIVE) {
    const list = await call("todo.list", { status: [status], pageSize: 100 }) as { items?: Array<{ id: string; title: string; status: string; steps?: { total?: number } }> };
    for (const item of list.items ?? []) {
      const shown = await call("todo.show", { todoId: item.id }) as { conditions?: Array<{ type?: string; fired?: boolean; nextCheckAt?: string | null }> };
      out.push({ id: item.id, title: item.title, status: item.status, steps: item.steps?.total ?? 0, nextFireAt: nextFireOf(shown.conditions ?? []) });
    }
  }
  return out;
}

/** The todos a tick may complete are read again with their state, so a todo done elsewhere is not touched twice. */
async function apply(action: SyncAction, run: Reminders, call: Call): Promise<void> {
  const add = (a: { title: string; due: string | null; notes: string }) => run(["add", REMINDER_LIST, a.title, ...(a.due ? ["--due-date", a.due] : []), "--notes", a.notes, "--format", "json"]);
  switch (action.type) {
    case "add": await add(action); return;
    case "replace": await run(["delete", REMINDER_LIST, action.reminderId]); await add(action); return;
    case "retitle": await run(["edit", REMINDER_LIST, action.reminderId, action.title]); return;
    case "complete": await run(["complete", REMINDER_LIST, action.reminderId]); return;
    case "uncomplete": await run(["uncomplete", REMINDER_LIST, action.reminderId]); return;
    case "delete": await run(["delete", REMINDER_LIST, action.reminderId]); return;
    case "finish_todo": await call("todo.update", { todoId: action.todoId, status: "done" }); return;
    case "confirmed": return;
  }
}

export interface SyncResult { readonly actions: number; readonly applied: Record<string, number>; readonly failed: string[] }

/** One pass. Errors on single actions are collected; the next pass plans from the real state again. */
export async function syncReminders(call: Call, run: Reminders = remindersCli): Promise<SyncResult> {
  if (process.platform !== "darwin") throw new Error("Apple Reminders works on macOS only.");
  const [todos, reminders] = await Promise.all([readTodos(call), readReminders(run)]);
  const actions = planSync(todos, reminders);
  const applied: Record<string, number> = {};
  const failed: string[] = [];
  for (const action of actions) {
    try { await apply(action, run, call); applied[action.type] = (applied[action.type] ?? 0) + 1; }
    catch (error) { failed.push(`${action.type}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { actions: actions.length, applied, failed };
}

/** The background service's clock for the link; does nothing until `frely reminders setup` has turned it on. */
export async function superviseReminders(options: { signal: AbortSignal; log: (text: string) => void; call: Call; tickMs?: number }): Promise<void> {
  while (!options.signal.aborted) {
    if (process.platform === "darwin" && await readEnabled()) {
      await syncReminders(options.call).then((result) => { if (result.actions > 0) options.log(`Reminders: ${JSON.stringify(result.applied)}${result.failed.length ? `, ${result.failed.length} failed: ${result.failed[0]}` : ""}`); },
        (error: unknown) => options.log(`Reminders: ${error instanceof Error ? error.message : String(error)}`));
    }
    await new Promise<void>((resolve) => { const timer = setTimeout(resolve, options.tickMs ?? TICK_MS); options.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
  }
}
