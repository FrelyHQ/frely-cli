#!/usr/bin/env node
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { login, logout, requireLogin, whoami } from "./auth.js";
import { startStdioMcp } from "./runtime/mcp.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === "help" || command === "--help" || command === "-h") return usage();
  if (command === "login") {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error("`frely login` requires an interactive TTY.");
    const relay = option(args, "--relay");
    const email = await promptLine("Email: ");
    const password = await promptSecret("Password: ");
    const user = await login(email.trim(), password, relay);
    stdout.write(`Logged in as ${user.email}.\n`);
    return;
  }
  if (command === "logout") { await logout(); stdout.write("Frely login removed.\n"); return; }
  if (command === "whoami") { const user = await whoami(); stdout.write(`${user.email} (${user.id})\n`); return; }
  if (command === "mcp" && args[1] === "stdio") {
    await requireLogin();
    const workspace = resolve(option(args, "--workspace") || process.cwd());
    await startStdioMcp(workspace);
    return;
  }
  usage();
  process.exitCode = 2;
}

function option(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function usage(): void { stdout.write("Usage:\n  frely login [--relay <url>]\n  frely logout\n  frely whoami\n  frely mcp stdio [--workspace <path>]\n"); }
async function promptLine(label: string): Promise<string> { const { createInterface } = await import("node:readline/promises"); const rl = createInterface({ input: stdin, output: stdout }); try { return await rl.question(label); } finally { rl.close(); } }
async function promptSecret(label: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") throw new Error("A TTY is required for password input.");
  stdout.write(label);
  stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
  return new Promise<string>((resolvePromise, rejectPromise) => {
    let value = "";
    const cleanup = () => { stdin.off("data", onData); stdin.setRawMode(false); stdin.pause(); stdout.write("\n"); };
    const onData = (chunk: string | Buffer) => {
      for (const char of String(chunk)) {
        if (char === "\u0003") { cleanup(); rejectPromise(new Error("Login cancelled.")); return; }
        if (char === "\r" || char === "\n") { cleanup(); resolvePromise(value); return; }
        if (char === "\u007f" || char === "\b") { value = value.slice(0, -1); continue; }
        if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
