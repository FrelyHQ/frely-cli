import { chmod, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { isAgentId } from "../agents/registry.js";
import { verifyApproval, type ApprovalPayload, type SignedApproval, type TrustRecord } from "./record.js";
import { TrustError } from "./webauthn.js";

/**
 * Device-side enforcement of a todo's scope. The cloud checks the same rules before it dispatches, but this device never trusts that:
 * it accepts a step only under an Owner passkey `todo_scope` approval it verifies itself against its pinned trust record, and it
 * keeps its own step count per approval. The relay's `active` flag, a terminal confirmation or any unsigned claim is not accepted.
 */
export const TODO_SCOPE_GRANT = "todo_scope";
/** The device's own cap, whatever the signed expiry says. */
export const TODO_SCOPE_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_STEPS = 100;
const MAX_SITES = 20;
const SITE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/u;

export interface TodoStepRequest { todoId: string; stepKey: string; cwd: string; sites: readonly string[]; executor?: string }
export interface TodoAuthContext { record: TrustRecord; device: string; deviceKey: string; counterDirectory: string; now?: number }
export interface TodoAuthorization { approvalId: string; scope: NonNullable<ApprovalPayload["scope"]>; expiresAt: string; stepsUsed: number; duplicate: boolean }

function shapedScope(payload: ApprovalPayload): NonNullable<ApprovalPayload["scope"]> {
  const scope = payload.scope;
  if (!scope || typeof scope.todo !== "string" || typeof scope.workspace !== "string" || !isAbsolute(scope.workspace) || scope.workspace.includes("\0")) throw new TrustError("scope_invalid");
  if (!Array.isArray(scope.sites) || scope.sites.length > MAX_SITES || !scope.sites.every((site) => typeof site === "string" && SITE.test(site))) throw new TrustError("scope_invalid");
  if (scope.executors !== undefined && (!Array.isArray(scope.executors) || scope.executors.length < 1 || !scope.executors.every((item) => isAgentId(item)))) throw new TrustError("scope_invalid");
  if (scope.scriptHashes !== undefined && (!Array.isArray(scope.scriptHashes) || scope.scriptHashes.length > 20 || !scope.scriptHashes.every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/u.test(hash)))) throw new TrustError("scope_invalid");
  if (!Number.isSafeInteger(scope.maxSteps) || scope.maxSteps < 1 || scope.maxSteps > MAX_STEPS) throw new TrustError("scope_invalid");
  return scope;
}

/** True when `target` is `root` or inside it, after both are resolved through symlinks; case-insensitive where the file system is. */
export async function insideWorkspace(root: string, target: string): Promise<boolean> {
  let realRoot: string, realTarget: string;
  try { [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]); } catch { return false; }
  const fold = process.platform === "darwin" || process.platform === "win32" ? (value: string) => value.toLowerCase() : (value: string) => value;
  const a = fold(realRoot), b = fold(realTarget);
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

interface Counters { [approvalId: string]: { exp: string; keys: string[] } }
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(work: () => Promise<T>): Promise<T> => { const run = queue.then(work); queue = run.catch(() => undefined); return run; };

/** Reserve one step under an approval. The same step key is not counted twice, so a retried dispatch cannot burn the limit. Entries of expired approvals are dropped. */
function reserve(directory: string, approvalId: string, exp: string, stepKey: string, max: number, now: number): Promise<{ used: number; duplicate: boolean }> {
  return serial(async () => {
    const path = join(directory, "todo-steps.json");
    let counters: Counters = {};
    try { counters = JSON.parse(await readFile(path, "utf8")) as Counters; } catch { /* first use */ }
    for (const [id, entry] of Object.entries(counters)) if (Date.parse(entry.exp) < now - 24 * 3600_000) delete counters[id];
    const entry = counters[approvalId] ?? { exp, keys: [] };
    if (entry.keys.includes(stepKey)) return { used: entry.keys.length, duplicate: true };
    if (entry.keys.length >= max) throw new TrustError("step_limit_reached");
    entry.keys.push(stepKey);
    counters[approvalId] = entry;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(counters), { mode: 0o600 });
    await rename(temp, path);
    await chmod(path, 0o600).catch(() => undefined);
    return { used: entry.keys.length, duplicate: false };
  });
}

/**
 * Accept or refuse one step. Throws TrustError (code says why). Order: signature and bindings, then what the approval grants, then the
 * folder and sites of this step, and only then is the step counted.
 */
export async function authorizeTodoStep(approval: SignedApproval, context: TodoAuthContext, request: TodoStepRequest): Promise<TodoAuthorization> {
  const now = context.now ?? Date.now();
  const payload = verifyApproval(approval, { record: context.record, device: context.device, deviceKey: context.deviceKey, now });
  if (payload.grant.kind !== TODO_SCOPE_GRANT || payload.grant.mode !== "authorization") throw new TrustError("wrong_grant");
  if (payload.ctl !== undefined || payload.bind !== undefined) throw new TrustError("approval_invalid");
  const scope = shapedScope(payload);
  if (payload.grant.resource !== request.todoId || scope.todo !== request.todoId) throw new TrustError("todo_mismatch");
  if (Date.parse(payload.exp) - Date.parse(payload.iat) > TODO_SCOPE_MAX_TTL_MS) throw new TrustError("ttl_too_long");
  if (!(await insideWorkspace(scope.workspace, request.cwd))) throw new TrustError("outside_workspace");
  const allowed = new Set(scope.sites);
  if (!request.sites.every((site) => allowed.has(site))) throw new TrustError("site_not_allowed");
  // A scope signed before executors existed allows pi only; the owner has to sign for codex.
  if (!(scope.executors ?? ["pi"]).includes(request.executor ?? "pi")) throw new TrustError("executor_not_allowed");
  if (typeof request.stepKey !== "string" || request.stepKey.length < 1 || request.stepKey.length > 128) throw new TrustError("approval_invalid");
  const { used, duplicate } = await reserve(context.counterDirectory, payload.id, payload.exp, request.stepKey, scope.maxSteps, now);
  return { approvalId: payload.id, scope, expiresAt: payload.exp, stepsUsed: used, duplicate };
}

/**
 * Accept or refuse one script check of a `script` todo condition. Same signature, todo, expiry and folder rules as a step, and the script's
 * sha256 must be one the owner signed: an edited script is refused (`script_mismatch`). A check is not a step and is not counted.
 */
export async function authorizeTodoCheck(approval: SignedApproval, context: TodoAuthContext, request: { todoId: string; cwd: string; scriptHash: string }): Promise<{ approvalId: string; expiresAt: string }> {
  const now = context.now ?? Date.now();
  const payload = verifyApproval(approval, { record: context.record, device: context.device, deviceKey: context.deviceKey, now });
  if (payload.grant.kind !== TODO_SCOPE_GRANT || payload.grant.mode !== "authorization") throw new TrustError("wrong_grant");
  if (payload.ctl !== undefined || payload.bind !== undefined) throw new TrustError("approval_invalid");
  const scope = shapedScope(payload);
  if (payload.grant.resource !== request.todoId || scope.todo !== request.todoId) throw new TrustError("todo_mismatch");
  if (Date.parse(payload.exp) - Date.parse(payload.iat) > TODO_SCOPE_MAX_TTL_MS) throw new TrustError("ttl_too_long");
  if (!(await insideWorkspace(scope.workspace, request.cwd))) throw new TrustError("outside_workspace");
  if (!(scope.scriptHashes ?? []).includes(request.scriptHash)) throw new TrustError("script_mismatch");
  return { approvalId: payload.id, expiresAt: payload.exp };
}
