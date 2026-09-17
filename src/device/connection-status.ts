import { VERSION } from "../version.js";
import { IS_STANDALONE } from "../cli-launch.js";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deviceStatePath, type DeviceBinding } from "./state.js";
import { diagnosticError } from "../runtime/diagnostics.js";

export const HEARTBEAT_MAX_AGE_MS = 75_000;
export interface ConnectionStatus {
  version: 1;
  cliVersion?: string;
  autoRefresh?: boolean;
  entry?: string;
  startedAt?: string;
  pid: number;
  relayUrl: string;
  userId: string;
  deviceId: string;
  workspace?: string;
  authorizationId?: string | undefined;
  mcpEnabled: boolean;
  state: "connecting" | "connected" | "disconnected" | "stopped";
  updatedAt: string;
  connectedAt?: string | undefined;
  heartbeatAt?: string | undefined;
  lastError?: string;
}
export type ConnectionEvent =
  | { type: "upgrade_watch"; enabled: boolean }
  | { type: "connecting"; authorizationId?: string | undefined; mcpEnabled: boolean }
  | { type: "connected" | "heartbeat" | "mcp_disabled" | "stopped" }
  | { type: "disconnected" | "authorization_unavailable"; error: unknown };

export function connectionStatusPath(): string {
  return join(dirname(deviceStatePath()), "relay-status-v1.json");
}

/** Observability must never interrupt tool execution or serialize credentials/errors verbatim. */
export function connectionReporter(binding: DeviceBinding, workspace?: string) {
  let current: ConnectionStatus = {
    version: 1, cliVersion: VERSION, entry: realpathSync(IS_STANDALONE ? process.execPath : process.argv[1]!), startedAt: new Date().toISOString(), pid: process.pid, relayUrl: binding.relayUrl, userId: binding.userId,
    deviceId: binding.deviceId, ...(workspace ? { workspace } : {}),
    mcpEnabled: false, state: "connecting", updatedAt: new Date().toISOString(),
  };
  let pending = Promise.resolve();
  const path = connectionStatusPath();
  const report = (event: ConnectionEvent) => {
    const now = new Date().toISOString();
    current = { ...current, updatedAt: now };
    if (event.type === "upgrade_watch") {
      current = { ...current, autoRefresh: event.enabled };
    } else if (event.type === "connecting") {
      current = { ...current, state: "connecting", mcpEnabled: event.mcpEnabled,
        authorizationId: event.authorizationId, heartbeatAt: undefined, connectedAt: undefined };
    } else if (event.type === "connected") {
      current = { ...current, state: "connected", connectedAt: now };
    } else if (event.type === "heartbeat") {
      current = { ...current, heartbeatAt: now };
    } else if (event.type === "mcp_disabled") {
      current = { ...current, mcpEnabled: false };
    } else if (event.type === "disconnected" || event.type === "authorization_unavailable") {
      const error = diagnosticError(event.error);
      current = { ...current, ...(event.type === "disconnected" ? { state: "disconnected" as const } : {}), mcpEnabled: false,
        lastError: [error.code, error.message].filter(Boolean).join(": ") };
    } else {
      current = { ...current, state: "stopped", mcpEnabled: false };
    }
    const content = JSON.stringify(current) + "\n";
    pending = pending.then(async () => {
      const temp = path + "." + process.pid + "." + randomUUID() + ".tmp";
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(temp, content, { flag: "wx", mode: 0o600 });
        await rename(temp, path);
      } finally { await rm(temp, { force: true }).catch(() => undefined); }
    }).catch(() => undefined);
  };
  return { report, flush: () => pending };
}

export async function readConnectionStatus(binding: DeviceBinding): Promise<ConnectionStatus | null> {
  const raw = await readFile(connectionStatusPath(), "utf8").catch(() => null);
  if (!raw) return null;
  let value: ConnectionStatus;
  try { value = JSON.parse(raw) as ConnectionStatus; } catch { return null; }
  if (!value || value.version !== 1 || value.relayUrl !== binding.relayUrl || value.userId !== binding.userId
    || value.deviceId !== binding.deviceId || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !["connecting", "connected", "disconnected", "stopped"].includes(value.state)
    || typeof value.mcpEnabled !== "boolean" || !Number.isFinite(Date.parse(value.updatedAt))
    || (value.heartbeatAt !== undefined && !Number.isFinite(Date.parse(value.heartbeatAt)))
    || (value.connectedAt !== undefined && !Number.isFinite(Date.parse(value.connectedAt)))
    || (value.workspace !== undefined && typeof value.workspace !== "string")
    || (value.authorizationId !== undefined && !/^mca_[a-f0-9]{32}$/u.test(value.authorizationId))) return null;
  // Return only known fields; never print arbitrary content from a diagnostic file.
  return { version: 1,
    ...(typeof value.autoRefresh === "boolean" ? { autoRefresh: value.autoRefresh } : {}),
    ...(typeof value.cliVersion === "string" ? { cliVersion: value.cliVersion.slice(0, 80) } : {}),
    ...(typeof value.entry === "string" ? { entry: value.entry } : {}),
    ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
    pid: value.pid, relayUrl: binding.relayUrl, userId: binding.userId, deviceId: binding.deviceId,
    state: value.state, mcpEnabled: value.mcpEnabled, updatedAt: value.updatedAt,
    ...(value.workspace ? { workspace: value.workspace } : {}),
    ...(value.authorizationId ? { authorizationId: value.authorizationId } : {}),
    ...(value.heartbeatAt ? { heartbeatAt: value.heartbeatAt } : {}),
    ...(value.connectedAt ? { connectedAt: value.connectedAt } : {}),
    ...(typeof value.lastError === "string" ? { lastError: value.lastError.slice(0, 240) } : {}) };
}
export function connectionIsLive(status: ConnectionStatus, now = Date.now()): boolean {
  if (status.state !== "connected" || !status.heartbeatAt) return false;
  const age = now - Date.parse(status.heartbeatAt);
  if (!Number.isFinite(age) || age < 0 || age > HEARTBEAT_MAX_AGE_MS) return false;
  try { process.kill(status.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
