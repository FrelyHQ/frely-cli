# frely-cli

[English](README.md) · [简体中文](README.zh-CN.md)

`frely-cli` turns the computer you choose into a secure remote device that AI agents can operate. Browser agents (ChatGPT, Codex) and command-line agents (Claude Code, pi) connect through Model Context Protocol (MCP) and access the files, commands and processes inside the workspace you authorize — from anywhere.

Two optional features, each with its own setup and authorization:

- **Remote Agent Skill** — install a published Frely Agent as a local trigger Skill and invoke it from automation.
- **Local model sharing** — publish a local Ollama / OpenAI-compatible runtime as your personal Frely Provider.

This repository contains the open-source Frely client and local MCP runtime. The hosted Frely Relay control plane remains a separate service dependency. There is no separate `friday-local` project; local MCP execution belongs to `frely-cli`.

```text
Remote Agent Skill: install -> frely login -> frely skill install -> frely agent invoke
Device MCP:  install on target computer -> frely login -> frely mcp -> add MCP URL to client -> OAuth authorize
```

## Install

The standalone installers select the platform executable, verify a SHA-256 checksum and install into the user directory. They do not require Node.js, npm or a keyring.

```sh
# macOS / Linux
curl -fsSL https://app.frely.cloud/install.sh | sh
```

```powershell
# Windows
irm https://github.com/FrelyHQ/frely-cli/releases/latest/download/install.ps1 | iex
```

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
frely mcp --workspace /path/to/project
```

`frely login` requests a restricted account session through browser device authorization. `frely mcp` initializes a separate secure MCP key, requests browser approval for this device and workspace, and installs the user-level Device Relay service (macOS LaunchAgent, Linux systemd user unit, or Windows Task Scheduler). The default authorization is 90 days; `--days 1..180` selects a duration.

Print the URL to add to an MCP client:

```sh
frely mcp url
```

If MCP has not been configured, `frely mcp url` automatically runs the equivalent of `frely mcp setup --workspace ~`: it requests browser approval for your home directory (90 days by default), then installs the background service and prints the URL. Run `frely login` first. Setup prompts go to stderr, so stdout remains a single URL or, with `--json`, a JSON object. No URL is printed if approval or service installation fails.

Add the exact printed URL to a remote MCP client with OAuth support, choose OAuth and complete authorization. Keep the computer online. Verify the first connection by asking the client to list the top-level names in your selected workspace, without writing files or running shell commands — a returned result that matches the folder confirms connectivity.

For Claude Code on the calling computer:

```sh
claude mcp add --transport http frely-computer "<MCP_URL>"
```

Open `/mcp` in Claude Code to complete OAuth authorization. Use a distinct server name per device. Ask the Agent to use Frely tools for remote work; its built-in shell still runs on the calling computer. Clients of the same device share its workspace and managed processes.

Authorization lifecycle: `frely mcp renew --days 180` requires a new approval and rotates the MCP execution key. The MCP URL remains bound to the device. Login refresh, OAuth refresh, restart and repeated setup do not extend authorization. Manage your devices in Frely → **Device MCP** (`/user/account/connections`). `frely mcp setup` and `frely mcp chatgpt` remain compatibility aliases; a bare `frely mcp` uses the current directory.

### Invoke a Frely-hosted Agent

Use a published Agent with account or restricted API-key access. To install it as a local trigger Skill:

```sh
frely skill install https://app.frely.cloud/api/public/virtual-models/<distribution-id> \
  --host pi \
  --scope global \
  --json
```

A Creator can also provide an existing model-scoped, quota-limited API key for a sponsored/demo invocation. Pass it only on stdin so it never appears in argv or the generated Skill:

```sh
printf '%s' "$FRELY_AGENT_KEY" | \
  frely skill install https://app.frely.cloud/api/public/virtual-models/<distribution-id> \
    --host chatgpt \
    --scope global \
    --api-key-stdin \
    --json
```

The CLI verifies the key against the target model-scoped MCP `tools/list` endpoint, stores it in the secure credential store, and records only `authMode=api-key` in managed Skill metadata. Use short-lived, single-model keys with bounded quota for sharing; do not paste a Creator master key.

The generated Skill calls the published Agent through Frely's model-scoped MCP endpoint. Invoke the installed Agent from automation with the full task on stdin:

```sh
printf '%s' 'Your complete task' | \
  frely agent invoke '<distribution-id>' --input-stdin --json
```

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

Requirements: Frely login, one empty active personal Provider slot, loopback HTTP, OpenAI-compatible `/v1` (default Ollama endpoint `http://127.0.0.1:11434/v1`). Model names cannot contain whitespace or `/`.

The command creates a server-managed `openai-compatible` personal Provider, stores the local endpoint in owner-only CLI state, starts the Device Relay service, signs a Provider credential with the device Ed25519 key, configures CPA, and enables the declared models. Existing Frely Access Point and API-key flows consume the Provider.

Provider inspection and recovery:

```sh
frely provider list
frely provider finalize <provider-id>
```

`finalize` resumes CPA setup for a Provider left in a prepared state.

## Update and diagnostics

```sh
frely doctor      # installation path, distribution, latest stable, local account/MCP/service state
frely doctor -v   # + config paths, runtime details, authorization expiry, last heartbeat, sanitized errors
frely upgrade     # updates the running installation in place
```

`frely upgrade` never changes to a different installer, edits PATH or downgrades a newer installation. Standalone downloads are checksum-checked and tested before the installed executable is replaced. npm/Bun installations keep their original global directory. A matching, running Device Relay service is paused for maintenance, restarted and checked after installation; credentials, device identity, MCP URL, workspace and authorization expiry are preserved. On Windows, `upgrade` prints a PowerShell command for the detected installation to run in a local terminal.

`frely doctor` is the single diagnostic entry point and never restarts the service. `Connected` means the matching account/device process has received a WebSocket heartbeat within 75 seconds and the MCP authorization and workspace match the running relay. Neither mode completes client OAuth authorization or executes a tool call through the client. Legacy `frely status`, `frely mcp status`, `frely mcp service status` and `frely doctor --mcp` remain compatible, but `frely doctor` is the recommended entry point.

Full behavior: [the self-upgrade contract](docs/self-upgrade.md) and [service maintenance and legacy upgrades](docs/service-maintenance.md). If more than one `frely` is installed, check the path shown by `doctor` before upgrading.

## Local execution boundaries

The local MCP server exposes workspace inspection, file search/read/write/patch, directory create/delete/move, shell commands, and persistent process management.

Filesystem tools are constrained to the selected workspace, reject symlink escapes, cap normal file reads/writes at 1 MiB, use no-follow reads, and use atomic replacement for writes. `run_command` and persistent process tools execute with the current OS user's permissions; the workspace only constrains their working directory and is **not** a shell sandbox.

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
- Frely Network commands (unreleased): [docs/frely-network.md](docs/frely-network.md)

The public MCP URL is the canonical resource returned by Relay, for example `https://connect.frely.cloud/mcp/<device-id>`. Use `frely mcp url`; do not derive the URL from the control-plane hostname. The URL contains no bearer secret.

## Commands

```text
frely login [--relay <https-url>] [--no-browser]
frely logout
frely whoami
frely doctor [-v] [--json]
frely upgrade
frely skill install <manifest-url> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--api-key-stdin] [--json]
frely skill status <distribution-id> [--json]
frely skill remove <distribution-id> [--json]
frely agent invoke <distribution-id> (--input <text>|--input-stdin) [--json]
frely provider share [ollama|openai-compatible] [--url <loopback-v1-url>] [--models <a,b>] [--slot <slot-id>] [--name <name>]
frely provider list [--json]
frely provider finalize <provider-id>
frely mcp [--workspace <path>] [--days 1..180]
frely mcp renew [--days 1..180]
frely mcp url [--json]
frely mcp serve [--workspace <path>]
frely mcp service start|stop|uninstall
frely mcp revoke
frely mcp stdio [--workspace <path>]
```

`frely mcp serve` is the foreground form of the Device Relay client. Remote execution requires the approved workspace and MCP lease; a Provider-only connection does not enable MCP.

`frely logout` removes the account session and attempts to stop the background service. `frely mcp revoke` revokes the MCP lease and removes its secure credential; it retains the Provider device and service.

## Landing page

The open-source CLI landing page lives in [`site/`](site/README.md), alongside the CLI under the same Apache-2.0 license and trademark policy. It is prepared for `cli.frely.cloud` and deploys independently as a static site. Website assets are excluded from the npm package.

## License and trademarks

`frely-cli` is licensed under the Apache License 2.0; see [`LICENSE`](LICENSE). The Frely name, logos, and product names are not licensed as trademarks; see [`TRADEMARKS.md`](TRADEMARKS.md).

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development guidance and [`SECURITY.md`](SECURITY.md) for private vulnerability reporting.
