import { inspectAuth, probeCredentialStore, whoami } from "./auth.js";
import { currentDevice } from "./device/control.js";
import { serviceStatus } from "./service.js";

export interface DiagnosticCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function statusSnapshot() {
  const auth = await inspectAuth();
  let device = null;
  if (auth.configured && auth.credentialStored) device = await currentDevice().catch(() => null);
  const service = await serviceStatus().catch(() => ({ installed: false, active: false, platform: process.platform }));
  return {
    version: "0.3.0",
    node: process.version,
    platform: process.platform,
    auth,
    device: device ? { deviceId: device.deviceId, mcpUrl: device.mcpUrl, keyThumbprint: device.keyThumbprint } : null,
    service,
  };
}

export async function doctor(): Promise<{ ok: boolean; checks: DiagnosticCheck[] }> {
  const checks: DiagnosticCheck[] = [];
  const major = Number(process.versions.node.split(".", 1)[0]);
  checks.push({ name: "node", ok: major >= 22, detail: process.version });

  try {
    await probeCredentialStore();
    checks.push({ name: "credential_store", ok: true, detail: "read/write/delete succeeded" });
  } catch (error) {
    checks.push({ name: "credential_store", ok: false, detail: message(error) });
  }

  const auth = await inspectAuth();
  checks.push({
    name: "config",
    ok: auth.configured && (auth.configMode === undefined || auth.configMode === 0o600),
    detail: auth.configured ? `${auth.configPath}${auth.configMode === undefined ? "" : ` mode=${auth.configMode.toString(8)}`}` : "not configured",
  });
  checks.push({ name: "credential", ok: auth.credentialStored, detail: auth.credentialStored ? "stored" : "missing" });

  if (auth.configured && auth.credentialStored) {
    try {
      const user = await whoami();
      checks.push({ name: "relay_session", ok: true, detail: `${user.email} @ ${auth.relayUrl}` });
      const device = await currentDevice();
      checks.push({ name: "mcp_device", ok: Boolean(device), detail: device ? `${device.deviceId} -> ${device.mcpUrl}` : "not provisioned; run frely mcp url" });
    } catch (error) {
      checks.push({ name: "relay_session", ok: false, detail: message(error) });
      checks.push({ name: "mcp_device", ok: false, detail: "unavailable until login is valid" });
    }
  } else {
    checks.push({ name: "relay_session", ok: false, detail: "login required" });
    checks.push({ name: "mcp_device", ok: false, detail: "login required" });
  }

  const service = await serviceStatus().catch((error) => ({ installed: false, active: false, platform: process.platform, error: message(error) }));
  checks.push({
    name: "mcp_service",
    ok: service.installed && service.active,
    detail: "error" in service ? service.error : service.active ? `running${service.workspace ? ` workspace=${service.workspace}` : ""}` : service.installed ? "installed but stopped" : "not installed; run frely mcp setup",
  });

  return { ok: checks.every((check) => check.ok), checks };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
