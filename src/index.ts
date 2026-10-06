#!/usr/bin/env node
import { update } from "./update/update.js";
import { requireMcpAuthorization, inspectMcpMetadataOrQuarantine, revokeMcpAuthorization, generateMcpKey, parseMcpDays, MCP_DEFAULT_DAYS } from "./mcp-authorization.js";
import { realpath } from "node:fs/promises";
import { runLocalMcpCommand } from "./local-mcp-command.js";
import { runWorkspaceCommand } from "./workspace-command.js";
import { McpLease } from "./runtime/mcp-lease.js";
import { join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { inspectAuth, loginDevice, logout, normalizeRelayUrl, requireLogin, initEmailDeviceLogin, completeEmailDeviceLogin, savePendingEmailChallenge, readPendingEmailChallenge, deletePendingEmailChallenge, localDeviceId, finishDeviceLogin, readConfig } from "./auth.js";
import { basicCredentialStore as credentialStore } from "./credential-basic.js";
import type { EmailDeviceChallenge } from "./auth.js";
import { doctor, formatDoctor } from "./diagnostics.js";
import { ensureDevice } from "./device/control.js";
import { createLocalProviderToken, loadOrCreateDeviceIdentity } from "./device/identity.js";
import { serveDeviceRelay } from "./device/relay-client.js";
import { startStdioMcp } from "./runtime/mcp.js";
import { installDeviceRelayService, serviceStatus, startMcpService, stopMcpService, uninstallMcpService } from "./service.js";
import { discoverLocalModels } from "./provider/local.js";
import { finalizeLocalProvider, listPersonalProviderSlots, prepareLocalProvider, waitForLocalProviderRelay } from "./provider/control.js";
import { isSupportedLocalModelName, listLocalProviders, normalizeLoopbackOpenAiBaseUrl, saveLocalProvider, type LocalProviderBinding } from "./provider/state.js";
import { CLOUD_USAGE, logoutCloud, runCloud } from "./cloud.js";
import { createAgentService } from "./agent/compose.js";
import { loadAgentConfig, saveAgentConfig } from "./agent/agent-service.js";
import { readAppInstall } from "./agent/app-install.js";
import { appInstallStatus, installApp, openApp, uninstallApp, updateApp } from "./app-manager.js";
import { detectSandboxBackend } from "./runtime/sandbox.js";
import { LocalMcpHub } from "./runtime/local-mcp.js";
import { provisionAgentKey } from "./agent/app-key.js";
import { startAgentOpsServer } from "./agent/ops-server.js";
import { runAgentOpsStdioBridge } from "./agent/ops-stdio.js";
import { pingAgentOpsSocket } from "./agent/ops-server.js";
import { agentStateDir } from "./agent/task-store.js";
import { TaskStore } from "./agent/task-store.js";
import { VERSION } from "./version.js";
import { agentHelp, cliUsage, mcpUsage, subcommandUsage } from "./agent-help.js";
import { ensureMcpAuthorization, grantInactive, normalizeMcpArgs, startMcp } from "./mcp-command.js";
import { getKeyBudget, KeyBudgetError, publicKeyBudgetError } from "./key-budget.js";
import { runNetwork, publicNetworkError } from "./network.js";
import { runComputerCommand } from "./computer/command.js";
import { runComputerMcpServer } from "./computer/server.js";
import { agentManifestUrl, installSkillAdapter, invokeInstalledAgent, publicSkillAccessError, removeSkillAdapter, skillAdapterStatus } from "./skill/access.js";
import type { SkillHost, SkillScope } from "./skill/managed.js";
import { installCloudItem, trustCloudItem } from "./skill/cloud-item.js";
import { callCloudTool } from "./cloud.js";


const DEFAULT_EMAIL_LOGIN_MCP_DAYS = MCP_DEFAULT_DAYS;

async function main(): Promise<void> {
  const args = normalizeMcpArgs(process.argv.slice(2));
  const command = args[0];
  if (command === "update") {
    if (args.length !== 1) throw new Error("Usage: frely update. Version checks are available in frely doctor.");
    const result = await update((message) => process.stderr.write(message));
    stdout.write(result.message + "\n");
    return;
  }
  if (command === "mcp" && args[1] === "help") { stdout.write(mcpUsage()); return; }
  if (command === "--version" || command === "-v" || command === "version") {
    stdout.write(`${VERSION}\n`);
    return;
  }
  if ((command === "help" || command === "--help") && args.includes("--agent")) {
    stdout.write(JSON.stringify(agentHelp(), null, args.includes("--json") ? undefined : 2) + "\n");
    return;
  }
  if (!command || command === "help" || command === "--help" || command === "-h") return usage();

  if (command === "cloud") {
    if (args[1] === undefined) { stdout.write(CLOUD_USAGE); return; }
    const result = await runCloud(args);
    stdout.write(result.text ?? JSON.stringify(result.value, null, 2) + "\n");
    if (result.failed) process.exitCode = 2;
    return;
  }

  if (command === "network") {
    const value = await runNetwork(args);
    if (args.includes("--json")) stdout.write(`${JSON.stringify(value)}\n`);
    else stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  if (command === "agent") {
    const action = args[1];
    if (action === undefined) { stdout.write(subcommandUsage("agent")); return; }
    if (action === "install") {
      const target = args[2];
      if (!target || target.startsWith("-")) throw new Error("Usage: frely agent install <distribution-id|manifest-url> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--api-key-stdin] [--json]");
      const host = skillHost(option(args, "--host") ?? "generic");
      const scope = skillScope(option(args, "--scope") ?? "global");
      const apiKey = args.includes("--api-key-stdin") ? await readStdinSecret(8192) : undefined;
      const relayUrl = normalizeRelayUrl((await inspectAuth().catch(() => null))?.relayUrl);
      const value = await installSkillAdapter({ manifestUrl: agentManifestUrl(target, relayUrl), host, scope, ...(apiKey ? { apiKey } : {}) });
      if (args.includes("--json")) stdout.write(`${JSON.stringify(value)}\n`);
      else stdout.write(`Agent: ${value.name}\nSkill: ${value.skillPath}\nAuth: ${value.authMode}\nState: ${value.state}\n${value.hostAction ? `Host action: ${value.hostAction}\n` : ""}`);
      return;
    }
    if (action === "run") {
      const distributionId = args[2];
      if (!distributionId || distributionId.startsWith("-")) throw new Error("Usage: frely agent run <distribution-id> (--input <text>|--input-stdin) [--json]");
      const task = args.includes("--input-stdin") ? await readStdinText(128 * 1024) : option(args, "--input");
      if (!task) throw new Error("Agent input is required. Use --input or --input-stdin.");
      const value = await invokeInstalledAgent({ distributionId, task });
      if (args.includes("--json")) stdout.write(`${JSON.stringify(value)}\n`);
      else stdout.write(`${value.text}\n`);
      return;
    }
    if (action === "status") {
      const json = args.includes("--json");
      if (args.includes("--api-key-stdin")) {
        const relayUrl = option(args, "--relay");
        const budget = await getKeyBudget({ apiKey: await readStdinSecret(8192), ...(relayUrl === undefined ? {} : { relayUrl }) });
        stdout.write(JSON.stringify({ ok: true, budget }, null, json ? undefined : 2) + "\n");
        return;
      }
      const distributionId = args[2];
      if (!distributionId || distributionId.startsWith("-")) throw new KeyBudgetError("input_invalid", "Usage: frely agent status (<distribution-id>|--api-key-stdin [--relay <url>]) [--json]");
      const status = await skillAdapterStatus(distributionId);
      let budget: Record<string, unknown> | undefined;
      if (status.installed && status.authMode === "api-key") {
        budget = await getKeyBudget({ distributionId }).then((value) => ({ ...value }), (error: unknown) => ({ error: publicKeyBudgetError(error).error }));
      }
      const value = { ...status, ...(budget ? { budget } : {}) };
      if (json) stdout.write(`${JSON.stringify(value)}\n`);
      else if (!status.installed) stdout.write("Agent is not installed.\n");
      else stdout.write(`Agent: ${status.name}\nState: ${status.state}\nAuth: ${status.authMode}\nSkill: ${status.skillPath}\n${budget ? `Budget: ${JSON.stringify(budget, null, 2)}\n` : ""}`);
      return;
    }
    if (action === "remove") {
      const distributionId = args[2];
      if (!distributionId || distributionId.startsWith("-")) throw new Error("Usage: frely agent remove <distribution-id> [--json]");
      const value = await removeSkillAdapter(distributionId);
      if (args.includes("--json")) stdout.write(`${JSON.stringify(value)}\n`);
      else stdout.write(value.removed ? "Agent removed.\n" : "Agent was not installed.\n");
      return;
    }
    throw new Error(`Unknown agent command.\n${subcommandUsage("agent")}`);
  }

  if (command === "item") {
    if (args[1] === "trust") {
      const folder = args[2];
      if (!folder || folder.startsWith("-")) throw new Error("Usage: frely item trust <folder> [--check]");
      const check = args.includes("--check");
      const result = await trustCloudItem(folder, { check });
      stdout.write(`${result.trusted ? "trusted" : "not reviewed"}\n`);
      if (check && !result.trusted) process.exitCode = 1;
      return;
    }
    if (args[1] !== "install") { stdout.write(subcommandUsage("item")); return; }
    const skillId = args[2];
    if (!skillId || skillId.startsWith("-")) throw new Error("Usage: frely item install <item-id> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--dir <path>] [--json]");
    const host = skillHost(option(args, "--host") ?? "generic");
    const scope = skillScope(option(args, "--scope") ?? "global");
    const dir = option(args, "--dir");
    const value = await installCloudItem({ skillId, call: callCloudTool, host, scope, ...(dir ? { dir } : {}) });
    if (args.includes("--json")) { stdout.write(`${JSON.stringify(value)}\n`); return; }
    stdout.write(`${value.kind === "prompt" ? "Prompt" : "Skill"}: ${value.name} (v${value.version})\nPath: ${value.path}\nFiles: ${value.files}\n`);
    if (value.premium === "installed") stdout.write("Paid part: installed\n");
    if (value.premium === "pass_required") stdout.write(`Paid part: not installed. Buy a pass in the marketplace or with frely cloud call passes.buy --json '{"productKind":"cloud_skill","productId":"${value.id}","duration":"30d"}', then run this command again.\n`);
    if (value.hasScripts) stdout.write("This item contains scripts. Read them before you let an agent run them; they were saved without execute permission.\n");
    if (value.scanned) stdout.write("Passed Frely automated scan for this version. This is an automated check, not a guarantee.\n");
    if (value.guarded) stdout.write("Frely has not scanned this Skill. Your agent reviews it with the frely-item-guard Skill before first use.\n");
    if (value.kind === "skill") stdout.write("Restart or reload the agent session so it rescans Skills.\n");
    return;
  }

  if (command === "login") {
    if (args.includes("--help") || args.includes("-h")) return usage();
    const relay = option(args, "--relay");
    const noBrowser = args.includes("--no-browser") || process.env.FRELY_NO_BROWSER === "1";
    const email = option(args, "--email");
    const code = option(args, "--code");
    const invite = option(args, "--invite");
    const json = args.includes("--json");

    // Email-based device login (two steps): `--email` sends the code, `--code` finishes.
    if (email || code) {
      const relayUrl = normalizeRelayUrl(relay);
      if (code) {
        try {
          const pendingChallenge = await readPendingEmailChallenge(relayUrl);
          if (!pendingChallenge) {
            stdout.write("No pending email verification. Run `frely login --email <email>` first.\n");
            process.exitCode = 1;
            return;
          }
          const result = await completeEmailDeviceLogin(relayUrl, pendingChallenge, code);
          const deviceId = localDeviceId((await readConfig().catch(() => null))?.deviceId);
          const { user } = await finishDeviceLogin(relayUrl, pendingChallenge, deviceId);
          await deletePendingEmailChallenge(relayUrl);
          stdout.write(`Logged in as ${user.email}.\n`);

          const mcp = pendingChallenge.mcp;
          if (mcp && result.mcpPreapproval) {
            const authorization = await ensureMcpAuthorization({
              workspace: mcp.workspace, days: String(mcp.days),
              notify: (message) => { process.stderr.write(message); },
              preset: { privateKeyPem: mcp.privateKeyPem, preapproval: result.mcpPreapproval },
            });
            stdout.write(`Device MCP enabled for ${authorization.grant.workspace} until ${authorization.grant.expiresAt}. Remove it any time with \`frely mcp remove\`.\n`);
            stdout.write(`MCP address: ${authorization.mcpUrl}\n`);
          } else {
            stdout.write("Run `frely mcp start` on the computer you want to control, then connect your MCP client with OAuth.\n");
          }
        } catch (error) {
          stdout.write(`Verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
          process.exitCode = 1;
        }
        return;
      }

      try {
        let mcp: EmailDeviceChallenge["mcp"];
        if (args.includes("--mcp")) {
          const workspace = await realpath(resolve(option(args, "--workspace") || process.cwd()));
          const days = parseMcpDays(option(args, "--days") ?? DEFAULT_EMAIL_LOGIN_MCP_DAYS);
          mcp = { ...generateMcpKey(), workspace, days };
        }
        const challenge = await initEmailDeviceLogin(relayUrl, email!, invite, mcp);
        await savePendingEmailChallenge(relayUrl, challenge);

        if (json) {
          stdout.write(JSON.stringify({
            state: "code_sent",
            email: challenge.email,
            expiresIn: challenge.expiresIn,
            challengeId: challenge.challengeId,
            ...(mcp ? { deviceMcp: { workspace: mcp.workspace, days: mcp.days } } : {}),
          }, null, 2) + "\n");
        } else {
          stdout.write(`Verification code sent to ${challenge.email}\n`);
          stdout.write(`Expires in: ${challenge.expiresIn} seconds\n`);
          if (mcp) {
            stdout.write(`Entering the code also lets remote agents read and write files and run commands in ${mcp.workspace} for ${mcp.days} days. Remove it later with \`frely mcp remove\`.\n`);
          }
          stdout.write(`Run: frely login --code <code>\n`);
        }
      } catch (error) {
        stdout.write(`Failed to send verification code: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
      return;
    }

    // Browser-based device login (traditional)
    const result = await loginDevice(relay, ({ verificationUri, userCode }) => {
      stdout.write(`Open this URL to authorize Frely CLI:\n${verificationUri}\n`);
      stdout.write(`Device code: ${userCode}\n`);
      stdout.write(noBrowser
        ? "Automatic browser opening is disabled. Open this new URL only in the browser signed in to the account you want to use.\n"
        : "Opening your default browser. To use another account or browser, press Ctrl+C and run `frely login --no-browser` for a new URL.\n");
      stdout.write("Waiting for approval...\n");
    }, { openBrowser: !noBrowser });
    const user = result.user;
    stdout.write(`Logged in as ${user.email}.\n`);
    if (!("sessionBound" in result) || !result.sessionBound) {
      stdout.write("Your server version is older and does not support logging out per device yet.\n");
    }
    stdout.write("Run `frely mcp start --workspace <path>` on the computer you want to control, then connect your MCP client with OAuth.\n");
    return;
  }

  if (command === "logout") {
    await stopMcpService().catch(() => undefined);
    // Cloud credentials are keyed by the signed-in account, so revoke them before removing the login.
    const cloudRevoked = await logoutCloud().then(() => true, () => false);
    await logout();
    stdout.write("Frely login removed and MCP background service stopped.\n");
    if (!cloudRevoked) process.stderr.write("Cloud authorization revocation was not confirmed; revoke it in Frely account settings if needed.\n");
    return;
  }

  if (command === "doctor") {
    const value = await doctor({ verbose: args.includes("-v") || args.includes("--verbose"), mcp: args.includes("--mcp") });
    if (args.includes("--json")) stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    else stdout.write(formatDoctor(value));
    if (!value.ok) process.exitCode = 1;
    return;
  }

  if (command === "provider" && args[1] === undefined) { stdout.write(subcommandUsage("provider")); return; }
  if (command === "provider" && args[1] === "share") {
    const auth = await requireLogin();
    const device = await ensureDevice();
    const pending = (await listLocalProviders()).find((provider) => provider.pending);
    if (pending) {
      stdout.write(`Resuming prepared Provider ${pending.providerId}.\n`);
      await activateLocalProvider(auth, device.deviceId, pending);
      return;
    }
    const driver = args[2] ?? "ollama";
    if (driver !== "ollama" && driver !== "openai-compatible") throw new Error("Provider driver must be `ollama` or `openai-compatible`.");
    const defaultUrl = driver === "ollama" ? "http://127.0.0.1:11434/v1" : "http://127.0.0.1:8080/v1";
    const baseUrl = normalizeLoopbackOpenAiBaseUrl(option(args, "--url") ?? defaultUrl);
    const selectedModels = option(args, "--models")?.split(",").map((value) => value.trim()).filter(Boolean);
    const models = selectedModels?.length ? [...new Set(selectedModels)] : await discoverLocalModels(baseUrl);
    if (models.length < 1 || models.length > 256 || models.some((model) => !isSupportedLocalModelName(model))) throw new Error("At least one valid model is required; model names cannot contain whitespace or `/`.");
    const requestedSlot = option(args, "--slot");
    const forceCreator = args.includes("--creator");
    if (forceCreator && requestedSlot) throw new Error("Use either --slot or --creator, not both.");
    const slots = forceCreator ? [] : await listPersonalProviderSlots();
    const slot = requestedSlot ? slots.find((candidate) => candidate.id === requestedSlot) : slots.find((candidate) => candidate.lifecycle === "active" && candidate.provider === null);
    if (requestedSlot && !slot) throw new Error("The requested personal Provider slot is unavailable.");
    if (slot && (slot.lifecycle !== "active" || slot.provider !== null)) throw new Error("The selected personal Provider slot is not empty and active.");
    const name = (option(args, "--name") ?? `${driver === "ollama" ? "Ollama" : "Local"}: ${models[0]}`).slice(0, 128);
    // Without an empty personal slot the Provider counts against the Creator Plan Provider limit.
    const prepared = await prepareLocalProvider(slot ? { deviceId: device.deviceId, slotId: slot.id, name, models } : { deviceId: device.deviceId, source: "creator", name, models });
    if (!slot) stdout.write("Created as a Creator Provider. Pick these models when you create a Frely Agent; buyers call the Agent, and this device must stay online.\n");
    const provider = { providerId: prepared.providerId, name, driver, baseUrl, providerBaseUrl: prepared.providerBaseUrl, models, createdAt: new Date().toISOString(), pending: true } as const;
    await saveLocalProvider(provider);
    await activateLocalProvider(auth, device.deviceId, provider);
    return;
  }

  if (command === "provider" && args[1] === "list") {
    await requireLogin();
    const providers = await listLocalProviders();
    if (args.includes("--json")) stdout.write(`${JSON.stringify({ providers }, null, 2)}\n`);
    else if (providers.length === 0) stdout.write("No local Providers are configured on this device.\n");
    else for (const provider of providers) stdout.write(`${provider.providerId}  ${provider.driver}  ${provider.name}  ${provider.models.join(", ")}${provider.pending ? "  (pending: run frely provider share)" : ""}\n`);
    return;
  }

  if (command === "app" && args[1] === undefined) { stdout.write(subcommandUsage("app")); return; }
  if (command === "app" && args[1] === "key") {
    const lifetime = Number(option(args, "--lifetime-usd") ?? 50);
    const key = await provisionAgentKey(lifetime);
    if (args.includes("--json")) stdout.write(`${JSON.stringify({ keyId: key.keyId, name: key.name, lifetimeUsd: key.lifetimeUsd })}\n`);
    else stdout.write(`Frely app key: ${key.name}\nKey: ${key.rawKey}\nLifetime spend limit: $${key.lifetimeUsd ?? "unlimited"}\n`);
    stdout.write("This key is shown once and is not stored by the CLI. Store it where the frely app reads model credentials.\n");
    return;
  }

  if (command === "app" && args[1] === "ops") {
    process.exitCode = await runAgentOpsStdioBridge({ stdout: process.stdout, stdin: process.stdin, stderr: process.stderr });
    return;
  }

  if (command === "app" && args[1] === "connect-info") {
    const socketPath = join(agentStateDir(), "ops.sock");
    const probe = await pingAgentOpsSocket(socketPath, 300);
    const value = { opsSocketPath: socketPath, running: probe.running, ...(probe.version ? { version: probe.version } : {}), ...(probe.pid ? { pid: probe.pid } : {}) };
    if (args.includes("--json")) stdout.write(`${JSON.stringify(value)}\n`);
    else stdout.write(`Ops socket: ${socketPath}\nStatus: ${probe.running ? "running" : "stopped (start with frely mcp serve)"}\n`);
    return;
  }

  if (command === "computer") {
    if (args[1] === "mcp") { await runComputerMcpServer(); return; }
    stdout.write(await runComputerCommand(args.slice(1)));
    return;
  }

  if (command === "app" && args[1] === "remote") {
    const action = args[2];
    if (action === undefined) { stdout.write(subcommandUsage("app.remote")); return; }
    const config = await loadAgentConfig();
    if (action === "enable") {
      await saveAgentConfig({ ...config, remoteControlEnabled: true });
      stdout.write("Agent remote control enabled. Start or restart the device relay service (frely mcp start).\n");
    } else if (action === "disable") {
      await saveAgentConfig({ ...config, remoteControlEnabled: false });
      stdout.write("Agent remote control disabled.\n");
    } else if (action === "status") {
      const value = { remoteControlEnabled: config.remoteControlEnabled, defaultMaxCostUsd: config.defaultMaxCostUsd, maxCostUsdLimit: config.maxCostUsdLimit, maxConcurrentTasks: config.maxConcurrentTasks };
      if (args.includes("--json")) stdout.write(`${JSON.stringify(value)}\n`);
      else stdout.write(`Agent remote control: ${config.remoteControlEnabled ? "enabled" : "disabled"}\nDefault task budget: $${config.defaultMaxCostUsd} (limit $${config.maxCostUsdLimit})\nConcurrent tasks: up to ${config.maxConcurrentTasks}\n`);
    } else throw new Error(`Unknown app remote command.\n${subcommandUsage("app.remote")}`);
    return;
  }

  if (command === "app" && args[1] === "tasks") {
    const store = TaskStore.open();
    const tasks = await store.list();
    if (args.includes("--json")) stdout.write(`${JSON.stringify(tasks)}\n`);
    else for (const task of tasks) stdout.write(`${task.id}  ${task.status.padEnd(14)} ${task.mergeStatus.padEnd(15)} $${task.usage.costUsd.toFixed(3)}/${task.maxCostUsd.toFixed(2)}  ${task.goal.split("\n")[0]!.slice(0, 60)}\n`);
    return;
  }

  if (command === "app" && args[1] === "install") {
    const result = await installApp({ log: (message) => stdout.write(`${message}\n`) }, { force: args.includes("--force") });
    if (args.includes("--json")) stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === "app" && args[1] === "open") {
    await openApp({ log: (message) => stdout.write(`${message}\n`) }, { window: args.includes("--window") });
    return;
  }

  if (command === "app" && args[1] === "status") {
    const status = await appInstallStatus({ log: () => {} });
    const value = { installed: status.installed, ...(status.path ? { path: status.path } : {}), ...(status.version ? { version: status.version } : {}), running: status.running, managedBy: status.managedBy };
    if (args.includes("--json")) stdout.write(`${JSON.stringify(value)}\n`);
    else if (!status.installed) stdout.write("Frely App is not installed. Run `frely app install`.\n");
    else stdout.write(`Frely App ${status.version ? `v${status.version} ` : ""}at ${status.path}\nState: ${status.running ? "running" : "not running"} (managed by ${status.managedBy})\n`);
    return;
  }

  if (command === "app" && args[1] === "update") {
    const result = await updateApp({ log: (message) => stdout.write(`${message}\n`) });
    if (args.includes("--json")) stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === "app" && args[1] === "uninstall") {
    await uninstallApp({ log: (message) => stdout.write(`${message}\n`) });
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
    const agentLog = (message: string) => process.stderr.write(`${message}\n`);
    const agent = createAgentService({ defaultWorkspace: workspace ?? process.cwd(), log: agentLog });
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    // Device-local MCP servers are only served with device MCP, never for a provider-only relay.
    const localMcp = providerOnly ? undefined : new LocalMcpHub({ log: agentLog });
    localMcp?.start();
    try {
      const capabilities = async () => {
        const install = await readAppInstall().then((value) => value, () => null);
        const config = await loadAgentConfig();
        await localMcp?.ensureFresh(5 * 60_000).catch(() => undefined);
        return {
          app: { ...(install ? { installed: true, version: install.appVersion } : { installed: false }) },
          sandbox: detectSandboxBackend(),
          agentHost: true,
          remoteControl: config.remoteControlEnabled,
          ...(localMcp ? { localMcp: localMcp.capabilities() } : {}),
        };
      };
      const ops = await startAgentOpsServer(agent, { workspace: workspace ?? process.cwd(), log: agentLog });
      process.stderr.write(`Agent ops socket: ${ops.path}\n`);
      try {
        await serveDeviceRelay({ ...(workspace ? { workspace } : {}), ...(localMcp ? { localMcp } : {}), agent, capabilities, managedService: Boolean(serviceConfigHome), restartForUpdate: stop, signal: controller.signal, log: (message) => process.stderr.write(`${message}\n`) });
      } finally {
        await ops.close().catch(() => undefined);
      }
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await localMcp?.close();
    }
    return;
  }
  if (command === "mcp" && args[1] === "local") {
    if (args[2] === undefined) { stdout.write(subcommandUsage("mcp.local")); return; }
    await runLocalMcpCommand({ args, write: (text) => { stdout.write(text); } });
    return;
  }
  if (command === "mcp" && args[1] === "workspace") {
    if (args[2] === undefined) { stdout.write(subcommandUsage("mcp.workspace")); return; }
    const metadata = await inspectMcpMetadataOrQuarantine((message) => { process.stderr.write(message); });
    await runWorkspaceCommand({ args, primary: metadata?.grant.workspace ?? null, write: (text) => { stdout.write(text); } });
    return;
  }

  if (command === "mcp" && args[1] === "start") {
    if (process.argv[3] === "url") process.stderr.write("`frely mcp url` is deprecated; use `frely mcp start`.\n");
    // Internal: update scripts only resume the installed service, never prompt for approval.
    if (args.includes("--resume")) { const service = await startMcpService(); stdout.write(`Frely MCP service ${service.active ? "started" : "not active"}.\n`); return; }
    const workspace = option(args, "--workspace");
    const days = option(args, "--days");
    const authorization = await startMcp({ ...(workspace ? { workspace } : {}), ...(days ? { days } : {}), notify: (message) => { process.stderr.write(message); } });
    const value = { deviceId: authorization.grant.deviceId, mcpUrl: authorization.mcpUrl, transport: "http", authentication: "oauth", workspace: authorization.grant.workspace, expiresAt: authorization.grant.expiresAt };
    if (args.includes("--json")) stdout.write(`${JSON.stringify(value)}\n`);
    else stdout.write(`${authorization.mcpUrl}\n`);
    return;
  }
  if (command === "mcp" && args[1] === "status") {
    const metadata = await inspectMcpMetadataOrQuarantine((message) => { process.stderr.write(message); });
    const service = await serviceStatus();
    const expired = metadata ? grantInactive(metadata) : false;
    const value = { configured: Boolean(metadata), service: { installed: service.installed, running: service.active }, ...(metadata ? { mcpUrl: metadata.mcpResource, workspace: metadata.grant.workspace, expiresAt: metadata.grant.expiresAt, expired } : {}) };
    if (args.includes("--json")) stdout.write(`${JSON.stringify(value)}\n`);
    else if (!metadata) stdout.write(`Device MCP is not configured. Run frely mcp start.\nService: ${service.active ? "running" : service.installed ? "stopped" : "not installed"}\n`);
    else stdout.write(`MCP URL: ${metadata.mcpResource}\nWorkspace: ${metadata.grant.workspace}\nAuthorization: ${expired ? "expired or inactive (run frely mcp start to renew)" : `active until ${metadata.grant.expiresAt}`}\nService: ${service.active ? "running" : service.installed ? "stopped (run frely mcp start)" : "not installed (run frely mcp start)"}\n`);
    return;
  }
  if (command === "mcp" && args[1] === "stop") { const service = await stopMcpService(); stdout.write(`Frely MCP service ${service.active ? "still active" : "stopped"}.\n`); return; }

  if (command === "mcp" && args[1] === "remove") {
    await revokeMcpAuthorization((message) => { process.stderr.write(message); });
    if ((await listLocalProviders()).length > 0) {
      await installDeviceRelayService();
      stdout.write("Device MCP removed. The background service keeps running for local Providers.\n");
    } else {
      await uninstallMcpService();
      stdout.write("Device MCP removed and background service uninstalled.\n");
    }
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

  if (command === "provider" || command === "app") throw new Error(`Unknown ${command} command.\n${subcommandUsage(command)}`);
  usage();
  process.exitCode = 2;
}

async function activateLocalProvider(auth: Awaited<ReturnType<typeof requireLogin>>, deviceId: string, provider: LocalProviderBinding): Promise<void> {
  const service = await installDeviceRelayService();
  const identity = await loadOrCreateDeviceIdentity(auth.config.relayUrl, auth.user.id);
  const token = createLocalProviderToken(identity, deviceId, auth.user.id, provider.providerId);
  try {
    await waitForLocalProviderRelay(provider.providerBaseUrl, token);
    await finalizeLocalProvider({ providerId: provider.providerId, token });
  } catch (error) {
    throw new Error(`Provider ${provider.providerId} is prepared but not ready. Run \`frely provider share\` again to resume. ${error instanceof Error ? error.message : String(error)}`);
  }
  const { pending: _pending, ...ready } = provider;
  await saveLocalProvider(ready);
  stdout.write(`Provider: ${provider.providerId}\n`);
  stdout.write(`Models: ${provider.models.join(", ")}\n`);
  stdout.write(`Device Relay: ${service.active ? "running" : "installed"}\n`);
  stdout.write("The Provider is ready for Access Point creation in Frely.\n");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function skillHost(value: string): SkillHost {
  if (["chatgpt", "codex", "claude-code", "pi", "generic"].includes(value)) return value as SkillHost;
  throw new Error("--host must be chatgpt, codex, claude-code, pi, or generic.");
}

function skillScope(value: string): SkillScope {
  if (value === "global" || value === "project") return value;
  throw new Error("--scope must be global or project.");
}

async function readStdinText(maxBytes: number): Promise<string> {
  let value = "";
  for await (const chunk of stdin) {
    value += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`stdin exceeds ${maxBytes} bytes.`);
  }
  return value;
}

async function readStdinSecret(maxBytes: number): Promise<string> {
  const value = await readStdinText(maxBytes);
  return value.replace(/\r?\n$/u, "");
}

function usage(): void {
  stdout.write(cliUsage());
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const jsonMode = process.argv.includes("--json");
  const command = process.argv[2];
  if (jsonMode && command === "network") process.stdout.write(`${JSON.stringify(publicNetworkError(error))}\n`);
  else if (jsonMode && command === "agent") process.stdout.write(`${JSON.stringify(error instanceof KeyBudgetError ? publicKeyBudgetError(error) : publicSkillAccessError(error))}\n`);
  else process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
