/**
 * Agent tool executor: executes `tool.*` requests from the agent host inside
 * the task's worktree through the shared `Workspace` implementation (path
 * containment + srt sandbox for commands) under a fair read/write scheduler.
 */
import { FairRwScheduler } from "../runtime/scheduler.js";
import { Workspace } from "../runtime/workspace.js";

export type AgentToolResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: "tool_failed" | "not_found" | "invalid_args"; message: string } };

export type AgentToolKind = "read" | "write" | "bash" | "grep" | "find" | "ls" | "edit";

/** Single active executor per task; created when the task starts running. */
export class AgentToolExecutor {
  private readonly workspace: Promise<Workspace>;
  private disposed = false;

  constructor(
    worktreeRoot: string,
    private readonly scheduler: FairRwScheduler,
  ) {
    this.workspace = Workspace.open(worktreeRoot);
  }

  async execute(kind: AgentToolKind, args: Record<string, unknown>): Promise<AgentToolResult> {
    if (this.disposed) return failure("tool_failed", "Task session is disposed.");
    try {
      const result = await this.dispatch(kind, args);
      return { ok: true, result };
    } catch (error) {
      return failure("tool_failed", error instanceof Error ? error.message : "tool failed");
    }
  }

  private async dispatch(kind: AgentToolKind, args: Record<string, unknown>): Promise<unknown> {
    const workspace = await this.workspace;
    switch (kind) {
      case "read": {
        const path = stringArg(args, "path");
        return this.scheduler.read(() => workspace.readFile(path));
      }
      case "write": {
        const path = stringArg(args, "path");
        const content = stringArg(args, "content");
        const overwrite = args.overwrite === true;
        return this.scheduler.write(() => workspace.writeFile(path, content, overwrite));
      }
      case "edit": {
        const path = stringArg(args, "path");
        const edits = args.edits;
        if (!Array.isArray(edits)) throw new Error("edits must be an array.");
        const expectedSha256 = typeof args.expectedSha256 === "string" ? args.expectedSha256 : undefined;
        return this.scheduler.write(() => workspace.applyPatch(path, edits, expectedSha256));
      }
      case "bash": {
        const command = stringArg(args, "command");
        const cwd = typeof args.cwd === "string" ? args.cwd : ".";
        const timeoutMs = numberArg(args, "timeoutMs", 30_000);
        return this.scheduler.write(() => workspace.runCommand(command, cwd, timeoutMs));
      }
      case "grep": {
        const query = stringArg(args, "query");
        const path = typeof args.path === "string" ? args.path : ".";
        return this.scheduler.read(() =>
          workspace.searchFiles(path, query, {
            regex: args.regex === true,
            caseSensitive: args.caseSensitive === true,
            maxResults: numberArg(args, "maxResults", 100),
            contextLines: numberArg(args, "contextLines", 0),
          }),
        );
      }
      case "find": {
        const pattern = stringArg(args, "pattern");
        const path = typeof args.path === "string" ? args.path : ".";
        return this.scheduler.read(() => workspace.findFiles(path, pattern, numberArg(args, "maxResults", 100)));
      }
      case "ls": {
        const path = typeof args.path === "string" ? args.path : ".";
        return this.scheduler.read(() => workspace.listDirectory(path));
      }
      default:
        throw new Error(`Unknown tool kind: ${kind satisfies never}`);
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}

export function toolKindFromMethod(method: string): AgentToolKind | null {
  switch (method) {
    case "tool.read":
      return "read";
    case "tool.write":
      return "write";
    case "tool.edit":
      return "edit";
    case "tool.bash":
      return "bash";
    case "tool.grep":
      return "grep";
    case "tool.find":
      return "find";
    case "tool.ls":
      return "ls";
    default:
      return null;
  }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a non-empty string.`);
  return value;
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${key} must be an integer.`);
  return value;
}

function failure(code: "tool_failed" | "not_found" | "invalid_args", message: string): AgentToolResult {
  return { ok: false, error: { code, message: message.slice(0, 512) } };
}
