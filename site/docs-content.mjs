// SPDX-License-Identifier: Apache-2.0
// Single source for https://cli.frely.cloud/docs. Every answer is derived from README.md and docs/*.md.
// English placeholder copy; translations are handled separately.

const REPO = 'https://github.com/FrelyHQ/frely-cli/blob/main';
const link = (label, href) => ({ label, href });

const install = link('Install page', 'https://cli.frely.cloud/#install');
const app = link('Frely App (My Devices)', 'https://frely.cloud/app/');
const connections = link('Connections page', 'https://frely.cloud/user/account/connections');
const mcpUrl = link('FrelyMCP endpoint', 'https://mcp.frely.cloud/mcp');
const readme = link('README', `${REPO}/README.md`);
const deviceDoc = link('Device MCP doc', `${REPO}/docs/device-mcp.md`);
const credDoc = link('Credential and installation boundaries', `${REPO}/docs/credential-storage.md`);
const apiDoc = link('frely api doc', `${REPO}/docs/api.md`);
const updateDoc = link('Self-update doc', `${REPO}/docs/self-update.md`);
const serviceDoc = link('Service maintenance doc', `${REPO}/docs/service-maintenance.md`);
const security = link('Security policy', `${REPO}/SECURITY.md`);

export const categories = ['Getting started', 'Connecting AI clients', 'Using your computer', 'Account and API', 'Security and limits', 'Maintenance'];

export const entries = [
  {
    slug: 'what-is-frely-cli',
    category: 'Getting started',
    question: 'What is Frely CLI?',
    answer:
      'Frely CLI (the `frely` command) turns a computer you choose into a device that AI agents can work on from anywhere. ChatGPT, Claude, Codex and other MCP clients connect through FrelyMCP and use the files, shell commands and processes in the folders you allow. The computer connects out to Frely, so you open no ports. It is also the command line for your Frely account.',
    links: [link('Home', 'https://cli.frely.cloud/'), readme],
  },
  {
    slug: 'how-do-i-install',
    category: 'Getting started',
    question: 'How do I install Frely CLI?',
    answer:
      'On macOS or Linux run: curl -fsSL https://frely.cloud/start.sh | sh. On Windows run the PowerShell command shown on the install page. The script installs the latest `frely`, then runs `frely mcp start`, which opens the browser to sign in (new accounts can register on the same page), asks you to approve the device and prints your MCP URL. Run it again any time to update.',
    links: [install, link('start.sh', 'https://frely.cloud/start.sh'), link('start.ps1 (Windows)', 'https://frely.cloud/start.ps1')],
  },
  {
    slug: 'install-on-a-server',
    category: 'Getting started',
    question: 'How do I install on a server with no browser?',
    answer:
      'Create a one-time install command in the Frely App under My Devices, Add a computer, Create install command, or ask ChatGPT or Claude (connected to FrelyMCP) to add a computer. Paste the command on the server. It looks like: curl -fsSL https://frely.cloud/start.sh | FRELY_INSTALL_TOKEN=fit_... sh. The token works once, expires after 15 minutes and is not saved. On Linux also run `sudo loginctl enable-linger $USER` so the service stays online after you log out of SSH.',
    links: [app, readme],
  },
  {
    slug: 'install-only',
    category: 'Getting started',
    question: 'How do I install only the program, without the device service?',
    answer:
      'Use https://frely.cloud/install.sh (macOS and Linux) or https://frely.cloud/install.ps1 (Windows). They only install `frely`, which suits scripts, Skills and agents. Or run: npm install --global --ignore-scripts frely-cli@latest (Node.js 22 or newer). The installers check the SHA-256 of the executable and download from GitHub Releases first, then fall back to npmmirror and npmjs.',
    links: [link('install.sh', 'https://frely.cloud/install.sh'), link('install.ps1', 'https://frely.cloud/install.ps1'), readme],
  },
  {
    slug: 'which-workspace-is-shared',
    category: 'Getting started',
    question: 'Which folder does the AI get access to?',
    answer:
      'Your home directory by default; credential and shell start-up files stay protected. Set FRELY_WORKSPACE=/path before installing to share another folder. Afterwards use `frely mcp workspace add <path>` to share more folders, `frely mcp workspace remove <path>` to stop sharing one, and `frely mcp workspace list` to see them all.',
    links: [readme, deviceDoc],
  },
  {
    slug: 'connect-chatgpt-or-claude',
    category: 'Connecting AI clients',
    question: 'How do I connect ChatGPT or Claude to my computer?',
    answer:
      'First run `frely mcp start` on the computer; it prints the MCP URL. FrelyMCP is one address for your whole account: https://mcp.frely.cloud/mcp. In ChatGPT or Claude add a custom connector with that URL, sign in to Frely and approve the client. To check, ask the client to list the top-level names in your workspace.',
    links: [mcpUrl, install, readme],
  },
  {
    slug: 'connect-claude-code-or-codex',
    category: 'Connecting AI clients',
    question: 'How do I connect Claude Code or Codex?',
    answer:
      'Claude Code: claude mcp add --transport http frelymcp "https://mcp.frely.cloud/mcp", then open /mcp in Claude Code to authorize. Codex: codex mcp add frelymcp --url "https://mcp.frely.cloud/mcp". Both use OAuth, so sign in to Frely and approve the client when asked. Any other MCP client that supports remote HTTP MCP with OAuth can use the same URL.',
    links: [mcpUrl, install, readme],
  },
  {
    slug: 'mcp-url',
    category: 'Connecting AI clients',
    question: 'What is my MCP URL, and does it change?',
    answer:
      'The FrelyMCP address is https://mcp.frely.cloud/mcp for every computer on your account. It never changes and contains no secret; clients hold OAuth tokens. Run `frely mcp status` to print the URL, the workspace, the authorization expiry and the service state.',
    links: [mcpUrl, readme],
  },
  {
    slug: 'what-can-the-ai-do',
    category: 'Using your computer',
    question: 'What can the AI do on my computer?',
    answer:
      'Through FrelyMCP the AI can use list_devices (your computers and whether each is online), read (list, read, search and find files in the workspace), edit_file (write whole files or edit lines atomically), process (run shell commands or manage long-running processes) and web_fetch (read public web pages). Device tools take a `device` argument and run on that computer. The AI client\'s own shell still runs where the client runs, so ask it to use the Frely tools for work on your computer.',
    links: [mcpUrl, deviceDoc, readme],
  },
  {
    slug: 'add-another-computer',
    category: 'Using your computer',
    question: 'How do I add another computer?',
    answer:
      'Run the install command on the new computer, or ask ChatGPT or Claude connected to FrelyMCP to add a computer: list_devices returns an install command. You can also create one in the Frely App under My Devices. Every computer where you ran `frely mcp start` appears behind the same MCP URL, and all clients share each computer\'s workspaces and running processes.',
    links: [app, mcpUrl],
  },
  {
    slug: 'local-mcp-servers',
    category: 'Using your computer',
    question: 'How do I let remote AI use an MCP server that runs on my computer?',
    answer:
      'Servers that listen only on loopback are found automatically (`frely mcp local list`). Add others with: frely mcp local add <name> --url http://127.0.0.1:<port>/mcp, or for a stdio server: frely mcp local add <name> -- <command> [args...]. Each server stays hidden from remote clients until you turn it on, one by one, on the Frely connections page. Enabled servers run outside the command sandbox with your user account.',
    links: [connections, readme],
  },
  {
    slug: 'share-local-model',
    category: 'Using your computer',
    question: 'How do I share a local model (Ollama, LM Studio, vLLM)?',
    answer:
      'Run `frely provider share ollama`, or `frely provider share openai-compatible --url http://127.0.0.1:8080/v1 --models model-a,model-b --name "Local GPU"`. This publishes a loopback OpenAI-compatible endpoint as a personal Frely Provider using one empty personal Provider slot. With no empty slot, or with --creator, it creates a Creator Provider counted against your Creator plan. Keep the computer online while it is used and make sure the runtime returns usage. If setup stops halfway, run the same command again. `frely provider list` shows your Providers.',
    links: [app, readme],
  },
  {
    slug: 'install-agents-and-items',
    category: 'Account and API',
    question: 'How do I install a Frely Agent, Prompt or Skill?',
    answer:
      'Agent: frely agent install <distribution-id> --host claude-code --scope global (hosts: chatgpt, codex, claude-code, pi, generic). Run it with: printf \'%s\' \'Your task\' | frely agent run <distribution-id> --input-stdin --json. Marketplace items: frely item install <username/skill-name> --host claude-code. Find the name on the creator profile page (frely.cloud/@<username>) or in the share link the creator sent you; creator items are not listed in the public Store, which shows only products Frely picks. The first call opens a browser for authorization, and a paid part installs only if your account holds a pass; otherwise the command says how to buy one. Frely never overwrites a folder it did not install or a file you edited.',
    links: [app, readme],
  },
  {
    slug: 'manage-account-from-cli',
    category: 'Account and API',
    question: 'How do I manage my Frely account (API keys, credits, plans, orders) from the terminal or an AI?',
    answer:
      'Use `frely api list` to see operations, `frely api describe <name>` to inspect one, and `frely api call <name> --json \'{...}\'` to run it. Examples: frely api call agents.list, frely api call usage.summary. AI clients connected to FrelyMCP reach the same operations through the frely_list and frely_call tools. The first `frely api` command opens a browser for separate OAuth authorization. The operations are served at https://frely.cloud/mcp.',
    links: [apiDoc, link('Frely account API endpoint', 'https://frely.cloud/mcp'), app],
  },
  {
    slug: 'login-and-logout',
    category: 'Account and API',
    question: 'How do I sign in or out?',
    answer:
      '`frely mcp start` signs in when needed, so a separate login is normally unnecessary. Use `frely login` to sign in on its own (add --no-browser on a machine without a browser, or --email <address> then --code <6-digit code>), and `frely logout` to sign out; logout also revokes the `frely api` authorization. To stop controlling the computer remotely, use `frely mcp stop` (pause) or `frely mcp remove` (revoke every client and uninstall the service).',
    links: [readme, app],
  },
  {
    slug: 'authorization-expiry',
    category: 'Account and API',
    question: 'How long does device access last, and how do I renew it?',
    answer:
      'Device MCP access lasts 90 days by default. Run `frely mcp start --days 1..365` to renew early or choose another length. When it expires, requests and queued work stop (finished writes are not undone) and `frely mcp start` asks for approval again. The URL never changes. Manage your computers on the Frely website under My Devices.',
    links: [app, deviceDoc, readme],
  },
  {
    slug: 'is-it-safe',
    category: 'Security and limits',
    question: 'Is it safe to let an AI use my computer?',
    answer:
      'Access is limited to the folders you share. File tools reject symlink escapes and cap reads and writes at 1 MiB. Commands run as your OS user inside an OS sandbox: credential folders are unreadable, writes are limited to the workspace and the temp directory, and network goes through a proxy. If the computer cannot sandbox, commands are refused rather than run unsandboxed. The MCP URL contains no secret, and the CLI keeps its execution key encrypted in the OS credential store. You can revoke access any time with `frely mcp remove`.',
    links: [credDoc, security, readme],
  },
  {
    slug: 'sandbox-and-permissions',
    category: 'Security and limits',
    question: 'A command failed because of the sandbox. What can I do?',
    answer:
      'On the Frely connections page you can open more for a connection: credential folders to read, extra folders to write, or a time-limited run without the sandbox. On Windows, or on Linux without bubblewrap, socat and ripgrep, commands are refused because the computer cannot sandbox; install those tools on Linux. FRELY_SANDBOX=off turns the sandbox off on the device only; use it only when you accept the risk.',
    links: [connections, readme],
  },
  {
    slug: 'doctor',
    category: 'Maintenance',
    question: 'Something does not work. How do I diagnose it?',
    answer:
      'Run `frely doctor` to check sign-in, installation, the latest version, MCP and service state. Add -v for config paths, authorization expiry, last heartbeat and sanitized errors. If the device shows offline, run `frely mcp start`, which is safe to re-run. If the problem remains, ask in Discord or open a GitHub issue with the `frely doctor -v` output.',
    links: [serviceDoc, link('Discord', 'https://discord.gg/hugMuSveb'), link('GitHub issues', 'https://github.com/FrelyHQ/frely-cli/issues')],
  },
  {
    slug: 'update',
    category: 'Maintenance',
    question: 'How do I update Frely CLI?',
    answer:
      'Run `frely update`. It keeps your login, device, URL and workspace, never downgrades, pauses the background service, replaces the program after checking it and restarts the service. On Windows it prints a PowerShell command to run in a local terminal. Re-running https://frely.cloud/start.sh also updates and restarts the service.',
    links: [updateDoc, link('start.sh', 'https://frely.cloud/start.sh')],
  },
  {
    slug: 'uninstall',
    category: 'Maintenance',
    question: 'How do I uninstall Frely CLI?',
    answer:
      'Run `frely uninstall` in a local terminal (not through Device MCP). It lists everything first and removes it after you type yes (--yes for scripts). It revokes this computer\'s access on the Frely side, removes the service, saved login, device identity, settings, caches and the Agent Skills Frely installed, and finally the `frely` program. It keeps the Frely App, your Providers and Agents in your account, the PATH lines the installer added, Skills you edited and marketplace items.',
    links: [readme, app],
  },
  {
    slug: 'commands',
    category: 'Maintenance',
    question: 'Which commands does the CLI have?',
    answer:
      'Main ones: frely mcp start|status|stop|remove, frely mcp workspace list|add|remove, frely mcp local list|add|remove, frely doctor, frely update, frely login, frely logout, frely uninstall, frely agent install|run|status|remove, frely item install|trust, frely provider share|list and frely api list|describe|call. Run any command group without a subcommand (for example `frely mcp`) to see what it offers; `frely help --agent --json` prints the full machine-readable contract.',
    links: [readme],
  },
];

export const entryUrl = (entry) => `/docs/help/${entry.slug}/`;
