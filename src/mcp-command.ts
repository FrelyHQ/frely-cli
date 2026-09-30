import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectMcpMetadataOrQuarantine, requireMcpAuthorization, setupMcpAuthorization, type McpAuthorization, type McpMetadata } from "./mcp-authorization.js";
import { installMcpService } from "./service.js";

/**
 * Keep the public device-MCP entry client-neutral. A bare `frely mcp` is the
 * idempotent entry (internally `setup`); every other action must be named.
 */
export function normalizeMcpArgs(input: readonly string[]): string[] {
  const args = [...input];
  if (args[0] !== "mcp") return args;
  if (args.slice(1).some((arg) => arg === "--help" || arg === "-h") || args[1] === "help") return ["mcp", "help"];
  // Upgrade bridge: Windows upgrade commands printed by 0.7.x run `mcp service stop|start`.
  if (args[1] === "service" && args.length === 3 && (args[2] === "start" || args[2] === "stop")) return ["mcp", args[2]];
  if (!args[1] || args[1].startsWith("-")) args.splice(1, 0, "setup");
  else if (!["workspace", "stop", "start", "remove", "serve", "stdio"].includes(args[1])) throw new Error("Unknown device MCP command. Run frely mcp --help.");
  const action = args[1]!;
  if (action === "stop" || action === "start" || action === "remove") {
    if (args.length > 2) throw new Error("Unsupported MCP option. Run frely mcp --help.");
    return args;
  }
  if (action === "workspace") {
    const subaction = args[2];
    if (subaction === undefined || subaction === "--json") {
      if (args.length > 3 || (subaction !== undefined && subaction !== "--json")) throw new Error("Unsupported workspace option. Run frely mcp --help.");
      return ["mcp", "workspace", "list", ...args.slice(2)];
    }
    if (subaction !== "add" && subaction !== "remove") throw new Error("Use frely mcp workspace [add|remove <path>]. Run frely mcp --help.");
    if (!args[3]) throw new Error(`frely mcp workspace ${subaction} requires a path argument.`);
    if (args.length > 4) throw new Error(`Unsupported workspace ${subaction} option. Run frely mcp --help.`);
    return args;
  }
  const valueOptions: Record<string, readonly string[]> = {
    setup: ["--workspace", "--days"],
    serve: ["--workspace", "--service-config-home", "--service-credential-store"],
    stdio: ["--workspace"],
  };
  const flags: Record<string, readonly string[]> = {
    setup: ["--json"],
    serve: ["--provider-only"],
  };
  const seen = new Set<string>();
  for (let i = 2; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) throw new Error("Duplicate MCP option. Run frely mcp --help.");
    seen.add(arg);
    if (valueOptions[action]!.includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("An MCP option is missing its value. Run frely mcp --help.");
    } else if (!(flags[action] ?? []).includes(arg)) {
      throw new Error("Unsupported MCP option. Run frely mcp --help.");
    }
  }
  return args;
}

function grantInactive(metadata: McpMetadata, now = Date.now()): boolean {
  const expiresAt = metadata.grant.expiresAt ? Date.parse(metadata.grant.expiresAt) : NaN;
  return metadata.grant.status !== "active" || !Number.isFinite(expiresAt) || expiresAt <= now;
}

/**
 * `frely mcp`: set up an unconfigured device, renew an expired grant (or when
 * `--days` is given), and otherwise return the existing authorization unchanged.
 * All prompts go through `notify` so stdout can carry only the URL or JSON.
 */
export async function ensureMcpAuthorization(
  input: { workspace?: string; days?: string; notify: (message: string) => void },
  installService: typeof installMcpService = installMcpService,
): Promise<McpAuthorization> {
  const metadata = await inspectMcpMetadataOrQuarantine(input.notify);
  if (metadata && input.workspace !== undefined) {
    const requested = await realpath(resolve(input.workspace));
    if (requested !== metadata.grant.workspace) {
      throw new Error(`Device MCP is already enabled for ${metadata.grant.workspace}. Add another directory with frely mcp workspace add <path>, or run frely mcp remove first to change the primary workspace.`);
    }
  }
  if (metadata && !grantInactive(metadata) && input.days === undefined) return requireMcpAuthorization();
  const workspace = metadata?.grant.workspace ?? input.workspace ?? process.cwd();
  input.notify(metadata ? `Renewing device MCP authorization for ${workspace}\n` : `Enabling device MCP for ${workspace}\n`);
  const authorization = await setupMcpAuthorization(workspace, input.days, Boolean(metadata), ({ verificationUri, keyThumbprint, days }) => {
    input.notify(`Device MCP execution authorization: ${days} days\nMCP key: ${keyThumbprint}\nApprove: ${verificationUri}\n`);
  });
  const service = await installService(authorization.grant.workspace);
  input.notify(`Background service: ${service.active ? "running" : "installed"}\n`);
  return authorization;
}
