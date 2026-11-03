import { join } from "node:path";
import type { TaskRunRecord, TaskRunSnapshot } from "./run-store.js";

/** What the worker passes a runner. */
export interface RunnerContext {
  readonly record: TaskRunRecord;
  readonly snapshot: TaskRunSnapshot;
  /** Where the run works: the task folder, or the worktree a runner made. */
  readonly cwd: string;
  /** The model endpoint the program should call (the model proxy), when the run has a model. */
  readonly model?: { readonly baseUrl: string; readonly name: string };
  readonly log: (text: string) => void;
}

/** What a runner decided to execute inside the sandbox. */
export interface RunnerPlan {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface Runner {
  readonly id: "script" | "pi";
  /** Runs before the sandboxed program starts: set up a worktree, say. */
  prepare(context: RunnerContext): Promise<RunnerPlan & { readonly patch?: Partial<TaskRunRecord> }>;
  /** Runs after it ended: collect the answer and the diff. */
  finish?(context: RunnerContext, exit: { readonly code: number | null; readonly output: string }): Promise<Partial<TaskRunRecord>>;
}

const PASS_THROUGH = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TZ", "TMPDIR", "SystemRoot"] as const;

/**
 * The environment of a task's program. Not the caller's environment: a key or token exported in the shell must not reach it.
 * Package managers get caches inside the task folder, the only place besides the temp folder they may write.
 */
export function taskEnv(cwd: string, extra: Readonly<Record<string, string>>, model: RunnerContext["model"], base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASS_THROUGH) if (base[name] !== undefined) env[name] = base[name]!;
  const cache = join(cwd, ".cache");
  Object.assign(env, { XDG_CACHE_HOME: cache, UV_CACHE_DIR: join(cache, "uv"), PIP_CACHE_DIR: join(cache, "pip"), npm_config_cache: join(cache, "npm"), BUN_INSTALL_CACHE_DIR: join(cache, "bun") });
  Object.assign(env, extra);
  if (model) {
    Object.assign(env, {
      FRELY_MODEL_BASE_URL: model.baseUrl, FRELY_MODEL: model.name,
      OPENAI_BASE_URL: model.baseUrl, OPENAI_API_BASE: model.baseUrl, OPENAI_API_KEY: "frely-local-placeholder",
    });
  }
  return env;
}

export const scriptRunner: Runner = {
  id: "script",
  async prepare(context) {
    return { command: context.snapshot.command, cwd: context.cwd, env: taskEnv(context.cwd, context.snapshot.env, context.model) };
  },
};
