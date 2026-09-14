import { spawn } from "node:child_process";

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type CredentialCommand = (file: string, args: string[], input?: string) => Promise<CommandResult>;

/** Secrets travel through pipes, never command arguments, a shell, or error messages. */
export const runCredentialCommand: CredentialCommand = (file, args, input) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  const finish = (error?: Error, result?: CommandResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(result!);
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish(new Error("Credential service timed out. Unlock the OS credential store or configure FRELY_CREDENTIAL_STORE=encrypted-file with FRELY_CREDENTIAL_KEY."));
  }, 15_000);
  const collect = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) {
      child.kill("SIGKILL");
      finish(new Error("Credential service response exceeded the size limit."));
      return;
    }
    if (stream === "stdout") stdout.push(chunk);
    else stderr.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
  child.once("error", () => finish(new Error("OS credential tool is unavailable. Linux requires secret-tool and an unlocked Secret Service; headless hosts can use FRELY_CREDENTIAL_STORE=encrypted-file with FRELY_CREDENTIAL_KEY.")));
  child.stdin.on("error", () => { /* close/error below determines the result; never expose input */ });
  child.once("close", (code) => finish(undefined, { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  child.stdin.end(input ?? "");
});
