# frely.agent-host.v1

`frely.agent-host.v1` is the local contract between the frely CLI (the agent
host supervisor) and the Pi Node agent host process that ships inside the Frely
App Runtime Capsule. This document describes the wire format only.

## Transport

- The CLI spawns the agent host entry point as a child process and creates one
  extra duplex pipe (file descriptor 3 on POSIX, the corresponding stdio handle
  on Windows). The pipe carries the whole protocol.
- A one-time connection key is passed to the child through the
  `FRELY_AGENT_HOST_KEY` environment variable. The first message from the CLI
  is a JSON-RPC request whose params include `connectionKey`; a mismatching key
  must close the connection immediately.
- Frames are NDJSON: one JSON-RPC 2.0 object per `\n`-terminated line, UTF-8,
  maximum 1 MiB per line. The pipe is reserved for the protocol; diagnostics
  must never be written to it.
- Both peers act as JSON-RPC client and server on the same connection: the CLI
  sends task lifecycle requests, the host sends `tool.*` requests and
  `task.event` notifications.

## Handshake

```json
--> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"cliVersion":"0.8.0","connectionKey":"…","capabilities":["tasks","tools"]}}
<-- {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"hostVersion":"0.1.0","capabilities":["tasks","tools"]}}
--> {"jsonrpc":"2.0","method":"initialized","params":{}}
```

Mismatched major `protocolVersion` fails the handshake with error code
`-32000` and the child exits. Until `initialized` arrives no other messages
may be sent.

## CLI → host methods

| Method | Params | Notes |
| --- | --- | --- |
| `task.start` | `{taskId, worktreePath, goal, model?, budgetUsd, baseBranch, baseCommit}` | Starts one agent task rooted at the worktree. |
| `task.message` | `{taskId, message}` | Appends user input. Only valid while running/waiting. |
| `task.cancel` | `{taskId, reason}` | Best-effort cancellation; host settles with a `status` event. |
| `session.dispose` | `{taskId}` | Releases host-side session state for a finished task. |
| `host.shutdown` | `{}` | Graceful exit; the host finishes writing state first. |
| `model.credentials` (notification) | `{apiKey, baseUrl, model}` | Model credentials for the Frely cloud provider. Memory only: the host must never persist or log these values. |

## Host → CLI methods

Tool requests always carry `taskId`; the CLI executes them inside that task's
worktree under the workspace scheduler and sandbox.

| Method | Params |
| --- | --- |
| `tool.read` | `{taskId, path}` |
| `tool.write` | `{taskId, path, content, overwrite?}` |
| `tool.edit` | `{taskId, path, edits: [{startLine, endLine, replacement}], expectedSha256?}` |
| `tool.bash` | `{taskId, command, cwd?, timeoutMs?}` |
| `tool.grep` | `{taskId, query, path?, regex?, caseSensitive?, maxResults?, contextLines?}` |
| `tool.find` | `{taskId, pattern, path?, maxResults?}` |
| `tool.ls` | `{taskId, path?}` |

Read-only operations may run concurrently; writes, shell commands, and unknown
side effects are serialized per task.

## Host → CLI notifications

`task.event` carries one event object:

```json
{"jsonrpc":"2.0","method":"task.event","params":{"taskId":"at_…","event":{"type":"status","status":"running"}}}
```

| Event | Fields | Meaning |
| --- | --- | --- |
| `status` | `status: running \| waiting_input \| completed \| failed \| cancelled`, `detail?` | Terminal statuses settle the task. |
| `message` | `role: assistant \| user \| system`, `text`, `partial?` | Conversation output; `partial: true` marks streaming chunks. |
| `tool_call` | `tool`, `summary`, `state: started \| finished \| failed` | Tool activity summary. |
| `usage` | `inputTokens`, `outputTokens`, `costUsd` | Cumulative usage; the CLI enforces the budget. |
| `log` | `text` | Bounded diagnostic line. |

## Errors

Standard JSON-RPC error codes plus `-32000` (handshake/protocol violations).
Tool execution failures are method results with `ok: false, error: {code,
message}` so the host can feed them back to the model.
