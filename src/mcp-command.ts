import { homedir } from "node:os";
import { inspectMcpMetadata, requireMcpAuthorization, setupMcpAuthorization, type McpAuthorization } from "./mcp-authorization.js";
import { installMcpService } from "./service.js";

/**
 * Keep the public device-MCP entry client-neutral. `setup` is implicit when no
 * subcommand is given; every other action must be named explicitly.
 */
export function normalizeMcpArgs(input: readonly string[]): string[] {
  const args = [...input];
  if (args[0] !== "mcp") return args;
  if (args.slice(1).some((arg) => arg === "--help" || arg === "-h") || args[1] === "help") return ["mcp", "help"];
  if (!args[1] || args[1].startsWith("-")) args.splice(1, 0, "setup");
  const action = args[1]!;
  const valueOptions: Record<string, readonly string[]> = {
    setup: ["--workspace", "--days"], renew: ["--workspace", "--days"],
    url: [], revoke: [],
    serve: ["--workspace", "--service-config-home", "--service-credential-store"],
    stdio: ["--workspace"],
  };
  const flags: Record<string, readonly string[]> = {
    url: ["--json"],
    serve: ["--provider-only"],
    "workspace.list": ["--json"],
  };
  if (action === "service") {
    if (!args[2] || !["start", "stop", "uninstall"].includes(args[2])) throw new Error("Use frely mcp service start|stop|uninstall. Inspect status with frely doctor.");
    if (args.length > 3) throw new Error("Unsupported MCP service option. Run frely mcp --help.");
    return args;
  }
  if (action === "workspace") {
    const subaction = args[2];
    if (!subaction || !["add", "list", "remove"].includes(subaction)) {
      throw new Error("Use frely mcp workspace add|list|remove. Run frely mcp --help.");
    }
    if (subaction === "add") {
      if (!args[3]) throw new Error("frely mcp workspace add requires a path argument.");
      if (args.length > 4) throw new Error("Unsupported workspace add option. Run frely mcp --help.");
    } else if (subaction === "list") {
      if (args.length > 3 && !args.slice(3).every((arg) => arg === "--json")) {
        throw new Error("Unsupported workspace list option. Run frely mcp --help.");
      }
    } else if (subaction === "remove") {
      if (!args[3]) throw new Error("frely mcp workspace remove requires a path argument.");
      if (args.length > 4) throw new Error("Unsupported workspace remove option. Run frely mcp --help.");
    }
    return args;
  }
  if (!Object.hasOwn(valueOptions, action)) throw new Error("Unknown device MCP command. Run frely mcp --help.");
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

/** Bootstrap only an unconfigured device; existing grants retain their workspace and lifecycle. */
export async function resolveMcpUrlAuthorization(
  notify: (message: string) => void,
  installService: typeof installMcpService = installMcpService,
): Promise<McpAuthorization> {
  if (await inspectMcpMetadata()) return requireMcpAuthorization();
  const workspace = homedir();
  notify(`No MCP workspace is configured. Setting up your home directory: ${workspace}\n`);
  const authorization = await setupMcpAuthorization(workspace, undefined, false, ({ verificationUri, keyThumbprint, days }) => {
    notify(`Device MCP execution authorization: ${days} days\nMCP key: ${keyThumbprint}\nApprove: ${verificationUri}\n`);
  });
  const service = await installService(authorization.grant.workspace);
  notify(`Background service: ${service.active ? "running" : "installed"}\n`);
  return authorization;
}
