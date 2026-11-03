import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { terminateProcessTree } from "../runtime/process-tree.js";
import { restrictSandboxNetwork, sandboxCommandDetailed, sandboxViolationLines, shutdownSandbox } from "../runtime/sandbox.js";
import { logTail, LOG_LIMIT_BYTES, readTaskRun, runsDir, taskLogPath, writeTaskRun, type TaskRunRecord } from "./run-store.js";
import { openTaskModel, type ModelStats, type OpenedModel } from "./model-route.js";
import { scriptRunner, type Runner, type RunnerContext } from "./runner.js";

/** Runners the worker can run. `pi` is registered by `registerRunner` when the Pi capsule support is present. */
const runners = new Map<string, Runner>([["script", scriptRunner]]);
export function registerRunner(runner: Runner): void { runners.set(runner.id, runner); }

/** What a worker needs beyond the run record. Tests stand in for these. */
export interface WorkerDeps {
  /** Model proxy for runs that have a model; set by the model route (step 2). Returns what the program should call and how to stop it. */
  readonly openModel?: (record: TaskRunRecord, log: (text: string) => void) => Promise<OpenedModel | undefined>;
}

/** The worker side of one run: runs the program in the sandbox, keeps its log, records the end. Saved after every step. */
export async function executeTaskRun(runId: string, signal: AbortSignal = new AbortController().signal, deps: WorkerDeps = { openModel: openTaskModel }): Promise<void> {
  const loaded = await readTaskRun(runId);
  if (loaded === null || (loaded.status !== "running" && loaded.status !== "queued")) return;
  let record = await writeTaskRun({ ...loaded, status: "running", workerPid: process.pid, startedAt: new Date().toISOString() });
  const save = async (patch: Partial<TaskRunRecord>): Promise<void> => { record = await writeTaskRun({ ...record, ...patch }); };
  await mkdir(runsDir(), { recursive: true, mode: 0o700 });
  const logStream = createWriteStream(taskLogPath(runId), { flags: "a", mode: 0o600 });
  let logged = 0;
  let truncated = false;
  const write = (text: string): void => {
    if (truncated) return;
    logged += Buffer.byteLength(text);
    if (logged > LOG_LIMIT_BYTES) { truncated = true; logStream.write("\n[frely] The log reached 8 MiB; the rest of the output is dropped.\n"); return; }
    logStream.write(text);
  };
  const note = (text: string): void => write(`[frely] ${text}\n`);
  let closeModel: (() => Promise<void>) | undefined;
  let modelStats: (() => ModelStats) | undefined;
  try {
    const runner = runners.get(record.snapshot.runner);
    if (!runner) { await save({ status: "failed", endedAt: new Date().toISOString(), error: { code: "runner_unavailable", message: `The ${record.snapshot.runner} runner is not available in this version.` } }); return; }
    let model: RunnerContext["model"];
    let domains: string[] = [...record.snapshot.sites];
    let mitm: { socketPath: string; domains: readonly string[] } | undefined;
    if (record.snapshot.model !== undefined && deps.openModel) {
      const opened = await deps.openModel(record, note);
      if (opened) {
        model = { baseUrl: opened.baseUrl, name: opened.name };
        closeModel = opened.close;
        modelStats = opened.stats;
        domains = [...domains, ...opened.allowedDomains];
        mitm = opened.mitmProxy;
        await save({ modelUsed: opened.name });
      }
    }
    const context: RunnerContext = { record, snapshot: record.snapshot, cwd: record.snapshot.cwd, ...(model ? { model } : {}), log: note };
    const plan = await runner.prepare(context);
    if (plan.patch) await save(plan.patch);
    restrictSandboxNetwork({ allowedDomains: domains, ...(mitm ? { mitmProxy: mitm } : {}) });
    await mkdir(`${plan.cwd}/.cache`, { recursive: true }).catch(() => undefined);
    note(`${record.snapshot.name} started (${record.snapshot.runner}, task folder ${plan.cwd}${domains.length ? `, sites: ${domains.join(", ")}` : ""}).`);
    const wrapped = await sandboxCommandDetailed(plan.command, plan.cwd);
    const child = spawn(wrapped.command, { cwd: plan.cwd, env: plan.env as NodeJS.ProcessEnv, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    child.stdout?.on("data", (data: Buffer) => write(data.toString("utf8")));
    child.stderr?.on("data", (data: Buffer) => write(data.toString("utf8")));
    let timedOut = false;
    const stop = (): void => { void terminateProcessTree(child); };
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => { timedOut = true; note(`Timed out after ${record.snapshot.timeoutSec} seconds; stopping.`); stop(); }, record.snapshot.timeoutSec * 1000);
    const code = await new Promise<number | null>((done) => { child.once("error", (error) => { note(`Could not start: ${error.message}`); done(1); }); child.once("close", (exit) => done(exit)); });
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    const blocked = [...new Set(sandboxViolationLines(wrapped.commandId))].slice(0, 10);
    if (blocked.length > 0) note(`The sandbox blocked:\n${blocked.join("\n")}\nIf a site is missing, add it with frely task add --net <site> and approve it with frely task approve.`);
    await new Promise<void>((done) => logStream.end(done));
    const output = await logTail(runId);
    const extra = runner.finish ? await runner.finish(context, { code, output }).catch((error: unknown) => ({ error: { code: "finish_failed", message: error instanceof Error ? error.message : String(error) } })) : {};
    const status = signal.aborted ? "cancelled" : timedOut ? "timeout" : code === 0 ? "completed" : "failed";
    await save({ ...extra, ...(modelStats ? { modelStats: modelStats() } : {}), status, exitCode: code, endedAt: new Date().toISOString(), ...(blocked.length > 0 ? { blocked } : {}), ...(status === "failed" && !("error" in extra) ? { error: { code: "exit", message: `The program exited with code ${code ?? "unknown"}.` } } : {}) });
  } catch (error) {
    if (!logStream.closed) await new Promise<void>((done) => logStream.end(done));
    await save({ ...(modelStats ? { modelStats: modelStats() } : {}), status: signal.aborted ? "cancelled" : "failed", endedAt: new Date().toISOString(), error: { code: "start_failed", message: error instanceof Error ? error.message : String(error) } });
  } finally {
    await closeModel?.().catch(() => undefined);
    await shutdownSandbox().catch(() => undefined);
  }
}

/** Entry of `frely task __worker <runId>`: cancel on SIGTERM, ignore the terminal hang-up. */
export async function taskWorkerMain(runId: string, deps: WorkerDeps = { openModel: openTaskModel }): Promise<void> {
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGHUP", () => undefined);
  await executeTaskRun(runId, controller.signal, deps);
}
