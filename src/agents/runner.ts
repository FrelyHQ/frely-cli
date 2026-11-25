import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tasksDir } from "../task/definition.js";
import type { Runner, RunnerContext } from "../task/runner.js";
import { taskEnv } from "../task/runner.js";
import type { TaskRunRecord } from "../task/run-store.js";
import { findBinary } from "./detect.js";
import type { AgentAdapter } from "./types.js";

const shellQuote = (text: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`);

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-c", "user.name=frely", "-c", "user.email=frely@localhost", ...args], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)));
  });
}

/** `a/b | +3 -1` lines from a unified diff, at most 30 files. */
export function summarizeDiff(diff: string): string {
  const files: Array<{ name: string; add: number; del: number }> = [];
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (header) { files.push({ name: header[2]!, add: 0, del: 0 }); continue; }
    const file = files.at(-1);
    if (!file) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) file.add += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) file.del += 1;
  }
  if (files.length === 0) return "No file changes.";
  const shown = files.slice(0, 30).map((file) => `${file.name} | +${file.add} -${file.del}`);
  return `${files.length} file${files.length === 1 ? "" : "s"} changed\n${shown.join("\n")}${files.length > 30 ? `\n… and ${files.length - 30} more` : ""}`;
}

/** What `prepare` decided and `finish` needs again. */
interface RunState { readonly workdir: string; readonly kind: "direct" | "scratch" | "worktree" | "read"; readonly outputFile: string; readonly adapter: AgentAdapter; readonly source: string; readonly branch?: string }

/** The prompt: the task's instructions, then the caller's request when a shared task got one. */
export const promptOf = (snapshot: { command: string; input?: string }): string => (snapshot.input === undefined ? snapshot.command : `${snapshot.command}\n\nRequest from the caller:\n${snapshot.input}`);

export interface AgentRunnerDeps { readonly find?: (binary: string) => Promise<string | undefined> }

/**
 * Runs an agent installed on this computer as the program of a task: its non-interactive command inside the Frely sandbox, the task text on
 * stdin. The sandbox is the boundary of the run, so the agent's own approval prompts and sandbox are off. The agent uses its own login and
 * model settings; Frely holds none of them. Workspace: no `workspace` runs in the task folder (a git worktree when the task asks for one);
 * `none` in an empty folder; `read` in a throwaway worktree whose changes are dropped; `worktree` in a worktree whose changes are kept.
 */
export function createAgentRunner(adapter: AgentAdapter, deps: AgentRunnerDeps = {}): Runner {
  const states = new Map<string, RunState>();
  return {
    id: adapter.id,
    nativeModel: true,
    async prepare(context: RunnerContext) {
      const { snapshot, record } = context;
      const binary = await (deps.find ?? findBinary)(adapter.binary);
      if (binary === undefined) throw new Error(`${adapter.title} is not installed on this computer. ${adapter.installHint}`);
      const mode = snapshot.workspace ?? (snapshot.worktree === true ? "worktree" : "direct");
      let workdir = context.cwd;
      let kind: RunState["kind"] = "direct";
      let branch: string | undefined;
      if (mode === "none") {
        workdir = await mkdtemp(join(tmpdir(), "frely-agent-empty-"));
        await git(workdir, ["init", "-q"]);
        await git(workdir, ["commit", "-q", "--allow-empty", "-m", "start"]);
        kind = "scratch";
      } else if (mode === "worktree" || mode === "read") {
        const root = join(tasksDir(), "worktrees");
        await mkdir(root, { recursive: true, mode: 0o700 });
        workdir = join(root, record.runId);
        branch = `frely/${record.runId.slice(0, 8)}`;
        try { await git(context.cwd, ["worktree", "add", "-q", "-b", branch, workdir]); } catch (error) {
          throw new Error(`The task folder ${context.cwd} must be a git repository to run in a worktree (${error instanceof Error ? error.message : String(error)}).`);
        }
        kind = mode === "read" ? "read" : "worktree";
      }
      const outputFile = join(tmpdir(), `frely-agent-${record.runId}.txt`);
      states.set(record.runId, { workdir, kind, outputFile, adapter, source: context.cwd, ...(branch === undefined ? {} : { branch }) });
      const args = adapter.runArguments({ ...(snapshot.model === undefined ? {} : { model: snapshot.model }), outputFile });
      return {
        command: [binary, ...args].map(shellQuote).join(" "),
        cwd: workdir,
        env: taskEnv(workdir, snapshot.env, undefined),
        stdin: promptOf(snapshot),
        patch: kind === "worktree" || kind === "read" ? { worktreePath: workdir, ...(branch === undefined ? {} : { branch }) } : {},
      };
    },
    async finish(context: RunnerContext, exit) {
      const state = states.get(context.record.runId);
      states.delete(context.record.runId);
      if (!state) return {};
      const patch: Partial<TaskRunRecord> = {};
      const fileText = state.adapter.usesOutputFile ? await readFile(state.outputFile, "utf8").catch(() => "") : undefined;
      await rm(state.outputFile, { force: true }).catch(() => undefined);
      const parsed = state.adapter.parseOutput(exit.output, fileText);
      const result: Partial<TaskRunRecord> = { ...patch, answer: parsed.answer };
      if (state.kind === "worktree" || state.kind === "read") {
        try {
          await git(state.workdir, ["add", "-A", "--", ".", ":(exclude).cache"]);
          const diff = await git(state.workdir, ["diff", "--cached", "HEAD"]);
          if (state.kind === "worktree") Object.assign(result, { diffSummary: summarizeDiff(diff) });
        } catch { /* a diff that cannot be read is left out */ }
        if (state.kind === "read") {
          await git(state.source, ["worktree", "remove", "--force", state.workdir]).catch(() => undefined);
          await git(state.source, ["branch", "-D", state.branch ?? ""]).catch(() => undefined);
          Object.assign(result, { worktreePath: undefined, branch: undefined });
        }
      }
      if (state.kind === "scratch") await rm(state.workdir, { recursive: true, force: true }).catch(() => undefined);
      if (exit.code === 0 && parsed.answer === "") Object.assign(result, { error: { code: "no_answer", message: `${state.adapter.title} finished without an answer. See the log with frely result --log.` } });
      return result;
    },
  };
}
