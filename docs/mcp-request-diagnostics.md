# MCP request isolation and diagnostics

The Device Relay multiplexes independent HTTP clients over one device connection.
Client JSON-RPC IDs are only unique within a client, so they must not be used as
the shared runtime's pending-request key.

Each invocation now has three identifiers:

- The original client ID, preserved exactly (including string/number type) in the response.
- The unique outer Device Relay request ID, used for cancellation and log correlation.
- A fresh internal JSON-RPC ID, used by the MCP SDK and discarded after completion.

Fresh internal IDs also prevent late cancelled responses from resolving a later
request if an outer ID is reused. Cancellation removes only the addressed request,
notifies the SDK and passes its abort signal to command execution. Queued operations
check cancellation before starting. File operations already in progress can still
complete, so cancellation does not prove that a mutation had no effect.

This stateless endpoint has no authenticated per-client namespace for a raw
`notifications/cancelled.params.requestId`. Such notifications are ignored rather
than cancelling a different client's request. The supported cancellation path is
closing the original HTTP request: the Relay sends a cancel envelope carrying its
unique outer request ID. MCP clients using a direct stdio connection retain SDK
cancellation behavior.

## Logs

The existing service log destination is unchanged. On macOS the default is
`~/.local/state/frely/mcp.log`. New lines are JSON objects containing an ISO UTC
timestamp, process ID and event name. Historical plain-text lines may remain.

Request events include `mcp.request_started`, `mcp.request_completed`,
`mcp.tool_failed`, `mcp.request_failed` and `mcp.request_cancelled`. The outer
`requestId` links them to Relay requests. Completion records include duration and
`ok`, `tool_error` or `protocol_error`; protocol errors also include their numeric
JSON-RPC error code. Connection, authorization, frame and response failures have
separate `relay.*` events.

Failures record allowlisted error names/codes/messages and up to 20 stack locations.
Arbitrary exception messages and outside-package stack locations are withheld.
Command arguments, file contents, tool output, original client IDs, credentials,
headers and nested error properties are not serialized into diagnostic logs.
This intentionally trades some free-form error detail for safe persistent logging.

To investigate a failed call, find its `mcp.request_started` record and follow the
same `requestId`. If no local start record exists, inspect the upstream Relay and
connector logs. A completed local request without a client response does not prove
delivery; inspect response/connection errors as well. Do not automatically retry
mutating commands after a lost response.

The running background process must be restarted after installing a new build.
Confirm a new `relay.started` / `relay.connected` pair with a new PID before testing.
