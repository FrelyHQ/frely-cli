#!/usr/bin/env node
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { login, logout, requireLogin, whoami } from "./auth.js";
import { doctor, statusSnapshot } from "./diagnostics.js";
import { currentDevice, ensureDevice, revokeDevice } from "./device/control.js";
import { serveDeviceRelay } from "./device/relay-client.js";
import { startStdioMcp } from "./runtime/mcp.js";
import { installMcpService, serviceStatus, startMcpService, stopMcpService, uninstallMcpService } from "./service.js";

const VERSION = "0.3.0";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "--version" || command === "-v" || command === "version") {
    stdout.write(`${VERSION}\n`);
    return;
  }
  if (!command || command === "help" || command === "--help" || command === "-h") return usage();

  if (command === "login") {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error("`frely login` requires an interactive TTY.");
    const relay = option(args, "--relay");
    const email = await promptLine("Email: ");
    const password = await promptSecret("Password: ");
    const user = await login(email.trim(), password, relay);
    const service = await serviceStatus().catch(() => null);
    if (service?.installed && !service.active) await startMcpService().catch(() => undefined);
    stdout.write(`Logged in as ${user.email}.\n`);
    stdout.write("Run `frely mcp setup --workspace <path>` to provision this machine and get the ChatGPT MCP address.\n");
    return;
  }

  if (command === "logout") {
    await stopMcpService().catch(() => undefined);
    await logout();
    stdout.write("Frely login removed and MCP background service stopped.\n");
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
      stdout.write(`Frely CLI ${VERSION}\n`);
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

  if (command === "mcp" && args[1] === "setup") {
    await requireLogin();
    const workspace = resolve(option(args, "--workspace") || process.cwd());
    const device = await ensureDevice();
    const service = await installMcpService(workspace);
    stdout.write(`MCP URL: ${device.mcpUrl}\n`);
    stdout.write(`Background service: ${service.active ? "running" : "installed"}\n`);
    stdout.write(`Workspace: ${service.workspace ?? workspace}\n`);
    stdout.write("Add the MCP URL to ChatGPT and complete the Frely authentication flow.\n");
    return;
  }

  if (command === "mcp" && args[1] === "url") {
    const device = await ensureDevice();
    if (args.includes("--json")) stdout.write(`${JSON.stringify({ deviceId: device.deviceId, mcpUrl: device.mcpUrl }, null, 2)}\n`);
    else stdout.write(`${device.mcpUrl}\n`);
    return;
  }

  if (command === "mcp" && args[1] === "status") {
    await requireLogin();
    const device = await currentDevice();
    if (args.includes("--json")) stdout.write(`${JSON.stringify({ provisioned: Boolean(device), device }, null, 2)}\n`);
    else if (!device) stdout.write("MCP device is not provisioned. Run `frely mcp url`.\n");
    else {
      stdout.write(`Device: ${device.deviceId}\n`);
      stdout.write(`MCP URL: ${device.mcpUrl}\n`);
      stdout.write(`Key: ${device.keyThumbprint}\n`);
    }
    return;
  }

  if (command === "mcp" && args[1] === "chatgpt") {
    const device = await ensureDevice();
    const service = await serviceStatus().catch(() => null);
    stdout.write("Frely MCP for ChatGPT\n\n");
    stdout.write(`MCP URL: ${device.mcpUrl}\n`);
    stdout.write(`Background service: ${service?.active ? "running" : "not running"}\n\n`);
    if (!service?.active) stdout.write("Run `frely mcp setup --workspace <path>` before adding the server to ChatGPT.\n\n");
    stdout.write("1. Add the MCP URL above as a custom MCP server in ChatGPT.\n");
    stdout.write("2. Complete the Frely authentication flow presented by the Relay.\n");
    stdout.write("3. Do not append a token or credential to the MCP URL.\n");
    return;
  }

  if (command === "mcp" && args[1] === "serve") {
    await requireLogin();
    const workspace = resolve(option(args, "--workspace") || process.cwd());
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await serveDeviceRelay({ workspace, signal: controller.signal, log: (message) => process.stderr.write(`${message}\n`) });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return;
  }

  if (command === "mcp" && args[1] === "service") {
    const action = args[2] ?? "status";
    if (action === "status") {
      const service = await serviceStatus();
      if (args.includes("--json")) stdout.write(`${JSON.stringify(service, null, 2)}\n`);
      else {
        stdout.write(`Installed: ${service.installed ? "yes" : "no"}\n`);
        stdout.write(`Active: ${service.active ? "yes" : "no"}\n`);
        if (service.workspace) stdout.write(`Workspace: ${service.workspace}\n`);
      }
      return;
    }
    if (action === "start") { const service = await startMcpService(); stdout.write(`Frely MCP service ${service.active ? "started" : "not active"}.\n`); return; }
    if (action === "stop") { const service = await stopMcpService(); stdout.write(`Frely MCP service ${service.active ? "still active" : "stopped"}.\n`); return; }
    if (action === "uninstall") { await uninstallMcpService(); stdout.write("Frely MCP background service removed.\n"); return; }
    throw new Error("Unknown MCP service action. Use status, start, stop, or uninstall.");
  }

  if (command === "mcp" && args[1] === "revoke") {
    await uninstallMcpService().catch(() => undefined);
    await revokeDevice();
    stdout.write("Frely MCP device revoked, local device key removed, and background service uninstalled.\n");
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
  stdout.write(
    "Usage:\n" +
    "  frely login [--relay <url>]\n" +
    "  frely logout\n" +
    "  frely whoami\n" +
    "  frely status [--json]\n" +
    "  frely doctor [--json]\n" +
    "  frely mcp setup [--workspace <path>]\n" +
    "  frely mcp url [--json]\n" +
    "  frely mcp status [--json]\n" +
    "  frely mcp chatgpt\n" +
    "  frely mcp serve [--workspace <path>]\n" +
    "  frely mcp service status|start|stop|uninstall [--json]\n" +
    "  frely mcp revoke\n" +
    "  frely mcp stdio [--workspace <path>]\n"
  );
}

async function promptLine(label: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: stdin, output: stdout });
  try { return await rl.question(label); }
  finally { rl.close(); }
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
        if (char === "\u0003") { cleanup(); rejectPromise(new Error("Login cancelled.")); return; }
        if (char === "\r" || char === "\n") { cleanup(); resolvePromise(value); return; }
        if (char === "\u007f" || char === "\b") { value = value.slice(0, -1); continue; }
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
