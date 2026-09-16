import { terminateProcessTree } from "./process-tree.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

const MAX_STREAM_CHARS = 1024 * 1024;
const MAX_PROCESSES = 64;

interface ManagedProcess {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly startedAt: string;
  stdout: string;
  stderr: string;
  stdoutBase: number;
  stderrBase: number;
  exitedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface ProcessSnapshot {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  running: boolean;
}

export interface ProcessReadResult extends ProcessSnapshot {
  stdout: string;
  stderr: string;
  stdoutCursor: number;
  stderrCursor: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export class ProcessManager {
  private closed = false;
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly operations = new Map<string, Promise<unknown>>();

  start(command: string, cwd: string, env: NodeJS.ProcessEnv): ProcessSnapshot {
    if (this.closed) throw new Error("MCP process manager is closed.");
    if (!command.trim()) throw new Error("command is required.");
    this.pruneExited();
    if (this.processes.size >= MAX_PROCESSES) throw new Error(`At most ${MAX_PROCESSES} managed processes may exist in one MCP session.`);
    const id = randomUUID();
    const child = spawn(command, { cwd, env, shell: true, stdio: "pipe", detached: process.platform !== "win32", windowsHide: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const managed: ManagedProcess = {
      id,
      command,
      cwd,
      child,
      startedAt: new Date().toISOString(),
      stdout: "",
      stderr: "",
      stdoutBase: 0,
      stderrBase: 0,
      exitedAt: null,
      exitCode: null,
      signal: null,
    };
    child.stdout.on("data", (chunk: string) => this.append(managed, "stdout", chunk));
    child.stderr.on("data", (chunk: string) => this.append(managed, "stderr", chunk));
    child.once("error", () => { managed.exitedAt = new Date().toISOString(); managed.exitCode = 1; });
    child.once("exit", (code, signal) => {
      managed.exitedAt = new Date().toISOString();
      managed.exitCode = code;
      managed.signal = signal;
    });
    this.processes.set(id, managed);
    return snapshot(managed);
  }

  list(): ProcessSnapshot[] {
    return [...this.processes.values()].map(snapshot);
  }

  read(id: string, stdoutCursor = 0, stderrCursor = 0): ProcessReadResult {
    const managed = this.require(id);
    const stdoutStart = Math.max(stdoutCursor, managed.stdoutBase);
    const stderrStart = Math.max(stderrCursor, managed.stderrBase);
    return {
      ...snapshot(managed),
      stdout: managed.stdout.slice(stdoutStart - managed.stdoutBase),
      stderr: managed.stderr.slice(stderrStart - managed.stderrBase),
      stdoutCursor: managed.stdoutBase + managed.stdout.length,
      stderrCursor: managed.stderrBase + managed.stderr.length,
      stdoutTruncated: stdoutCursor < managed.stdoutBase,
      stderrTruncated: stderrCursor < managed.stderrBase,
    };
  }

  write(id: string, input: string): Promise<ProcessSnapshot> {
    return this.serialize(id, async () => {
      const managed = this.require(id);
      if (managed.exitedAt || !managed.child.stdin.writable) throw new Error("Process is not accepting input.");
      await new Promise<void>((resolve, reject) => {
        managed.child.stdin.write(input, (error) => error ? reject(error) : resolve());
      });
      return snapshot(managed);
    });
  }

  stop(id: string): Promise<ProcessSnapshot> {
    return this.serialize(id, async () => {
      const managed = this.require(id);
      if (managed.exitedAt) return snapshot(managed);
      await terminateProcessTree(managed.child);
      return snapshot(managed);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.processes.values()]
        .filter((item) => !item.exitedAt)
        .map((item) => this.serialize(item.id, async () => {
          if (!item.exitedAt) await terminateProcessTree(item.child);
        })),
    );
  }

  private require(id: string): ManagedProcess {
    const managed = this.processes.get(id);
    if (!managed) throw new Error("Unknown process id.");
    return managed;
  }

  private serialize<T>(id: string, work: () => T | Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.operations.set(id, current);
    const cleanup = () => {
      if (this.operations.get(id) === current) this.operations.delete(id);
    };
    current.then(cleanup, cleanup);
    return current;
  }

  private pruneExited(): void {
    if (this.processes.size < MAX_PROCESSES) return;
    const exited = [...this.processes.values()]
      .filter((managed) => managed.exitedAt !== null)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    for (const managed of exited) {
      if (this.processes.size < MAX_PROCESSES) break;
      this.processes.delete(managed.id);
    }
  }

  private append(managed: ManagedProcess, stream: "stdout" | "stderr", chunk: string): void {
    const baseKey = stream === "stdout" ? "stdoutBase" : "stderrBase";
    managed[stream] += chunk;
    if (managed[stream].length > MAX_STREAM_CHARS) {
      const removed = managed[stream].length - MAX_STREAM_CHARS;
      managed[stream] = managed[stream].slice(removed);
      managed[baseKey] += removed;
    }
  }
}

function snapshot(managed: ManagedProcess): ProcessSnapshot {
  return {
    id: managed.id,
    command: managed.command,
    cwd: managed.cwd,
    startedAt: managed.startedAt,
    exitedAt: managed.exitedAt,
    exitCode: managed.exitCode,
    signal: managed.signal,
    running: managed.exitedAt === null,
  };
}
