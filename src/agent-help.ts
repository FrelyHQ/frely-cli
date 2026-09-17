import { VERSION } from "./version.js";

export const COMMANDS = [
  { id: "help", usage: "frely help --agent --json", auth: "none", effect: "read", purpose: "Read this installed CLI's current Agent instructions." },
  { id: "key.budget", usage: "frely key budget (--api-key-stdin [--relay <url>]|--distribution <distribution-id>) [--json]", auth: "api-key", effect: "read", purpose: "Read the Key's self usage and each funding source's limits without account login." },
  { id: "skill.install", usage: "frely skill install <manifest-url> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--api-key-stdin] [--json]", auth: "optional-api-key", effect: "local-write", purpose: "Install the public Agent's trigger Skill; an API key goes only through stdin to secure storage." },
  { id: "skill.status", usage: "frely skill status <distribution-id> [--json]", auth: "none", effect: "read", purpose: "Inspect a managed Agent Skill." },
  { id: "skill.remove", usage: "frely skill remove <distribution-id> [--json]", auth: "none", effect: "local-write", purpose: "Remove a managed Agent Skill and its saved API key." },
  { id: "agent.invoke", usage: "frely agent invoke <distribution-id> (--input <text>|--input-stdin) [--json]", auth: "installed-api-key-or-account", effect: "remote-call", purpose: "Send the complete relevant user request to the installed Agent through model-scoped MCP. Usage may be billed." },
  { id: "login", usage: "frely login [--relay <url>] [--no-browser]", auth: "browser", effect: "authorization", purpose: "Authorize the CLI for the user's Frely account." },
  { id: "logout", usage: "frely logout", auth: "none", effect: "local-write", purpose: "Remove login and stop the MCP background service." },
  { id: "whoami", usage: "frely whoami", auth: "account", effect: "read", purpose: "Read the signed-in account." },
  { id: "doctor", usage: "frely doctor [-v] [--json]", auth: "optional-account", effect: "diagnostic", purpose: "Show a quick account, MCP and connection overview; -v runs detailed diagnostics." },
  { id: "provider.share", usage: "frely provider share [ollama|openai-compatible] [--url <loopback-v1-url>] [--models <a,b>] [--slot <slot-id>] [--name <name>]", auth: "account", effect: "remote-write", purpose: "Publish a local model Provider." },
  { id: "provider.list", usage: "frely provider list [--json]", auth: "account", effect: "read", purpose: "List configured local Providers." },
  { id: "provider.finalize", usage: "frely provider finalize <provider-id>", auth: "account", effect: "remote-write", purpose: "Finish a prepared local Provider." },
  { id: "mcp.setup", usage: "frely mcp [setup] [--workspace <path>] [--days 1..180]", auth: "account-and-browser", effect: "authorization", purpose: "Authorize local tool execution and install its background service." },
  { id: "mcp.renew", usage: "frely mcp renew [--days 1..180]", auth: "account-and-browser", effect: "authorization", purpose: "Renew local MCP execution authorization." },
  { id: "mcp.url", usage: "frely mcp url [--json]", auth: "mcp", effect: "read", purpose: "Read this device's MCP URL." },
  { id: "mcp.chatgpt", usage: "frely mcp chatgpt", auth: "mcp", effect: "read", purpose: "Read MCP connection details for ChatGPT." },
  { id: "mcp.serve", usage: "frely mcp serve [--workspace <path>]", auth: "account-and-mcp", effect: "local-execution", purpose: "Serve authorized local workspace tools." },
  { id: "mcp.service", usage: "frely mcp service start|stop|uninstall", auth: "none", effect: "local-service", purpose: "Manage the local MCP background service; use frely doctor to inspect it." },
  { id: "mcp.revoke", usage: "frely mcp revoke", auth: "account", effect: "remote-write", purpose: "Revoke local MCP execution authorization." },
  { id: "mcp.stdio", usage: "frely mcp stdio [--workspace <path>]", auth: "mcp", effect: "local-execution", purpose: "Serve authorized local tools over stdio." },
  { id: "network", usage: "frely network setup|status|find|use|logout [--json]", auth: "network", effect: "subcommand-dependent", purpose: "Access Frely Network using its separate setup and credentials." },
] as const;

export function agentHelp() {
  return {
    schemaVersion: "frely.cli.agent-help.v1",
    cliVersion: VERSION,
    bootstrapVersion: 1,
    skill_update_required: false,
    instructions: [
      "Use this installed CLI's command contract instead of remembered command syntax.",
      "For an installed Agent, pass the user's complete relevant request through stdin to agent.invoke and return its result.",
      "A Skill installed with an API key does not require account login or local MCP execution setup.",
      "Read credentials from a secure input channel; never put them in argv, Skills, ordinary configuration, or logs.",
      "Use --json where the command advertises it. A nonzero exit status means failure; surface the returned error.",
      "A Key amount limit is a spending cap. It reserves no funds and remains subject to its owner's available Plan allowance and Credit.",
      "Budget sources are independent constraints. Do not sum their remaining amounts or describe them as a Key balance.",
      "Installing a remote Agent Skill does not replace the host's current model provider.",
    ],
    commands: COMMANDS,
  };
}

export function cliUsage(): string {
  return "Usage:\n" + COMMANDS.map((command) => "  " + command.usage + "\n").join("");
}
