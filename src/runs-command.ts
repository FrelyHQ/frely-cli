import { ControllerError, EXIT } from "./controller/client.js";
import { cancelRun, listRunSummaries, resumeRun, runSummary, waitForRun } from "./agent/run.js";
import { effectiveStatus, isRunId, listRuns, readRun, resolveRun } from "./agent/run-store.js";
import { taskRunRecordCommand, type TaskIo } from "./task/command.js";
import { isTaskRunId, listTaskRuns, readTaskRun } from "./task/run-store.js";

export const RUNS_USAGE = `Runs on this computer: item calls (frely item call) and task runs (frely task start, schedules, remote calls).
  frely runs [<task name>] [--json]                                 Newest first, both kinds
  frely result [<runId>|--last] [--wait [--wait-sec <n>]] [--resume] [--log [--lines <n>] [--follow]] [--json]
  frely cancel [<runId>|--last] [--json]
--resume continues an interrupted item call; --log shows what a task run printed.
`;

type Kind = "item" | "task";

const FLAGS_WITH_VALUE = new Set(["--wait-sec", "--lines"]);
function positional(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("-")) { if (FLAGS_WITH_VALUE.has(arg)) index += 1; continue; }
    out.push(arg);
  }
  return out;
}

/** Which store holds this run. Both use UUIDs in separate folders; --last is the newest run of either kind. */
async function kindOf(target: string | undefined): Promise<Kind> {
  if (target === undefined || target === "--last") {
    const [item] = await listRuns();
    const [task] = await listTaskRuns();
    if (!item && !task) throw new Error("There are no runs on this computer.");
    if (!task) return "item";
    if (!item) return "task";
    return item.createdAt >= task.createdAt ? "item" : "task";
  }
  if (isRunId(target) && await readRun(target) !== null) return "item";
  if (isTaskRunId(target) && await readTaskRun(target) !== null) return "task";
  throw new Error("This run is not on this computer. Use a run id from `frely runs`, or --last.");
}

/** `frely runs|result|cancel`: one set of commands for every run recorded on this computer. */
export async function runRecordCommand(action: "runs" | "result" | "cancel", args: string[], io: TaskIo): Promise<number> {
  try {
    if (args.includes("--help") || args.includes("-h")) { io.out(RUNS_USAGE); return EXIT.ok; }
    const json = args.includes("--json");
    if (action === "runs") {
      const name = positional(args)[0];
      const items = name === undefined ? await listRunSummaries() : [];
      const tasks = (await listTaskRuns()).filter((record) => name === undefined || record.snapshot.name === name).slice(0, 20);
      const rows = [
        ...items.map((run) => ({ kind: "item" as const, runId: String(run.runId), status: String(run.status), name: String(run.distributionId), createdAt: String(run.createdAt), run })),
        ...tasks.map((record) => ({ kind: "task" as const, runId: record.runId, status: record.status, name: record.snapshot.name, createdAt: record.createdAt, run: null })),
      ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      if (json) { io.out(`${JSON.stringify({ ok: true, runs: rows.map(({ run, ...row }) => ({ ...row, ...(run ?? {}) })) })}\n`); return EXIT.ok; }
      io.out(rows.length === 0 ? "No runs on this computer.\n" : rows.map((row) => `${row.runId}  ${row.kind}  ${row.status}  ${row.name}  ${row.createdAt}\n`).join(""));
      return EXIT.ok;
    }
    const target = positional(args)[0] ?? (args.includes("--last") ? "--last" : undefined);
    const kind = await kindOf(target);
    if (kind === "task") {
      const rest = target === undefined || target === "--last" ? args.filter((arg) => arg !== "--last") : args;
      return await taskRunRecordCommand(action, [...rest], io);
    }
    const runArg = target === "--last" ? undefined : target;
    let record = action === "cancel" ? await cancelRun(runArg) : await resolveRun(runArg);
    if (action === "result") {
      if (args.includes("--resume")) {
        if (effectiveStatus(record) !== "running") { await resumeRun(record.runId); record = (await readRun(record.runId)) ?? record; }
      }
      if (args.includes("--wait")) record = await waitForRun(record.runId);
    }
    const summary = runSummary(record);
    if (json) io.out(`${JSON.stringify(summary)}\n`);
    else io.out(summary.status === "completed" ? `${summary.text as string}\n` : `${JSON.stringify(summary, null, 2)}\n`);
    return action === "result" && summary.ok === false ? EXIT.tool : EXIT.ok;
  } catch (error) {
    if (error instanceof ControllerError) { io.err(`${error.message}\n`); return error.exitCode; }
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.cli;
  }
}
