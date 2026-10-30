import { spawn } from "node:child_process";
import { connect } from "node:net";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frpcConfigToml, type ShareGrant } from "./frpc-config.js";
import { ensureFrpc } from "./frpc.js";
import { startGateway } from "./gateway.js";
import { accountShareControl, type ShareControl } from "./control.js";

export interface ShareOptions {
  readonly port: number;
  /** Lifetime of the link in hours; the relay caps it at 24. */
  readonly ttlHours?: number;
  readonly rewriteHost?: boolean;
  readonly json?: boolean;
}

export interface FrpcProcess { readonly done: Promise<{ code: number | null; stderr: string }>; kill(): void }

export interface ShareDeps {
  readonly control: () => Promise<ShareControl>;
  readonly ensureFrpc: () => Promise<string>;
  readonly startGateway: typeof startGateway;
  readonly spawnFrpc: (binary: string, configPath: string) => FrpcProcess;
  readonly probe: (port: number) => Promise<boolean>;
  readonly write: (text: string) => void;
  readonly signal: AbortSignal;
  readonly heartbeatMs?: number;
  /** How long the config file (it holds the session token) stays on disk after frpc started. */
  readonly configLifetimeMs?: number;
}

const HEARTBEAT_MS = 30_000;
const HEARTBEAT_FAILURES = 3;
const MIB = 1024 * 1024;

export function parseShareArguments(args: readonly string[]): ShareOptions {
  let port: number | undefined, ttlHours: number | undefined;
  let rewriteHost = false, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--ttl" || arg.startsWith("--ttl=")) {
      const value = arg === "--ttl" ? args[++i] : arg.slice("--ttl=".length);
      ttlHours = Number(value);
      if (!value || !Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 24) throw new Error("--ttl must be a number of hours from 0.02 to 24.");
    } else if (arg === "--rewrite-host") rewriteHost = true;
    else if (arg === "--json") json = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}.\n${shareUsage()}`);
    else if (port === undefined) {
      port = Number(arg);
      if (!/^\d+$/u.test(arg) || port < 1 || port > 65535) throw new Error(`Usage: ${shareUsage()}`);
    } else throw new Error(`Usage: ${shareUsage()}`);
  }
  if (port === undefined) throw new Error(`Usage: ${shareUsage()}`);
  return { port, ...(ttlHours !== undefined ? { ttlHours } : {}), rewriteHost, json };
}

export function shareUsage(): string {
  return "frely share <port> [--ttl <hours>] [--rewrite-host] [--json]";
}

/** Shares http://127.0.0.1:<port> through Frely's relay until Ctrl+C, the link expires, the allowance is used up or Frely revokes it. Returns the exit code. */
export async function runShare(options: ShareOptions, deps: ShareDeps): Promise<number> {
  const say = (text: string) => { if (!options.json) deps.write(text); };
  if (!(await deps.probe(options.port))) throw new Error(`Nothing is listening on 127.0.0.1:${options.port}. Start your service first.`);
  const binary = await deps.ensureFrpc();
  const control = await deps.control();
  const grant = await control.create({ ...(options.ttlHours !== undefined ? { ttlSeconds: Math.round(options.ttlHours * 3600) } : {}) });
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined, frpc: FrpcProcess | undefined, directory: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined, expiry: ReturnType<typeof setTimeout> | undefined, configTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    gateway = await deps.startGateway({ host: new URL(grant.url).hostname, targetPort: options.port, ...(options.rewriteHost ? { rewriteHost: true } : {}) });
    directory = await mkdtemp(join(tmpdir(), "frely-share-"));
    await chmod(directory, 0o700).catch(() => undefined);
    const configPath = join(directory, "frpc.toml");
    await writeFile(configPath, frpcConfigToml(grant, gateway.port), { mode: 0o600 });
    frpc = deps.spawnFrpc(binary, configPath);
    configTimer = setTimeout(() => { void rm(configPath, { force: true }).catch(() => undefined); }, deps.configLifetimeMs ?? 3000);
    announce(grant, options, deps.write);

    const stopped = new Promise<string>((resolve) => {
      let failures = 0;
      const stop = (reason: string) => resolve(reason);
      deps.signal.addEventListener("abort", () => stop("Stopped."), { once: true });
      void frpc!.done.then(({ code, stderr }) => stop(`frpc exited${code === null ? "" : ` with code ${code}`}${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" | ")}` : "."}`));
      expiry = setTimeout(() => stop("The link expired."), Math.max(0, Date.parse(grant.expiresAt) - Date.now()));
      heartbeat = setInterval(() => {
        void control.heartbeat(grant.id).then((status) => {
          failures = 0;
          if (!status.active) stop(describe(status.reason));
        }, () => { failures += 1; if (failures >= HEARTBEAT_FAILURES) stop("Frely could not be reached."); });
      }, deps.heartbeatMs ?? HEARTBEAT_MS);
    });
    const reason = await stopped;
    say(`\n${reason}\n`);
    return reason === "Stopped." ? 0 : 1;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (expiry) clearTimeout(expiry);
    if (configTimer) clearTimeout(configTimer);
    frpc?.kill();
    await gateway?.close().catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    await control.revoke(grant.id).catch(() => undefined);
  }
}

function describe(reason: string | undefined): string {
  if (reason === "quota_exhausted") return "This week's relay allowance is used up; it renews on Monday (UTC).";
  if (reason === "expired") return "The link expired.";
  return `Frely ended this share (${reason ?? "revoked"}).`;
}

function announce(grant: ShareGrant, options: ShareOptions, write: (text: string) => void): void {
  if (options.json) { write(`${JSON.stringify({ id: grant.id, url: grant.url, expiresAt: grant.expiresAt, bandwidthBytesPerSecond: grant.bandwidthBytesPerSecond, remainingBytes: grant.remainingBytes })}\n`); return; }
  write(`Sharing http://127.0.0.1:${options.port}\n  ${grant.url}\n`);
  write(`Up to ${(grant.bandwidthBytesPerSecond / MIB).toFixed(1)} MiB/s; ${Math.floor(grant.remainingBytes / MIB)} MiB of relay left this week (UTC). Expires ${grant.expiresAt}.\n`);
  write("Anyone with the link can open it. Press Ctrl+C to stop.\n");
}

export function probeLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export function spawnFrpcProcess(binary: string, configPath: string): FrpcProcess {
  const child = spawn(binary, ["-c", configPath], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
  const done = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, stderr: error.message }));
    child.once("exit", (code) => resolve({ code, stderr }));
  });
  return { done, kill: () => { child.kill(); } };
}

export async function runShareCommand(args: readonly string[], io: { write: (text: string) => void; interactive: boolean }): Promise<number> {
  const options = parseShareArguments(args);
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    return await runShare(options, {
      control: accountShareControl,
      ensureFrpc: () => ensureFrpc({ log: io.write }),
      startGateway, spawnFrpc: spawnFrpcProcess, probe: probeLoopback,
      write: io.write, signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
