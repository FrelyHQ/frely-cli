# Frely API

`frely api` calls your Frely account's business operations (API keys, credits, orders, Creator items and more) at `https://frely.cloud/mcp`. AI clients connected to FrelyMCP reach the same operations through `frely_list` and `frely_call`; use `frely api` from scripts, CI, terminal agents, or when an input comes from a local file. It uses the application origin selected by your Frely account configuration. Device access uses Frely Connect and has separate authorization.

```sh
frely api list
frely api list --group agents
frely api list --json
frely api describe agents.create
frely api call agents.list --json '{"page":1,"pageSize":25}'
frely api call usage.summary
frely api call agents.create --input ./agent.json
```

The CLI discovers tool names, input/output schemas and descriptions from the server on each command. Use `describe` to inspect the deployed contract before preparing input. Tool additions do not need a CLI update.

The first `frely api` command opens a browser for separate OAuth authorization. Run it once in a terminal you can type in: scripts and AI tools without a terminal fail immediately with that instruction instead of waiting. If basic login has selected an account, authorize that same account. These credentials use encrypted storage independent of basic and device credentials; `frely logout` also revokes this authorization. `frely item install` uses the same authorization.

`list` prints the operations grouped by area (the part of the tool name before the dot), each area with a one-line description from the server and one line per tool showing read, write or destructive; `--json` prints the full tool list as JSON. `describe` and `call` print JSON. `--json` supplies an input object; `--input` reads an object from a file, up to 512 KiB. An MCP tool error exits with status 2. If the browser authorization does not finish within 5 minutes, or the connection fails, the error states the underlying cause.

Run `frely api list` for the current operations; the server decides which ones this computer may use. A new computer may only read non-sensitive data; for anything else the error links to the web page where you grant it, and actions that move money or change credentials also need a one-time approval there.

Calls can create resources or incur usage. Failed business calls are not automatically replayed. A timeout does not prove that a mutation failed; inspect the account state before issuing another call. For creation, preserve the original idempotency key when reconciling an uncertain result.

New device URLs are `https://mcp.frely.cloud/mcp`. Earlier `connect.frely.cloud/mcp/devices` and `mcp.frely.cloud/mcp/devices` URLs remain valid. The stored address is only a cache: whenever the CLI checks the authorization it adopts the `mcpResource` the relay returns, so upgraded installations print the current address without re-approval.
