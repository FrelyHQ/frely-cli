import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createServer, type Server as HttpServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { credentialStore } from "./credential-store.js";
import { inspectAuth, normalizeRelayUrl, openVerificationUrl, requireLogin } from "./auth.js";
import { VERSION } from "./version.js";
import { CloudToolError } from "./skill/cloud-item.js";
import { ensureDevice, relayFetch } from "./device/control.js";

const SERVICE = "frely-cli-cloud-v1";
/** Names this installation on the web console ("Frely CLI Cloud (host)"). Display only: the server limits the client by its device binding (see bindCloudClient), not by this name. */
export function cloudClientName(host = hostname()): string {
  const safe = host.replace(/[^A-Za-z0-9._ -]/g, "").trim().slice(0, 40);
  return safe ? `Frely CLI Cloud (${safe})` : "Frely CLI Cloud";
}

/** The server's `permission_required` or `confirmation_required` tool failure as a one-line hint, or null for any other result. */
export function permissionHint(result: object): string | null {
  const { isError, content } = result as { isError?: unknown; content?: unknown };
  if (isError !== true || !Array.isArray(content)) return null;
  for (const part of content) {
    const text = (part as { type?: unknown; text?: unknown }).type === "text" ? (part as { text?: unknown }).text : undefined;
    if (typeof text !== "string") continue;
    try {
      const error = (JSON.parse(text) as { error?: { code?: unknown; need?: unknown; group?: unknown; url?: unknown; confirmationId?: unknown; summary?: unknown } }).error;
      if (typeof error?.url !== "string" || (error.code !== "permission_required" && error.code !== "confirmation_required")) continue;
      const need = error.need === "write" ? "write access" : error.need === "sensitive" ? "sensitive read access" : "read access";
      const url = new URL(error.url);
      if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") continue;
      if (error.code === "confirmation_required") {
        if (typeof error.confirmationId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(error.confirmationId)) continue;
        return `${typeof error.summary === "string" ? error.summary + "\n" : ""}Approve this in your browser (passkey or authenticator code required): ${url.toString()}\nThen run the same call again with "confirmationId":"${error.confirmationId}" added to the input.`;
      }
      return `This device needs ${need}${typeof error.group === "string" ? " to " + error.group : ""}. Grant it in your browser (passkey or authenticator code required): ${url.toString()}`;
    } catch { /* Not a permission failure. */ }
  }
  return null;
}

type CallResult = { isError?: boolean; content?: unknown; [key: string]: unknown };
const WAIT_DEFAULT_MS = 5 * 60_000, WAIT_MAX_MS = 10 * 60_000;

/** The error object of a failed tool result, or null when the result is not a JSON error. */
function toolError(result: object): { code?: unknown; url?: unknown; confirmationId?: unknown; expiresAt?: unknown } | null {
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
 * After a `permission_required` or `confirmation_required` refusal, blocks until the owner decides and returns the call's real result, so the
 * calling AI resumes by itself. Only calls the server refused before running are repeated: a pending approval answers `permission_required`
 * again (a denial answers it without a link) or `confirmation_invalid`; the first call that is let through runs exactly once.
 * Gives up at the request's expiry (at most 10 minutes) and returns the last refusal.
 */
export async function waitForApproval(first: CallResult, call: (input: Record<string, unknown>) => Promise<CallResult>, input: Record<string, unknown>,
  options: { intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<CallResult> {
  const { intervalMs = 3000, now = Date.now, sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) } = options;
  const start = toolError(first);
  if (!start || typeof start.url !== "string" || (start.code !== "permission_required" && start.code !== "confirmation_required")) return first;
  const confirmationId = start.code === "confirmation_required" && typeof start.confirmationId === "string" ? start.confirmationId : undefined;
  if (start.code === "confirmation_required" && !confirmationId) return first;
  const expires = typeof start.expiresAt === "string" || typeof start.expiresAt === "number" ? new Date(start.expiresAt).getTime() : NaN;
  const deadline = Math.min(Number.isFinite(expires) ? expires : now() + WAIT_DEFAULT_MS, now() + WAIT_MAX_MS);
  let last = first;
  while (now() + intervalMs < deadline) {
    await sleep(intervalMs);
    last = await call(confirmationId ? { ...input, confirmationId } : input);
    const error = toolError(last);
    const pending = error?.code === "confirmation_invalid" || (error?.code === "permission_required" && typeof error.url === "string");
    if (!pending) return last;
  }
  return last;
}

const SCOPE = "openid profile offline_access cloud:read cloud:write cloud:execute cloud:publish";
/**
 * Registration metadata for the Cloud OAuth client. The callback is an http loopback URL, so the client must declare
 * itself `native`: the server treats an unspecified type as `web` and rejects every http redirect URI of a web client.
 */
export function cloudClientMetadata(redirectUrl: string, host = hostname()): OAuthClientMetadata & { application_type: "native" } {
  return { client_name: cloudClientName(host), application_type: "native", redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: SCOPE };
}
export const API_USAGE = `Frely API — call your Frely account's business operations (keys, credits, orders, Creator items…).
  frely api list [--group <name>] [--json]
  frely api describe <tool>
  frely api call <tool> [--json '<object>' | --input <file>] [--wait]

"list" prints the operations grouped by area with a one-line description each; add --json for the full tool list.
Other results are JSON. The first command opens a browser for authorization;
frely logout also revokes it. This authorization is separate from device MCP.
Calls may create resources or incur usage. Failed writes are never replayed automatically.
A new device may only read non-sensitive data; for anything else the error links to the web
console page where you grant it (passkey or authenticator code required).
With --wait, a call that needs approval prints the link, then blocks until the owner decides and
continues by itself: it returns the real result once approved, or the refusal when denied or expired.
`;
interface StoredCloud {
  version: 1;
  resource: string;
  redirectUrl: string;
  client?: OAuthClientInformationMixed;
  /** The device this client was last bound to on the server; the binding is what makes the client this computer's CLI. */
  bound?: { clientId: string; deviceId: string };
  tokens?: OAuthTokens;
  expiresAt?: number;
}

/**
 * Tells the server which enrolled device this Cloud client belongs to, so it is limited and shown as this computer's CLI. The server decides by
 * this binding, not by the client's name. Skipped when the same client was already bound to the same device; throws when the server refuses.
 */
export async function bindCloudClient(stored: Pick<StoredCloud, "client" | "bound">, device: { deviceId: string },
  post: (body: { clientId: string; deviceId: string }) => Promise<Response>): Promise<{ clientId: string; deviceId: string } | null> {
  const clientId = stored.client?.client_id;
  if (!clientId) return null;
  if (stored.bound?.clientId === clientId && stored.bound.deviceId === device.deviceId) return stored.bound;
  const response = await post({ clientId, deviceId: device.deviceId });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: unknown }; message?: unknown } | null;
    const message = payload?.error?.message ?? payload?.message;
    throw new Error(typeof message === "string" ? message : `The server refused to link this Cloud authorization to this computer (HTTP ${response.status}).`);
  }
  return { clientId, deviceId: device.deviceId };
}

async function cloudIdentity() {
  const account = await inspectAuth();
  const origin = normalizeRelayUrl(account.relayUrl);
  const resource = origin + "/mcp";
  return { origin, resource, userId: account.user?.id, key: resource + "|" + (account.user?.id ?? "cloud") };
}

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

export const NON_INTERACTIVE_AUTHORIZATION = "Cloud authorization is required, but this is not an interactive terminal. Run frely api list in a terminal you can type in to authorize in the browser once, then run this command again.";

/** True when a person can finish a browser authorization: both stdin and stderr (where the link is printed) are terminals. */
export function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

async function connectCloud() {
  const identity = await cloudIdentity();
  const raw = await credentialStore.getPassword(SERVICE, identity.key);
  let stored: StoredCloud = raw ? JSON.parse(raw) as StoredCloud : { version: 1, resource: identity.resource, redirectUrl: "" };
  if (stored.version !== 1 || stored.resource !== identity.resource) throw new Error("Cloud credentials are invalid. Run frely logout, then frely login.");
  const state = randomUUID();
  let verifier = "";
  let listener: HttpServer | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((error: Error) => void) | undefined;
  let pendingCode: Promise<string> | undefined;
  const closeListener = async () => {
    if (timer) clearTimeout(timer);
    if (listener?.listening) await new Promise<void>(resolve => listener!.close(() => resolve()));
  };
  const listen = async (port: number) => {
    listener = createServer((request, response) => {
      const url = new URL(request.url ?? "/", stored.redirectUrl || "http://127.0.0.1");
      if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
        response.writeHead(400); response.end("Invalid authorization callback."); return;
      }
      const code = url.searchParams.get("code");
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      if (!code || url.searchParams.has("error")) {
        response.writeHead(400); response.end("Authorization was not completed.");
        rejectCode?.(new Error("Cloud authorization was declined.")); return;
      }
      response.end("Frely Cloud is authorized. You can close this window.");
      resolveCode?.(code);
    });
    await new Promise<void>((resolve, reject) => {
      listener!.once("error", reject);
      listener!.listen(port, "127.0.0.1", resolve);
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Cloud callback could not start.");
    return "http://127.0.0.1:" + address.port + "/callback";
  };
  if (!stored.redirectUrl) stored.redirectUrl = await listen(0);
  const callback = new URL(stored.redirectUrl);
  if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" || callback.pathname !== "/callback" || !callback.port || callback.username || callback.password || callback.search || callback.hash) {
    await closeListener(); throw new Error("Stored Cloud callback is invalid.");
  }
  const save = () => credentialStore.setPassword(SERVICE, identity.key, JSON.stringify(stored));
  const provider: OAuthClientProvider = {
    redirectUrl: stored.redirectUrl,
    clientMetadata: cloudClientMetadata(stored.redirectUrl),
    state: () => state,
    clientInformation: () => stored.client,
    saveClientInformation: async client => { stored.client = client; await save(); },
    tokens: () => stored.tokens,
    saveTokens: async tokens => {
      // This checks account selection; signature/audience verification remains on the server.
      if (identity.userId) {
        let subject: unknown;
        try { subject = (JSON.parse(Buffer.from(tokens.access_token.split(".")[1] ?? "", "base64url").toString()) as { sub?: unknown }).sub; } catch { /* Rejected below. */ }
        if (subject !== identity.userId) throw new Error("Cloud authorization used another account. Use the account shown by frely doctor.");
      }
      stored.tokens = tokens;
      stored.expiresAt = Date.now() + (tokens.expires_in ?? 600) * 1000;
      await save();
    },
    saveCodeVerifier: value => { verifier = value; },
    codeVerifier: () => { if (!verifier) throw new Error("Cloud PKCE verifier is missing."); return verifier; },
    redirectToAuthorization: async url => {
      if (url.origin !== identity.origin) throw new Error("Unexpected Cloud authorization server.");
      if (!listener) await listen(Number(callback.port));
      // Scripts and AI tools cannot complete a browser authorization: fail now instead of waiting out the timeout.
      if (!isInteractiveTerminal()) throw new Error(NON_INTERACTIVE_AUTHORIZATION);
      pendingCode = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
      // Attach immediately so a callback rejection never becomes an unhandled promise.
      pendingCode.catch(() => undefined);
      timer = setTimeout(() => rejectCode?.(new Error("Cloud authorization timed out.")), 300000);
      process.stderr.write("Authorize Frely Cloud in your browser (waiting up to 5 minutes):\n" + url.toString() + "\n");
      openVerificationUrl(url.toString());
    },
    validateResourceURL: async (_serverUrl, resource) => {
      if (resource !== undefined && resource !== identity.resource) throw new Error("Cloud resource mismatch.");
      return new URL(identity.resource);
    },
    invalidateCredentials: async scope => {
      if (scope === "all" || scope === "client") { delete stored.client; delete stored.bound; }
      if (scope === "all" || scope === "tokens") { delete stored.tokens; delete stored.expiresAt; }
      if (scope === "all" || scope === "verifier") verifier = "";
      await save();
    },
  };
  const cloudFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== identity.origin) throw new Error("Cloud discovery cannot send credentials to another origin.");
    return fetch(input, { ...init, redirect: "error", signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000) });
  };
  const makeTransport = () => new StreamableHTTPClientTransport(new URL(identity.resource), {
    authProvider: provider, fetch: cloudFetch, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  const transport = makeTransport();
  let client = new Client({ name: "frely-cli-cloud", version: VERSION });
  try {
    try { await client.connect(transport as unknown as Transport); }
    catch (error) {
      if (!(error instanceof UnauthorizedError) || !pendingCode) throw error;
      await transport.finishAuth(await pendingCode);
      // A started transport refuses a second start(): the first connect already started it, so reconnect on a fresh one that reads the stored tokens.
      await transport.close().catch(() => undefined);
      client = new Client({ name: "frely-cli-cloud", version: VERSION });
      await client.connect(makeTransport() as unknown as Transport);
    }
    // No call is made before the server knows this authorization belongs to this computer: an unbound client is not limited by approved permissions.
    const device = await ensureDevice();
    const account = await requireLogin();
    const bound = await bindCloudClient(stored, device, body => relayFetch(account.config.relayUrl, account.credential, "/api/user/device-relay/cloud-client",
      { method: "POST", body: JSON.stringify(body) }));
    if (bound && bound !== stored.bound) { stored.bound = bound; await save(); }
    await closeListener();
    return { client, close: () => client.close() };
  } catch (error) {
    await closeListener();
    await client.close().catch(() => undefined);
    if (error instanceof Error && error.message === NON_INTERACTIVE_AUTHORIZATION) throw error;
    throw new Error(`Cloud connection or authorization failed${failureCause(error)}. Confirm app availability and account selection, then run the command again. No business call was replayed.`);
  }
}

/** The underlying failure as ": <one line, at most 200 characters>", or "" when there is none. */
export function failureCause(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const line = message.replace(/\s+/g, " ").trim();
  return line ? ": " + (line.length > 200 ? line.slice(0, 199) + "…" : line) : "";
}

interface ListedTool { name: string; description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; _meta?: Record<string, unknown> }

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
  const session = await connectCloud();
  try {
    const all = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await session.client.listTools(cursor === undefined ? {} : { cursor });
      all.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error("Invalid Cloud tool pagination.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (action === "list") {
      const group = options.get("--group");
      const tools = all.filter(tool => !group || tool.name.startsWith(group + "."));
      return fullJson ? { value: { tools } } : { text: formatApiList(tools as ListedTool[]) };
    }
    const tool = all.find(tool => tool.name === name);
    if (!tool) throw new Error("Cloud tool is unavailable or not authorized: " + name);
    if (action === "describe") return { value: tool };
    const call = (arguments_: Record<string, unknown>) => session.client.callTool({ name: name!, arguments: arguments_ }, undefined, { timeout: 180000 }) as Promise<CallResult>;
    let result = await call(input);
    const hint = permissionHint(result);
    if (hint) process.stderr.write(hint + "\n");
    if (hint && wait) {
      process.stderr.write("Waiting for approval; this command continues by itself once the owner decides (up to 10 minutes).\n");
      result = await waitForApproval(result, call, input);
    }
    return { value: result, failed: result.isError === true };
  } finally { await session.close(); }
}

/**
 * Call one Cloud tool for another command (for example skill install). The
 * result is the tool's JSON; a failed call throws CloudToolError with the
 * server's error code. Writes are never retried.
 */
export async function callCloudTool(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const session = await connectCloud();
  try {
    const result = await session.client.callTool({ name, arguments: input }, undefined, { timeout: 180000 });
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
  } finally { await session.close(); }
}

