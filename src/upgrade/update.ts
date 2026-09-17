import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, copyFile, lstat, mkdtemp, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { VERSION } from "../version.js";
import { readDeviceBinding } from "../device/state.js";
import { connectionIsLive, readConnectionStatus } from "../device/connection-status.js";
import { serviceCommand, serviceStatus, startMcpService, stopMcpService } from "../service.js";
import { inspectInstallation, manualUpgradeCommand, packageArguments, type Installation } from "./installation.js";
import { compareVersions, latestRelease, standaloneAsset, type Release } from "./release.js";
import { acquireMaintenance } from "./maintenance.js";

const execFile = promisify(execFileCallback);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export interface UpgradeResult { state: "current" | "manual" | "upgraded"; message: string }

export interface UpgradeInspection { currentVersion: string; latestVersion?: string; installation: Installation; state: "unsupported" | "available" | "current" | "unavailable"; message: string }
export async function inspectUpgrade(): Promise<UpgradeInspection> {
  const installation = await inspectInstallation().catch((): Installation => ({ method: "unknown", entry: process.argv[1] ?? process.execPath, platform: process.platform, reason: "Installation could not be inspected." }));
  if (installation.method === "unknown" || installation.method === "source") {
    return { currentVersion: VERSION, installation, state: "unsupported" as const, message: installation.reason! };
  }
  try {
    const release = await latestRelease(installation);
    const available = compareVersions(release.version, VERSION) > 0;
    return { currentVersion: VERSION, latestVersion: release.version, installation, state: available ? "available" as const : "current" as const,
      message: available ? `${VERSION} → ${release.version}. Run frely upgrade.` : `${VERSION} is up to date.` };
  } catch {
    return { currentVersion: VERSION, installation, state: "unavailable" as const, message: "Version lookup unavailable. Check connectivity and run frely doctor again." };
  }
}

export async function installedVersion(installation: Installation): Promise<string> {
  const file = installation.method === "standalone" ? installation.entry : process.execPath;
  const args = installation.method === "standalone" ? ["--version"] : [installation.entry, "--version"];
  return (await execFile(file, args, { cwd: homedir(), timeout: 10000, maxBuffer: 65536 })).stdout.trim();
}

async function download(url: string, destination: string, maxBytes: number): Promise<void> {
  const signal = AbortSignal.timeout(60000);
  let response: Response | undefined;
  for (let redirects = 0; redirects < 5; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(parsed.hostname)) throw new Error("Unsupported release download location.");
    response = await fetch(url, { signal, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Missing release redirect.");
      url = new URL(location, url).toString();
    } else break;
  }
  if (!response?.ok || !response.body) throw new Error("Release download failed.");
  const file = await open(destination, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error("Release download exceeds its size limit.");
      await file.writeFile(chunk);
    }
    await file.sync();
  } finally { await file.close(); }
}

export async function validateStandalone(path: string, checksum: string, version: string, execute = installedVersion): Promise<void> {
  const match = /^([a-fA-F0-9]{64})(?:\s|$)/u.exec(checksum);
  if (!match) throw new Error("Invalid release checksum.");
  const hash = createHash("sha256").update(await readFile(path)).digest("hex");
  if (hash !== match[1]!.toLowerCase()) throw new Error("Release checksum mismatch; the installed executable was not changed.");
  await chmod(path, 0o755);
  if (await execute({ method: "standalone", platform: process.platform, entry: path }) !== version) throw new Error("Downloaded executable did not report the target version.");
}

export interface PreparedUpdate { apply(): Promise<void>; restore(): Promise<void>; cleanup(): Promise<void> }
export async function prepareStandalone(installation: Installation, release: Release,
  fetchFile = download, execute = installedVersion): Promise<PreparedUpdate> {
  const target = installation.entry;
  if (!(await lstat(target)).isFile()) throw new Error("The installation is not a regular file.");
  const stage = await mkdtemp(join(dirname(target), ".frely-upgrade-"));
  const next = join(stage, "frely"), backup = join(stage, "previous");
  try {
    const asset = standaloneAsset();
    await fetchFile(`${release.baseUrl}/${asset}.sha256`, join(stage, "checksum"), 1024);
    await fetchFile(`${release.baseUrl}/${asset}`, next, 200 * 1024 * 1024);
    await validateStandalone(next, await readFile(join(stage, "checksum"), "utf8"), release.version, execute);
    await copyFile(target, backup);
    return {
      apply: () => rename(next, target),
      restore: () => rename(backup, target),
      cleanup: () => rm(stage, { recursive: true, force: true }),
    };
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}

async function installPackage(installation: Installation, version: string): Promise<void> {
  // Installation failures may contain registry credentials. Expose a bounded generic error instead.
  try {
    await execFile(installation.manager!, packageArguments(installation, version), { cwd: homedir(), timeout: 180000, maxBuffer: 1024 * 1024 });
  } catch { throw new Error("The package manager could not update frely-cli. Check its registry, permissions and global installation; no other manager was tried."); }
}

async function lockInstallation(installation: Installation): Promise<() => Promise<void>> {
  const directory = installation.method === "standalone" ? dirname(installation.entry) : dirname(dirname(dirname(installation.entry)));
  const path = join(directory, ".frely-upgrade.lock");
  const file = await open(path, "wx", 0o600).catch(() => { throw new Error(`Cannot acquire upgrade lock: ${path}. Check directory permissions or another upgrade. Remove a stale lock only after confirming no upgrade is running.`); });
  await file.writeFile(`${process.pid}\n`);
  return async () => { await file.close(); await rm(path, { force: true }); };
}

const defaults = { inspectInstallation, latestRelease, installedVersion, serviceStatus, serviceCommand, stopMcpService, startMcpService,
  readDeviceBinding, readConnectionStatus, acquireMaintenance, prepareStandalone, installPackage, lockInstallation, pause };
export type UpgradeDependencies = typeof defaults;

/** Upgrade in the calling terminal. Busy MCP callers fail before any service stop or package write. */
export async function upgrade(write: (message: string) => void, dependencies: UpgradeDependencies = defaults): Promise<UpgradeResult> {
  const d = dependencies, installation = await d.inspectInstallation();
  if (installation.method === "source" || installation.method === "unknown") throw new Error(installation.reason);
  const release = await d.latestRelease(installation);
  if (compareVersions(release.version, VERSION) <= 0) return { state: "current", message: `Frely ${VERSION} is up to date.` };
  const service = await d.serviceStatus();
  if (installation.platform === "win32") return { state: "manual", message: `Update ${VERSION} → ${release.version}. Finish any running Frely tasks, then run this command in a local PowerShell terminal:\n\n${manualUpgradeCommand(installation, release.version, service.active)}\n\nAfter installation, run frely doctor. No files or services were changed by frely upgrade.` };
  if (!["darwin", "linux"].includes(installation.platform)) throw new Error("This platform requires a manual update.");
  if (service.active) {
    const command = await d.serviceCommand();
    const entry = command?.[installation.method === "standalone" ? 0 : 1];
    if (!service.pid || !entry || await realpath(entry).catch(() => entry) !== installation.entry) throw new Error("The running service does not match this installation. Inspect frely doctor -v before upgrading.");
  }
  const unlock = await d.lockInstallation(installation);
  let prepared: PreparedUpdate | undefined, releaseMaintenance: (() => void) | undefined;
  let attempted = false, stopped = false, preserveRecovery = false;
  try {
    write(`Updating Frely ${VERSION} → ${release.version} (${installation.method}).\n`);
    prepared = installation.method === "standalone" ? await d.prepareStandalone(installation, release) : {
      apply: () => d.installPackage(installation, release.version), restore: () => d.installPackage(installation, VERSION), cleanup: async () => {},
    };
    // Prepare downloads before pausing admission. A command inside this MCP is itself busy and cannot stop its parent.
    if (service.active) releaseMaintenance = await d.acquireMaintenance(service.pid!);
    if (service.active) {
      const current = await d.serviceStatus();
      if (!current.active || current.pid !== service.pid) throw new Error("The service changed during upgrade preparation. Run frely doctor, then retry.");
      stopped = true;
      await d.stopMcpService();
      for (let i = 0; i < 30 && (await d.serviceStatus()).active; i++) await d.pause(100);
      if ((await d.serviceStatus()).active) throw new Error("The service did not stop; the installation was not changed.");
    }
    attempted = true;
    await prepared.apply();
    if (await d.installedVersion(installation) !== release.version) throw new Error("Installed executable did not report the target version.");
    attempted = false; // Installation verified. Service/network failures must not revert a working binary.
    if (stopped) {
      await d.startMcpService();
      const binding = await d.readDeviceBinding();
      let started = false, connected = false;
      for (let i = 0; i < 40; i++) {
        const active = await d.serviceStatus();
        const observation = binding ? await d.readConnectionStatus(binding) : null;
        if (active.active && observation && observation.pid === active.pid && observation.cliVersion === release.version && observation.entry === installation.entry) {
          started = true; connected = connectionIsLive(observation);
          if (connected) break;
        }
        await d.pause(250);
      }
      if (!started) {
        // Authentication/network can prevent ensureDevice and its reporter. Keep a verified installed binary.
        return { state: "upgraded", message: `Frely ${release.version} is installed. A service restart was requested, but its new runtime could not be verified. Run frely doctor -v.` };
      }
      return { state: "upgraded", message: `Frely ${release.version} is installed; the service is using the new version. ${connected ? "Relay connection verified." : "Relay connection is not yet verified. Run frely doctor."}` };
    }
    return { state: "upgraded", message: `Frely ${release.version} is installed. The background service remains ${service.installed ? "stopped" : "uninstalled"}.` };
  } catch (error) {
    let recovery = "";
    if (attempted && prepared) {
      try {
        await prepared.restore();
        if (await d.installedVersion(installation) !== VERSION) throw new Error("Old version not restored.");
        recovery = ` Restored Frely ${VERSION}.`;
      } catch { preserveRecovery = true; recovery = " Recovery failed; the backup (if any) was retained. Use the original installer to repair this installation."; }
    }
    if (stopped) {
      try { await d.startMcpService(); recovery += " Requested restart of the original service."; }
      catch { recovery += " The service could not restart. Run frely doctor -v."; }
    }
    throw new Error(`${error instanceof Error ? error.message : "Upgrade failed."}${recovery}`);
  } finally {
    releaseMaintenance?.();
    try { if (!preserveRecovery) await prepared?.cleanup(); } finally { await unlock(); }
  }
}
