import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_ANSWER_FILE, codexRunner } from "./codex-runner.js";
import { buildDefinition } from "./definition.js";
import { snapshotOf, type TaskRunRecord } from "./run-store.js";

const definition = (extra: { input?: string } = {}) => {
  const built = buildDefinition({ name: "demo", runner: "codex", command: "Say \"hi\" and `date`; $HOME", cwd: "/work" });
  return { built, snapshot: snapshotOf(built, [], extra) };
};
const context = (cwd: string, extra: { input?: string } = {}) => {
  const { snapshot } = definition(extra);
  return { record: { runId: "r1" } as TaskRunRecord, snapshot, cwd, log: () => undefined };
};

test("codex is a known runner and its prompt reaches the program through the environment, never the command line", async () => {
  assert.equal(definition().built.runner, "codex");
  const plan = await codexRunner.prepare(context("/work"));
  assert.match(plan.command, /^codex exec /u);
  assert.ok(plan.command.includes('"$FRELY_TASK_PROMPT"'));
  assert.ok(!plan.command.includes("Say"));
  assert.equal(plan.env.FRELY_TASK_PROMPT, "Say \"hi\" and `date`; $HOME");
  assert.equal((await codexRunner.prepare(context("/work", { input: "extra" }))).env.FRELY_TASK_PROMPT, "Say \"hi\" and `date`; $HOME\n\nRequest from the caller:\nextra");
});

test("finish returns the last message Codex wrote, and names a missing install", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frely-codex-"));
  try {
    await mkdir(join(dir, ".cache"));
    await writeFile(join(dir, CODEX_ANSWER_FILE), "done: 3 files\n");
    assert.deepEqual(await codexRunner.finish!(context(dir), { code: 0, output: "" }), { answer: "done: 3 files" });
    assert.deepEqual(await codexRunner.finish!(context(join(dir, "none")), { code: 0, output: "" }), {});
    const missing = await codexRunner.finish!(context(join(dir, "none")), { code: 127, output: "sh: codex: command not found" });
    assert.equal((missing as { error: { code: string } }).error.code, "codex_unavailable");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
