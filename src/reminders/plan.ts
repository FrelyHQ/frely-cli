// The rules of the Apple Reminders link, as pure functions: which todos appear in the "Frely" list and what one sync pass does.
// No I/O here. The link is one-way for content (todo -> reminder). The only thing that flows back is a tick: a reminder ticked off
// completes a todo that has no steps; for a todo with steps the tick is only a confirmation, so a stray tap on a phone cannot
// start or finish work on a computer.

export const REMINDER_LIST = "Frely";
const MARKER = /frely:todo:([A-Za-z0-9_-]{1,64})/u;

export interface TodoFacts {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly steps: number;
  /** The next time a date or schedule condition fires; null when the todo has none. */
  readonly nextFireAt: string | null;
}

export interface ReminderFacts {
  readonly externalId: string;
  readonly title: string;
  readonly isCompleted: boolean;
  readonly dueDate: string | null;
  readonly notes: string | null;
}

export type SyncAction =
  | { readonly type: "add"; readonly todoId: string; readonly title: string; readonly due: string | null; readonly notes: string }
  | { readonly type: "retitle"; readonly reminderId: string; readonly title: string }
  | { readonly type: "replace"; readonly reminderId: string; readonly todoId: string; readonly title: string; readonly due: string | null; readonly notes: string }
  | { readonly type: "complete"; readonly reminderId: string }
  | { readonly type: "uncomplete"; readonly reminderId: string }
  | { readonly type: "delete"; readonly reminderId: string }
  | { readonly type: "finish_todo"; readonly todoId: string }
  | { readonly type: "confirmed"; readonly todoId: string };

export const reminderNotes = (todoId: string, origin = "https://frely.cloud"): string => `${origin}/user/tasks\nfrely:todo:${todoId}`;
export const todoIdOf = (reminder: Pick<ReminderFacts, "notes">): string | null => MARKER.exec(reminder.notes ?? "")?.[1] ?? null;

/** Only a todo that has a date or schedule, or is in progress, is worth a reminder; the list stays short. */
export function wantsReminder(todo: TodoFacts): boolean {
  return (todo.status === "open" || todo.status === "in_progress") && (todo.nextFireAt !== null || todo.status === "in_progress");
}

const sameMinute = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : Math.floor(Date.parse(a) / 60_000) === Math.floor(Date.parse(b) / 60_000));

/** One sync pass: what to do so the list matches the todos. `reminders` holds every item of the list, completed ones too. */
export function planSync(todos: readonly TodoFacts[], reminders: readonly ReminderFacts[]): SyncAction[] {
  const actions: SyncAction[] = [];
  const byTodo = new Map(todos.map((todo) => [todo.id, todo]));
  const seen = new Set<string>();
  for (const reminder of reminders) {
    const todoId = todoIdOf(reminder);
    if (todoId === null) continue; // the owner's own reminder in the list: never touched
    const todo = byTodo.get(todoId);
    if (seen.has(todoId)) { actions.push({ type: "delete", reminderId: reminder.externalId }); continue; } // a duplicate left by an interrupted sync
    seen.add(todoId);
    if (reminder.isCompleted) {
      if (todo && (todo.status === "open" || todo.status === "in_progress")) {
        if (todo.steps === 0) actions.push({ type: "finish_todo", todoId });
        else { actions.push({ type: "confirmed", todoId }, { type: "uncomplete", reminderId: reminder.externalId }); }
      }
      continue;
    }
    if (!todo || !wantsReminder(todo)) {
      actions.push({ type: !todo || todo.status === "done" ? "complete" : "delete", reminderId: reminder.externalId });
      continue;
    }
    if (!sameMinute(reminder.dueDate, todo.nextFireAt)) actions.push({ type: "replace", reminderId: reminder.externalId, todoId, title: todo.title, due: todo.nextFireAt, notes: reminderNotes(todoId) });
    else if (reminder.title !== todo.title) actions.push({ type: "retitle", reminderId: reminder.externalId, title: todo.title });
  }
  for (const todo of todos) {
    if (!seen.has(todo.id) && wantsReminder(todo)) actions.push({ type: "add", todoId: todo.id, title: todo.title, due: todo.nextFireAt, notes: reminderNotes(todo.id) });
  }
  return actions;
}

/** The next time one of a todo's conditions fires: the earliest check time of an unfired date or schedule. */
export function nextFireOf(conditions: ReadonlyArray<{ type?: string; fired?: boolean; nextCheckAt?: string | null }>): string | null {
  const times = conditions.filter((c) => (c.type === "after" || c.type === "cron") && c.nextCheckAt && !(c.type === "after" && c.fired)).map((c) => c.nextCheckAt!).sort();
  return times[0] ?? null;
}
