# Frely CLI

[![Frely CLI: let agents access your device from any location](site/assets/og.png)](https://cli.frely.cloud/)

[Website](https://cli.frely.cloud/) · [Docs](https://cli.frely.cloud/docs/) · [Frely](https://frely.cloud/) · [English](README.md) · [简体中文](README.zh-CN.md)

Frely CLI (`frely-cli`) gives agents with a shell, such as Claude Code, Codex and pi, the `frely` Skill: your agent uses your Frely account and the Store from the terminal. For web ChatGPT and Claude, and to work on another computer, it connects a computer you choose to **FrelyMCP**, so those clients can use the files, shell commands and processes in the folders you allow. The computer connects out to Frely, so you open no ports.

It is also the command line for your Frely account:

- **Agents, Prompts and Skills**: install a published Frely Agent as a local Skill, or install Prompts and Skills you bought.
- **Device MCP**: let remote AI clients work on this computer.
- **Local MCP servers**: pass MCP servers that only run on this computer (for example on `127.0.0.1`) through to remote clients.
- **Local model sharing**: publish a local Ollama or OpenAI-compatible runtime as your own Frely Provider.

## Install

### Let your agent set it up

Ask an agent that has a shell (Claude Code, Codex, pi) to install the CLI, sign in and install the Skill:

```text
Install Frely CLI and the frely Skill on this computer. On macOS or Linux run curl -fsSL https://frely.cloud/install.sh | sh; on Windows PowerShell run curl.exe -fsSLo "$env:TEMP\frely-install.ps1" https://frely.cloud/install.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\frely-install.ps1". Ask me for my email, run frely login --email <my email>, ask me for the 6-digit code from the email, then run frely login --code <code>. Then run frely skill install --host <your host: claude-code, codex, pi or generic> and read the Skill it installs. Do not run frely link on until I ask for it.
```

The `frely` Skill teaches the agent to use your account and to offer FrelyMCP only when a request needs it. This path does not open this computer to remote clients; `frely link on` does. [More](https://cli.frely.cloud/#skill)

### Install it yourself

`https://frely.cloud/install.sh` and `install.ps1` only install the program, for scripts and agents that need the CLI. Node.js 22 or newer is needed only for npm.

```sh
# macOS / Linux
curl -fsSL https://frely.cloud/install.sh | sh
```

```powershell
# Windows (PowerShell)
curl.exe -fsSLo "$env:TEMP\frely-install.ps1" https://frely.cloud/install.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\frely-install.ps1"
```

Or with npm:

```sh
npm install --global --ignore-scripts frely-cli@latest
```

The installers check the SHA-256 and download from GitHub Releases first, then npmmirror and npmjs. [More](https://cli.frely.cloud/docs/help/install-only/)

Then sign in and install the Skill for your agent host:

```sh
frely login --email <you@example.com>   # then: frely login --code <6-digit code>
frely skill install --host <claude-code|codex|pi|generic>
```

## Common commands

| Command | What it does |
| --- | --- |
| `frely skill install --host <host>` | Install the `frely` Skill for an agent host (`claude-code`, `codex`, `pi` or `generic`). |
| `frely link on` | Sign in if needed, enable Device MCP, start the service and print the MCP URL. Safe to re-run. |
| `frely link status` | Show the MCP URL, workspace, authorization expiry and service state. |
| `frely link workspace add <path>` | Share another folder. `frely link workspace list` shows them all. |
| `frely link stop` / `frely link on` | Pause or resume the background service. |
| `frely link auto-update [on\|off]` | Let the background service update itself while idle (macOS/Linux, off by default). |
| `frely link off` | Revoke access for every client and uninstall the service. |
| `frely doctor` | Check sign-in, installation, service and connection. `-v` for details. |
| `frely update` | Update to the latest version in place. |
| `frely login` / `frely logout` | Sign in or out of your Frely account. `frely login --email <you@example.com>` then `--code <code>` signs in without a browser. |
| `frely sandbox proxy <url>` | Forward the command sandbox's network traffic to your own HTTP(S) proxy. Without it the CLI uses `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` and, on macOS, the system proxy. `--clear` removes it; restart the service to apply. |
| `frely tunnel <host>:<port>` | Inside a sandboxed command: listen on `127.0.0.1` and forward TCP connections to `host:port` through the sandbox, for database and redis clients. `--local-port N` picks the local port. |
| `frely uninstall` | Remove Frely from this computer (lists everything first). |

All commands and options: [command reference](https://cli.frely.cloud/docs/help/commands/). `frely help --agent --json` prints the full machine-readable contract.

## Use with FrelyMCP

Use FrelyMCP from clients with no shell, such as web ChatGPT and Claude, or to work on another computer.

FrelyMCP is one MCP address for your whole account: `https://mcp.frely.cloud/mcp`. Every computer where you ran `frely link on` appears behind it.

### Connect a computer with a browser

```sh
# macOS / Linux
curl -fsSL https://frely.cloud/start.sh | sh
```

```powershell
# Windows (PowerShell)
curl.exe -fsSLo "$env:TEMP\frely-start.ps1" https://frely.cloud/start.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\frely-start.ps1"
```

The script installs the latest `frely`, opens the browser to sign in (new accounts can register there), asks you to approve this device and prints your MCP URL. Run it again any time to update. The workspace is `~/Frely` by default (created for you); set `FRELY_WORKSPACE=/path` to share another folder. When an AI client needs a folder outside it, you can allow that folder on the web. [More](https://cli.frely.cloud/docs/help/how-do-i-install/)

### Connect a server (no browser)

Get a one-time install command on the Frely website (**My Devices → Add a computer → Create install command**), or ask ChatGPT or Claude connected to FrelyMCP to add a computer. Paste it on the server:

```sh
curl -fsSL https://frely.cloud/start.sh | FRELY_INSTALL_TOKEN=fit_... sh
```

It installs `frely`, signs in to your account, enables Device MCP and starts the background service. The token works once and expires after 15 minutes. On Linux, run `sudo loginctl enable-linger $USER` so the service stays online after you log out of SSH. [More](https://cli.frely.cloud/docs/help/install-on-a-server/)

1. On the computer to control, run `frely link on` (the install scripts above already do this).
2. Add the URL to your client as a remote MCP server with OAuth:
   - ChatGPT or Claude: add a custom connector with the URL.
   - Claude Code on another computer: `claude mcp add --transport http frely "https://mcp.frely.cloud/mcp"`, then open `/mcp` to authorize.
3. Sign in to Frely and approve the client.

To check the connection, ask the client to list the top-level names in your workspace.

- **What the AI can do**: `list_devices`, then `read`, `edit_file`, `process` and `web_fetch` on the computer you pick, plus your account through `frely_list` and `frely_call`. [More](https://cli.frely.cloud/docs/help/what-can-the-ai-do/)
- **Local MCP servers**: loopback servers are found automatically (`frely link local list`); each stays hidden until you turn it on in Frely. [More](https://cli.frely.cloud/docs/help/local-mcp-servers/)
- **Authorization**: access lasts 90 days by default; `frely link on --days 1..365` renews early. The URL never changes. [More](https://cli.frely.cloud/docs/help/authorization-expiry/)

## More features

- **Agents on this computer**: `frely agent local add <username/name>` downloads an Agent's repository into its own folder and `frely agent local start <name>` runs it inside the Frely sandbox. It can write only that folder, cannot read your SSH or cloud credentials, and never sees your Frely API key; its model calls go through a local proxy that adds the key. It can reach Frely's API and, after you approve each one once, the sites its `frely.yaml` lists. [Details](docs/agent-local.md)
- **Frely-hosted Agents**: `frely item install <username/name> --host claude-code` installs an Agent as a local Skill; `frely agent run <username/name>` calls it. [More](https://cli.frely.cloud/docs/help/install-agents-and-items/)
- **Marketplace Prompts and Skills**: `frely item install <username/name> --host claude-code` (the same command installs Agents too; add `@3` for version 3). Paid parts install only when your account holds a pass. `frely item update` lists installed items that have a newer version; it changes nothing until you run `frely item update <folder>`. [More](https://cli.frely.cloud/docs/help/install-agents-and-items/)
- **Local model sharing**: `frely provider share ollama` publishes a loopback model server as your personal Frely Provider. [More](https://cli.frely.cloud/docs/help/share-local-model/)
- **Share a local web page**: `frely share 3000` asks first, then prints a private link to `http://127.0.0.1:3000` through Frely's relay until you press Ctrl+C or it expires (at most 24 hours). Relay traffic is a plan allowance per UTC week; direct connections are not counted. Not the same as `frely provider share` (local models) or `frely tunnel` (inside the command sandbox).
- **Your account from the terminal**: `frely api list|describe|call`. [More](https://cli.frely.cloud/docs/help/manage-account-from-cli/)

## Safety

File tools stay inside the shared workspaces and protect credential and shell start-up files. Commands run as your OS user inside an OS sandbox, and are refused where the computer cannot sandbox them. Clients hold OAuth tokens; the CLI keeps its own key in the system credential store. [Is it safe?](https://cli.frely.cloud/docs/help/is-it-safe/) · [Sandbox and permissions](https://cli.frely.cloud/docs/help/sandbox-and-permissions/) · [Credential storage](docs/credential-storage.md)

## Documentation

- Help: [cli.frely.cloud/docs](https://cli.frely.cloud/docs/) ([update](https://cli.frely.cloud/docs/help/update/), [doctor](https://cli.frely.cloud/docs/help/doctor/), [uninstall](https://cli.frely.cloud/docs/help/uninstall/))
- Contracts, for contributors: [Device MCP](docs/device-mcp.md) · [Device Relay transport](docs/device-transport.md) · [MCP OAuth contract](docs/mcp-oauth-relay-contract.md) · [`frely api`](docs/api.md) · [Frely Network (preview)](docs/frely-network.md) · [self-update](docs/self-update.md) · [service maintenance](docs/service-maintenance.md)

## License and trademarks

`frely-cli` is licensed under the Apache License 2.0; see [`LICENSE`](LICENSE). The Frely name, logos and product names are not licensed as trademarks; see [`TRADEMARKS.md`](TRADEMARKS.md). See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development and [`SECURITY.md`](SECURITY.md) to report a vulnerability.
