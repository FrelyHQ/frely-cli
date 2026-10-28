import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SERVICE_SHARE_ID, type ServiceType } from "./service-config.js";

/** A registered service on this computer. The port is local-only and is never sent to Frely. */
export interface LocalService {
  serviceShareId: string;
  type: ServiceType;
  label: string;
  /** A port on 127.0.0.1. */
  port: number;
  createdAt: string;
  /** True when the background service (the device daemon) keeps this service connected. */
  background: boolean;
}

interface State { version: 1; services: LocalService[] }

export function localServiceStatePath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "local-services.json");
}

export async function listLocalServices(): Promise<LocalService[]> { return [...(await readState()).services]; }

export async function saveLocalService(service: LocalService): Promise<void> {
  validate(service);
  const state = await readState();
  const services = state.services.filter((candidate) => candidate.serviceShareId !== service.serviceShareId);
  services.push({ ...service });
  services.sort((a, b) => a.serviceShareId.localeCompare(b.serviceShareId));
  await writeState({ version: 1, services });
}

export async function removeLocalService(serviceShareId: string): Promise<boolean> {
  const state = await readState();
  const services = state.services.filter((service) => service.serviceShareId !== serviceShareId);
  if (services.length === state.services.length) return false;
  await writeState({ version: 1, services });
  return true;
}

function validate(service: LocalService): void {
  if (!SERVICE_SHARE_ID.test(service.serviceShareId)) throw new Error("Frely local service ID is invalid.");
  if (service.type !== "mcp" && service.type !== "a2a") throw new Error("Frely local service type is invalid.");
  if (!service.label || service.label.length > 60) throw new Error("Frely local service label is invalid.");
  if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) throw new Error("Frely local service port is invalid.");
}

async function readState(): Promise<State> {
  const raw = await readFile(localServiceStatePath(), "utf8").catch(() => null);
  if (!raw) return { version: 1, services: [] };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Frely local service configuration is invalid."); }
  const record = value as { version?: unknown; services?: unknown } | null;
  if (!record || typeof record !== "object" || record.version !== 1 || !Array.isArray(record.services)) throw new Error("Frely local service configuration is invalid.");
  const services = record.services.map((entry): LocalService => {
    const row = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const service = { serviceShareId: String(row.serviceShareId ?? ""), type: row.type as ServiceType, label: String(row.label ?? ""), port: Number(row.port), createdAt: String(row.createdAt ?? ""), background: row.background === true };
    validate(service);
    return service;
  });
  return { version: 1, services };
}

async function writeState(state: State): Promise<void> {
  const path = localServiceStatePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => undefined);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => undefined);
}
