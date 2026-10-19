# frely-cli

[English](README.md) · [简体中文](README.zh-CN.md)

`frely-cli` turns a computer you choose into a device that AI agents can work on from anywhere. ChatGPT, Claude, Codex and other MCP clients connect through **FrelyMCP** and use the files, shell commands and processes in the folders you allow. The computer connects out to Frely, so you open no ports.

It is also the command line for your Frely account:

- **Device MCP**: let remote AI clients work on this computer.
- **Local MCP servers**: pass MCP servers that only run on this computer (for example on `127.0.0.1`) through to remote clients.
- **Agents, Prompts and Skills**: install a published Frely Agent as a local Skill, or install Prompts and Skills you bought.
- **Local model sharing**: publish a local Ollama or OpenAI-compatible runtime as your own Frely Provider.

## Install

### A server, with a Frely account (no browser)

Get a one-time install command and paste it on the server. It installs `frely`, signs in to your account, enables Device MCP and starts the background service. Nothing opens in a browser and nothing asks a question.

Get the command in either place:

- On the Frely website: **My Devices → Add a computer → Create install command**.
- In ChatGPT or Claude connected to FrelyMCP: ask it to add a computer. `list_devices` returns the command.

It looks like this:

```sh
curl -fsSL https://frely.cloud/start.sh | FRELY_INSTALL_TOKEN=fit_... sh
```

The token works once and expires after 15 minutes. It is not saved on the computer. If the computer already has Frely installed or signed in, the command updates it and switches the sign-in to your account. On Linux, run `sudo loginctl enable-linger $USER` so the service stays online after you log out of SSH.

### A computer with a browser

```sh
# macOS / Linux
curl -fsSL https://frely.cloud/start.sh | sh
```

```powershell
# Windows (PowerShell)
curl.exe -fsSLo "$env:TEMP\frely-start.ps1" https://frely.cloud/start.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\frely-start.ps1"
```

The script installs the latest `frely`, then runs `frely mcp start`: it opens the browser to sign in (new accounts can register on the same page), asks you to approve this device and prints your MCP URL. Run it again any time to update; it restarts the background service on the new version.

The workspace is your home directory by default (credential and shell start-up files stay protected). Set `FRELY_WORKSPACE=/path` to share another folder, and `FRELY_INSTALL_DIR` to install somewhere other than `~/.local/bin`.

### Install only

`install.sh` and `install.ps1` (same URLs, `https://frely.cloud/install.sh`) only install the program, for scripts, Skills and agents that need the CLI. Or use npm (Node.js 22 or newer):

```sh
npm install --global --ignore-scripts frely-cli@latest
```

The installers pick the right executable for your platform, check its SHA-256 and install into your user directory without Node.js. They download from GitHub Releases first and fall back to npmmirror and npmjs (`@frelyhq/cli-<platform>`) when GitHub is slow or unreachable. `FRELY_INSTALL_SOURCES` changes the order.

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
| `frely uninstall` | Remove Frely from this computer (lists everything first). |

Run any command group without a subcommand (for example `frely mcp` or `frely agent`) to see what it offers.

## Use frely-cli with FrelyMCP

FrelyMCP is one MCP address for your whole account: `https://mcp.frely.cloud/mcp`. Every computer where you ran `frely mcp start` appears behind it. `frely-cli` runs the tools on each computer; the AI client only needs the URL.

### Connect a client

1. On the computer to control, run `frely mcp start` (the install scripts above already do this). It prints the MCP URL.
2. Add the URL to your client as a remote MCP server with OAuth:
   - ChatGPT or Claude: add a custom connector with the URL.
   - Claude Code on another computer: `claude mcp add --transport http frely "https://mcp.frely.cloud/mcp"`, then open `/mcp` to authorize.
3. Sign in to Frely and approve the client.

To check the connection, ask the client to list the top-level names in your workspace. A result that matches the folder means it works.

### What the AI can do

- `list_devices` shows your computers, whether each is online and its workspaces. If you have none, it gives the install command above.
- Device tools take a `device` argument and run on that computer:
  - `read`: list, read, search and find files in the workspace.
  - `edit_file`: write whole files or edit lines, atomically.
  - `process`: run shell commands, or start and manage long-running processes.
  - `web_fetch`: read public web pages.
- `local_mcp_list` and `local_mcp_call` reach MCP servers on that computer that you turned on (see below).
- `local_models` (background service only) lists model servers on that computer (Ollama, LM Studio, vLLM, llama.cpp) and shares them as a Frely Provider; it uses one Provider slot. Shared models appear in `models_list` marked `local: true`.
- `frely_list` and `frely_call` manage your Frely account (API keys, credits, plans, orders). `frely api list|describe|call` is the same set from the terminal.

The AI client's own shell still runs where the client runs; ask it to use the Frely tools for work on your computer. All clients share each computer's workspaces and running processes.

### Local MCP servers on this computer

Servers that listen only on loopback are found automatically (`frely mcp local list`). Add others with:

```sh
frely mcp local add <name> --url http://127.0.0.1:<port>/mcp
frely mcp local add <name> [--env KEY=VALUE] -- <command> [args...]   # stdio
```

Each server stays hidden from remote clients until you turn it on, one by one, on the Frely connections page. Enabled servers run outside the command sandbox with your user account. Only loopback addresses are contacted, and headers and environment values never leave the computer.

### Authorization

Device MCP access lasts 90 days by default; `frely mcp start --days 1..365` renews early. When it expires, `frely mcp start` asks for approval again. The URL never changes. Manage your computers on the Frely website under **My Devices**.

## More features

### Invoke a Frely-hosted Agent

```sh
frely agent install <distribution-id> --host claude-code --scope global
printf '%s' 'Your complete task' | frely agent run <distribution-id> --input-stdin --json
```

`--host` is one of `chatgpt`, `codex`, `claude-code`, `pi` or `generic`. A full manifest URL also works in place of the id. To use a Creator's sponsored API key instead of your account, pass it on stdin with `--api-key-stdin`; it is stored in the secure credential store, never in the Skill. Use short-lived, single-model keys with a bounded quota. `frely agent status <id>` shows the Skill and the key's budget; `frely agent remove <id>` removes both.

### Install marketplace Prompts and Skills

```sh
frely item install <item-id> --host claude-code
```

The first call opens a browser for Frely Cloud authorization. A paid part is installed only if your account holds a pass; otherwise the command says how to buy one. Skills go to the host's Skill folder, Prompts to `--dir` (default: current directory), and scripts are saved without execute permission. Frely never overwrites a folder it did not install or a file you edited. After you review an installed item, `frely item trust <folder>` remembers it; a new version needs a new review.

Cloud MCPs you buy are not installed on the computer: enable them for a connection on the Frely website and their tools appear in FrelyMCP.

### Local model sharing

```sh
frely provider share ollama
frely provider share openai-compatible --url http://127.0.0.1:8080/v1 --models model-a,model-b --name "Local GPU"
frely provider list
```

This publishes a loopback OpenAI-compatible endpoint (Ollama by default at `http://127.0.0.1:11434/v1`) as a personal Frely Provider, using one empty personal Provider slot. With no empty slot, or with `--creator`, it creates a Creator Provider counted against your Creator plan, and its models can be the base of Agents you publish. Keep the computer online while it is used, and make sure the runtime returns `usage`. If setup stops halfway, run the same command again to resume.

## Local execution boundaries

- **Files**: file tools stay inside the shared workspaces, reject symlink escapes, cap reads and writes at 1 MiB and write atomically. Credential stores and shell start-up files are protected even inside the home directory.
- **Commands**: `process` runs as your OS user inside an OS sandbox. Credential folders are unreadable, writes are limited to the workspace and the temp directory, and network goes through a proxy. If the computer cannot sandbox (Windows, or Linux without `bubblewrap`, `socat` and `ripgrep`), commands are refused rather than run unsandboxed. You can open more on the Frely connections page: credential folders to read, extra folders to write, or a time-limited run without the sandbox. `FRELY_SANDBOX=off` turns the sandbox off on the device.
- **Credentials**: the MCP URL contains no secret. Clients hold OAuth tokens; the CLI holds a separate MCP execution key, encrypted with a master key in macOS Keychain, Windows Credential Manager or Linux Secret Service. Headless machines can set `FRELY_CREDENTIAL_KEY` (32 bytes) with `FRELY_CREDENTIAL_STORE=encrypted-file`. When authorization expires, requests and queued work stop; finished writes are not undone.

Details: [credential and installation boundaries](docs/credential-storage.md).

## Update, diagnose and uninstall

```sh
frely doctor      # account, installation, latest version, MCP and service state
frely doctor -v   # + config paths, authorization expiry, last heartbeat, sanitized errors
frely update      # update in place, keeping your login, device, URL and workspace
frely uninstall   # list everything, then remove it after you type yes (--yes for scripts)
```

`frely update` keeps the original install method and never downgrades. It pauses the background service, replaces the program after checking it, and restarts the service. On Windows it prints a PowerShell command to run in a local terminal. See [self-update](docs/self-update.md) and [service maintenance](docs/service-maintenance.md).

`frely uninstall` revokes this computer's access on the Frely side, removes the service, saved login, device identity, settings, caches and the Agent Skills Frely installed, and finally removes the `frely` program. It keeps the Frely App, your Providers and Agents in your account, the PATH lines the installer added, Skills you edited and marketplace items. Run it in a local terminal, not through Device MCP.

## All commands

```text
frely login [--relay <https-url>] [--no-browser]
frely login --email <address> [--mcp] [--workspace <path>]   then   frely login --code <6-digit code>
frely logout
frely uninstall [--yes] [--json]
frely doctor [-v] [--json]
frely update
frely mcp start [--workspace <path>] [--days 1..365] [--no-browser] [--json]
frely mcp status [--json]
frely mcp stop|remove
frely mcp workspace list [--json]
frely mcp workspace add|remove <path>
frely mcp local list [--json]
frely mcp local add <name> (--url <address> | [--env KEY=VALUE] -- <command> [args...])
frely mcp local remove <name>
frely agent install <distribution-id|manifest-url> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--api-key-stdin] [--json]
frely agent run <distribution-id> (--input <text>|--input-stdin) [--json]
frely agent status (<distribution-id>|--api-key-stdin [--relay <url>]) [--json]
frely agent remove <distribution-id> [--json]
frely item install <item-id> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--dir <path>] [--json]
frely item trust <folder> [--check]
frely provider share [ollama|openai-compatible] [--url <loopback-v1-url>] [--models <a,b>] [--slot <slot-id> | --creator] [--name <name>]
frely provider list [--json]
frely api list|describe|call
```

`frely help --agent --json` prints the full machine-readable contract, including commands not shown in `frely --help`: `frely mcp stdio` (serve the tools over stdio to a local client), `frely mcp serve` (the foreground process the service runs) and `frely network` (preview).

## Documentation

- [Device MCP](docs/device-mcp.md)
- [Device Relay transport](docs/device-transport.md)
- [MCP OAuth contract](docs/mcp-oauth-relay-contract.md)
- [`frely api`](docs/api.md)
- [Frely Network (preview)](docs/frely-network.md)

## License and trademarks

`frely-cli` is licensed under the Apache License 2.0; see [`LICENSE`](LICENSE). The Frely name, logos and product names are not licensed as trademarks; see [`TRADEMARKS.md`](TRADEMARKS.md). See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development and [`SECURITY.md`](SECURITY.md) to report a vulnerability.
