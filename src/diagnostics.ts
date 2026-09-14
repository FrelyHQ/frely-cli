import { inspectAuth, probeCredentialStore, whoami } from "./auth.js";
import { inspectMcpMetadata, requireMcpAuthorization } from "./mcp-authorization.js";
import { VERSION } from "./version.js";

export interface DiagnosticCheck { name: string; ok: boolean; detail: string }
export async function statusSnapshot() {
  const auth = await inspectAuth();
  const metadata = await inspectMcpMetadata().catch(() => null);
  return { version: VERSION, node: process.version, platform: process.platform, auth,
    mcp: metadata ? { configured: true, authorizationId: metadata.grant.id, expiresAt: metadata.grant.expiresAt,
      expired: !metadata.grant.expiresAt || Date.parse(metadata.grant.expiresAt) <= Date.now() } : { configured: false } };
}
export async function doctor(options: { mcp?: boolean } = {}): Promise<{ ok: boolean; checks: DiagnosticCheck[] }> {
  const checks: DiagnosticCheck[] = [{ name: "runtime", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.version }];
  try { await probeCredentialStore(); checks.push({ name: "basic_storage", ok: true, detail: "private session files; no OS keyring required" }); }
  catch { checks.push({ name: "basic_storage", ok: false, detail: "User-private session directory is not writable." }); }
  const auth = await inspectAuth();
  checks.push({ name: "account", ok: !auth.credentialError, detail: auth.credentialError ?? (auth.credentialStored ? "configured" : "not logged in; account features require frely login") });
  if (auth.credentialStored) {
    try { await whoami(); checks.push({ name: "account_session", ok: true, detail: "valid" }); }
    catch { checks.push({ name: "account_session", ok: false, detail: "Session unavailable; run frely login." }); }
  }
  if (options.mcp) {
    try { const authorization = await requireMcpAuthorization(); checks.push({ name: "mcp", ok: true, detail: `authorized until ${authorization.grant.expiresAt}` }); }
    catch (error) { checks.push({ name: "mcp", ok: false, detail: error instanceof Error ? error.message : "MCP authorization unavailable." }); }
  } else {
    const metadata = await inspectMcpMetadata().catch(() => null);
    checks.push({ name: "mcp", ok: true, detail: metadata ? "optional; use frely doctor --mcp for MCP checks" : "not enabled (optional)" });
  }
  return { ok: checks.every((check) => check.ok), checks };
}
