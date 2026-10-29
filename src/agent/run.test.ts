import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClientToolsUnsupportedError, SkillAccessError, type InstalledAgentSession } from "../skill/access.js";
import type { AgentTurnResult } from "../skill/router.js";
import { cancelRun, executeRun, listRunSummaries, resumeRun, runOutcome, runSummary, startRun, type RunDeps } from "./run.js";
import { createRun, effectiveStatus, pruneRuns, readRun, runsDirectory, RUN_RETENTION_MS, writeRun } from "./run-store.js";

const limits = { totalBytes: 1024 * 1024, maxRounds: 16 };
const usage = (n: number) => ({ input_tokens: n, output_tokens: 1, total_tokens: n + 1 });

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "frely-run-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, "README.md"), "# demo\n");
  await writeFile(join(root, ".env"), "SECRET=1\n");
  return root;
}

interface Seen { task: string; items: unknown[]; tools: number }

function deps(turns: (seen: Seen, call: number) => Promise<AgentTurnResult>, extra: Partial<RunDeps> = {}): { deps: RunDeps; seen: Seen[]; workers: Promise<void>[] } {
  const seen: Seen[] = [];
  const workers: Promise<void>[] = [];
  const session: InstalledAgentSession = {
    distributionId: "creator_distribution_x",
    modelId: "friday/gpt800",
    turn: async (input) => {
      const entry = { task: input.task, items: [...input.items], tools: input.tools.length };
      seen.push(entry);
      return turns(entry, seen.length);
    },
  };
  const value: RunDeps = {
    openSession: async () => session,
    invokePlain: async () => ({ text: "plain answer", modelId: "friday/gpt800" }),
    spawnWorker: (runId) => { workers.push(executeRun(runId, value)); },
    stderr: () => undefined,
    pollMs: 5,
    ...extra,
  };
  return { deps: value, seen, workers };
}

const toolCall = (callId: string, args: Record<string, unknown>): AgentTurnResult => ({
  status: "tool_calls",
  calls: [{ callId, name: "read_file", arguments: JSON.stringify(args) }],
  items: [{ type: "function_call", call_id: callId, name: "read_file", arguments: JSON.stringify(args) }],
  requestId: `req_${callId}`,
  usage: usage(10),
});

test("a run reads files through tool rounds, refuses .env and ends with the answer", async () => {
  const root = await workspace();
  try {
    const { deps: d, seen } = deps(async (_entry, call) => {
      if (call === 1) return toolCall("c1", { path: "README.md" });
      if (call === 2) return toolCall("c2", { path: ".env" });
      return { status: "completed", text: "the plan", requestId: "req_done", usage: usage(30) };
    });
    const record = await startRun({ distributionId: "creator_distribution_x", task: "plan it", read: { root, limits } }, d);
    assert.equal(record.status, "completed");
    const outcome = runOutcome(record);
    assert.equal(outcome.text, "the plan");
    assert.deepEqual(outcome.filesRead, [{ path: "README.md", bytes: 7 }]);
    assert.equal(outcome.rounds, 3);
    assert.deepEqual(outcome.usage, { input_tokens: 50, output_tokens: 3, total_tokens: 53 });
    // First round carries the task and the overview, every round carries the same tools; continuation items grow.
    assert.match(seen[0]!.task, /^plan it\n\n---\nLocal workspace/u);
    assert.match(seen[0]!.task, /README\.md/u);
    assert.doesNotMatch(seen[0]!.task, /\.env/u);
    assert.equal(seen[0]!.tools, 7);
    assert.deepEqual(seen[0]!.items, []);
    assert.equal(seen[1]!.items.length, 2);
    assert.equal(seen[2]!.items.length, 4);
    assert.match(JSON.stringify(seen[2]!.items), /denied by local policy/u);
    assert.doesNotMatch(JSON.stringify(seen), /SECRET=1/u);
    assert.deepEqual(record.rounds.map((round) => round.requestId), ["req_c1", "req_c2", "req_done"]);
    assert.equal(((await stat(join(runsDirectory(), `${record.runId}.json`))).mode & 0o777).toString(8), process.platform === "win32" ? "666" : "600");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plain run without --read is one call and keeps the old result shape", async () => {
  const { deps: d } = deps(async () => { throw new Error("no tool round expected"); });
  const record = await startRun({ distributionId: "creator_distribution_x", task: "hi" }, d);
  assert.deepEqual(runOutcome(record), { ok: true, runId: record.runId, distributionId: "creator_distribution_x", modelId: "friday/gpt800", text: "plain answer" });
});

test("an Agent that takes no caller tools falls back to one plain call", async () => {
  const root = await workspace();
  try {
    const { deps: d } = deps(async () => { throw new ClientToolsUnsupportedError(); });
    const record = await startRun({ distributionId: "creator_distribution_x", task: "hi", read: { root, limits } }, d);
    assert.equal(record.status, "completed");
    assert.equal(runOutcome(record).text, "plain answer");
    assert.equal(runOutcome(record).toolsUnsupported, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed call keeps its typed error and can be resumed from the rounds already done", async () => {
  const root = await workspace();
  try {
    let failNext = true;
    const { deps: d, seen, workers } = deps(async (_entry, call) => {
      if (call === 1) return toolCall("c1", { path: "README.md" });
      if (failNext) { failNext = false; throw new SkillAccessError("remote_call_failed", "The remote Frely Agent call failed."); }
      return { status: "completed", text: "resumed answer", usage: usage(5) };
    });
    const failed = await startRun({ distributionId: "creator_distribution_x", task: "plan", read: { root, limits } }, d);
    assert.equal(failed.status, "failed");
    assert.throws(() => runOutcome(failed), (error: unknown) => error instanceof SkillAccessError && error.code === "remote_call_failed");
    assert.equal(runSummary(failed).resumable, true);
    await resumeRun(failed.runId, d);
    await Promise.all(workers);
    const done = await readRun(failed.runId);
    assert.equal(done!.status, "completed");
    assert.equal(done!.text, "resumed answer");
    assert.equal(done!.resumeCount, 1);
    // The resume sent the first round's items again and did not re-read the file.
    assert.equal(seen.length, 3);
    assert.equal(seen[2]!.items.length, 2);
    assert.deepEqual(done!.filesRead, [{ path: "README.md", bytes: 7 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a worker that died leaves an interrupted run that can still be read", async () => {
  const record = await createRun({ distributionId: "creator_distribution_x", task: "t" });
  await writeRun({ ...record, workerPid: 2 ** 22 + 12345 });
  const current = (await readRun(record.runId))!;
  assert.equal(effectiveStatus(current), "interrupted");
  assert.equal(runSummary(current).status, "interrupted");
  assert.equal(runSummary(current).resumable, true);
  assert.equal((await listRunSummaries())[0]!.runId, record.runId);
});

test("cancelling an orphaned run marks it cancelled; a finished run is left alone", async () => {
  const orphan = await createRun({ distributionId: "creator_distribution_x", task: "t" });
  await writeRun({ ...orphan, workerPid: 2 ** 22 + 12345 });
  assert.equal((await cancelRun(orphan.runId, { pollMs: 5 })).status, "cancelled");
  const { deps: d } = deps(async () => ({ status: "completed", text: "x" }));
  const finished = await startRun({ distributionId: "creator_distribution_x", task: "hi" }, d);
  assert.equal((await cancelRun(finished.runId, { pollMs: 5 })).status, "completed");
});

test("aborting the worker marks the run cancelled", async () => {
  const record = await createRun({ distributionId: "creator_distribution_x", task: "t" });
  const controller = new AbortController();
  const { deps: d } = deps(async () => ({ status: "completed", text: "x" }), {
    invokePlain: async (_id, _task, signal) => { controller.abort(); assert.equal(signal.aborted, true); throw new Error("aborted"); },
  });
  await executeRun(record.runId, d, controller.signal);
  assert.equal((await readRun(record.runId))!.status, "cancelled");
});

test("an error thrown by the call is reported as the same typed error", async () => {
  const { deps: d } = deps(async () => ({ status: "completed", text: "x" }), {
    invokePlain: async () => { throw new SkillAccessError("payment_required", "Not enough Frely Credit."); },
  });
  const record = await startRun({ distributionId: "creator_distribution_x", task: "hi" }, d);
  assert.throws(() => runOutcome(record), (error: unknown) => error instanceof SkillAccessError && error.code === "payment_required");
});

test("finished runs are removed after seven days, running ones are not", async () => {
  const old = await createRun({ distributionId: "creator_distribution_x", task: "old" });
  await writeRun({ ...old, status: "completed" });
  const running = await createRun({ distributionId: "creator_distribution_x", task: "running" });
  await pruneRuns(Date.now() + RUN_RETENTION_MS + 1000);
  assert.equal(await readRun(old.runId), null);
  assert.notEqual(await readRun(running.runId), null);
  await utimes(runsDirectory(), new Date(), new Date());
  assert.ok((await readFile(join(runsDirectory(), `${running.runId}.json`), "utf8")).includes(running.runId));
});

test("input over 128 KiB is refused before a run is created", async () => {
  const { deps: d } = deps(async () => ({ status: "completed", text: "x" }));
  await assert.rejects(() => startRun({ distributionId: "creator_distribution_x", task: "x".repeat(128 * 1024 + 1) }, d), (error: unknown) => error instanceof SkillAccessError && error.code === "input_invalid");
  assert.deepEqual(await listRunSummaries(), []);
});
