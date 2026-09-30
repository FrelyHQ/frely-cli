import { VERSION } from "./version.js";

export const COMMANDS = [
  { id: "login", usage: "frely login [--relay <url>] [--no-browser]", auth: "browser", effect: "authorization", purpose: "Authorize the CLI for the user's Frely account." },
  { id: "logout", usage: "frely logout", auth: "none", effect: "local-write", purpose: "Remove login, revoke Cloud authorization and stop the MCP background service." },
  { id: "doctor", usage: "frely doctor [-v] [--json]", auth: "optional-account", effect: "diagnostic", purpose: "Show the signed-in account, installation, available upgrades, MCP and connection status; -v verifies the account online and runs detailed diagnostics." },
  { id: "upgrade", usage: "frely upgrade", auth: "none", effect: "local-write", purpose: "Upgrade the current installation to the latest stable release. Windows prints a manual command; doctor checks versions." },
  { id: "help", usage: "frely help --agent --json", auth: "none", effect: "read", purpose: "Read this installed CLI's current Agent instructions." },
  { id: "mcp", usage: "frely mcp [--workspace <path>] [--days 1..180] [--json]", auth: "account-and-browser-if-needed", effect: "authorization-if-needed", purpose: "Enable, renew or read device MCP. Unconfigured: request browser approval for --workspace (default: current directory) and install the background service. Expired or --days given: renew with browser approval; the MCP URL stays the same. Otherwise print the MCP URL unchanged. Prompts go to stderr; stdout holds only the URL, or JSON with HTTP transport and OAuth details." },
  { id: "mcp.workspace", usage: "frely mcp workspace [add|remove <path>] [--json]", auth: "mcp", effect: "subcommand-dependent", purpose: "List workspace directories for this device, or add/remove an additional one (the primary cannot be removed)." },
  { id: "mcp.stop", usage: "frely mcp stop", auth: "none", effect: "local-service", purpose: "Pause the local MCP background service. Supported upgrades restore running services without this command." },
  { id: "mcp.start", usage: "frely mcp start", auth: "none", effect: "local-service", purpose: "Resume the local MCP background service." },
  { id: "mcp.remove", usage: "frely mcp remove", auth: "account", effect: "remote-write", purpose: "Revoke device MCP for every connected client and uninstall the background service (kept running provider-only when local Providers exist)." },
  { id: "mcp.stdio", usage: "frely mcp stdio [--workspace <path>]", auth: "mcp", effect: "local-execution", purpose: "Serve authorized local tools over stdio for a local MCP client." },
  { id: "mcp.serve", usage: "frely mcp serve [--workspace <path>]", auth: "account-and-mcp", effect: "local-execution", purpose: "Foreground Device Relay client; the background service runs this. Not needed for normal use." },
  { id: "agent.install", usage: "frely agent install <distribution-id|manifest-url> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--api-key-stdin] [--json]", auth: "optional-api-key", effect: "local-write", purpose: "Install the public Agent's trigger Skill; an API key goes only through stdin to secure storage." },
  { id: "agent.run", usage: "frely agent run <distribution-id> (--input <text>|--input-stdin) [--json]", auth: "installed-api-key-or-account", effect: "remote-call", purpose: "Send the complete relevant user request to the installed Agent through model-scoped MCP. Usage may be billed." },
  { id: "agent.status", usage: "frely agent status (<distribution-id>|--api-key-stdin [--relay <url>]) [--json]", auth: "none-or-api-key", effect: "read", purpose: "Inspect an installed Agent Skill and, for API-key installs, its Key budget. With --api-key-stdin, read that Key's budget without installing or logging in." },
  { id: "agent.remove", usage: "frely agent remove <distribution-id> [--json]", auth: "none", effect: "local-write", purpose: "Remove an installed Agent Skill and its saved API key." },
  { id: "provider.share", usage: "frely provider share [ollama|openai-compatible] [--url <loopback-v1-url>] [--models <a,b>] [--slot <slot-id>] [--name <name>]", auth: "account", effect: "remote-write", purpose: "Publish a local model Provider. If a prepared Provider on this device is not finished, resume it instead." },
  { id: "provider.list", usage: "frely provider list [--json]", auth: "account", effect: "read", purpose: "List configured local Providers." },
  { id: "cloud", usage: "frely cloud list|describe|call [--help]", auth: "cloud-oauth", effect: "subcommand-dependent", purpose: "Discover and call Frely cloud business operations at frely.cloud/mcp. The first call requests browser authorization. Use describe before call; parameters and results are JSON." },
  { id: "app.remote", usage: "frely app remote enable|disable|status [--json]", auth: "local", effect: "local-write", purpose: "Toggle agent remote control for the Frely web app (app.frely.cloud). Disabled by default; enable before starting tasks from a phone." },
  { id: "app.ops", usage: "frely app ops", auth: "local", effect: "read-only", purpose: "Bridge the local agent ops socket to stdin/stdout (NDJSON, incl. tasks_changed pushes); used by the Frely App GUI task panel." },
  { id: "app.connectInfo", usage: "frely app connect-info [--json]", auth: "local", effect: "read-only", purpose: "Report the local agent ops socket path and whether a serving process is reachable (used by the Frely App GUI to find task control)." },
  { id: "app.key", usage: "frely app key [--lifetime-usd N] [--json]", auth: "user", effect: "account-write", purpose: "Provision a device-scoped Frely API key for app agent tasks (shown once, capped at a lifetime spend limit; default $50, max $500)." },
  { id: "app.tasks", usage: "frely app tasks [--json]", auth: "local", effect: "read", purpose: "List local agent tasks with status, merge state and budget usage." },
  { id: "network", usage: "frely network setup|status|find|use|logout [--json]", auth: "network", effect: "subcommand-dependent", purpose: "Access Frely Network (preview) using its separate setup and credentials." },
] as const;

export function agentHelp() {
  return {
    schemaVersion: "frely.cli.agent-help.v1",
    cliVersion: VERSION,
    bootstrapVersion: 2,
    skill_update_required: false,
    instructions: [
      "Use this installed CLI's command contract instead of remembered command syntax.",
      "For an installed Agent, pass the user's complete relevant request through stdin to agent.run and return its result.",
      "A Skill installed with an API key does not require account login or local MCP execution setup.",
      "Read credentials from a secure input channel; never put them in argv, Skills, ordinary configuration, or logs.",
      "Use --json where the command advertises it. A nonzero exit status means failure; surface the returned error.",
      "A Key amount limit is a spending cap. It reserves no funds and remains subject to its owner's available Plan allowance and Credit.",
      "Budget sources are independent constraints. Do not sum their remaining amounts or describe them as a Key balance.",
      "Installing a remote Agent Skill does not replace the host's current model provider.",
      "Device MCP exposes this computer to remote HTTP MCP clients with OAuth. Commands execute on the device, not on the calling computer.",
      "Use frely mcp to enable device MCP or read its address, and frely doctor [-v] for status and diagnostics.",
      "If MCP is unconfigured or expired, frely mcp requests browser approval; otherwise it only prints the URL. Existing workspaces stay unchanged.",
      "Remote clients of one device share its workspace and managed processes. Shell uses the device OS account; it is not a workspace sandbox.",
    ],
    commands: COMMANDS,
  };
}

const GROUPS: readonly { title: string; ids: readonly string[] }[] = [
  { title: "Account", ids: ["login", "logout", "doctor", "upgrade"] },
  { title: "Device MCP", ids: ["mcp", "mcp.workspace", "mcp.lifecycle"] },
  { title: "Agents", ids: ["agent.install", "agent.run", "agent.status", "agent.remove"] },
  { title: "Providers", ids: ["provider.share", "provider.list"] },
  { title: "Cloud", ids: ["cloud"] },
];

// Short, flag-light forms for the human `--help` overview. The full usage
// strings (with every flag) live on COMMANDS and stay in `frely help --agent
// --json`, which this overview points to for the complete contract. Commands
// meant for services and Agents (mcp serve/stdio, network) appear only there.
const SHORT_USAGE: Readonly<Record<string, string>> = {
  login: "frely login [--no-browser]",
  logout: "frely logout",
  doctor: "frely doctor [-v] [--json]",
  upgrade: "frely upgrade",
  mcp: "frely mcp [--workspace <path>] [--days 1..180] [--json]",
  "mcp.workspace": "frely mcp workspace [add|remove <path>]",
  "mcp.lifecycle": "frely mcp stop|start|remove",
  "agent.install": "frely agent install <distribution-id> [--host <host>] [--api-key-stdin]",
  "agent.run": "frely agent run <distribution-id> (--input <text>|--input-stdin)",
  "agent.status": "frely agent status <distribution-id>",
  "agent.remove": "frely agent remove <distribution-id>",
  "provider.share": "frely provider share [ollama|openai-compatible] [--models <a,b>]",
  "provider.list": "frely provider list",
  cloud: "frely cloud list|describe|call",
};

export function cliUsage(): string {
  const lines = ["Usage: frely <command>\n"];
  for (const group of GROUPS) {
    lines.push(`\n${group.title}:\n`);
    for (const id of group.ids) lines.push(`  ${SHORT_USAGE[id] ?? id}\n`);
  }
  lines.push("\nFull flags and the machine-readable contract: frely help --agent --json\n");
  return lines.join("");
}

export function mcpUsage(): string {
  return "Device MCP — use this computer from a remote MCP client.\n\nUsage:\n"
    + ["mcp", "mcp.workspace", "mcp.lifecycle"].map((id) => "  " + SHORT_USAGE[id] + "\n").join("")
    + "\nStatus and diagnostics: frely doctor [-v] [--json]\n\n"
    + "Run frely mcp on the computer to control. It asks for browser approval the first time (current directory, or --workspace) and when authorization has expired, installs the background service, and prints the MCP URL. Add that URL to ChatGPT, Claude Code on another computer, or another HTTP MCP client, then authorize with OAuth.\n"
    + "Prompts go to stderr; stdout contains only the URL or JSON. --days 1..180 renews now; the URL stays the same.\n"
    + "frely mcp remove revokes access for every client. Clients share the device workspace and managed processes. Shell runs under the device OS account.\n";
}
