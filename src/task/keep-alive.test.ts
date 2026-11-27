import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { runTaskCommand } from "./command.js";
import { buildDefinition, getDefinition, isLoopbackUrl, saveDefinition } from "./definition.js";
import { HEALTH_FAILURES, restartDelayMs, startKeepAlive, stopKeepAlive, tickKeepAlive, RESTART_MAX_MS } from "./keep-alive.js";
import { createTaskRun, isActive, listTaskRuns, snapshotOf, taskLogPath, writeTaskRun, type TaskRunRecord } from "./run-store.js";
import { type ManagerDeps } from "./manager.js";
import { localTasksReport, LOCAL_TASK_REPORT_FIELDS, controlLocalTask } from "./report.js";
import { executeTaskRun, KEEP_ALIVE_LOG_BYTES } from "./worker.js";

let root: string;
let cwd: string;
let previousConfig: string | undefined;
let previousSandbox: string | undefined;

before(async () => { root = await mkdtemp(join(tmpdir(), "frely-keepalive-")); previousSandbox = process.env.FRELY_SANDBOX; process.env.FRELY_SANDBOX = "off"; });
after(async () => { if (previousSandbox === undefined) delete process.env.FRELY_SANDBOX; else process.env.FRELY_SANDBOX = previousSandbox; await rm(root, { recursive: true, force: true }); });
beforeEach(async () => { previousConfig = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = await mkdtemp(join(root, "config-")); cwd = await mkdtemp(join(root, "work-")); });

/** Workers run in this process; a "service" here is a short command so a test can see it end. */
const inProcess = (jobs: Promise<void>[] = []): ManagerDeps & { jobs: Promise<void>[] } => ({ jobs, spawnWorker: (runId) => { jobs.push(executeTaskRun(runId)); } });
const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t), interactive: false } }; };

const run = (over: Partial<TaskRunRecord> & { startedAt: string; endedAt: string }): TaskRunRecord => ({
  version: 1, runId: crypto.randomUUID(), snapshot: { name: "svc", runner: "script", command: "x", cwd: "/tmp", env: {}, timeoutSec: 1, hash: "h", sites: [] }, trigger: "schedule", status: "failed",
  createdAt: over.startedAt, updatedAt: over.endedAt, ...over,
});

test("the restart delay starts at one second, doubles per quick exit, stops at five minutes and resets after a stable run", () => {
  const at = (minute: number, seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, minute, seconds)).toISOString();
  const quick = (n: number) => run({ startedAt: at(n, 0), endedAt: at(n, 1) });
  assert.equal(restartDelayMs([]), 1000);
  assert.equal(restartDelayMs([quick(3)]), 1000);
  assert.equal(restartDelayMs([quick(4), quick(3)]), 2000);
  assert.equal(restartDelayMs([quick(5), quick(4), quick(3)]), 4000);
  assert.equal(restartDelayMs(Array.from({ length: 20 }, (_, i) => quick(30 - i))), RESTART_MAX_MS);
  const stable = run({ startedAt: at(0, 0), endedAt: at(11, 0) });
  assert.equal(restartDelayMs([quick(20), stable, quick(1)]), 1000);
});

test("a health URL must be on this computer", () => {
  assert.ok(isLoopbackUrl("http://127.0.0.1:8080/health"));
  assert.ok(isLoopbackUrl("http://localhost:3000/"));
  for (const bad of ["https://example.com/health", "http://192.168.1.2/health", "http://127.0.0.1.evil.com/", "ftp://127.0.0.1/", "http://user:pw@127.0.0.1/"]) assert.ok(!isLoopbackUrl(bad), bad);
  assert.throws(() => buildDefinition({ name: "svc", command: "x", cwd, keepAlive: { healthUrl: "https://example.com/" } }), /this computer/u);
});

test("--keep-alive refuses --cron, --timeout and a health URL without it; the definition has no timeout and no schedule", async () => {
  const a = io();
  assert.notEqual(await runTaskCommand(["add", "svc", "--cwd", cwd, "--keep-alive", "--cron", "* * * * *", "--", "sleep", "9"], a.io), 0);
  assert.notEqual(await runTaskCommand(["add", "svc", "--cwd", cwd, "--health-url", "http://127.0.0.1:1/", "--", "sleep", "9"], a.io), 0);
  assert.equal(await runTaskCommand(["add", "svc", "--cwd", cwd, "--keep-alive", "--health-url", "http://127.0.0.1:1/h", "--", "sleep", "9"], a.io), 0);
  const definition = (await getDefinition("svc"))!;
  assert.deepEqual(definition.keepAlive, { healthUrl: "http://127.0.0.1:1/h" });
  assert.equal(definition.schedule, undefined);
  assert.equal(definition.timeoutSec, 24 * 3600);
});

test("a stopped service is not restarted; start brings it back; an exited service restarts after its delay", { skip: process.platform === "win32" }, async () => {
  const definition = buildDefinition({ name: "svc", command: "echo up", cwd, keepAlive: {} });
  await saveDefinition(definition);
  const deps = inProcess();
  const t0 = Date.now();
  assert.deepEqual((await tickKeepAlive(t0, deps)).started, ["svc"]);
  await Promise.all(deps.jobs);
  assert.equal((await tickKeepAlive(t0 + 100, deps)).started.length, 0, "still inside the one-second delay");
  assert.deepEqual((await tickKeepAlive(t0 + 60_000, deps)).started, ["svc"]);
  await Promise.all(deps.jobs);
  await stopKeepAlive("svc");
  assert.equal((await getDefinition("svc"))!.keepAlive!.stopped, true);
  assert.equal((await tickKeepAlive(t0 + 600_000, deps)).started.length, 0);
  const runStarted = await startKeepAlive("svc", deps);
  assert.ok(runStarted);
  await Promise.all(deps.jobs);
  assert.equal((await getDefinition("svc"))!.keepAlive!.stopped, false);
  assert.equal((await getDefinition("svc"))!.hash, definition.hash, "stopping does not change the hash");
});

test("three failed health checks restart the service, after the start-up grace", { skip: process.platform === "win32" }, async () => {
  const definition = buildDefinition({ name: "svc", command: "sleep 60", cwd, keepAlive: { healthUrl: "http://127.0.0.1:9/health" } });
  await saveDefinition(definition);
  // A real stand-in process owns the run: cancelling sends SIGTERM to its pid, which must not be this test's own.
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  try {
    const record = await createTaskRun({ snapshot: snapshotOf(definition, []), trigger: "schedule" });
    const startedAt = new Date(Date.now() - 120_000).toISOString();
    await writeTaskRun({ ...record, status: "running", workerPid: child.pid!, startedAt });
    const down = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const deps = inProcess();
    const now = Date.now();
    assert.deepEqual((await tickKeepAlive(now - 100_000, deps, undefined, down)).restartedUnhealthy, [], "inside the start-up grace");
    for (let i = 1; i < HEALTH_FAILURES; i += 1) assert.deepEqual((await tickKeepAlive(now + i, deps, undefined, down)).restartedUnhealthy, []);
    assert.deepEqual((await tickKeepAlive(now + HEALTH_FAILURES, deps, undefined, down)).restartedUnhealthy, ["svc"]);
    assert.ok(!isActive((await listTaskRuns()).find((item) => item.runId === record.runId)!));
  } finally { child.kill("SIGKILL"); }
});

test("the report shows a service as keep_alive with running, restarts, lastExit and healthy, and nothing else new", async () => {
  await saveDefinition(buildDefinition({ name: "svc", command: "SECRET_CMD", cwd, keepAlive: {} }));
  const [item] = await localTasksReport();
  assert.equal(item!.mode, "keep_alive");
  assert.equal(item!.enabled, true);
  assert.equal(item!.running, false);
  assert.equal(item!.restarts, 0);
  for (const key of Object.keys(item!)) assert.ok((LOCAL_TASK_REPORT_FIELDS as readonly string[]).includes(key), key);
  assert.ok(!JSON.stringify(item).includes("SECRET_CMD"));
  await controlLocalTask({ action: "stop", name: "svc" });
  assert.equal((await localTasksReport())[0]!.enabled, false);
  await assert.rejects(() => controlLocalTask({ action: "schedule", name: "svc", cron: "* * * * *" }), /keep-alive/u);
});

test("a service log rotates at 10 MB and keeps the current file and two older ones", { skip: process.platform === "win32" }, async () => {
  const lines = Math.ceil((KEEP_ALIVE_LOG_BYTES * 2.5) / 1000);
  await saveDefinition(buildDefinition({ name: "svc", command: `head -c ${lines * 1000} /dev/zero | tr '\\0' 'x' | fold -w 999`, cwd, keepAlive: {} }));
  const deps = inProcess();
  await tickKeepAlive(Date.now(), deps);
  await Promise.all(deps.jobs);
  const [record] = await listTaskRuns();
  const path = taskLogPath(record!.runId);
  const sizes = await Promise.all([path, `${path}.1`, `${path}.2`].map(async (file) => (await stat(file).catch(() => ({ size: -1 }))).size));
  assert.ok(sizes.every((size) => size >= 0 && size <= KEEP_ALIVE_LOG_BYTES + 4096), sizes.join(","));
  assert.ok(!(await stat(`${path}.3`).then(() => true, () => false)));
});
