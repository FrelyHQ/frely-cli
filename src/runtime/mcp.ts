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
  /** Bridge for cloud_list / cloud_call (frely-app toolset): the Frely Cloud tools, called with this device's own Cloud authorization. Without it the tools stay hidden. */
  cloud?: {
    list: (group?: string) => Promise<unknown>;
    call: (name: string, input: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
  };
  /** Device-local MCP servers (plan mcp/本机MCP转发-方案.md). Without a hub the local_mcp_* tools stay hidden. */
  localMcp?: LocalMcpHub;
  /** Names the owner enabled on the current MCP authorization; absent or empty hides the local_mcp_* tools. */
  getLocalMcps?: () => string[];
}

function enabledLocalMcps(options: McpRuntimeOptions): string[] {
  try { return options.localMcp ? options.getLocalMcps?.() ?? [] : []; } catch { return []; }
}

function enabledToolsets(options: McpRuntimeOptions): string[] {
  try { return options.getToolsets?.() ?? ["workspace"]; } catch { return ["workspace"]; }
}

/** Frely Cloud tools (account, keys, Creator, Owner). Permissions and per-call approval are enforced by the server for this device. */
export const CLOUD_TOOLS = [
  tool("cloud_list", "List the Frely Cloud tools this device may use, with their input schemas. With `group`, only that tool group.", { group: stringSchema("Tool group prefix such as keys or skills; omit for all") }, { readOnly: true }),
  tool("cloud_call", "Call one Frely Cloud tool by name with its arguments. Writes that need approval return confirmation_required with a link: the user approves on the web console, then call again with the same arguments plus confirmationId.", { tool: stringSchema("Cloud tool name from cloud_list"), arguments: { type: "object", description: "Arguments for the tool", additionalProperties: true } }, { readOnly: false, destructive: true, idempotent: false }),
];

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
    ...((enabledToolsets(options).includes("frely-app") && options.cloud) ? CLOUD_TOOLS : []),
    ...(enabledLocalMcps(options).length > 0 ? LOCAL_MCP_TOOLS : []),
    tool("read", "Read the workspace. action=list lists a directory, or returns type/size/mtime for a file; read returns a UTF-8 file (max 1 MiB), or lines startLine..endLine; search finds `query` in file contents; find matches file names (*, **, ?); roots lists workspace roots.", { action: { type: "string", enum: ["list", "read", "search", "find", "roots"] }, path: stringSchema("Relative path", "."), startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, query: { type: "string" }, regex: boolSchema(false), caseSensitive: boolSchema(false), maxResults: intSchema(100, 1, 1000), contextLines: intSchema(0, 0, 10) }, { readOnly: true }),
    tool("edit_file", "Change a UTF-8 workspace file: `content` atomically writes the whole file, creating parent directories (overwrite=true to replace one); `edits` replaces line ranges. Delete, move and mkdir with process.", { path: stringSchema("Relative path"), content: { type: "string" }, overwrite: boolSchema(false), edits: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, required: ["startLine", "endLine", "replacement"], properties: { startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, replacement: { type: "string" } } } } }, { readOnly: false, idempotent: false }),
    tool("web_fetch", "Fetch a public http(s) URL (ports 80, 443) from this device's network; private addresses are refused. Returns status, content type and body text up to maxBytes.", { url: { type: "string" }, method: { type: "string", enum: ["GET", "HEAD", "POST"], default: "GET" }, headers: { type: "object", additionalProperties: { type: "string" } }, body: { type: "string" }, maxBytes: intSchema(262144, 1, 1048576), timeoutMs: intSchema(30000, 100, 120000) }, { readOnly: false, idempotent: false }),
    tool("process", "Run shell commands as the current OS user, sandboxed where supported: credential folders blocked (ask with request_permission), writes limited to workspace and temp, network to HTTP(S) and ssh. action=run waits up to timeoutMs and returns output; start returns an id for longer tasks; read returns output after stdoutCursor/stderrCursor; write sends `input` to stdin; list; stop. concurrency=exclusive for commands that change shared repo, dependency or build state.", { action: { type: "string", enum: ["run", "start", "read", "write", "list", "stop"] }, command: { type: "string" }, cwd: stringSchema("Relative path", "."), timeoutMs: intSchema(30000, 100, 120000), concurrency: { type: "string", enum: ["parallel", "exclusive"], default: "parallel" }, processId: { type: "string" }, stdoutCursor: intSchema(0, 0, Number.MAX_SAFE_INTEGER), stderrCursor: intSchema(0, 0, Number.MAX_SAFE_INTEGER), input: { type: "string" } }, { readOnly: false, destructive: true, idempotent: false }),
  ] }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let complete: (() => void) | undefined;
    const active = new Promise<void>((resolve) => { complete = resolve; });
    activeCalls.add(active);
    const finish = options.maintenance?.track();
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === "cloud_list" || name === "cloud_call") {
        if (!enabledToolsets(options).includes("frely-app") || !options.cloud) {
          throw new Error("Cloud tools are not enabled for this MCP permission. Enable Frely app tools on the Frely connections page.");
        }
        if (name === "cloud_list") return { content: [{ type: "text" as const, text: JSON.stringify(await options.cloud.list(optionalTextArg(args, "group"))) }] };
        const callArgs = args.arguments ?? {};
        if (!callArgs || typeof callArgs !== "object" || Array.isArray(callArgs)) throw new Error("arguments must be an object.");
        return await options.cloud.call(textArg(args, "tool"), callArgs as Record<string, unknown>);
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
    return dispatch(mapped, routed, workspaces, primaryRoot, processes, workspaceScheduler, commandScheduler, processScheduler, signal, pathGrants, networkAllow);
  }
  if (name === "edit_file") {
    if ((args.content === undefined) === (args.edits === undefined)) throw new Error("Pass exactly one of content or edits.");
    return dispatch(args.edits === undefined ? "write_file" : "apply_patch", args, workspaces, primaryRoot, processes, workspaceScheduler, commandScheduler, processScheduler, signal, pathGrants, networkAllow);
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
  if (name === "read_file") return read(() => workspace.readFile(relativeInput));
  if (name === "read_file_lines") return read(() => workspace.readFileLines(relativeInput, intArg(args, "startLine", 1, 1, Number.MAX_SAFE_INTEGER), optionalIntArg(args, "endLine", 1, Number.MAX_SAFE_INTEGER)));
  if (name === "write_file" && boolArg(args, "directory", false)) return write(() => workspace.createDirectory(relativeInput));
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
