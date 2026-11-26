import { lstat } from "node:fs/promises";
import { runTodoDispatch, TODO_DISPATCH_TOOL } from "../task/todo-dispatch.js";
import { applySecretDrop, prepareSecretDrop, SECRET_DROP_APPLY_TOOL, SECRET_DROP_PREPARE_TOOL } from "../secret-drop.js";
import { siteLogin, siteLoginAvailable, SITE_LOGIN_TOOL } from "../vault/site-login.js";
import { hideSecrets, vaultEnvFor, type VaultEnv } from "../vault/note-env.js";
import { homedir } from "node:os";
import { dirname, sep } from "node:path";
import { createHash } from "node:crypto";
import type { MaintenanceGate } from "../update/maintenance.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ProcessManager } from "./process-manager.js";
import { FairRwScheduler } from "./scheduler.js";
import { safeEnv, Workspace } from "./workspace.js";

/** A read that should reach the model as an MCP image block next to its text metadata. */
class ImageResult {
  constructor(readonly meta: Record<string, unknown>, readonly data: string, readonly mimeType: string) {}
}
import { VERSION } from "../version.js";
import { changeWorkspaces, ensureWorkspaceRegistered, readWorkspaceState, WorkspaceConflictError, type WorkspaceOperation } from "./workspace-registry.js";
import { OutsideWorkspaceError, resolveWorkspace, resolveWorkspacePair } from "./workspace-router.js";
import type { LocalMcpHub } from "./local-mcp.js";
import type { LocalModelsHub } from "../provider/local-models.js";
import { customWritePath, pathGrantsFromMeta } from "./sandbox.js";
import { networkAllowFromMeta, webFetch } from "./web-fetch.js";
import { P2pTransfers, type P2pAddress } from "./p2p.js";
import { TRANSFER_TOOLS, transferAllowedFromMeta, transferDownload, transferPrepare, transferUpload, type TransferTarget } from "./transfer.js";

interface ToolFlags {
  readOnly: boolean;
  destructive: boolean;
  /** True when the tool reaches beyond this device and workspace (network, cloud, other servers). */
  openWorld: boolean;
  idempotent?: boolean;
}

export interface McpRuntimeOptions {
  maintenance?: MaintenanceGate;
  assertAuthorized?: () => void | Promise<void>;
  signal?: AbortSignal;
  maxConcurrentCommands?: number;
  onToolError?: (requestId: string | number, tool: string, error: unknown) => void;
  /** Enabled toolsets on the current MCP authorization; absent or empty means workspace only (plan §6.4). */
  getToolsets?: () => string[];
  /** Device-local MCP servers (plan mcp/本机MCP转发-方案.md). Without a hub the local_mcp_* tools stay hidden; with one they are always listed so an MCP client that cached tools/list before the owner enabled a name needs no reconnect. */
  localMcp?: LocalMcpHub;
  /** Names the owner enabled on the current MCP authorization; absent or empty makes the local_mcp_* tools answer that nothing is enabled yet. */
  getLocalMcps?: () => string[];
  /** Probes and shares loopback model servers from the daemon process. Without it (stdio mode) the local_models tool stays hidden. */
  localModels?: LocalModelsHub;
  /**
   * Managed service only. Called when a client runs exactly `frely self update`: the service upgrades itself (outside the command sandbox, release signature required,
   * idle-only) and switches over without anyone logging in. Resolves true when it took the request; false runs the command as usual.
   */
  requestUpgrade?: () => Promise<boolean>;
}

/** True for the exact command `frely self update` (surrounding and repeated whitespace ignored); anything else, including extra arguments or shell syntax, is an ordinary command. */
export function isSelfUpdateCommand(name: string, args: Record<string, unknown>): boolean {
  if (!(name === "run_command" || (name === "process" && args.action === "run"))) return false;
  return typeof args.command === "string" && args.command.trim().split(/\s+/u).join(" ") === "frely self update";
}

/** How long closing a session waits for running tool calls before it stops waiting and ends the processes. */
const ACTIVE_CALLS_DRAIN_MS = 5_000;

function enabledLocalMcps(options: McpRuntimeOptions): string[] {
  try { return options.localMcp ? options.getLocalMcps?.() ?? [] : []; } catch { return []; }
}

/** Gateway tools for device-local MCP servers (plan F1): one pair, whatever number of servers or transports sit behind them. */
export const LOCAL_MCP_TOOLS = [
  tool("local_mcp_list", "List the MCP servers running on this device that the owner enabled. With `server`, list that server's tools and their input schemas.", { server: stringSchema("Server name from the list; omit to list servers") }, { readOnly: true, destructive: false, openWorld: false }),
  tool("local_mcp_call", "Call one tool of an enabled MCP server running on this device (for example a browser extension that only listens on 127.0.0.1). Use local_mcp_list with `server` first to see the tools and arguments.", { server: stringSchema("Server name"), tool: stringSchema("Tool name on that server"), arguments: { type: "object", description: "Arguments for the tool", additionalProperties: true }, timeoutMs: intSchema(60000, 100, 120000) }, { readOnly: false, destructive: true, openWorld: true, idempotent: false }),
];

/**
 * Share this device's loopback OpenAI-compatible model server (Ollama, LM Studio, vLLM, llama.cpp) as a Frely Provider.
 * One tool, two actions; the daemon runs both, so probing is not limited by the command sandbox. It stays one tool for the
 * hosts' tool lists, so its hints are those of the stronger action (share).
 */
export const LOCAL_MODELS_TOOL = tool("local_models", "Use a model server running on this device (Ollama, LM Studio, vLLM, llama.cpp, mltf) through Frely. action=list probes loopback OpenAI-compatible servers (the given url, else the usual ports 11434, 1234, 8000, 8080) and lists their models plus the local models already shared. action=share publishes the server's models (all of them, or `models`) as a Frely Provider, which uses one Provider slot of the account (without a free slot it counts against the Creator Plan Provider limit). Shared models then appear in models_list marked local: true; they run on this device at no Credit cost and suit low-priority, slow-ok tasks. The device must stay online.", { action: { type: "string", enum: ["list", "share"] }, url: stringSchema("Loopback OpenAI-compatible base URL such as http://127.0.0.1:1234/v1. Required for share; for list it limits the probe to that server."), models: { type: "array", maxItems: 256, items: { type: "string", maxLength: 256 }, description: "Model ids to share; omit to share every model the server reports." }, name: stringSchema("Provider name shown in Frely (at most 128 characters)") }, { readOnly: false, destructive: false, openWorld: true, idempotent: false });

/** Logs in to a site with the user's Bitwarden vault; listed only where ego lite can run (macOS with ego-browser installed). */
export const SITE_LOGIN = tool(SITE_LOGIN_TOOL, "Log in to a website in ego lite with the login the user saved in their Frely Bitwarden vault. You never see the password; you get only whether it was submitted. If the vault is locked, call secret_drop with target {\"kind\":\"vault_unlock\"} on this device and give the user the link. If there is no saved login for the site, save one with secret_drop target {\"kind\":\"vault_item\",\"url\":\"<https login page>\"}; the user enters the username and password on the approval page.", { url: stringSchema("The https URL of the login page") }, { readOnly: false, destructive: false, openWorld: true, idempotent: false });

export async function createMcpServer(workspaceInput: string, options: McpRuntimeOptions = {}): Promise<Server> {
  const p2p = new P2pTransfers();
  // Ensure the primary workspace is registered
  await ensureWorkspaceRegistered(workspaceInput);

  // Load all registered workspaces; `workspaceInput` is the launch workspace, the primary until the owner chooses another.
  const workspaces = new Map<string, Workspace>();
  const launchRoot = (await Workspace.open(workspaceInput)).root;
  await syncWorkspaces(workspaces, launchRoot);

  const lifecycle = new AbortController();
  const assertAuthorized = async () => { lifecycle.signal.throwIfAborted(); await options.assertAuthorized?.(); };
  const maxConcurrentCommands = options.maxConcurrentCommands ?? 4;
  if (!Number.isSafeInteger(maxConcurrentCommands) || maxConcurrentCommands < 1 || maxConcurrentCommands > 16) {
    throw new Error("maxConcurrentCommands must be an integer between 1 and 16.");
  }
  const workspaceScheduler = new FairRwScheduler(4, assertAuthorized);
  const commandScheduler = new FairRwScheduler(maxConcurrentCommands, assertAuthorized);
  const processScheduler = new FairRwScheduler(64, assertAuthorized);
  const processes = new ProcessManager();
  const unregister = options.maintenance?.registerProcesses(() => processes.list().filter((p) => p.running).length);
  const server = new Server({ name: "frely-cli", version: VERSION }, { capabilities: { tools: {} } });

  const activeCalls = new Set<Promise<void>>();
  let cleanupPromise: Promise<void> | undefined;

  const cleanup = () => cleanupPromise ??= (async () => {
    // A call whose handler never returns must not hold the session open forever: it would stop the relay loop from reconnecting.
    const deadline = Date.now() + ACTIVE_CALLS_DRAIN_MS;
    while (activeCalls.size > 0 && Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...activeCalls]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); }),
      ]);
      clearTimeout(timer);
    }
    await processes.close();
    unregister?.();
  })();
  const stop = () => {
    lifecycle.abort();
    void cleanup().catch(() => undefined);
  };
  const sdkClose = server.close.bind(server);
  server.close = async () => {
    lifecycle.abort();
    try {
      await sdkClose();
    } finally {
      await cleanup();
    }
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  server.onclose = () => { options.signal?.removeEventListener("abort", stop); stop(); };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    ...(options.localMcp ? LOCAL_MCP_TOOLS : []),
    ...(options.localModels ? [LOCAL_MODELS_TOOL] : []),
    ...(siteLoginAvailable() ? [SITE_LOGIN] : []),
    tool("read", "Read the workspace. action=list lists a directory, or returns type/size/mtime for a file; read returns a UTF-8 file (max 1 MiB), or lines startLine..endLine; encoding=base64 returns any file as base64 with its sha256, encoding=image returns a png/jpeg/gif/webp the model can see (both max 1 MiB); search finds `query` in file contents; find matches file names (*, **, ?); roots lists workspace roots. Docs: https://github.com/FrelyHQ/frely-cli#local-execution-boundaries", { action: { type: "string", enum: ["list", "read", "search", "find", "roots"] }, path: stringSchema("Relative path", "."), encoding: { type: "string", enum: ["utf8", "base64", "image"], default: "utf8" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, query: { type: "string" }, regex: boolSchema(false), caseSensitive: boolSchema(false), maxResults: intSchema(100, 1, 1000), contextLines: intSchema(0, 0, 10) }, { readOnly: true, destructive: false, openWorld: false }),
    tool("edit_file", "Change a UTF-8 workspace file: `content` atomically writes the whole file, creating parent directories (overwrite=true to replace one); `contentBase64` does the same for binary data (max 1 MiB decoded); `edits` replaces line ranges. Delete, move and mkdir with process. Docs: https://github.com/FrelyHQ/frely-cli#local-execution-boundaries", { path: stringSchema("Relative path"), content: { type: "string" }, contentBase64: { type: "string" }, overwrite: boolSchema(false), edits: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, required: ["startLine", "endLine", "replacement"], properties: { startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, replacement: { type: "string" } } } } }, { readOnly: false, destructive: true, openWorld: false, idempotent: false }),
    tool("web_fetch", "Read a public http(s) URL (GET or HEAD, ports 80, 443) from this device's network; private addresses are refused. Read-only: it cannot send a request body. Returns status, content type and body text up to maxBytes. Docs: https://github.com/FrelyHQ/frely-cli#local-execution-boundaries", { url: { type: "string" }, method: { type: "string", enum: ["GET", "HEAD"], default: "GET" }, headers: { type: "object", additionalProperties: { type: "string" } }, maxBytes: intSchema(262144, 1, 1048576), timeoutMs: intSchema(30000, 100, 120000) }, { readOnly: true, destructive: false, openWorld: true }),
    tool("process", "Run shell commands as the current OS user, inside the OS sandbox, and refused when this device cannot sandbox them unless the owner turned the sandbox off: credential folders blocked (ask with request_permission), writes limited to workspace and temp, network to HTTP(S) and ssh (the connection needs no approval, but reading ~/.ssh config and keys does: request_permission resource=ssh). action=run waits up to timeoutMs and returns output; start returns an id for longer tasks; read returns output after stdoutCursor/stderrCursor; write sends `input` to stdin; list; stop. concurrency=exclusive for commands that change shared repo, dependency or build state.", { action: { type: "string", enum: ["run", "start", "read", "write", "list", "stop"] }, command: { type: "string" }, cwd: stringSchema("Relative path", "."), timeoutMs: intSchema(30000, 100, 120000), concurrency: { type: "string", enum: ["parallel", "exclusive"], default: "parallel" }, processId: { type: "string" }, stdoutCursor: intSchema(0, 0, Number.MAX_SAFE_INTEGER), stderrCursor: intSchema(0, 0, Number.MAX_SAFE_INTEGER), input: { type: "string" }, vaultItem: stringSchema("run/start only: name of a Bitwarden secure note on this device; its fields become environment variables of the command (values never shown; replaced with *** in output). Save one with secret_drop target vault_item name+fields.") }, { readOnly: false, destructive: true, openWorld: true, idempotent: false }),
  ] }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let complete: (() => void) | undefined;
    const active = new Promise<void>((resolve) => { complete = resolve; });
    activeCalls.add(active);
    const finish = options.maintenance?.track();
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    let vault: VaultEnv | undefined;
    try {
      if (name === "local_mcp_list" || name === "local_mcp_call") {
        const enabled = enabledLocalMcps(options);
        if (enabled.length === 0 || !options.localMcp) throw new Error("No local MCP is enabled for this device yet. Ask the user to enable one (for example computer) on the Frely connections page; it works right away, no reconnect needed.");
        const signal = AbortSignal.any([lifecycle.signal, extra.signal]);
        if (name === "local_mcp_list") {
          const server = optionalTextArg(args, "server");
          return { content: [{ type: "text" as const, text: JSON.stringify(await options.localMcp.list(enabled, server, signal)) }] };
        }
        const callArgs = args.arguments ?? {};
        if (!callArgs || typeof callArgs !== "object" || Array.isArray(callArgs)) throw new Error("arguments must be an object.");
        const result = await options.localMcp.call(enabled, textArg(args, "server"), textArg(args, "tool"), callArgs as Record<string, unknown>, { timeoutMs: intArg(args, "timeoutMs", 60000, 100, 120000), signal });
        return result as { content: Array<{ type: "text"; text: string }>; isError?: boolean };
      }
      if (name === SITE_LOGIN.name) {
        if (!siteLoginAvailable()) throw new Error("site_login needs ego-browser on this computer (macOS).");
        return { content: [{ type: "text" as const, text: JSON.stringify(await siteLogin(args.url, { signal: AbortSignal.any([lifecycle.signal, extra.signal]) })) }] };
      }
      if (name === LOCAL_MODELS_TOOL.name) {
        if (!options.localModels) throw new Error("Sharing local models is not available on this connection.");
        const signal = AbortSignal.any([lifecycle.signal, extra.signal]);
        const action = textArg(args, "action");
        const url = optionalTextArg(args, "url");
        if (action === "list") return { content: [{ type: "text" as const, text: JSON.stringify(await options.localModels.list(url, signal)) }] };
        if (action !== "share") throw new Error("action must be one of list, share.");
        if (!url) throw new Error("url is required to share a model server; call local_models with action=list to find one.");
        const models = args.models === undefined ? undefined : arrayArg(args, "models", 1, 256).map((model) => { if (typeof model !== "string") throw new Error("models must be strings."); return model.trim(); }).filter(Boolean);
        const providerName = optionalTextArg(args, "name");
        return { content: [{ type: "text" as const, text: JSON.stringify(await options.localModels.share({ url, ...(models?.length ? { models } : {}), ...(providerName ? { name: providerName.slice(0, 128) } : {}) }, signal)) }] };
      }
      // `frely link workspace add|remove` edits the registry while this runtime keeps running; pick the change up per call.
      const primaryRoot = await syncWorkspaces(workspaces, launchRoot);
      if (name === TODO_DISPATCH_TOOL) {
        // Relay-made, never listed. `start` needs a passkey todo_scope approval this device verifies itself.
        return { content: [{ type: "text" as const, text: JSON.stringify(await runTodoDispatch(args, request.params._meta)) }] };
      }
      if (name === SECRET_DROP_PREPARE_TOOL || name === SECRET_DROP_APPLY_TOOL) {
        // Relay-made, never listed. The receipt carries no part of the value; `apply` verifies the owner's passkey approval itself.
        return { content: [{ type: "text" as const, text: JSON.stringify(name === SECRET_DROP_PREPARE_TOOL ? prepareSecretDrop(args) : await applySecretDrop(args)) }] };
      }
      if (name === WORKSPACE_MANAGE_TOOL) {
        const state = await manageWorkspaces(args, request.params._meta, launchRoot);
        await syncWorkspaces(workspaces, launchRoot);
        return { content: [{ type: "text" as const, text: JSON.stringify(state) }] };
      }
      if (options.requestUpgrade && isSelfUpdateCommand(name, args) && await options.requestUpgrade()) {
        return { content: [{ type: "text" as const, text: "The service is upgrading itself to the latest signed Frely release. No approval is needed. It installs once running work is finished, then restarts and reconnects on its own; this connection may drop briefly. Check with frely doctor." }] };
      }
      vault = await vaultEnvFor(name, args, request.params._meta);
      const dispatched = await dispatch(name, args, workspaces, primaryRoot, processes, workspaceScheduler, commandScheduler, processScheduler, AbortSignal.any([lifecycle.signal, extra.signal]), pathGrantsFromMeta(request.params._meta), networkAllowFromMeta(request.params._meta), transferAllowedFromMeta(request.params._meta), p2p, vault);
      const result = vault ? hideSecrets(dispatched, vault.secrets) : dispatched;
      if (result instanceof ImageResult) {
        return { content: [{ type: "image" as const, data: result.data, mimeType: result.mimeType }, { type: "text" as const, text: JSON.stringify(result.meta) }] };
      }
      return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }] };
    } catch (error) {
      try { options.onToolError?.(extra.requestId, name, error); } catch { /* Diagnostics cannot change tool results. */ }
      const message = error instanceof Error ? error.message : "Local tool failed.";
      return { isError: true, content: [{ type: "text" as const, text: vault ? hideSecrets(message, vault.secrets) : message }] };
    } finally {
      finish?.();
      complete?.();
      activeCalls.delete(active);
    }
  });

  return server;
}

/** Make `workspaces` match the registry: open added roots, drop removed ones, and return the effective primary root. */
async function syncWorkspaces(workspaces: Map<string, Workspace>, launchRoot: string): Promise<string> {
  const state = await readWorkspaceState(launchRoot);
  const roots = new Set(state.workspaces);
  for (const root of [...workspaces.keys()]) if (!roots.has(root)) workspaces.delete(root);
  for (const root of state.workspaces) {
    if (workspaces.has(root)) continue;
    // A root that vanished from disk must not break calls to the other workspaces.
    try { workspaces.set(root, await Workspace.open(root)); } catch { /* skipped until it is valid again */ }
  }
  // Primary first, so listings show it first.
  const ordered = state.workspaces.filter((root) => workspaces.has(root)).map((root) => [root, workspaces.get(root)!] as const);
  workspaces.clear();
  for (const [root, workspace] of ordered) workspaces.set(root, workspace);
  return state.primary;
}

/** Relay-made call that changes workspaces after the owner confirmed it on the web; never listed, and the relay strips this meta from client calls. */
export const WORKSPACE_MANAGE_TOOL = "workspace_manage";
export const WORKSPACE_CHANGE_META_KEY = "frely/workspace-change";

async function manageWorkspaces(args: Record<string, unknown>, meta: unknown, launchRoot: string): Promise<unknown> {
  const op = textArg(args, "action") as WorkspaceOperation;
  if (op !== "add" && op !== "remove" && op !== "primary") throw new Error("action must be one of add, remove, primary.");
  const path = textArg(args, "path");
  const expectedRev = args.expectedRev;
  if (typeof expectedRev !== "number" || !Number.isSafeInteger(expectedRev) || expectedRev < 0) throw new Error("expectedRev is required.");
  // The approval the owner gave on the web, bound to exactly this operation, path and configuration version.
  const proof = meta && typeof meta === "object" ? (meta as Record<string, unknown>)[WORKSPACE_CHANGE_META_KEY] as Record<string, unknown> | undefined : undefined;
  if (!proof || typeof proof.approvalId !== "string" || !proof.approvalId || proof.action !== op || proof.path !== path || proof.expectedRev !== expectedRev) {
    throw new Error("This workspace change was not approved. Confirm it on the Frely web page for this device.");
  }
  try { return await changeWorkspaces(op, path, launchRoot, expectedRev); }
  catch (error) { if (error instanceof WorkspaceConflictError) throw new Error(`workspace_config_changed: ${error.message}`); throw error; }
}

export async function startStdioMcp(workspaceInput: string, options: McpRuntimeOptions = {}): Promise<void> {
  const server = await createMcpServer(workspaceInput, options);
  await server.connect(new StdioServerTransport());
}

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  workspaces: Map<string, unknown>,
  primaryRoot: string,
  processes: ProcessManager,
  workspaceScheduler: FairRwScheduler,
  commandScheduler: FairRwScheduler,
  processScheduler: FairRwScheduler,
  signal: AbortSignal,
  pathGrants: readonly string[] = [],
  networkAllow: readonly string[] = [],
  transferAllowed = false,
  p2p: P2pTransfers = new P2pTransfers(),
  vault?: VaultEnv,
): Promise<unknown> {
  const guarded = <T>(work: () => Promise<T>) => async () => { signal.throwIfAborted(); return work(); };
  // Directories the owner approved on the web (`path:` grants) act as workspaces for this call only; nothing is stored here.
  let grantedWorkspaces: Map<string, Workspace> | undefined;
  const grantedFor = async () => grantedWorkspaces ??= await grantWorkspaces(pathGrants);
  let granted: ReadonlyMap<string, Workspace> = new Map();
  const routed = async <T>(route: () => T): Promise<T> => {
    granted = pathGrants.some((grant) => grant.startsWith("path:")) ? await grantedFor() : new Map();
    try { return route(); } catch (error) {
      if (error instanceof OutsideWorkspaceError) throw new Error(await outsideMessage(error.input));
      throw error;
    }
  };
  const read = <T>(work: () => Promise<T>) => workspaceScheduler.read(guarded(work), signal);
  const write = <T>(work: () => Promise<T>) => workspaceScheduler.write(guarded(work), signal);
  const processRead = <T>(work: () => Promise<T>) => processScheduler.read(guarded(work), signal);

  // Special case: workspace_info returns {root, workspaces} for all workspaces
  if (name === "workspace_info") {
    return read(async () => ({
      root: primaryRoot,
      workspaces: Array.from(workspaces.keys()),
      rev: (await readWorkspaceState(primaryRoot)).rev,
    }));
  }

  // Merged tools route to the former per-action tools, which still answer under their old names.
  const merged = ({
    read: { list: "list_directory", read: "read_file", search: "search_files", find: "find_files", roots: "workspace_info" },
    process: { run: "run_command", start: "start_process", list: "list_processes", read: "read_process", write: "write_process", stop: "stop_process" },
  } as Record<string, Record<string, string>>)[name];
  if (merged) {
    const action = textArg(args, "action");
    const mapped = Object.hasOwn(merged, action) ? merged[action] : undefined;
    if (!mapped) throw new Error(`action must be one of ${Object.keys(merged).join(", ")}.`);
    const routed = mapped === "find_files" ? { ...args, pattern: args.query } : args;
    return dispatch(mapped, routed, workspaces, primaryRoot, processes, workspaceScheduler, commandScheduler, processScheduler, signal, pathGrants, networkAllow, transferAllowed, p2p, vault);
  }
  if (name === "edit_file") {
    if ([args.content, args.contentBase64, args.edits].filter((value) => value !== undefined).length !== 1) throw new Error("Pass exactly one of content, contentBase64 or edits.");
    return dispatch(args.edits === undefined ? "write_file" : "apply_patch", args, workspaces, primaryRoot, processes, workspaceScheduler, commandScheduler, processScheduler, signal, pathGrants, networkAllow, transferAllowed, p2p, vault);
  }

  // Process-management tools address a process id, not a path: no workspace routing.
  if (name === "list_processes") return processRead(async () => processes.list());
  if (name === "read_process") return processRead(async () => processes.read(textArg(args, "processId"), intArg(args, "stdoutCursor", 0, 0, Number.MAX_SAFE_INTEGER), intArg(args, "stderrCursor", 0, 0, Number.MAX_SAFE_INTEGER)));
  if (name === "write_process") return processRead(() => processes.write(textArg(args, "processId"), textArg(args, "input")));
  if (name === "stop_process") return processRead(() => processes.stop(textArg(args, "processId")));

  // Hidden from tools/list: only the relay's transfer tool calls these, and it marks them in `_meta`.
  if (TRANSFER_TOOLS.has(name)) {
    if (!transferAllowed) throw new Error(`Unknown tool: ${name}`);
    if (name === "transfer_p2p_info") return p2p.info();
    if (name === "transfer_p2p_status") return p2p.status(textArg(args, "jobId"));
    if (name === "transfer_p2p_cancel") return p2p.cancel(textArg(args, "jobId"));
    const resolvedPath = await routed(() => resolveWorkspace(workspaces as Map<string, Workspace>, textArg(args, "path"), granted));
    const transferWorkspace = resolvedPath.workspace.withGrants(pathGrants);
    if (name === "transfer_p2p_listen" || name === "transfer_p2p_send") {
      const p2pBytes = intArg(args, "bytes", 0, 1, 104857600), p2pSha = textArg(args, "sha256");
      if (!/^[0-9a-f]{64}$/u.test(p2pSha)) throw new Error("sha256 must be 64 hex characters.");
      if (name === "transfer_p2p_listen") {
        return write(() => p2p.listen(transferWorkspace, { path: resolvedPath.relativeInput, bytes: p2pBytes, sha256: p2pSha, overwrite: boolArg(args, "overwrite", false), from: textArg(args, "from"), relayUrl: args.relayUrl }));
      }
      const to = args.to as Partial<P2pAddress> | undefined;
      if (!to || typeof to.id !== "string" || !Array.isArray(to.directAddresses)) throw new Error("to must be the other device's address.");
      return read(() => p2p.send(transferWorkspace, { path: resolvedPath.relativeInput, bytes: p2pBytes, sha256: p2pSha, to: { id: to.id!, relayUrl: typeof to.relayUrl === "string" ? to.relayUrl : null, directAddresses: to.directAddresses!.filter((entry): entry is string => typeof entry === "string").slice(0, 16) }, relayUrl: args.relayUrl }));
    }
    if (name === "transfer_prepare") return read(() => transferPrepare(transferWorkspace, resolvedPath.relativeInput));
    // The link is chosen by the Relay, so connect() in transfer.ts accepts only Frely's object-store hosts; that allowlist closes plan gap G4.
    const headers = args.headers ?? {};
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("headers must be an object.");
    const target: TransferTarget = { url: textArg(args, "url"), headers: headers as Record<string, string> };
    const expected = { bytes: intArg(args, "bytes", 0, 1, 104857600), sha256: textArg(args, "sha256") };
    if (!/^[0-9a-f]{64}$/u.test(expected.sha256)) throw new Error("sha256 must be 64 hex characters.");
    if (name === "transfer_upload") return read(() => transferUpload(transferWorkspace, resolvedPath.relativeInput, target, expected, signal));
    return write(() => transferDownload(transferWorkspace, resolvedPath.relativeInput, target, expected, boolArg(args, "overwrite", false), signal));
  }

  // Network access is not a workspace operation: no path routing, no workspace locks.
  if (name === "web_fetch") {
    const headers = args.headers ?? {};
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("headers must be an object.");
    const method = optionalTextArg(args, "method");
    return webFetch({
      url: textArg(args, "url"),
      ...(method ? { method: method as "GET" | "HEAD" } : {}),
      headers: headers as Record<string, string>,
      maxBytes: intArg(args, "maxBytes", 262144, 1, 1048576),
      timeoutMs: intArg(args, "timeoutMs", 30000, 100, 120000),
    }, { signal, allow: networkAllow });
  }

  // For all other tools, resolve the workspace based on the input path/cwd
  const resolved = await routed(() => resolveWorkspace(
    workspaces as Map<string, Workspace>,
    name === "run_command" || name === "start_process" ? textArg(args, "cwd", ".") : (name === "move_path" ? textArg(args, "from", ".") : textArg(args, "path", ".")),
    granted,
  ));
  const workspace = resolved.workspace.withGrants(pathGrants), relativeInput = resolved.relativeInput;

  if (name === "list_directory") {
    return read(async () => {
      const info = await workspace.statPath(relativeInput);
      return info.type === "directory" && !boolArg(args, "stat", false) ? workspace.listDirectory(relativeInput) : info;
    });
  }
  if (name === "stat_path") return read(() => workspace.statPath(relativeInput));
  if (name === "find_files") return read(() => workspace.findFiles(relativeInput, textArg(args, "pattern"), intArg(args, "maxResults", 100, 1, 1000)));
  if (name === "search_files" && args.mode === "name") return read(() => workspace.findFiles(relativeInput, textArg(args, "query"), intArg(args, "maxResults", 100, 1, 1000)));
  if (name === "search_files") return read(() => workspace.searchFiles(relativeInput, textArg(args, "query"), { regex: boolArg(args, "regex", false), caseSensitive: boolArg(args, "caseSensitive", false), maxResults: intArg(args, "maxResults", 100, 1, 500), contextLines: intArg(args, "contextLines", 0, 0, 10) }));
  if (name === "read_file" && (args.startLine !== undefined || args.endLine !== undefined)) return read(() => workspace.readFileLines(relativeInput, intArg(args, "startLine", 1, 1, Number.MAX_SAFE_INTEGER), optionalIntArg(args, "endLine", 1, Number.MAX_SAFE_INTEGER)));
  if (name === "read_file" && args.encoding !== undefined && args.encoding !== "utf8") {
    if (args.encoding !== "base64" && args.encoding !== "image") throw new Error("encoding must be one of utf8, base64, image.");
    return read(async () => {
      const file = await workspace.readFileBytes(relativeInput).catch((error: unknown) => {
        if (error instanceof Error && /exceeds 1 MiB/u.test(error.message)) throw new Error(`${error.message} Do not send it through the model: run \`frely file put <file>\` to share it as a link (https://frely.cloud/f/<code>) and give the user that link.`);
        throw error;
      });
      const meta = { path: file.path, bytes: file.bytes, mimeType: file.mimeType, sha256: createHash("sha256").update(file.data).digest("hex") };
      const base64 = file.data.toString("base64");
      if (args.encoding === "image") {
        if (!file.mimeType.startsWith("image/")) throw new Error("Not a png, jpeg, gif or webp image; read it with encoding=base64.");
        return new ImageResult(meta, base64, file.mimeType);
      }
      return { ...meta, encoding: "base64", content: base64 };
    });
  }
  if (name === "read_file") return read(() => workspace.readFile(relativeInput));
  if (name === "read_file_lines") return read(() => workspace.readFileLines(relativeInput, intArg(args, "startLine", 1, 1, Number.MAX_SAFE_INTEGER), optionalIntArg(args, "endLine", 1, Number.MAX_SAFE_INTEGER)));
  if (name === "write_file" && boolArg(args, "directory", false)) return write(() => workspace.createDirectory(relativeInput));
  if (name === "write_file" && args.contentBase64 !== undefined) {
    const encoded = textArg(args, "contentBase64");
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw new Error("contentBase64 is not valid base64.");
    const data = Buffer.from(encoded, "base64");
    return write(() => workspace.writeFile(relativeInput, data, boolArg(args, "overwrite", false)));
  }
  if (name === "write_file") return write(() => workspace.writeFile(relativeInput, textArg(args, "content"), boolArg(args, "overwrite", false)));
  if (name === "apply_patch") return write(() => workspace.applyPatch(relativeInput, arrayArg(args, "edits", 1, 100), optionalTextArg(args, "expectedSha256")));
  if (name === "create_directory") return write(() => workspace.createDirectory(relativeInput));
  if (name === "delete_path") return write(() => workspace.deletePath(relativeInput, boolArg(args, "recursive", false)));
  if (name === "move_path") {
    const pair = await routed(() => resolveWorkspacePair(workspaces as Map<string, Workspace>, textArg(args, "from", "."), textArg(args, "to"), granted));
    return write(() => pair.workspace.withGrants(pathGrants).movePath(pair.relativeFrom, pair.relativeTo, boolArg(args, "overwrite", false)));
  }
  if (name === "run_command") {
    const command = textArg(args, "command");
    const timeoutMs = intArg(args, "timeoutMs", 30000, 100, 120000);
    let started = false;
    const work = () => { started = true; return workspace.runCommand(command, relativeInput, timeoutMs, signal, pathGrants, vault?.env); };
    // Waiting for a free slot counts against the same timeout: otherwise queue time plus run time outlasts the relay's wait,
    // the call is cancelled with no answer, and the client retries into a longer queue.
    const queueLimit = AbortSignal.timeout(timeoutMs);
    const queued = AbortSignal.any([signal, queueLimit]);
    const run = concurrencyArg(args) === "exclusive" ? commandScheduler.write(guarded(work), queued) : commandScheduler.read(guarded(work), queued);
    return run.catch((error: unknown) => {
      if (!started && queueLimit.aborted && !signal.aborted) throw new Error(`The device is busy: the command waited ${timeoutMs} ms for other commands to finish and did not start. Try again, or use process start for long commands.`);
      throw error;
    });
  }
  if (name === "start_process") {
    const command = textArg(args, "command");
    return processRead(async () => {
      const cwdPath = await workspace.processCwd(relativeInput);
      signal.throwIfAborted();
      return processes.start(command, cwdPath, { ...safeEnv(), ...vault?.env }, workspace.root, pathGrants, vault?.secrets);
    });
  }
  throw new Error(`Unknown tool: ${name}`);
}

/** One workspace per existing `path:` directory the owner approved for this call, with those grants applied so credential folders stay protected. */
async function grantWorkspaces(pathGrants: readonly string[]): Promise<Map<string, Workspace>> {
  const result = new Map<string, Workspace>();
  for (const grant of pathGrants) {
    const dir = grant.startsWith("path:") ? customWritePath(grant) : undefined;
    if (!dir) continue;
    try {
      const workspace = (await Workspace.open(dir)).withGrants(pathGrants);
      result.set(workspace.root, workspace);
    } catch { /* A missing or non-directory grant is skipped. */ }
  }
  return result;
}

/** The error for a path no workspace or approved directory contains, naming the `path:` resource to ask the owner for. */
async function outsideMessage(input: string): Promise<string> {
  const stat = await lstat(input).catch(() => undefined);
  const dir = stat?.isDirectory() ? input : dirname(input);
  const home = homedir();
  // `path:` resources spell paths with forward slashes, also on Windows (`D:/work`).
  const shown = dir === home ? "~" : dir.startsWith(home + sep) ? `~/${dir.slice(home.length + 1).split(sep).join("/")}` : dir.split(sep).join("/");
  return `${input} is outside the workspace. To work there, call request_permission with resource "path:${shown}" and tool "files" (the owner approves on the web), then repeat this call.`;
}

function tool(name: string, description: string, properties: Record<string, unknown>, flags: ToolFlags) {
  return {
    name,
    description,
    inputSchema: { type: "object", additionalProperties: false, properties },
    annotations: {
      readOnlyHint: flags.readOnly,
      destructiveHint: flags.destructive,
      openWorldHint: flags.openWorld,
      idempotentHint: flags.idempotent ?? flags.readOnly,
    },
  };
}

function stringSchema(description: string, defaultValue?: string) { return { type: "string", description, ...(defaultValue === undefined ? {} : { default: defaultValue }) }; }
function intSchema(defaultValue: number, minimum: number, maximum: number) { return { type: "integer", minimum, maximum, default: defaultValue }; }
function boolSchema(defaultValue: boolean) { return { type: "boolean", default: defaultValue }; }
function textArg(args: Record<string, unknown>, name: string, fallback?: string): string { const value = args[name] ?? fallback; if (typeof value !== "string") throw new Error(`${name} must be a string.`); return value; }
function optionalTextArg(args: Record<string, unknown>, name: string): string | undefined { const value = args[name]; if (value === undefined) return undefined; if (typeof value !== "string") throw new Error(`${name} must be a string.`); return value; }
function intArg(args: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number { const value = args[name] ?? fallback; if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} is invalid.`); return Number(value); }
function optionalIntArg(args: Record<string, unknown>, name: string, min: number, max: number): number | undefined { const value = args[name]; if (value === undefined) return undefined; if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} is invalid.`); return Number(value); }
function boolArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean { const value = args[name] ?? fallback; if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`); return value; }
function arrayArg(args: Record<string, unknown>, name: string, min: number, max: number): unknown[] { const value = args[name]; if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${name} must contain ${min}-${max} entries.`); return value; }
function concurrencyArg(args: Record<string, unknown>): "parallel" | "exclusive" { const value = args.concurrency ?? "parallel"; if (value !== "parallel" && value !== "exclusive") throw new Error("concurrency must be parallel or exclusive."); return value; }
