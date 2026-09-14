import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { cliLaunchArguments, IS_STANDALONE } from "./cli-launch.js";
import { windowsService } from "./service-windows.js";

const execFile = promisify(execFileCallback);
const LABEL = "cloud.frely.cli-mcp";
export interface McpServiceInfo { installed: boolean; active: boolean; platform: string; workspace?: string; definitionPath?: string }

export async function installMcpService(workspaceInput: string): Promise<McpServiceInfo> {
  return installDeviceRelayService(workspaceInput);
}
export async function installDeviceRelayService(workspaceInput?: string): Promise<McpServiceInfo> {
  const existing = await readServiceConfig();
  const workspace = workspaceInput ? await realpath(resolve(workspaceInput)) : existing?.workspace;
  const entry = IS_STANDALONE ? process.execPath : await realpath(process.argv[1] ?? "");
  const stateDir = frelyStateDir();
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(stateDir, 0o700);
  const command = serviceLaunchArguments(entry, workspace);
  await writeServiceConfig(workspace);
  if (process.platform === "darwin") {
    const path = launchAgentPath();
    await writeDefinition(path, launchAgentPlist(command, stateDir));
    const domain = `gui/${process.getuid?.() ?? 0}`;
    await execFile("launchctl", ["bootout", domain, path]).catch(() => undefined);
    await execFile("launchctl", ["bootstrap", domain, path]);
    await execFile("launchctl", ["kickstart", "-k", `${domain}/${LABEL}`]);
  } else if (process.platform === "linux") {
    await writeDefinition(systemdUnitPath(), systemdUnit(command));
    await execFile("systemctl", ["--user", "daemon-reload"]);
    await execFile("systemctl", ["--user", "enable", "--now", "frely-mcp.service"]);
    await execFile("systemctl", ["--user", "restart", "frely-mcp.service"]);
  } else if (process.platform === "win32") {
    await windowsService("install", command);
  } else throw new Error("Device Relay background services support macOS, Windows and Linux.");
  return serviceStatus();
}
export async function startMcpService(): Promise<McpServiceInfo> {
  if (process.platform === "darwin") {
    const domain = `gui/${process.getuid?.() ?? 0}`;
    await execFile("launchctl", ["bootstrap", domain, launchAgentPath()]).catch(async () => {
      await execFile("launchctl", ["kickstart", "-k", `${domain}/${LABEL}`]);
    });
  } else if (process.platform === "linux") await execFile("systemctl", ["--user", "start", "frely-mcp.service"]);
  else if (process.platform === "win32") await windowsService("start");
  else throw new Error("Background service is unsupported on this platform.");
  return serviceStatus();
}
export async function stopMcpService(): Promise<McpServiceInfo> {
  if (process.platform === "darwin") await execFile("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, launchAgentPath()]).catch(() => undefined);
  else if (process.platform === "linux") await execFile("systemctl", ["--user", "stop", "frely-mcp.service"]);
  else if (process.platform === "win32") await windowsService("stop");
  else throw new Error("Background service is unsupported on this platform.");
  return serviceStatus();
}
export async function uninstallMcpService(): Promise<void> {
  if (process.platform === "win32") await windowsService("uninstall");
  else {
    await stopMcpService();
    if (process.platform === "darwin") await rm(launchAgentPath(), { force: true });
    else if (process.platform === "linux") {
      await execFile("systemctl", ["--user", "disable", "frely-mcp.service"]);
      await rm(systemdUnitPath(), { force: true });
      await execFile("systemctl", ["--user", "daemon-reload"]);
    }
  }
  await rm(serviceConfigPath(), { force: true });
}
export async function serviceStatus(): Promise<McpServiceInfo> {
  const config = await readServiceConfig();
  const common = { platform: process.platform, ...(config?.workspace ? { workspace: config.workspace } : {}) };
  if (process.platform === "win32") return { ...common, ...await windowsService("status") };
  if (process.platform === "darwin") {
    const path = launchAgentPath(), installed = await fileExists(path);
    const active = installed && await execFile("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${LABEL}`])
      .then(({ stdout }) => /\bpid = \d+|\bstate = running/u.test(stdout), () => false);
    return { ...common, installed, active, ...(installed ? { definitionPath: path } : {}) };
  }
  if (process.platform === "linux") {
    const path = systemdUnitPath(), installed = await fileExists(path);
    const active = installed && await execFile("systemctl", ["--user", "is-active", "--quiet", "frely-mcp.service"]).then(() => true, () => false);
    return { ...common, installed, active, ...(installed ? { definitionPath: path } : {}) };
  }
  return { ...common, installed: false, active: false };
}

/** Service definitions carry configuration paths and storage mode, not encryption keys. */
export function serviceLaunchArguments(entry: string, workspace?: string): string[] {
  const mode = process.env.FRELY_CREDENTIAL_KEY !== undefined ? "encrypted-file" : process.env.FRELY_CREDENTIAL_STORE ?? "auto";
  return cliLaunchArguments(entry, ["mcp", "serve", "--service-config-home", resolve(process.env.XDG_CONFIG_HOME || join(homedir(), ".config")),
    "--service-credential-store", mode, ...(workspace ? ["--workspace", workspace] : ["--provider-only"])]);
}
function frelyConfigDir(): string { return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely"); }
function frelyStateDir(): string { return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "frely"); }
function serviceConfigPath(): string { return join(frelyConfigDir(), "mcp-service.json"); }
function launchAgentPath(): string { return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`); }
export function systemdUnitPath(): string { return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", "frely-mcp.service"); }
async function writeServiceConfig(workspace?: string): Promise<void> {
  const path = serviceConfigPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ version: 2, ...(workspace ? { workspace } : {}) }, null, 2)}\n`, { mode: 0o600 });
}
async function readServiceConfig(): Promise<{ workspace?: string } | null> {
  const raw = await readFile(serviceConfigPath(), "utf8").catch(() => null);
  if (!raw) return null;
  try { const value = JSON.parse(raw) as Record<string, unknown>; return value.version === 1 || value.version === 2 ? typeof value.workspace === "string" ? { workspace: value.workspace } : {} : null; }
  catch { return null; }
}
async function fileExists(path: string): Promise<boolean> { return readFile(path).then(() => true, () => false); }
async function writeDefinition(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { mode: 0o600 });
}
export function launchAgentPlist(command: string[], stateDir: string): string {
  const argumentsXml = command.map((value) => `<string>${xml(value)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array>${argumentsXml}</array>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH || "/usr/local/bin:/usr/bin:/bin")}</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>${xml(join(stateDir, "mcp.log"))}</string>\n<key>StandardErrorPath</key><string>${xml(join(stateDir, "mcp.log"))}</string>\n</dict></plist>\n`;
}
export function systemdUnit(command: string[]): string {
  const args = command.map(systemdQuote).join(" ");
  return `[Unit]\nDescription=Frely Device Relay\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${args}\nRestart=always\nRestartSec=3\nEnvironment=${systemdQuote(`PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`)}\n\n[Install]\nWantedBy=default.target\n`;
}
function xml(value: string): string {
  if (/[\x00-\x1f\x7f]/u.test(value)) throw new Error("Service arguments contain control characters.");
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}
function systemdQuote(value: string): string {
  if (/[\x00-\x1f\x7f]/u.test(value)) throw new Error("Service arguments contain control characters.");
  return '"' + value.replace(/%/gu, "%%").replace(/\$/gu, () => "$$").replace(/\\/gu, "\\\\").replace(/"/gu, '\\"') + '"';
}
