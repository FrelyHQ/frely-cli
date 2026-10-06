# frely-cli

[English](README.md) · [简体中文](README.zh-CN.md)

`frely-cli` turns the computer you choose into a secure remote device that AI agents can operate. Browser agents (ChatGPT, Codex) and command-line agents (Claude Code, pi) connect through Model Context Protocol (MCP) and access the files, commands and processes inside the workspace you authorize — from anywhere.

Two optional features, each with its own setup and authorization:

- **Remote Agent Skill** — install a published Frely Agent as a local trigger Skill and invoke it from automation.
- **Local model sharing** — publish a local Ollama / OpenAI-compatible runtime as your personal Frely Provider.

This repository contains the open-source Frely client and local MCP runtime. The hosted Frely Relay control plane remains a separate service dependency. There is no separate `friday-local` project; local MCP execution belongs to `frely-cli`.

```text
Remote Agent Skill: install -> frely login -> frely agent install -> frely agent run
Device MCP:  install on target computer -> frely login -> frely mcp url -> add MCP URL to client -> OAuth authorize
```

## Install

The standalone installers select the platform executable, verify a SHA-256 checksum and install into the user directory. They do not require Node.js, npm or a keyring.

```sh
# macOS / Linux
curl -fsSL https://cli.frely.cloud/install.sh | sh
```

```powershell
# Windows
irm https://cli.frely.cloud/install.ps1 | iex
```

To install and continue straight into Device MCP setup (sign in in the browser, new accounts can register there, then the MCP URL is printed), use `start.sh` / `start.ps1` instead. The workspace is the directory the command ran in (override with `FRELY_WORKSPACE`); without a terminal it only installs and prints the next commands. `install.sh` / `install.ps1` stay install-only, for scripts and Skills that need the CLI.

```sh
# macOS / Linux
curl -fsSL https://cli.frely.cloud/start.sh | sh
```

```powershell
# Windows
irm https://cli.frely.cloud/start.ps1 | iex
```

The installers and `frely update` download from a static mirror (`https://dl.frely.cloud/cli`, reachable from mainland China) and fall back to GitHub Releases as a whole when the mirror cannot supply the version or its checksum does not match. `FRELY_RELEASE_MIRROR=<https URL>` replaces the mirror and `FRELY_RELEASE_MIRROR=off` uses GitHub only.

Or with npm (Node.js 22 or newer required):

```sh
npm install --global --ignore-scripts frely-cli@latest
```

To install a specific release, replace `latest` with the version. Tagged releases publish the npm package and standalone GitHub Release assets after cross-platform verification.

### Install from a local checkout

To install the current source checkout with Bun:

```sh
cd /path/to/frely-cli
bun install
bun run build
bun install --global "$PWD"
```

Use the absolute `$PWD` path in the global install command. If `frely` is not found, add the Bun global bin to your `PATH`:

```sh
export PATH="$(bun pm bin -g):$PATH"
```

This source revision has no keytar dependency or native npm build step. Dependency installation supports `npm ci --ignore-scripts` and `bun install --ignore-scripts`. The repository uses npm as the canonical package manager for CI and releases and commits `package-lock.json`; Bun is for local development — keep the lockfiles synchronized when changing dependencies.

## First use

Sign in once with the Frely account the consumer uses:

```sh
frely login
```

The browser opens automatically. To choose another browser or Frely account, run `frely login --no-browser` and open the printed URL only in the browser signed in to the account you want to use. Visiting a device authorization URL while signed in can bind that code to the account before you click Approve — if the default browser already opened it with another account, press Ctrl+C, run `frely login --no-browser` again, and use the **new URL**. Signing in again or reusing the old URL does not switch its account. Keep `--relay <url>` when using a custom Relay. `FRELY_NO_BROWSER=1` remains supported.

### Device MCP: control this computer from a remote client

On the computer to control, enable file, shell and process access:

```sh
frely mcp url --workspace /path/to/project
```

`frely login` requests a restricted account session through browser device authorization. The first `frely mcp url` initializes a separate secure MCP key, requests browser approval for this device and workspace (the current directory when `--workspace` is omitted), installs the user-level Device Relay service (macOS LaunchAgent, Linux systemd user unit, or Windows Task Scheduler), and prints the MCP URL. The default authorization is 90 days; `--days 1..365` selects a duration.

`frely mcp url` is idempotent: once enabled it only prints the same URL, so run it again whenever you need the address. Prompts go to stderr, so stdout remains a single URL or, with `--json`, a JSON object. No URL is printed if approval or service installation fails. To expose more directories, use `frely mcp workspace add <path>`; `frely mcp workspace list` lists them. A command group run without a subcommand (for example `frely mcp workspace` or `frely agent`) prints the subcommands under it.

### Local MCP servers on this computer

Remote MCP clients can also reach MCP servers that only run on this computer, such as a browser-extension server listening on `127.0.0.1`. Servers listening only on loopback are found automatically (`frely mcp local list`); add others with `frely mcp local add <name> --url http://127.0.0.1:<port>/mcp` or `frely mcp local add <name> [--env KEY=VALUE] -- <command> [args...]` (stdio). Every server stays off for remote clients until you turn it on, one by one, on the Frely connections page. Enabled servers are then reachable through two device tools, `local_mcp_list` and `local_mcp_call`, and run outside the command sandbox with your user account. Only loopback addresses are ever contacted; headers and environment values stay on this computer.

Add the exact printed URL to a remote MCP client with OAuth support, choose OAuth and complete authorization. Keep the computer online. Verify the first connection by asking the client to list the top-level names in your selected workspace, without writing files or running shell commands — a returned result that matches the folder confirms connectivity.

For Claude Code on the calling computer:

```sh
claude mcp add --transport http frely "<MCP_URL>"
```

Open `/mcp` in Claude Code to complete OAuth authorization. One URL serves every device on your account with an active MCP permission: `list_devices` shows your devices and their workspaces, and every other tool takes a `device` argument (device name or id). Ask the Agent to use Frely tools for remote work; its built-in shell still runs on the calling computer. Clients share each device's workspaces and managed processes.

Authorization lifecycle: when the authorization has expired, `frely mcp url` asks for a new approval and rotates the MCP execution key; `frely mcp url --days 365` renews early. The MCP URL is the same for all your devices and does not change on renewal. Login refresh, OAuth refresh and restart do not extend authorization. `frely mcp stop|start` pauses or resumes the background service; `frely mcp remove` revokes access for every client and uninstalls the service (it keeps running provider-only when local Providers exist). Manage your devices in Frely → **Device MCP** (`/user/account/connections`).

### Invoke a Frely-hosted Agent

Use a published Agent with account or restricted API-key access. To install it as a local trigger Skill (a full manifest URL is also accepted in place of the id):

```sh
frely agent install <distribution-id> \
  --host pi \
  --scope global \
  --json
```

A Creator can also provide an existing model-scoped, quota-limited API key for a sponsored/demo invocation. Pass it only on stdin so it never appears in argv or the generated Skill:

```sh
printf '%s' "$FRELY_AGENT_KEY" | \
  frely agent install <distribution-id> \
    --host chatgpt \
    --scope global \
    --api-key-stdin \
    --json
```

The CLI verifies the key against the target model-scoped MCP `tools/list` endpoint, stores it in the secure credential store, and records only `authMode=api-key` in managed Skill metadata. Use short-lived, single-model keys with bounded quota for sharing; do not paste a Creator master key.

The generated Skill calls the published Agent through Frely's model-scoped MCP endpoint. Invoke the installed Agent from automation with the full task on stdin:

```sh
printf '%s' 'Your complete task' | \
  frely agent run '<distribution-id>' --input-stdin --json
```

`frely agent status <distribution-id>` shows the installed Skill and, for API-key installs, the Key's budget. `frely agent remove <distribution-id>` removes the Skill and its saved key.

### Install marketplace Prompts and Skills

```sh
frely item install <item-id> --host claude-code
```

`frely item install` downloads a Prompt or Skill through Frely Cloud (the first call opens a browser for Cloud authorization). A paid part is installed only when your account holds a pass; otherwise the command prints how to buy one. Skills go to the host's Skill folder, Prompts to `--dir` (default: current directory), and scripts are saved without execute permission. Frely never overwrites a folder it did not install or a file you edited.

Cloud MCPs you buy are not installed on the device: enable them for a connection on the Frely web console (Agents page) and their tools appear inside FrelyMCP.

## Local model sharing

Publish a loopback OpenAI-compatible runtime as a Frely personal Provider. Ollama is the default driver:

```sh
frely provider share ollama
```

Custom endpoint and model selection:

```sh
frely provider share openai-compatible \
  --url http://127.0.0.1:8080/v1 \
  --models model-a,model-b \
  --slot <personal-provider-slot-id> \
  --name "Local GPU"
```

Requirements: Frely login, one empty active personal Provider slot (or a Creator plan, see below), loopback HTTP, OpenAI-compatible `/v1` (default Ollama endpoint `http://127.0.0.1:11434/v1`). Model names cannot contain whitespace or `/`.

The command creates a server-managed `openai-compatible` personal Provider, stores the local endpoint in owner-only CLI state, starts the Device Relay service, signs a Provider credential with the device Ed25519 key, configures CPA, and enables the declared models. Existing Frely Access Point and API-key flows consume the Provider.

### Use a local model as the base of your own Agent (Creator)

With no empty personal Provider slot, or with `--creator`, `frely provider share` creates a Creator Provider instead, counted against your Creator plan (Creator 3, Creator Plus 100). Its enabled models appear in Frely when you create an Agent. You do not sell the Provider: buyers call your Agent, which runs on your model. Keep this device online while the Agent is used, and make sure the local runtime returns `usage` in its responses.

Provider inspection:

```sh
frely provider list
```

If setup stops after the Provider was prepared, run `frely provider share` again: it resumes that Provider instead of creating a new one.

## Update and diagnostics

```sh
frely doctor      # signed-in account, installation path, distribution, latest stable, MCP/service state
frely doctor -v   # + config paths, runtime details, authorization expiry, last heartbeat, sanitized errors
frely update     # updates the running installation in place
```

`frely update` never changes to a different installer, edits PATH or downgrades a newer installation. Standalone downloads are checksum-checked and tested before the installed executable is replaced. npm/Bun installations keep their original global directory. A matching, running Device Relay service is paused for maintenance, restarted and checked after installation; credentials, device identity, MCP URL, workspace and authorization expiry are preserved. On Windows, `update` prints a PowerShell command for the detected installation to run in a local terminal.

`frely doctor` is the single diagnostic entry point and never restarts the service. `Connected` means the matching account/device process has received a WebSocket heartbeat within 75 seconds and the MCP authorization and workspace match the running relay. Neither mode completes client OAuth authorization or executes a tool call through the client. `frely doctor --mcp` is the recommended way to check the protected credential and server state.

Full behavior: [the self-update contract](docs/self-update.md) and [service maintenance and legacy updates](docs/service-maintenance.md). If more than one `frely` is installed, check the path shown by `doctor` before updating.

## Local execution boundaries

The local MCP server exposes workspace inspection, file search/read/write/patch, directory create/delete/move, shell commands, and persistent process management.

Filesystem tools are constrained to the selected workspace, reject symlink escapes, cap normal file reads/writes at 1 MiB, use no-follow reads, and use atomic replacement for writes. `run_command` and persistent process tools execute with the current OS user's permissions inside an OS-level sandbox where the platform supports one (credential folders unreadable, writes limited to the workspace and the temp directory, HTTP(S) and ssh/scp/sftp through a proxy). The owner can open more from the Frely connections page: credential folders to read, build-cache or chosen directories to write, or a time-limited run without the sandbox for raw network connections. The workspace itself only constrains the working directory.

Read-only local operations may overlap; writes and shell operations use the local fair scheduler — this avoids device-wide `busy -> 429` behavior.

## Authentication and secrets

Basic account and Network sessions use private plaintext files. They cannot approve MCP authorization or invoke account-management operations outside their explicit scopes. The Provider key is separate from the MCP execution key.

MCP secrets use AES-256-GCM files with a master key in macOS Keychain, Windows Credential Manager or Linux Secret Service. Headless deployments can inject a 32-byte key through `FRELY_CREDENTIAL_KEY` and select `FRELY_CREDENTIAL_STORE=encrypted-file`. MCP has no plaintext fallback; secure-store failure does not stop basic features.

The stable MCP URL contains no credential. Remote clients hold OAuth credentials; the CLI holds the MCP execution private key. The Relay checks OAuth resource binding and the current MCP execution lease. Expiry blocks requests and queued work and cancels managed execution; it does not undo writes or create a sandbox around arbitrary shell programs.

Storage, migration, service injection, release requirements and threat boundaries: [credential and installation boundaries](docs/credential-storage.md).

## Architecture

- Product definition and generic client integration: [docs/device-mcp.md](docs/device-mcp.md)
- Device Relay transport: subprotocol, connection grant, reconnection, fallback state machine: [docs/device-transport.md](docs/device-transport.md)
- Relay OAuth 2.1 Authorization Code + PKCE, discovery and token endpoints: [docs/mcp-oauth-relay-contract.md](docs/mcp-oauth-relay-contract.md)
- Cloud commands and authorization: [docs/cloud.md](docs/cloud.md)
- Frely Network commands (preview, not listed in `frely --help`): [docs/frely-network.md](docs/frely-network.md)

The public MCP URL is the canonical resource returned by Relay, `https://mcp.frely.cloud/mcp` (one URL per account, shared by all your devices). Use `frely mcp url`; do not derive the URL from the control-plane hostname. The URL contains no bearer secret.

## Commands

```text
frely login [--relay <https-url>] [--no-browser]
frely logout
frely doctor [-v] [--json]
frely update
frely mcp url [--workspace <path>] [--days 1..365] [--json]
frely mcp workspace list [--json]
frely mcp workspace add|remove <path>
frely mcp local list [--json]
frely mcp local add <name> (--url <address> | -- <command> [args...])
frely mcp local remove <name>
frely mcp stop|start|remove
frely agent install <distribution-id|manifest-url> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--api-key-stdin] [--json]
frely agent run <distribution-id> (--input <text>|--input-stdin) [--json]
frely agent status (<distribution-id>|--api-key-stdin [--relay <url>]) [--json]
frely agent remove <distribution-id> [--json]
frely item install <item-id> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--dir <path>] [--json]
frely provider share [ollama|openai-compatible] [--url <loopback-v1-url>] [--models <a,b>] [--slot <slot-id> | --creator] [--name <name>]
frely provider list [--json]
frely cloud list|describe|call
```

Not listed in `frely --help`, but in `frely help --agent --json`: `frely mcp stdio [--workspace <path>]` serves the tools over stdio for a local MCP client; `frely mcp serve` is the foreground Device Relay client the background service runs; `frely network` is the Network preview.

`frely logout` removes the account session, revokes Cloud authorization and attempts to stop the background service.

## Landing page

The open-source CLI landing page lives in [`site/`](site/README.md), alongside the CLI under the same Apache-2.0 license and trademark policy. It is prepared for `cli.frely.cloud` and deploys independently as a static site. Website assets are excluded from the npm package.

## License and trademarks

`frely-cli` is licensed under the Apache License 2.0; see [`LICENSE`](LICENSE). The Frely name, logos, and product names are not licensed as trademarks; see [`TRADEMARKS.md`](TRADEMARKS.md).

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development guidance and [`SECURITY.md`](SECURITY.md) for private vulnerability reporting.
