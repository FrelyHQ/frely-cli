import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, rm, rmdir, unlink, access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { inspectAuth, logout } from "./auth.js";
import { logoutCloud } from "./cloud.js";
import { revokeDevice } from "./device/control.js";
import { readDeviceBinding } from "./device/state.js";
import { inspectMcpMetadata, revokeMcpAuthorization } from "./mcp-authorization.js";
import { runNetwork } from "./network.js";
import { listLocalProviders } from "./provider/state.js";
import { serviceStatus, uninstallMcpService } from "./service.js";
import { removeSkillAdapter } from "./skill/access.js";
import { createNativeCredentialStore } from "./credential-native.js";
import { readAppInstall } from "./agent/app-install.js";
import { inspectInstallation, type Installation } from "./update/installation.js";

const execFile = promisify(execFileCallback);

export type UninstallGroup = "remote" | "service" | "agents" | "data" | "program";
export interface UninstallStep {
  id: string;
  group: UninstallGroup;
  label: string;
  paths?: string[];
  run(): Promise<string | void>;
}
export interface UninstallPlan {
  steps: UninstallStep[];
  /** Things deliberately left alone, with the reason. */
  keeps: string[];
  /** Follow-up the user may want to do by hand. */
  notes: string[];
}
export interface StepResult { id: string; group: UninstallGroup; label: string; status: "removed" | "failed" | "skipped"; detail?: string }
export interface UninstallResult { ok: boolean; results: StepResult[]; keeps: string[]; notes: string[] }

export interface UninstallDeps {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  pid: number;
  inspectInstallation: () => Promise<Installation>;
  parentPid: (pid: number) => Promise<number | null>;
  servicePid: () => Promise<{ installed: boolean; active: boolean; pid?: number }>;
  isLoggedIn: () => Promise<boolean>;
  hasMcpAuthorization: () => Promise<boolean>;
  hasDeviceBinding: () => Promise<boolean>;
  revokeMcp: () => Promise<void>;
  revokeDevice: () => Promise<void>;
  logoutCloud: () => Promise<void>;
  logoutNetwork: () => Promise<void>;
  logout: () => Promise<void>;
  uninstallService: () => Promise<void>;
  localProviderNames: () => Promise<string[]>;
  removeAgent: (distributionId: string, home: string) => Promise<void>;
  deleteVaultKey: (service: string, account: string) => Promise<void>;
  piNodePid: () => Promise<number | null>;
  terminate: (pid: number) => Promise<void>;
  runPackageManager: (file: string, args: string[]) => Promise<void>;
  spawnDetached: (file: string, args: string[], env: NodeJS.ProcessEnv) => void;
  which: (name: string) => Promise<string[]>;
}

export const VAULT_SERVICE = "frely-cli-vault";
const STAGE_PATTERNS = [/^\.frely-install\./u, /^\.frely-update-/u, /^\.frely-update\.lock$/u];
const PROFILE_MARKER = "# Frely user bin";
const DISTRIBUTION_FILE = /^([A-Za-z0-9_-]{1,128})\.json$/u;
const NETWORK_HOST_ROOTS = (home: string) => [join(home, ".claude", "skills"), join(home, ".config", "opencode", "skills"), join(home, ".agents", "skills")];

export const defaultDeps = (): UninstallDeps => ({
  platform: process.platform,
  home: homedir(),
  env: process.env,
  pid: process.pid,
  inspectInstallation: () => inspectInstallation(),
  parentPid,
  servicePid: async () => { const status = await serviceStatus(); return { installed: status.installed, active: status.active, ...(status.pid ? { pid: status.pid } : {}) }; },
  isLoggedIn: async () => (await inspectAuth().catch(() => null))?.configured === true,
  hasMcpAuthorization: async () => (await inspectMcpMetadata().catch(() => null)) !== null,
  hasDeviceBinding: async () => (await readDeviceBinding().catch(() => null)) !== null,
  revokeMcp: () => revokeMcpAuthorization(),
  revokeDevice,
  logoutCloud,
  logoutNetwork: async () => { await runNetwork(["network", "logout", "--json"]); },
  logout,
  uninstallService: uninstallMcpService,
  localProviderNames: async () => (await listLocalProviders().catch(() => [])).map((provider) => provider.name),
  removeAgent: async (distributionId, home) => { await removeSkillAdapter(distributionId, home); },
  deleteVaultKey: async (service, account) => { await createNativeCredentialStore().deletePassword(service, account); },
  piNodePid: async () => {
    const install = await readAppInstall().catch(() => null);
    if (!install) return null;
    const endpoint = JSON.parse(await readFile(join(install.agentDir, "frely", "headless.json"), "utf8").catch(() => "null")) as { pid?: unknown } | null;
    return endpoint && Number.isSafeInteger(endpoint.pid) ? endpoint.pid as number : null;
  },
  terminate: terminateProcess,
  runPackageManager: async (file, args) => { await execFile(file, args, { cwd: homedir(), timeout: 120_000, maxBuffer: 1024 * 1024 }); },
  spawnDetached: (file, args, env) => { spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true, env }).unref(); },
  which: whichAll,
});

/** True when this process was started by the running Device Relay service, e.g. a command run through device MCP. */
export async function runsInsideService(deps: Pick<UninstallDeps, "pid" | "parentPid" | "servicePid">): Promise<boolean> {
  const service = await deps.servicePid().catch(() => null);
  if (!service?.active || !service.pid) return false;
  let current: number | null = deps.pid;
  for (let depth = 0; current && depth < 64; depth++) {
    if (current === service.pid) return true;
    current = await deps.parentPid(current).catch(() => null);
  }
  return false;
}

export async function buildPlan(deps: UninstallDeps = defaultDeps()): Promise<UninstallPlan> {
  const steps: UninstallStep[] = [];
  const keeps: string[] = [];
  const notes: string[] = [];
  const { home, env } = deps;
  const configRoot = env.XDG_CONFIG_HOME || join(home, ".config");
  const configDir = join(configRoot, "frely");
  const stateDir = join(env.XDG_STATE_HOME || join(home, ".local", "state"), "frely");
  const cacheDir = join(env.XDG_RUNTIME_DIR || join(home, ".cache"), "frely");

  // A. Account side first: it needs the stored login.
  if (await deps.isLoggedIn()) {
    if (await deps.hasMcpAuthorization()) steps.push({ id: "revoke-mcp", group: "remote", label: "Revoke this device's Device MCP authorization", run: deps.revokeMcp });
    if (await deps.hasDeviceBinding()) steps.push({ id: "revoke-device", group: "remote", label: "Remove this device from your Frely account", run: async () => {
      await deps.revokeDevice();
    } });
    steps.push({ id: "logout-cloud", group: "remote", label: "Revoke Cloud authorization", run: deps.logoutCloud });
    steps.push({ id: "logout-network", group: "remote", label: "Sign out of Frely Network", run: deps.logoutNetwork });
    steps.push({ id: "logout", group: "remote", label: "Revoke the account login", run: deps.logout });
  }

  // B. Background service, and the Pi Node the App's service leaves running.
  const service = await deps.servicePid().catch(() => ({ installed: false, active: false }));
  const piPid = await deps.piNodePid().catch(() => null);
  if (piPid) steps.push({ id: "stop-pi-node", group: "service", label: `Stop the Frely App Pi Node process (pid ${piPid})`, run: () => deps.terminate(piPid) });
  if (service.installed || service.active) {
    steps.push({ id: "uninstall-service", group: "service", label: "Stop and uninstall the Device Relay background service", paths: servicePaths(deps), run: deps.uninstallService });
  }

  // E. Installed Agent Skills (they call `frely agent run`, so they stop working without the CLI).
  const recordsDir = join(home, ".config", "frely", "skills");
  for (const name of (await readdir(recordsDir).catch(() => [] as string[])).sort()) {
    const id = DISTRIBUTION_FILE.exec(name)?.[1];
    if (!id) continue;
    const skillPath = await readFile(join(recordsDir, name), "utf8").then((raw) => (JSON.parse(raw) as { skillPath?: unknown }).skillPath, () => undefined);
    steps.push({ id: `agent:${id}`, group: "agents", label: `Remove installed Agent Skill ${id}`, ...(typeof skillPath === "string" ? { paths: [skillPath] } : {}), run: () => deps.removeAgent(id, home) });
  }
  for (const root of NETWORK_HOST_ROOTS(home)) {
    const folder = join(root, "frely-network");
    if (await managedNetworkSkill(folder)) steps.push({ id: `network-skill:${folder}`, group: "agents", label: "Remove the Frely Network Skill", paths: [folder], run: () => removeNetworkSkill(folder) });
  }

  // C/D. Local data, credentials, state and cache.
  const providers = await deps.localProviderNames();
  if (providers.length > 0) notes.push(`${providers.length} local Provider(s) (${providers.join(", ")}) stay in your Frely account but go offline; delete them in the web console if you no longer need them.`);
  const appJson = join(configDir, "app.json");
  const appInstalled = await exists(appJson);
  if (appInstalled) keeps.push(`${appJson} (written by the Frely App, which uninstall does not remove; use \`frely app uninstall\` first if you want it gone)`);
  const dataPaths: string[] = [];
  const legacySkills = join(home, ".config", "frely", "skills");
  for (const path of [configDir, stateDir, cacheDir, ...(legacySkills.startsWith(configDir + "/") || legacySkills.startsWith(configDir + "\\") ? [] : [legacySkills])]) if (await exists(path)) dataPaths.push(path);
  if (dataPaths.length > 0) {
    const vaultRoot = resolve(join(configDir, "system-credentials-v1"));
    const hasVault = await exists(vaultRoot);
    steps.push({ id: "remove-data", group: "data", label: "Delete saved login, device identity, MCP and Provider settings, service state and caches", paths: dataPaths, run: async () => {
      const failures: string[] = [];
      if (hasVault) await deps.deleteVaultKey(VAULT_SERVICE, `v1:${createHash("sha256").update(vaultRoot).digest("hex")}`).catch(() => failures.push("the OS credential vault entry frely-cli-vault (delete it in Keychain Access / Credential Manager / your Secret Service)"));
      for (const path of dataPaths) {
        const preserved = path === configDir && appInstalled ? [appJson] : [];
        failures.push(...await removeDirectory(path, preserved));
      }
      if (failures.length > 0) throw new Error(`could not remove: ${failures.join(", ")}`);
    } });
  }

  // H. The program itself, always last.
  const installation = await deps.inspectInstallation().catch(() => null);
  if (installation) addProgramStep(steps, keeps, installation, deps);
  for (const other of await deps.which("frely").catch(() => [] as string[])) {
    if (installation && other !== installation.entry) notes.push(`Another \`frely\` is on PATH at ${other}; uninstall it with the tool that installed it.`);
  }
  for (const profile of [".zshrc", ".bashrc", ".bash_profile", ".bash_login", ".profile"]) {
    const path = join(home, profile);
    if ((await readFile(path, "utf8").catch(() => "")).includes(PROFILE_MARKER)) notes.push(`${path} still has the "${PROFILE_MARKER}" PATH lines added by install.sh; they are harmless, remove them by hand if you want.`);
  }
  if (deps.platform === "darwin") notes.push("macOS may still list Open Computer Use under Accessibility / Screen Recording; remove it in System Settings if you enabled computer use.");
  notes.push("The Device MCP URL you added to MCP clients (Claude, ChatGPT, ...) stops working for this device; delete that connection in the client.");
  notes.push("Marketplace items installed with `frely item install` (folders with .frely-managed.json) are not removed.");
  return { steps, keeps, notes };
}

function addProgramStep(steps: UninstallStep[], keeps: string[], installation: Installation, deps: UninstallDeps): void {
  const windows = installation.platform === "win32";
  if (installation.method === "standalone") {
    const directory = dirname(installation.entry);
    if (windows) {
      steps.push({ id: "remove-program", group: "program", label: "Remove the frely program after this command exits", paths: [installation.entry], run: async () => {
        deps.spawnDetached(join(deps.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_REMOVE_SCRIPT],
          { ...deps.env, FRELY_UNINSTALL_PID: String(deps.pid), FRELY_UNINSTALL_FILE: installation.entry });
        return "scheduled; finishes a moment after this command exits";
      } });
    } else {
      steps.push({ id: "remove-program", group: "program", label: "Remove the frely program", paths: [installation.entry], run: async () => {
        await unlink(installation.entry);
        for (const name of await readdir(directory).catch(() => [] as string[])) {
          if (STAGE_PATTERNS.some((pattern) => pattern.test(name))) await rm(join(directory, name), { recursive: true, force: true });
        }
      } });
    }
  } else if (installation.method === "npm" || installation.method === "bun") {
    const manager = installation.manager!;
    const args = installation.method === "npm" ? ["uninstall", "--global", "--prefix", installation.prefix!, "frely-cli"] : ["remove", "--global", "frely-cli"];
    const label = `Uninstall the frely-cli package (${installation.method} global)`;
    if (windows) {
      steps.push({ id: "remove-program", group: "program", label, run: async () => {
        deps.spawnDetached(join(deps.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PACKAGE_SCRIPT],
          { ...deps.env, FRELY_UNINSTALL_PID: String(deps.pid), FRELY_UNINSTALL_MANAGER: manager, FRELY_UNINSTALL_ARGS: JSON.stringify(args) });
        return "scheduled; finishes a moment after this command exits";
      } });
    } else steps.push({ id: "remove-program", group: "program", label, run: () => deps.runPackageManager(manager, args) });
  } else {
    keeps.push(`${installation.entry} (${installation.reason ?? "installation not managed by an installer Frely recognises"}); remove it with the tool that installed it.`);
  }
}

/** Execution takes parameters only through the environment, never through the script text. */
const WINDOWS_REMOVE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$file = $env:FRELY_UNINSTALL_FILE
Wait-Process -Id ([int]$env:FRELY_UNINSTALL_PID) -Timeout 60
for ($i = 0; $i -lt 50 -and (Test-Path -LiteralPath $file); $i++) { Remove-Item -LiteralPath $file -Force; if (Test-Path -LiteralPath $file) { Start-Sleep -Milliseconds 200 } }
$dir = Split-Path -Parent $file
if ((Test-Path -LiteralPath $dir) -and -not (Get-ChildItem -LiteralPath $dir -Force | Where-Object { $_.Name -notlike '.frely-*' })) {
  Get-ChildItem -LiteralPath $dir -Force | Remove-Item -Recurse -Force
  Remove-Item -LiteralPath $dir -Force
  $user = [Environment]::GetEnvironmentVariable('PATH', 'User')
  if ($user) { [Environment]::SetEnvironmentVariable('PATH', (($user -split ';' | Where-Object { $_ -and $_ -ne $dir }) -join ';'), 'User') }
}
`;
const WINDOWS_PACKAGE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Wait-Process -Id ([int]$env:FRELY_UNINSTALL_PID) -Timeout 60
$arguments = $env:FRELY_UNINSTALL_ARGS | ConvertFrom-Json
& $env:FRELY_UNINSTALL_MANAGER @arguments
`;

export interface ExecuteOptions {
  /** Decide whether to continue to local deletion after an account-side step failed. */
  continueAfterRemoteFailure: (failed: StepResult[]) => Promise<boolean> | boolean;
}

export async function executePlan(plan: UninstallPlan, options: ExecuteOptions): Promise<UninstallResult> {
  const results: StepResult[] = [];
  let proceed = true;
  for (const [index, step] of plan.steps.entries()) {
    if (!proceed) { results.push(summary(step, "skipped", "not run: the account-side revocation failed")); continue; }
    try {
      const detail = await step.run();
      results.push(summary(step, "removed", detail || undefined));
    } catch (error) {
      results.push(summary(step, "failed", error instanceof Error ? error.message : String(error)));
    }
    const next = plan.steps[index + 1];
    if (step.group === "remote" && (!next || next.group !== "remote") && results.some((entry) => entry.group === "remote" && entry.status === "failed")) {
      proceed = await options.continueAfterRemoteFailure(results.filter((entry) => entry.group === "remote" && entry.status === "failed"));
    }
  }
  const failed = results.some((entry) => entry.status !== "removed");
  return { ok: !failed, results, keeps: plan.keeps, notes: plan.notes };
}

const summary = (step: UninstallStep, status: StepResult["status"], detail?: string): StepResult => ({ id: step.id, group: step.group, label: step.label, status, ...(detail ? { detail } : {}) });

const GROUP_TITLES: Record<UninstallGroup, string> = {
  remote: "Account and authorization (revoked first, while you are still signed in)",
  service: "Background service",
  agents: "Installed Agent Skills",
  data: "Local data",
  program: "Program",
};

export function formatPlan(plan: UninstallPlan): string {
  const lines = ["Frely will remove the following from this computer:\n"];
  for (const group of Object.keys(GROUP_TITLES) as UninstallGroup[]) {
    const steps = plan.steps.filter((step) => step.group === group);
    if (steps.length === 0) continue;
    lines.push(`\n${GROUP_TITLES[group]}:\n`);
    for (const step of steps) {
      lines.push(`  - ${step.label}\n`);
      for (const path of step.paths ?? []) lines.push(`      ${path}\n`);
    }
  }
  if (plan.steps.length === 0) lines.push("  (nothing found)\n");
  if (plan.keeps.length > 0) lines.push("\nNot removed:\n", ...plan.keeps.map((item) => `  - ${item}\n`));
  if (plan.notes.length > 0) lines.push("\nGood to know:\n", ...plan.notes.map((item) => `  - ${item}\n`));
  return lines.join("");
}

export function formatResult(result: UninstallResult): string {
  const lines = [result.ok ? "Frely was uninstalled.\n" : "Frely was only partly uninstalled. These items need attention:\n"];
  for (const entry of result.results) {
    if (entry.status === "removed") lines.push(`  removed  ${entry.label}${entry.detail ? ` (${entry.detail})` : ""}\n`);
    else lines.push(`  ${entry.status === "failed" ? "FAILED " : "skipped"}  ${entry.label}: ${entry.detail ?? ""}\n`);
  }
  for (const failed of result.results.filter((entry) => entry.status !== "removed")) {
    if (failed.group === "remote") lines.push("\nAuthorization on the Frely side may still be active. Review Device MCP and account security in the Frely web console and revoke it there.\n");
    break;
  }
  if (result.keeps.length > 0) lines.push("\nNot removed:\n", ...result.keeps.map((item) => `  - ${item}\n`));
  if (result.notes.length > 0) lines.push("\nGood to know:\n", ...result.notes.map((item) => `  - ${item}\n`));
  return lines.join("");
}

async function exists(path: string): Promise<boolean> { return lstat(path).then(() => true, () => false); }

/** Remove a directory tree without following links; a link at the top is removed itself, never its target. */
async function removeDirectory(path: string, preserve: string[]): Promise<string[]> {
  const failures: string[] = [];
  const info = await lstat(path).catch(() => null);
  if (!info) return failures;
  if (info.isSymbolicLink() || !info.isDirectory()) {
    await unlink(path).catch(() => failures.push(path));
    return failures;
  }
  for (const name of await readdir(path)) {
    const child = join(path, name);
    if (preserve.includes(child)) continue;
    await rm(child, { recursive: true, force: true }).catch(() => failures.push(child));
  }
  if (preserve.length === 0) await rmdir(path).catch(() => failures.push(path));
  return failures;
}

async function managedNetworkSkill(folder: string): Promise<boolean> {
  const marker = await readFile(join(folder, ".frely-managed.json"), "utf8").then((raw) => JSON.parse(raw) as Record<string, unknown>, () => null);
  if (!marker || marker.version !== 1 || marker.owner !== "frely-network" || typeof marker.sha256 !== "string") return false;
  const text = await readFile(join(folder, "SKILL.md"), "utf8").catch(() => null);
  return text !== null && createHash("sha256").update(text).digest("hex") === marker.sha256;
}

async function removeNetworkSkill(folder: string): Promise<void> {
  if (!await managedNetworkSkill(folder)) throw new Error("the Skill was modified; left in place");
  await unlink(join(folder, "SKILL.md"));
  await unlink(join(folder, ".frely-managed.json"));
  await rmdir(folder).catch(() => undefined);
}

function servicePaths(deps: UninstallDeps): string[] {
  const configRoot = deps.env.XDG_CONFIG_HOME || join(deps.home, ".config");
  if (deps.platform === "darwin") return [join(deps.home, "Library", "LaunchAgents", "cloud.frely.cli-mcp.plist")];
  if (deps.platform === "linux") return [join(configRoot, "systemd", "user", "frely-mcp.service")];
  return [];
}

async function whichAll(name: string): Promise<string[]> {
  const found: string[] = [];
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const suffix of process.platform === "win32" ? [".exe", ".cmd", ""] : [""]) {
      const path = join(directory, name + suffix);
      if (await access(path, constants.X_OK).then(() => true, () => false)) {
        const real = await realpath(path).catch(() => path);
        if (!found.includes(real)) found.push(real);
      }
    }
  }
  return found;
}

async function parentPid(pid: number): Promise<number | null> {
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(fields[1]) || null;
  }
  if (process.platform === "win32") {
    const { stdout } = await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").ParentProcessId`], { timeout: 10_000 });
    return Number(stdout.trim()) || null;
  }
  const { stdout } = await execFile("ps", ["-o", "ppid=", "-p", String(Math.trunc(pid))], { timeout: 5_000 });
  return Number(stdout.trim()) || null;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function terminateProcess(pid: number): Promise<void> {
  if (!alive(pid)) return;
  process.kill(pid, "SIGTERM");
  for (let waited = 0; waited < 5_000; waited += 100) {
    if (!alive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (alive(pid)) process.kill(pid, "SIGKILL");
}

export interface UninstallIo {
  write: (text: string) => void;
  /** Resolve true when the user confirms; undefined means no terminal is available. */
  prompt?: (question: string) => Promise<string>;
  interactive: boolean;
}

/** Entry point for `frely uninstall`. Returns the process exit code. */
export async function runUninstall(args: string[], io: UninstallIo, deps: UninstallDeps = defaultDeps()): Promise<number> {
  const unknown = args.filter((arg) => arg !== "--yes" && arg !== "--json");
  if (unknown.length > 0) throw new Error("Usage: frely uninstall [--yes] [--json]");
  const yes = args.includes("--yes");
  const json = args.includes("--json");
  // A command run through device MCP is a child of the service this command would stop.
  if (await runsInsideService(deps)) throw new Error("`frely uninstall` stops the background service that is running this command. Run it in a terminal on this computer instead. Nothing was changed.");
  const plan = await buildPlan(deps);
  if (!yes && (json || !io.interactive || !io.prompt)) {
    io.write(json ? `${JSON.stringify({ ok: false, confirmed: false, plan: planView(plan) })}\n` : `${formatPlan(plan)}\nNothing was removed. Run \`frely uninstall --yes\` to remove everything above.\n`);
    return 1;
  }
  if (!yes) {
    io.write(formatPlan(plan));
    if ((await io.prompt!("\nType yes to remove everything above: ")).trim().toLowerCase() !== "yes") { io.write("Nothing was removed.\n"); return 1; }
  }
  const result = await executePlan(plan, {
    continueAfterRemoteFailure: async (failed) => {
      if (yes || !io.interactive || !io.prompt) return true;
      io.write(`\nThese account-side steps failed:\n${failed.map((entry) => `  - ${entry.label}: ${entry.detail ?? ""}\n`).join("")}`);
      return (await io.prompt("Continue and delete local files anyway? Type yes to continue: ")).trim().toLowerCase() === "yes";
    },
  });
  io.write(json ? `${JSON.stringify({ ok: result.ok, confirmed: true, results: result.results, keeps: result.keeps, notes: result.notes })}\n` : formatResult(result));
  return result.ok ? 0 : 1;
}

const planView = (plan: UninstallPlan) => ({ steps: plan.steps.map((step) => ({ id: step.id, group: step.group, label: step.label, ...(step.paths ? { paths: step.paths } : {}) })), keeps: plan.keeps, notes: plan.notes });
