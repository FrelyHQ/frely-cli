import type { MaintenanceGate } from "../upgrade/maintenance.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ProcessManager } from "./process-manager.js";
import { FairRwScheduler } from "./scheduler.js";
import { safeEnv, Workspace } from "./workspace.js";
import { VERSION } from "../version.js";

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
}
export async function createMcpServer(workspaceInput: string, options: McpRuntimeOptions = {}): Promise<Server> {
  const workspace = await Workspace.open(workspaceInput);
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
      const result = await dispatch(name, args, workspace, processes, workspaceScheduler, commandScheduler, processScheduler, AbortSignal.any([lifecycle.signal, extra.signal]));
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

export async function startStdioMcp(workspaceInput: string, options: McpRuntimeOptions = {}): Promise<void> {
  const server = await createMcpServer(workspaceInput, options);
  await server.connect(new StdioServerTransport());
}

async function dispatch(name: string, args: Record<string, unknown>, workspace: Workspace, processes: ProcessManager, workspaceScheduler: FairRwScheduler, commandScheduler: FairRwScheduler, processScheduler: FairRwScheduler, signal: AbortSignal): Promise<unknown> {
  const guarded = <T>(work: () => Promise<T>) => async () => { signal.throwIfAborted(); return work(); };
  const read = <T>(work: () => Promise<T>) => workspaceScheduler.read(guarded(work));
  const write = <T>(work: () => Promise<T>) => workspaceScheduler.write(guarded(work));
  const processRead = <T>(work: () => Promise<T>) => processScheduler.read(guarded(work));
  if (name === "workspace_info") return read(async () => workspace.info());
  if (name === "list_directory") return read(() => workspace.listDirectory(textArg(args, "path", ".")));
  if (name === "stat_path") return read(() => workspace.statPath(textArg(args, "path")));
  if (name === "find_files") return read(() => workspace.findFiles(textArg(args, "path", "."), textArg(args, "pattern"), intArg(args, "maxResults", 100, 1, 1000)));
  if (name === "search_files") return read(() => workspace.searchFiles(textArg(args, "path", "."), textArg(args, "query"), { regex: boolArg(args, "regex", false), caseSensitive: boolArg(args, "caseSensitive", false), maxResults: intArg(args, "maxResults", 100, 1, 500), contextLines: intArg(args, "contextLines", 0, 0, 10) }));
  if (name === "read_file") return read(() => workspace.readFile(textArg(args, "path")));
  if (name === "read_file_lines") return read(() => workspace.readFileLines(textArg(args, "path"), intArg(args, "startLine", 1, 1, Number.MAX_SAFE_INTEGER), optionalIntArg(args, "endLine", 1, Number.MAX_SAFE_INTEGER)));
  if (name === "write_file") return write(() => workspace.writeFile(textArg(args, "path"), textArg(args, "content"), boolArg(args, "overwrite", false)));
  if (name === "apply_patch") return write(() => workspace.applyPatch(textArg(args, "path"), arrayArg(args, "edits", 1, 100), optionalTextArg(args, "expectedSha256")));
  if (name === "create_directory") return write(() => workspace.createDirectory(textArg(args, "path")));
  if (name === "delete_path") return write(() => workspace.deletePath(textArg(args, "path"), boolArg(args, "recursive", false)));
  if (name === "move_path") return write(() => workspace.movePath(textArg(args, "from"), textArg(args, "to"), boolArg(args, "overwrite", false)));
  if (name === "run_command") {
    const work = () => workspace.runCommand(textArg(args, "command"), textArg(args, "cwd", "."), intArg(args, "timeoutMs", 30000, 100, 120000), signal);
    return concurrencyArg(args) === "exclusive" ? commandScheduler.write(guarded(work)) : commandScheduler.read(guarded(work));
  }
  if (name === "start_process") return processRead(async () => {
    const cwd = await workspace.processCwd(textArg(args, "cwd", "."));
    signal.throwIfAborted();
    return processes.start(textArg(args, "command"), cwd, safeEnv());
  });
  if (name === "list_processes") return processRead(async () => processes.list());
  if (name === "read_process") return processRead(async () => processes.read(textArg(args, "processId"), intArg(args, "stdoutCursor", 0, 0, Number.MAX_SAFE_INTEGER), intArg(args, "stderrCursor", 0, 0, Number.MAX_SAFE_INTEGER)));
  if (name === "write_process") return processRead(() => processes.write(textArg(args, "processId"), textArg(args, "input")));
  if (name === "stop_process") return processRead(() => processes.stop(textArg(args, "processId")));
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
