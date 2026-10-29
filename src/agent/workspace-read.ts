import { execFile, spawn } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { Workspace } from "../runtime/workspace.js";
import type { CallerToolDefinition } from "../skill/router.js";

const execute = promisify(execFile);

/** One tool result is cut at this size (the Agent runtime rejects larger caller tool outputs). */
export const TOOL_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_TOTAL_READ_BYTES = 1024 * 1024;
export const DEFAULT_MAX_ROUNDS = 16;
const OVERVIEW_LIMIT_BYTES = 8 * 1024;
const DENIED = "denied by local policy";

export interface ReadLimits {
  /** Total tool output handed to the Agent in one run. */
  readonly totalBytes: number;
  /** Rounds in which tool calls are answered; later calls get "budget exhausted". */
  readonly maxRounds: number;
}

export const DEFAULT_READ_LIMITS: ReadLimits = Object.freeze({ totalBytes: DEFAULT_TOTAL_READ_BYTES, maxRounds: DEFAULT_MAX_ROUNDS });

export interface FileRead {
  readonly path: string;
  readonly bytes: number;
}

/**
 * Read-only tools, with the same names and parameters as the FrelyMCP workspace tools. They run on this computer; the Agent only sees
 * what a call returns.
 */
export const READ_TOOLS: readonly CallerToolDefinition[] = Object.freeze([
  tool("workspace_info", "Describe the workspace and the limits of these read-only tools.", {}),
  tool("list_directory", "List a directory of the workspace (path relative to the workspace root).", { path: { type: "string" } }),
  tool("find_files", "Find files by glob pattern, for example **/*.ts.", { path: { type: "string" }, pattern: { type: "string" }, maxResults: { type: "integer" } }, ["pattern"]),
  tool("search_files", "Search file contents for text (or a regular expression).", {
    path: { type: "string" }, query: { type: "string" }, regex: { type: "boolean" }, caseSensitive: { type: "boolean" }, maxResults: { type: "integer" }, contextLines: { type: "integer" },
  }, ["query"]),
  tool("read_file", "Read a text file (up to 64 KiB per call; use startLine/endLine for the rest).", { path: { type: "string" }, startLine: { type: "integer" }, endLine: { type: "integer" } }, ["path"]),
  tool("read_file_lines", "Read a line range of a text file.", { path: { type: "string" }, startLine: { type: "integer" }, endLine: { type: "integer" } }, ["path", "startLine"]),
  tool("stat_path", "Size and type of a file or directory.", { path: { type: "string" } }, ["path"]),
]);

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): CallerToolDefinition {
  return { type: "function", name, description, parameters: { type: "object", properties, required, additionalProperties: false } };
}

/**
 * Why a workspace path never leaves this computer, or null. Applies to every read-only tool result: git internals, environment files,
 * key material, package-manager credentials. Gitignored files and binaries are checked separately (they need git and the file content).
 */
export function localDenyReason(relativePath: string): string | null {
  const segments = relativePath.split(/[\\/]+/u).filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment.toLowerCase() === ".git")) return DENIED;
  const name = (segments.at(-1) ?? "").toLowerCase();
  if (name === ".env" || name.startsWith(".env.") || name.startsWith(".env-")) return DENIED;
  if (/\.(pem|key|p12)$/u.test(name)) return DENIED;
  if (/^id_/u.test(name)) return DENIED;
  if (name === ".npmrc" || name === ".netrc" || name === ".pypirc") return DENIED;
  return null;
}

/** Which of these workspace-relative paths git ignores. Outside a git repository nothing is ignored. */
export async function gitIgnoredPaths(root: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", root, "check-ignore", "--stdin", "-z"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", () => resolve(new Set()));
    child.once("close", (code) => resolve(code === 0 ? new Set(Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean)) : new Set()));
    child.stdin.once("error", () => undefined);
    child.stdin.end(paths.join("\0") + "\0");
  });
}

/** The repository root for `--read` without a directory: the git top level of the current directory, else the directory itself. */
export async function defaultReadRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execute("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { windowsHide: true });
    const top = stdout.trim();
    return top === "" ? cwd : top;
  } catch {
    return cwd;
  }
}

export class WorkspaceReadBridge {
  private used = 0;
  private roundsAnswered = 0;
  private readonly reads = new Map<string, number>();

  private constructor(private readonly workspace: Workspace, readonly limits: ReadLimits) {}

  static async open(root: string, limits: ReadLimits = DEFAULT_READ_LIMITS): Promise<WorkspaceReadBridge> {
    return new WorkspaceReadBridge(await Workspace.open(root), limits);
  }

  get root(): string { return this.workspace.root; }

  /** Restore the counters of an earlier part of the same run (resume). */
  restore(state: { readonly usedBytes: number; readonly roundsAnswered: number; readonly filesRead: readonly FileRead[] }): void {
    this.used = state.usedBytes;
    this.roundsAnswered = state.roundsAnswered;
    for (const file of state.filesRead) this.reads.set(file.path, file.bytes);
  }

  state(): { usedBytes: number; roundsAnswered: number; filesRead: FileRead[] } {
    return { usedBytes: this.used, roundsAnswered: this.roundsAnswered, filesRead: this.filesRead() };
  }

  filesRead(): FileRead[] {
    return [...this.reads].map(([path, bytes]) => ({ path, bytes }));
  }

  /** True once the Agent has used up the round budget; its next tool calls only get "budget exhausted". */
  get roundBudgetSpent(): boolean { return this.roundsAnswered >= this.limits.maxRounds; }

  /** Answer one round of calls. Never throws: a failure is the tool's output. Returns `onRead(path)` events through `log`. */
  async answerRound(calls: readonly { callId: string; name: string; arguments: string }[], log: (path: string) => void = () => undefined): Promise<{ callId: string; output: string }[]> {
    const exhausted = this.roundBudgetSpent;
    if (!exhausted) this.roundsAnswered += 1;
    const outputs: { callId: string; output: string }[] = [];
    for (const call of calls) {
      outputs.push({ callId: call.callId, output: exhausted || this.used >= this.limits.totalBytes ? this.exhaustedMessage() : await this.run(call, log) });
    }
    return outputs;
  }

  private exhaustedMessage(): string {
    return "budget exhausted: no more files can be read in this run. Answer with what you have already read.";
  }

  private async run(call: { name: string; arguments: string }, log: (path: string) => void): Promise<string> {
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      args = parsed as Record<string, unknown>;
    } catch {
      return "error: arguments must be a JSON object";
    }
    let output: string;
    try {
      output = await this.dispatch(call.name, args, log);
    } catch (error) {
      output = `error: ${this.sanitize(error instanceof Error ? error.message : "tool failed")}`;
    }
    output = limitBytes(output, Math.min(TOOL_OUTPUT_LIMIT_BYTES, Math.max(0, this.limits.totalBytes - this.used)));
    this.used += Buffer.byteLength(output, "utf8");
    return output;
  }

  private sanitize(message: string): string {
    return message.split(this.workspace.root).join(".");
  }

  private noteRead(path: string, bytes: number, log: (path: string) => void): void {
    if (!this.reads.has(path)) log(path);
    this.reads.set(path, (this.reads.get(path) ?? 0) + bytes);
  }

  private async dispatch(name: string, args: Record<string, unknown>, log: (path: string) => void): Promise<string> {
    switch (name) {
      case "workspace_info":
        return JSON.stringify({
          workspace: basename(this.workspace.root),
          tools: READ_TOOLS.map((entry) => entry.name),
          limits: { toolOutputBytes: TOOL_OUTPUT_LIMIT_BYTES, totalBytes: this.limits.totalBytes, rounds: this.limits.maxRounds },
          note: "Read-only. Git internals, .env files, key files, files ignored by git and binary files are not readable.",
        });
      case "list_directory": {
        const path = pathArg(args, "path", ".");
        if (localDenyReason(path) !== null || await this.ignored(path)) return DENIED;
        const info = await this.workspace.statPath(path);
        if (info.type !== "directory") return JSON.stringify(info);
        const entries = await this.workspace.listDirectory(path);
        const kept = await this.visible(entries.map((entry) => ({ entry, path: joinPath(path, entry.name) })));
        return JSON.stringify(kept.map(({ entry }) => entry));
      }
      case "stat_path": {
        const path = pathArg(args, "path");
        if (localDenyReason(path) !== null || await this.ignored(path)) return DENIED;
        return JSON.stringify(await this.workspace.statPath(path));
      }
      case "find_files": {
        const path = pathArg(args, "path", ".");
        if (localDenyReason(path) !== null) return DENIED;
        const found = await this.workspace.findFiles(path, stringArg(args, "pattern"), intArg(args, "maxResults", 100, 1, 1000));
        return JSON.stringify((await this.visible(found.map((file) => ({ file, path: file })))).map(({ file }) => file));
      }
      case "search_files": {
        const path = pathArg(args, "path", ".");
        if (localDenyReason(path) !== null) return DENIED;
        const hits = await this.workspace.searchFiles(path, stringArg(args, "query"), {
          regex: args.regex === true,
          caseSensitive: args.caseSensitive === true,
          maxResults: intArg(args, "maxResults", 50, 1, 500),
          contextLines: intArg(args, "contextLines", 0, 0, 10),
        });
        const kept = await this.visible(hits.map((hit) => ({ hit, path: hit.path })));
        for (const { hit } of kept) this.noteRead(hit.path, Buffer.byteLength(hit.text, "utf8"), log);
        return JSON.stringify(kept.map(({ hit }) => hit));
      }
      case "read_file":
      case "read_file_lines": {
        const path = pathArg(args, "path");
        if (localDenyReason(path) !== null || await this.ignored(path)) return DENIED;
        const file = await this.workspace.readFileBytes(path);
        if (file.data.subarray(0, 8000).includes(0)) return `${DENIED} (binary file)`;
        const ranged = name === "read_file_lines" || args.startLine !== undefined || args.endLine !== undefined;
        const text = ranged
          ? (await this.workspace.readFileLines(path, intArg(args, "startLine", 1, 1, Number.MAX_SAFE_INTEGER), args.endLine === undefined ? undefined : intArg(args, "endLine", 1, 1, Number.MAX_SAFE_INTEGER))).content
          : file.data.toString("utf8");
        const returned = limitBytes(text, TOOL_OUTPUT_LIMIT_BYTES);
        this.noteRead(path, Buffer.byteLength(returned, "utf8"), log);
        return returned;
      }
      default:
        return `error: unknown tool ${name.slice(0, 64)}`;
    }
  }

  private async ignored(path: string): Promise<boolean> {
    if (path === "." || path === "") return false;
    return (await gitIgnoredPaths(this.workspace.root, [normalize(path)])).size > 0;
  }

  /** Drop denied and gitignored entries from a listing. */
  private async visible<T extends { path: string }>(entries: T[]): Promise<T[]> {
    const allowed = entries.filter((entry) => localDenyReason(entry.path) === null);
    const ignored = await gitIgnoredPaths(this.workspace.root, allowed.map((entry) => normalize(entry.path)));
    return allowed.filter((entry) => !ignored.has(normalize(entry.path)));
  }

  /**
   * A path tree of the files the Agent may read, cut at `maxBytes`: the first thing it gets, so it can choose what to open. Uses
   * `git ls-files` (tracked and untracked, not ignored) in a repository, else a bounded walk.
   */
  async overview(maxBytes = OVERVIEW_LIMIT_BYTES): Promise<string> {
    let files: string[];
    try {
      const { stdout } = await execute("git", ["-C", this.workspace.root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      files = stdout.split("\0").filter(Boolean);
    } catch {
      files = await this.workspace.findFiles(".", "*", 2000).catch(() => []);
    }
    files = [...new Set(files)].filter((file) => localDenyReason(file) === null).sort();
    const lines: string[] = [];
    let size = 0;
    for (const file of files) {
      size += Buffer.byteLength(file, "utf8") + 1;
      if (size > maxBytes) break;
      lines.push(file);
    }
    const more = files.length - lines.length;
    return `${lines.join("\n")}${more > 0 ? `\n... and ${more} more files` : ""}`;
  }
}

function joinPath(base: string, name: string): string {
  return base === "." || base === "" ? name : `${base.replace(/[\\/]+$/u, "")}/${name}`;
}

function normalize(path: string): string {
  return path.split(/[\\/]+/u).filter((segment) => segment !== "" && segment !== ".").join("/");
}

function pathArg(args: Record<string, unknown>, name: string, fallback?: string): string {
  const value = args[name];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || value === "" || value.includes("\0")) throw new Error(`${name} must be a non-empty path.`);
  return value;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") throw new Error(`${name} is required.`);
  return value;
}

function intArg(args: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

/** Cut at a byte limit on a character boundary, saying so, so the Agent knows to ask for a line range. */
export function limitBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const note = "\n[truncated: output limit reached; use read_file_lines for the rest]";
  const room = Math.max(0, limit - Buffer.byteLength(note, "utf8"));
  let cut = Buffer.from(text, "utf8").subarray(0, room).toString("utf8");
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return limit === 0 ? "" : cut + note;
}

