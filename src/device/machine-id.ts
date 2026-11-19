import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** The OS's own id for this computer: IOPlatformUUID on macOS, machine-id on Linux, MachineGuid on Windows. Null when unreadable. */
export async function osMachineId(platform: NodeJS.Platform = process.platform): Promise<string | null> {
  try {
    if (platform === "darwin") {
      const { stdout } = await execFile("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 3000, maxBuffer: 256 * 1024 });
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/u.exec(stdout)?.[1] ?? null;
    }
    if (platform === "linux") {
      for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        const value = (await readFile(path, "utf8").catch(() => "")).trim();
        if (/^[0-9a-f]{32}$/u.test(value)) return value;
      }
      return null;
    }
    if (platform === "win32") {
      const { stdout } = await execFile("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { timeout: 3000, windowsHide: true });
      return /MachineGuid\s+REG_SZ\s+(\S+)/u.exec(stdout)?.[1] ?? null;
    }
  } catch { /* unreadable: enroll without it */ }
  return null;
}

/**
 * What enrollment sends instead of the machine id: a hash salted with the account, so Frely can tell a re-install on the same computer
 * from a new computer, while the value means nothing outside this account.
 */
export function machineFingerprint(machineId: string, userId: string): string {
  return createHash("sha256").update(`frely-machine-v1\n${userId}\n${machineId.trim().toLowerCase()}`).digest("hex");
}
