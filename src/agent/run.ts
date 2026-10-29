import { spawn } from "node:child_process";
import { cliLaunchArguments } from "../cli-launch.js";
import {
  ClientToolsUnsupportedError,
  invokeInstalledAgent,
  openInstalledAgentSession,
  SkillAccessError,
  type InstalledAgentSession,
} from "../skill/access.js";
import type { CallerItem } from "../skill/router.js";
import {
  addUsage,
  createRun,
  effectiveStatus,
  listRuns,
  processAlive,
  readRun,
  resolveRun,
  resumable,
  writeRun,
  type RunRecord,
} from "./run-store.js";
import { READ_TOOLS, WorkspaceReadBridge, type ReadLimits } from "./workspace-read.js";

const MAX_TASK_BYTES = 128 * 1024;
const OVERVIEW_HEADER = "\n\n---\nLocal workspace (read-only file tools are available: read what you need, do not guess). Readable files:\n";

export interface RunDeps {
  openSession(distributionId: string): Promise<InstalledAgentSession>;
  invokePlain(distributionId: string, task: string, signal: AbortSignal): Promise<{ text: string; modelId: string; usage?: Readonly<Record<string, unknown>> }>;
  /** Start the detached worker for a run. */
  spawnWorker(runId: string): void;
  stderr(text: string): void;
  pollMs: number;
}

export const defaultRunDeps: RunDeps = {
  openSession: (distributionId) => openInstalledAgentSession({ distributionId }),
  invokePlain: async (distributionId, task, signal) => {
    const result = await invokeInstalledAgent({ distributionId, task, signal });
    return { text: result.text, modelId: result.modelId, ...("usage" in result && result.usage ? { usage: result.usage } : {}) };
  },
  spawnWorker: (runId) => {
    // Detached, so Ctrl-C, a host command timeout or a killed parent does not stop the call it is waiting for.
    const launch = cliLaunchArguments(process.argv[1] ?? "", ["agent", "__worker", runId]);
    spawn(launch[0]!, launch.slice(1), { detached: true, stdio: "ignore", windowsHide: true, env: process.env }).unref();
  },
  stderr: (text) => { process.stderr.write(text); },
  pollMs: 400,
};

/** Create the run record, start the detached worker and wait for the end. The same call also serves `frely agent result --wait`. */
export async function startRun(input: {
  readonly distributionId: string;
  readonly task: string;
  readonly read?: { readonly root: string; readonly limits: ReadLimits };
}, deps: RunDeps = defaultRunDeps): Promise<RunRecord> {
  if (!input.task.trim() || Buffer.byteLength(input.task, "utf8") > MAX_TASK_BYTES) throw new SkillAccessError("input_invalid", "Agent input must be non-empty and at most 128 KiB.");
  const record = await createRun({
    distributionId: input.distributionId,
    task: input.task,
    ...(input.read === undefined ? {} : { readRoot: input.read.root, limits: input.read.limits }),
  });
  deps.stderr(`Run ${record.runId} started. If this command is cut off the run keeps going: frely agent result ${record.runId} --wait\n`);
  deps.spawnWorker(record.runId);
  return waitForRun(record.runId, deps);
}

/** Poll the local record until the run is no longer running; prints each newly read file to stderr. */
export async function waitForRun(runId: string, deps: Pick<RunDeps, "pollMs" | "stderr"> = defaultRunDeps): Promise<RunRecord> {
  const seen = new Set<string>();
  while (true) {
    const record = await readRun(runId);
    if (record === null) throw new SkillAccessError("remote_call_failed", "The run record is no longer on this computer.");
    for (const file of record.filesRead) {
      if (!seen.has(file.path)) { seen.add(file.path); deps.stderr(`read ${file.path}\n`); }
    }
    if (effectiveStatus(record) !== "running") return { ...record, status: effectiveStatus(record) };
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs));
  }
}

/** A finished run as the foreground command reports it: the result, or the error the call would have thrown. */
export function runOutcome(record: RunRecord): Record<string, unknown> {
  if (record.status === "completed") {
    return {
      ok: true,
      runId: record.runId,
      distributionId: record.distributionId,
      ...(record.modelId === undefined ? {} : { modelId: record.modelId }),
      text: record.text ?? "",
      ...(record.readRoot === undefined ? {} : { filesRead: record.filesRead, rounds: record.rounds.length }),
      ...(record.usage.total_tokens > 0 ? { usage: record.usage } : {}),
      ...(record.toolsUnsupported === true ? { toolsUnsupported: true } : {}),
    };
  }
  throw runFailure(record);
}

export function runFailure(record: RunRecord): SkillAccessError {
  if (record.status === "interrupted") {
    return new SkillAccessError("remote_call_failed", `The run was interrupted before it finished. Run \`frely agent result ${record.runId} --resume --wait\` to continue it; the interrupted round is billed again.`);
  }
  if (record.status === "cancelled") return new SkillAccessError("remote_call_failed", `The run ${record.runId} was cancelled.`);
  const code = (record.error?.code ?? "remote_call_failed") as SkillAccessError["code"];
  return new SkillAccessError(code, record.error?.message ?? "The remote Frely Agent call failed.");
}

/** The state `frely agent result` and `frely agent runs` print for a run (no task text; the result text only when finished). */
export function runSummary(record: RunRecord): Record<string, unknown> {
  const status = effectiveStatus(record);
  return {
    ok: status === "running" || status === "completed",
    runId: record.runId,
    status,
    distributionId: record.distributionId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    rounds: record.rounds.length,
    filesRead: record.filesRead,
    usage: record.usage,
    ...(status === "completed" ? { text: record.text ?? "" } : {}),
    ...(status === "completed" || record.error === undefined ? {} : { error: record.error }),
    resumable: resumable(record),
    ...(status === "running" ? { note: "Still running. Progress so far is listed; run `frely agent result <runId> --wait` to wait for the answer." } : {}),
  };
}

export async function listRunSummaries(): Promise<Record<string, unknown>[]> {
  return (await listRuns()).slice(0, 20).map((record) => {
    const { filesRead, usage, ...rest } = runSummary(record);
    return { ...rest, filesRead: record.filesRead.length, totalTokens: (usage as RunRecord["usage"]).total_tokens };
  });
}

/** Stop a run: ask its worker to abort the call (the server stops and settles what was used), or mark an orphaned record. */
export async function cancelRun(target: string | undefined, deps: Pick<RunDeps, "pollMs"> = defaultRunDeps): Promise<RunRecord> {
  const record = await resolveRun(target);
  if (record.status !== "running") return record;
  if (processAlive(record.workerPid)) {
    try { process.kill(record.workerPid!, "SIGTERM"); } catch { /* it just ended */ }
    for (let waited = 0; waited < 5000; waited += deps.pollMs) {
      await new Promise((resolve) => setTimeout(resolve, deps.pollMs));
      const current = await readRun(record.runId);
      if (current !== null && current.status !== "running") return current;
    }
  }
  const latest = await readRun(record.runId) ?? record;
  if (latest.status !== "running") return latest;
  return writeRun({ ...latest, status: "cancelled" });
}

/** Prepare an interrupted or failed run to continue with the items it already has, and start a worker for it. */
export async function resumeRun(target: string | undefined, deps: RunDeps = defaultRunDeps): Promise<RunRecord> {
  const record = await resolveRun(target);
  if (!resumable(record)) throw new Error(effectiveStatus(record) === "running" ? "This run is still running." : "This run cannot be resumed.");
  const { error: _error, workerPid: _pid, ...rest } = record;
  const next = await writeRun({ ...rest, status: "running", resumeCount: record.resumeCount + 1 });
  deps.stderr(`Resuming run ${record.runId}. The round that was interrupted is billed again.\n`);
  deps.spawnWorker(record.runId);
  return next;
}

/** The worker side: runs the call (and the tool rounds) of one record, saving after every step. */
export async function executeRun(runId: string, deps: RunDeps = defaultRunDeps, signal: AbortSignal = new AbortController().signal): Promise<void> {
  const loaded = await readRun(runId);
  if (loaded === null || loaded.status !== "running") return;
  let record = await writeRun({ ...loaded, workerPid: process.pid });
  const save = async (patch: Partial<RunRecord>): Promise<void> => { record = await writeRun({ ...record, ...patch }); };
  try {
    if (record.readRoot === undefined) {
      const result = await deps.invokePlain(record.distributionId, record.task, signal);
      await save({ status: "completed", modelId: result.modelId, text: result.text });
      return;
    }
    await runWithTools(record, save, () => record, deps, signal);
  } catch (error) {
    if (signal.aborted) { await save({ status: "cancelled" }); return; }
    const code = error instanceof SkillAccessError ? error.code : "remote_call_failed";
    const message = error instanceof SkillAccessError ? error.message : "The remote Frely Agent call failed.";
    await save({ status: "failed", error: { code, message } });
  }
}

async function runWithTools(
  start: RunRecord,
  save: (patch: Partial<RunRecord>) => Promise<void>,
  current: () => RunRecord,
  deps: RunDeps,
  signal: AbortSignal,
): Promise<void> {
  const limits = start.limits;
  if (limits === undefined || start.readRoot === undefined) throw new SkillAccessError("input_invalid", "The run has no workspace.");
  const bridge = await WorkspaceReadBridge.open(start.readRoot, limits);
  bridge.restore({ usedBytes: start.bridge?.usedBytes ?? 0, roundsAnswered: start.bridge?.roundsAnswered ?? 0, filesRead: start.filesRead });
  const task = await withOverview(start.task, bridge);
  const session = await deps.openSession(start.distributionId);
  await save({ modelId: session.modelId });
  const hardCap = limits.maxRounds + 3;
  while (true) {
    if (signal.aborted) throw new Error("aborted");
    const items = [...current().items];
    const pending = unansweredCalls(items);
    if (pending.length > 0) {
      const outputs = await bridge.answerRound(pending);
      for (const output of outputs) items.push({ type: "function_call_output", call_id: output.callId, output: output.output });
      await save({ items, filesRead: bridge.filesRead(), bridge: { usedBytes: bridge.state().usedBytes, roundsAnswered: bridge.state().roundsAnswered } });
    }
    if (current().rounds.length >= hardCap) throw new SkillAccessError("remote_call_failed", "The Agent kept asking for files after the read budget was used up.");
    const startedAt = new Date().toISOString();
    let turn;
    try {
      turn = await session.turn({ task, tools: READ_TOOLS, items, signal });
    } catch (error) {
      if (error instanceof ClientToolsUnsupportedError && current().rounds.length === 0) {
        // The Agent takes no caller tools: do the plain single call, as if --read had not been given.
        const result = await deps.invokePlain(start.distributionId, start.task, signal);
        await save({ status: "completed", modelId: result.modelId, text: result.text, toolsUnsupported: true });
        return;
      }
      throw error;
    }
    const round = {
      n: current().rounds.length + 1,
      ...(turn.requestId === undefined ? {} : { requestId: turn.requestId }),
      startedAt,
      endedAt: new Date().toISOString(),
      toolCalls: turn.status === "tool_calls" ? turn.calls.map((call) => call.name) : [],
      ...(turn.usage === undefined ? {} : { usage: turn.usage }),
    };
    const usage = addUsage(current().usage, turn.usage);
    if (turn.status === "completed") {
      await save({ status: "completed", text: turn.text, rounds: [...current().rounds, round], usage });
      return;
    }
    await save({ rounds: [...current().rounds, round], usage, items: [...items, ...turn.items] as CallerItem[] });
  }
}

function unansweredCalls(items: readonly CallerItem[]): { callId: string; name: string; arguments: string }[] {
  const answered = new Set(items.flatMap((item) => (item.type === "function_call_output" ? [item.call_id] : [])));
  return items.flatMap((item) => (item.type === "function_call" && !answered.has(item.call_id) ? [{ callId: item.call_id, name: item.name, arguments: item.arguments }] : []));
}

/** Task plus the path tree of the readable files, kept inside the 128 KiB input limit. */
async function withOverview(task: string, bridge: WorkspaceReadBridge): Promise<string> {
  const room = MAX_TASK_BYTES - Buffer.byteLength(task, "utf8") - Buffer.byteLength(OVERVIEW_HEADER, "utf8");
  if (room < 256) return task;
  const overview = await bridge.overview(Math.min(8 * 1024, room));
  return overview === "" ? task : `${task}${OVERVIEW_HEADER}${overview}`;
}

/** Entry of `frely agent __worker <runId>`: cancel on SIGTERM, ignore the terminal hang-up. */
export async function workerMain(runId: string, deps: RunDeps = defaultRunDeps): Promise<void> {
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGHUP", () => undefined);
  await executeRun(runId, deps, controller.signal);
}
