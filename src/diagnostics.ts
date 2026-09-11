import { inspectAuth, probeCredentialStore, whoami } from "./auth.js";

export interface DiagnosticCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function statusSnapshot() {
  const auth = await inspectAuth();
  return {
    version: "0.2.0",
    node: process.version,
    platform: process.platform,
    auth,
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
    } catch (error) {
      checks.push({ name: "relay_session", ok: false, detail: message(error) });
    }
  } else {
    checks.push({ name: "relay_session", ok: false, detail: "login required" });
  }

  return { ok: checks.every((check) => check.ok), checks };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
