import { exec as execCallback } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const exec = promisify(execCallback);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

type Mode = "read" | "write";

type Job<T> = { mode: Mode; work: () => Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

class FairRwScheduler {
  private activeReaders = 0;
  private writer = false;
  private readonly queue: Job<unknown>[] = [];
  constructor(private readonly maxReaders = 4) {}

  read<T>(work: () => Promise<T>): Promise<T> { return this.enqueue("read", work); }
  write<T>(work: () => Promise<T>): Promise<T> { return this.enqueue("write", work); }

  private enqueue<T>(mode: Mode, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ mode, work, resolve: resolve as (value: unknown) => void, reject });
      this.drain();
    });
  }

  private drain(): void {
    if (this.writer) return;
    const first = this.queue[0];
    if (!first) return;
    if (first.mode === "write") {
      if (this.activeReaders > 0) return;
      this.writer = true;
      this.queue.shift();
      void first.work().then(first.resolve, first.reject).finally(() => { this.writer = false; this.drain(); });
      return;
    }
    while (!this.writer && this.activeReaders < this.maxReaders && this.queue[0]?.mode === "read") {
      const job = this.queue.shift()!;
      this.activeReaders += 1;
      void job.work().then(job.resolve, job.reject).finally(() => { this.activeReaders -= 1; this.drain(); });
    }
  }
}

export async function startStdioMcp(workspaceInput: string): Promise<void> {
  const workspace = await realpath(resolve(workspaceInput));
  const scheduler = new FairRwScheduler(4);
  const server = new Server({ name: "friday-local", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    tool("list_directory", "List one workspace directory.", { path: stringSchema("Relative directory path", ".") }, true),
    tool("read_file", "Read a UTF-8 workspace file up to 1 MiB.", { path: stringSchema("Relative file path") }, true),
    tool("search_files", "Search UTF-8 workspace files for a literal string.", { path: stringSchema("Relative directory path", "."), query: stringSchema("Literal text"), maxResults: numberSchema(100) }, true),
    tool("write_file", "Atomically write a UTF-8 workspace file.", { path: stringSchema("Relative file path"), content: stringSchema("Complete file content"), overwrite: { type: "boolean", default: false } }, false),
    tool("apply_patch", "Apply line replacements to a UTF-8 workspace file.", { path: stringSchema("Relative file path"), edits: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, required: ["startLine", "endLine", "replacement"], properties: { startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, replacement: { type: "string" } } } } }, false),
    tool("run_command", "Run a shell command as the current OS user. Workspace only constrains cwd; this is not a sandbox.", { command: stringSchema("Shell command"), cwd: stringSchema("Relative working directory", "."), timeoutMs: { type: "integer", minimum: 100, maximum: 120000, default: 30000 } }, false)
  ] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = name === "list_directory" ? await scheduler.read(() => listDirectory(workspace, args))
        : name === "read_file" ? await scheduler.read(() => readTextFile(workspace, args))
        : name === "search_files" ? await scheduler.read(() => searchFiles(workspace, args))
        : name === "write_file" ? await scheduler.write(() => writeTextFile(workspace, args))
        : name === "apply_patch" ? await scheduler.write(() => applyLinePatch(workspace, args))
        : name === "run_command" ? await scheduler.write(() => runCommand(workspace, args))
        : (() => { throw new Error(`Unknown tool: ${name}`); })();
      return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Local tool failed." }] };
    }
  });

  await server.connect(new StdioServerTransport());
}

function tool(name: string, description: string, properties: Record<string, unknown>, readOnly: boolean) {
  return { name, description, inputSchema: { type: "object", additionalProperties: false, properties }, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly } };
}
function stringSchema(description: string, defaultValue?: string) { return { type: "string", description, ...(defaultValue === undefined ? {} : { default: defaultValue }) }; }
function numberSchema(defaultValue: number) { return { type: "integer", minimum: 1, maximum: 500, default: defaultValue }; }
function textArg(args: Record<string, unknown>, name: string, fallback?: string): string { const value = args[name] ?? fallback; if (typeof value !== "string") throw new Error(`${name} must be a string.`); return value; }
function intArg(args: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number { const value = args[name] ?? fallback; if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} is invalid.`); return Number(value); }

async function safePath(root: string, input: string, parentOnly = false): Promise<string> {
  if (input.includes("\0")) throw new Error("Invalid path.");
  const target = resolve(root, input || ".");
  assertInside(root, target);
  if (parentOnly) await assertNearestExistingAncestorInside(root, dirname(target));
  else {
    const canonical = await realpath(target).catch(() => null);
    if (canonical) assertInside(root, canonical);
  }
  return target;
}

async function assertNearestExistingAncestorInside(root: string, start: string): Promise<void> {
  let cursor = start;
  while (true) {
    const canonical = await realpath(cursor).catch(() => null);
    if (canonical) {
      assertInside(root, canonical);
      return;
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("Write parent is unavailable.");
    cursor = parent;
  }
}

function assertInside(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || resolve(target) === resolve("/")) throw new Error("Path escapes workspace.");
}

async function listDirectory(root: string, args: Record<string, unknown>) {
  const path = await safePath(root, textArg(args, "path", "."));
  const entries = await readdir(path, { withFileTypes: true });
  return entries.slice(0, 500).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }));
}

async function readTextFile(root: string, args: Record<string, unknown>): Promise<string> {
  const path = await safePath(root, textArg(args, "path"));
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Only regular files are readable.");
  if (stat.size > MAX_FILE_BYTES) throw new Error("File exceeds 1 MiB limit.");
  return readFile(path, "utf8");
}

async function searchFiles(root: string, args: Record<string, unknown>) {
  const base = await safePath(root, textArg(args, "path", "."));
  const query = textArg(args, "query");
  const maxResults = intArg(args, "maxResults", 100, 1, 500);
  const results: Array<{ path: string; line: number; text: string }> = [];
  async function walk(dir: string): Promise<void> {
    if (results.length >= maxResults) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (results.length >= maxResults || entry.name === ".git" || entry.name === "node_modules") break;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const stat = await lstat(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        const content = await readFile(full, "utf8").catch(() => null);
        if (content === null) continue;
        for (const [index, line] of content.split(/\r?\n/u).entries()) if (line.includes(query)) { results.push({ path: relative(root, full), line: index + 1, text: line }); if (results.length >= maxResults) break; }
      }
    }
  }
  await walk(base);
  return results;
}

async function writeTextFile(root: string, args: Record<string, unknown>) {
  const path = await safePath(root, textArg(args, "path"), true);
  const content = textArg(args, "content");
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("Content exceeds 1 MiB limit.");
  const overwrite = args.overwrite === true;
  const existing = await lstat(path).catch(() => null);
  if (existing?.isSymbolicLink()) throw new Error("Refusing to replace a symbolic link.");
  if (existing && !overwrite) throw new Error("File exists; set overwrite=true.");
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, { flag: "wx", mode: 0o600 });
  await rename(tmp, path).catch(async (error) => { await rm(tmp, { force: true }); throw error; });
  return { path: relative(root, path), bytes: Buffer.byteLength(content) };
}

async function applyLinePatch(root: string, args: Record<string, unknown>) {
  const path = await safePath(root, textArg(args, "path"));
  const edits = args.edits;
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 100) throw new Error("edits must contain 1-100 entries.");
  const content = await readTextFile(root, { path: relative(root, path) });
  const lines = content.split("\n");
  const parsed = edits.map((value) => { if (!value || typeof value !== "object") throw new Error("Invalid edit."); const item = value as Record<string, unknown>; const startLine = Number(item.startLine); const endLine = Number(item.endLine); if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) throw new Error("Invalid edit range."); if (typeof item.replacement !== "string") throw new Error("replacement must be a string."); return { startLine, endLine, replacement: item.replacement }; }).sort((a, b) => b.startLine - a.startLine);
  for (const edit of parsed) lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...edit.replacement.split("\n"));
  return writeTextFile(root, { path: relative(root, path), content: lines.join("\n"), overwrite: true });
}

async function runCommand(root: string, args: Record<string, unknown>) {
  const command = textArg(args, "command");
  if (!command.trim()) throw new Error("command is required.");
  const cwd = await safePath(root, textArg(args, "cwd", "."));
  const timeout = intArg(args, "timeoutMs", 30000, 100, 120000);
  const { stdout, stderr } = await exec(command, { cwd, timeout, maxBuffer: MAX_OUTPUT_BYTES, env: safeEnv() });
  return { stdout: truncate(stdout), stderr: truncate(stderr) };
}
function safeEnv(): NodeJS.ProcessEnv { const keys = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SHELL", "SystemRoot"]; return Object.fromEntries(keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv; }
function truncate(value: string): string { return Buffer.byteLength(value) <= MAX_OUTPUT_BYTES ? value : `${value.slice(0, MAX_OUTPUT_BYTES)}\n[truncated]`; }
