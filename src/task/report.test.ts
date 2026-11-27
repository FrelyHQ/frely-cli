import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDefinition, buildSchedule, getDefinition, saveDefinition } from "./definition.js";
import { controlLocalTask, LOCAL_TASK_REPORT_FIELDS, LOCAL_TASK_RUN_FIELDS, localTasksReport } from "./report.js";

async function withHome(work: () => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "frely-report-"));
  const before = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  try { await work(); } finally { if (before === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = before; await rm(home, { recursive: true, force: true }); }
}

test("the report carries only the whitelisted fields and never the command, folder, sites or environment", async () => {
  await withHome(async () => {
    const base = buildDefinition({ name: "daily", command: "SECRET_COMMAND --token abc", cwd: "/tmp/secret-folder", network: ["example.com"], env: { API: "hunter2" } });
    await saveDefinition({ ...base, description: "Daily update", schedule: buildSchedule("30 9 * * *", "Asia/Shanghai") });
    const [item] = await localTasksReport();
    assert.ok(item);
    for (const key of Object.keys(item)) assert.ok((LOCAL_TASK_REPORT_FIELDS as readonly string[]).includes(key), key);
    for (const run of item.runs) for (const key of Object.keys(run)) assert.ok((LOCAL_TASK_RUN_FIELDS as readonly string[]).includes(key), key);
    const text = JSON.stringify(item);
    for (const secret of ["SECRET_COMMAND", "abc", "secret-folder", "example.com", "hunter2"]) assert.ok(!text.includes(secret), secret);
    assert.deepEqual([item.name, item.description, item.mode, item.cron, item.timezone, item.enabled], ["daily", "Daily update", "cron", "30 9 * * *", "Asia/Shanghai", true]);
    assert.ok(item.nextRunAt);
    assert.equal(item.hash.length, 8);
  });
});

test("pause, resume and a new cron change only the schedule, and the definition hash stays", async () => {
  await withHome(async () => {
    const base = buildDefinition({ name: "daily", command: "echo hi", cwd: "/tmp" });
    await saveDefinition({ ...base, schedule: buildSchedule("30 9 * * *", "UTC") });
    await controlLocalTask({ action: "pause", name: "daily" });
    assert.equal((await getDefinition("daily"))!.schedule!.enabled, false);
    await controlLocalTask({ action: "resume", name: "daily" });
    await controlLocalTask({ action: "schedule", name: "daily", cron: "0 8 * * *", timezone: "Asia/Shanghai" });
    const after = (await getDefinition("daily"))!;
    assert.deepEqual([after.schedule!.cron, after.schedule!.timezone, after.schedule!.enabled, after.hash], ["0 8 * * *", "Asia/Shanghai", true, base.hash]);
    await assert.rejects(() => controlLocalTask({ action: "pause", name: "missing" }), /No task/u);
    await assert.rejects(() => controlLocalTask({ action: "schedule", name: "daily", cron: "nonsense" }));
  });
});
