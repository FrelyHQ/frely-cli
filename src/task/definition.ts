import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isValidTimezone, nextCronTime, parseCron } from "./cron.js";

/**
 * Runners: `script` runs a shell command in the sandbox. `pi` runs a prompt through the Pi agent (added with the Pi capsule).
 * Both get their model through the model proxy; neither holds a credential.
 */
export const RUNNERS = ["script", "pi"] as const;
export type RunnerId = (typeof RUNNERS)[number];

export const TASK_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
export const MAX_COMMAND_BYTES = 16 * 1024;
export const DEFAULT_TIMEOUT_SEC = 3600;
export const MAX_TIMEOUT_SEC = 24 * 3600;

export interface TaskSchedule {
  readonly cron: string;
  readonly timezone: string;
  readonly enabled: boolean;
  /** When the schedule was last saved: missed runs are counted from here. */
  readonly since: string;
}

/**
 * A task definition: the name, what runs, where, with what reach. Everything that decides what the task can do is in `hash`, so a change
 * is visible (and, for a shared task, forces a new approval). The schedule and the approvals are not part of the hash.
 */
export interface TaskDefinition {
  readonly version: 1;
  readonly name: string;
  readonly runner: RunnerId;
  /** `script`: the shell command. `pi`: the prompt. */
  readonly command: string;
  /** Absolute folder: the working directory, and the only place the task can write besides the temp folder. */
  readonly cwd: string;
  /** Extra sites the task may reach, asked for through a device approval. */
  readonly network: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutSec: number;
  /** Frely model name for runners that use a model; the model proxy picks the local or gateway endpoint (see src/task/model-route.ts). */
  readonly model?: string;
  /** Models tried in order when the first cannot be started (unreachable, unknown model, authentication error). */
  readonly fallbackModels?: readonly string[];
  /** Run in a fresh git worktree of `cwd` (pi). */
  readonly worktree?: boolean;
  readonly schedule?: TaskSchedule;
  /** Approved site -> end of the approval (ISO). */
  readonly approvals: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly hash: string;
}

export interface TaskDefinitionInput {
  readonly name: string;
  readonly runner?: RunnerId;
  readonly command: string;
  readonly cwd: string;
  readonly network?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutSec?: number;
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
  readonly worktree?: boolean;
}

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/u;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;
/** Names a definition cannot set: the sandbox and the model proxy set these. */
const RESERVED_ENV = /^(PATH|HOME|OPENAI_.*|ANTHROPIC_.*|FRELY_.*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|LD_.*|DYLD_.*|NODE_OPTIONS|BUN_OPTIONS)$/u;

export function taskHash(definition: Pick<TaskDefinition, "runner" | "command" | "cwd" | "network" | "env" | "timeoutSec" | "model" | "fallbackModels" | "worktree">): string {
  const canonical = JSON.stringify({
    runner: definition.runner, command: definition.command, cwd: definition.cwd, network: [...definition.network].sort(),
    env: Object.fromEntries(Object.entries(definition.env).sort(([a], [b]) => a.localeCompare(b))), timeoutSec: definition.timeoutSec,
    model: definition.model ?? null, fallbackModels: definition.fallbackModels ?? [], worktree: definition.worktree ?? false,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function buildDefinition(input: TaskDefinitionInput, previous?: TaskDefinition, now = new Date()): TaskDefinition {
  if (!TASK_NAME.test(input.name)) throw new Error("A task name is lower-case letters, digits and dashes (at most 63).");
  const runner = input.runner ?? "script";
  if (!RUNNERS.includes(runner)) throw new Error(`Unknown runner ${JSON.stringify(runner)}. Use ${RUNNERS.join(" or ")}.`);
  const command = input.command.trim();
  if (command === "" || Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) throw new Error(`A task needs a ${runner === "pi" ? "prompt" : "command"} of at most 16 KiB.`);
  if (!isAbsolute(input.cwd)) throw new Error("The task folder must be an absolute path.");
  const network = [...new Set((input.network ?? []).map((host) => host.trim().toLowerCase()))];
  for (const host of network) if (!HOST.test(host) || host === "*") throw new Error(`Invalid site ${JSON.stringify(host)}. Use a host name such as registry.npmjs.org.`);
  const env = { ...(input.env ?? {}) };
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_NAME.test(key) || RESERVED_ENV.test(key)) throw new Error(`Environment name ${JSON.stringify(key)} is not allowed.`);
    if (typeof value !== "string" || /[\0]/u.test(value) || Buffer.byteLength(value, "utf8") > 4096) throw new Error(`Environment value of ${key} is invalid.`);
  }
  const timeoutSec = input.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_TIMEOUT_SEC) throw new Error(`The timeout must be 1 to ${MAX_TIMEOUT_SEC} seconds.`);
  const stamp = now.toISOString();
  const core = {
    runner, command, cwd: input.cwd, network, env, timeoutSec,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.fallbackModels === undefined || input.fallbackModels.length === 0 ? {} : { fallbackModels: [...input.fallbackModels] }),
    ...(input.worktree === true ? { worktree: true } : {}),
  };
  const hash = taskHash(core);
  // Approvals follow the sites: a site that stays keeps its approval.
  const approvals = Object.fromEntries(Object.entries(previous?.approvals ?? {}).filter(([host]) => network.includes(host)));
  return {
    version: 1, name: input.name, ...core, approvals, ...(previous?.schedule ? { schedule: previous.schedule } : {}),
    createdAt: previous?.createdAt ?? stamp, updatedAt: stamp, hash,
  };
}

export function buildSchedule(cron: string, timezone: string | undefined, now = new Date()): TaskSchedule {
  const zone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  if (!isValidTimezone(zone)) throw new Error(`Unknown time zone ${JSON.stringify(zone)}. Use an IANA name such as Asia/Shanghai or UTC.`);
  const spec = parseCron(cron);
  if (nextCronTime(spec, zone, now.getTime()) === undefined) throw new Error("This schedule never runs.");
  return { cron: cron.trim().replace(/\s+/gu, " "), timezone: zone, enabled: true, since: now.toISOString() };
}

export function approvedSites(definition: Pick<TaskDefinition, "network" | "approvals">, now = Date.now()): string[] {
  return definition.network.filter((host) => { const end = definition.approvals[host]; return end !== undefined && Date.parse(end) > now; });
}

const configRoot = (): string => process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
/** Definitions, run records, logs: `~/.config/frely/tasks`. Outside every task's folder, so a task cannot edit its own definition. */
export const tasksDir = (): string => join(configRoot(), "frely", "tasks");
const definitionsPath = (): string => join(tasksDir(), "definitions.json");

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(tasksDir(), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => undefined);
}

export async function listDefinitions(): Promise<TaskDefinition[]> {
  const raw = await readFile(definitionsPath(), "utf8").catch(() => null);
  if (raw === null) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("The task definitions file is not valid JSON."); }
  const list = (value as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(list)) throw new Error("The task definitions file is not valid.");
  return (list as TaskDefinition[]).filter((item) => item && item.version === 1 && TASK_NAME.test(item.name)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getDefinition(name: string): Promise<TaskDefinition | undefined> {
  return (await listDefinitions()).find((item) => item.name === name);
}

let queue: Promise<unknown> = Promise.resolve();
/** Read-modify-write one at a time inside this process, so two commands in the daemon cannot lose each other's change. */
export function updateDefinitions(change: (current: TaskDefinition[]) => TaskDefinition[]): Promise<TaskDefinition[]> {
  const run = queue.then(async () => {
    const next = change(await listDefinitions());
    await writeJson(definitionsPath(), { version: 1, tasks: next });
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}

export async function saveDefinition(definition: TaskDefinition): Promise<void> {
  await updateDefinitions((current) => [...current.filter((item) => item.name !== definition.name), definition]);
}

export async function removeDefinition(name: string): Promise<boolean> {
  let removed = false;
  await updateDefinitions((current) => current.filter((item) => { if (item.name === name) removed = true; return item.name !== name; }));
  return removed;
}

export { writeJson as writeTaskJson };
