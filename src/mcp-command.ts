import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { inspectMcpMetadataOrQuarantine, requireMcpAuthorization, setupMcpAuthorization, type McpAuthorization, type McpMetadata, type McpPreset } from "./mcp-authorization.js";
import { installMcpService, serviceStatus, startMcpService } from "./service.js";

/**
 * Keep the public device-MCP entry client-neutral. `frely mcp start` is the
 * idempotent enable/start/print-URL action (`mcp url` is its deprecated alias); a bare `frely mcp` has no action of its
 * own and prints the usage, and every other action must be named.
 */
export function normalizeMcpArgs(input: readonly string[]): string[] {
  const args = [...input];
  if (args[0] !== "mcp") return args;
  if (args.slice(1).some((arg) => arg === "--help" || arg === "-h") || args[1] === "help") return ["mcp", "help"];
  // Update bridge: Windows update commands printed by 0.7.x run `mcp service stop|start`.
  if (args[1] === "service" && args.length === 3 && (args[2] === "start" || args[2] === "stop")) return args[2] === "start" ? ["mcp", "start", "--resume"] : ["mcp", "stop"];
  if (!args[1]) return ["mcp", "help"];
  // Deprecated alias: `mcp url` is `mcp start`.
  if (args[1] === "url") args[1] = "start";
  if (!["workspace", "local", "stop", "start", "status", "remove", "serve", "stdio"].includes(args[1])) throw new Error("Unknown device MCP command. Run frely mcp --help.");
  const action = args[1]!;
  if (action === "stop" || action === "remove") {
    if (args.length > 2) throw new Error("Unsupported MCP option. Run frely mcp --help.");
    return args;
  }
  if (action === "workspace") {
    // A bare `mcp workspace` has no action of its own; the CLI prints its subcommands.
    const subaction = args[2];
    if (subaction === undefined) return args;
    if (subaction === "list") {
      if (args.length > 4 || (args[3] !== undefined && args[3] !== "--json")) throw new Error("Unsupported workspace list option. Run frely mcp workspace.");
      return args;
    }
    if (subaction !== "add" && subaction !== "remove") throw new Error("Unknown workspace command. Run frely mcp workspace.");
    // A bare `workspace add` means the current directory.
    if (subaction === "add" && args.length === 3) return [...args, "."];
    if (!args[3]) throw new Error(`frely mcp workspace ${subaction} requires a path argument.`);
    if (args.length > 4) throw new Error(`Unsupported workspace ${subaction} option. Run frely mcp workspace.`);
    return args;
  }
  if (action === "local") {
    // Arguments after `--` belong to the local server's own command line and are not validated here.
    const subaction = args[2];
    if (subaction === undefined) return args;
    if (subaction === "list") {
      if (args.length > 4 || (args[3] !== undefined && args[3] !== "--json")) throw new Error("Unsupported local list option. Run frely mcp local.");
      return args;
    }
    if (subaction !== "add" && subaction !== "remove") throw new Error("Unknown local MCP command. Run frely mcp local.");
    if (!args[3]) throw new Error(`frely mcp local ${subaction} requires a name argument.`);
    return args;
  }
  const valueOptions: Record<string, readonly string[]> = {
    start: ["--workspace", "--days"],
    serve: ["--workspace", "--service-config-home", "--service-credential-store"],
    stdio: ["--workspace"],
  };
  const flags: Record<string, readonly string[]> = {
    start: ["--json", "--resume"],
    status: ["--json"],
    serve: ["--provider-only"],
  };
  const seen = new Set<string>();
  for (let i = 2; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) throw new Error("Duplicate MCP option. Run frely mcp --help.");
    seen.add(arg);
    if ((valueOptions[action] ?? []).includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("An MCP option is missing its value. Run frely mcp --help.");
    } else if (!(flags[action] ?? []).includes(arg)) {
      throw new Error("Unsupported MCP option. Run frely mcp --help.");
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
    throw new Error(`Device MCP is already enabled for ${metadata.grant.workspace}. Add another directory with frely mcp workspace add <path>, or run frely mcp remove first to change the primary workspace.`);
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
    input.notify(`Device MCP execution authorization: ${days} days\nMCP key: ${keyThumbprint}\nApprove: ${verificationUri}\n`);
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
  const metadata = await inspectMcpMetadataOrQuarantine(input.notify);
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
 * `frely mcp start`: configure when unconfigured or expired (or when `--days` is given);
 * otherwise make sure the already-authorized service is running.
 */
export async function startMcp(
  input: McpSetupInput,
  deps: McpStartDeps = { installService: installMcpService, startService: startMcpService, serviceStatus },
): Promise<McpAuthorization> {
  const metadata = await inspectMcpMetadataOrQuarantine(input.notify);
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
