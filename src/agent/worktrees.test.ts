import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { branchNameForTask, createTaskWorktree, inspectWorkspace, mergeTaskBranch, removeTaskWorktree, taskDiff, WorktreeError, worktreePathForTask } from "./worktrees.js";
import { newTaskId } from "./protocol.js";

const windowsSkip = process.platform === "win32" ? "worktree path handling assumes POSIX separators" : false;

const exec = promisify(execFile);

async function gitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "frely-agent-git-"));
  await exec("git", ["init", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "test@frely.test"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "hello\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-m", "init"], { cwd: root });
  return root;
}

test("inspectWorkspace rejects non-repos and dirty repos", async () => {
  const plain = await mkdtemp(join(tmpdir(), "frely-agent-plain-"));
  try {
    await assert.rejects(() => inspectWorkspace(plain), (error: unknown) => error instanceof WorktreeError && error.code === "not_a_git_repo");
  } finally {
    await rm(plain, { recursive: true, force: true });
  }
  const repo = await gitRepo();
  try {
    await writeFile(join(repo, "dirty.txt"), "x");
    await assert.rejects(() => inspectWorkspace(repo), (error: unknown) => error instanceof WorktreeError && error.code === "dirty_workspace");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("worktree lifecycle: create outside workspace, merge, remove", { skip: windowsSkip }, async () => {
  const repo = await gitRepo();
  try {
    const taskId = newTaskId();
    const info = await createTaskWorktree(taskId, repo);
    assert.equal(info.branch, `frely/task/${taskId}`);
    assert.equal(info.baseBranch, "main");
    // Worktree lives outside the user workspace.
    assert.ok(!info.path.startsWith(repo));
    assert.match(info.path, /frely\/worktrees\//u);
    assert.equal(worktreePathForTask(taskId, repo).startsWith(info.path.slice(0, info.path.indexOf("worktrees"))), true);

    // Commit a change on the task branch.
    await writeFile(join(info.path, "feature.txt"), "feature\n");
    await exec("git", ["add", "."], { cwd: info.path });
    await exec("git", ["config", "user.email", "test@frely.test"], { cwd: info.path });
    await exec("git", ["config", "user.name", "Test"], { cwd: info.path });
    await exec("git", ["commit", "-m", "task change"], { cwd: info.path });

    const diff = await taskDiff(taskId, repo);
    assert.match(diff.diff, /\+feature/u);

    const outcome = await mergeTaskBranch(taskId, repo);
    assert.equal(outcome.status, "merged");
    const merged = await readFile(join(repo, "feature.txt"), "utf8");
    assert.equal(merged, "feature\n");
    await exec("git", ["worktree", "prune"], { cwd: repo });

    await removeTaskWorktree(taskId, repo);
    const branches = await exec("git", ["branch", "--list", branchNameForTask(taskId)], { cwd: repo });
    assert.equal(branches.stdout.trim(), "");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("merge rebases onto an advanced baseline", { skip: windowsSkip }, async () => {
  const repo = await gitRepo();
  try {
    const taskId = newTaskId();
    const info = await createTaskWorktree(taskId, repo);

    // Baseline advances independently.
    await writeFile(join(repo, "baseline.txt"), "baseline\n");
    await exec("git", ["add", "."], { cwd: repo });
    await exec("git", ["commit", "-m", "baseline advance"], { cwd: repo });

    // Task branch touches a different file.
    await writeFile(join(info.path, "feature.txt"), "feature\n");
    await exec("git", ["config", "user.email", "test@frely.test"], { cwd: info.path });
    await exec("git", ["config", "user.name", "Test"], { cwd: info.path });
    await exec("git", ["add", "."], { cwd: info.path });
    await exec("git", ["commit", "-m", "task change"], { cwd: info.path });

    const outcome = await mergeTaskBranch(taskId, repo);
    assert.equal(outcome.status, "merged");
    assert.equal(await readFile(join(repo, "baseline.txt"), "utf8"), "baseline\n");
    assert.equal(await readFile(join(repo, "feature.txt"), "utf8"), "feature\n");
    await exec("git", ["worktree", "prune"], { cwd: repo });
    await removeTaskWorktree(taskId, repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("conflicting merge reports merge_conflict without corrupting the baseline", async () => {
  const repo = await gitRepo();
  try {
    const taskId = newTaskId();
    const info = await createTaskWorktree(taskId, repo);

    await writeFile(join(repo, "README.md"), "baseline version\n");
    await exec("git", ["add", "."], { cwd: repo });
    await exec("git", ["commit", "-m", "baseline edit"], { cwd: repo });

    await writeFile(join(info.path, "README.md"), "task version\n");
    await exec("git", ["config", "user.email", "test@frely.test"], { cwd: info.path });
    await exec("git", ["config", "user.name", "Test"], { cwd: info.path });
    await exec("git", ["add", "."], { cwd: info.path });
    await exec("git", ["commit", "-m", "task edit"], { cwd: info.path });

    const outcome = await mergeTaskBranch(taskId, repo);
    assert.equal(outcome.status, "merge_conflict");
    assert.equal(await readFile(join(repo, "README.md"), "utf8"), "baseline version\n");
    const status = await exec("git", ["status", "--porcelain"], { cwd: repo });
    assert.equal(status.stdout.trim(), "");
    await exec("git", ["worktree", "prune"], { cwd: repo });
    await removeTaskWorktree(taskId, repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
