import { approvalCodeOfLink, formatApprovalCode } from "./approval-code.js";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { attachDeviceCodeMcp, finishDeviceLogin, localDeviceId, loginDevice, readConfig, redeemInstallToken, requireLogin } from "./auth.js";
import { discardForeignMcpAuthorization, generateMcpKey, inspectMcpMetadata, inspectMcpMetadataOrQuarantine, MCP_DEFAULT_DAYS, parseMcpDays, requireMcpAuthorization, setupMcpAuthorization, takeDeviceCodeMcpPreapproval, type McpAuthorization, type McpMetadata, type McpPreset } from "./mcp-authorization.js";
import { installMcpService, serviceStatus, startMcpService } from "./service.js";

/**
 * The controlled-side group is `frely link`: whether this computer accepts remote control, whatever the channel (an MCP client, `frely run`
 * from another computer, a hosted Agent). `link on` is the idempotent enable/start/print-URL action; a bare `frely link` prints the usage.
 * `mcp serve` and `mcp stdio` stay: installed system services and local MCP clients launch them by that name. The Windows update bridge
 * (`mcp service start|stop`, `mcp start --resume`, `mcp stop`) only maps onto the new names so a service stopped by an older CLI's
 * update command still comes back; every other `frely mcp …` command is gone.
 */
export function normalizeLinkArgs(input: readonly string[]): string[] {
  const args = [...input];
  if (args[0] === "mcp") {
    if (args[1] === "service" && args.length === 3 && (args[2] === "start" || args[2] === "stop")) return args[2] === "start" ? ["link", "on", "--resume"] : ["link", "stop"];
    if (args.length === 3 && args[1] === "start" && args[2] === "--resume") return ["link", "on", "--resume"];
    if (args.length === 2 && args[1] === "stop") return ["link", "stop"];
    if (args[1] !== "serve" && args[1] !== "stdio") throw new Error("Unknown command. Controlled-side commands are under frely link; run frely link --help.");
    return checkOptions(args, args[1]);
  }
  if (args[0] !== "link") return args;
  if (args.slice(1).some((arg) => arg === "--help" || arg === "-h") || args[1] === "help") return ["link", "help"];
  if (!args[1]) return ["link", "help"];
  if (!["workspace", "local", "auto-update", "stop", "on", "off", "status"].includes(args[1])) throw new Error("Unknown link command. Run frely link --help.");
  const action = args[1]!;
  if (action === "stop" || action === "off") {
    if (args.length > 2) throw new Error("Unsupported link option. Run frely link --help.");
    return args;
  }
  if (action === "auto-update") {
    if (args.length > 3 || (args[2] !== undefined && args[2] !== "on" && args[2] !== "off")) throw new Error("Usage: frely link auto-update [on|off]");
    return args;
  }
  if (action === "workspace") {
    // A bare `link workspace` has no action of its own; the CLI prints its subcommands.
    const subaction = args[2];
    if (subaction === undefined) return args;
    if (subaction === "list") {
      if (args.length > 4 || (args[3] !== undefined && args[3] !== "--json")) throw new Error("Unsupported workspace list option. Run frely link workspace.");
      return args;
    }
    if (subaction !== "add" && subaction !== "remove") throw new Error("Unknown workspace command. Run frely link workspace.");
    // A bare `workspace add` means the current directory.
    if (subaction === "add" && args.length === 3) return [...args, "."];
    if (!args[3]) throw new Error(`frely link workspace ${subaction} requires a path argument.`);
    if (args.length > 4) throw new Error(`Unsupported workspace ${subaction} option. Run frely link workspace.`);
    return args;
  }
  if (action === "local") {
    // Arguments after `--` belong to the local server's own command line and are not validated here.
    const subaction = args[2];
    if (subaction === undefined) return args;
    if (subaction === "list") {
      if (args.length > 4 || (args[3] !== undefined && args[3] !== "--json")) throw new Error("Unsupported local list option. Run frely link local.");
      return args;
    }
    if (subaction !== "add" && subaction !== "remove") throw new Error("Unknown local MCP command. Run frely link local.");
    if (!args[3]) throw new Error(`frely link local ${subaction} requires a name argument.`);
    return args;
  }
  return checkOptions(args, action);
}

const valueOptions: Record<string, readonly string[]> = {
  on: ["--workspace", "--days"],
  serve: ["--workspace", "--service-config-home", "--service-credential-store"],
  stdio: ["--workspace"],
};
const flagOptions: Record<string, readonly string[]> = {
  on: ["--json", "--resume", "--no-browser"],
  status: ["--json"],
  serve: ["--provider-only"],
};

function checkOptions(args: string[], action: string): string[] {
  const seen = new Set<string>();
  for (let i = 2; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) throw new Error("Duplicate option. Run frely link --help.");
    seen.add(arg);
    if ((valueOptions[action] ?? []).includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("An option is missing its value. Run frely link --help.");
    } else if (!(flagOptions[action] ?? []).includes(arg)) {
      throw new Error("Unsupported option. Run frely link --help.");
    }
  }
  return args;
}

export function grantInactive(metadata: McpMetadata, now = Date.now()): boolean {
  const expiresAt = metadata.grant.expiresAt ? Date.parse(metadata.grant.expiresAt) : NaN;
  return metadata.grant.status !== "active" || !Number.isFinite(expiresAt) || expiresAt <= now;
}

type McpSetupInput = { workspace?: string; days?: string; notify: (message: string) => void; preset?: McpPreset };

async function checkWorkspace(metadata: McpMetadata | null, workspace: string | undefined): Promise<void> {
  if (!metadata || workspace === undefined) return;
  const requested = await realpath(resolve(workspace));
  if (requested !== metadata.grant.workspace) {
    throw new Error(`Device MCP is already enabled for ${metadata.grant.workspace}. Add another directory with frely link workspace add <path>, or run frely link off first to change the primary workspace.`);
  }
}

/**
 * First-time setup or renewal: browser approval, then install and start the background service.
 * All prompts go through `notify` so stdout can carry only the URL or JSON.
 */
export async function setupMcp(
  metadata: McpMetadata | null,
  input: McpSetupInput,
  installService: typeof installMcpService = installMcpService,
): Promise<McpAuthorization> {
  const workspace = metadata?.grant.workspace ?? input.workspace ?? homedir();
  input.notify(metadata ? `Renewing device MCP authorization for ${workspace}\n` : `Enabling device MCP for ${workspace}\n`);
  const authorization = await setupMcpAuthorization(workspace, input.days, Boolean(metadata), ({ verificationUri, keyThumbprint, days }) => {
    input.notify(`Device MCP execution authorization: ${days} days\nMCP key: ${keyThumbprint}\nApprove: ${verificationUri}\n${approvalCodeOfLink(verificationUri) ? `Code: ${approvalCodeOfLink(verificationUri)}\n` : ""}`);
  }, input.preset);
  const service = await installService(authorization.grant.workspace);
  input.notify(`Background service: ${service.active ? "running" : "installed"}\n`);
  return authorization;
}

/**
 * Set up an unconfigured device, renew an expired grant (or when `--days` is given),
 * and otherwise return the existing authorization unchanged.
 */
export async function ensureMcpAuthorization(
  input: McpSetupInput,
  installService: typeof installMcpService = installMcpService,
): Promise<McpAuthorization> {
  const metadata = await discardForeignMcpAuthorization(await inspectMcpMetadataOrQuarantine(input.notify), input.notify);
  await checkWorkspace(metadata, input.workspace);
  if (metadata && !grantInactive(metadata) && input.days === undefined) return requireMcpAuthorization();
  return setupMcp(metadata, input, installService);
}

export interface McpStartDeps {
  installService: typeof installMcpService;
  startService: typeof startMcpService;
  serviceStatus: typeof serviceStatus;
}

/**
 * `frely link on`: configure when unconfigured or expired (or when `--days` is given);
 * otherwise make sure the already-authorized service is running.
 */
export async function startMcp(
  input: McpSetupInput,
  deps: McpStartDeps = { installService: installMcpService, startService: startMcpService, serviceStatus },
): Promise<McpAuthorization> {
  const metadata = await discardForeignMcpAuthorization(await inspectMcpMetadataOrQuarantine(input.notify), input.notify);
  await checkWorkspace(metadata, input.workspace);
  if (!metadata || grantInactive(metadata) || input.days !== undefined) return setupMcp(metadata, input, deps.installService);
  const authorization = await requireMcpAuthorization();
  const status = await deps.serviceStatus();
  if (status.active) input.notify("Background service: already running\n");
  else {
    const service = status.installed ? await deps.startService() : await deps.installService(authorization.grant.workspace);
    input.notify(`Background service: ${service.active ? "running" : "not active"}\n`);
  }
  return authorization;
}

/**
 * Read the pre-login install token and remove it from the environment at once, so the
 * background service and every other child process never inherit it.
 */
export function takeInstallToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.FRELY_INSTALL_TOKEN?.trim();
  delete env.FRELY_INSTALL_TOKEN;
  return value || undefined;
}

export interface McpStartLoginDeps {
  requireLogin: typeof requireLogin;
  loginDevice: typeof loginDevice;
  redeemInstallToken: typeof redeemInstallToken;
  finishDeviceLogin: typeof finishDeviceLogin;
  readConfig: typeof readConfig;
  /** One browser approval for sign-in and device MCP; absent in tests that do not cover it. */
  attachDeviceCodeMcp?: typeof attachDeviceCodeMcp;
  takeDeviceCodeMcpPreapproval?: typeof takeDeviceCodeMcpPreapproval;
}

type McpStartLoginInput = { installToken?: string; workspace?: string; days?: string; notify: (message: string) => void };

/**
 * Sign in for `frely link on` when needed. With an install token the server approves this CLI's own
 * device code and preapproves device MCP: no browser and no prompt. The token is the user's explicit choice
 * of account, so it replaces any existing login; without a token a valid login is kept.
 * Returns the MCP setup overrides that go with a preapproval.
 */
export async function mcpStartLogin(
  input: McpStartLoginInput,
  deps: McpStartLoginDeps = { requireLogin, loginDevice, redeemInstallToken, finishDeviceLogin, readConfig, attachDeviceCodeMcp, takeDeviceCodeMcpPreapproval },
): Promise<{ workspace?: string; days?: string; preset?: McpPreset }> {
  const signedIn = await deps.requireLogin().then((auth) => auth.user, (error: unknown) => {
    if (!(error instanceof Error && /Run `frely login`/u.test(error.message))) throw error;
    return null;
  });
  if (signedIn && !input.installToken) return {};
  // The preapproval is bound to the workspace: keep the one an earlier setup on this computer used.
  const earlier = input.workspace ? null : await inspectMcpMetadata().catch(() => null);
  const workspace = await realpath(resolve(input.workspace || earlier?.grant.workspace || homedir()));
  const days = parseMcpDays(input.days ?? process.env.FRELY_MCP_DAYS ?? MCP_DEFAULT_DAYS);
  const mcp = { ...generateMcpKey(), workspace, days };
  if (!input.installToken) {
    // MCP authorization needs an account: sign in first (the browser page also creates new accounts). The device MCP request is attached
    // to the device code, so approving the code on that page also enables device MCP and no second approval link is needed.
    let attached = false;
    const { user, userCode } = await deps.loginDevice(undefined, ({ verificationUri, userCode }) => {
      input.notify(`Sign in to Frely (new accounts can register on the same page):\n${verificationUri}\nDevice code: ${formatApprovalCode(userCode)}\n`
        + (attached ? `Approving also enables device MCP for ${workspace} (${days} days, key ${mcp.keyThumbprint}).\n` : "") + "Waiting for approval...\n");
    }, deps.attachDeviceCodeMcp ? {
      beforeNotify: async ({ relayUrl, userCode }) => { attached = await deps.attachDeviceCodeMcp!(relayUrl, userCode, { keyThumbprint: mcp.keyThumbprint, workspace, days }); },
    } : {});
    input.notify(`Logged in as ${user.email}.\n`);
    const preapproval = attached && deps.takeDeviceCodeMcpPreapproval ? await deps.takeDeviceCodeMcpPreapproval(userCode).catch(() => null) : null;
    if (!preapproval) return {};
    return { workspace, days: String(days), preset: { privateKeyPem: mcp.privateKeyPem, preapproval } };
  }
  const previous = await deps.readConfig().catch(() => null);
  const redeemed = await deps.redeemInstallToken(undefined, input.installToken, mcp);
  const { user } = await deps.finishDeviceLogin(redeemed.relayUrl, redeemed.device, localDeviceId(previous?.deviceId));
  input.notify(`Signed in to Frely as ${user.email} with the install command.\n`);
  if (previous && previous.user.email !== user.email) input.notify(`This replaces the earlier sign-in of ${previous.user.email} on this computer.\n`);
  if (!redeemed.mcpPreapproval) {
    input.notify("Frely did not preapprove device MCP for this install command; open the approval link below in a browser signed in to Frely.\n");
    return { workspace, days: String(days) };
  }
  return { workspace, days: String(days), preset: { privateKeyPem: mcp.privateKeyPem, preapproval: redeemed.mcpPreapproval } };
}
