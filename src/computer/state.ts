import { appendFile, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function computerDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "computer");
}

const switchPath = () => join(computerDir(), "switch.json");
const auditPath = () => join(computerDir(), "audit.jsonl");

export interface ComputerSwitch { version: 1; enabled: true; enabledAt: string }

/**
 * Local key of the two-key rule (plan computer-use D3): computer use only works on a device where a
 * person sitting at it ran `frely computer enable`. The web grant alone never turns it on.
 */
export async function readComputerSwitch(): Promise<ComputerSwitch | null> {
  const raw = await readFile(switchPath(), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ComputerSwitch>;
    return value.version === 1 && value.enabled === true && typeof value.enabledAt === "string" ? value as ComputerSwitch : null;
  } catch { return null; }
}

export async function writeComputerSwitch(): Promise<ComputerSwitch> {
  const value: ComputerSwitch = { version: 1, enabled: true, enabledAt: new Date().toISOString() };
  const path = switchPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => undefined);
  return value;
}

export async function clearComputerSwitch(): Promise<boolean> {
  return unlink(switchPath()).then(() => true, () => false);
}

export interface ComputerAuditEntry { ts: string; tool: string; app?: string; ok: boolean; ms: number; reason?: string }

/** Metadata only: never the screenshot, the typed text or any tool output. Failures here never affect the call. */
export async function appendComputerAudit(entry: ComputerAuditEntry): Promise<void> {
  try {
    const path = auditPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch { /* best effort */ }
}
