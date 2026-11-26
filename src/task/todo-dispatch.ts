import { createHash } from "node:crypto";
import { defaultAgentId, isAgentId } from "../agents/registry.js";
import type { AgentId } from "../agents/types.js";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { observeIdentity } from "../trust/observe.js";
import { trustDirectory, type SignedApproval } from "../trust/record.js";
import { readTrustOrRefresh, type TrustRefresh } from "../trust/sync.js";
import { refreshAccountTrust } from "../device/control.js";
import { insideWorkspace } from "../trust/todo-scope.js";
import { authorizeTodoCheck, authorizeTodoStep, hashStepFiles, MAX_SCRIPT_FILES, SCRIPT_EXECUTOR } from "../trust/todo-scope.js";
import { NO_TRUST_MESSAGE, TrustError } from "../trust/webauthn.js";
import { buildDefinition, removeDefinition, saveDefinition } from "./definition.js";
import { cancelTaskRun, defaultManagerDeps, describeRun, startTask, waitForTaskRun, type ManagerDeps } from "./manager.js";
import { readTaskRun } from "./run-store.js";

/** A condition script may run this long; longer counts as not met. */
export const TODO_CHECK_TIMEOUT_SEC = 30;

/**
 * The relay's way to run one todo step on this computer, as a hidden tool like `workspace_manage`: never listed, only relays call it,
 * and `start` runs only under an Owner passkey `todo_scope` approval this device verifies itself (src/trust/todo-scope.ts). A run is
 * named by the relay's own run key, so a retried `start` returns the same run and `status` / `cancel` find it again after a reconnect.
 */
export const TODO_DISPATCH_TOOL = "task_dispatch";
export const TODO_SCOPE_META_KEY = "frely/todo-scope";
const RUN_KEY = /^[A-Za-z0-9_-]{8,128}$/u;
const MAX_INSTRUCTION_BYTES = 16 * 1024;
const MAX_STEP_SECONDS = 3600;
const ANSWER_LIMIT = 4000;

interface RunMap { [runKey: string]: { runId: string; task: string } }

export interface TodoDispatchDeps extends ManagerDeps { /** Tests shorten how long a check is waited for. */ checkWaitMs?: number; now?: () => number; refreshTrust?: TrustRefresh; defaultAgent?: () => Promise<AgentId> }

const text = (args: Record<string, unknown>, name: string, max = 4096): string => {
  const value = args[name];
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > max) throw new Error(`${name} is required.`);
  return value;
};

let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(work: () => Promise<T>): Promise<T> => { const run = queue.then(work); queue = run.catch(() => undefined); return run; };

async function readRuns(path: string): Promise<RunMap> {
  try { return JSON.parse(await readFile(path, "utf8")) as RunMap; } catch { return {}; }
}
async function writeRuns(directory: string, path: string, runs: RunMap): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(runs), { mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => undefined);
}

async function runView(runKey: string, runId: string): Promise<Record<string, unknown>> {
  const record = await readTaskRun(runId);
  if (!record) return { runKey, status: "unknown", note: "The run record is no longer on this computer." };
  const view = await describeRun(record);
  const answer = typeof view.answer === "string" ? view.answer.slice(0, ANSWER_LIMIT) : undefined;
  return { runKey, status: view.status, ...(view.startedAt ? { startedAt: view.startedAt } : {}), ...(view.endedAt ? { endedAt: view.endedAt } : {}), ...(view.exitCode !== undefined ? { exitCode: view.exitCode } : {}), ...(view.error ? { error: view.error } : {}), ...(answer !== undefined ? { answer } : {}) };
}

export async function runTodoDispatch(args: Record<string, unknown>, meta: unknown, deps: TodoDispatchDeps = defaultManagerDeps, workspaces: readonly string[] = []): Promise<Record<string, unknown>> {
  const action = args.action;
  if (action !== "start" && action !== "status" && action !== "cancel" && action !== "check" && action !== "hash") throw new Error("action must be one of start, status, cancel, check, hash.");
  if (action === "hash") return hashScriptFiles(args, workspaces);
  const runKey = text(args, "runKey", 128);
  if (!RUN_KEY.test(runKey)) throw new Error("runKey is invalid.");
  const identity = observeIdentity();
  if (!identity) throw new TrustError("device_not_bound");
  const directory = trustDirectory({ relayUrl: identity.relayUrl, userId: identity.userId });
  const mapPath = join(directory, "todo-runs.json");

  if (action === "check") return runTodoCheck(args, meta, identity, directory, deps);
  if (action !== "start") {
    const found = (await readRuns(mapPath))[runKey];
    if (!found) return { runKey, status: "unknown", note: "This computer has no run with that key." };
    if (action === "cancel") await cancelTaskRun(found.runId);
    return runView(runKey, found.runId);
  }

  return serial(async () => {
    const existing = (await readRuns(mapPath))[runKey];
    if (existing) return runView(runKey, existing.runId);
    const trust = await readTrustOrRefresh({ relayUrl: identity.relayUrl, userId: identity.userId }, deps.refreshTrust ?? refreshAccountTrust);
    if (!trust) throw new TrustError("no_trust_record", NO_TRUST_MESSAGE);
    const approval = (meta && typeof meta === "object" ? (meta as Record<string, unknown>)[TODO_SCOPE_META_KEY] : undefined) as SignedApproval | undefined;
    if (!approval || typeof approval !== "object") throw new TrustError("approval_missing");
    const sites = Array.isArray(args.sites) ? args.sites.filter((site): site is string => typeof site === "string") : [];
    const now = deps.now?.() ?? Date.now();
    // The agent that runs the step is part of what the owner signed for: a device default or a named agent must be in the scope.
    const script = args.executor === SCRIPT_EXECUTOR;
    if (args.executor !== undefined && args.executor !== null && !script && !isAgentId(args.executor)) throw new Error("executor must be script or an installed-agent id such as pi, codex or claude-code.");
    const runner = script ? SCRIPT_EXECUTOR : isAgentId(args.executor) ? args.executor : await (deps.defaultAgent ?? defaultAgentId)();
    const credentials = script && Array.isArray(args.credentials) ? args.credentials.filter((name): name is string => typeof name === "string") : [];
    const instruction = text(args, "instruction", MAX_INSTRUCTION_BYTES);
    const authorization = await authorizeTodoStep(approval, { record: trust.record, device: identity.device, deviceKey: identity.deviceKey, counterDirectory: directory, now }, {
      todoId: text(args, "todoId", 128), stepKey: runKey, cwd: text(args, "cwd", 1024), sites, executor: runner,
      ...(script ? { script: { command: instruction }, credentials } : {}),
    });
    const name = `todo-${createHash("sha256").update(runKey).digest("hex").slice(0, 24)}`;
    const remaining = Math.floor((Date.parse(authorization.expiresAt) - now) / 1000);
    const definition = buildDefinition({
      name, runner, command: instruction, cwd: args.cwd as string, network: sites,
      timeoutSec: Math.max(1, Math.min(MAX_STEP_SECONDS, remaining)), ...(typeof args.model === "string" && args.model ? { model: args.model } : {}),
    }, undefined, new Date(now));
    // The signed scope is the approval for its sites, until the approval ends.
    await saveDefinition({ ...definition, approvals: Object.fromEntries(sites.map((site) => [site, authorization.expiresAt])) });
    try {
      // Credential groups open for this run only (read access); nothing is written to the global grants.
      const run = await startTask(name, { trigger: "remote", ...(credentials.length > 0 ? { credentials } : {}) }, deps);
      await writeRuns(directory, mapPath, { ...(await readRuns(mapPath)), [runKey]: { runId: run.runId, task: name } });
      return runView(runKey, run.runId);
    } finally { await removeDefinition(name).catch(() => undefined); }
  });
}


/**
 * One check of a `script` todo condition: the script runs inside the sandbox in the signed folder, with no network, no credentials (the
 * task environment is the plain pass-through list) and at most 30 seconds. Only `met` (exit code 0) and the code go back; the output does not.
 * The script's sha256 must be in the owner's signed scope, so an edited script is refused here whatever the cloud sent.
 */
async function runTodoCheck(args: Record<string, unknown>, meta: unknown, identity: { relayUrl: string; userId: string; device: string; deviceKey: string }, directory: string, deps: TodoDispatchDeps): Promise<Record<string, unknown>> {
  const trust = await readTrustOrRefresh({ relayUrl: identity.relayUrl, userId: identity.userId }, deps.refreshTrust ?? refreshAccountTrust);
  if (!trust) throw new TrustError("no_trust_record", NO_TRUST_MESSAGE);
  const approval = (meta && typeof meta === "object" ? (meta as Record<string, unknown>)[TODO_SCOPE_META_KEY] : undefined) as SignedApproval | undefined;
  if (!approval || typeof approval !== "object") throw new TrustError("approval_missing");
  const script = text(args, "script", MAX_INSTRUCTION_BYTES);
  const cwd = text(args, "cwd", 1024);
  const now = deps.now?.() ?? Date.now();
  await authorizeTodoCheck(approval, { record: trust.record, device: identity.device, deviceKey: identity.deviceKey, counterDirectory: directory, now }, {
    todoId: text(args, "todoId", 128), cwd, scriptHash: createHash("sha256").update(script, "utf8").digest("hex"),
  });
  const name = `todo-check-${createHash("sha256").update(text(args, "runKey", 128)).digest("hex").slice(0, 20)}`;
  const definition = buildDefinition({ name, runner: "script", command: script, cwd, network: [], timeoutSec: TODO_CHECK_TIMEOUT_SEC }, undefined, new Date(now));
  await saveDefinition(definition);
  try {
    const run = await startTask(name, { trigger: "remote" }, deps);
    const done = await waitForTaskRun(run.runId, deps.checkWaitMs ?? (TODO_CHECK_TIMEOUT_SEC + 10) * 1000);
    if (done.status === "running" || done.status === "queued") { await cancelTaskRun(run.runId).catch(() => undefined); return { status: "checked", met: false, exitCode: null }; }
    return { status: "checked", met: done.status === "completed" && done.exitCode === 0, exitCode: done.exitCode ?? null };
  } finally { await removeDefinition(name).catch(() => undefined); }
}

/**
 * `hash`: the sha256 of the files a script step names, read from the step folder, so the owner's signing page can show them before signing.
 * Read-only, only inside a workspace of this computer, and the content never leaves: only names and hashes go back.
 */
async function hashScriptFiles(args: Record<string, unknown>, workspaces: readonly string[]): Promise<Record<string, unknown>> {
  const cwd = text(args, "cwd", 1024);
  const files = Array.isArray(args.files) ? args.files : [];
  if (files.length > MAX_SCRIPT_FILES || !files.every((file): file is string => typeof file === "string" && file.length > 0)) throw new Error(`files must be at most ${MAX_SCRIPT_FILES} relative paths.`);
  let workspace: string | undefined;
  for (const root of workspaces) if (await insideWorkspace(root, cwd)) { workspace = root; break; }
  if (!workspace) throw new TrustError("outside_workspace");
  return { status: "hashed", files: await hashStepFiles(workspace, cwd, files) };
}
