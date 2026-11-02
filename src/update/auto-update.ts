import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { VERSION } from "../version.js";
import { diagnostic, type DiagnosticLog } from "../runtime/diagnostics.js";
import { inspectInstallation } from "./installation.js";
import type { MaintenanceGate } from "./maintenance.js";
import { compareVersions, latestRelease } from "./release.js";
import { installedVersion, installPackage, lockInstallation, prepareStandalone, type PreparedUpdate } from "./update.js";

export type AutoUpdateOutcome = "disabled" | "unsupported" | "current" | "busy" | "updated" | "failed";

const defaults = { inspectInstallation, latestRelease, installedVersion, prepareStandalone, installPackage, lockInstallation };
export type AutoUpdateDependencies = typeof defaults;

/** The device-local switch: a file, so the service and `frely link auto-update` need no shared process. Off when missing. */
export function autoUpdatePath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "auto-update");
}

export async function readAutoUpdate(path = autoUpdatePath()): Promise<boolean> {
  return (await readFile(path, "utf8").catch(() => "")).trim() === "on";
}

export async function writeAutoUpdate(enabled: boolean, path = autoUpdatePath()): Promise<void> {
  if (!enabled) { await rm(path, { force: true }); return; }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, "on\n", { mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * Older versions let the Relay turn auto-update on through a frame field. A frame carries no user signature, so that
 * switch is gone: only the local file (`frely link auto-update`) counts. The path stays only to delete a leftover file.
 */
export function remoteAutoUpdatePath(): string { return `${autoUpdatePath()}-remote`; }

/** On only when the local command switched it on; a leftover Relay-set file from an older version is removed, never read. */
export async function readEffectiveAutoUpdate(): Promise<boolean> {
  await rm(remoteAutoUpdatePath(), { force: true }).catch(() => {});
  return readAutoUpdate();
}

/**
 * Updates the installation this service runs from, only while idle and only when the owner switched it on.
 * It swaps files and leaves the restart to the existing installation watcher (service-refresh), so there is no
 * stop/start here and no remote update job: a call that is running keeps running on the old code until it ends.
 */
export class AutoUpdater {
  private running = false;
  constructor(private readonly options: { enabled: () => boolean | Promise<boolean>; gate: MaintenanceGate; log?: DiagnosticLog; deps?: AutoUpdateDependencies; version?: string }) {}

  async check(): Promise<AutoUpdateOutcome> {
    if (this.running) return "busy";
    this.running = true;
    const { gate, log } = this.options, d = this.options.deps ?? defaults, version = this.options.version ?? VERSION;
    try {
      if (!(await this.options.enabled())) return "disabled";
      const installation = await d.inspectInstallation();
      if (!["standalone", "npm", "bun"].includes(installation.method)) return "unsupported";
      const release = await d.latestRelease(installation);
      if (compareVersions(release.version, version) <= 0) return "current";
      if (!gate.idle) return "busy";
      const unlock = await d.lockInstallation(installation);
      let prepared: PreparedUpdate | undefined;
      try {
        const standalone = installation.method === "standalone";
        prepared = standalone ? await d.prepareStandalone(installation, release) : {
          apply: () => d.installPackage(installation, release.version), restore: () => d.installPackage(installation, version), cleanup: async () => {},
        };
        // The standalone swap is one rename of a verified file, so admission may pause for it; a package install can take minutes and must not.
        let paused = false;
        if (standalone) {
          try { gate.pause(); paused = true; } catch { return "busy"; }
          if (!gate.idle) return "busy";
        }
        try {
          await prepared.apply();
          if (await d.installedVersion(installation) !== release.version) throw new Error("Installed executable did not report the target version.");
        } catch (error) {
          await prepared.restore().catch(() => {});
          throw error;
        } finally { if (paused) gate.resume(); }
        diagnostic(log, "relay.auto_update_installed", {});
        return "updated";
      } finally {
        await prepared?.cleanup().catch(() => {});
        await unlock().catch(() => {});
      }
    } catch (error) {
      diagnostic(log, "relay.auto_update_failed", {}, error);
      return "failed";
    } finally { this.running = false; }
  }
}

/** Checks a few minutes after start, then every few hours, with jitter so a fleet does not hit the release source together. */
export function watchAutoUpdate(options: { gate: MaintenanceGate; signal: AbortSignal; enabled: () => boolean | Promise<boolean>; log?: DiagnosticLog;
  firstDelayMs?: number; intervalMs?: number; random?: () => number }): () => void {
  if (options.signal.aborted || !["darwin", "linux"].includes(process.platform)) return () => {};
  const updater = new AutoUpdater({ enabled: options.enabled, gate: options.gate, ...(options.log ? { log: options.log } : {}) });
  const random = options.random ?? Math.random, interval = options.intervalMs ?? 6 * 3600_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay: number) => {
    timer = setTimeout(() => { void updater.check().finally(() => { if (!options.signal.aborted) schedule(interval + random() * interval / 6); }); }, delay);
    timer.unref();
  };
  schedule((options.firstDelayMs ?? 10 * 60_000) + random() * 60_000);
  const close = () => { clearTimeout(timer); options.signal.removeEventListener("abort", close); };
  options.signal.addEventListener("abort", close, { once: true });
  return close;
}
