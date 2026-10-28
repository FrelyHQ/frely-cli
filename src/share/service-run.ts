import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceFrpcConfigToml, SERVICE_SHARE_ID, type ServiceGrant, type ServiceType } from "./service-config.js";
import { accountServiceControl, type ServiceControl } from "./service-control.js";
import { listLocalServices, removeLocalService, saveLocalService, type LocalService } from "./service-state.js";
import { ensureFrpc } from "./frpc.js";
import { probeLoopback, spawnFrpcProcess, type FrpcProcess } from "./run.js";

const HEARTBEAT_MS = 30_000;
const HEARTBEAT_FAILURES = 3;
const MIB = 1024 * 1024;
const POLL_MS = 10_000;
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

export const ALLOWANCE_NOTE = "Relayed traffic counts against your weekly relay allowance.";

export interface ServiceShareOptions { readonly type: ServiceType; readonly port: number; readonly label: string; readonly background: boolean; readonly json: boolean }

export function serviceUsage(): string {
  return [
    "frely service share --type mcp|a2a --port <n> [--label <text>] [--background] [--json]",
    "frely service list [--json]",
    "frely service stop <id|label>",
    "frely service remove <id|label>",
  ].join("\n");
}

export function parseServiceShareArguments(args: readonly string[]): ServiceShareOptions {
  let type: string | undefined, port: number | undefined, label: string | undefined;
  let background = false, json = false;
  const value = (i: number, arg: string, name: string): string => {
    const inline = arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : args[i + 1];
    if (inline === undefined || inline === "" || (!arg.includes("=") && inline.startsWith("-"))) throw new Error(`${name} needs a value.\n${serviceUsage()}`);
    return inline;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const name = arg.split("=")[0]!;
    if (name === "--type") { type = value(i, arg, name); if (!arg.includes("=")) i++; }
    else if (name === "--port") {
      const text = value(i, arg, name); if (!arg.includes("=")) i++;
      port = Number(text);
      if (!/^\d+$/u.test(text) || port < 1 || port > 65535) throw new Error("--port must be a port number from 1 to 65535 on this computer (127.0.0.1).");
    } else if (name === "--label") { label = value(i, arg, name); if (!arg.includes("=")) i++; }
    else if (arg === "--background") background = true;
    else if (arg === "--json") json = true;
    else throw new Error(`${arg.startsWith("-") ? "Unknown option" : "Unexpected argument"} ${arg}. A service is a port on this computer; no address is accepted.\n${serviceUsage()}`);
  }
  if (type !== "mcp" && type !== "a2a") throw new Error(`--type must be mcp or a2a.\n${serviceUsage()}`);
  if (port === undefined) throw new Error(`--port is required.\n${serviceUsage()}`);
  const text = (label ?? `local-${type}`).trim();
  if (text.length < 1 || text.length > 60 || /[\u0000-\u001f\u007f]/u.test(text)) throw new Error("--label must be 1 to 60 characters.");
  return { type, port, label: text, background, json };
}

export interface ServiceSessionDeps {
  readonly control: ServiceControl;
  readonly ensureFrpc: () => Promise<string>;
  readonly spawnFrpc: (binary: string, configPath: string) => FrpcProcess;
  readonly write: (text: string) => void;
  readonly signal: AbortSignal;
  readonly heartbeatMs?: number;
  readonly configLifetimeMs?: number;
  /** Called once the session is up, with the grant (for the allowance line). */
  readonly onGrant?: (grant: ServiceGrant) => void;
}

/** One session of one service: ask Frely for it, run frpc on it, heartbeat, and revoke when it ends. Returns why it ended. */
export async function runServiceSession(service: Pick<LocalService, "serviceShareId" | "port">, deps: ServiceSessionDeps): Promise<{ reason: string; stopped: boolean }> {
  const binary = await deps.ensureFrpc();
  const grant = await deps.control.session(service.serviceShareId);
  let directory: string | undefined, frpc: FrpcProcess | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined, expiry: ReturnType<typeof setTimeout> | undefined, configTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "frely-service-"));
    await chmod(directory, 0o700).catch(() => undefined);
    const configPath = join(directory, "frpc.toml");
    await writeFile(configPath, serviceFrpcConfigToml(grant, service.port), { mode: 0o600 });
    frpc = deps.spawnFrpc(binary, configPath);
    configTimer = setTimeout(() => { void rm(configPath, { force: true }).catch(() => undefined); }, deps.configLifetimeMs ?? 3000);
    deps.onGrant?.(grant);
    let stoppedByUser = false;
    const reason = await new Promise<string>((resolve) => {
      let failures = 0;
      const stop = (text: string) => resolve(text);
      if (deps.signal.aborted) stop("Stopped.");
      deps.signal.addEventListener("abort", () => { stoppedByUser = true; stop("Stopped."); }, { once: true });
      void frpc!.done.then(({ code, stderr }) => stop(`frpc exited${code === null ? "" : ` with code ${code}`}${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" | ")}` : "."}`));
      expiry = setTimeout(() => stop("The session expired."), Math.max(0, Date.parse(grant.expiresAt) - Date.now()));
      heartbeat = setInterval(() => {
        void deps.control.heartbeat(grant.id).then((status) => {
          failures = 0;
          if (!status.active) stop(describeEnd(status.reason));
        }, () => { failures += 1; if (failures >= HEARTBEAT_FAILURES) stop("Frely could not be reached."); });
      }, deps.heartbeatMs ?? HEARTBEAT_MS);
    });
    return { reason, stopped: stoppedByUser };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (expiry) clearTimeout(expiry);
    if (configTimer) clearTimeout(configTimer);
    frpc?.kill();
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    await deps.control.revoke(grant.id).catch(() => undefined);
  }
}

function describeEnd(reason: string | undefined): string {
  if (reason === "quota_exhausted") return "This week's relay allowance is used up; it renews on Monday (UTC).";
  if (reason === "expired") return "The session expired.";
  if (reason === "service_removed") return "The service was removed.";
  return `Frely ended this session (${reason ?? "revoked"}).`;
}

export function allowanceLines(grant: ServiceGrant): string[] {
  return [`${Math.floor(grant.remainingBytes / MIB)} MiB of relay allowance left this week (UTC).`, ALLOWANCE_NOTE];
}

/** Keeps one service connected until aborted: when a session ends for any reason but a stop, ask for a new one after a growing pause. */
export async function keepServiceConnected(service: Pick<LocalService, "serviceShareId" | "port" | "label">, deps: ServiceSessionDeps, sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep): Promise<void> {
  let pause = RETRY_MIN_MS;
  while (!deps.signal.aborted) {
    const started = Date.now();
    try {
      const { reason } = await runServiceSession(service, deps);
      if (deps.signal.aborted) return;
      deps.write(`Service ${service.label}: ${reason}\n`);
    } catch (error) {
      if (deps.signal.aborted) return;
      deps.write(`Service ${service.label}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    pause = Date.now() - started > 60_000 ? RETRY_MIN_MS : Math.min(pause * 2, RETRY_MAX_MS);
    await sleep(pause, deps.signal);
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Runs inside the device daemon: every service saved with `background` stays connected; a stop or removal in the state file ends it within seconds. */
export async function superviseServices(options: { signal: AbortSignal; log: (text: string) => void; pollMs?: number; control?: () => Promise<ServiceControl>; session?: Partial<ServiceSessionDeps> }): Promise<void> {
  const running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  let control: ServiceControl | undefined;
  const reconcile = async () => {
    const wanted = (await listLocalServices().catch(() => [])).filter((service) => service.background);
    for (const [id, entry] of running) {
      const current = wanted.find((service) => service.serviceShareId === id);
      if (!current || (current.port !== (entry as { port?: number }).port)) { entry.abort.abort(); await entry.done; running.delete(id); }
    }
    for (const service of wanted) {
      if (running.has(service.serviceShareId)) continue;
      try { control ??= await (options.control ?? accountServiceControl)(); } catch (error) { options.log(`Services: ${error instanceof Error ? error.message : String(error)}`); return; }
      const abort = new AbortController();
      const onParent = () => abort.abort();
      options.signal.addEventListener("abort", onParent, { once: true });
      const done = keepServiceConnected(service, {
        control, ensureFrpc: () => ensureFrpc({ log: () => undefined }), spawnFrpc: spawnFrpcProcess, write: (text) => options.log(text.trimEnd()), signal: abort.signal,
        onGrant: (grant) => options.log(`Service ${service.label} connected. ${allowanceLines(grant).join(" ")}`), ...options.session,
      }).finally(() => options.signal.removeEventListener("abort", onParent));
      running.set(service.serviceShareId, Object.assign({ abort, done }, { port: service.port }));
    }
  };
  while (!options.signal.aborted) {
    await reconcile();
    await abortableSleep(options.pollMs ?? POLL_MS, options.signal);
  }
  for (const entry of running.values()) entry.abort.abort();
  await Promise.all([...running.values()].map((entry) => entry.done));
}

export interface ServiceCommandIo { readonly write: (text: string) => void }
export interface ServiceCommandDeps {
  readonly control: () => Promise<ServiceControl>;
  readonly probe: (port: number) => Promise<boolean>;
  readonly ensureFrpc: () => Promise<string>;
  readonly spawnFrpc: (binary: string, configPath: string) => FrpcProcess;
  readonly signal: AbortSignal;
  /** Installs / restarts the background service so it picks the service up. */
  readonly installDaemon: () => Promise<void>;
}

export async function runServiceCommand(args: readonly string[], io: ServiceCommandIo, deps: ServiceCommandDeps): Promise<number> {
  const [action, ...rest] = args;
  if (action === undefined || action === "help" || action === "--help") { io.write(`Usage:\n${serviceUsage().split("\n").map((line) => `  ${line}`).join("\n")}\n`); return 0; }
  if (action === "share") return shareService(parseServiceShareArguments(rest), io, deps);
  if (action === "list") {
    if (rest.some((arg) => arg !== "--json")) throw new Error(`Usage: frely service list [--json]`);
    const control = await deps.control();
    const [remote, local] = await Promise.all([control.list(), listLocalServices()]);
    const rows = remote.map((item) => {
      const mine = local.find((service) => service.serviceShareId === item.id);
      return { id: item.id, type: item.type, label: item.label, onThisComputer: Boolean(mine), background: mine?.background ?? false };
    });
    if (rest.includes("--json")) io.write(`${JSON.stringify({ services: rows }, null, 2)}\n`);
    else if (rows.length === 0) io.write("No services are registered.\n");
    else for (const row of rows) io.write(`${row.id}  ${row.type}  ${row.label}  ${row.onThisComputer ? (row.background ? "background" : "this computer") : "other device"}\n`);
    return 0;
  }
  if (action === "stop" || action === "remove") {
    if (rest.length !== 1 || rest[0]!.startsWith("-")) throw new Error(`Usage: frely service ${action} <id|label>`);
    const service = await findLocal(rest[0]!);
    if (action === "stop") {
      await saveLocalService({ ...service, background: false });
      io.write(`Stopped ${service.label}. The background service disconnects it within seconds; a foreground \`frely service share\` stops with Ctrl+C. The service stays registered.\n`);
      return 0;
    }
    await (await deps.control()).remove(service.serviceShareId);
    await removeLocalService(service.serviceShareId);
    io.write(`Removed ${service.label}. Products that pointed at it answer as unreachable.\n`);
    return 0;
  }
  throw new Error(`Unknown service command ${action}.\n${serviceUsage()}`);
}

async function findLocal(selector: string): Promise<LocalService> {
  const services = await listLocalServices();
  const matches = services.filter((service) => SERVICE_SHARE_ID.test(selector) ? service.serviceShareId === selector : service.label === selector);
  if (matches.length !== 1) throw new Error(matches.length === 0 ? `No service "${selector}" on this computer. Run frely service list.` : `More than one service is called "${selector}"; use its id.`);
  return matches[0]!;
}

async function shareService(options: ServiceShareOptions, io: ServiceCommandIo, deps: ServiceCommandDeps): Promise<number> {
  const say = (text: string) => { if (!options.json) io.write(text); };
  if (!(await deps.probe(options.port))) throw new Error(`Nothing is listening on 127.0.0.1:${options.port}. Start your ${options.type.toUpperCase()} service first.`);
  const control = await deps.control();
  const record = await control.register({ type: options.type, label: options.label });
  const existing = (await listLocalServices()).find((service) => service.serviceShareId === record.id);
  if (existing?.background && !options.background) throw new Error(`${record.label} is already kept connected by the background service. Run \`frely service stop ${record.id}\` first, or share it again with --background.`);
  const service: LocalService = { serviceShareId: record.id, type: record.type, label: record.label, port: options.port, createdAt: existing?.createdAt || record.createdAt || new Date().toISOString(), background: options.background };
  await saveLocalService(service);
  if (options.background) {
    await deps.installDaemon();
    if (options.json) io.write(`${JSON.stringify({ serviceShareId: record.id, type: record.type, label: record.label, background: true })}\n`);
    else io.write(`Service ${record.id} (${record.type}, ${record.label}) is kept connected by the background service. It is not a public link: only Frely can reach it. ${ALLOWANCE_NOTE}\n`);
    return 0;
  }
  const outcome = await runServiceSession(service, {
    control, ensureFrpc: deps.ensureFrpc, spawnFrpc: deps.spawnFrpc, write: io.write, signal: deps.signal,
    onGrant: (grant) => {
      if (options.json) { io.write(`${JSON.stringify({ serviceShareId: record.id, type: record.type, label: record.label, sessionId: grant.id, expiresAt: grant.expiresAt, remainingBytes: grant.remainingBytes })}\n`); return; }
      say(`Sharing ${record.type.toUpperCase()} service ${record.id} (${record.label}) from 127.0.0.1:${options.port}. There is no public link; only Frely can reach it.\n`);
      for (const line of allowanceLines(grant)) say(`${line}\n`);
      say(`Expires ${grant.expiresAt}; run again to renew, or use --background to keep it connected. Press Ctrl+C to stop.\n`);
    },
  });
  say(`\n${outcome.reason}\n`);
  return outcome.stopped ? 0 : 1;
}
