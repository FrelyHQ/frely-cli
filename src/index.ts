#!/usr/bin/env node
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { login, logout, requireLogin, whoami } from "./auth.js";
import { doctor, statusSnapshot } from "./diagnostics.js";
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

  if (command === "logout") {
    await logout();
    stdout.write("Frely login removed.\n");
    return;
  }

  if (command === "whoami") {
    const user = await whoami();
    stdout.write(`${user.email} (${user.id})\n`);
    return;
  }

  if (command === "status") {
    const value = await statusSnapshot();
    if (args.includes("--json")) stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    else {
      stdout.write(`Frely CLI 0.2.0\n`);
      stdout.write(`Relay: ${value.auth.relayUrl ?? "not configured"}\n`);
      stdout.write(`Account: ${value.auth.user?.email ?? "not logged in"}\n`);
      stdout.write(`Credential: ${value.auth.credentialStored ? "stored" : "missing"}\n`);
    }
    return;
  }

  if (command === "doctor") {
    const value = await doctor();
    if (args.includes("--json")) stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    else for (const check of value.checks) stdout.write(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}\n`);
    if (!value.ok) process.exitCode = 1;
    return;
  }

  if (command === "mcp" && args[1] === "stdio") {
    await requireLogin();
    const workspace = resolve(option(args, "--workspace") || process.cwd());
    await startStdioMcp(workspace);
    return;
  }

  usage();
  process.exitCode = 2;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function usage(): void {
  stdout.write("Usage:\n  frely login [--relay <url>]\n  frely logout\n  frely whoami\n  frely status [--json]\n  frely doctor [--json]\n  frely mcp stdio [--workspace <path>]\n");
}

async function promptLine(label: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(label);
  } finally {
    rl.close();
  }
}

async function promptSecret(label: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") throw new Error("A TTY is required for password input.");
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise<string>((resolvePromise, rejectPromise) => {
    let value = "";
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: string | Buffer) => {
      for (const char of String(chunk)) {
        if (char === "\u0003") {
          cleanup();
          rejectPromise(new Error("Login cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolvePromise(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
