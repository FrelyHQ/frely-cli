import { VERSION } from "./version.js";

export const COMMANDS = [
  { id: "login", usage: "frely login [--relay <url>] [--no-browser] | frely login --wait | frely login --email <address> [--invite <link>] [--mcp] [--workspace <path>] [--days <n>] then frely login --code <6-digit code>", auth: "browser-or-email", effect: "authorization", purpose: "Authorize the CLI for the user's Frely account. The browser form blocks until the user approves, then returns, so continue the task when it exits; if the command is stopped first, run `frely login --wait` to resume on the same link. With --email, Frely emails a code; the user pastes it into `frely login --code` (enter only the 6 digits; the mail also shows a short reference such as K7, which is only for matching the mail). Add --mcp to also enable device MCP for the workspace (default 90 days) once the code is verified; do this when the user is registering for the first time, and tell them before asking for the code." },
  { id: "logout", usage: "frely logout", auth: "none", effect: "local-write", purpose: "Remove login, revoke Cloud authorization and stop the MCP background service." },
  { id: "uninstall", usage: "frely uninstall [--yes] [--json]", auth: "optional-account", effect: "remote-write", purpose: "Remove Frely from this computer: revoke this device's Device MCP authorization, Cloud and account login on the Frely side, stop and uninstall the background service, delete saved login, device and MCP data, installed Agent Skills and the frely program itself. It lists everything first and removes nothing until the user types yes; without a terminal it only lists, and --yes confirms. Frely App and server-side Providers/Agents are not removed. Refuses to run inside device MCP. Destructive: run only when the user asks for it." },
  { id: "doctor", usage: "frely doctor [-v] [--json]", auth: "optional-account", effect: "diagnostic", purpose: "Show the signed-in account, installation, available updates, MCP and connection status; -v verifies the account online and runs detailed diagnostics." },
  { id: "update", usage: "frely update", auth: "none", effect: "local-write", purpose: "Update the current installation to the latest stable release. Windows prints a manual command; doctor checks versions." },
  { id: "help", usage: "frely help --agent --json", auth: "none", effect: "read", purpose: "Read this installed CLI's current Agent instructions." },
  { id: "link.on", usage: "frely link on [--workspace <path>] [--days 1..365] [--no-browser] [--json]", auth: "account-and-browser-if-needed", effect: "authorization-if-needed", purpose: "Enable, renew, start and read device MCP. Without a stored login it first signs in through the browser (the page also registers new accounts; --no-browser only prints the sign-in URL and device code, which can be approved on any device signed in to Frely); that one approval also enables device MCP, so no second approval link is needed. Unconfigured: request browser approval for --workspace (default: the home directory), install and start the background service. Expired or --days given: renew with browser approval; the MCP URL stays the same. Otherwise start the service if it is not running. With FRELY_INSTALL_TOKEN (the one-time install command from list_devices or the Frely console), it signs in to that account (replacing any stored login) and preapproves device MCP with no browser or prompt. Prompts go to stderr; stdout holds only the URL, or JSON with HTTP transport and OAuth details." },
  { id: "link.workspace.list", usage: "frely link workspace list [--json]", auth: "mcp", effect: "read", purpose: "List workspace directories for this device; the primary is marked." },
  { id: "link.workspace.add", usage: "frely link workspace add [path]", auth: "mcp", effect: "local-write", purpose: "Add an additional workspace directory for this device (default: current directory); takes effect on the running service without restart." },
  { id: "link.workspace.remove", usage: "frely link workspace remove <path>", auth: "mcp", effect: "local-write", purpose: "Remove an additional workspace directory (the primary cannot be removed)." },
  { id: "link.local.list", usage: "frely link local list [--json]", auth: "none", effect: "read", purpose: "List MCP servers on this device that remote clients could use: loopback HTTP servers found automatically plus ones added by hand. Every server is off for remote clients until the owner turns it on in the web console." },
  { id: "link.local.add", usage: "frely link local add <name> --url <http://127.0.0.1:port/path> [--header K=V] | frely link local add <name> [--env K=V] -- <command> [args...]", auth: "none", effect: "local-write", purpose: "Add a local MCP server by loopback URL or by the command that starts it (stdio). It is connected once to check it works; it stays off for remote clients until the owner turns it on in the web console." },
  { id: "link.local.remove", usage: "frely link local remove <name>", auth: "none", effect: "local-write", purpose: "Remove a manually added local MCP server." },
  { id: "link.status", usage: "frely link status [--json]", auth: "none", effect: "read", purpose: "Show the remote-control state (not enabled by default / on / off and locked here), its URL, workspace, authorization expiry and background service state. Makes no network request." },
  { id: "link.stop", usage: "frely link stop", auth: "none", effect: "local-service", purpose: "Stop the local MCP background service without revoking authorization; frely link on resumes it. Supported updates restore running services without this command." },
  { id: "link.auto-update", usage: "frely link auto-update [on|off]", auth: "none", effect: "local-write", purpose: "Show or set whether this device's background service installs new stable versions of its own installation while idle and restarts itself. Off by default; macOS and Linux only." },
  { id: "link.off", usage: "frely link off", auth: "account", effect: "remote-write", purpose: "Turn remote control off and lock it on this computer: revoke the authorization for every connected client, uninstall the background service (kept running provider-only when local Providers exist) and write a local lock. The web page cannot turn it on again; only frely link on here can." },
  { id: "mcp.stdio", usage: "frely mcp stdio [--workspace <path>]", auth: "mcp", effect: "local-execution", purpose: "Serve authorized local tools over stdio for a local MCP client." },
  { id: "mcp.serve", usage: "frely mcp serve [--workspace <path>]", auth: "account-and-mcp", effect: "local-execution", purpose: "Foreground Device Relay client; the background service runs this. Not needed for normal use." },
  { id: "skill.install", usage: "frely skill install [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--dir <project>] [--json]", auth: "none", effect: "local-write", purpose: "Install the `frely` Skill into the host Skill folder. It teaches the agent to sign in, use `frely api`, install marketplace items and Agents, and offer FrelyMCP only when a request needs it. Running it again refreshes the Skill; an edited copy is left alone. Does not enable device MCP." },
  { id: "item.trust", usage: "frely item trust <folder> [--check]", auth: "none", effect: "local-write", purpose: "Remember that the installed files of an item were reviewed, or with --check print trusted / not reviewed (exit 1 when not reviewed). A new version must be reviewed again." },
  { id: "item.run", usage: "frely item run <script> [args...]", auth: "cloud-oauth", effect: "local-execution", purpose: "Run an encrypted paid script of an installed item inside the Frely command sandbox. The placeholder file at the script's path calls this for you. The access lease is renewed when it is near its end; without a valid pass the script does not run." },
  { id: "item.update", usage: "frely item update [<folder>] [--json]", auth: "cloud-oauth", effect: "local-write", purpose: "Without a folder, list the installed marketplace items and say which have a newer version; nothing is changed. With a folder, install the newer version into that folder, after you decide to. Frely never updates an item by itself. A folder you edited is refused, and a new version needs a new review (frely item trust) unless Frely's scan passed for it." },
  { id: "item.install", usage: "frely item install <username/name[@version]> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--dir <path>] [--json]", auth: "cloud-oauth", effect: "local-write", purpose: "Install a download-install Prompt or Skill from the marketplace through Frely Cloud. The paid part is installed only with a valid pass; otherwise the command prints how to buy one. Skills go to the host Skill folder, Prompts to --dir (default: current directory). Scripts are saved without execute permission." },
  { id: "remote.tools", usage: "frely remote tools <username/name> [--json] [--replace]", auth: "cloud-oauth", effect: "remote-read", purpose: "List the tools of a remote MCP product from the marketplace, with their input schemas, without configuring it in an MCP client. The first use asks Frely for a key that works only for this MCP. If the name now belongs to a different MCP than the one connected before, it stops; --replace switches to the new one." },
  { id: "remote.call", usage: "frely remote call <username/name> <tool> [--json '<object>' | --input <file>] [--replace]", auth: "cloud-oauth", effect: "remote-call", purpose: "Call one tool of a remote MCP product and print the result as JSON (exit code 1 when the tool reports an error). Each call is billed or needs a pass exactly as in an MCP client; ask the user before a call that writes data they did not ask for." },
  { id: "remote.config", usage: "frely remote config <username/name> [--write <file>] [--replace]", auth: "cloud-oauth", effect: "remote-write", purpose: "Get a new key for one remote MCP product (it replaces the previous one) and print the mcpServers JSON that MCP clients take for it; with --write the entry is merged into that JSON file (created 0600) instead of printed. The key works only for this MCP." },
  { id: "agent.install", usage: "frely agent install <username/name[@version]> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--dir <project>] [--api-key-stdin] [--json]", auth: "optional-api-key", effect: "local-write", purpose: "Install the public Agent's trigger Skill; an API key goes only through stdin to secure storage." },
  { id: "agent.run", usage: "frely agent run <username/name> (--input <text>|--input-stdin) [--read [<dir>] [--read-max-bytes <n>] [--read-max-rounds <n>]] [--progress-summary|--no-progress-summary] [--json]", auth: "installed-api-key-or-account", effect: "remote-call", purpose: "Send the complete relevant user request to the installed Agent through model-scoped MCP. Usage may be billed. The call runs in a background worker and is recorded on this computer (run id on stderr), so a cut-off command loses nothing: use `frely agent result`. A long call keeps running at Frely and the worker waits for it (reading is free); `frely agent result` shows its newest progress line while it runs. --no-progress-summary asks the Agent not to write progress lines (use it when the user says so, for example in AGENTS.md); without a flag the account setting applies. With --read the Agent may read files of <dir> (default: the git root of the current directory) through read-only tools that run here: only files it asks for leave this computer; .git, .env*, key files, git-ignored and binary files are refused; defaults 1 MiB read and 16 rounds per run; each round is billed, and the result lists filesRead." },
  { id: "agent.result", usage: "frely agent result (<runId>|--last) [--wait] [--resume] [--json]", auth: "none", effect: "read", purpose: "Show a run of `frely agent run` from this computer: running (rounds done, files read so far), completed (the full text) or failed/interrupted. --wait blocks until it ends. --resume continues an interrupted or failed run from the rounds already done; the interrupted round is billed again." },
  { id: "agent.runs", usage: "frely agent runs [--json]", auth: "none", effect: "read", purpose: "List the recent agent runs on this computer (kept 7 days)." },
  { id: "agent.cancel", usage: "frely agent cancel (<runId>|--last) [--json]", auth: "none", effect: "local-process", purpose: "Stop a running agent run; the server stops and settles what was already used (a long call is canceled at Frely too)." },
  { id: "agent.status", usage: "frely agent status (<username/name>|--api-key-stdin [--relay <url>]) [--json]", auth: "none-or-api-key", effect: "read", purpose: "Inspect an installed Agent Skill and, for API-key installs, its Key budget. With --api-key-stdin, read that Key's budget without installing or logging in." },
  { id: "agent.remove", usage: "frely agent remove <username/name> [--json]", auth: "none", effect: "local-write", purpose: "Remove an installed Agent Skill and its saved API key." },
  { id: "agent.local.add", usage: "frely agent local add <username/name | https://github.com/owner/repo> [--name <folder-name>]", auth: "optional-account", effect: "local-write", purpose: "Download an Agent's repository into its own folder under ~/frely-agents and run its setup inside the sandbox. The sandbox can write only that folder, cannot read credential folders and can reach only Frely's API plus the sites the repository lists in frely.yaml, each of which the owner approves once through a link (exit code 3 with the link when nobody can wait; approve, then run the same command again). Needs a frely.yaml with a local.run command." },
  { id: "agent.local.start", usage: "frely agent local start <name> [--foreground]", auth: "account-and-api-key", effect: "local-process", purpose: "Run a local Agent in the background inside the sandbox. Its model calls go through a local proxy that adds the Frely API key (saved with `frely agent local key`), so the repository's code never sees it. Billed to the key like any other API call." },
  { id: "agent.local.stop", usage: "frely agent local stop <name>", auth: "none", effect: "local-process", purpose: "Stop a running local Agent. Run start again afterwards to apply newly approved sites." },
  { id: "agent.local.logs", usage: "frely agent local logs <name> [--lines <n>] [--follow]", auth: "none", effect: "read", purpose: "Show what a local Agent printed, including what the sandbox blocked." },
  { id: "agent.local.list", usage: "frely agent local list [--json]", auth: "none", effect: "read", purpose: "List the Agents on this computer, whether each is running, and the sites each has been approved for." },
  { id: "agent.local.remove", usage: "frely agent local remove <name>", auth: "none", effect: "local-write", purpose: "Stop a local Agent and delete its folder and records. Only the Agent's own folder is removed." },
  { id: "agent.local.key", usage: "frely agent local key --api-key-stdin | --clear", auth: "account", effect: "local-write", purpose: "Save the Frely API key that local Agents use for model calls; it goes only through stdin to secure storage. FRELY_API_KEY overrides it." },
  { id: "provider.share", usage: "frely provider share [ollama|openai-compatible] [--url <loopback-v1-url>] [--models <a,b>] [--slot <slot-id>] [--name <name>]", auth: "account", effect: "remote-write", purpose: "Publish a local model Provider. If a prepared Provider on this device is not finished, resume it instead. Prints this week's remaining relay allowance; relayed traffic counts against the weekly relay allowance." },
  { id: "provider.list", usage: "frely provider list [--json]", auth: "account", effect: "read", purpose: "List configured local Providers." },
  { id: "share", usage: "frely share <port> [--ttl <hours>] [--rewrite-host] [--json]", auth: "account", effect: "remote-write", purpose: "Make a web service on this computer (http://127.0.0.1:<port>) reachable from the Internet by a private link through Frely's relay, until Ctrl+C or expiry (at most 24 hours). Needs the owner's approval in the browser each time (an approval link and code are printed; the command waits and continues by itself). The relay allowance is a plan limit per UTC week; --rewrite-host sends Host: localhost to dev servers that refuse other names. Not the same as `frely provider share` (local models) or `frely tunnel` (command sandbox)." },
  { id: "service.share", usage: "frely service share --type mcp|a2a --port <n> [--label <text>] [--background] [--json]", auth: "account", effect: "remote-write", purpose: "Connect an MCP server or A2A Agent that runs on this computer (127.0.0.1:<port>) to Frely so you can sell it, without a public address: only Frely's own cloud can reach it, the port never leaves this computer, and Frely never supplies a target. Runs until Ctrl+C, or with --background the device background service keeps it connected. Prints this week's remaining relay allowance; relayed traffic counts against the weekly relay allowance." },
  { id: "service.manage", usage: "frely service list [--json] | stop <id|label> | remove <id|label>", auth: "account", effect: "remote-write", purpose: "List registered services, stop one on this computer (it stays registered), or remove it from Frely (products that pointed at it become unreachable)." },
  { id: "tunnel", usage: "frely tunnel <host>:<port> [--local-port N]", auth: "none", effect: "local-execution", purpose: "Run inside a sandboxed command (run_command): listen on 127.0.0.1:<local-port> (default: the same port) and forward each TCP connection to host:port through the command sandbox's proxy, so database and redis clients connect to 127.0.0.1 without turning the sandbox off. Start it in the same command as the client, for example `frely tunnel db.example.com:5432 & sleep 1; psql -h 127.0.0.1 ...`. Prints the local address and runs until killed." },
  { id: "sandbox.proxy", usage: "frely sandbox proxy [<http://host:port> [--no-proxy <list>] | --clear]", auth: "none", effect: "local-write", purpose: "Show, save or remove the HTTP(S) proxy that the command sandbox forwards its network traffic to (your own proxy, for example Clash). Without one saved it uses the HTTPS_PROXY / HTTP_PROXY / ALL_PROXY of the CLI process and, on macOS, the system proxy. Your proxy settings are never changed. Takes effect when the MCP service restarts." },
  { id: "devices", usage: "frely devices [--add] [--json]", auth: "login", effect: "read", purpose: "List your Frely devices with online state and workspaces (list_devices). --add prints a one-time install command for a new computer." },
  { id: "run", usage: "frely run <device> [--cwd <dir>] [--timeout <s>] [--background] -- <command> [--json] [--out <file>]", auth: "login", effect: "remote-execution", purpose: "Run a shell command on a device inside its sandbox and print its output; --background returns a process id. The command's own failure is exit code 2." },
  { id: "ps", usage: "frely ps <device>", auth: "login", effect: "read", purpose: "List background commands on a device." },
  { id: "logs", usage: "frely logs <device> <id> [--follow]", auth: "login", effect: "read", purpose: "Output of a background command; --follow shows it live until it ends." },
  { id: "kill", usage: "frely kill <device> <id>", auth: "login", effect: "remote-execution", purpose: "Stop a background command on a device." },
  { id: "read", usage: "frely read <device>:<path> [--lines a:b] [--json] [--out <file>]", auth: "login", effect: "read", purpose: "Print a file on a device (UTF-8, up to 1 MiB). A Windows drive path such as C:\\x is this computer, not a device." },
  { id: "ls", usage: "frely ls [<device>[:<path>]] [--json]", auth: "login", effect: "read", purpose: "List a folder on a device; with only a device, its workspace roots." },
  { id: "grep", usage: "frely grep <device>:<path> <text> [--regex] [--case] [--max <n>]", auth: "login", effect: "read", purpose: "Search file contents on a device." },
  { id: "edit", usage: "frely edit <device>:<path> (--from <local file> | --patch <json file>) [--overwrite]", auth: "login", effect: "remote-write", purpose: "Write a device file from a local file, or apply line-range edits from a JSON file." },
  { id: "permission", usage: "frely permission request <device> --resource <name> --reason <text> --command <text> | confirm <code> [A|B|C] | wait <short code> [--then '<command>']", auth: "login", effect: "authorization", purpose: "Ask the owner to open what the device sandbox blocks. Exit code 3 prints the approval link and the wait command: show the link to the user, then run `frely permission wait <short code> --then '<original command>'` in the background so the original command runs once they approve." },
  { id: "tools", usage: "frely tools [--json]", auth: "login", effect: "read", purpose: "Print FrelyMCP's own instructions and every tool it offers." },
  { id: "call", usage: "frely call <tool> [--json '<object>' | --input <file>] [--out <file>]", auth: "login", effect: "subcommand-dependent", purpose: "Call any FrelyMCP tool by name (browser, models, web_fetch, local_mcp_call, store, ...)." },
  { id: "api", usage: "frely api list|describe|call [--wait] [--help]", auth: "login", effect: "subcommand-dependent", purpose: "Discover and call your Frely account's business operations (the same tools FrelyMCP offers through frely_list/frely_call). Read-only discovery runs on the account's own login; the first write call asks you to approve this computer in a browser. `list` is grouped and compact (add --json for the full tool list); use describe before call; parameters and results are JSON; --input reads a file up to 512 KiB. When a call needs the owner's approval the error links to it; run the call with --wait (in the foreground, tool timeout of at least 10 minutes) to show the user the link first and then block until they approve on their phone or the web, so the call finishes by itself and you need not be told. Never background or kill it." },
  { id: "app.install", usage: "frely app install [--force] [--json]", auth: "local", effect: "local-write", purpose: "Install the Frely App: Homebrew cask when available, otherwise a verified download (SHA-256) from the FrelyHQ/frely-cli release mirror; quarantine is preserved." },
  { id: "app.open", usage: "frely app open [--window]", auth: "local", effect: "local-write", purpose: "Launch the Frely App in the background (menu bar) or with its main window via --window." },
  { id: "app.status", usage: "frely app status [--json]", auth: "local", effect: "read", purpose: "Show whether the Frely App is installed, its version, install path, running state and how it is managed." },
  { id: "app.update", usage: "frely app update [--json]", auth: "local", effect: "local-write", purpose: "Update the Frely App through Homebrew or by re-downloading the latest release." },
  { id: "app.uninstall", usage: "frely app uninstall", auth: "local", effect: "local-write", purpose: "Uninstall the Frely App. Credentials stay with frely-cli." },
  { id: "computer.enable", usage: "frely computer enable", auth: "local", effect: "local-write", purpose: "Lift the local block set by `frely computer disable` and pre-install the computer-use runtime. Computer use (desktop control by a remote MCP client) is built in and stays off until the owner turns it on for the device on the Frely connections page (passkey or authenticator code required). On macOS the first use asks that Mac for Accessibility and Screen Recording permission." },
  { id: "computer.doctor", usage: "frely computer doctor", auth: "local", effect: "local-execution", purpose: "Check and request the OS permissions computer use needs (macOS Accessibility and Screen Recording; Windows as applicable) by running the installed runtime's doctor. `frely computer enable` runs it automatically, and a computer-use call that fails for missing permission starts it too." },
  { id: "computer.disable", usage: "frely computer disable", auth: "local", effect: "local-write", purpose: "Block computer use on this device at once, whatever the web page says. The web page cannot lift this; only `frely computer enable` does." },
  { id: "computer.status", usage: "frely computer status [--json]", auth: "local", effect: "read", purpose: "Show whether computer use is blocked locally, the runtime version it needs and whether it is installed yet (it installs on first use)." },
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
      "Remote control lets other clients (HTTP MCP clients with OAuth, frely run from another computer, hosted Agents) use this computer. It is not enabled after install; the owner turns it on from the web page after two-step verification, or with frely link on. Commands execute on the device, not on the calling computer.",
      "Use frely link on to enable remote control, start it, or read its MCP address; frely link off turns it off and locks it on this computer (only frely link on there lifts the lock); frely link status and frely doctor [-v] show status and diagnostics.",
      "If MCP is unconfigured or expired, frely link on requests browser approval; otherwise it only ensures the service is running and prints the URL. Existing workspaces stay unchanged.",
      "Remote clients of one device share its workspace and managed processes. Shell uses the device OS account; it is not a workspace sandbox.",
    ],
    commands: COMMANDS,
  };
}

const GROUPS: readonly { title: string; ids: readonly string[] }[] = [
  { title: "Control your devices", ids: ["devices", "run", "ps", "logs", "kill", "read", "ls", "grep", "edit", "permission", "tools", "call"] },
  { title: "Account", ids: ["login", "logout", "uninstall", "doctor", "update"] },
  { title: "Let others control this computer", ids: ["link.on", "link.workspace", "link.local", "link.lifecycle"] },
  { title: "Agents", ids: ["agent.install", "agent.run", "agent.status", "agent.remove", "agent.local"] },
  { title: "Skills", ids: ["skill.install"] },
  { title: "Marketplace items", ids: ["item.install", "item.update", "item.run", "item.trust"] },
  { title: "Providers", ids: ["provider.share", "provider.list"] },
  { title: "Share", ids: ["share", "service.share", "service.manage"] },
  { title: "Command sandbox", ids: ["tunnel", "sandbox.proxy"] },
  { title: "API", ids: ["api", "remote.tools", "remote.call", "remote.config"] },
];

// Short, flag-light forms for the human `--help` overview. The full usage
// strings (with every flag) live on COMMANDS and stay in `frely help --agent
// --json`, which this overview points to for the complete contract. Commands
// meant for services and Agents (mcp serve/stdio, network) appear only there.
const SHORT_USAGE: Readonly<Record<string, string>> = {
  devices: "frely devices [--add]",
  run: "frely run <device> [--cwd <dir>] [--background] -- <command>",
  ps: "frely ps <device>",
  logs: "frely logs <device> <id> [--follow]",
  kill: "frely kill <device> <id>",
  read: "frely read <device>:<path> [--lines a:b]",
  ls: "frely ls [<device>[:<path>]]",
  grep: "frely grep <device>:<path> <text>",
  edit: "frely edit <device>:<path> --from <file>",
  permission: "frely permission request|confirm|wait",
  tools: "frely tools",
  call: "frely call <tool> [--json '<object>']",
  login: "frely login [--no-browser]",
  logout: "frely logout",
  uninstall: "frely uninstall [--yes]",
  doctor: "frely doctor [-v] [--json]",
  update: "frely update",
  "link.on": "frely link on [--workspace <path>] [--days 1..365] [--no-browser] [--json]",
  "link.workspace": "frely link workspace list|add <path>|remove <path>",
  "link.local": "frely link local list|add <name> (--url <address>|-- <command>)|remove <name>",
  "link.lifecycle": "frely link status|stop|off",
  "skill.install": "frely skill install [--host <host>]",
  "item.install": "frely item install <username/name[@version]> [--host <host>]",
  "item.update": "frely item update [<folder>]",
  "item.run": "frely item run <script> [args...]",
  "item.trust": "frely item trust <folder> [--check]",
  "agent.install": "frely agent install <username/name> [--host <host>] [--api-key-stdin]",
  "agent.run": "frely agent run <username/name> (--input <text>|--input-stdin) [--read [<dir>]]",
  "agent.result": "frely agent result (<runId>|--last) [--wait] [--resume]",
  "agent.runs": "frely agent runs",
  "agent.cancel": "frely agent cancel (<runId>|--last)",
  "agent.status": "frely agent status <username/name>",
  "agent.remove": "frely agent remove <username/name>",
  "agent.local": "frely agent local add|start|stop|logs|list|remove|key",
  "agent.local.add": "frely agent local add <username/name | github-url>",
  "agent.local.start": "frely agent local start <name>",
  "agent.local.stop": "frely agent local stop <name>",
  "agent.local.logs": "frely agent local logs <name> [--follow]",
  "agent.local.list": "frely agent local list",
  "agent.local.remove": "frely agent local remove <name>",
  "agent.local.key": "frely agent local key --api-key-stdin",
  "provider.share": "frely provider share [ollama|openai-compatible] [--models <a,b>]",
  "provider.list": "frely provider list",
  share: "frely share <port> [--ttl <hours>]",
  "service.share": "frely service share --type mcp|a2a --port <n>",
  "service.manage": "frely service list|stop|remove",
  tunnel: "frely tunnel <host>:<port> [--local-port N]",
  "sandbox.proxy": "frely sandbox proxy [<url> [--no-proxy <list>] | --clear]",
  api: "frely api list|describe|call",
  "remote.tools": "frely remote tools <username/name> [--json]",
  "remote.call": "frely remote call <username/name> <tool> [--json '<object>']",
  "remote.config": "frely remote config <username/name> [--write <file>]",
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
 * A command group without a direct action (`frely link workspace`, `frely agent`,
 * ...) prints the subcommands under it instead of running one.
 */
export function subcommandUsage(group: string): string {
  const prefix = `${group}.`;
  const lines = COMMANDS.filter((command) => command.id.startsWith(prefix))
    .map((command) => `  ${SHORT_USAGE[command.id] ?? command.usage}\n`);
  return `Usage:\n${lines.join("")}`;
}

export function linkUsage(): string {
  return "Remote control — let others control this computer (MCP clients, frely run from another computer, hosted Agents).\n\nUsage:\n"
    + ["link.on", "link.workspace", "link.local", "link.lifecycle"].map((id) => "  " + SHORT_USAGE[id] + "\n").join("")
    + "\nStatus: frely link status [--json]; diagnostics: frely doctor [-v] [--json]\n\n"
    + "Run frely link on on the computer to control. It asks for browser approval the first time (the home directory, or --workspace) and when authorization has expired, installs and starts the background service, and prints the MCP URL. Add that URL to ChatGPT, Claude Code on another computer, or another HTTP MCP client, then authorize with OAuth.\n"
    + "Prompts go to stderr; stdout contains only the URL or JSON. --days 1..365 renews now; the URL stays the same.\n"
    + "frely link stop only stops the service; frely link off revokes access for every client. Clients share the device workspace and managed processes. Shell runs under the device OS account.\n";
}
