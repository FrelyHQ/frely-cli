/**
 * Keeps the Frely App's headless Pi Node running (plan E3/E6). The CLI does not
 * know threads or tasks: it reads `app.json`, verifies the Runtime Capsule,
 * starts `pi-node headless` in its own process group, restarts it when it dies,
 * and hands its loopback MCP endpoint to the local MCP forwarder. A CLI restart
 * re-adopts the running node; an App upgrade or an invalid `app.json` stops it.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { diagnostic, type DiagnosticLog } from "../runtime/diagnostics.js";
import type { LocalMcpHttpEntry } from "../runtime/local-mcp.js";
import { readAppInstall, verifyCapsule, verifyCapsuleIntegrity, type AppInstall, type CapsuleFacts } from "./app-install.js";

export const PI_NODE_MCP_NAME = "frely-app";
export const PI_NODE_TICK_MS = 5_000;
const ENDPOINT_WAIT_MS = 20_000;
const MAX_BACKOFF_MS = 60_000;
const HEALTHY_AFTER_MS = 60_000;
const TERMINATE_GRACE_MS = 5_000;

export type PiNodeEndpoint = { url: string; token: string; pid: number };
type Running = { pid: number; key: string; startedAt: number; endpoint: PiNodeEndpoint | null; install: AppInstall };

export type PiNodeSupervisorDeps = {
  log?: DiagnosticLog | undefined;
  readInstall?: () => Promise<AppInstall>;
  verify?: (install: AppInstall) => Promise<CapsuleFacts>;
  verifyIntegrity?: (install: AppInstall) => Promise<void>;
  launch?: (facts: CapsuleFacts, install: AppInstall) => number;
  readEndpoint?: (install: AppInstall) => Promise<PiNodeEndpoint | null>;
  readState?: (install: AppInstall) => Promise<{ pid: number; key: string } | null>;
  writeState?: (install: AppInstall, state: { pid: number; key: string } | null) => Promise<void>;
  isAlive?: (pid: number) => boolean;
  terminate?: (pid: number) => Promise<void>;
  /** Called when the node's endpoint appears, changes or goes away. */
  onChange?: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export class PiNodeSupervisor {
  private running: Running | null = null;
  private failures = 0;
  private notBefore = 0;
  private integrityVerifiedFor: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private watching = false;
  private stopRequested = false;

  constructor(private readonly deps: PiNodeSupervisorDeps = {}) {}

  start(): void {
    if (this.watching) return;
    this.watching = true;
    this.stopRequested = false;
    const loop = () => {
      this.ticking = this.tick().finally(() => {
        this.ticking = null;
        if (!this.stopRequested) {
          this.timer = setTimeout(loop, PI_NODE_TICK_MS);
          this.timer.unref?.();
        }
      });
    };
    loop();
  }

  /** Stops watching. The node keeps running so a CLI restart or upgrade does not interrupt threads. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.watching = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.ticking?.catch(() => undefined);
  }

  endpoint(): PiNodeEndpoint | null {
    return this.running?.endpoint ?? null;
  }

  /** The node's MCP as a manual local MCP entry, or null while it is not up. */
  localMcpEntry(): LocalMcpHttpEntry | null {
    const endpoint = this.endpoint();
    if (!endpoint) return null;
    return { name: PI_NODE_MCP_NAME, source: "manual", transport: "http", url: endpoint.url, flavor: "streamable", headers: { Authorization: `Bearer ${endpoint.token}` } };
  }

  /** One reconcile step; exposed for tests. Never throws. */
  async tick(): Promise<void> {
    const before = this.endpointKey();
    try {
      await this.reconcile();
    } catch (error) {
      diagnostic(this.deps.log, "pi_node.supervisor.tick_failed", {}, error);
    }
    if (this.endpointKey() !== before) this.deps.onChange?.();
  }

  private endpointKey(): string | null {
    const endpoint = this.endpoint();
    return endpoint ? `${endpoint.pid}|${endpoint.url}|${endpoint.token}` : null;
  }

  private async reconcile(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const install = await (this.deps.readInstall ?? (() => readAppInstall()))().catch(() => null);
    let facts: CapsuleFacts | null = null;
    if (install) {
      try {
        facts = await (this.deps.verify ?? verifyCapsule)(install);
      } catch (error) {
        diagnostic(this.deps.log, "pi_node.supervisor.capsule_invalid", {}, error);
      }
    }
    if (!install || !facts) {
      // App uninstalled or app.json invalid: stop supervising and stop the node.
      await this.stopNode(install);
      return;
    }
    const key = installKey(install, facts);
    if (this.running && this.running.key !== key) await this.stopNode(install); // App upgraded or moved.

    if (this.running && !(this.deps.isAlive ?? processAlive)(this.running.pid)) {
      diagnostic(this.deps.log, "pi_node.supervisor.node_exited", {});
      if (now - this.running.startedAt < HEALTHY_AFTER_MS) this.failures += 1;
      else this.failures = 0;
      this.notBefore = now + backoff(this.failures);
      this.running = null;
      await this.deps.writeState?.(install, null);
    }
    if (this.running) {
      if (now - this.running.startedAt >= HEALTHY_AFTER_MS) this.failures = 0;
      return;
    }
    if (now < this.notBefore) return;

    if (await this.adopt(install, key, now)) return;
    await this.verifyIntegrityOnce(install, key);
    await this.startNode(install, facts, key, now);
  }

  private async adopt(install: AppInstall, key: string, now: number): Promise<boolean> {
    const state = await (this.deps.readState ?? readState)(install).catch(() => null);
    if (!state || state.key !== key || !(this.deps.isAlive ?? processAlive)(state.pid)) return false;
    const endpoint = await (this.deps.readEndpoint ?? readEndpoint)(install).catch(() => null);
    if (!endpoint || endpoint.pid !== state.pid) return false;
    this.running = { pid: state.pid, key, startedAt: now, endpoint, install };
    diagnostic(this.deps.log, "pi_node.supervisor.adopted", {});
    return true;
  }

  private async verifyIntegrityOnce(install: AppInstall, key: string): Promise<void> {
    if (this.integrityVerifiedFor === key) return;
    await (this.deps.verifyIntegrity ?? verifyCapsuleIntegrity)(install);
    this.integrityVerifiedFor = key;
  }

  private async startNode(install: AppInstall, facts: CapsuleFacts, key: string, now: number): Promise<void> {
    await rm(endpointPath(install), { force: true }).catch(() => undefined); // never trust a stale endpoint
    const pid = (this.deps.launch ?? launchNode)(facts, install);
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const readEndpointFile = this.deps.readEndpoint ?? readEndpoint;
    let endpoint: PiNodeEndpoint | null = null;
    for (let waited = 0; waited < ENDPOINT_WAIT_MS && !this.stopRequested; waited += 100) {
      endpoint = await readEndpointFile(install).catch(() => null);
      if (endpoint && endpoint.pid === pid) break;
      endpoint = null;
      if (!(this.deps.isAlive ?? processAlive)(pid)) break;
      await sleep(100);
    }
    if (!endpoint) {
      this.failures += 1;
      this.notBefore = now + backoff(this.failures);
      await this.terminateQuietly(pid);
      diagnostic(this.deps.log, "pi_node.supervisor.start_failed", {});
      return;
    }
    this.running = { pid, key, startedAt: now, endpoint, install };
    await (this.deps.writeState ?? writeState)(install, { pid, key });
    diagnostic(this.deps.log, "pi_node.supervisor.started", {});
  }

  private async stopNode(install: AppInstall | null): Promise<void> {
    const running = this.running;
    this.running = null;
    if (!running) return;
    await this.terminateQuietly(running.pid);
    await (this.deps.writeState ?? writeState)(install ?? running.install, null).catch(() => undefined);
  }

  private terminateQuietly(pid: number): Promise<void> {
    return (this.deps.terminate ?? terminateProcess)(pid).catch(() => undefined);
  }
}

function backoff(failures: number): number {
  return failures <= 0 ? 0 : Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (failures - 1));
}

function installKey(install: AppInstall, facts: CapsuleFacts): string {
  return JSON.stringify([install.capsulePath, install.appVersion, facts.manifest.sourceCommit, install.agentDir, install.projectsFile]);
}

function dataDirectory(install: AppInstall): string {
  return join(install.agentDir, "frely");
}

function endpointPath(install: AppInstall): string {
  return join(dataDirectory(install), "headless.json");
}

function statePath(install: AppInstall): string {
  return join(dataDirectory(install), "headless-supervisor.json");
}

async function readEndpoint(install: AppInstall): Promise<PiNodeEndpoint | null> {
  const value = JSON.parse(await readFile(endpointPath(install), "utf8")) as Record<string, unknown>;
  if (value.schemaVersion !== 1 || typeof value.url !== "string" || typeof value.token !== "string" || !Number.isSafeInteger(value.pid)) return null;
  return { url: value.url, token: value.token, pid: value.pid as number };
}

async function readState(install: AppInstall): Promise<{ pid: number; key: string } | null> {
  const value = JSON.parse(await readFile(statePath(install), "utf8")) as Record<string, unknown>;
  return Number.isSafeInteger(value.pid) && typeof value.key === "string" ? { pid: value.pid as number, key: value.key } : null;
}

async function writeState(install: AppInstall, state: { pid: number; key: string } | null): Promise<void> {
  const path = statePath(install);
  if (!state) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, path);
}

function launchNode(facts: CapsuleFacts, install: AppInstall): number {
  const child = spawn(
    facts.executable,
    [...facts.headlessArguments, "--cwd", homedir(), "--agent-dir", install.agentDir, "--projects-file", install.projectsFile],
    {
      detached: true, // its own process group: a CLI restart must not take the node down
      stdio: "ignore",
      env: { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
      windowsHide: true,
    },
  );
  child.unref();
  if (child.pid === undefined) throw new Error("Pi Node did not start.");
  return child.pid;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function terminateProcess(pid: number): Promise<void> {
  if (!processAlive(pid)) return;
  process.kill(pid, "SIGTERM");
  for (let waited = 0; waited < TERMINATE_GRACE_MS; waited += 100) {
    if (!processAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (processAlive(pid)) process.kill(pid, "SIGKILL");
}
