import { readFile, stat } from "node:fs/promises";
import { credentialStore } from "./credential-store.js";
import { inspectAuth, normalizeRelayUrl } from "./auth.js";
import { CloudToolError } from "./skill/cloud-item.js";
import { openController } from "./controller/client.js";
import { waitForApproval, type ApprovalOutcome, type ApprovalRef } from "./controller/approval-wait.js";
import { openCloudReader, type CloudReader, type DirectResult } from "./cloud/direct.js";

const SERVICE = "frely-cli-cloud-v1";

/** The server's `permission_required` or `confirmation_required` tool failure as a one-line hint, or null for any other result. */
export function permissionHint(result: object): string | null {
  const { isError, content } = result as { isError?: unknown; content?: unknown };
  if (isError !== true || !Array.isArray(content)) return null;
  for (const part of content) {
    const text = (part as { type?: unknown; text?: unknown }).type === "text" ? (part as { text?: unknown }).text : undefined;
    if (typeof text !== "string") continue;
    try {
      const error = (JSON.parse(text) as { error?: { code?: unknown; need?: unknown; group?: unknown; url?: unknown; approvalCode?: unknown; shortCode?: unknown; summary?: unknown } }).error;
      if (typeof error?.url !== "string" || (error.code !== "permission_required" && error.code !== "confirmation_required")) continue;
      const need = error.need === "write" ? "write access" : error.need === "sensitive" ? "sensitive read access" : "read access";
      const url = new URL(error.url);
      if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") continue;
      if (error.code === "confirmation_required") {
        if (typeof error.approvalCode !== "string" || !/^[A-HJ-NP-Z]{8}$/.test(error.approvalCode)) continue;
        return `${typeof error.summary === "string" ? error.summary + "\n" : ""}Approve this in your browser: ${url.toString()}\nCode: ${error.approvalCode.slice(0, 4)}-${error.approvalCode.slice(4)}\nThen run the same call again with "approvalCode":"${error.approvalCode}" added to the input, or add --wait to let the CLI wait and run it once. To wait in the background: frely permission wait ${error.approvalCode}`;
      }
      const waiting = typeof error.shortCode === "string" && /^[A-Za-z]{8}$/.test(error.shortCode) ? `\nTo wait in the background: frely permission wait ${error.shortCode}, then run the call again (or use --wait).` : "";
      return `This device needs ${need}${typeof error.group === "string" ? " to " + error.group : ""}. Grant it in your browser (passkey or authenticator code required): ${url.toString()}${waiting}`;
    } catch { /* Not a permission failure. */ }
  }
  return null;
}

type CallResult = { isError?: boolean; content?: unknown; [key: string]: unknown };
const WAIT_DEFAULT_MS = 5 * 60_000, WAIT_MAX_MS = 10 * 60_000;

/** The error object of a failed tool result, or null when the result is not a JSON error. */
function toolError(result: object): { code?: unknown; url?: unknown; approvalCode?: unknown; shortCode?: unknown; expiresAt?: unknown } | null {
  const { isError, content } = result as { isError?: unknown; content?: unknown };
  if (isError !== true || !Array.isArray(content)) return null;
  for (const part of content) {
    const text = (part as { type?: unknown; text?: unknown }).type === "text" ? (part as { text?: unknown }).text : undefined;
    if (typeof text !== "string") continue;
    try { const error = (JSON.parse(text) as { error?: object }).error; if (error && typeof error === "object") return error; } catch { /* Not JSON. */ }
  }
  return null;
}

/**
 * After a `permission_required` or `confirmation_required` refusal: waits for the owner's decision with the one shared wait, then runs the call
 * again exactly once, and only when the approval is `approved`. A denied, expired or already-used approval, or a time-out, gives back the refusal
 * without running anything. A confirmation is repeated with the same approvalCode; the server lets it through once. The repeat is never retried,
 * so a write whose outcome was lost is not replayed (it is reported as it came back).
 */
export async function rerunAfterApproval(first: CallResult, call: (input: Record<string, unknown>) => Promise<CallResult>, input: Record<string, unknown>,
  wait: (ref: ApprovalRef, timeoutMs: number) => Promise<ApprovalOutcome>, now: () => number = Date.now): Promise<CallResult> {
  const start = toolError(first);
  if (!start || (start.code !== "permission_required" && start.code !== "confirmation_required")) return first;
  const approvalCode = start.code === "confirmation_required" && typeof start.approvalCode === "string" ? start.approvalCode : undefined;
  const shortCode = start.code === "permission_required" && typeof start.shortCode === "string" ? start.shortCode : undefined;
  const code = approvalCode ?? shortCode;
  if (!code) return first;
  const expires = typeof start.expiresAt === "string" || typeof start.expiresAt === "number" ? new Date(start.expiresAt).getTime() : NaN;
  const budget = Math.min(Number.isFinite(expires) ? expires - now() : WAIT_DEFAULT_MS, WAIT_MAX_MS);
  const outcome = await wait({ code }, Math.max(budget, 0));
  if (outcome.status !== "approved") {
    process.stderr.write(outcome.status === "used" ? "This approval was already used for a call; not repeating it. Check that call's result.\n"
      : outcome.status === "pending" ? "Still waiting for the owner. Run the same command with --wait to keep waiting.\n"
      : outcome.status === "error" ? outcome.message + "\n" : `The request was ${outcome.status}.\n`);
    return first;
  }
  return call(approvalCode ? { ...input, approvalCode } : input);
}

export const API_USAGE = `Frely API — call your Frely account's business operations (keys, credits, orders, Creator items…).
  frely api list [--group <name>] [--json]
  frely api describe <tool>
  frely api call <tool> [--json '<object>' | --input <file>] [--wait]

"list" prints the operations grouped by area with a one-line description each; add --json for the full tool list.
Other results are JSON. The first command asks you to approve this computer in your browser (the same approval as frely controller login);
frely logout also revokes it. Without a terminal it prints the approval link and exits; run it again after approving.
Calls may create resources or incur usage. Failed writes are never replayed automatically.
A new device may only read non-sensitive data; for anything else the error links to the web
console page where you grant it (passkey or authenticator code required).
With --wait, a call that needs approval prints the link, then blocks until the owner decides and
continues by itself: it returns the real result once approved, or the refusal when denied or expired.
`;
/** What an older CLI kept for its separate Cloud authorization; only read to revoke it on logout. */
interface StoredCloud {
  version: 1;
  resource: string;
  client?: { client_id: string };
  tokens?: { access_token: string; refresh_token?: string };
}

async function cloudIdentity() {
  const account = await inspectAuth();
  const origin = normalizeRelayUrl(account.relayUrl);
  const resource = origin + "/mcp";
  return { origin, resource, userId: account.user?.id, key: resource + "|" + (account.user?.id ?? "cloud") };
}

/** Revokes and forgets the Cloud authorization an older CLI left behind; there is nothing to do on a computer that never had one. */
export async function logoutCloud(): Promise<void> {
  const identity = await cloudIdentity();
  const raw = await credentialStore.getPassword(SERVICE, identity.key);
  if (!raw) return;
  const stored = JSON.parse(raw) as StoredCloud;
  if (stored.resource !== identity.resource) throw new Error("Cloud credential resource mismatch.");
  if (stored.tokens && stored.client) {
    const token = stored.tokens.refresh_token ?? stored.tokens.access_token;
    const response = await fetch(identity.origin + "/api/auth/oauth2/revoke", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: identity.origin },
      body: new URLSearchParams({ client_id: stored.client.client_id, token,
        token_type_hint: stored.tokens.refresh_token ? "refresh_token" : "access_token" }),
    });
    if (!response.ok) throw new Error("Cloud authorization revocation failed. Try again.");
  }
  await credentialStore.deletePassword(SERVICE, identity.key);
}

/** True when a person can finish a browser authorization: both stdin and stderr (where the link is printed) are terminals. */
export function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

interface ListedTool { name: string; description?: string | undefined; annotations?: { readOnlyHint?: boolean | undefined; destructiveHint?: boolean | undefined } | undefined; _meta?: Record<string, unknown> | undefined }

function firstSentence(text: string | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  const end = flat.search(/[.。!?](\s|$)/);
  return end === -1 ? flat : flat.slice(0, end + 1);
}

/** Tools grouped by the part of the name before the first dot; the server's `frely/groupSummary` describes each group. */
export function formatApiList(tools: readonly ListedTool[]): string {
  const groups = new Map<string, { summary: string; tools: ListedTool[] }>();
  for (const tool of tools) {
    const dot = tool.name.indexOf(".");
    const group = dot === -1 ? tool.name : tool.name.slice(0, dot);
    const entry = groups.get(group) ?? { summary: "", tools: [] };
    const summary = tool._meta?.["frely/groupSummary"];
    if (typeof summary === "string" && !entry.summary) entry.summary = summary;
    entry.tools.push(tool);
    groups.set(group, entry);
  }
  const lines: string[] = [];
  for (const [group, entry] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(entry.summary ? `${group} — ${entry.summary}` : group);
    for (const tool of entry.tools) {
      const kind = tool.annotations?.destructiveHint === true ? "destructive" : tool.annotations?.readOnlyHint === true ? "read" : "write";
      lines.push(`  ${tool.name} [${kind}] ${firstSentence(tool.description)}`.trimEnd());
    }
    lines.push("");
  }
  lines.push("Details: frely api describe <tool>   Full JSON: frely api list --json");
  return lines.join("\n") + "\n";
}

export async function runApi(args: readonly string[]): Promise<{ value?: unknown; text?: string; failed?: boolean }> {
  const action = args[1] ?? "list";
  if (action === "help" || args.includes("--help") || args.includes("-h")) return { text: API_USAGE };
  if (!["list", "describe", "call"].includes(action)) throw new Error(API_USAGE);
  const named = action === "describe" || action === "call";
  const name = named ? args[2] : undefined;
  if (named && (!name || !/^[a-zA-Z0-9_.-]{1,128}$/.test(name))) throw new Error("A valid Cloud tool name is required.");
  const options = new Map<string, string>();
  let fullJson = false, wait = false;
  for (let i = named ? 3 : 2; i < args.length; i++) {
    if (action === "list" && args[i] === "--json") { fullJson = true; continue; }
    if (action === "call" && args[i] === "--wait") { wait = true; continue; }
    const option = args[i]!, value = args[++i];
    const allowed = action === "list" ? ["--group"] : action === "call" ? ["--json", "--input"] : [];
    if (!allowed.includes(option) || options.has(option) || value === undefined) throw new Error(API_USAGE);
    options.set(option, value);
  }
  let input: Record<string, unknown> = {};
  if (options.has("--json") && options.has("--input")) throw new Error("Use --json or --input.");
  if (action === "call") {
    let raw = options.get("--json") ?? "{}";
    const file = options.get("--input");
    if (file !== undefined) {
      if ((await stat(file)).size > 512 * 1024) throw new Error("Cloud input exceeds 512 KiB.");
      raw = await readFile(file, "utf8");
    }
    if (Buffer.byteLength(raw) > 512 * 1024) throw new Error("Cloud input exceeds 512 KiB.");
    const value: unknown = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Cloud input must be a JSON object.");
    input = value as Record<string, unknown>;
  }
  return (await runApiDirect({ action, name, options, fullJson, wait, input })) ?? runApiViaController({ action, name, options, fullJson, wait, input });
}

/**
 * `frely api list/describe` and read-only calls run on the login token alone; a write or paid tool is invisible there, and
 * `--wait` needs the controller connection to poll the approval, so those return null and the caller falls back to the controller path.
 */
async function runApiDirect(request: { action: string; name: string | undefined; options: Map<string, string>; fullJson: boolean; wait: boolean; input: Record<string, unknown> }): Promise<{ value?: unknown; text?: string; failed?: boolean } | null> {
  const reader = await openCloudReader();
  try {
    if (request.action === "list" || request.action === "describe") {
      const tools = await reader.tools();
      if (request.action === "describe") {
        const tool = tools.find((entry) => entry.name === request.name);
        return tool ? { value: tool } : null;
      }
      const group = request.options.get("--group");
      const visible = group ? tools.filter((tool) => tool.name.startsWith(group + ".")) : tools;
      return request.fullJson ? { value: visible } : { text: formatApiList(visible) };
    }
    let result = await reader.call(request.name!, request.input);
    const hint = permissionHint(result);
    if (hint) process.stderr.write(hint + "\n");
    if (result.isError === true && request.wait) {
      const error = toolError(result);
      if (error && (error.code === "permission_required" || error.code === "confirmation_required")) return null;
    }
    return { value: result, failed: result.isError === true };
  } finally { await reader.close().catch(() => undefined); }
}

/** `frely api` on the controller connection: the account tools are FrelyMCP's frely_list and frely_call, so the answers and approvals are the same as in an AI client. */
async function runApiViaController(request: { action: string; name: string | undefined; options: Map<string, string>; fullJson: boolean; wait: boolean; input: Record<string, unknown> }): Promise<{ value?: unknown; text?: string; failed?: boolean }> {
  const controller = await openController({ interactive: isInteractiveTerminal() });
  try {
    const textOf = (result: CallResult) => (Array.isArray(result.content) ? (result.content as Array<{ type?: unknown; text?: unknown }>).filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text as string).join("\n") : "");
    if (request.action === "list" || request.action === "describe") {
      const group = request.action === "describe" ? request.name!.split(".")[0] : request.options.get("--group");
      const result = await controller.call("frely_list", group ? { group } : {}) as CallResult;
      if (result.isError === true || request.action === "describe" || request.fullJson) return { value: result, failed: result.isError === true };
      return { text: textOf(result) + "\n" };
    }
    const call = (arguments_: Record<string, unknown>) => controller.call("frely_call", { tool: request.name, arguments: arguments_ }) as Promise<CallResult>;
    let result = await call(request.input);
    const hint = permissionHint(result);
    if (hint) process.stderr.write(hint + "\n");
    if (hint && request.wait) {
      process.stderr.write("Waiting for approval; this command runs the call once, by itself, as soon as the owner approves (up to 10 minutes).\n");
      result = await rerunAfterApproval(result, call, request.input, (ref, timeoutMs) => waitForApproval(controller, ref, timeoutMs));
    }
    return { value: result, failed: result.isError === true };
  } finally { await controller.close().catch(() => undefined); }
}

/**
 * Call one Cloud tool for another command (for example skill install). The
 * result is the tool's JSON; a failed call throws CloudToolError with the
 * server's error code. Writes are never retried.
 */
export async function callCloudTool(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return callCloudToolWith(name, input, { openReader: openCloudReader, openControllerConnection });
}

/** The two connections a Cloud call needs; production opens the login's reader directly and the controller only on fallback. */
export interface CloudCallDeps {
  openReader(): Promise<CloudReader>;
  openControllerConnection(): Promise<{ call(name: string, args: Record<string, unknown>): Promise<DirectResult>; close(): Promise<void> }>;
}

export async function callCloudToolWith(name: string, input: Record<string, unknown>, deps: CloudCallDeps): Promise<Record<string, unknown>> {
  const reader = await deps.openReader();
  try {
    return cloudToolResult(await reader.call(name, input));
  } catch (error) {
    // A read-only login cannot see write or paid tools; those keep the controller connection and its approval codes.
    if (error instanceof CloudToolError && error.code === "tool_unavailable_or_forbidden") return callCloudToolViaController(name, input, deps.openControllerConnection);
    throw error;
  } finally { await reader.close().catch(() => undefined); }
}

/** One tool result as the calling command needs it: the JSON object on success, CloudToolError(code) on failure. Permission hints go to stderr either way. */
function cloudToolResult(result: DirectResult): Record<string, unknown> {
  const hint = permissionHint(result);
  if (hint) process.stderr.write(hint + "\n");
  const text = Array.isArray(result.content) ? (result.content as Array<{ type?: unknown; text?: unknown }>).find(part => part.type === "text")?.text : undefined;
  if (result.isError === true) {
    let code = "operation_failed";
    try { const parsed = (JSON.parse(String(text)) as { error?: { code?: unknown } }).error?.code; if (typeof parsed === "string") code = parsed; } catch { /* Keep the generic code. */ }
    throw new CloudToolError(code);
  }
  const value: unknown = result.structuredContent ?? (typeof text === "string" ? JSON.parse(text) : null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CloudToolError("invalid_operation_output");
  return value as Record<string, unknown>;
}

async function openControllerConnection(): Promise<{ call(name: string, args: Record<string, unknown>): Promise<DirectResult>; close(): Promise<void> }> {
  const controller = await openController({ interactive: isInteractiveTerminal() });
  return { call: (name, args) => controller.call(name, args), close: () => controller.close() };
}

/** The same call on the controller connection (frely_call): for write and paid tools, where an approval code guards every write. */
async function callCloudToolViaController(name: string, input: Record<string, unknown>, open: CloudCallDeps["openControllerConnection"]): Promise<Record<string, unknown>> {
  const controller = await open();
  try { return cloudToolResult(await controller.call("frely_call", { tool: name, arguments: input })); }
  finally { await controller.close().catch(() => undefined); }
}
