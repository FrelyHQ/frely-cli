# frely-cli

`frely-cli` is Frely's local command-line client and MCP runtime. There is no separate `friday-local` project in this design.

Local MCP capabilities require a valid Frely account login. The CLI authenticates against Frely, stores the session only in the OS credential store, and keeps non-secret account metadata in `~/.config/frely/config.json`.

## Commands

```text
frely login [--relay <https-url>]
frely logout
frely whoami
frely status [--json]
frely doctor [--json]
frely mcp stdio [--workspace <path>]
```

## MCP capabilities

The stdio MCP server exposes workspace inspection, file search/read/write/patch, directory create/delete/move, shell commands, and persistent process management.

Read-only operations may execute in parallel. Mutating operations and commands use a fair queue instead of returning a device-wide `429` while another request is active.

Filesystem tools are constrained to the selected workspace, reject symlink escapes, cap normal file reads/writes at 1 MiB, use no-follow reads, and use atomic replacement for writes. `run_command` and persistent process tools execute with the current OS user's permissions; the workspace only constrains their working directory and is not a shell sandbox.

## Authentication and secrets

- Password input requires an interactive TTY and is not stored.
- Frely session credentials are stored through Keychain / Secret Service via `keytar`.
- Plaintext session values are not written to CLI configuration.
- `logout` removes the local credential and configuration after a best-effort server logout.
- `doctor` tests credential-store access and the current Frely session without printing credentials.

## Current boundary

`frely-cli` owns local MCP execution. Friday Relay remains a server-side relay concern. This repository does not implement or depend on `friday_agent`, `pi-client`, or a separate `friday-local` runtime.
