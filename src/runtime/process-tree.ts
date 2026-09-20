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

export function runShellCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, maxBytes: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
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
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`MCP command exited with status ${code ?? "unknown"}.`));
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
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      reject(new Error(`Timed out waiting for process ${child.pid ?? "unknown"} to release its resources.`));
    }, timeoutMs);
    timer.unref?.();
    child.once("close", onClose);
    if (childClosed(child)) {
      child.removeListener("close", onClose);
      clearTimeout(timer);
      resolve();
    }
  });
}
