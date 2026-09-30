import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentToolExecutor, toolKindFromMethod } from "./tool-executor.js";
import { FairRwScheduler } from "../runtime/scheduler.js";

const windowsSkip = process.platform === "win32" ? "sandboxed bash tool assumes a POSIX shell" : false;

test("tool executor maps relay method names to kinds", () => {
  assert.equal(toolKindFromMethod("tool.read"), "read");
  assert.equal(toolKindFromMethod("tool.bash"), "bash");
  assert.equal(toolKindFromMethod("tool.edit"), "edit");
  assert.equal(toolKindFromMethod("session.dispose"), null);
});

test("tool executor writes and reads inside the worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-agent-tools-"));
  try {
    const executor = new AgentToolExecutor(root, new FairRwScheduler(4));
    const write = await executor.execute("write", { path: "src/a.txt", content: "hello\n", overwrite: false });
    assert.equal(write.ok, true);
    const read = await executor.execute("read", { path: "src/a.txt" });
    assert.equal(read.ok ? (read.result as string) : undefined, "hello\n");
    const ls = await executor.execute("ls", {});
    assert.equal(ls.ok, true);
    const find = await executor.execute("find", { pattern: "*.txt" });
    assert.ok(find.ok && Array.isArray(find.result));
    const grep = await executor.execute("grep", { query: "hello" });
    assert.ok(grep.ok && Array.isArray(grep.result) && (grep.result as unknown[]).length === 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool executor rejects path escapes outside the worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-agent-tools-"));
  const outside = await mkdtemp(join(tmpdir(), "frely-agent-outside-"));
  try {
    const executor = new AgentToolExecutor(root, new FairRwScheduler(4));
    const escape = await executor.execute("write", { path: "../escape.txt", content: "bad", overwrite: true });
    assert.equal(escape.ok, false);
    const deep = await executor.execute("write", { path: "a/../../b.txt", content: "bad", overwrite: true });
    assert.equal(deep.ok, false);
    const absolute = await executor.execute("write", { path: join(outside, "abs.txt"), content: "bad", overwrite: true });
    assert.equal(absolute.ok, false);
    const readEscape = await executor.execute("read", { path: "../outside.txt" });
    assert.equal(readEscape.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("tool executor refuses edits without matching expectations and disposes", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-agent-tools-"));
  try {
    const executor = new AgentToolExecutor(root, new FairRwScheduler(4));
    await executor.execute("write", { path: "a.txt", content: "one\ntwo\n", overwrite: false });
    const stale = await executor.execute("edit", { path: "a.txt", edits: [{ startLine: 1, endLine: 1, replacement: "ONE" }], expectedSha256: "0".repeat(64) });
    assert.equal(stale.ok, false);
    const edit = await executor.execute("edit", { path: "a.txt", edits: [{ startLine: 2, endLine: 2, replacement: "TWO" }] });
    assert.equal(edit.ok, true);
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "one\nTWO\n");

    executor.dispose();
    const after = await executor.execute("read", { path: "a.txt" });
    assert.equal(after.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool executor runs commands with cwd constrained to the worktree", { skip: windowsSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-agent-tools-"));
  const outside = await mkdtemp(join(tmpdir(), "frely-agent-outside-"));
  try {
    const executor = new AgentToolExecutor(root, new FairRwScheduler(4));
    const inside = await executor.execute("bash", { command: "pwd", cwd: "." });
    assert.equal(inside.ok, true);
    assert.ok((inside.ok ? (inside.result as { stdout: string }).stdout : "").includes(root));

    const outsideCwd = await executor.execute("bash", { command: "pwd", cwd: outside });
    assert.equal(outsideCwd.ok, false);

    const escapeDotDot = await executor.execute("bash", { command: "pwd", cwd: ".." });
    assert.equal(escapeDotDot.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
