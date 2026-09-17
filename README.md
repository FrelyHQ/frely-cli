# frely-cli

设计与 ChatGPT MCP 用户流程见 [`docs/chatgpt-mcp.md`](docs/chatgpt-mcp.md)。

`frely-cli` is Frely's local command-line client, remote Agent bridge, and local MCP runtime. Remote Agent use and local tool sharing are separate flows:

```text
Remote Agent Skill: install -> frely login -> frely skill install -> frely agent invoke
Local tool sharing:  install -> frely login -> frely mcp setup -> add stable MCP URL -> OAuth authorize
```

`frely skill install` installs a local trigger Skill. It does not install a model or change the user's current model Provider/Base URL. `frely mcp setup` provisions local file, shell, process, and workspace execution; consuming a remote Frely Agent does not require that local execution authorization.

There is no separate `friday-local` project. Local MCP execution belongs to `frely-cli`.

This repository contains the open-source Frely client and local MCP runtime.
The hosted Friday Relay control plane remains a separate service dependency.
See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development guidance and
[`SECURITY.md`](SECURITY.md) for private vulnerability reporting.

## Landing page

The open-source CLI landing page lives in [`site/`](site/README.md), alongside
the CLI under the same Apache-2.0 license and trademark policy. It is prepared
for `cli.frely.cloud` and deploys independently as a static site. Website assets
are excluded from the npm package.

## Quick install

After the standalone artifacts and installer are released, Frely can serve `install.sh` as:

```sh
curl -fsSL https://app.frely.cloud/install.sh | sh
```

The standalone installers (`install.sh` and `install.ps1`) select a platform executable, verify its SHA-256 checksum and install in the user directory. They do not require Node.js, npm or a keyring. The npm package requires Node.js 22 or newer. Tagged releases publish the npm package and standalone GitHub Release assets after cross-platform verification. See [credential and installation boundaries](docs/credential-storage.md).

## Install or update with npm

To install or update to the latest release, use:

```sh
npm install --global --ignore-scripts frely-cli@latest
```

To install or update to a specific release, replace `latest` with the release version. For example:

```sh
npm install --global frely-cli@0.3.6
```

## Update an existing installation

If you installed `frely-cli` with the official installer, run the [Quick install](#quick-install) installer again. It replaces the global package with the latest `frely-cli` release. If you installed the package directly with npm, run one of the commands in [Install or update with npm](#install-or-update-with-npm) again.

If multiple `frely` executables are installed, list the candidates and check the npm global installation:

```sh
type -a frely
npm prefix --global
"$(npm prefix --global)/bin/frely" --version
```

Your shell uses the first `frely` path in `PATH`. If that path is not the npm global bin directory, put `$(npm prefix --global)/bin` earlier in `PATH` and run `frely --version` again.

If the background Device Relay service is running, restart it after the update so it loads the new CLI version:

```sh
frely mcp service stop
frely mcp service start
```

Verify the update:

```sh
frely --version
frely doctor
```

## Install from a local checkout

To install the current source checkout with Bun:

```sh
cd /path/to/frely-cli
bun install
bun run build
bun install --global "$PWD"
```

Use the absolute `$PWD` path in the global install command. Bun installs the `frely` executable in its global bin directory. If the command is not found, add that directory to your `PATH`:

```sh
export PATH="$(bun pm bin -g):$PATH"
```

This source revision has no keytar dependency or native npm build step. Dependency installation supports `npm ci --ignore-scripts` and `bun install --ignore-scripts`. Do not add a lifecycle-script trust exception for an old keytar installation.

The repository uses npm as the canonical package manager for CI and releases
and commits `package-lock.json`. Bun can be used for local development; keep
the lockfiles synchronized when changing dependencies.

## First use

Sign in once when the consumer uses their own Frely account:

```sh
frely login
```

To choose another browser or Frely account, disable automatic browser opening:

```sh
frely login --no-browser
```

Open the printed URL only in the browser signed in to the account you want to use. Visiting a device authorization URL while signed in can bind that code to the account before you click Approve. If the default browser already opened it with another account, press Ctrl+C, run `frely login --no-browser` again, and use the **new URL**. Signing in again or reusing the old URL does not switch its account. Keep `--relay <url>` when using a custom Relay.

`FRELY_NO_BROWSER=1` remains supported for scripts and existing setups. `frely login --help` lists the available options.

To install a published Frely Agent as a local trigger Skill:

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

For local workspace, file, shell, and process sharing, enable the separate local MCP runtime:

```sh
frely mcp setup --workspace /path/to/project
```

`frely login` requests a restricted account session through browser device authorization. Basic sessions use private plaintext files, not the OS credential store. Legacy account cookies do not migrate to this store. Basic features and Network commands do not initialize MCP credentials.

`frely mcp setup` initializes a separate secure MCP key, requests browser approval for this device and workspace, and installs the user-level Device Relay service. The default authorization is 90 days; `--days 1..180` selects a duration. `frely mcp renew --days 180` requires a new approval and rotates the MCP execution key. The MCP URL remains bound to the device. Login refresh, OAuth refresh, restart and repeated setup do not extend authorization.

Services use macOS LaunchAgents, Linux systemd user units, or Windows Task Scheduler for the logged-on user. Windows implementation needs native acceptance testing. Linux MCP secure storage can require Secret Service or an injected key; basic installation does not.

You can print the URL again with:

```sh
frely mcp url
```

Or show ChatGPT-oriented instructions with:

```sh
frely mcp chatgpt
```

## Local model sharing

`frely-cli` can publish a loopback OpenAI-compatible runtime as a Frely personal Provider. Ollama is the default driver.

```sh
frely provider share ollama
```

Default Ollama endpoint: `http://127.0.0.1:11434/v1`.

Custom endpoint and model selection:

```sh
frely provider share openai-compatible \
  --url http://127.0.0.1:8080/v1 \
  --models model-a,model-b \
  --slot <personal-provider-slot-id> \
  --name "Local GPU"
```

Requirements: Frely login, one empty active personal Provider slot, loopback HTTP, OpenAI-compatible `/v1`. Model names cannot contain whitespace or `/`.

The command creates a server-managed `openai-compatible` personal Provider, stores the local endpoint in owner-only CLI state, starts the Device Relay service, signs a Provider credential with the device Ed25519 key, configures CPA, and enables the declared models. Existing Frely Access Point and API-key flows consume the Provider.

Provider inspection and recovery:

```sh
frely provider list
frely provider finalize <provider-id>
```

`finalize` resumes CPA setup for a Provider left in a prepared state.

## Commands

```text
frely login [--relay <https-url>] [--no-browser]
frely logout
frely whoami
frely status [--json]
frely doctor [--json]
frely skill install <manifest-url> [--host chatgpt|codex|claude-code|pi|generic] [--scope global|project] [--api-key-stdin] [--json]
frely skill status <distribution-id> [--json]
frely skill remove <distribution-id> [--json]
frely agent invoke <distribution-id> (--input <text>|--input-stdin) [--json]
frely provider share [ollama|openai-compatible] [--url <loopback-v1-url>] [--models <a,b>] [--slot <slot-id>] [--name <name>]
frely provider list [--json]
frely provider finalize <provider-id>
frely mcp setup [--workspace <path>]
frely mcp url [--json]
frely mcp status [--json]
frely mcp chatgpt
frely mcp serve [--workspace <path>]
frely mcp service status|start|stop|uninstall [--json]
frely mcp revoke
frely mcp stdio [--workspace <path>]
```

`frely mcp serve` is the foreground form of the Device Relay client. Remote execution requires the approved workspace and MCP lease. A Provider-only connection does not enable MCP.

`frely logout` removes the account session and attempts to stop the background service. `frely mcp revoke` revokes the MCP lease and removes its secure credential; it retains the Provider device and service.

## MCP provisioning contract

The CLI expects Frely Relay to expose these authenticated user endpoints:

```text
POST /api/user/device-relay/enroll
POST /api/user/device-relay/connect
POST /api/user/device-relay/revoke
```

Enrollment returns:

```json
{
  "deviceId": "..."
}
```

The public MCP URL has the stable form `https://app.frely.cloud/mcp/<device-id>`. The URL contains no bearer secret. Remote MCP clients use OAuth 2.1 Authorization Code + PKCE. OAuth access tokens bind to the exact MCP resource URL and do not extend the 90/180-day local execution authorization. Relay OAuth requirements are defined in [`docs/mcp-oauth-relay-contract.md`](docs/mcp-oauth-relay-contract.md).

A Device Relay connection request uses the enrolled Ed25519 device key and returns a short-lived connection grant:

```json
{
  "websocketUrl": "wss://...",
  "accessToken": "short-lived-token",
  "expiresAt": "..."
}
```

The access token is sent only in the WebSocket `Authorization` header. It is not printed and is not persisted in the MCP URL.

## Device Relay

The WebSocket subprotocol is `frely.device-relay.v1`. Requests use independent request IDs and a 64-request inflight window. Read-only local operations may overlap; writes and shell operations use the local fair scheduler. This avoids LocalMCP's device-wide `busy -> 429` behavior.

The client requests a fresh short-lived connection grant for every connection attempt and reconnects with bounded exponential backoff. A renewed Frely login is picked up by the next reconnect without reinstalling the service.

## Local MCP capabilities

The local MCP server exposes workspace inspection, file search/read/write/patch, directory create/delete/move, shell commands, and persistent process management.

Filesystem tools are constrained to the selected workspace, reject symlink escapes, cap normal file reads/writes at 1 MiB, use no-follow reads, and use atomic replacement for writes. `run_command` and persistent process tools execute with the current OS user's permissions; the workspace only constrains their working directory and is not a shell sandbox.

## Authentication and secrets

Basic account and Network sessions use private plaintext files. They cannot approve MCP authorization or invoke account-management operations outside their explicit scopes. The Provider key is separate from the MCP execution key.

MCP secrets use AES-256-GCM files with a master key in macOS Keychain, Windows Credential Manager or Linux Secret Service. Headless deployments can inject a 32-byte key through `FRELY_CREDENTIAL_KEY` and select `FRELY_CREDENTIAL_STORE=encrypted-file`. MCP has no plaintext fallback. Secure-store failure does not stop basic features.

The stable MCP URL contains no credential. Remote clients hold OAuth credentials; the CLI holds the MCP execution private key. The Relay checks OAuth resource binding and the current MCP execution lease. Expiry blocks requests and queued work and cancels managed execution. It does not undo writes or create a sandbox around arbitrary shell programs.

`frely doctor` treats unconfigured MCP as optional. `frely doctor --mcp` checks the secure credential and server. `frely mcp status` displays local metadata; it is not server revocation proof.

Storage, migration, service injection, release requirements and threat boundaries: [`docs/credential-storage.md`](docs/credential-storage.md).

## Current server dependency

The CLI side of installation, account login, device enrollment, MCP URL discovery, background service lifecycle, Device Relay WebSocket transport, multiplexing, reconnection, local MCP execution, local model discovery, and loopback Provider forwarding is implemented here.

A Frely Relay deployment must implement the device provisioning endpoints, Device Relay WebSocket host, OAuth-protected MCP ingress, OAuth discovery/token endpoints, local Provider ingress, and personal Provider control flow. The MCP URL is a stable resource identifier. Local Provider credentials are device-key signatures stored by CPA. See [`docs/mcp-oauth-relay-contract.md`](docs/mcp-oauth-relay-contract.md).

## License and trademarks

`frely-cli` is licensed under the Apache License 2.0; see [`LICENSE`](LICENSE).
The Frely name, logos, and product names are not licensed as trademarks; see
[`TRADEMARKS.md`](TRADEMARKS.md).

## Frely Network onboarding

The Network commands are part of the unreleased 0.4.0 source version. The npm distribution requires Node.js 22 or newer; the standalone distribution includes its runtime. Package publication and server activation are separate release steps.

```sh
frely network setup --host chatgpt --json
frely network status --json
frely network find --capability web3.address-risk --json
frely network use --capability web3.address-risk \
  --input-json '{"address":"<EVM_ADDRESS>","chainId":"1"}' \
  --request-id '<REQUEST_UUID>' --json
frely network logout --json
```

The examples contain placeholders. Host values are `chatgpt`, `claude-code`, `opencode` and `generic`. Setup returns a browser link and request code without waiting for a signature or requiring a TTY. The next status or capability call retrieves the authorization. ChatGPT requires an existing device-execution bridge and uses the instructions in its current conversation; setup does not add a ChatGPT connector or native Skill.

`--network <HTTPS-origin>` selects a deployment. Credentials are scoped to that origin in the basic private-file store under `frely-network`; they do not share Frely account or device-relay credentials. Tokens and private device codes are excluded from command output. `logout` affects the Network session, not the existing FrelyMCP service. An unconfirmed remote revocation is reported as an error.

Skill installation manages its own files and hash metadata. An unmanaged file, user edit or symlink causes a failure rather than a configuration overwrite. Installation paths are `.claude/skills/frely-network`, `.config/opencode/skills/frely-network` or `.agents/skills/frely-network` under the user home.

The first address-risk profile requires target chain `1`; the wallet login chain does not choose the target. Service output contains source-backed risk signals and `scamProbability: null`, not a fabricated percentage. Calls use platform demo quota without granting wallet transfer permissions. Preserve the request UUID for retries; the CLI does not resend an ambiguous service call.

Source verification:

```sh
npm ci
npm run check
npm test
npm run build
node dist/index.js network help --json
```

CLI unit tests use a fake credential store and temporary home directories. They do not verify the user's OS credential-store permissions or a deployed Network.
