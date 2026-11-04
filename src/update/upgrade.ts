import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../version.js";
import { diagnostic, type DiagnosticLog } from "../runtime/diagnostics.js";
import { inspectInstallation, manualUpdateCommand, type Installation } from "./installation.js";
import type { MaintenanceGate } from "./maintenance.js";
import { compareVersions, latestRelease } from "./release.js";
import { installedVersion, lockInstallation, prepareStandalone, removeStaleWindowsExecutables, type PreparedUpdate } from "./update.js";

export type UpgradeOutcome = "current" | "busy" | "updated" | "manual" | "unsupported" | "failed";
export interface UpgradeStatus { state: "idle" | "running" | UpgradeOutcome; target?: string; command?: string; at: string }

let status: UpgradeStatus = { state: "idle", at: new Date(0).toISOString() };
/** What the web console shows next to the version number; reported with the device capabilities. */
export const upgradeStatus = (): UpgradeStatus => status;

const defaults = { inspectInstallation, latestRelease, installedVersion, prepareStandalone, lockInstallation, removeStaleWindowsExecutables };
export type UpgradeDependencies = typeof defaults;

/** Older versions had an automatic updater with a local switch; both are gone. Only deletes the leftover files. */
export async function removeLegacyAutoUpdate(directory = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely")): Promise<void> {
  for (const name of ["auto-update", "auto-update-remote"]) await rm(join(directory, name), { force: true }).catch(() => {});
}

/**
 * One upgrade, started by the owner from the web console. It only installs the newest stable release of a standalone
 * installation, only after its offline release signature verifies, and only while the service is idle. There is no
 * schedule: nothing here runs unless the owner asked.
 */
export class Upgrader {
  private running = false;
  constructor(private readonly options: { gate: MaintenanceGate; restart: () => void; log?: DiagnosticLog; deps?: UpgradeDependencies; version?: string;
    signing?: { keys?: readonly string[]; required?: boolean }; windowsRestart?: (installation: Installation) => void }) {}

  async runOnce(): Promise<UpgradeOutcome> {
    if (this.running) return "busy";
    this.running = true;
    const d = this.options.deps ?? defaults, version = this.options.version ?? VERSION, { gate, log } = this.options;
    const set = (state: UpgradeStatus["state"], extra: Partial<UpgradeStatus> = {}) => { status = { state, at: new Date().toISOString(), ...extra }; return state as UpgradeOutcome; };
    try {
      set("running");
      const installation = await d.inspectInstallation();
      const release = await d.latestRelease(installation);
      if (compareVersions(release.version, version) <= 0) return set("current", { target: release.version });
      // Package managers cannot check Frely's own release signature, so a remote request never drives them.
      if (installation.method !== "standalone") return set(["npm", "bun"].includes(installation.method) ? "manual" : "unsupported", { target: release.version, command: manualUpdateCommand(installation, release.version) });
      if (!gate.idle) return set("busy", { target: release.version });
      const unlock = await d.lockInstallation(installation);
      let prepared: PreparedUpdate | undefined;
      try {
        prepared = await d.prepareStandalone(installation, release, undefined, undefined, undefined, { required: true, ...(this.options.signing ?? {}) });
        let paused = false;
        try { gate.pause(); paused = true; } catch { return set("busy", { target: release.version }); }
        if (!gate.idle) return set("busy", { target: release.version });
        try {
          await prepared.apply();
          if (await d.installedVersion(installation) !== release.version) throw new Error("Installed executable did not report the target version.");
        } catch (error) { await prepared.restore().catch(() => {}); throw error; }
        finally { if (paused) gate.resume(); }
        diagnostic(log, "relay.upgrade_installed", {});
        set("updated", { target: release.version });
        // macOS and Linux: the installation watcher restarts the idle service. Windows has no watcher, so restart here.
        if (installation.platform === "win32") (this.options.windowsRestart ?? restartWindowsService)(installation), this.options.restart();
        return "updated";
      } finally {
        await prepared?.cleanup().catch(() => {});
        await unlock().catch(() => {});
        await d.removeStaleWindowsExecutables(installation).catch(() => {});
      }
    } catch (error) {
      diagnostic(log, "relay.upgrade_failed", {}, error);
      return set("failed", status.target ? { target: status.target } : {});
    } finally { this.running = false; }
  }
}

/** The scheduled task ignores a start while the old process still runs, so a detached helper waits for it to exit first. */
export function restartWindowsService(installation: Installation): void {
  const command = `Start-Sleep -Seconds 6; & '${installation.entry.replace(/'/gu, "''")}' mcp service start`;
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", command], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}
