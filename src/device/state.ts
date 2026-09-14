import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DeviceBinding {
  version: 2;
  relayUrl: string;
  userId: string;
  deviceId: string;
  publicKeySpki: string;
  keyThumbprint: string;
  updatedAt: string;
}

export function deviceStatePath(): string {
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(root, "frely", "device-basic-v1.json");
}

export async function readDeviceBinding(): Promise<DeviceBinding | null> {
  const raw = await readFile(deviceStatePath(), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<DeviceBinding>;
    if (value.version !== 2 || typeof value.relayUrl !== "string" || typeof value.userId !== "string" || typeof value.deviceId !== "string" || typeof value.publicKeySpki !== "string" || typeof value.keyThumbprint !== "string") return null;
    return value as DeviceBinding;
  } catch {
    return null;
  }
}

export async function writeDeviceBinding(binding: DeviceBinding): Promise<void> {
  const path = deviceStatePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => undefined);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(binding, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => undefined);
}

export async function clearDeviceBinding(): Promise<void> {
  await unlink(deviceStatePath()).catch(() => undefined);
}
