import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { approveSites, type ApprovalDeps } from "../agent/local/approvals.js";
import { ControllerError, EXIT } from "../controller/client.js";
import { buildDefinition, buildSchedule, getDefinition, listDefinitions, removeDefinition, saveDefinition, updateDefinitions, type TaskDefinition } from "./definition.js";
import { approvedSites } from "./definition.js";
import { cancelTaskRun, defaultManagerDeps, describeRun, startTask, TaskError, waitForTaskRun, type ManagerDeps } from "./manager.js";
import { effectiveTaskStatus, listTaskRuns, resolveTaskRun, taskLogPath } from "./run-store.js";
import { nextCronTime, parseCron } from "./cron.js";

export interface TaskIo {
  out(text: string): void;
  err(text: string): void;
  interactive: boolean;
}

export const TASK_USAGE = `Usage:
  frely task add <name> [--cwd <dir>] [--net <site>]... [--env K=V]... [--timeout <seconds>] [--model <name> [--fallback-model <name>]...] [--cron "<m h dom mon dow>" [--tz <zone>]] [--replace] [--pi] -- <command...>
  frely task list [--json]
  frely task show <name> [--json]
  frely task remove <name>
  frely task schedule <name> (--cron "<m h dom mon dow>" [--tz <zone>] | --pause | --resume | --clear)
  frely task approve <name>
  frely task start <name> [--wait [--wait-sec <n>]] [--json]
  frely task status [<runId>|--last] [--json]
  frely task result [<runId>|--last] [--wait [--wait-sec <n>]] [--json]
  frely task cancel [<runId>|--last]
  frely task runs [<name>] [--json]
  frely task logs [<runId>|--last] [--lines <n>] [--follow]
`;

const fail = (message: string, code: number = EXIT.cli): never => { throw new ControllerError(message, code); };
const has = (args: readonly string[], name: string): boolean => args.includes(name);

function values(args: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) fail(`${name} needs a value.`);
    out.push(next!);
  }
  return out;
}
const value = (args: readonly string[], name: string): string | undefined => values(args, name).at(-1);

const FLAGS_WITH_VALUE = new Set(["--cwd", "--net", "--env", "--timeout", "--cron", "--tz", "--wait-sec", "--lines", "--task", "--model", "--fallback-model"]);
function positional(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("--")) { if (FLAGS_WITH_VALUE.has(arg)) index += 1; continue; }
    out.push(arg);
  }
  return out;
}

const shellQuote = (text: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`);

function parseEnv(items: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const item of items) {
    const at = item.indexOf("=");
    if (at < 1) fail(`--env needs NAME=value, got ${JSON.stringify(item)}.`);
    env[item.slice(0, at)] = item.slice(at + 1);
  }
  return env;
}

function waitMs(args: readonly string[]): number {
  const seconds = value(args, "--wait-sec");
  if (seconds === undefined) return 100_000;
  const parsed = Number(seconds);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) return fail("--wait-sec must be 0 to 100.");
  return parsed * 1000;
}

/** Runs `frely task ...`; returns the exit code. */
export async function runTaskCommand(args: readonly string[], io: TaskIo, deps: { manager?: ManagerDeps; approval?: ApprovalDeps } = {}): Promise<number> {
  try {
    const [action, ...rest] = args;
    switch (action) {
      case "add": return await add(rest, io);
      case "list": return await list(rest, io);
      case "show": return await show(rest, io);
      case "remove": return await remove(rest, io);
      case "schedule": return await schedule(rest, io);
      case "approve": return await approve(rest, io, deps.approval);
      case "start": return await start(rest, io, deps);
      case "status": return await status(rest, io, false);
      case "result": return await status(rest, io, true);
      case "cancel": return await cancel(rest, io);
      case "runs": return await runs(rest, io);
      case "logs": return await logs(rest, io);
      default: io.out(TASK_USAGE); return action === undefined || action === "help" || action === "--help" ? EXIT.ok : EXIT.cli;
    }
  } catch (error) {
    if (error instanceof ControllerError) { io.err(`${error.message}\n`); return error.exitCode; }
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof TaskError && error.code === "busy" ? EXIT.tool : EXIT.cli;
  }
}

async function requireDefinition(name: string | undefined): Promise<TaskDefinition> {
  if (!name) return fail(TASK_USAGE);
  return (await getDefinition(name)) ?? fail(`No task named ${name}. See frely task list.`);
}

async function add(args: string[], io: TaskIo): Promise<number> {
  const split = args.indexOf("--");
  const options = split < 0 ? args : args.slice(0, split);
  const commandWords = split < 0 ? [] : args.slice(split + 1);
  const [name] = positional(options);
  if (!name || commandWords.length === 0) return fail(TASK_USAGE);
  const cwd = resolve(value(options, "--cwd") ?? process.cwd());
  if (!(await stat(cwd).then((info) => info.isDirectory(), () => false))) return fail(`The task folder ${cwd} does not exist.`);
  const previous = await getDefinition(name);
  if (previous && !has(options, "--replace")) return fail(`A task named ${name} exists. Use --replace to change it (a changed task needs its sites approved again).`);
  const timeout = value(options, "--timeout");
  const command = commandWords.length === 1 ? commandWords[0]! : commandWords.map(shellQuote).join(" ");
  const model = value(options, "--model");
  const fallbacks = values(options, "--fallback-model");
  if (fallbacks.length > 0 && model === undefined) return fail("--fallback-model needs --model.");
  let definition = buildDefinition({
    name, command, cwd, network: values(options, "--net"), ...(has(options, "--pi") ? { runner: "pi" as const, worktree: true } : {}), env: parseEnv(values(options, "--env")),
    ...(timeout === undefined ? {} : { timeoutSec: Number(timeout) }),
    ...(model === undefined ? {} : { model }), ...(fallbacks.length > 0 ? { fallbackModels: fallbacks } : {}),
  }, previous);
  const cron = value(options, "--cron");
  if (cron !== undefined) { const zone = value(options, "--tz"); definition = { ...definition, schedule: buildSchedule(cron, zone) }; }
  await saveDefinition(definition);
  io.out(`${previous ? "Updated" : "Added"} task ${name}.\n  runs: ${definition.command}\n  folder: ${definition.cwd} (the only place it can write besides the temp folder)\n`);
  if (definition.model) io.out(`  model: ${definition.model}${definition.fallbackModels?.length ? ` (if it cannot be started: ${definition.fallbackModels.join(", ")})` : ""}. The program calls $OPENAI_BASE_URL with any key; Frely adds the real one.\n`);
  io.out(`  can reach: ${definition.network.length ? `${definition.network.join(", ")} after your approval (frely task approve ${name})` : "nothing outside this computer"}\n`);
  if (definition.schedule) io.out(`  schedule: ${definition.schedule.cron} (${definition.schedule.timezone}). The background service starts it; run frely link on if it is not running.\n`);
  io.out(`Start it with: frely task start ${name}\n`);
  return EXIT.ok;
}

function scheduleText(definition: TaskDefinition): string {
  const item = definition.schedule;
  if (!item) return "none";
  const next = nextCronTime(parseCron(item.cron), item.timezone, Date.now());
  return `${item.cron} (${item.timezone})${item.enabled ? `, next ${next === undefined ? "never" : new Date(next).toISOString()}` : ", paused"}`;
}

async function list(args: string[], io: TaskIo): Promise<number> {
  const definitions = await listDefinitions();
  if (has(args, "--json")) {
    io.out(`${JSON.stringify({ tasks: definitions.map((item) => ({ name: item.name, runner: item.runner, command: item.command, cwd: item.cwd, network: item.network, approved: approvedSites(item), timeoutSec: item.timeoutSec, schedule: item.schedule ?? null, hash: item.hash })) }, null, 2)}\n`);
    return EXIT.ok;
  }
  if (definitions.length === 0) { io.out("No tasks. Add one with frely task add <name> -- <command>.\n"); return EXIT.ok; }
  io.out(definitions.map((item) => `${item.name}\t${item.runner}\t${scheduleText(item)}\t${item.cwd}`).join("\n") + "\n");
  return EXIT.ok;
}

async function show(args: string[], io: TaskIo): Promise<number> {
  const definition = await requireDefinition(positional(args)[0]);
  if (has(args, "--json")) { io.out(`${JSON.stringify({ ...definition, approved: approvedSites(definition) }, null, 2)}\n`); return EXIT.ok; }
  io.out(`${definition.name} (${definition.runner})${definition.model ? `\n  model: ${definition.model}${definition.fallbackModels?.length ? ` -> ${definition.fallbackModels.join(" -> ")}` : ""}` : ""}\n  runs: ${definition.command}\n  folder: ${definition.cwd}\n  timeout: ${definition.timeoutSec}s\n  sites: ${definition.network.join(", ") || "none"}${definition.network.length ? ` (approved now: ${approvedSites(definition).join(", ") || "none"})` : ""}\n  schedule: ${scheduleText(definition)}\n  definition hash: ${definition.hash.slice(0, 16)}\n`);
  return EXIT.ok;
}

async function remove(args: string[], io: TaskIo): Promise<number> {
  const [name] = positional(args);
  if (!name) return fail(TASK_USAGE);
  if (!(await removeDefinition(name))) return fail(`No task named ${name}.`);
  io.out(`Removed task ${name}. Its past runs stay for 14 days.\n`);
  return EXIT.ok;
}

async function schedule(args: string[], io: TaskIo): Promise<number> {
  const [name] = positional(args);
  const definition = await requireDefinition(name);
  const cron = value(args, "--cron");
  let next: TaskDefinition;
  if (has(args, "--clear")) { const { schedule: _gone, ...rest } = definition; next = rest as TaskDefinition; }
  else if (has(args, "--pause") || has(args, "--resume")) {
    if (!definition.schedule) return fail(`${definition.name} has no schedule.`);
    next = { ...definition, schedule: { ...definition.schedule, enabled: has(args, "--resume"), ...(has(args, "--resume") ? { since: new Date().toISOString() } : {}) } };
  } else if (cron !== undefined) next = { ...definition, schedule: buildSchedule(cron, value(args, "--tz")) };
  else return fail(TASK_USAGE);
  await updateDefinitions((current) => current.map((item) => (item.name === next.name ? { ...next, updatedAt: new Date().toISOString() } : item)));
  io.out(`${next.name}: schedule ${scheduleText(next)}.\n`);
  return EXIT.ok;
}

async function approve(args: string[], io: TaskIo, deps: ApprovalDeps = {}): Promise<number> {
  const definition = await requireDefinition(positional(args)[0]);
  if (definition.network.length === 0) { io.out(`${definition.name} asks for no sites.\n`); return EXIT.ok; }
  const gained = await approveSites({
    slug: definition.name, network: [...definition.network], approvals: { ...definition.approvals }, who: `The task ${definition.name}`,
    why: (host) => `The task ${definition.name} (${definition.command.slice(0, 120)}) needs to reach ${host}.`, command: `frely task approve ${definition.name}`,
  }, io, deps);
  if (Object.keys(gained).length > 0) {
    await updateDefinitions((current) => current.map((item) => (item.name === definition.name ? { ...item, approvals: { ...item.approvals, ...gained } } : item)));
  }
  const latest = await requireDefinition(definition.name);
  io.out(`Approved now: ${approvedSites(latest).join(", ") || "none"}. A schedule uses only the sites approved when it fires.\n`);
  return EXIT.ok;
}

async function start(args: string[], io: TaskIo, deps: { manager?: ManagerDeps; approval?: ApprovalDeps }): Promise<number> {
  const definition = await requireDefinition(positional(args)[0]);
  if (io.interactive && definition.network.some((host) => !approvedSites(definition).includes(host))) await approve([definition.name], io, deps.approval);
  const record = await startTask(definition.name, { trigger: "manual" }, deps.manager ?? defaultManagerDeps);
  io.err(`Run ${record.runId} started. It keeps going if this command is cut off: frely task result ${record.runId} --wait\n`);
  if (!has(args, "--wait")) { io.out(`${JSON.stringify(await describeRun(record), null, has(args, "--json") ? undefined : 2)}\n`); return EXIT.ok; }
  return printRun(await waitForTaskRun(record.runId, waitMs(args)), io, args, true);
}

async function printRun(record: Awaited<ReturnType<typeof resolveTaskRun>>, io: TaskIo, args: readonly string[], tail: boolean): Promise<number> {
  const described = await describeRun(record, { tail });
  io.out(`${JSON.stringify(described, null, has(args, "--json") ? undefined : 2)}\n`);
  const status = effectiveTaskStatus(record);
  return status === "running" || status === "queued" || status === "completed" || status === "skipped" ? EXIT.ok : EXIT.tool;
}

async function status(args: string[], io: TaskIo, withResult: boolean): Promise<number> {
  const target = positional(args)[0];
  let record = await resolveTaskRun(target ?? "--last", value(args, "--task"));
  if (has(args, "--wait")) record = await waitForTaskRun(record.runId, waitMs(args));
  return printRun(record, io, args, withResult);
}

async function cancel(args: string[], io: TaskIo): Promise<number> {
  const record = await cancelTaskRun(positional(args)[0] ?? "--last");
  io.out(`${record.snapshot.name} run ${record.runId}: ${effectiveTaskStatus(record)}.\n`);
  return EXIT.ok;
}

async function runs(args: string[], io: TaskIo): Promise<number> {
  const name = positional(args)[0];
  const records = (await listTaskRuns()).filter((record) => name === undefined || record.snapshot.name === name).slice(0, 20);
  if (has(args, "--json")) { io.out(`${JSON.stringify({ runs: await Promise.all(records.map((record) => describeRun(record))) }, null, 2)}\n`); return EXIT.ok; }
  if (records.length === 0) { io.out("No runs.\n"); return EXIT.ok; }
  io.out(records.map((record) => `${record.runId}\t${record.snapshot.name}\t${effectiveTaskStatus(record)}\t${record.trigger}\t${record.createdAt}`).join("\n") + "\n");
  return EXIT.ok;
}

async function logs(args: string[], io: TaskIo): Promise<number> {
  const record = await resolveTaskRun(positional(args)[0] ?? "--last", value(args, "--task"));
  const lines = Number(value(args, "--lines") ?? 100);
  if (!Number.isInteger(lines) || lines < 1 || lines > 10_000) return fail("--lines must be 1 to 10000.");
  const text = await readFile(taskLogPath(record.runId), "utf8").catch(() => "");
  io.out(text.split("\n").slice(-lines - 1).join("\n"));
  if (!has(args, "--follow")) return EXIT.ok;
  let offset = Buffer.byteLength(text);
  for (;;) {
    await new Promise((done) => setTimeout(done, 1000));
    const data = await readFile(taskLogPath(record.runId)).catch(() => Buffer.alloc(0));
    if (data.length > offset) { io.out(data.subarray(offset).toString("utf8")); offset = data.length; }
    const current = await resolveTaskRun(record.runId);
    const state = effectiveTaskStatus(current);
    if (state !== "running" && state !== "queued" && data.length <= offset) return EXIT.ok;
  }
}

