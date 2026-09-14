#!/usr/bin/env node
import { setupMcpAuthorization, requireMcpAuthorization, inspectMcpMetadata, revokeMcpAuthorization } from "./mcp-authorization.js";
import { McpLease } from "./runtime/mcp-lease.js";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { loginDevice, logout, requireLogin, whoami } from "./auth.js";
import { doctor, statusSnapshot } from "./diagnostics.js";
import { currentDevice, ensureDevice, revokeDevice } from "./device/control.js";
import { createLocalProviderToken, loadOrCreateDeviceIdentity } from "./device/identity.js";
import { serveDeviceRelay } from "./device/relay-client.js";
import { startStdioMcp } from "./runtime/mcp.js";
import { installDeviceRelayService, installMcpService, serviceStatus, startMcpService, stopMcpService, uninstallMcpService } from "./service.js";
import { discoverLocalModels } from "./provider/local.js";
import { finalizeLocalProvider, listPersonalProviderSlots, prepareLocalProvider, waitForLocalProviderRelay } from "./provider/control.js";
import { getLocalProvider, isSupportedLocalModelName, listLocalProviders, normalizeLoopbackOpenAiBaseUrl, saveLocalProvider } from "./provider/state.js";
import { VERSION } from "./version.js";
import { runNetwork, publicNetworkError } from "./network.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "mcp" && ["--help", "help", "-h"].includes(args[1] ?? "")) return usage();
  if (command === "mcp" && args.length === 1) args.push("setup");
  if (command === "--version" || command === "-v" || command === "version") {
    stdout.write(`${VERSION}\n`);
    return;
  }
  if (!command || command === "help" || command === "--help" || command === "-h") return usage();

  if (command === "network") {
    const value = await runNetwork(args);
    if (args.includes("--json")) stdout.write(`${JSON.stringify(value)}\n`);
    else stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  if (command === "login") {
    const relay = option(args, "--relay");
    const result = await loginDevice(relay, ({ verificationUri, userCode }) => {
      stdout.write(`Open this URL to authorize Frely CLI:\n${verificationUri}\n`);
      stdout.write(`Device code: ${userCode}\nWaiting for approval...\n`);
    });
    const user = result.user;
    stdout.write(`Logged in as ${user.email}.\n`);
    stdout.write("Run `frely mcp setup --workspace <path>` to provision this machine and get the ChatGPT MCP address.\n");
    return;
  }

  if (command === "logout") {
    await stopMcpService().catch(() => undefined);
    await logout();
    stdout.write("Frely login removed and MCP background service stopped.\n");
    return;
  }

  if (command === "whoami") {
    const user = await whoami();
    stdout.write(`${user.email} (${user.id})\n`);
    return;
  }

  if (command === "status") {
    const value = await statusSnapshot();
    if (args.includes("--json")) stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    else {
      stdout.write(`Frely CLI ${VERSION}\n`);
      stdout.write(`Relay: ${value.auth.relayUrl ?? "not configured"}\n`);
      stdout.write(`Account: ${value.auth.user?.email ?? "not logged in"}\n`);
      stdout.write(`Credential: ${value.auth.credentialStored ? "stored" : "missing"}\n`);
    }
    return;
  }

  if (command === "doctor") {
    const value = await doctor({ mcp: args.includes("--mcp") });
    if (args.includes("--json")) stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    else for (const check of value.checks) stdout.write(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}\n`);
    if (!value.ok) process.exitCode = 1;
    return;
  }

  if (command === "provider" && args[1] === "share") {
    const driver = args[2] ?? "ollama";
    if (driver !== "ollama" && driver !== "openai-compatible") throw new Error("Provider driver must be `ollama` or `openai-compatible`.");
    const auth = await requireLogin();
    const device = await ensureDevice();
    const defaultUrl = driver === "ollama" ? "http://127.0.0.1:11434/v1" : "http://127.0.0.1:8080/v1";
    const baseUrl = normalizeLoopbackOpenAiBaseUrl(option(args, "--url") ?? defaultUrl);
    const selectedModels = option(args, "--models")?.split(",").map((value) => value.trim()).filter(Boolean);
    const models = selectedModels?.length ? [...new Set(selectedModels)] : await discoverLocalModels(baseUrl);
    if (models.length < 1 || models.length > 256 || models.some((model) => !isSupportedLocalModelName(model))) throw new Error("At least one valid model is required; model names cannot contain whitespace or `/`.");
    const slots = await listPersonalProviderSlots();
    const requestedSlot = option(args, "--slot");
    const slot = requestedSlot ? slots.find((candidate) => candidate.id === requestedSlot) : slots.find((candidate) => candidate.lifecycle === "active" && candidate.provider === null);
    if (!slot) throw new Error(requestedSlot ? "The requested personal Provider slot is unavailable." : "No empty active personal Provider slot is available.");
    if (slot.lifecycle !== "active" || slot.provider !== null) throw new Error("The selected personal Provider slot is not empty and active.");
    const name = (option(args, "--name") ?? `${driver === "ollama" ? "Ollama" : "Local"}: ${models[0]}`).slice(0, 128);
    const prepared = await prepareLocalProvider({ deviceId: device.deviceId, slotId: slot.id, name, models });
    await saveLocalProvider({ providerId: prepared.providerId, name, driver, baseUrl, providerBaseUrl: prepared.providerBaseUrl, models, createdAt: new Date().toISOString() });
    const service = await installDeviceRelayService();
    const identity = await loadOrCreateDeviceIdentity(auth.config.relayUrl, auth.user.id);
    const token = createLocalProviderToken(identity, device.deviceId, auth.user.id, prepared.providerId);
    try {
      await waitForLocalProviderRelay(prepared.providerBaseUrl, token);
      await finalizeLocalProvider({ providerId: prepared.providerId, token });
    } catch (error) {
      throw new Error(`Provider ${prepared.providerId} is prepared but not ready. Run \`frely provider finalize ${prepared.providerId}\`. ${error instanceof Error ? error.message : String(error)}`);
    }
    stdout.write(`Provider: ${prepared.providerId}\n`);
    stdout.write(`Models: ${models.join(", ")}\n`);
    stdout.write(`Device Relay: ${service.active ? "running" : "installed"}\n`);
    stdout.write("The Provider is ready for Access Point creation in Frely.\n");
    return;
  }

  if (command === "provider" && args[1] === "finalize") {
    const providerId = args[2] ?? "";
    if (!/^prv_[0-9a-f]{24}$/u.test(providerId)) throw new Error("Usage: frely provider finalize <provider-id>");
    const auth = await requireLogin();
    const device = await ensureDevice();
    const provider = await getLocalProvider(providerId);
    if (!provider) throw new Error("Local Provider is not configured on this device.");
    const service = await installDeviceRelayService();
    const identity = await loadOrCreateDeviceIdentity(auth.config.relayUrl, auth.user.id);
    const token = createLocalProviderToken(identity, device.deviceId, auth.user.id, providerId);
    await waitForLocalProviderRelay(provider.providerBaseUrl, token);
    await finalizeLocalProvider({ providerId, token });
    stdout.write(`Provider: ${providerId}\n`);
    stdout.write(`Models: ${provider.models.join(", ")}\n`);
    stdout.write(`Device Relay: ${service.active ? "running" : "installed"}\n`);
    stdout.write("The Provider is ready for Access Point creation in Frely.\n");
    return;
  }

  if (command === "provider" && args[1] === "list") {
    await requireLogin();
    const providers = await listLocalProviders();
    if (args.includes("--json")) stdout.write(`${JSON.stringify({ providers }, null, 2)}\n`);
    else if (providers.length === 0) stdout.write("No local Providers are configured on this device.\n");
    else for (const provider of providers) stdout.write(`${provider.providerId}  ${provider.driver}  ${provider.name}  ${provider.models.join(", ")}\n`);
    return;
  }

  if (command === "mcp" && (args[1] === "setup" || args[1] === "renew")) {
    const old = await inspectMcpMetadata();
    const workspace = option(args, "--workspace") ?? (args[1] === "renew" ? old?.grant.workspace : undefined) ?? process.cwd();
    const authorization = await setupMcpAuthorization(workspace, option(args, "--days"), args[1] === "renew", ({ verificationUri, keyThumbprint, days }) => {
      stdout.write(`MCP remote execution authorization: ${days} days\nMCP key: ${keyThumbprint}\nApprove: ${verificationUri}\n`);
    });
    const service = await installMcpService(authorization.grant.workspace);
    stdout.write(`MCP URL: ${authorization.mcpUrl}\nExpires: ${authorization.grant.expiresAt}\nBackground service: ${service.active ? "running" : "installed"}\n`);
    stdout.write("Keep the MCP URL private. Renewal rotates the URL; update the remote client after renewal.\n");
    return;
  }

  if (command === "mcp" && (args[1] === "url" || args[1] === "chatgpt")) {
    const authorization = await requireMcpAuthorization();
    if (args.includes("--json")) stdout.write(`${JSON.stringify({ deviceId: authorization.grant.deviceId, mcpUrl: authorization.mcpUrl, expiresAt: authorization.grant.expiresAt })}\n`);
    else stdout.write(`${authorization.mcpUrl}\n`);
    return;
  }

  if (command === "mcp" && args[1] === "status") {
    const metadata = await inspectMcpMetadata();
    const value = metadata ? { configured: true, deviceId: metadata.grant.deviceId, workspace: metadata.grant.workspace,
      expiresAt: metadata.grant.expiresAt, expired: !metadata.grant.expiresAt || Date.parse(metadata.grant.expiresAt) <= Date.now() } : { configured: false };
    stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  if (command === "mcp" && args[1] === "serve") {
    const serviceConfigHome = option(args, "--service-config-home");
    const serviceCredentialStore = option(args, "--service-credential-store");
    if (serviceConfigHome) process.env.XDG_CONFIG_HOME = resolve(serviceConfigHome);
    if (serviceCredentialStore) process.env.FRELY_CREDENTIAL_STORE = serviceCredentialStore;
    await requireLogin();
    const providerOnly = args.includes("--provider-only");
    const workspace = providerOnly ? undefined : resolve(option(args, "--workspace") || process.cwd());
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await serveDeviceRelay({ ...(workspace ? { workspace } : {}), signal: controller.signal, log: (message) => process.stderr.write(`${message}\n`) });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return;
  }

  if (command === "mcp" && args[1] === "service") {
    const action = args[2] ?? "status";
    if (action === "status") {
      const service = await serviceStatus();
      if (args.includes("--json")) stdout.write(`${JSON.stringify(service, null, 2)}\n`);
      else {
        stdout.write(`Installed: ${service.installed ? "yes" : "no"}\n`);
        stdout.write(`Active: ${service.active ? "yes" : "no"}\n`);
        if (service.workspace) stdout.write(`Workspace: ${service.workspace}\n`);
      }
      return;
    }
    if (action === "start") { const service = await startMcpService(); stdout.write(`Frely MCP service ${service.active ? "started" : "not active"}.\n`); return; }
    if (action === "stop") { const service = await stopMcpService(); stdout.write(`Frely MCP service ${service.active ? "still active" : "stopped"}.\n`); return; }
    if (action === "uninstall") { await uninstallMcpService(); stdout.write("Frely MCP background service removed.\n"); return; }
    throw new Error("Unknown MCP service action. Use status, start, stop, or uninstall.");
  }

  if (command === "mcp" && args[1] === "revoke") {
    await revokeMcpAuthorization();
    stdout.write("MCP execution authorization revoked. The Provider device and service were retained.\n");
    return;
  }

  if (command === "mcp" && args[1] === "stdio") {
    const workspace = resolve(option(args, "--workspace") || process.cwd());
    const authorization = await requireMcpAuthorization(workspace);
    const lease = new McpLease(authorization.grant.id, Date.parse(authorization.grant.expiresAt!));
    await startStdioMcp(workspace, { assertAuthorized: () => lease.assert(), signal: lease.controller.signal });
    const verify = setInterval(() => { void requireMcpAuthorization(workspace).catch(() => lease.close()); }, 5000);
    verify.unref?.();
    lease.controller.signal.addEventListener("abort", () => clearInterval(verify), { once: true });
    return;
  }

  usage();
  process.exitCode = 2;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function usage(): void {
  stdout.write(
    "Usage:\n" +
    "  frely network setup|status|find|use|logout [--json]\n" +
    "  frely login [--relay <url>]\n" +
    "  frely logout\n" +
    "  frely whoami\n" +
    "  frely status [--json]\n" +
    "  frely doctor [--mcp] [--json]\n" +
    "  frely provider share [ollama|openai-compatible] [--url <loopback-v1-url>] [--models <a,b>] [--slot <slot-id>] [--name <name>]\n" +
    "  frely provider list [--json]\n" +
    "  frely provider finalize <provider-id>\n" +
    "  frely mcp [setup] [--workspace <path>] [--days 1..360]\n" +
    "  frely mcp renew [--days 1..360]\n" +
    "  frely mcp url [--json]\n" +
    "  frely mcp status [--json]\n" +
    "  frely mcp chatgpt\n" +
    "  frely mcp serve [--workspace <path>]\n" +
    "  frely mcp service status|start|stop|uninstall [--json]\n" +
    "  frely mcp revoke\n" +
    "  frely mcp stdio [--workspace <path>]\n"
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json") && process.argv[2] === "network") process.stdout.write(`${JSON.stringify(publicNetworkError(error))}\n`);
  else process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
