import assert from "node:assert/strict";
import test from "node:test";
import { parseTodoArgs, runTodoCommand } from "./todo-command.js";

function harness(result: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  let text = "";
  return {
    calls,
    text: () => text,
    io: { out: (value: string) => { text += value; }, call: async (name: string, input: Record<string, unknown>) => { calls.push({ name, input }); return result; } },
  };
}

test("add sends the title, the description and the steps in order with their devices", async () => {
  const h = harness({ todo: { id: "td_1" } });
  const code = await runTodoCommand(["add", "Ship", "it", "--description", "d", "--step", "build", "--device", "dev_1", "--step", "test"], h.io);
  assert.equal(code, 0);
  assert.deepEqual(h.calls, [{ name: "task.add", input: { title: "Ship it", description: "d", steps: [{ instruction: "build", deviceId: "dev_1" }, { instruction: "test" }] } }]);
  assert.equal(h.text(), "Created td_1\n");
});

test("list maps its flags to the task.list input and validates the status", async () => {
  const h = harness({ items: [{ id: "td_1", title: "A", status: "open", steps: { total: 2, succeeded: 1 } }], total: 1, page: 1, totalPages: 1 });
  await runTodoCommand(["list", "--status", "open", "--search", "a", "--sort", "title", "--direction", "asc", "--page", "2"], h.io);
  assert.deepEqual(h.calls[0]!.input, { status: ["open"], q: "a", sort: "title", direction: "asc", page: 2 });
  assert.match(h.text(), /td_1 +open +A +1\/2/);
  await assert.rejects(() => runTodoCommand(["list", "--status", "nope"], harness().io), /--status must be one of/);
});

test("archive is task.update with status archived (the only delete)", async () => {
  const h = harness({ todo: { id: "td_1", status: "archived" } });
  await runTodoCommand(["archive", "td_1"], h.io);
  assert.deepEqual(h.calls, [{ name: "task.update", input: { todoId: "td_1", status: "archived" } }]);
});

test("update needs something to change, and a step status must be a manual one", async () => {
  await assert.rejects(() => runTodoCommand(["update", "td_1"], harness().io), /Nothing to update/);
  await assert.rejects(() => runTodoCommand(["step", "update", "td_1", "tds_1", "--status", "running"], harness().io), /--status must be one of/);
  const h = harness({ step: { id: "tds_1", seq: 1, status: "succeeded", instruction: "x" } });
  await runTodoCommand(["step", "update", "td_1", "tds_1", "--status", "succeeded", "--result", "ok"], h.io);
  assert.deepEqual(h.calls[0], { name: "task.step_update", input: { todoId: "td_1", stepId: "tds_1", status: "succeeded", resultSummary: "ok" } });
});

test("plan with no --step clears the unstarted steps; --json prints the raw result", async () => {
  const h = harness({ steps: [] });
  await runTodoCommand(["plan", "td_1", "--json"], h.io);
  assert.deepEqual(h.calls[0], { name: "task.plan", input: { todoId: "td_1", steps: [] } });
  assert.equal(h.text(), '{"steps":[]}\n');
});

test("an unknown option is refused and no call is made", () => {
  assert.throws(() => parseTodoArgs(["--bogus", "x"], []), /Unknown option --bogus/);
});

test("schedule sends the cron, the zone and an optional end to task.schedule_add", async () => {
  const h = harness({ condition: { id: "tdc_1", nextCheckAt: "2026-11-28T01:30:00Z" } });
  const code = await runTodoCommand(["schedule", "td_1", "--cron", "30 9 * * *", "--tz", "Asia/Shanghai", "--until", "2027-01-01T00:00:00Z"], h.io);
  assert.equal(code, 0);
  assert.deepEqual(h.calls, [{ name: "task.schedule_add", input: { todoId: "td_1", cron: "30 9 * * *", timezone: "Asia/Shanghai", until: "2027-01-01T00:00:00Z" } }]);
  assert.match(h.text(), /Scheduled td_1/);
});

test("schedule needs the task id, a cron and a zone", async () => {
  const h = harness();
  await assert.rejects(runTodoCommand(["schedule", "td_1", "--cron", "30 9 * * *"], h.io), /Usage: frely task schedule/);
});
