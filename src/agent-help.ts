import { VERSION } from "./version.js";

export const COMMANDS = [
  { id: "login", usage: "frely login [--relay <url>] [--no-browser] | frely login --email <address> [--invite <link>] [--mcp] [--workspace <path>] [--days <n>] then frely login --code <6-digit code>", auth: "browser-or-email", effect: "authorization", purpose: "Authorize the CLI for the user's Frely account. With --email, Frely emails a code; the user pastes it into `frely login --code`. Add --mcp to also enable device MCP for the workspace (default 90 days) once the code is verified; do this when the user is registering for the first time, and tell them before asking for the code." },
  { id: "logout", usage: "frely logout", auth: "none", effect: "local-write", purpose: "Remove login, revoke Cloud authorization and stop the MCP background service." },
  { id: "doctor", usage: "frely doctor [-v] [--json]", auth: "optional-account", effect: "diagnostic", purpose: "Show the signed-in account, installation, available updates, MCP and connection status; -v verifies the account online and runs detailed diagnostics." },
  { id: "update", usage: "frely update", auth: "none", effect: "local-write", purpose: "Update the current installation to the latest stable release. Windows prints a manual command; doctor checks versions." },
  { id: "help", usage: "frely help --agent --json", auth: "none", effect: "read", purpose: "Read this installed CLI's current Agent instructions." },
  { id: "mcp.start", usage: "frely mcp start [--workspace <path>] [--days 1..365] [--json]", auth: "account-and-browser-if-needed", effect: "authorization-if-needed", purpose: "Enable, renew, start and read device MCP. Unconfigured: request browser approval for --workspace (default: the home directory), install and start the background service. Expired or --days given: renew with browser approval; the MCP URL stays the same. Otherwise start the service if it is not running. Prompts go to stderr; stdout holds only the URL, or JSON with HTTP transport and OAuth details. `frely mcp url` is a deprecated alias." },
  { id: "mcp.workspace.list", usage: "frely mcp workspace list [--json]", auth: "mcp", effect: "read", purpose: "List workspace directories for this device; the primary is marked." },
  { id: "mcp.workspace.add", usage: "frely mcp workspace add [path]", auth: "mcp", effect: "local-write", purpose: "Add an additional workspace directory for this device (default: current directory); takes effect on the running service without restart." },
  { id: "mcp.workspace.remove", usage: "frely mcp workspace remove <path>", auth: "mcp", effect: "local-write", purpose: "Remove an additional workspace directory (the primary cannot be removed)." },
  { id: "mcp.local.list", usage: "frely mcp local list [--json]", auth: "none", effect: "read", purpose: "List MCP servers on this device that remote clients could use: loopback HTTP servers found automatically plus ones added by hand. Every server is off for remote clients until the owner turns it on in the web console." },
  { id: "mcp.local.add", usage: "frely mcp local add <name> --url <http://127.0.0.1:port/path> [--header K=V] | frely mcp local add <name> [--env K=V] -- <command> [args...]", auth: "none", effect: "local-write", purpose: "Add a local MCP server by loopback URL or by the command that starts it (stdio). It is connected once to check it works; it stays off for remote clients until the owner turns it on in the web console." },
  { id: "mcp.local.remove", usage: "frely mcp local remove <name>", auth: "none", effect: "local-write", purpose: "Remove a manually added local MCP server." },
  { id: "mcp.status", usage: "frely mcp status [--json]", auth: "none", effect: "read", purpose: "Show whether device MCP is configured, its URL, workspace, authorization expiry and background service state. Makes no network request." },
  { id: "mcp.stop", usage: "frely mcp stop", auth: "none", effect: "local-service", purpose: "Stop the local MCP background service without revoking authorization; frely mcp start resumes it. Supported updates restore running services without this command." },
  { id: "mcp.remove", usage: "frely mcp remove", auth: "account", effect: "remote-write", purpose: "Revoke device MCP for every connected client and uninstall the background service (kept running provider-only when local Providers exist)." },
  { id: "mcp.stdio", usage: "frely mcp stdio [--workspace <path>]", auth: "mcp", effect: "local-execution", purpose: "Serve authorized local tools over stdio for a local MCP client." },
  { id: "mcp.serve", usage: "frely mcp serve [--workspace <path>]", auth: "account-and-mcp", effect: "local-execution", purpose: "Foreground Device Relay client; the background service runs this. Not needed for normal use." },
  { id: "item.trust", usage: "frely item trust <folder> [--check]", auth: "none", effect: "local-write", purpose: "Remember that the installed files of an item were reviewed, or with --check print trusted / not reviewed (exit 1 when not reviewed). A new version must be reviewed again." },
  { id: "item.install", usage: "frely item install <item-id> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--dir <path>] [--json]", auth: "cloud-oauth", effect: "local-write", purpose: "Install a download-install Prompt or Skill from the marketplace through Frely Cloud. The paid part is installed only with a valid pass; otherwise the command prints how to buy one. Skills go to the host Skill folder, Prompts to --dir (default: current directory). Scripts are saved without execute permission." },
  { id: "agent.install", usage: "frely agent install <distribution-id|manifest-url> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--api-key-stdin] [--json]", auth: "optional-api-key", effect: "local-write", purpose: "Install the public Agent's trigger Skill; an API key goes only through stdin to secure storage." },
  { id: "agent.run", usage: "frely agent run <distribution-id> (--input <text>|--input-stdin) [--json]", auth: "installed-api-key-or-account", effect: "remote-call", purpose: "Send the complete relevant user request to the installed Agent through model-scoped MCP. Usage may be billed." },
  { id: "agent.status", usage: "frely agent status (<distribution-id>|--api-key-stdin [--relay <url>]) [--json]", auth: "none-or-api-key", effect: "read", purpose: "Inspect an installed Agent Skill and, for API-key installs, its Key budget. With --api-key-stdin, read that Key's budget without installing or logging in." },
  { id: "agent.remove", usage: "frely agent remove <distribution-id> [--json]", auth: "none", effect: "local-write", purpose: "Remove an installed Agent Skill and its saved API key." },
  { id: "provider.share", usage: "frely provider share [ollama|openai-compatible] [--url <loopback-v1-url>] [--models <a,b>] [--slot <slot-id>] [--name <name>]", auth: "account", effect: "remote-write", purpose: "Publish a local model Provider. If a prepared Provider on this device is not finished, resume it instead." },
  { id: "provider.list", usage: "frely provider list [--json]", auth: "account", effect: "read", purpose: "List configured local Providers." },
  { id: "cloud", usage: "frely cloud list|describe|call [--help]", auth: "cloud-oauth", effect: "subcommand-dependent", purpose: "Discover and call Frely cloud business operations at frely.cloud/mcp. The first call requests browser authorization. Use describe before call; parameters and results are JSON." },
  { id: "app.remote.enable", usage: "frely app remote enable", auth: "local", effect: "local-write", purpose: "Allow agent remote control from the Frely web app (app.frely.cloud). Disabled by default; enable before starting tasks from a phone." },
  { id: "app.remote.disable", usage: "frely app remote disable", auth: "local", effect: "local-write", purpose: "Disallow agent remote control from the Frely web app." },
  { id: "app.remote.status", usage: "frely app remote status [--json]", auth: "local", effect: "read", purpose: "Show whether agent remote control is enabled and the task budget limits." },
  { id: "app.ops", usage: "frely app ops", auth: "local", effect: "read-only", purpose: "Bridge the local agent ops socket to stdin/stdout (NDJSON, incl. tasks_changed pushes); used by the Frely App GUI task panel." },
  { id: "app.connectInfo", usage: "frely app connect-info [--json]", auth: "local", effect: "read-only", purpose: "Report the local agent ops socket path and whether a serving process is reachable (used by the Frely App GUI to find task control)." },
  { id: "app.key", usage: "frely app key [--lifetime-usd N] [--json]", auth: "user", effect: "account-write", purpose: "Provision a device-scoped Frely API key for app agent tasks (shown once, capped at a lifetime spend limit; default $50, max $500)." },
  { id: "app.tasks", usage: "frely app tasks [--json]", auth: "local", effect: "read", purpose: "List local agent tasks with status, merge state and budget usage." },
  { id: "app.install", usage: "frely app install [--force] [--json]", auth: "local", effect: "local-write", purpose: "Install the Frely App: Homebrew cask when available, otherwise a verified download (SHA-256) from the FrelyHQ/frely-cli release mirror; quarantine is preserved." },
  { id: "app.open", usage: "frely app open [--window]", auth: "local", effect: "local-write", purpose: "Launch the Frely App in the background (menu bar) or with its main window via --window." },
  { id: "app.status", usage: "frely app status [--json]", auth: "local", effect: "read", purpose: "Show whether the Frely App is installed, its version, install path, running state and how it is managed." },
  { id: "app.update", usage: "frely app update [--json]", auth: "local", effect: "local-write", purpose: "Update the Frely App through Homebrew or by re-downloading the latest release." },
  { id: "app.uninstall", usage: "frely app uninstall", auth: "local", effect: "local-write", purpose: "Uninstall the Frely App. Tasks, credentials and worktrees stay with frely-cli." },
  { id: "computer.enable", usage: "frely computer enable", auth: "local", effect: "local-write", purpose: "Register computer use (desktop control by a remote MCP client) as the local MCP \"computer\" on this device. Run it only on a device you are sitting at. It still has to be turned on for remote clients on the Frely connections page; registering alone never exposes it." },
  { id: "computer.disable", usage: "frely computer disable", auth: "local", effect: "local-write", purpose: "Remove the local MCP \"computer\" so computer use stops working on this device at once, whatever the web page says." },
  { id: "computer.status", usage: "frely computer status [--json]", auth: "local", effect: "read", purpose: "Show whether computer use is registered locally, the runtime version it needs and whether it is installed." },
  { id: "computer.mcp", usage: "frely computer mcp", auth: "local", effect: "local-execution", purpose: "Stdio MCP server for computer use; local MCP forwarding starts it. Not needed for normal use." },
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
      "Use frely mcp start to enable device MCP, start it, or read its address; frely mcp status and frely doctor [-v] show status and diagnostics.",
      "If MCP is unconfigured or expired, frely mcp start requests browser approval; otherwise it only ensures the service is running and prints the URL. Existing workspaces stay unchanged.",
      "Remote clients of one device share its workspace and managed processes. Shell uses the device OS account; it is not a workspace sandbox.",
    ],
    commands: COMMANDS,
  };
}

const GROUPS: readonly { title: string; ids: readonly string[] }[] = [
  { title: "Account", ids: ["login", "logout", "doctor", "update"] },
  { title: "Device MCP", ids: ["mcp.start", "mcp.workspace", "mcp.local", "mcp.lifecycle"] },
  { title: "Agents", ids: ["agent.install", "agent.run", "agent.status", "agent.remove"] },
  { title: "Marketplace items", ids: ["item.install", "item.trust"] },
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
  update: "frely update",
  "mcp.start": "frely mcp start [--workspace <path>] [--days 1..365] [--json]",
  "mcp.workspace": "frely mcp workspace list|add <path>|remove <path>",
  "mcp.local": "frely mcp local list|add <name> (--url <address>|-- <command>)|remove <name>",
  "mcp.lifecycle": "frely mcp status|stop|remove",
  "item.install": "frely item install <item-id> [--host <host>]",
  "item.trust": "frely item trust <folder> [--check]",
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

/**
 * A command group without a direct action (`frely mcp workspace`, `frely agent`,
 * ...) prints the subcommands under it instead of running one.
 */
export function subcommandUsage(group: string): string {
  const prefix = `${group}.`;
  const lines = COMMANDS.filter((command) => command.id.startsWith(prefix))
    .map((command) => `  ${SHORT_USAGE[command.id] ?? command.usage}\n`);
  return `Usage:\n${lines.join("")}`;
}

export function mcpUsage(): string {
  return "Device MCP — use this computer from a remote MCP client.\n\nUsage:\n"
    + ["mcp.start", "mcp.workspace", "mcp.local", "mcp.lifecycle"].map((id) => "  " + SHORT_USAGE[id] + "\n").join("")
    + "\nStatus: frely mcp status [--json]; diagnostics: frely doctor [-v] [--json]\n\n"
    + "Run frely mcp start on the computer to control. It asks for browser approval the first time (the home directory, or --workspace) and when authorization has expired, installs and starts the background service, and prints the MCP URL. Add that URL to ChatGPT, Claude Code on another computer, or another HTTP MCP client, then authorize with OAuth.\n"
    + "Prompts go to stderr; stdout contains only the URL or JSON. --days 1..365 renews now; the URL stays the same.\n"
    + "frely mcp stop only stops the service; frely mcp remove revokes access for every client. Clients share the device workspace and managed processes. Shell runs under the device OS account.\n";
}
