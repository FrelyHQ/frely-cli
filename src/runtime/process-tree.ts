import { execFile, spawn, type ChildProcess } from "node:child_process";
import { win32 } from "node:path";

const PROCESS_CLOSE_TIMEOUT_MS = 5000;

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || childClosed(child)) return;
  const closed = waitForChildClose(child, PROCESS_CLOSE_TIMEOUT_MS);
  let terminate: Promise<void>;
  if (process.platform === "win32") {
    const taskkill = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    terminate = new Promise<void>((resolve) => execFile(
      taskkill,
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: PROCESS_CLOSE_TIMEOUT_MS },
      () => resolve(),
    ));
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") child.kill("SIGKILL");
    }
    terminate = Promise.resolve();
  }
  await Promise.all([terminate, closed]);
}

/** Output kept per stream when a command fails, so the caller can see why (for example a sandbox denial). */
const FAILURE_OUTPUT_BYTES = 4096;

/** A non-zero exit. The first message line is stable; stderr/stdout tails and an optional hint follow it. */
export class CommandFailedError extends Error {
  constructor(readonly exitCode: number | null, readonly stdout: string, readonly stderr: string, hint?: string) {
    const tail = (name: string, text: string) => text.trim() ? `\n${name}:\n${text.length > FAILURE_OUTPUT_BYTES ? "…" + text.slice(-FAILURE_OUTPUT_BYTES) : text}` : "";
    super(`MCP command exited with status ${exitCode ?? "unknown"}.${tail("stderr", stderr)}${tail("stdout", stdout)}${hint ? `\n${hint}` : ""}`);
  }
}

export interface RunShellOptions {
  /** Kill the shell's process group once the shell has closed, so no background child outlives the command. */
  killLeftovers?: boolean;
  /** Called when that kill found processes still running. */
  onLeftoversKilled?: () => void;
}

export function runShellCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, maxBytes: number, signal?: AbortSignal, options: RunShellOptions = {}): Promise<{ stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, env, shell: true, stdio: "pipe", detached: process.platform !== "win32", windowsHide: true });
    const output: Buffer[] = [], errors: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const stop = (message: string) => { failure ??= new Error(message); void terminateProcessTree(child); };
    const abort = () => stop("MCP command authorization was cancelled; mutation outcome may be unknown.");
    const timer = setTimeout(() => stop("MCP command timed out; mutation outcome may be unknown."), timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    const collect = (list: Buffer[], data: Buffer) => { size += data.length; if (size > maxBytes) stop("MCP command output limit exceeded."); else list.push(data); };
    child.stdout.on("data", (data: Buffer) => collect(output, data));
    child.stderr.on("data", (data: Buffer) => collect(errors, data));
    child.once("error", () => { failure ??= new Error("MCP command could not be started."); });
    child.once("close", (code) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (options.killLeftovers && child.pid !== undefined && process.platform !== "win32") {
        // The shell is gone; whatever is still in its process group was left running in the background by the command.
        try { process.kill(-child.pid, "SIGKILL"); options.onLeftoversKilled?.(); } catch { /* ESRCH: nothing was left */ }
      }
      if (failure) reject(failure);
      else if (code !== 0) reject(new CommandFailedError(code, Buffer.concat(output).toString("utf8"), Buffer.concat(errors).toString("utf8")));
      else resolve({ stdout: Buffer.concat(output).toString("utf8"), stderr: Buffer.concat(errors).toString("utf8") });
    });
    if (signal?.aborted) abort();
  });
}

function childClosed(child: ChildProcess): boolean {
  if (child.exitCode === null && child.signalCode === null) return false;
  return [child.stdin, child.stdout, child.stderr].every((stream) => !stream || stream.destroyed);
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (childClosed(child)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    // A descendant outside the killed group (macOS) can keep the pipes open long after the shell is gone, so "close" never arrives.
    // The tree has been killed by now, so once the shell exits drop our ends of the pipes and let "close" follow.
    const onExit = () => { for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy(); };
    if (child.exitCode !== null || child.signalCode !== null) onExit(); else child.once("exit", onExit);
    const onClose = () => {
      child.removeListener("exit", onExit);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      child.removeListener("exit", onExit);
      reject(new Error(`Timed out waiting for process ${child.pid ?? "unknown"} to release its resources.`));
    }, timeoutMs);
    timer.unref?.();
    child.once("close", onClose);
    if (childClosed(child)) {
      child.removeListener("close", onClose);
      child.removeListener("exit", onExit);
      clearTimeout(timer);
      resolve();
    }
  });
}
