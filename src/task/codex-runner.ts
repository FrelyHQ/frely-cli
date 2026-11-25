import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runner } from "./runner.js";
import { taskEnv } from "./runner.js";

/** Where `codex exec` writes its last message, inside the task folder (the one place the sandbox lets a task write). */
export const CODEX_ANSWER_FILE = ".cache/frely-codex-answer.txt";
const ANSWER_LIMIT = 8 * 1024;

/**
 * Runs the task's command as the prompt of one `codex exec`. It runs inside the Frely sandbox like a script (the sandbox is the boundary,
 * so Codex's own sandbox is turned off: a sandbox inside a sandbox cannot start). The prompt travels in an environment variable, never
 * in the command line, so it needs no shell quoting. Codex uses the login and provider in the user's `~/.codex` (`frely key setup codex`
 * points it at the Frely gateway); Frely holds no credential for it.
 */
export const codexRunner: Runner = {
  id: "codex",
  async prepare(context) {
    const command = `codex exec --skip-git-repo-check --sandbox danger-full-access --color never --output-last-message ${CODEX_ANSWER_FILE} "$FRELY_TASK_PROMPT"`;
    const prompt = context.snapshot.input === undefined ? context.snapshot.command : `${context.snapshot.command}\n\nRequest from the caller:\n${context.snapshot.input}`;
    return { command, cwd: context.cwd, env: taskEnv(context.cwd, { ...context.snapshot.env, FRELY_TASK_PROMPT: prompt }, undefined) };
  },
  async finish(context, exit) {
    const answer = await readFile(join(context.cwd, CODEX_ANSWER_FILE), "utf8").then((text) => text.trim().slice(0, ANSWER_LIMIT), () => "");
    if (exit.code !== 0 && /not found|ENOENT/u.test(exit.output)) return { error: { code: "codex_unavailable", message: "Codex is not installed or not on PATH. Install it and run `frely key setup codex`." } };
    return answer === "" ? {} : { answer };
  },
};
