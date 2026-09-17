# Frely Cloud

`frely cloud` calls the Frely application's business tools at `https://app.frely.cloud/mcp`. It uses the application origin selected by your Frely account configuration. Device access uses Frely Connect and has separate authorization.

```sh
frely cloud login
frely cloud list
frely cloud list --group agents
frely cloud describe agents.create
frely cloud call agents.list --json '{"page":1,"pageSize":25}'
frely cloud call usage.summary
frely cloud call agents.create --input ./agent.json
frely cloud logout
```

The CLI discovers tool names, input/output schemas and descriptions from the server on each command. Use `describe` to inspect the deployed contract before preparing input. Tool additions do not need a CLI upgrade.

Cloud login opens a browser for separate OAuth authorization. If basic login has selected an account, authorize that same account. Cloud credentials use encrypted storage independent of basic and device credentials; `frely cloud logout` revokes the Cloud authorization. Basic `frely logout` does not replace this command.

`list`, `describe` and `call` print JSON. `--json` supplies an input object; `--input` reads an object from a file, up to 512 KiB. An MCP tool error exits with status 2.

The first catalog includes Agent listing, prompt/Skill creation, publication status changes, publication, invocation, Creator runtime choices and usage summary. Creation requires Creator entitlement and an idempotency key and may incur model planning usage. Invocation uses an existing enabled API key and existing access/funding, and returns a completed result and request ID. Update currently means unpublish or disable.

Calls can create resources or incur usage. Failed business calls are not automatically replayed. A timeout does not prove that a mutation failed; inspect the account state before issuing another call. For creation, preserve the original idempotency key when reconciling an uncertain result.

New device URLs use `connect.frely.cloud`. Existing `mcp.frely.cloud` device URLs remain valid through the compatibility hostname and are not rewritten by this CLI.
