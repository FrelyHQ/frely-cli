# Frely CLI

[![Frely CLI: let agents access your device from any location](site/assets/og.png)](https://cli.frely.cloud/)

[Website](https://cli.frely.cloud/) · [Docs](https://cli.frely.cloud/docs/) · [Frely](https://frely.cloud/) · [English](README.md) · [简体中文](README.zh-CN.md)

Frely CLI (`frely-cli`) connects a computer you choose to **FrelyMCP**, so ChatGPT, Claude, Codex and other MCP clients can work on it from anywhere. They use the files, shell commands and processes in the folders you allow. The computer connects out to Frely, so you open no ports.

It is also the command line for your Frely account:

- **Device MCP**: let remote AI clients work on this computer.
- **Local MCP servers**: pass MCP servers that only run on this computer (for example on `127.0.0.1`) through to remote clients.
- **Agents, Prompts and Skills**: install a published Frely Agent as a local Skill, or install Prompts and Skills you bought.
- **Local model sharing**: publish a local Ollama or OpenAI-compatible runtime as your own Frely Provider.

## Install

### A server, with a Frely account (no browser)

Get a one-time install command on the Frely website (**My Devices → Add a computer → Create install command**), or ask ChatGPT or Claude connected to FrelyMCP to add a computer. Paste it on the server:

```sh
curl -fsSL https://frely.cloud/start.sh | FRELY_INSTALL_TOKEN=fit_... sh
```

It installs `frely`, signs in to your account, enables Device MCP and starts the background service. The token works once and expires after 15 minutes. On Linux, run `sudo loginctl enable-linger $USER` so the service stays online after you log out of SSH. [More](https://cli.frely.cloud/docs/help/install-on-a-server/)

### A computer with a browser

```sh
# macOS / Linux
curl -fsSL https://frely.cloud/start.sh | sh
```

```powershell
# Windows (PowerShell)
curl.exe -fsSLo "$env:TEMP\frely-start.ps1" https://frely.cloud/start.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\frely-start.ps1"
```

The script installs the latest `frely`, opens the browser to sign in (new accounts can register there), asks you to approve this device and prints your MCP URL. Run it again any time to update. The workspace is your home directory by default; set `FRELY_WORKSPACE=/path` to share another folder. [More](https://cli.frely.cloud/docs/help/how-do-i-install/)

### Let your agent set it up

Ask an agent that has a shell (Claude Code, Codex, pi) to install the CLI, sign in with `frely login --email`, and run `frely skill install --host <host>`. The `frely` Skill teaches the agent to use your account and to offer FrelyMCP only when a request needs it. This path does not open this computer to remote clients; `frely mcp start` does.

### Install only

`https://frely.cloud/install.sh` and `install.ps1` only install the program, for scripts and agents that need the CLI. Or use npm (Node.js 22 or newer):

```sh
npm install --global --ignore-scripts frely-cli@latest
```

The installers check the SHA-256 and download from GitHub Releases first, then npmmirror and npmjs. [More](https://cli.frely.cloud/docs/help/install-only/)

## Common commands

| Command | What it does |
| --- | --- |
| `frely mcp start` | Sign in if needed, enable Device MCP, start the service and print the MCP URL. Safe to re-run. |
| `frely mcp status` | Show the MCP URL, workspace, authorization expiry and service state. |
| `frely mcp workspace add <path>` | Share another folder. `frely mcp workspace list` shows them all. |
| `frely mcp stop` / `frely mcp start` | Pause or resume the background service. |
| `frely mcp remove` | Revoke access for every client and uninstall the service. |
| `frely doctor` | Check sign-in, installation, service and connection. `-v` for details. |
| `frely update` | Update to the latest version in place. |
| `frely login` / `frely logout` | Sign in or out of your Frely account. |
| `frely sandbox proxy <url>` | Forward the command sandbox's network traffic to your own HTTP(S) proxy. Without it the CLI uses `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` and, on macOS, the system proxy. `--clear` removes it; restart the service to apply. |
| `frely tunnel <host>:<port>` | Inside a sandboxed command: listen on `127.0.0.1` and forward TCP connections to `host:port` through the sandbox, for database and redis clients. `--local-port N` picks the local port. |
| `frely uninstall` | Remove Frely from this computer (lists everything first). |

All commands and options: [command reference](https://cli.frely.cloud/docs/help/commands/). `frely help --agent --json` prints the full machine-readable contract.

## Use with FrelyMCP

FrelyMCP is one MCP address for your whole account: `https://mcp.frely.cloud/mcp`. Every computer where you ran `frely mcp start` appears behind it.

1. On the computer to control, run `frely mcp start` (the install scripts above already do this).
2. Add the URL to your client as a remote MCP server with OAuth:
   - ChatGPT or Claude: add a custom connector with the URL.
   - Claude Code on another computer: `claude mcp add --transport http frely "https://mcp.frely.cloud/mcp"`, then open `/mcp` to authorize.
3. Sign in to Frely and approve the client.

To check the connection, ask the client to list the top-level names in your workspace.

- **What the AI can do**: `list_devices`, then `read`, `edit_file`, `process` and `web_fetch` on the computer you pick, plus your account through `frely_list` and `frely_call`. [More](https://cli.frely.cloud/docs/help/what-can-the-ai-do/)
- **Local MCP servers**: loopback servers are found automatically (`frely mcp local list`); each stays hidden until you turn it on in Frely. [More](https://cli.frely.cloud/docs/help/local-mcp-servers/)
- **Authorization**: access lasts 90 days by default; `frely mcp start --days 1..365` renews early. The URL never changes. [More](https://cli.frely.cloud/docs/help/authorization-expiry/)

## More features

- **Frely-hosted Agents**: `frely agent install <distribution-id> --host claude-code` installs an Agent as a local Skill; `frely agent run` calls it. [More](https://cli.frely.cloud/docs/help/install-agents-and-items/)
- **Marketplace Prompts and Skills**: `frely item install <item-id> --host claude-code`. Paid parts install only when your account holds a pass. [More](https://cli.frely.cloud/docs/help/install-agents-and-items/)
- **Local model sharing**: `frely provider share ollama` publishes a loopback model server as your personal Frely Provider. [More](https://cli.frely.cloud/docs/help/share-local-model/)
- **Your account from the terminal**: `frely api list|describe|call`. [More](https://cli.frely.cloud/docs/help/manage-account-from-cli/)

## Safety

File tools stay inside the shared workspaces and protect credential and shell start-up files. Commands run as your OS user inside an OS sandbox, and are refused where the computer cannot sandbox them. Clients hold OAuth tokens; the CLI keeps its own key in the system credential store. [Is it safe?](https://cli.frely.cloud/docs/help/is-it-safe/) · [Sandbox and permissions](https://cli.frely.cloud/docs/help/sandbox-and-permissions/) · [Credential storage](docs/credential-storage.md)

## Documentation

- Help: [cli.frely.cloud/docs](https://cli.frely.cloud/docs/) ([update](https://cli.frely.cloud/docs/help/update/), [doctor](https://cli.frely.cloud/docs/help/doctor/), [uninstall](https://cli.frely.cloud/docs/help/uninstall/))
- Contracts, for contributors: [Device MCP](docs/device-mcp.md) · [Device Relay transport](docs/device-transport.md) · [MCP OAuth contract](docs/mcp-oauth-relay-contract.md) · [`frely api`](docs/api.md) · [Frely Network (preview)](docs/frely-network.md) · [self-update](docs/self-update.md) · [service maintenance](docs/service-maintenance.md)

## License and trademarks

`frely-cli` is licensed under the Apache License 2.0; see [`LICENSE`](LICENSE). The Frely name, logos and product names are not licensed as trademarks; see [`TRADEMARKS.md`](TRADEMARKS.md). See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development and [`SECURITY.md`](SECURITY.md) to report a vulnerability.
