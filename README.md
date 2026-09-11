# frely-cli

设计与 ChatGPT MCP 用户流程见 [`docs/chatgpt-mcp.md`](docs/chatgpt-mcp.md)。

`frely-cli` is Frely's local command-line client and MCP runtime. The target flow is:

```text
install -> frely login -> frely mcp setup -> add MCP URL to ChatGPT
```

There is no separate `friday-local` project. Local MCP execution belongs to `frely-cli`.

## Quick install

After `@frely/cli` is published, Frely can serve the repository `install.sh` as:

```sh
curl -fsSL https://app.frely.cloud/install.sh | sh
```

The installer requires Node.js 22 or newer and installs `@frely/cli@latest` through npm.

## First use

```sh
frely login
frely mcp setup --workspace /path/to/project
```

`mcp setup` performs three client-side steps:

1. enrolls this machine with the logged-in Frely account;
2. obtains the stable public MCP URL;
3. installs and starts the user-level background Device Relay service.

It prints the MCP URL to add to ChatGPT. The background service keeps the outbound connection alive, so no terminal window or inbound port is required.

You can print the URL again with:

```sh
frely mcp url
```

Or show ChatGPT-oriented instructions with:

```sh
frely mcp chatgpt
```

## Commands

```text
frely login [--relay <https-url>]
frely logout
frely whoami
frely status [--json]
frely doctor [--json]
frely mcp setup [--workspace <path>]
frely mcp url [--json]
frely mcp status [--json]
frely mcp chatgpt
frely mcp serve [--workspace <path>]
frely mcp service status|start|stop|uninstall [--json]
frely mcp revoke
frely mcp stdio [--workspace <path>]
```

`frely mcp serve` is the foreground/debug form of the same Device Relay client. `frely mcp setup` uses a LaunchAgent on macOS and a systemd user service on Linux.

`frely logout` stops the background service before removing the account session. `frely mcp revoke` removes the background service, revokes the server-side device binding, and deletes the local device private key.

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
  "deviceId": "...",
  "mcpUrl": "https://.../mcp/..."
}
```

The public MCP URL is a private bearer URL of the form `https://app.frely.cloud/mcp/<device-id>/<private-secret>`. The secret is high entropy, is only stored as a SHA-256 hash by the Relay, and must be treated as a credential. ChatGPT uses this URL with MCP Authentication set to `None`; no separate ChatGPT MCP OAuth flow is required.

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

- Password input requires an interactive TTY and is not stored.
- Frely account session credentials are stored through Keychain / Secret Service via `keytar`.
- The device Ed25519 private key is stored in the OS credential store.
- Device binding metadata includes the private MCP bearer URL and therefore uses owner-only file permissions; the Relay stores only the MCP secret hash.
- Device connection grants are short lived and stay in memory.
- The MCP URL does not contain the device private key, account session, or connection grant, but the URL's private secret is itself a credential.
- `doctor` never prints passwords, sessions, private keys, or connection grants.

## Current server dependency

The CLI side of installation, account login, device enrollment, MCP URL discovery, background service lifecycle, Device Relay WebSocket transport, multiplexing, reconnection, and local MCP execution is implemented here.

A Frely Relay deployment must implement the three provisioning endpoints, Device Relay WebSocket host, and public private-URL MCP ingress before `frely mcp setup` can produce a working ChatGPT connection. The private MCP URL is the ChatGPT-side bearer credential, so no separate ChatGPT MCP authentication service is required.
