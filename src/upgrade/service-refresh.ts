import { execFile as execFileCallback } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { VERSION } from "../version.js";
import { diagnostic, type DiagnosticLog } from "../runtime/diagnostics.js";
import { inspectInstallation, type Installation } from "./installation.js";
import type { MaintenanceGate } from "./maintenance.js";

const execFile = promisify(execFileCallback);
export interface InstalledCandidate { fingerprint: string; version: string }
export interface RefreshProbe {
  read(): Promise<InstalledCandidate>;
  verify(candidate: InstalledCandidate): Promise<boolean>;
}

/** Inspect only the installation this process already runs; never follow PATH or download code. */
export function installationProbe(installation: Installation): RefreshProbe {
  let standaloneCache: InstalledCandidate | undefined;
  const version = async () => {
    const standalone = installation.method === "standalone";
    const result = await execFile(standalone ? installation.entry : process.execPath,
      standalone ? ["--version"] : [installation.entry, "--version"],
      { cwd: homedir(), timeout: 10000, maxBuffer: 65536 });
    const value = result.stdout.trim();
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)) throw new Error("Invalid installed CLI version.");
    return value;
  };
  const fingerprint = async () => {
    const files = installation.method === "standalone" ? [installation.entry]
      : [installation.entry, join(dirname(dirname(installation.entry)), "package.json")];
    return (await Promise.all(files.map(async (path) => {
      const info = await stat(path, { bigint: true });
      if (!info.isFile()) throw new Error("Installed CLI file is unavailable.");
      return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
    }))).join("|");
  };
  return {
    async read() {
      const before = await fingerprint();
      let installed: string;
      if (installation.method === "standalone") {
        if (standaloneCache?.fingerprint === before) return standaloneCache;
        installed = await version();
      } else {
        const metadata = JSON.parse(await readFile(join(dirname(dirname(installation.entry)), "package.json"), "utf8")) as { name?: string; version?: string };
        if (metadata.name !== "frely-cli" || typeof metadata.version !== "string") throw new Error("Installed package is unavailable.");
        installed = metadata.version;
      }
      if (before !== await fingerprint()) throw new Error("Installation is changing.");
      const candidate = { fingerprint: before, version: installed };
      if (installation.method === "standalone") standaloneCache = candidate;
      return candidate;
    },
    async verify(candidate) {
      return await fingerprint() === candidate.fingerprint && await version() === candidate.version
        && await fingerprint() === candidate.fingerprint;
    },
  };
}

/** One tick at a time. Busy work keeps its connection and admission; only idle runtimes drain. */
export class ServiceRefresh {
  private candidate: InstalledCandidate | undefined;
  private checking = false;
  private restarting = false;
  private deferredFingerprint: string | undefined;

  constructor(private readonly options: {
    probe: RefreshProbe; gate: MaintenanceGate; signal: AbortSignal;
    restart: () => void; log?: DiagnosticLog; currentVersion?: string;
  }) {}

  async check(): Promise<void> {
    if (this.checking || this.restarting || this.options.signal.aborted) return;
    this.checking = true;
    let paused = false;
    const { probe, gate, signal, restart, log } = this.options;
    try {
      const candidate = await probe.read();
      if (candidate.version === (this.options.currentVersion ?? VERSION)) { this.candidate = undefined; return; }
      // Two observations, separated by the polling interval, avoid switching during package extraction.
      if (this.candidate?.fingerprint !== candidate.fingerprint || this.candidate.version !== candidate.version) {
        this.candidate = candidate;
        return;
      }
      if (signal.aborted) return;
      if (!gate.idle) {
        if (this.deferredFingerprint !== candidate.fingerprint) {
          diagnostic(log, "relay.upgrade_deferred");
          this.deferredFingerprint = candidate.fingerprint;
        }
        return;
      }
      // An explicit frely upgrade may already own maintenance. Never resume another owner's gate.
      try { gate.pause(); paused = true; } catch { return; }
      if (!await probe.verify(candidate) || signal.aborted || !gate.idle) return;
      diagnostic(log, "relay.upgrade_restart");
      restart();
      this.restarting = true;
      // Keep admission closed while the relay flushes and exits. Its existing supervisor restarts it.
    } catch {
      // Missing files and unsuccessful startup are expected during external installation.
      // Keep the loaded runtime alive and require two fresh observations before retrying.
      this.candidate = undefined;
    } finally {
      if (paused && !this.restarting) gate.resume();
      this.checking = false;
    }
  }
}

/** Only an already-running managed POSIX service watches its supported installation. */
export async function watchServiceInstallation(options: {
  gate: MaintenanceGate; signal: AbortSignal; restart: () => void; log?: DiagnosticLog; onEnabled?: () => void;
}): Promise<() => void> {
  if (options.signal.aborted || !["darwin", "linux"].includes(process.platform)) return () => {};
  const installation = await inspectInstallation();
  if (options.signal.aborted || !["standalone", "npm", "bun"].includes(installation.method)) return () => {};
  options.onEnabled?.();
  const refresh = new ServiceRefresh({ ...options, probe: installationProbe(installation) });
  const timer = setInterval(() => { void refresh.check(); }, 5000);
  timer.unref();
  const close = () => { clearInterval(timer); options.signal.removeEventListener("abort", close); };
  options.signal.addEventListener("abort", close, { once: true });
  void refresh.check();
  return close;
}
