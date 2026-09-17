import { authConfigPath, inspectAuth, probeCredentialStore, whoami, type AuthSnapshot } from "./auth.js";
import { inspectMcpMetadata, requireMcpAuthorization } from "./mcp-authorization.js";
import { readDeviceBinding } from "./device/state.js";
import { connectionIsLive, connectionStatusPath, readConnectionStatus } from "./device/connection-status.js";
import { serviceStatus } from "./service.js";
import { VERSION } from "./version.js";

export interface DiagnosticCheck { name: string; ok: boolean; detail: string; status: "pass" | "fail" | "info" }
export interface DoctorOptions { verbose?: boolean; /** Compatibility with doctor --mcp. */ mcp?: boolean }
const defaultDependencies = { inspectAuth, probeCredentialStore, whoami, inspectMcpMetadata, requireMcpAuthorization,
  readDeviceBinding, readConnectionStatus, serviceStatus };
type DoctorDependencies = typeof defaultDependencies;

export async function statusSnapshot() {
  const auth = await inspectAuth();
  const metadata = await inspectMcpMetadata().catch(() => null);
  return { version: VERSION, node: process.version, platform: process.platform, auth,
    mcp: metadata ? { configured: true, authorizationId: metadata.grant.id, expiresAt: metadata.grant.expiresAt,
      expired: !metadata.grant.expiresAt || Date.parse(metadata.grant.expiresAt) <= Date.now() } : { configured: false } };
}

/** The default snapshot is local; verbose also validates account and MCP authorization online. */
export async function doctor(options: DoctorOptions = {}, dependencies: DoctorDependencies = defaultDependencies) {
  const verbose = options.verbose === true || options.mcp === true;
  const checks: DiagnosticCheck[] = [];
  const add = (name: string, status: DiagnosticCheck["status"], detail: string) =>
    checks.push({ name, status, ok: status !== "fail", detail });
  add("runtime", Number(process.versions.node.split(".")[0]) >= 22 ? "pass" : "fail", process.version);

  const auth: AuthSnapshot = await dependencies.inspectAuth().catch(() => ({
    configured: false, credentialStored: false, configPath: authConfigPath(),
    credentialError: "Account configuration could not be read. Run frely login.",
  }));
  add("account", auth.credentialError || (auth.configured && !auth.credentialStored) ? "fail" : auth.credentialStored ? "pass" : "info",
    auth.credentialError ? "Account configuration or credentials could not be read. Run frely login."
      : auth.credentialStored ? `${auth.user?.email ?? "configured"} (stored; not checked online)`
      : "Not logged in (optional). Run frely login to use account features.");

  let metadataError = false;
  const metadata = await dependencies.inspectMcpMetadata().catch(() => { metadataError = true; return null; });
  const binding = await dependencies.readDeviceBinding().catch(() => null);
  const bindingMatches = Boolean(binding && binding.relayUrl === auth.relayUrl && binding.userId === auth.user?.id);
  const now = Date.now();
  const expired = Boolean(metadata && (metadata.grant.status !== "active" || !metadata.grant.expiresAt
    || !Number.isFinite(Date.parse(metadata.grant.expiresAt)) || Date.parse(metadata.grant.expiresAt) <= now));
  const mcpMatches = Boolean(metadata && bindingMatches && metadata.grant.deviceId === binding?.deviceId
    && metadata.relayUrl === binding?.relayUrl && metadata.userId === binding?.userId);
  add("mcp", metadataError || expired || (metadata && !mcpMatches) || (!metadata && options.mcp) ? "fail" : metadata ? "pass" : "info",
    metadataError ? "Configuration could not be read. Run frely mcp."
      : !metadata ? "Not enabled (optional)."
      : expired ? "Authorization expired or inactive. Run frely mcp renew."
      : !mcpMatches ? "Authorization does not match this account/device. Run frely mcp."
      : `Configured; expires ${metadata.grant.expiresAt} (local authorization).`);

  const service = metadata || binding ? await dependencies.serviceStatus().catch(() => null) : null;
  add("service", service?.active ? "pass" : "info",
    !metadata && !binding ? "Not configured."
      : !service ? "Service status unavailable."
      : service.active ? "Background service running."
      : service.installed ? "Background service stopped; a foreground relay may still be running."
      : "Background service not installed; a foreground relay may still be running.");

  const connection = bindingMatches && binding ? await dependencies.readConnectionStatus(binding).catch(() => null) : null;
  const live = Boolean(connection && connectionIsLive(connection));
  const mcpReady = live && Boolean(connection?.mcpEnabled && metadata && mcpMatches && !expired
    && connection.authorizationId === metadata.grant.id && connection.workspace === metadata.grant.workspace);
  const connectionState = !metadata && !binding ? "not_configured"
    : !bindingMatches || !connection ? "unknown"
    : live ? "connected"
    : connection.state === "disconnected" || connection.state === "stopped" ? connection.state : "unknown";
  add("connection", connectionState === "not_configured" ? "info" : live && (!metadata || mcpReady) ? "pass" : "fail",
    connectionState === "not_configured" ? "Not configured."
      : live && metadata && !mcpReady ? "Relay connected, but this MCP authorization/workspace is not active in the running service."
      : live ? "Relay connected; recent heartbeat received."
      : connectionState === "disconnected" ? "Disconnected; the relay is retrying."
      : connectionState === "stopped" ? "Relay stopped. Run frely mcp service start."
      : "Unknown: no recent heartbeat for this account/device. Run frely doctor -v.");

  if (verbose) {
    try { await dependencies.probeCredentialStore(); add("basic_storage", "pass", "Private session storage read/write/delete verified."); }
    catch { add("basic_storage", "fail", "Private session storage is unavailable or not writable."); }
    if (auth.credentialStored) {
      try { await dependencies.whoami(); add("account_session", "pass", "Account session verified by the server."); }
      catch { add("account_session", "fail", "Account session could not be verified. Check connectivity and login."); }
    } else add("account_session", "info", "Not checked: no stored account credential.");
    if (metadata && !expired && mcpMatches) {
      try { await dependencies.requireMcpAuthorization(); add("mcp_authorization", "pass", "Secure key and server authorization verified."); }
      catch { add("mcp_authorization", "fail", "Secure key or server authorization could not be verified. Check connectivity, login and MCP renewal."); }
    } else add("mcp_authorization", "info", "Not checked: MCP configuration/authorization is unavailable.");
  }

  return {
    schemaVersion: "frely.cli.doctor.v1", version: VERSION, mode: verbose ? "verbose" : "summary",
    checkedAt: new Date().toISOString(), ok: checks.every((check) => check.ok),
    summary: {
      account: auth.credentialError ? "Configuration unreadable" : auth.credentialStored
        ? (auth.user?.email ?? "Configured") + " (stored)" : "Not logged in",
      mcp: metadataError ? "Configuration unreadable" : !metadata ? "Not enabled" : expired ? "Expired or inactive"
        : !mcpMatches ? "Account/device mismatch" : "Configured (local); expires " + metadata.grant.expiresAt,
      service: !metadata && !binding ? "Not configured" : !service ? "Unknown" : service.active ? "Running"
        : service.installed ? "Stopped" : "Not installed",
      connection: connectionState === "not_configured" ? "Not configured"
        : live ? metadata && !mcpReady ? "Relay connected; MCP unavailable" : "Connected (recent heartbeat)"
        : connectionState === "disconnected" ? "Disconnected (retrying)" : connectionState === "stopped" ? "Stopped"
        : "Unknown (no recent heartbeat)",
    },
    checks,
    ...(verbose ? { details: {
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      configPath: auth.configPath, relayStatusPath: connectionStatusPath(), relayUrl: auth.relayUrl,
      credentialBackend: auth.credentialBackend, deviceId: binding?.deviceId, workspace: metadata?.grant.workspace,
      expiresAt: metadata?.grant.expiresAt, service,
      connection: { state: connectionState, live, mcpReady, observation: connection },
      coverage: "Heartbeat verifies the device-to-relay transport. ChatGPT OAuth and end-to-end tool calls are not tested.",
    } } : {}),
  };
}

export function formatDoctor(report: Awaited<ReturnType<typeof doctor>>): string {
  const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ");
  const lines = [`Frely CLI ${report.version}`];
  if (report.mode === "summary") {
    for (const [label, detail] of Object.entries(report.summary)) lines.push(`${label === "mcp" ? "MCP" : label[0]!.toUpperCase() + label.slice(1)}: ${clean(detail)}`);
    if (!report.checks.find((check) => check.name === "runtime")!.ok) lines.push("Runtime: Node.js 22 or later is required.");
    lines.push("Run frely doctor -v for detailed diagnostics.");
  } else {
    for (const check of report.checks) lines.push(`${check.status.toUpperCase()} ${check.name}: ${clean(check.detail)}`);
    if (report.details) lines.push("", "Details:", ...JSON.stringify(report.details, null, 2).split("\n"));
  }
  return lines.join("\n") + "\n";
}
