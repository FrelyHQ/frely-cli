import { watchAgentLinks } from "../skill/link-sync.js";
import { remoteLocked } from "../remote-lock.js";
import { watchServiceInstallation } from "../update/service-refresh.js";
import { readEffectiveAutoUpdate, watchAutoUpdate } from "../update/auto-update.js";
import { MaintenanceGate, serveMaintenance } from "../update/maintenance.js";
import { isDefinitiveAuthorizationFailure, requireLocalMcpAuthorization, requireMcpAuthorization } from "../mcp-authorization.js";
import { McpLease } from "../runtime/mcp-lease.js";
import WebSocket, { type RawData } from "ws";
import { observeApprovals, setObserveIdentity } from "../trust/observe.js";
import { connectionGrant, directConnectionGrant, ensureDevice, storedDevice, type ConnectionGrant } from "./control.js";
import { nextDeviceTransportKind, selectDeviceTransport, type DeviceTransportGrant, type DeviceTransportKind } from "./transport.js";
import { connectionReporter, type ConnectionEvent } from "./connection-status.js";
import { randomBytes } from "node:crypto";
import {
  DEVICE_RELAY_DEFAULT_MAX_INFLIGHT,
  DEVICE_RELAY_MAX_FRAME_BYTES,
  DEVICE_RELAY_PROTOCOL,
  decodeDeviceRelayEnvelope,
  encodeDeviceRelayEnvelope,
  type DeviceRelayEnvelope,
  type DeviceRelayRequest,
  type DeviceRelayResponse,
} from "./protocol.js";
import { diagnostic, mcpDiagnosticContext, type DiagnosticLog } from "../runtime/diagnostics.js";
import { RelayMcpSession } from "../runtime/relay-mcp.js";
import type { LocalMcpHub } from "../runtime/local-mcp.js";
import type { LocalModelsHub } from "../provider/local-models.js";
import type { RelaySession } from "../runtime/relay-session.js";
import { openLocalProviderRequest, readLocalProviderBody } from "../provider/local.js";
import { forwardCoalesced } from "./stream-coalesce.js";

export interface RelayServeOptions {
  workspace?: string;
  managedService?: boolean;
  restartForUpdate?: () => void;
  signal: AbortSignal;
  log?: (message: string) => void;
  /**
   * Injected [RelaySession] factory for non-MCP transports (e.g. Pi Node).
   *
   * When provided the relay skips MCP authorization and bridges frames to the
   * injected session; pairing/access control is enforced by the owning runtime.
   * When omitted the relay falls back to the existing MCP path.
   */
  session?: () => Promise<RelaySession>;
  /** Device capability report sent once per connection for the web console (plan §6.4). */
  capabilities?: () => Record<string, unknown> | Promise<Record<string, unknown>> | undefined;
  /** Device-local MCP servers; enabled names arrive on each mcp request (plan mcp/本机MCP转发-方案.md). */
  localMcp?: LocalMcpHub;
  /** Lets device MCP probe and share loopback model servers (the local_models tool). */
  localModels?: LocalModelsHub;
}

interface InflightRequest {
  request: DeviceRelayRequest;
  controller: AbortController;
}

/** A response is kept for the next connection this long; the relay holds its caller for 60 s, so later is useless. */
export const RELAY_OUTBOX_TTL_MS = 130_000;

/**
 * State that survives a dropped connection: MCP commands keep running and report on the next one.
 * `socket` is the current connection (looked up when a response is sent, never captured by a request).
 */
export interface RelayCarry {
  readonly inflight: Map<string, InflightRequest>;
  readonly cancelled: Set<string>;
  readonly outbox: Map<string, { envelope: DeviceRelayResponse; at: number }>;
  /** Responses already written to a socket whose delivery no pong has proven yet; sent again on the next connection. */
  readonly unacked: Map<string, { envelope: DeviceRelayResponse; at: number }>;
  /** Ids written since the last ping; the next ping takes them. */
  readonly unpinged: Set<string>;
  socket?: WebSocket | undefined;
}

export function createRelayCarry(): RelayCarry {
  return { inflight: new Map(), cancelled: new Set(), outbox: new Map(), unacked: new Map(), unpinged: new Set() };
}

function hasCarriedMcp(carry: RelayCarry): boolean {
  for (const item of carry.inflight.values()) if (item.request.method === "mcp" && !item.controller.signal.aborted) return true;
  return false;
}

/** Aborts carried commands and forgets their results; nothing is re-executed. */
function abortCarried(carry: RelayCarry, session: RelaySession | null, log: DiagnosticLog, reason: string): void {
  if (carry.inflight.size > 0 || carry.outbox.size > 0 || carry.unacked.size > 0) diagnostic(log, `relay.carried_aborted.${reason}`, { inflight: carry.inflight.size });
  for (const [id, item] of carry.inflight) {
    carry.cancelled.add(id);
    item.controller.abort();
    if (item.request.method === "mcp") session?.cancel(id);
  }
  carry.outbox.clear();
  carry.unacked.clear();
  carry.unpinged.clear();
}

export interface HeldMcp { session: RelaySession; lease: McpLease }

/**
 * Commands that outlived a connection keep their session only for the same MCP authorization (and a live lease).
 * Anything else aborts them, drops their results and closes the session.
 */
export async function resumeOrRelease(carry: RelayCarry, held: HeldMcp | undefined, authorizationId: string | undefined, log: DiagnosticLog, reason: string): Promise<HeldMcp | undefined> {
  if (!held) return undefined;
  if (authorizationId !== undefined && held.lease.authorizationId === authorizationId && !held.lease.controller.signal.aborted && hasCarriedMcp(carry)) return held;
  abortCarried(carry, held.session, log, reason);
  held.lease.close();
  await held.session.close();
  return undefined;
}

type Parked = Map<string, { envelope: DeviceRelayResponse; at: number }>;

function prune(entries: Parked, log: DiagnosticLog): void {
  const now = Date.now();
  for (const [id, entry] of entries) {
    if (now - entry.at <= RELAY_OUTBOX_TTL_MS) continue;
    entries.delete(id);
    diagnostic(log, "relay.outbox_dropped.expired", { requestId: id });
  }
}

function bound(entries: Parked, log: DiagnosticLog): void {
  while (entries.size > DEVICE_RELAY_DEFAULT_MAX_INFLIGHT) {
    const oldest = entries.keys().next().value as string;
    entries.delete(oldest);
    diagnostic(log, "relay.outbox_dropped.limit", { requestId: oldest });
  }
}

/** Writes a response and remembers it until a pong proves the relay got it (a dead socket can swallow the write). */
function writeTracked(carry: RelayCarry, socket: WebSocket, entry: { envelope: DeviceRelayResponse; at: number }, log: DiagnosticLog): void {
  if (!send(socket, entry.envelope, log)) return; // too large: the small error that replaced it is not worth repeating
  prune(carry.unacked, log);
  carry.unacked.delete(entry.envelope.id);
  carry.unacked.set(entry.envelope.id, entry);
  carry.unpinged.add(entry.envelope.id);
  bound(carry.unacked, log);
}

/** Sends on the current connection, or keeps the response (bounded) for the next one. */
export function deliverResponse(carry: RelayCarry, envelope: DeviceRelayResponse, log: DiagnosticLog): void {
  const socket = carry.socket;
  if (socket && socket.readyState === WebSocket.OPEN) { writeTracked(carry, socket, { envelope, at: Date.now() }, log); return; }
  let kept = envelope;
  try { encodeDeviceRelayEnvelope(envelope); }
  catch (error) {
    diagnostic(log, "relay.response_failed", { requestId: envelope.id }, error);
    kept = errorResponse(envelope.id, "response_too_large", "Device Relay response exceeds the frame limit.");
  }
  prune(carry.outbox, log);
  carry.outbox.delete(kept.id);
  carry.outbox.set(kept.id, { envelope: kept, at: Date.now() });
  bound(carry.outbox, log);
}

/** Parked responses first, then those the previous connection never proved delivered. The relay ignores ids it no longer waits for. */
function flushOutbox(carry: RelayCarry, socket: WebSocket, log: DiagnosticLog): void {
  prune(carry.outbox, log);
  prune(carry.unacked, log);
  const again = [...carry.unacked.values()];
  carry.unpinged.clear();
  for (const [id, entry] of carry.outbox) {
    carry.outbox.delete(id);
    writeTracked(carry, socket, entry, log);
  }
  for (const entry of again) if (carry.unacked.get(entry.envelope.id) === entry && !carry.unpinged.has(entry.envelope.id)) writeTracked(carry, socket, entry, log);
}

export async function serveDeviceRelay(options: RelayServeOptions): Promise<void> {
  const log = options.log ?? (() => undefined);
  diagnostic(log, "relay.started");
  // A machine that is already enrolled starts without the web app; the checks run in the background.
  const device = await storedDevice() ?? await ensureDevice();
  setObserveIdentity({ device: device.deviceId, deviceKey: device.keyThumbprint });
  const reporter = connectionReporter(device, options.workspace);
  const maintenance = options.managedService && process.platform !== "win32" ? new MaintenanceGate() : undefined;
  const closeMaintenance = maintenance ? await serveMaintenance(maintenance) : undefined;
  // Watch the current installation from the existing runtime, without an updater daemon.
  const closeRefresh = maintenance && options.restartForUpdate
    ? watchServiceInstallation({ gate: maintenance, signal: options.signal, restart: options.restartForUpdate, log, onEnabled: () => reporter.report({ type: "upgrade_watch", enabled: true }) })
      .catch((error) => { diagnostic(log, "relay.upgrade_watch_unavailable", {}, error); return () => {}; })
    : Promise.resolve(() => {});
  // Off unless the owner switched it on; the swap happens while idle and the watcher above restarts the service.
  const closeAutoUpdate = maintenance && options.restartForUpdate ? watchAutoUpdate({ gate: maintenance, signal: options.signal, enabled: () => readEffectiveAutoUpdate(), log }) : () => {};
  // Agents installed after a Skill get its link without another frely command (see skill/link-sync.ts).
  const closeLinkSync = options.managedService ? watchAgentLinks({ log }) : () => {};
  let delayMs = 1000;
  let restartSince: number | undefined;
  let preferredTransport: DeviceTransportKind | undefined;
  // MCP commands that outlive a connection keep their session and lease here until they finish.
  const carry = createRelayCarry();
  let held: HeldMcp | undefined;
  let carryAuthorization: string | undefined;
  const releaseHeld = async (reason: string) => { const previous = held; held = undefined; await resumeOrRelease(carry, previous, undefined, log, reason); };
  const retryNow = createRetryNow(options.signal);
  try {
    while (!options.signal.aborted) {
      let session: RelaySession | null = null;
      let lease: McpLease | null = null;
      let selectedTransport: DeviceTransportGrant | undefined;
      let transports: readonly DeviceTransportGrant[] = [];
      let retryWithoutDelay = false;
      try {
        let authorization = null;
        if (options.session) {
          // Injected session (e.g. Pi Node). No MCP authorization is required;
          // the relay bridges frames to this session and the owning runtime
          // enforces pairing/access control.
          await releaseHeld("session_replaced");
          try {
            session = await options.session();
          } catch (error) {
            diagnostic(log, "relay.session_unavailable", {}, error);
            reporter.report({ type: "authorization_unavailable", error: (error as Error)?.message ?? String(error) });
            session = null;
          }
        } else if (options.workspace) {
          try {
            authorization = await requireLocalMcpAuthorization(options.workspace);
            if (authorization.grant.deviceId !== device.deviceId) throw new Error("MCP device differs from the connected device.");
            const previous = held;
            held = undefined;
            const resumed = await resumeOrRelease(carry, previous, authorization.grant.id, log, "authorization_changed");
            if (resumed) {
              // Same authorization: the commands still running keep their session.
              ({ session, lease } = resumed);
            } else {
              lease = new McpLease(authorization.grant.id, Date.parse(authorization.grant.expiresAt!));
              const guard = lease;
              session = await RelayMcpSession.create(options.workspace, {
                assertAuthorized: () => guard.assert(), signal: guard.controller.signal, log, ...(maintenance ? { maintenance } : {}),
                ...(options.localMcp ? { localMcp: options.localMcp } : {}),
                ...(options.localModels ? { localModels: options.localModels } : {}),
              });
              const activeSession = session;
              guard.controller.signal.addEventListener("abort", () => {
                // While disconnected nobody would notice; connected, the closing session fails its requests.
                if (!carry.socket) abortCarried(carry, activeSession, log, "lease_aborted");
                void activeSession.close();
              }, { once: true });
            }
          } catch (error) {
            diagnostic(log, "relay.authorization_unavailable", {}, error);
            reporter.report({ type: "authorization_unavailable", error });
            authorization = null;
            lease?.close();
            await session?.close();
            session = null; lease = null;
            await releaseHeld("authorization_unavailable");
          }
        } else {
          await releaseHeld("workspace_removed");
        }
        // Results kept for resending belong to one authorization; a different one never sees them.
        if (carryAuthorization !== authorization?.grant.id) { carry.outbox.clear(); carry.unacked.clear(); carry.unpinged.clear(); carryAuthorization = authorization?.grant.id; }
        const grant = await obtainGrant(device, authorization, lease, options.workspace, log);
        transports = grant.transports;
        selectedTransport = selectDeviceTransport(transports, preferredTransport);
        const isFallback = preferredTransport !== undefined && selectedTransport.kind === preferredTransport;
        reporter.report({ type: "connecting", mcpEnabled: Boolean(authorization), authorizationId: authorization?.grant.id, transport: selectedTransport.kind });
        diagnostic(log, isFallback ? `relay.transport_selected_fallback.${selectedTransport.kind}` : `relay.transport_selected.${selectedTransport.kind}`);
        await serveConnection(
          selectedTransport.websocketUrl,
          selectedTransport.accessToken,
          device.deviceId,
          session,
          lease,
          options.signal,
          log,
          (event) => {
            if (event.type === "connected") { delayMs = 1000; restartSince = undefined; }
            reporter.report(event);
          },
          maintenance,
          options.capabilities,
          carry,
        );
        preferredTransport = undefined;
        delayMs = 1000;
      } catch (error) {
        if (options.signal.aborted) break;
        if (selectedTransport && isTransportFallbackEligible(error)) {
          const fallback = nextDeviceTransportKind(transports, selectedTransport.kind);
          if (fallback) {
            preferredTransport = fallback;
            retryWithoutDelay = true;
            diagnostic(log, `relay.transport_fallback.${selectedTransport.kind}_to_${fallback}`, {}, error);
          } else {
            preferredTransport = undefined;
          }
        } else {
          preferredTransport = undefined;
        }
        diagnostic(log, selectedTransport ? `relay.disconnected.${selectedTransport.kind}` : "relay.disconnected", {}, error);
        reporter.report({ type: "disconnected", error });
        if (!retryWithoutDelay) {
          const next = nextReconnectDelay({ backoffMs: delayMs, restartSince }, error, Date.now());
          restartSince = next.restartSince;
          delayMs = next.backoffMs;
          await wait(next.delayMs, options.signal, retryNow);
        }
      } finally {
        if (session && lease && !options.signal.aborted && !lease.controller.signal.aborted && hasCarriedMcp(carry)) held = { session, lease };
        else { lease?.close(); await session?.close(); }
      }
    }
    reporter.report({ type: "stopped" });
    await reporter.flush();
  } finally { await releaseHeld("stopped"); closeAutoUpdate(); closeLinkSync(); (await closeRefresh)(); await closeMaintenance?.(); }
}

class DeviceTransportConnectionError extends Error {
  constructor(message: string, readonly fallbackEligible: boolean, readonly closeCode?: number) {
    super(message);
    this.name = "Error";
  }
}

export function isTransportFallbackEligible(error: unknown): boolean {
  return error instanceof DeviceTransportConnectionError && error.fallbackEligible;
}

function closedTransportError(code: number, reason: Buffer): DeviceTransportConnectionError {
  const text = reason.toString();
  const noFallback = new Set(["hard_lifetime", "connection_replaced", "device_revoked", "revocation_check_failed", "frame_invalid"]);
  return new DeviceTransportConnectionError(
    `WebSocket closed (${code}${text ? `: ${text}` : ""})`,
    !noFallback.has(text) && !isRelayRestartCode(code),
    code,
  );
}

/** 1012 (Service Restart) and 1001 (Going Away): the relay is restarting and will be back within seconds. */
function isRelayRestartCode(code: number): boolean {
  return code === 1012 || code === 1001;
}

export function isRelayRestartClose(error: unknown): boolean {
  return error instanceof DeviceTransportConnectionError && error.closeCode !== undefined && isRelayRestartCode(error.closeCode);
}

export const RELAY_RESTART_RETRY_WINDOW_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 15_000;
/** The relay pings every 15 s and so do we. Nothing at all from it (no ping, pong or frame) for this long means the socket is dead even if it still looks open. */
export const RELAY_SILENCE_LIMIT_MS = 35_000;
const RELAY_PING_MS = 15_000;
const RELAY_SILENCE_CHECK_MS = 5_000;

/**
 * After the relay announced a restart, retry about every 2 seconds for ten minutes (also when attempts fail
 * while the container is still starting), then fall back to the exponential backoff. A release that stops the
 * whole application keeps the relay away for minutes, so the window must outlast it or devices return up to 15 s late.
 */
export function nextReconnectDelay(
  state: { backoffMs: number; restartSince?: number | undefined },
  error: unknown,
  now: number,
  random: () => number = Math.random,
): { delayMs: number; backoffMs: number; restartSince?: number | undefined } {
  const restartSince = state.restartSince ?? (isRelayRestartClose(error) ? now : undefined);
  if (restartSince !== undefined && now - restartSince < RELAY_RESTART_RETRY_WINDOW_MS) {
    return { delayMs: Math.round(1600 + random() * 800), backoffMs: state.backoffMs, restartSince };
  }
  return { delayMs: state.backoffMs, backoffMs: Math.min(state.backoffMs * 2, MAX_BACKOFF_MS) };
}

export async function serveConnection(
  websocketUrl: string,
  accessToken: string,
  deviceId: string,
  session: RelaySession | null,
  lease: McpLease | null,
  signal: AbortSignal,
  log: (message: string) => void,
  report: (event: ConnectionEvent) => void = () => undefined,
  maintenance?: MaintenanceGate,
  capabilities?: () => Record<string, unknown> | Promise<Record<string, unknown>> | undefined,
  carry: RelayCarry = createRelayCarry(),
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(websocketUrl, DEVICE_RELAY_PROTOCOL, {
      headers: { authorization: `Bearer ${accessToken}`, "x-frely-device-id": deviceId },
      maxPayload: DEVICE_RELAY_MAX_FRAME_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
    });
    // Do not switch while completed responses are still buffered for the relay.
    const unregisterOutput = maintenance?.registerProcesses(() => socket.bufferedAmount);
    const { inflight, cancelled } = carry;
    let finished = false;
    const connectedAt = Date.now();
    let heartbeatNonce: Buffer | undefined;
    // Timestamps and the socket error code let a disconnect be attributed (relay timeout, network reset, device stall).
    let lastPingAt = connectedAt;
    let lastPongAt = connectedAt;
    let lastFrameAt = connectedAt;
    let lastInboundAt = connectedAt;
    let socketErrorCode: string | undefined;
    // Responses written before a ping are delivered once its pong returns (TCP keeps order); then they are no longer kept.
    const pinged = new Map<string, string[]>();
    const ping = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      heartbeatNonce = randomBytes(16);
      if (carry.unpinged.size > 0) { pinged.set(heartbeatNonce.toString("hex"), [...carry.unpinged]); carry.unpinged.clear(); }
      socket.ping(heartbeatNonce);
    };
    const heartbeat = setInterval(ping, RELAY_PING_MS);
    heartbeat.unref?.();
    // Detects a dead connection (no ping, pong or frame from the relay) instead of waiting for the OS to notice.
    const silenceWatch = setInterval(() => {
      if (Date.now() - lastInboundAt <= RELAY_SILENCE_LIMIT_MS) return;
      diagnostic(log, "relay.heartbeat_timeout", { ageMs: Date.now() - connectedAt, sinceLastPongMs: Date.now() - lastPongAt, sinceLastFrameMs: Date.now() - lastFrameAt, inflight: inflight.size });
      finish(new DeviceTransportConnectionError("Device transport heartbeat timed out.", true));
    }, RELAY_SILENCE_CHECK_MS);
    silenceWatch.unref?.();
    // Device-local MCP servers come and go, so the report is refreshed while connected.
    const capabilityTimer = capabilities ? setInterval(() => { void sendCapabilities(socket, capabilities); }, 60_000) : undefined;
    capabilityTimer?.unref?.();

    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      if (!error) diagnostic(log, "relay.closed", { durationMs: Date.now() - connectedAt });
      else if (!signal.aborted) {
        const at = Date.now();
        diagnostic(log, "relay.socket_closed", {
          ...(error instanceof DeviceTransportConnectionError && error.closeCode !== undefined ? { closeCode: error.closeCode } : {}),
          ...(socketErrorCode ? { socketErrorCode } : {}),
          ageMs: at - connectedAt, sinceLastPingMs: at - lastPingAt, sinceLastPongMs: at - lastPongAt, sinceLastFrameMs: at - lastFrameAt,
          inflight: inflight.size,
        });
      }
      unregisterOutput?.();
      clearInterval(heartbeat);
      clearInterval(silenceWatch);
      if (capabilityTimer) clearInterval(capabilityTimer);
      if (carry.socket === socket) carry.socket = undefined;
      // MCP commands keep running when only the connection dropped (same lease, not stopping); their results go out on the next one.
      const keepMcp = !signal.aborted && session !== null && lease !== null && !lease.controller.signal.aborted;
      const carried = keepMcp ? [...inflight.values()].filter((item) => item.request.method === "mcp" && !item.controller.signal.aborted).length : 0;
      if (carried > 0) diagnostic(log, "relay.inflight_carried", { inflight: carried, durationMs: Date.now() - connectedAt });
      // The relay answers these callers with "cancelled"; a retry here could repeat a mutation, so only record them.
      if (inflight.size > carried) diagnostic(log, "relay.inflight_cancelled", { inflight: inflight.size - carried, durationMs: Date.now() - connectedAt }, error);
      for (const [id, item] of inflight) {
        if (keepMcp && item.request.method === "mcp") continue;
        cancelled.add(id);
        item.controller.abort();
        if (item.request.method === "mcp") session?.cancel(id);
      }
      signal.removeEventListener("abort", onAbort);
      lease?.controller.signal.removeEventListener("abort", onLeaseAbort);
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish();
    signal.addEventListener("abort", onAbort, { once: true });

    const onLeaseAbort = () => report({ type: "mcp_disabled" });
    lease?.controller.signal.addEventListener("abort", onLeaseAbort, { once: true });
    socket.once("open", () => {
      carry.socket = socket;
      flushOutbox(carry, socket, log);
      diagnostic(log, "relay.connected");
      report({ type: "connected" });
      if (lease?.controller.signal.aborted) report({ type: "mcp_disabled" });
      void sendCapabilities(socket, capabilities);
      ping();
    });
    socket.on("ping", () => { lastPingAt = lastInboundAt = Date.now(); });
    socket.on("pong", (data: Buffer) => {
      lastPongAt = lastInboundAt = Date.now();
      const acknowledged = pinged.get(data.toString("hex"));
      if (acknowledged) { pinged.delete(data.toString("hex")); for (const id of acknowledged) carry.unacked.delete(id); }
      if (heartbeatNonce && data.equals(heartbeatNonce)) { heartbeatNonce = undefined; report({ type: "heartbeat" }); }
    });
    socket.once("error", (socketError: unknown) => {
      const code = socketError instanceof Error && "code" in socketError && typeof socketError.code === "string" ? socketError.code : undefined;
      socketErrorCode = code;
      finish(new DeviceTransportConnectionError("Device transport WebSocket failed.", true));
    });
    socket.once("close", (code, reason) => {
      if (signal.aborted) finish();
      else finish(closedTransportError(code, reason));
    });
    socket.on("message", (data) => {
      lastFrameAt = lastInboundAt = Date.now();
      // WebSocket peers may deliver the same JSON envelope as either a text
      // or a binary frame. `rawDataBuffer` normalizes both forms before the
      // protocol validator parses the JSON.
      void handleFrame(rawDataBuffer(data), socket, carry, session, lease, log, maintenance).catch((error) => { diagnostic(log, "relay.frame_failed", {}, error); finish(error); });
    });
  });
}

async function handleFrame(
  data: Buffer,
  socket: WebSocket,
  carry: RelayCarry,
  session: RelaySession | null,
  lease: McpLease | null,
  log: DiagnosticLog,
  maintenance?: MaintenanceGate,
): Promise<void> {
  const { inflight, cancelled } = carry;
  const envelope = decodeDeviceRelayEnvelope(data);
  if (envelope.type === "mcp_disabled") {
    if (lease?.authorizationId === envelope.id) { lease.close(); await session?.close(); }
    return;
  }
  if (envelope.type === "cancel") {
    carry.outbox.delete(envelope.id);
    carry.unacked.delete(envelope.id);
    const item = inflight.get(envelope.id);
    if (item) {
      cancelled.add(envelope.id);
      item.controller.abort();
      if (item.request.method === "mcp") session?.cancel(envelope.id);
    }
    return;
  }
  if (envelope.type !== "request") return;
  if (inflight.has(envelope.id)) { diagnostic(log, "relay.request_rejected", { requestId: envelope.id }, new Error("Duplicate Device Relay request id.")); send(socket, errorResponse(envelope.id, "duplicate_request", "Duplicate Device Relay request id."), log); return; }
  if (inflight.size >= DEVICE_RELAY_DEFAULT_MAX_INFLIGHT) { diagnostic(log, "relay.request_rejected", { requestId: envelope.id }); send(socket, errorResponse(envelope.id, "inflight_limit", "Device Relay request window is full."), log); return; }
  let release: (() => void) | undefined;
  try { release = maintenance?.enter(); }
  catch { send(socket, errorResponse(envelope.id, "upgrade_in_progress", "Frely is preparing an update. Retry after it completes."), log); return; }
  const controller = new AbortController();
  inflight.set(envelope.id, { request: envelope, controller });
  const operation = envelope.method === "provider"
    ? executeProviderRequest(envelope, socket, controller.signal, cancelled, log)
    : executeMcpRequest(envelope, session, lease, log).then((payload) => {
        if (!cancelled.has(envelope.id)) deliverResponse(carry, { protocol: DEVICE_RELAY_PROTOCOL, type: "response", id: envelope.id, ok: true, payload }, log);
      });
  void operation.catch((error) => {
    diagnostic(log, "relay.request_failed", { requestId: envelope.id, ...(envelope.method === "mcp" ? mcpDiagnosticContext(envelope.payload) : {}) }, error);
    if (!cancelled.has(envelope.id)) {
      const failure = errorResponse(envelope.id, relayErrorCode(envelope.method), safeMessage(error));
      if (envelope.method === "mcp") deliverResponse(carry, failure, log); else send(socket, failure, log);
    }
  }).finally(() => {
    release?.();
    inflight.delete(envelope.id);
    cancelled.delete(envelope.id);
  });
}

async function executeMcpRequest(request: DeviceRelayRequest, session: RelaySession | null, lease: McpLease | null, log?: DiagnosticLog): Promise<unknown> {
  if (!session || !lease || request.authorizationId !== lease.authorizationId) throw new Error("MCP execution authorization is missing or mismatched.");
  lease.assert();
  // The local lock of the three-state remote link is checked on every request, so `frely link off` takes effect at once.
  if (await remoteLocked()) throw new Error("Remote control is turned off on this computer. Run `frely link on` on it to allow it again.");
  // Observation only (plan P1): count whether the signed approvals riding on this request verify; never blocks.
  await observeApprovals(request.payload, log);
  // `autoUpdate` on the frame is ignored: an unsigned Relay field must not switch on automatic updates (gap G9).
  return session.execute(request.payload, request.id, request.toolsets, request.localMcps);
}

function relayErrorCode(method: string): string {
  if (method === "mcp") return "mcp_execution_failed";
  return "provider_execution_failed";
}

async function executeProviderRequest(request: DeviceRelayRequest, socket: WebSocket, signal: AbortSignal, cancelled: Set<string>, log: DiagnosticLog): Promise<void> {
  const opened = await openLocalProviderRequest(request.payload, signal);
  try { await forwardProviderResponse(opened, request, socket, signal, cancelled, log); } finally { await opened.release?.(); }
}

async function forwardProviderResponse(opened: Awaited<ReturnType<typeof openLocalProviderRequest>>, request: DeviceRelayRequest, socket: WebSocket, signal: AbortSignal, cancelled: Set<string>, log: DiagnosticLog): Promise<void> {
  if (opened.contentType !== "text/event-stream") {
    const body = await readLocalProviderBody(opened.response);
    if (!cancelled.has(request.id)) send(socket, {
      protocol: DEVICE_RELAY_PROTOCOL, type: "response", id: request.id, ok: true,
      payload: { status: opened.status, contentType: opened.contentType, body },
    }, log);
    return;
  }
  if (cancelled.has(request.id)) return;
  await sendAsync(socket, { protocol: DEVICE_RELAY_PROTOCOL, type: "stream_start", id: request.id, status: opened.status, contentType: opened.contentType });
  const reader = opened.response.body?.getReader();
  if (!reader) {
    await sendAsync(socket, { protocol: DEVICE_RELAY_PROTOCOL, type: "stream_end", id: request.id });
    return;
  }
  let completed = false;
  try {
    completed = await forwardCoalesced(
      reader,
      (piece) => sendAsync(socket, { protocol: DEVICE_RELAY_PROTOCOL, type: "stream_chunk", id: request.id, data: Buffer.from(piece).toString("base64url") }),
      () => cancelled.has(request.id),
    );
  } catch (error) {
    if (signal.aborted || cancelled.has(request.id)) return;
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (completed && !cancelled.has(request.id) && socket.readyState === WebSocket.OPEN) {
    await sendAsync(socket, { protocol: DEVICE_RELAY_PROTOCOL, type: "stream_end", id: request.id });
  }
}

/** True when the envelope itself went out; false when the socket was not open or only the too-large fallback was sent. */
function send(socket: WebSocket, envelope: DeviceRelayEnvelope, log: DiagnosticLog): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try { socket.send(encodeDeviceRelayEnvelope(envelope)); return true; }
  catch (error) {
    diagnostic(log, "relay.response_failed", { requestId: envelope.id }, error);
    if (envelope.type !== "response") return false;
    const fallback = errorResponse(envelope.id, "response_too_large", "Device Relay response exceeds the frame limit.");
    socket.send(encodeDeviceRelayEnvelope(fallback));
    return false;
  }
}

async function sendAsync(socket: WebSocket, envelope: DeviceRelayEnvelope): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) throw new Error("Device Relay connection is not open.");
  const encoded = encodeDeviceRelayEnvelope(envelope);
  await new Promise<void>((resolve, reject) => {
    socket.send(encoded, (error) => error ? reject(error) : resolve());
  });
}

/** Best-effort capability report; relay-side rejection must never drop the connection. */
async function sendCapabilities(socket: WebSocket, capabilities?: () => Record<string, unknown> | Promise<Record<string, unknown>> | undefined): Promise<void> {
  try {
    const report = await capabilities?.() ?? {};
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(encodeDeviceRelayEnvelope({ protocol: DEVICE_RELAY_PROTOCOL, type: "device_capabilities", id: `caps_${randomBytes(8).toString("hex")}`, capabilities: report }));
  } catch {
    // Older relays reject unknown frames; capability reporting is advisory only.
  }
}

function errorResponse(id: string, code: string, message: string): DeviceRelayResponse {
  return { protocol: DEVICE_RELAY_PROTOCOL, type: "response", id, ok: false, error: { code: code.slice(0, 64), message: message.slice(0, 512) } };
}
function rawDataBuffer(data: RawData): Buffer { if (Buffer.isBuffer(data)) return data; if (data instanceof ArrayBuffer) return Buffer.from(data); return Buffer.concat(data); }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/gu, " ").slice(0, 240); }
/** Sleeps for `ms`, ending early on abort or when `retryNow` fires (frely doctor asks a disconnected service to retry once). */
async function wait(ms: number, signal: AbortSignal, retryNow?: RetryNow): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms); const onAbort = () => done();
    function done() { clearTimeout(timer); signal.removeEventListener("abort", onAbort); retryNow?.cancel(done); resolve(); }
    signal.addEventListener("abort", onAbort, { once: true });
    retryNow?.arm(done);
  });
}

/** Lets a signal cut the current reconnect delay short. It does not reset the backoff and is ignored while connected. */
export const RETRY_NOW_SIGNAL = "SIGUSR2";
export interface RetryNow { arm(fn: () => void): void; cancel(fn: () => void): void }
export function createRetryNow(signal: AbortSignal, platform: NodeJS.Platform = process.platform): RetryNow {
  let waiting: (() => void) | undefined;
  if (platform !== "win32") {
    const handler = () => { const fn = waiting; waiting = undefined; fn?.(); };
    process.on(RETRY_NOW_SIGNAL, handler);
    signal.addEventListener("abort", () => process.off(RETRY_NOW_SIGNAL, handler), { once: true });
  }
  return { arm: (fn) => { waiting = fn; }, cancel: (fn) => { if (waiting === fn) waiting = undefined; } };
}

/**
 * Direct to Device Relay first, so a web app outage does not stop reconnecting. A relay that predates the
 * direct endpoint (404/405) gets the previous flow: login and authorization checked up front, grant via the web app.
 * With the direct grant the same checks run in the background and stop the session only on a definitive answer.
 */
async function obtainGrant(
  device: Awaited<ReturnType<typeof ensureDevice>>,
  authorization: Awaited<ReturnType<typeof requireLocalMcpAuthorization>> | null,
  lease: McpLease | null,
  workspace: string | undefined,
  log: (message: string) => void,
): Promise<ConnectionGrant> {
  if (authorization) {
    const direct = await directConnectionGrant(device, { authorizationId: authorization.grant.id, mcpResource: authorization.mcpResource, sign: authorization.sign });
    if (direct) {
      void requireMcpAuthorization(workspace).then(() => undefined, (error: unknown) => {
        diagnostic(log, "relay.background_check_failed", {}, error);
        if (isDefinitiveAuthorizationFailure(error)) lease?.close();
      });
      return direct;
    }
    await requireMcpAuthorization(workspace);
  }
  return await connectionGrant(device, authorization ? { authorizationId: authorization.grant.id, sign: authorization.sign } : undefined);
}
