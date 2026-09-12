import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const LABEL = "cloud.frely.cli-mcp";

export interface McpServiceInfo {
  installed: boolean;
  active: boolean;
  platform: string;
  workspace?: string;
  definitionPath?: string;
}

export async function installMcpService(workspaceInput: string): Promise<McpServiceInfo> {
  return installDeviceRelayService(workspaceInput);
}

export async function installDeviceRelayService(workspaceInput?: string): Promise<McpServiceInfo> {
  const existing = await readServiceConfig();
  const workspace = workspaceInput ? await realpath(resolve(workspaceInput)) : existing?.workspace;
  const entry = await realpath(process.argv[1] ?? "");
  const stateDir = frelyStateDir();
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700).catch(() => undefined);
  await writeServiceConfig(workspace);

  if (process.platform === "darwin") {
    const path = launchAgentPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, launchAgentPlist(entry, workspace, stateDir), { mode: 0o600 });
    const domain = `gui/${process.getuid?.() ?? 0}`;
    await execFile("launchctl", ["bootout", domain, path]).catch(() => undefined);
    await execFile("launchctl", ["bootstrap", domain, path]);
    await execFile("launchctl", ["kickstart", "-k", `${domain}/${LABEL}`]);
    return serviceStatus();
  }

  if (process.platform === "linux") {
    const path = systemdUnitPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, systemdUnit(entry, workspace), { mode: 0o600 });
    await execFile("systemctl", ["--user", "daemon-reload"]);
    await execFile("systemctl", ["--user", "enable", "--now", "frely-mcp.service"]);
    return serviceStatus();
  }

  throw new Error("Background MCP service setup supports macOS and Linux. Use `frely mcp serve` on this platform.");
}

export async function startMcpService(): Promise<McpServiceInfo> {
  if (process.platform === "darwin") {
    const path = launchAgentPath();
    const domain = `gui/${process.getuid?.() ?? 0}`;
    await execFile("launchctl", ["bootstrap", domain, path]).catch(async () => {
      await execFile("launchctl", ["kickstart", "-k", `${domain}/${LABEL}`]);
    });
    return serviceStatus();
  }
  if (process.platform === "linux") {
    await execFile("systemctl", ["--user", "start", "frely-mcp.service"]);
    return serviceStatus();
  }
  throw new Error("Background MCP service is not supported on this platform.");
}

export async function stopMcpService(): Promise<McpServiceInfo> {
  if (process.platform === "darwin") {
    const path = launchAgentPath();
    await execFile("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, path]).catch(() => undefined);
    return serviceStatus();
  }
  if (process.platform === "linux") {
    await execFile("systemctl", ["--user", "stop", "frely-mcp.service"]).catch(() => undefined);
    return serviceStatus();
  }
  throw new Error("Background MCP service is not supported on this platform.");
}

export async function uninstallMcpService(): Promise<void> {
  await stopMcpService().catch(() => undefined);
  if (process.platform === "darwin") await rm(launchAgentPath(), { force: true });
  else if (process.platform === "linux") {
    await execFile("systemctl", ["--user", "disable", "frely-mcp.service"]).catch(() => undefined);
    await rm(systemdUnitPath(), { force: true });
    await execFile("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
  }
  await rm(serviceConfigPath(), { force: true });
}

export async function serviceStatus(): Promise<McpServiceInfo> {
  const config = await readServiceConfig();
  if (process.platform === "darwin") {
    const path = launchAgentPath();
    const installed = await fileExists(path);
    let active = false;
    if (installed) {
      const domain = `gui/${process.getuid?.() ?? 0}`;
      active = await execFile("launchctl", ["print", `${domain}/${LABEL}`]).then(() => true, () => false);
    }
    return { installed, active, platform: "darwin", ...(config ? { workspace: config.workspace } : {}), ...(installed ? { definitionPath: path } : {}) };
  }
  if (process.platform === "linux") {
    const path = systemdUnitPath();
    const installed = await fileExists(path);
    const active = installed && await execFile("systemctl", ["--user", "is-active", "--quiet", "frely-mcp.service"]).then(() => true, () => false);
    return { installed, active, platform: "linux", ...(config ? { workspace: config.workspace } : {}), ...(installed ? { definitionPath: path } : {}) };
  }
  return { installed: false, active: false, platform: process.platform, ...(config ? { workspace: config.workspace } : {}) };
}

function frelyConfigDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely");
}

function frelyStateDir(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "frely");
}

function serviceConfigPath(): string {
  return join(frelyConfigDir(), "mcp-service.json");
}

function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function systemdUnitPath(): string {
  return join(frelyConfigDir(), "systemd", "user", "frely-mcp.service");
}

async function writeServiceConfig(workspace?: string): Promise<void> {
  const path = serviceConfigPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ version: 2, ...(workspace ? { workspace } : {}) }, null, 2)}\n`, { mode: 0o600 });
}

async function readServiceConfig(): Promise<{ workspace?: string } | null> {
  const raw = await readFile(serviceConfigPath(), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== 1 && value.version !== 2) return null;
    return typeof value.workspace === "string" ? { workspace: value.workspace } : {};
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  return readFile(path).then(() => true, () => false);
}

function launchAgentPlist(entry: string, workspace: string | undefined, stateDir: string): string {
  const path = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
  const args = [process.execPath, entry, "mcp", "serve", ...(workspace ? ["--workspace", workspace] : ["--provider-only"])];
  const argumentsXml = args.map((value) => `<string>${xml(value)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array>${argumentsXml}</array>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>${xml(join(stateDir, "mcp.log"))}</string>\n<key>StandardErrorPath</key><string>${xml(join(stateDir, "mcp.log"))}</string>\n</dict></plist>\n`;
}

function systemdUnit(entry: string, workspace?: string): string {
  const path = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
  const args = [process.execPath, entry, "mcp", "serve", ...(workspace ? ["--workspace", workspace] : ["--provider-only"])].map(systemdQuote).join(" ");
  return `[Unit]\nDescription=Frely Device Relay\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${args}\nRestart=always\nRestartSec=3\nEnvironment=${systemdQuote(`PATH=${path}`)}\n\n[Install]\nWantedBy=default.target\n`;
}

function xml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}
