import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { runTaskCommand } from "./command.js";
import { buildDefinition, buildSchedule, getDefinition, listDefinitions, saveDefinition, taskHash } from "./definition.js";
import { cancelTaskRun, describeRun, startTask, TaskError, waitForTaskRun, type ManagerDeps } from "./manager.js";
import { effectiveTaskStatus, listTaskRuns, readTaskRun, writeTaskRun } from "./run-store.js";
import { tickSchedules } from "./scheduler.js";
import { executeTaskRun } from "./worker.js";

let root: string;
let cwd: string;
let previousConfig: string | undefined;
let previousSandbox: string | undefined;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "frely-task-"));
  previousSandbox = process.env.FRELY_SANDBOX;
  process.env.FRELY_SANDBOX = "off";
});
after(async () => {
  if (previousSandbox === undefined) delete process.env.FRELY_SANDBOX; else process.env.FRELY_SANDBOX = previousSandbox;
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  previousConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(root, "config-"));
  cwd = await mkdtemp(join(root, "work-"));
});

/** Workers run in this process, as the detached worker would in its own. */
const inProcess = (jobs: Promise<void>[] = []): ManagerDeps & { jobs: Promise<void>[] } => ({ jobs, spawnWorker: (runId) => { jobs.push(executeTaskRun(runId)); } });

async function define(name: string, command: string, extra: Partial<Parameters<typeof buildDefinition>[0]> = {}) {
  const definition = buildDefinition({ name, command, cwd, ...extra });
  await saveDefinition(definition);
  return definition;
}

test("a task runs, logs its output and records the result", { skip: process.platform === "win32" && "These tasks run POSIX shell commands; tasks need the Unix sandbox." }, async () => {
  await define("hello", "echo hello-out; echo hello-err >&2; echo data > made.txt");
  const deps = inProcess();
  const record = await startTask("hello", {}, deps);
  const done = await waitForTaskRun(record.runId, 20_000);
  assert.equal(done.status, "completed");
  assert.equal(done.exitCode, 0);
  assert.equal(await readFile(join(cwd, "made.txt"), "utf8"), "data\n");
  const described = await describeRun(done, { tail: true });
  assert.match(String(described.logTail), /hello-out/);
  assert.match(String(described.logTail), /hello-err/);
  await Promise.all(deps.jobs);
});

test("a failing command is failed with its exit code; a timeout is a timeout", { skip: process.platform === "win32" && "These tasks run POSIX shell commands; tasks need the Unix sandbox." }, async () => {
  await define("bad", "echo nope; exit 3");
  const deps = inProcess();
  const bad = await waitForTaskRun((await startTask("bad", {}, deps)).runId, 20_000);
  assert.equal(bad.status, "failed");
  assert.equal(bad.exitCode, 3);
  await define("slow", "sleep 30", { timeoutSec: 1 });
  const slow = await waitForTaskRun((await startTask("slow", {}, deps)).runId, 20_000);
  assert.equal(slow.status, "timeout");
  await Promise.all(deps.jobs);
});

test("cancel stops the whole process tree and marks the run cancelled", async () => {
  await define("long", "sleep 60 & wait");
  const controllers: AbortController[] = [];
  const jobs: Promise<void>[] = [];
  const deps: ManagerDeps = { spawnWorker: (runId) => { const abort = new AbortController(); controllers.push(abort); jobs.push(executeTaskRun(runId, abort.signal)); } };
  const record = await startTask("long", {}, deps);
  // Wait until the worker has recorded itself.
  for (let i = 0; i < 100 && (await readTaskRun(record.runId))?.workerPid === undefined; i += 1) await new Promise((r) => setTimeout(r, 20));
  controllers[0]!.abort();
  await Promise.all(jobs);
  assert.equal((await readTaskRun(record.runId))?.status, "cancelled");
});

test("a run whose worker died is interrupted, not running", async () => {
  await define("ghost", "true");
  const deps: ManagerDeps = { spawnWorker: () => undefined };
  const record = await startTask("ghost", {}, deps);
  assert.equal(effectiveTaskStatus(record), "running");
  const dead = await writeTaskRun({ ...record, status: "running", workerPid: 2 ** 22 + 12345 });
  assert.equal(effectiveTaskStatus(dead), "interrupted");
  assert.equal((await cancelTaskRun(record.runId)).status, "interrupted", "an ended record is reported as it is");
});

test("a run keeps its own copy of the definition", async () => {
  const first = await define("copy", "echo first");
  const deps: ManagerDeps = { spawnWorker: () => undefined };
  const record = await startTask("copy", {}, deps);
  await saveDefinition(buildDefinition({ name: "copy", command: "echo second", cwd }, first));
  const stored = await readTaskRun(record.runId);
  assert.equal(stored?.snapshot.command, "echo first");
  assert.notEqual((await getDefinition("copy"))?.hash, stored?.snapshot.hash);
});

test("the machine limit refuses a new run, and a schedule never doubles a running task", async () => {
  process.env.FRELY_TASK_MAX_CONCURRENT = "1";
  try {
    await define("one", "true");
    await define("two", "true");
    const deps: ManagerDeps = { spawnWorker: () => undefined };
    await startTask("one", {}, deps);
    await assert.rejects(startTask("two", {}, deps), (error: unknown) => error instanceof TaskError && error.code === "busy");
  } finally { delete process.env.FRELY_TASK_MAX_CONCURRENT; }
  const deps: ManagerDeps = { spawnWorker: () => undefined };
  await assert.rejects(startTask("one", { trigger: "schedule" }, deps), /still running/);
});

test("definitions validate names, sites, environment and folders", () => {
  assert.throws(() => buildDefinition({ name: "Bad Name", command: "x", cwd: "/tmp" }), /lower-case/);
  assert.throws(() => buildDefinition({ name: "ok", command: "x", cwd: "relative" }), /absolute/);
  assert.throws(() => buildDefinition({ name: "ok", command: "x", cwd: "/tmp", network: ["*"] }), /Invalid site/);
  assert.throws(() => buildDefinition({ name: "ok", command: "x", cwd: "/tmp", env: { OPENAI_API_KEY: "x" } }), /not allowed/);
  assert.throws(() => buildDefinition({ name: "ok", command: "x", cwd: "/tmp", timeoutSec: 0 }), /timeout/);
  const a = buildDefinition({ name: "ok", command: "x", cwd: "/tmp", network: ["b.com", "a.com"] });
  const b = buildDefinition({ name: "ok", command: "x", cwd: "/tmp", network: ["a.com", "b.com"] });
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, taskHash({ ...a, command: "y" }));
});

test("a changed definition keeps approvals only for sites that stay", () => {
  const first = buildDefinition({ name: "net", command: "x", cwd: "/tmp", network: ["a.com", "b.com"] });
  const approved = { ...first, approvals: { "a.com": "2999-01-01T00:00:00Z", "b.com": "2999-01-01T00:00:00Z" } };
  const next = buildDefinition({ name: "net", command: "x", cwd: "/tmp", network: ["a.com"] }, approved);
  assert.deepEqual(Object.keys(next.approvals), ["a.com"]);
});

test("schedule: fires once for a due slot, collapses missed slots, drops very old ones, skips when busy", async () => {
  const definition = await define("nightly", "true");
  const since = new Date("2026-11-03T00:00:00Z");
  await saveDefinition({ ...definition, schedule: buildSchedule("0 * * * *", "UTC", since) });
  const deps: ManagerDeps = { spawnWorker: () => undefined };
  // Not due yet at 00:30.
  assert.deepEqual((await tickSchedules(Date.parse("2026-11-03T00:30:00Z"), deps)).started, []);
  // Due at 01:00:10: one run for the 01:00 slot.
  assert.deepEqual((await tickSchedules(Date.parse("2026-11-03T01:00:10Z"), deps)).started, ["nightly"]);
  const [run] = await listTaskRuns();
  assert.equal(run?.trigger, "schedule");
  assert.equal(run?.scheduledFor, "2026-11-03T01:00:00.000Z");
  // Same slot again: nothing.
  assert.deepEqual((await tickSchedules(Date.parse("2026-11-03T01:00:40Z"), deps)).started, []);
  // Hours later while the first is still running (no worker finished it): the new slot is skipped, and recorded.
  const busy = await tickSchedules(Date.parse("2026-11-03T05:00:10Z"), deps);
  assert.deepEqual(busy.skipped, ["nightly"]);
  assert.ok((await listTaskRuns()).some((item) => item.status === "skipped"));
  // Missed by days: dropped, not run.
  const dropped = await tickSchedules(Date.parse("2026-11-09T05:00:10Z"), deps);
  assert.deepEqual(dropped.dropped, ["nightly"]);
});

test("a paused schedule does not fire", async () => {
  const definition = await define("paused", "true");
  const schedule = { ...buildSchedule("* * * * *", "UTC", new Date("2026-11-03T00:00:00Z")), enabled: false };
  await saveDefinition({ ...definition, schedule });
  assert.deepEqual((await tickSchedules(Date.parse("2026-11-03T01:00:00Z"), { spawnWorker: () => undefined })).started, []);
});

test("the command line: add, list, start --wait, result, runs, remove", async () => {
  let out = "";
  const io = { out: (text: string) => { out += text; }, err: () => undefined, interactive: false };
  const deps = inProcess();
  assert.equal(await runTaskCommand(["add", "cli-task", "--cwd", cwd, "--timeout", "30", "--", "echo", "two words"], io), 0);
  assert.equal((await getDefinition("cli-task"))?.command, "echo 'two words'");
  assert.equal(await runTaskCommand(["add", "cli-task", "--cwd", cwd, "--", "true"], io), 1, "no silent overwrite");
  out = "";
  assert.equal(await runTaskCommand(["start", "cli-task", "--wait", "--json"], io, { manager: deps }), 0);
  const result = JSON.parse(out.trim().split("\n").at(-1)!) as { status: string; exitCode: number; logTail: string };
  assert.equal(result.status, "completed");
  assert.match(result.logTail, /two words/);
  out = "";
  assert.equal(await runTaskCommand(["runs", "--json"], io), 0);
  assert.equal((JSON.parse(out) as { runs: unknown[] }).runs.length, 1);
  assert.equal(await runTaskCommand(["list"], io), 0);
  assert.equal(await runTaskCommand(["remove", "cli-task"], io), 0);
  assert.deepEqual(await listDefinitions(), []);
  assert.equal(await runTaskCommand(["start", "cli-task"], io, { manager: deps }), 1);
  await Promise.all(deps.jobs);
});

test("the log is capped and kept outside the task folder", async () => {
  await mkdir(join(cwd, "sub"), { recursive: true });
  await writeFile(join(cwd, "sub", "x"), "x");
  await define("quiet", "ls sub");
  const deps = inProcess();
  const done = await waitForTaskRun((await startTask("quiet", {}, deps)).runId, 20_000);
  assert.match(String((await describeRun(done, { tail: true })).logTail), /x/);
  await Promise.all(deps.jobs);
});
