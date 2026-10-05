import type { MaintenanceGate } from "../update/maintenance.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ProcessManager } from "./process-manager.js";
import { FairRwScheduler } from "./scheduler.js";
import { safeEnv, Workspace } from "./workspace.js";
import { VERSION } from "../version.js";
import { ensureWorkspaceRegistered, listWorkspaces } from "./workspace-registry.js";
import { resolveWorkspace, resolveWorkspacePair } from "./workspace-router.js";
import type { LocalMcpHub } from "./local-mcp.js";
import { pathGrantsFromMeta } from "./sandbox.js";
import { networkAllowFromMeta, webFetch } from "./web-fetch.js";

interface ToolFlags {
  readOnly: boolean;
  destructive?: boolean;
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
  /** Bridge for agent_* tools (frely-app toolset). Without it agent tools stay hidden. */
  callAgent?: (op: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Device-local MCP servers (plan mcp/本机MCP转发-方案.md). Without a hub the local_mcp_* tools stay hidden. */
  localMcp?: LocalMcpHub;
  /** Names the owner enabled on the current MCP authorization; absent or empty hides the local_mcp_* tools. */
  getLocalMcps?: () => string[];
}

/** agent_* MCP tools exposed when the frely-app toolset is enabled (plan §5). */
export const AGENT_TOOLS = [
  { op: "agent_start_task", description: "Start an agent task in a worktree. Returns immediately; poll agent_get_task/agent_get_events.", properties: { goal: stringSchema("What the task should accomplish"), workspace: stringSchema("Workspace root (defaults to the relay workspace)"), model: stringSchema("Model id"), maxCostUsd: { type: "number", minimum: 0.01, maximum: 50 } }, required: ["goal"] },
  { op: "agent_list_tasks", description: "List agent tasks for a workspace.", properties: { workspace: stringSchema("Workspace root (defaults to the relay workspace)") }, required: [] },
  { op: "agent_get_task", description: "Fetch one agent task by id.", properties: { taskId: stringSchema("Task id") }, required: ["taskId"] },
  { op: "agent_get_events", description: "Page agent task events from a cursor.", properties: { taskId: stringSchema("Task id"), cursor: { type: "integer", minimum: 0 } }, required: ["taskId"] },
  { op: "agent_send_message", description: "Send a user message to a running agent task.", properties: { taskId: stringSchema("Task id"), message: stringSchema("Message text") }, required: ["taskId", "message"] },
  { op: "agent_get_diff", description: "Get the unified diff of a task worktree.", properties: { taskId: stringSchema("Task id"), path: stringSchema("Limit the diff to one path") }, required: ["taskId"] },
  { op: "agent_request_merge", description: "Ask the task to wrap up and produce a merge request.", properties: { taskId: stringSchema("Task id"), note: stringSchema("Instruction for wrapping up") }, required: ["taskId"] },
  { op: "agent_discard_task", description: "Discard a task and delete its worktree.", properties: { taskId: stringSchema("Task id") }, required: ["taskId"] },
  { op: "agent_cancel_task", description: "Cancel a task; the worktree is kept.", properties: { taskId: stringSchema("Task id") }, required: ["taskId"] },
] as const;

function enabledLocalMcps(options: McpRuntimeOptions): string[] {
  try { return options.localMcp ? options.getLocalMcps?.() ?? [] : []; } catch { return []; }
}

function enabledToolsets(options: McpRuntimeOptions): string[] {
  try { return options.getToolsets?.() ?? ["workspace"]; } catch { return ["workspace"]; }
}

/** Gateway tools for device-local MCP servers (plan F1): one pair, whatever number of servers or transports sit behind them. */
export const LOCAL_MCP_TOOLS = [
  tool("local_mcp_list", "List the MCP servers running on this device that the owner enabled. With `server`, list that server's tools and their input schemas.", { server: stringSchema("Server name from the list; omit to list servers") }, { readOnly: true }),
  tool("local_mcp_call", "Call one tool of an enabled MCP server running on this device (for example a browser extension that only listens on 127.0.0.1). Use local_mcp_list with `server` first to see the tools and arguments.", { server: stringSchema("Server name"), tool: stringSchema("Tool name on that server"), arguments: { type: "object", description: "Arguments for the tool", additionalProperties: true }, timeoutMs: intSchema(60000, 100, 120000) }, { readOnly: false, destructive: true, idempotent: false }),
];

export async function createMcpServer(workspaceInput: string, options: McpRuntimeOptions = {}): Promise<Server> {
  // Ensure the primary workspace is registered
  await ensureWorkspaceRegistered(workspaceInput);

  // Load all registered workspaces
  const roots = await listWorkspaces();
  const workspaces = new Map<string, Workspace>();
  for (const root of roots) {
    workspaces.set(root, await Workspace.open(root));
  }

  // Get the primary workspace root (realpath-ed)
  const primaryWorkspace = await Workspace.open(workspaceInput);
  const primaryRoot = primaryWorkspace.root;

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
    while (activeCalls.size > 0) {
      await Promise.allSettled([...activeCalls]);
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
    ...((enabledToolsets(options).includes("frely-app") && options.callAgent)
      ? AGENT_TOOLS.map((entry) => tool(entry.op, entry.description, entry.properties, { readOnly: entry.op === "agent_get_task" || entry.op === "agent_get_events" || entry.op === "agent_list_tasks" }))
      : []),
    ...(enabledLocalMcps(options).length > 0 ? LOCAL_MCP_TOOLS : []),
    tool("workspace_info", "Return the active workspace root.", {}, { readOnly: true }),
    tool("list_directory", "List one workspace directory.", { path: stringSchema("Relative directory path", ".") }, { readOnly: true }),
    tool("stat_path", "Inspect one workspace file or directory.", { path: stringSchema("Relative path") }, { readOnly: true }),
    tool("find_files", "Find workspace files using *, ** and ? wildcards.", { path: stringSchema("Relative directory path", "."), pattern: stringSchema("Wildcard pattern"), maxResults: intSchema(100, 1, 1000) }, { readOnly: true }),
    tool("search_files", "Search UTF-8 workspace files.", { path: stringSchema("Relative directory path", "."), query: stringSchema("Search text or regex"), regex: boolSchema(false), caseSensitive: boolSchema(false), maxResults: intSchema(100, 1, 500), contextLines: intSchema(0, 0, 10) }, { readOnly: true }),
    tool("read_file", "Read a UTF-8 workspace file up to 1 MiB.", { path: stringSchema("Relative file path") }, { readOnly: true }),
    tool("read_file_lines", "Read a line range from a UTF-8 workspace file.", { path: stringSchema("Relative file path"), startLine: intSchema(1, 1, Number.MAX_SAFE_INTEGER), endLine: { type: "integer", minimum: 1 } }, { readOnly: true }),
    tool("write_file", "Atomically write a UTF-8 workspace file.", { path: stringSchema("Relative file path"), content: stringSchema("Complete file content"), overwrite: boolSchema(false) }, { readOnly: false, idempotent: false }),
    tool("apply_patch", "Apply non-overlapping line replacements to a UTF-8 workspace file.", { path: stringSchema("Relative file path"), expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, edits: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, required: ["startLine", "endLine", "replacement"], properties: { startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, replacement: { type: "string" } } } } }, { readOnly: false, idempotent: false }),
    tool("create_directory", "Create a workspace directory.", { path: stringSchema("Relative directory path") }, { readOnly: false, idempotent: true }),
    tool("delete_path", "Delete a workspace path. Recursive directory deletion requires recursive=true.", { path: stringSchema("Relative path"), recursive: boolSchema(false) }, { readOnly: false, destructive: true, idempotent: false }),
    tool("move_path", "Move or rename a workspace path.", { from: stringSchema("Source path"), to: stringSchema("Destination path"), overwrite: boolSchema(false) }, { readOnly: false, destructive: true, idempotent: false }),
    tool(
      "run_command",
      "Run a shell command as the current OS user. Workspace only constrains cwd; this is not a sandbox. Parallel mode allows bounded command concurrency; use exclusive for commands that mutate shared repository, dependency, build, migration, or release state.",
      {
        command: stringSchema("Shell command"),
        cwd: stringSchema("Relative working directory", "."),
        timeoutMs: intSchema(30000, 100, 120000),
        concurrency: { type: "string", enum: ["parallel", "exclusive"], default: "parallel" },
      },
      { readOnly: false, destructive: true, idempotent: false },
    ),
    tool("web_fetch", "Fetch a public web page or API from this device's own network connection (GET, HEAD or POST over http/https, ports 80 and 443). Addresses on private or local networks are refused. Returns status, content type and the body as text, up to maxBytes.", { url: stringSchema("http or https URL"), method: { type: "string", enum: ["GET", "HEAD", "POST"], default: "GET" }, headers: { type: "object", description: "Extra request headers", additionalProperties: { type: "string" } }, body: stringSchema("Request body for POST"), maxBytes: intSchema(262144, 1, 1048576), timeoutMs: intSchema(30000, 100, 120000) }, { readOnly: false, idempotent: false }),
    tool("start_process", "Start a persistent shell process as the current OS user.", { command: stringSchema("Shell command"), cwd: stringSchema("Relative working directory", ".") }, { readOnly: false, destructive: true, idempotent: false }),
    tool("list_processes", "List processes started by this MCP runtime.", {}, { readOnly: true }),
    tool("read_process", "Read process output using absolute cursors.", { processId: stringSchema("Process id"), stdoutCursor: intSchema(0, 0, Number.MAX_SAFE_INTEGER), stderrCursor: intSchema(0, 0, Number.MAX_SAFE_INTEGER) }, { readOnly: true }),
    tool("write_process", "Write stdin to a running process.", { processId: stringSchema("Process id"), input: stringSchema("Input text") }, { readOnly: false, destructive: true, idempotent: false }),
    tool("stop_process", "Stop a process started by this MCP runtime.", { processId: stringSchema("Process id") }, { readOnly: false, destructive: true, idempotent: true }),
  ] }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let complete: (() => void) | undefined;
    const active = new Promise<void>((resolve) => { complete = resolve; });
    activeCalls.add(active);
    const finish = options.maintenance?.track();
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name.startsWith("agent_")) {
        if (!enabledToolsets(options).includes("frely-app") || !options.callAgent) {
          throw new Error("Agent tools are not enabled for this MCP permission. Enable Frely app tools on the Frely connections page.");
        }
        const result = await options.callAgent(name, args);
        return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }] };
      }
      if (name === "local_mcp_list" || name === "local_mcp_call") {
        const enabled = enabledLocalMcps(options);
        if (enabled.length === 0 || !options.localMcp) throw new Error("Local MCP access is not enabled for this device. Enable a local MCP on the Frely connections page.");
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
      // `frely mcp workspace add|remove` edits the registry while this runtime keeps running; pick the change up per call.
      await syncWorkspaces(workspaces, primaryRoot);
      const result = await dispatch(name, args, workspaces, primaryRoot, processes, workspaceScheduler, commandScheduler, processScheduler, AbortSignal.any([lifecycle.signal, extra.signal]), pathGrantsFromMeta(request.params._meta), networkAllowFromMeta(request.params._meta));
      return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }] };
    } catch (error) {
      try { options.onToolError?.(extra.requestId, name, error); } catch { /* Diagnostics cannot change tool results. */ }
      return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Local tool failed." }] };
    } finally {
      finish?.();
      complete?.();
      activeCalls.delete(active);
    }
  });

  return server;
}

/** Make `workspaces` match the registry: open added roots, drop removed ones. The primary root always stays. */
async function syncWorkspaces(workspaces: Map<string, Workspace>, primaryRoot: string): Promise<void> {
  const roots = new Set(await listWorkspaces());
  roots.add(primaryRoot);
  for (const root of [...workspaces.keys()]) if (!roots.has(root)) workspaces.delete(root);
  for (const root of roots) {
    if (workspaces.has(root)) continue;
    // A root that vanished from disk must not break calls to the other workspaces.
    try { workspaces.set(root, await Workspace.open(root)); } catch { /* skipped until it is valid again */ }
  }
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
): Promise<unknown> {
  const guarded = <T>(work: () => Promise<T>) => async () => { signal.throwIfAborted(); return work(); };
  const read = <T>(work: () => Promise<T>) => workspaceScheduler.read(guarded(work));
  const write = <T>(work: () => Promise<T>) => workspaceScheduler.write(guarded(work));
  const processRead = <T>(work: () => Promise<T>) => processScheduler.read(guarded(work));

  // Special case: workspace_info returns {root, workspaces} for all workspaces
  if (name === "workspace_info") {
    return read(async () => ({
      root: primaryRoot,
      workspaces: Array.from(workspaces.keys()),
    }));
  }

  // Process-management tools address a process id, not a path: no workspace routing.
  if (name === "list_processes") return processRead(async () => processes.list());
  if (name === "read_process") return processRead(async () => processes.read(textArg(args, "processId"), intArg(args, "stdoutCursor", 0, 0, Number.MAX_SAFE_INTEGER), intArg(args, "stderrCursor", 0, 0, Number.MAX_SAFE_INTEGER)));
  if (name === "write_process") return processRead(() => processes.write(textArg(args, "processId"), textArg(args, "input")));
  if (name === "stop_process") return processRead(() => processes.stop(textArg(args, "processId")));

  // Network access is not a workspace operation: no path routing, no workspace locks.
  if (name === "web_fetch") {
    const headers = args.headers ?? {};
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("headers must be an object.");
    const method = optionalTextArg(args, "method");
    const body = optionalTextArg(args, "body");
    return webFetch({
      url: textArg(args, "url"),
      ...(method ? { method: method as "GET" | "HEAD" | "POST" } : {}),
      headers: headers as Record<string, string>,
      ...(body !== undefined ? { body } : {}),
      maxBytes: intArg(args, "maxBytes", 262144, 1, 1048576),
      timeoutMs: intArg(args, "timeoutMs", 30000, 100, 120000),
    }, { signal, allow: networkAllow });
  }

  // For all other tools, resolve the workspace based on the input path/cwd
  const resolved = resolveWorkspace(
    workspaces as Map<string, Workspace>,
    name === "run_command" || name === "start_process" ? textArg(args, "cwd", ".") : (name === "move_path" ? textArg(args, "from", ".") : textArg(args, "path", ".")),
  );
  const workspace = resolved.workspace.withGrants(pathGrants), relativeInput = resolved.relativeInput;

  if (name === "list_directory") return read(() => workspace.listDirectory(relativeInput));
  if (name === "stat_path") return read(() => workspace.statPath(relativeInput));
  if (name === "find_files") return read(() => workspace.findFiles(relativeInput, textArg(args, "pattern"), intArg(args, "maxResults", 100, 1, 1000)));
  if (name === "search_files") return read(() => workspace.searchFiles(relativeInput, textArg(args, "query"), { regex: boolArg(args, "regex", false), caseSensitive: boolArg(args, "caseSensitive", false), maxResults: intArg(args, "maxResults", 100, 1, 500), contextLines: intArg(args, "contextLines", 0, 0, 10) }));
  if (name === "read_file") return read(() => workspace.readFile(relativeInput));
  if (name === "read_file_lines") return read(() => workspace.readFileLines(relativeInput, intArg(args, "startLine", 1, 1, Number.MAX_SAFE_INTEGER), optionalIntArg(args, "endLine", 1, Number.MAX_SAFE_INTEGER)));
  if (name === "write_file") return write(() => workspace.writeFile(relativeInput, textArg(args, "content"), boolArg(args, "overwrite", false)));
  if (name === "apply_patch") return write(() => workspace.applyPatch(relativeInput, arrayArg(args, "edits", 1, 100), optionalTextArg(args, "expectedSha256")));
  if (name === "create_directory") return write(() => workspace.createDirectory(relativeInput));
  if (name === "delete_path") return write(() => workspace.deletePath(relativeInput, boolArg(args, "recursive", false)));
  if (name === "move_path") {
    const pair = resolveWorkspacePair(workspaces as Map<string, Workspace>, textArg(args, "from", "."), textArg(args, "to"));
    return write(() => pair.workspace.withGrants(pathGrants).movePath(pair.relativeFrom, pair.relativeTo, boolArg(args, "overwrite", false)));
  }
  if (name === "run_command") {
    const command = textArg(args, "command");
    const work = () => workspace.runCommand(command, relativeInput, intArg(args, "timeoutMs", 30000, 100, 120000), signal, pathGrants);
    return concurrencyArg(args) === "exclusive" ? commandScheduler.write(guarded(work)) : commandScheduler.read(guarded(work));
  }
  if (name === "start_process") {
    const command = textArg(args, "command");
    return processRead(async () => {
      const cwdPath = await workspace.processCwd(relativeInput);
      signal.throwIfAborted();
      return processes.start(command, cwdPath, safeEnv(), workspace.root, pathGrants);
    });
  }
  throw new Error(`Unknown tool: ${name}`);
}

function tool(name: string, description: string, properties: Record<string, unknown>, flags: ToolFlags) {
  return {
    name,
    description,
    inputSchema: { type: "object", additionalProperties: false, properties },
    annotations: {
      readOnlyHint: flags.readOnly,
      destructiveHint: flags.destructive ?? false,
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
