/**
 * Git worktree lifecycle for agent tasks (plan §4.4): task changes land in an
 * isolated worktree outside the user workspace, merge back with --no-ff after
 * approval, and rebase first when the baseline branch advanced.
 */
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { agentDataDir, workspaceStorageKey } from "./task-store.js";

const exec = promisify(execFile);

export class WorktreeError extends Error {
  constructor(readonly code: "not_a_git_repo" | "dirty_workspace" | "git_failed" | "merge_conflict" | "not_found" | "invalid_state") {
    super(code);
    this.name = "WorktreeError";
  }
}

export type WorktreeInfo = {
  path: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
};

export function branchNameForTask(taskId: string): string {
  return `frely/task/${taskId}`;
}

export function worktreePathForTask(taskId: string, workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDataDir(env), "worktrees", workspaceStorageKey(workspaceRoot), taskId);
}

/** Verify a workspace is a clean git repository and return its base facts. */
export async function inspectWorkspace(workspaceRoot: string): Promise<{ baseBranch: string; baseCommit: string; root: string }> {
  let root: string;
  try {
    const out = await git(workspaceRoot, ["rev-parse", "--show-toplevel"]);
    root = out.trim();
  } catch {
    throw new WorktreeError("not_a_git_repo");
  }
  let status: string;
  try {
    status = (await git(root, ["status", "--porcelain"])).trim();
  } catch {
    throw new WorktreeError("git_failed");
  }
  if (status.length > 0) throw new WorktreeError("dirty_workspace");
  const baseCommit = (await git(root, ["rev-parse", "HEAD"])).trim();
  if (!/^[0-9a-f]{7,40}$/u.test(baseCommit)) throw new WorktreeError("git_failed");
  let baseBranch: string;
  try {
    baseBranch = (await git(root, ["symbolic-ref", "--short", "HEAD"])).trim();
  } catch {
    baseBranch = baseCommit; // detached HEAD: baseline is the commit itself
  }
  return { baseBranch: baseBranch || baseCommit, baseCommit, root };
}

export async function createTaskWorktree(taskId: string, workspaceRoot: string, baseRef?: string): Promise<WorktreeInfo> {
  const facts = await inspectWorkspace(workspaceRoot);
  const path = worktreePathForTask(taskId, facts.root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const branch = branchNameForTask(taskId);
  try {
    await git(facts.root, ["worktree", "add", "-b", branch, path, baseRef ?? facts.baseCommit]);
  } catch {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    throw new WorktreeError("git_failed");
  }
  return { path, branch, baseBranch: facts.baseBranch, baseCommit: facts.baseCommit };
}

export async function removeTaskWorktree(taskId: string, workspaceRoot: string): Promise<void> {
  const facts = await inspectWorkspace(workspaceRoot).catch(() => null);
  const root = facts?.root ?? workspaceRoot;
  const path = worktreePathForTask(taskId, root);
  const branch = branchNameForTask(taskId);
  await git(root, ["worktree", "remove", "--force", path]).catch(() => undefined);
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  await git(root, ["branch", "-D", branch]).catch(() => undefined);
}

export type MergeOutcome = { status: "merged" } | { status: "merge_conflict"; detail: string };

/** Rebase the task branch (inside its worktree) onto the current baseline, then merge --no-ff. */
export async function mergeTaskBranch(taskId: string, workspaceRoot: string): Promise<MergeOutcome> {
  const facts = await inspectWorkspace(workspaceRoot);
  const branch = branchNameForTask(taskId);
  const worktree = worktreePathForTask(taskId, facts.root);
  const baseTip = (await git(facts.root, ["rev-parse", facts.baseBranch])).trim();

  // Uncommitted agent edits are committed first: merges only carry commits.
  const dirty = (await git(worktree, ["status", "--porcelain"])).trim();
  if (dirty.length > 0) {
    await git(worktree, ["add", "-A"]);
    await git(worktree, ["-c", "user.email=agent@frely.invalid", "-c", "user.name=frely agent", "commit", "-m", `Agent changes for ${taskId}`]);
  }

  // Rebase the task branch onto the current baseline tip inside its own worktree.
  let rebaseFailed = false;
  await git(worktree, ["rebase", baseTip]).catch(() => {
    rebaseFailed = true;
  });
  if (rebaseFailed) {
    await git(worktree, ["rebase", "--abort"]).catch(() => undefined);
    return { status: "merge_conflict", detail: "Task branch cannot be rebased onto the current baseline." };
  }

  if (facts.baseBranch === facts.baseCommit) {
    // Detached baseline: nothing to merge into; treat as conflict to force an explicit decision.
    return { status: "merge_conflict", detail: "Workspace baseline is a detached commit." };
  }

  try {
    await git(facts.root, ["merge", "--no-ff", branch, "-m", `Merge ${branch}`]);
    return { status: "merged" };
  } catch (error) {
    await git(facts.root, ["merge", "--abort"]).catch(() => undefined);
    return { status: "merge_conflict", detail: error instanceof Error ? error.message.slice(0, 512) : "merge failed" };
  }
}

/** List of changed files (vs base) with bounded diff output. */
export async function taskChangedFiles(taskId: string, workspaceRoot: string): Promise<string[]> {
  const facts = await inspectWorkspace(workspaceRoot);
  const branch = branchNameForTask(taskId);
  const base = (await git(facts.root, ["merge-base", branch, facts.baseBranch]).catch(() => null))?.trim() ?? facts.baseCommit;
  const out = await git(facts.root, ["diff", "--name-only", `${base}..${branch}`]);
  return out.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/** Bounded unified diff of the task worktree vs its merge-base (committed + uncommitted changes). */
export async function taskDiff(taskId: string, workspaceRoot: string, path?: string, maxBytes = 256 * 1024): Promise<{ diff: string; truncated: boolean }> {
  const facts = await inspectWorkspace(workspaceRoot);
  const branch = branchNameForTask(taskId);
  const worktree = worktreePathForTask(taskId, facts.root);
  const base = (await git(facts.root, ["merge-base", branch, facts.baseBranch]).catch(() => null))?.trim() ?? facts.baseCommit;
  // Include brand-new (untracked) files in the diff via intent-to-add markers.
  await git(worktree, ["add", "--intent-to-add", "-A"]).catch(() => undefined);
  const args = ["diff", base];
  if (path) args.push("--", path);
  const out = await git(worktree, args, { maxBuffer: 16 * 1024 * 1024 });
  const buffer = Buffer.from(out, "utf8");
  if (buffer.byteLength <= maxBytes) return { diff: out, truncated: false };
  return { diff: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

async function git(cwd: string, args: string[], options?: { maxBuffer?: number }): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: options?.maxBuffer ?? 4 * 1024 * 1024 });
  return stdout;
}
