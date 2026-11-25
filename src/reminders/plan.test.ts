import test from "node:test";
import assert from "node:assert/strict";
import { nextFireOf, planSync, reminderNotes, todoIdOf, type ReminderFacts, type TodoFacts } from "./plan.js";

const todo = (id: string, extra: Partial<TodoFacts> = {}): TodoFacts => ({ id, title: `Task ${id}`, status: "open", steps: 0, nextFireAt: "2026-12-01T09:00:00.000Z", ...extra });
const reminder = (id: string, todoId: string | null, extra: Partial<ReminderFacts> = {}): ReminderFacts => ({ externalId: `r-${id}`, title: `Task ${id}`, isCompleted: false, dueDate: "2026-12-01T09:00:00.000Z", notes: todoId ? reminderNotes(todoId) : null, ...extra });

test("a todo with a date gets a reminder; one with nothing to wait for and not in progress does not", () => {
  const actions = planSync([todo("a"), todo("b", { nextFireAt: null }), todo("c", { nextFireAt: null, status: "in_progress" })], []);
  assert.deepEqual(actions.map((a) => [a.type, (a as { todoId: string }).todoId]), [["add", "a"], ["add", "c"]]);
});

test("a matching reminder needs nothing; a changed title is edited and a changed date replaces it", () => {
  assert.deepEqual(planSync([todo("a")], [reminder("a", "a")]), []);
  assert.deepEqual(planSync([todo("a", { title: "New" })], [reminder("a", "a")]).map((a) => a.type), ["retitle"]);
  assert.deepEqual(planSync([todo("a", { nextFireAt: "2026-12-02T09:00:00.000Z" })], [reminder("a", "a")]).map((a) => a.type), ["replace"]);
});

test("ticking a reminder completes a todo without steps, and only confirms one with steps (the reminder is reset)", () => {
  assert.deepEqual(planSync([todo("a")], [reminder("a", "a", { isCompleted: true })]), [{ type: "finish_todo", todoId: "a" }]);
  assert.deepEqual(planSync([todo("a", { steps: 2 })], [reminder("a", "a", { isCompleted: true })]), [{ type: "confirmed", todoId: "a" }, { type: "uncomplete", reminderId: "r-a" }]);
});

test("a todo that is done is ticked off, one that is gone or archived is removed; the owner's own reminders are never touched", () => {
  assert.deepEqual(planSync([], [reminder("a", "a")]), [{ type: "complete", reminderId: "r-a" }]);
  assert.deepEqual(planSync([todo("a", { status: "archived" })], [reminder("a", "a")]), [{ type: "delete", reminderId: "r-a" }]);
  assert.deepEqual(planSync([], [reminder("own", null)]), []);
});

test("a duplicate left by an interrupted sync is removed, and the marker is read back from the notes", () => {
  assert.deepEqual(planSync([todo("a")], [reminder("a", "a"), { ...reminder("a2", "a") }]), [{ type: "delete", reminderId: "r-a2" }]);
  assert.equal(todoIdOf({ notes: reminderNotes("td_9") }), "td_9");
  assert.equal(todoIdOf({ notes: "buy milk" }), null);
});

test("the next fire time is the earliest unfired date or schedule", () => {
  assert.equal(nextFireOf([{ type: "cron", nextCheckAt: "2026-12-03T00:00:00Z" }, { type: "after", fired: false, nextCheckAt: "2026-12-01T00:00:00Z" }, { type: "after", fired: true, nextCheckAt: "2026-11-01T00:00:00Z" }, { type: "github_release", nextCheckAt: "2026-11-20T00:00:00Z" }]), "2026-12-01T00:00:00Z");
  assert.equal(nextFireOf([]), null);
});
