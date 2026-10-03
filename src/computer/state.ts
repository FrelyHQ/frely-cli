import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function computerDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "computer");
}

const auditPath = () => join(computerDir(), "audit.jsonl");

export interface ComputerAuditEntry { ts: string; tool: string; app?: string; ok: boolean; ms: number; reason?: string }

/** Metadata only: never the screenshot, the typed text or any tool output. Failures here never affect the call. */
export async function appendComputerAudit(entry: ComputerAuditEntry): Promise<void> {
  try {
    const path = auditPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch { /* best effort */ }
}
