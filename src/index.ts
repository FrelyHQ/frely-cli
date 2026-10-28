#!/usr/bin/env node
import { applyDataDir, activeDataDir } from "./data-dir.js";
import { update } from "./update/update.js";
import { requireMcpAuthorization, inspectMcpMetadata, inspectMcpMetadataOrQuarantine, revokeMcpAuthorization, generateMcpKey, parseMcpDays, MCP_DEFAULT_DAYS } from "./mcp-authorization.js";
import { chmod, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { sshProxyConnect } from "./runtime/ssh-proxy.js";
import { parseTunnelArguments, startTunnel, tunnelUsage } from "./runtime/tunnel.js";
import { runSandboxProxyCommand } from "./runtime/sandbox-proxy.js";
import { runLocalMcpCommand } from "./local-mcp-command.js";
import { readAutoUpdate, writeAutoUpdate } from "./update/auto-update.js";
import { runWorkspaceCommand } from "./workspace-command.js";
import { McpLease } from "./runtime/mcp-lease.js";
import { join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { inspectAuth, loginDevice, logout, normalizeRelayUrl, requireLogin, initEmailDeviceLogin, completeEmailDeviceLogin, savePendingEmailChallenge, readPendingEmailChallenge, deletePendingEmailChallenge, localDeviceId, finishDeviceLogin, readConfig, resumeDeviceLogin } from "./auth.js";
import { basicCredentialStore as credentialStore } from "./credential-basic.js";
import type { EmailDeviceChallenge } from "./auth.js";
import { doctor, formatDoctor } from "./diagnostics.js";
import { ensureDevice } from "./device/control.js";
import { createLocalProviderToken, loadOrCreateDeviceIdentity } from "./device/identity.js";
import { serveDeviceRelay } from "./device/relay-client.js";
import { startStdioMcp } from "./runtime/mcp.js";
import { installDeviceRelayService, serviceStatus, trimServiceLog, startMcpService, stopMcpService, uninstallMcpService } from "./service.js";
import { createLocalModelsHub } from "./provider/local-models.js";
import { shareLocalProvider } from "./provider/share.js";
import { probeLoopback, runShareCommand, shareUsage, spawnFrpcProcess } from "./share/run.js";
import { runServiceCommand, superviseServices } from "./share/service-run.js";
import { accountServiceControl } from "./share/service-control.js";
import { ensureFrpc } from "./share/frpc.js";
import { listLocalServices } from "./share/service-state.js";
import { listLocalProviders } from "./provider/state.js";
import { API_USAGE, logoutCloud, runApi } from "./cloud.js";
import { CONTROLLER_COMMANDS, runControllerCommand } from "./controller/commands.js";
import { controllerLogout, ControllerError } from "./controller/session.js";
import { runAgentLocal } from "./agent/local/command.js";
import { PiNodeSupervisor } from "./agent/pi-node-supervisor.js";
import { readAppInstall } from "./agent/app-install.js";
import { appInstallStatus, installApp, openApp, uninstallApp, updateApp } from "./app-manager.js";
import { detectSandboxBackend } from "./runtime/sandbox.js";
import { LocalMcpHub, loadManualEntries } from "./runtime/local-mcp.js";
import { reportedWorkspaces } from "./runtime/workspace-registry.js";
import { VERSION } from "./version.js";
import { agentHelp, cliUsage, mcpUsage, subcommandUsage } from "./agent-help.js";
import { ensureMcpAuthorization, grantInactive, mcpStartLogin, normalizeMcpArgs, startMcp, takeInstallToken } from "./mcp-command.js";
import { getKeyBudget, KeyBudgetError, publicKeyBudgetError } from "./key-budget.js";
import { runNetwork, publicNetworkError } from "./network.js";
import { runComputerCommand } from "./computer/command.js";
import { runComputerMcpServer } from "./computer/server.js";
import { agentManifestUrl, installSkillAdapter, invokeInstalledAgent, publicSkillAccessError, removeSkillAdapter, resolveAgentTarget, SkillAccessError, skillAdapterStatus } from "./skill/access.js";
import type { SkillHost, SkillScope } from "./skill/managed.js";
import { CloudToolError, installCloudItem, parseItemRef, trustCloudItem } from "./skill/cloud-item.js";
import { checkItemUpdates, updateCloudItem } from "./skill/item-update.js";
import { runSealedScript } from "./skill/sealed-run.js";
import { installEntrySkill } from "./skill/entry.js";
import { callRemoteTool, connectRemoteMcp, installRemoteMcpSkill, isNotASkill, listRemoteTools, mcpClientConfig, parseMcpName, RemoteMcpError } from "./skill/remote-mcp.js";
import { callCloudTool } from "./cloud.js";
import { createInterface } from "node:readline/promises";
import { runUninstall } from "./uninstall.js";


const DEFAULT_EMAIL_LOGIN_MCP_DAYS = MCP_DEFAULT_DAYS;

/** Installs a published Agent as a local trigger Skill, from `username/name[@version]` (or the distribution id older scripts use). */
async function installAgent(target: string, args: string[]): Promise<void> {
  const host = skillHost(option(args, "--host") ?? "generic");
  const scope = skillScope(option(args, "--scope") ?? "global");
  const apiKey = args.includes("--api-key-stdin") ? await readStdinSecret(8192) : undefined;
  const relayUrl = normalizeRelayUrl((await inspectAuth().catch(() => null))?.relayUrl);
  const projectDir = option(args, "--dir");
  const value = await installSkillAdapter({ manifestUrl: agentManifestUrl(target, relayUrl), host, scope, ...(projectDir ? { cwd: resolve(projectDir) } : {}), ...(apiKey ? { apiKey } : {}) });
  if (args.includes("--json")) stdout.write(`${JSON.stringify(value)}\n`);
  else stdout.write(`Agent: ${value.name}\nSkill: ${value.skillPath}\nAuth: ${value.authMode}\nState: ${value.state}\n${value.hostAction ? `Host action: ${value.hostAction}\n` : ""}`);
}

async function main(): Promise<void> {
  const args = normalizeMcpArgs(applyDataDir(process.argv.slice(2)));
  const command = args[0];
  if (command === "update") {
    if (args.length !== 1) throw new Error("Usage: frely update. Version checks are available in frely doctor.");
    const result = await update((message) => process.stderr.write(message));
    stdout.write(result.message + "\n");
    return;
  }
  if (command === "mcp" && args[1] === "help") { stdout.write(mcpUsage()); return; }
  // Internal: ssh's ProxyCommand inside the macOS command sandbox (see sshProxyPrefix in runtime/sandbox.ts). Not listed in help.
  if (command === "ssh-proxy") {
    const port = Number(args[2]);
    const proxyUrl = process.env.HTTP_PROXY ?? process.env.http_proxy;
    if (args.length !== 3 || !args[1] || !Number.isInteger(port) || port < 1 || port > 65535 || !proxyUrl) throw new Error("Usage: frely ssh-proxy <host> <port> (HTTP_PROXY must name the proxy).");
    await sshProxyConnect({ proxyUrl, host: args[1], port, input: process.stdin, output: process.stdout });
    process.exit(0);
  }
  // Run inside the command sandbox: a loopback port that forwards to host:port through the sandbox proxy, for clients that need a raw TCP connection.
  if (command === "tunnel") {
    if (args.length < 2 || args[1] === "help" || args[1] === "--help") { stdout.write(`${tunnelUsage()}\n`); return; }
    const proxyUrl = process.env.HTTP_PROXY ?? process.env.http_proxy;
    if (!proxyUrl) throw new Error("frely tunnel must run inside the Frely command sandbox: HTTP_PROXY does not name the sandbox proxy here.");
    const { host, port, localPort } = parseTunnelArguments(args.slice(1));
    // One failed connection must never take the tunnel down: log a line and keep serving.
    const survive = (error: unknown) => { process.stderr.write(`frely tunnel: ${error instanceof Error ? error.message : String(error)}\n`); };
    process.on("uncaughtException", survive);
    process.on("unhandledRejection", survive);
    const { address } = await startTunnel({ proxyUrl, host, port, localPort, onError: (error) => process.stderr.write(`frely tunnel: ${error.message}\n`) });
    stdout.write(`Tunnel listening on ${address} -> ${host}:${port}. Connect your client to ${address}; stop with Ctrl+C or by killing this process.\n`);
    await new Promise<never>(() => undefined);
  }
  if (command === "sandbox" && args[1] === "proxy") {
    await runSandboxProxyCommand(args.slice(2), (text) => { stdout.write(text); });
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    stdout.write(`${VERSION}\n`);
    return;
  }
  if ((command === "help" || command === "--help") && args.includes("--agent")) {
    stdout.write(JSON.stringify(agentHelp(), null, args.includes("--json") ? undefined : 2) + "\n");
    return;
  }
  if (!command || command === "help" || command === "--help" || command === "-h") return usage();

  if (command !== undefined && CONTROLLER_COMMANDS.has(command)) {
    process.exitCode = await runControllerCommand(args, { out: (text) => { stdout.write(text); }, err: (text) => { process.stderr.write(text); } });
    return;
  }

  if (command === "api") {
    if (args[1] === undefined) { stdout.write(API_USAGE); return; }
    const result = await runApi(args);
    stdout.write(result.text ?? JSON.stringify(result.value, null, 2) + "\n");
    if (result.failed) process.exitCode = 2;
    return;
  }

  if (command === "remote") {
    const action = args[1];
    const ref = args[2];
    if (action !== "tools" && action !== "call" && action !== "config") { stdout.write(subcommandUsage("remote")); return; }
    if (!ref || ref.startsWith("-")) throw new Error(`Usage: frely remote ${action} <username/name>${action === "call" ? " <tool> [--json '<object>' | --input <file>]" : ""}`);
    parseMcpName(ref);
    const deps = { call: callCloudTool };
    try {
      if (action === "tools") {
        const tools = await listRemoteTools(ref, deps);
        if (args.includes("--json")) stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
        else stdout.write(tools.map((tool) => `${tool.name}${tool.description ? `: ${tool.description.replace(/\s+/gu, " ").slice(0, 200)}` : ""}\n`).join(""));
        return;
      }
      if (action === "config") {
        const connection = await connectRemoteMcp(ref, deps);
        const config = mcpClientConfig(connection);
        const file = option(args, "--write");
        if (file === undefined) { stdout.write(`${JSON.stringify(config, null, 2)}\n`); return; }
        await mergeMcpServers(file, config.mcpServers);
        stdout.write(`Wrote ${Object.keys(config.mcpServers)[0]} to ${file}. The file holds a key that works only for ${connection.name}; keep it private.\n`);
        return;
      }
      const tool = args[3];
      if (!tool || tool.startsWith("-")) throw new Error("Usage: frely remote call <username/name> <tool> [--json '<object>' | --input <file>]");
      if (args.includes("--json") && args.includes("--input")) throw new Error("Use --json or --input.");
      const inline = option(args, "--json"), path = option(args, "--input");
      const text = path !== undefined ? await readInputFile(path) : inline ?? "{}";
      let input: unknown;
      try { input = JSON.parse(text); } catch { throw new Error("The tool arguments must be a JSON object."); }
      if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("The tool arguments must be a JSON object.");
      const result = await callRemoteTool(ref, tool, input as Record<string, unknown>, deps);
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if ((result as { isError?: unknown } | null)?.isError === true) process.exitCode = 1;
      return;
    } catch (error) {
      if (error instanceof RemoteMcpError) throw new Error(error.message);
      throw error;
    }
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
    if (action === "local") {
      process.exitCode = await runAgentLocal(args.slice(2), { out: (text) => { stdout.write(text); }, err: (text) => { process.stderr.write(text); }, interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY), readSecret: () => readStdinSecret(8192) });
      return;
    }
    if (action === "install") {
      const target = args[2];
      if (!target || target.startsWith("-")) throw new Error("Usage: frely agent install <username/name[@version]> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--dir <project>] [--api-key-stdin] [--json]");
      await installAgent(target, args);
      return;
    }
    if (action === "run") {
      const target = args[2];
      if (!target || target.startsWith("-")) throw new Error("Usage: frely agent run <username/name> (--input <text>|--input-stdin) [--json]");
      const distributionId = await resolveAgentTarget(target, normalizeRelayUrl((await inspectAuth().catch(() => null))?.relayUrl));
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
      const target = args[2];
      if (!target || target.startsWith("-")) throw new KeyBudgetError("input_invalid", "Usage: frely agent status (<username/name>|--api-key-stdin [--relay <url>]) [--json]");
      const distributionId = await resolveAgentTarget(target, normalizeRelayUrl((await inspectAuth().catch(() => null))?.relayUrl));
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
      const target = args[2];
      if (!target || target.startsWith("-")) throw new Error("Usage: frely agent remove <username/name> [--json]");
      const distributionId = await resolveAgentTarget(target, normalizeRelayUrl((await inspectAuth().catch(() => null))?.relayUrl));
      const value = await removeSkillAdapter(distributionId);
      if (args.includes("--json")) stdout.write(`${JSON.stringify(value)}\n`);
      else stdout.write(value.removed ? "Agent removed.\n" : "Agent was not installed.\n");
      return;
    }
    throw new Error(`Unknown agent command.\n${subcommandUsage("agent")}`);
  }

  if (command === "skill") {
    if (args[1] !== "install") { stdout.write(subcommandUsage("skill")); return; }
    const host = skillHost(option(args, "--host") ?? "generic");
    const scope = skillScope(option(args, "--scope") ?? "global");
    const dir = option(args, "--dir");
    const value = await installEntrySkill({ host, scope, ...(dir ? { dir } : {}) });
    if (args.includes("--json")) { stdout.write(`${JSON.stringify(value)}\n`); return; }
    stdout.write(`Skill: frely\nPath: ${value.path}\nRestart or reload the agent session so it rescans Skills.\n`);
    return;
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
    if (args[1] === "run") {
      const target = args[2];
      if (!target) throw new Error("Usage: frely item run <script> [args...]");
      process.exitCode = await runSealedScript({ target, args: args.slice(3), call: callCloudTool });
      return;
    }
    if (args[1] === "update") {
      const folder = args[2] && !args[2].startsWith("-") ? args[2] : undefined;
      if (folder === undefined) {
        const statuses = await checkItemUpdates({ call: callCloudTool });
        if (args.includes("--json")) { stdout.write(`${JSON.stringify(statuses)}\n`); return; }
        if (statuses.length === 0) { stdout.write("No marketplace items installed.\n"); return; }
        for (const status of statuses) {
          const line = status.state === "available" ? `v${status.installed} installed, v${status.latest} available. To update: frely item update ${status.path}`
            : status.state === "unknown" ? `installed version unknown, v${status.latest} is current. To refresh: frely item update ${status.path}` : `up to date (v${status.latest})`;
          stdout.write(`${status.path}: ${line}\n`);
        }
        return;
      }
      const value = await updateCloudItem({ folder, call: callCloudTool });
      if (args.includes("--json")) { stdout.write(`${JSON.stringify(value)}\n`); return; }
      stdout.write(`${value.kind === "prompt" ? "Prompt" : "Skill"}: ${value.name} (v${value.version})\nPath: ${value.path}\nFiles: ${value.files}\n`);
      if (value.premium === "pass_required") stdout.write("Paid part: not updated. Your access has ended, or this version is newer than your buy-out. Subscribe or buy again, then run this command again.\n");
      if (value.needsReview) stdout.write(`Frely has not scanned this version. Read every file in it, including scripts, before you use it. If it is safe, run: frely item trust ${value.path}\n`);
      if (value.kind === "skill") stdout.write("Restart or reload the agent session so it rescans Skills.\n");
      return;
    }
    if (args[1] !== "install") { stdout.write(subcommandUsage("item")); return; }
    const itemRef = args[2];
    if (!itemRef || itemRef.startsWith("-")) throw new Error("Usage: frely item install <username/name[@version]> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--dir <path>] [--json]");
    // Skills, Prompts and Agents are named alike. An Agent's manifest is public, so it is asked first; a name no Agent has is a Skill or Prompt.
    if (/^creator_distribution_/u.test(itemRef) || args.includes("--api-key-stdin")) { await installAgent(itemRef, args); return; }
    if (!(/^cloud_skill_|^skill_/u.test(itemRef))) {
      const installed = await installAgent(itemRef, args).then(() => true, (error: unknown) => { if (error instanceof SkillAccessError && error.code === "agent_not_found") return false; throw error; });
      if (installed) return;
    }
    const host = skillHost(option(args, "--host") ?? "generic");
    const scope = skillScope(option(args, "--scope") ?? "global");
    const dir = option(args, "--dir");
    const value = await installCloudItem({ ...parseItemRef(itemRef), call: callCloudTool, host, scope, ...(dir ? { dir } : {}) }).catch(async (error: unknown) => {
      // A name that is not a Skill may be a remote MCP: install the Skill that uses it through `frely remote`.
      if (!isNotASkill(error) || itemRef.includes("@") || !/^[^/@]+\/[^/@]+$/u.test(itemRef)) throw error;
      return installRemoteMcpSkill({ ref: itemRef, call: callCloudTool, host, scope, ...(dir ? { dir } : {}) }).catch((mcpError: unknown) => { throw isNotASkill(mcpError) || (mcpError instanceof CloudToolError && mcpError.code === "remote_mcp_not_found") ? error : mcpError; });
    });
    if ("tools" in value) {
      if (args.includes("--json")) { stdout.write(`${JSON.stringify(value)}\n`); return; }
      stdout.write(`MCP: ${value.name}\nPath: ${value.path}\nTools: ${value.tools}\nThe Skill calls this MCP through frely remote; no MCP client configuration is needed. Restart or reload the agent session so it rescans Skills.\n`);
      return;
    }
    if (args.includes("--json")) { stdout.write(`${JSON.stringify(value)}\n`); return; }
    stdout.write(`${value.kind === "prompt" ? "Prompt" : "Skill"}: ${value.name} (v${value.version})\nPath: ${value.path}\nFiles: ${value.files}\n`);
    if (value.premium === "installed") stdout.write("Paid part: installed\n");
    if (value.premium === "pass_required") stdout.write(`Paid part: not installed. Buy a pass in the marketplace or with frely api call passes.buy --json '{"productKind":"cloud_skill","productId":"${value.id}","duration":"monthly"}', then run this command again.\n`);
    if (value.sealedScripts > 0) stdout.write(`${value.sealedScripts} paid script${value.sealedScripts === 1 ? " is" : "s are"} encrypted on this device. They run through frely item run (the placeholder files do that for you) inside the Frely command sandbox, and stop working when your pass ends. Frely cannot show you their source.\n`);
    if (value.hasScripts && value.sealedScripts === 0) stdout.write("This item contains scripts. Read them before you let an agent run them; they were saved without execute permission.\n");
    if (value.scanned) stdout.write("Passed Frely automated scan for this version. This is an automated check, not a guarantee.\n");
    if (value.needsReview) stdout.write(`Frely has not scanned this Skill. Read every file in it, including scripts, before you use it (look for deleting files, reading credentials, unrelated network calls, obfuscated code, or instructions to hide actions from the user). If it is safe, run: frely item trust ${value.path}\n`);
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

    // Picks up a browser login whose process was killed before the owner approved; blocks until approval, so the calling agent continues when it returns.
    if (args.includes("--wait")) {
      stdout.write("Waiting for approval...\n");
      const resumed = await resumeDeviceLogin(relay);
      if (!resumed) {
        stdout.write("No pending browser login, or it expired. Run `frely login --no-browser` for a new link.\n");
        process.exitCode = 1;
        return;
      }
      stdout.write(`Logged in as ${resumed.user.email}.\n`);
      return;
    }

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
          const workspace = await realpath(resolve(option(args, "--workspace") || homedir()));
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
            ...(challenge.reference ? { reference: challenge.reference } : {}),
            ...(mcp ? { deviceMcp: { workspace: mcp.workspace, days: mcp.days } } : {}),
          }, null, 2) + "\n");
        } else {
          stdout.write(`Verification code sent to ${challenge.email}\n`);
          if (challenge.reference) stdout.write(`Mail reference: ${challenge.reference} (use the newest mail with this reference; enter only the 6 digits)\n`);
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
      stdout.write("If this command is stopped before the user approves, run `frely login --wait` to keep waiting on the same link.\n");
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
    // Reconnecting no longer needs the login, so the server-side MCP authorization must go with it.
    const mcpRevoked = await revokeMcpAuthorization().then(() => true, () => false);
    // Cloud credentials are keyed by the signed-in account, so revoke them before removing the login.
    const cloudRevoked = await logoutCloud().then(() => true, () => false);
    const controllerRevoked = await controllerLogout().then(() => true, () => false);
    await logout();
    stdout.write("Frely login removed and MCP background service stopped.\n");
    if (!mcpRevoked) process.stderr.write("MCP authorization revocation was not confirmed; revoke it in Frely account settings if needed.\n");
    if (!cloudRevoked) process.stderr.write("Cloud authorization revocation was not confirmed; revoke it in Frely account settings if needed.\n");
    if (!controllerRevoked) process.stderr.write("The controller authorization was not revoked; disconnect this computer under My Devices on the web.\n");
    return;
  }

  if (command === "uninstall") {
    const interactive = Boolean(stdin.isTTY && stdout.isTTY);
    const prompt = interactive ? async (question: string) => {
      const rl = createInterface({ input: stdin, output: stdout });
      try { return await rl.question(question); } finally { rl.close(); }
    } : undefined;
    process.exitCode = await runUninstall(args.slice(1), { write: (text) => { stdout.write(text); }, interactive, ...(prompt ? { prompt } : {}) });
    return;
  }

  if (command === "share") {
    if (args[1] === undefined || args[1] === "help" || args[1] === "--help") { stdout.write(`Usage: ${shareUsage()}\n`); return; }
    const interactive = Boolean(stdin.isTTY && stdout.isTTY);
    const prompt = interactive ? async (question: string) => {
      const rl = createInterface({ input: stdin, output: stdout });
      try { return await rl.question(question); } finally { rl.close(); }
    } : undefined;
    process.exitCode = await runShareCommand(args.slice(1), { write: (text) => { stdout.write(text); }, interactive, ...(prompt ? { prompt } : {}) });
    return;
  }

  if (command === "service") {
    const controller = new AbortController();
    const onSignal = () => controller.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      process.exitCode = await runServiceCommand(args.slice(1), { write: (text) => { stdout.write(text); } }, {
        control: accountServiceControl, probe: probeLoopback, ensureFrpc: () => ensureFrpc({ log: (text) => { stdout.write(text); } }), spawnFrpc: spawnFrpcProcess, signal: controller.signal,
        installDaemon: async () => { await installDeviceRelayService(); },
      });
    } finally { process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); }
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
    const driver = args[2] ?? "ollama";
    // A prepared Provider resumes without any other option, so the driver is only checked when a new one is prepared.
    if (driver !== "ollama" && driver !== "openai-compatible" && !(await listLocalProviders()).some((provider) => provider.pending)) throw new Error("Provider driver must be `ollama` or `openai-compatible`.");
    const url = option(args, "--url");
    const models = option(args, "--models")?.split(",").map((value) => value.trim()).filter(Boolean);
    const slot = option(args, "--slot");
    const name = option(args, "--name");
    await shareLocalProvider({
      driver: driver === "openai-compatible" ? "openai-compatible" : "ollama",
      ...(url ? { url } : {}), ...(models ? { models } : {}), ...(slot ? { slot } : {}), ...(name ? { name } : {}),
      creator: args.includes("--creator"),
    }, (text) => { stdout.write(text); });
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
  if (command === "computer") {
    if (args[1] === "mcp") { await runComputerMcpServer(); return; }
    stdout.write(await runComputerCommand(args.slice(1)));
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
    if (serviceConfigHome) await trimServiceLog().catch(() => undefined);
    if (serviceCredentialStore) process.env.FRELY_CREDENTIAL_STORE = serviceCredentialStore;
    await requireLogin();
    const providerOnly = args.includes("--provider-only");
    // Without --workspace (a service re-registered by hand, Windows after a reboot) use the workspace the device MCP grant is bound to; a different directory never matches the grant and would leave remote execution disabled.
    const grantWorkspace = providerOnly || option(args, "--workspace") ? undefined : (await inspectMcpMetadata().catch(() => null))?.grant.workspace;
    const workspace = providerOnly ? undefined : resolve(option(args, "--workspace") || grantWorkspace || process.cwd());
    const nodeLog = (message: string) => process.stderr.write(`${message}\n`);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    // Device-local MCP servers are only served with device MCP, never for a provider-only relay.
    // The App's headless Pi Node is supervised here; its thread tools are served as the local MCP "frely-app".
    let localMcp: LocalMcpHub | undefined;
    const piNode = providerOnly ? undefined : new PiNodeSupervisor({ log: nodeLog, onChange: () => { void localMcp?.refresh().catch(() => undefined); } });
    if (!providerOnly) {
      localMcp = new LocalMcpHub({
        log: nodeLog,
        loadManual: async () => {
          const manual = await loadManualEntries();
          const entry = piNode?.localMcpEntry();
          return entry ? [...manual.filter((item) => item.name !== entry.name), entry] : manual;
        },
      });
    }
    localMcp?.start();
    piNode?.start();
    // Services saved with `frely service share --background` stay connected for as long as the daemon runs.
    const services = superviseServices({ signal: controller.signal, log: nodeLog }).catch((error) => nodeLog(`Services stopped: ${error instanceof Error ? error.message : String(error)}`));
    try {
      const capabilities = async () => {
        const install = await readAppInstall().then((value) => value, () => null);
        await localMcp?.ensureFresh(5 * 60_000).catch(() => undefined);
        return {
          app: { ...(install ? { installed: true, version: install.appVersion } : { installed: false }) },
          sandbox: detectSandboxBackend(),
          // The relay sends the Web switch for automatic updates only to a CLI that says it understands it.
          autoUpdate: true,
          workspaces: providerOnly ? [] : await reportedWorkspaces(workspace),
          ...(localMcp ? { localMcp: localMcp.capabilities() } : {}),
        };
      };
      await serveDeviceRelay({ ...(workspace ? { workspace } : {}), ...(localMcp ? { localMcp } : {}), ...(providerOnly ? {} : { localModels: createLocalModelsHub() }), capabilities, managedService: Boolean(serviceConfigHome), restartForUpdate: stop, signal: controller.signal, log: (message) => process.stderr.write(`${message}\n`) });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      controller.abort();
      await services;
      await piNode?.stop(); // the node keeps running; a restarted service adopts it
      await localMcp?.close();
    }
    return;
  }
  if (command === "mcp" && args[1] === "auto-update") {
    if (args[2]) await writeAutoUpdate(args[2] === "on");
    const on = await readAutoUpdate();
    stdout.write(`Automatic updates are ${on ? "on" : "off"}. ${on ? "While idle, the background service installs new stable versions of this installation and restarts itself." : "Run frely mcp auto-update on to let the background service update itself while idle."} Windows still updates manually.\n`);
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
    // Pre-login install command (start.sh / start.ps1): never inherited by the service, logged or stored.
    const installToken = takeInstallToken();
    let workspace = option(args, "--workspace");
    let days = option(args, "--days");
    // --no-browser applies to both the sign-in and the MCP approval page: only the links are printed.
    if (args.includes("--no-browser") || installToken) process.env.FRELY_NO_BROWSER = "1";
    const notify = (message: string) => { process.stderr.write(message); };
    const login = await mcpStartLogin({ ...(installToken ? { installToken } : {}), ...(workspace ? { workspace } : {}), ...(days ? { days } : {}), notify });
    workspace = login.workspace ?? workspace;
    days = login.days ?? days;
    const authorization = await startMcp({ ...(workspace ? { workspace } : {}), ...(days ? { days } : {}), ...(login.preset ? { preset: login.preset } : {}), notify });
    if (login.preset) process.stderr.write("This computer now appears in your FrelyMCP device list (list_devices).\n");
    if (activeDataDir()) process.stderr.write(`No background service with --data-dir. Keep the device online with: frely --data-dir ${activeDataDir()} mcp serve\n`);
    const value = { deviceId: authorization.grant.deviceId, mcpUrl: authorization.mcpUrl, transport: "http", authentication: "oauth", workspace: authorization.grant.workspace, expiresAt: authorization.grant.expiresAt };
    if (args.includes("--json")) stdout.write(`${JSON.stringify(value)}\n`);
    else stdout.write(`${authorization.mcpUrl}\n`);
    return;
  }
  if (command === "mcp" && args[1] === "status") {
    const metadata = await inspectMcpMetadataOrQuarantine((message) => { process.stderr.write(message); });
    const service = await serviceStatus();
    const expired = metadata ? grantInactive(metadata) : false;
    const running = service.detached ? "running (background process, not restarted after reboot)" : "running";
    const value = { configured: Boolean(metadata), service: { installed: service.installed, running: service.active }, ...(metadata ? { mcpUrl: metadata.mcpResource, workspace: metadata.grant.workspace, expiresAt: metadata.grant.expiresAt, expired } : {}) };
    if (args.includes("--json")) stdout.write(`${JSON.stringify(value)}\n`);
    else if (!metadata) stdout.write(`Device MCP is not configured. Run frely mcp start.\nService: ${service.active ? running : service.installed ? "stopped" : "not installed"}\n`);
    else stdout.write(`MCP URL: ${metadata.mcpResource}\nWorkspace: ${metadata.grant.workspace}\nAuthorization: ${expired ? "expired or inactive (run frely mcp start to renew)" : `active until ${metadata.grant.expiresAt}`}\nService: ${service.active ? running : service.installed ? "stopped (run frely mcp start)" : "not installed (run frely mcp start)"}\n`);
    return;
  }
  if (command === "mcp" && args[1] === "stop") { const service = await stopMcpService(); stdout.write(`Frely MCP service ${service.active ? "still active" : "stopped"}.\n`); return; }

  if (command === "mcp" && args[1] === "remove") {
    await revokeMcpAuthorization((message) => { process.stderr.write(message); });
    if ((await listLocalProviders()).length > 0 || (await listLocalServices().catch(() => [])).some((service) => service.background)) {
      await installDeviceRelayService();
      stdout.write("Device MCP removed. The background service keeps running for local Providers and services.\n");
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

async function readInputFile(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 512 * 1024) throw new Error("--input must be a file of at most 512 KiB.");
  return readFile(path, "utf8");
}

/** Adds the entries to the file's `mcpServers`, keeping everything else; the file is created readable only by its owner. */
async function mergeMcpServers(path: string, servers: Record<string, unknown>): Promise<void> {
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    current = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${path} is not a JSON object; left unchanged.`);
  }
  const existing = current.mcpServers !== null && typeof current.mcpServers === "object" && !Array.isArray(current.mcpServers) ? current.mcpServers as Record<string, unknown> : {};
  await writeFile(path, `${JSON.stringify({ ...current, mcpServers: { ...existing, ...servers } }, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
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
  // A managed service writes to a shared log, so startup failures there carry a time.
  else process.stderr.write(`${process.argv.includes("--service-config-home") ? `${new Date().toISOString()} ` : ""}${message}\n`);
  process.exitCode = error instanceof ControllerError ? error.exitCode : 1;
});
