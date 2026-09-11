# frely-cli

`frely-cli` is the Frely device CLI. Its local execution runtime is `friday-local`. Local MCP capabilities are unavailable until a Frely account login succeeds.

## Current slice

- `frely login [--relay <https-url>]`
- `frely logout`
- `frely whoami`
- `frely mcp stdio [--workspace <path>]`
- Frely Web account authentication through `/api/auth/login`
- OS credential-store persistence through Keychain / Secret Service (`keytar`)
- workspace-contained file tools
- shell execution with explicit MCP side-effect metadata
- fair read/write scheduling: reads may overlap; writes and commands queue instead of returning device-wide `429`

The Friday Relay Device Relay transport is a separate server-side concern. It will forward multiplexed request IDs to the same local runtime without changing the tool implementation.
