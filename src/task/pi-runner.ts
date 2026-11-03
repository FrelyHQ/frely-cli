import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readAnyInstall } from "../agent/capsule-install.js";
import type { AppInstall } from "../agent/app-install.js";
import type { Runner, RunnerContext } from "./runner.js";
import type { TaskRunRecord } from "./run-store.js";

const POLL_MS = 2_000;
const DONE = new Set(["completed", "failed", "cancelled", "waiting_input"]);

interface Endpoint { readonly url: string; readonly token: string }
export interface PiRunnerDeps {
  readonly install?: () => Promise<AppInstall>;
  readonly fetchFn?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

async function readEndpoint(install: AppInstall): Promise<Endpoint | null> {
  try {
    const value = JSON.parse(await readFile(join(install.agentDir, "frely", "headless.json"), "utf8")) as Record<string, unknown>;
    return value.schemaVersion === 1 && typeof value.url === "string" && typeof value.token === "string" ? { url: value.url, token: value.token } : null;
  } catch { return null; }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return fallback; }
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

async function call(endpoint: Endpoint, fetchFn: typeof fetch, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetchFn(endpoint.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  if (!response.ok) throw new Error(`The Pi Node answered ${response.status}.`);
  const result = ((await response.json()) as { result?: { content?: Array<{ text?: string }>; isError?: boolean } }).result;
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) throw new Error(text || "The Pi Node refused the request.");
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Runs the task's command as the prompt of one Pi Node thread. The thread works in its own git worktree of the task folder
 * (the Pi Node makes it; nothing is committed to the main branch or pushed). The result is the thread's last answer plus a diff summary.
 * Model calls go through the run's loopback model endpoint, registered as a one-run provider in the Pi Node's `models.json`.
 */
export function createPiRunner(deps: PiRunnerDeps = {}): Runner {
  return {
    id: "pi",
    loopbackModel: true,
    async prepare() { throw new Error("The pi runner does not run a command."); },
    async execute(context: RunnerContext, signal: AbortSignal) {
      const { snapshot } = context;
      const install = await (deps.install ?? (() => readAnyInstall()))().catch(() => null);
      const endpoint = install ? await readEndpoint(install) : null;
      if (!install || !endpoint) return { code: 1, patch: { error: { code: "pi_unavailable", message: "The Pi Node is not running. Install it with `frely pi install` and keep the background service on (`frely link on`)." } } };
      const fetchFn = deps.fetchFn ?? fetch;
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      const project = snapshot.cwd;

      const projects = await readJson<string[]>(install.projectsFile, []);
      const addedProject = !projects.includes(project);
      if (addedProject) await atomicJson(install.projectsFile, [...projects, project]);
      const modelsFile = join(install.agentDir, "models.json");
      const providerId = `frely-${context.record.runId.replace(/[^a-zA-Z0-9]/gu, "").slice(-8).toLowerCase()}`;
      let model: string | undefined;
      if (context.model) {
        const models = await readJson<{ providers?: Record<string, unknown> }>(modelsFile, {});
        await atomicJson(modelsFile, { ...models, providers: { ...(models.providers ?? {}), [providerId]: { baseUrl: context.model.baseUrl, api: "openai-completions", apiKey: "frely-local-placeholder", models: [{ id: context.model.name }] } } });
        model = `${providerId}/${context.model.name}`;
      }
      try {
        const created = await call(endpoint, fetchFn, "create_thread", { project, goal: snapshot.command, title: snapshot.name, ...(model ? { model } : {}) });
        const threadId = String(created.id);
        context.log(`Pi thread ${threadId} started${model ? ` with ${context.model!.name}` : ""}.`);
        const deadline = Date.now() + snapshot.timeoutSec * 1000;
        for (;;) {
          if (signal.aborted) return { code: 1, patch: { error: { code: "cancelled", message: "Cancelled; the Pi thread may still be running in the Pi Node." } } };
          if (Date.now() > deadline) return { code: 1, patch: { error: { code: "timeout", message: `Timed out after ${snapshot.timeoutSec} seconds; the Pi thread may still be running in the Pi Node.` } } };
          const shown = await call(endpoint, fetchFn, "get_thread", { project, threadId });
          if (DONE.has(String(shown.status))) {
            const patch: Partial<TaskRunRecord> = { answer: String(shown.answer ?? ""), diffSummary: summarizeDiff(String(shown.diff ?? "")) };
            if (shown.status === "failed" || shown.status === "cancelled") return { code: 1, patch: { ...patch, error: { code: "thread_" + String(shown.status), message: String(shown.error ?? `The Pi thread ${String(shown.status)}.`) } } };
            return { code: 0, patch };
          }
          await sleep(POLL_MS);
        }
      } finally {
        if (addedProject) await atomicJson(install.projectsFile, projects).catch(() => undefined);
        if (context.model) {
          const models = await readJson<{ providers?: Record<string, unknown> }>(modelsFile, {});
          const { [providerId]: _gone, ...rest } = models.providers ?? {};
          await atomicJson(modelsFile, { ...models, providers: rest }).catch(() => undefined);
        }
      }
    },
  };
}
