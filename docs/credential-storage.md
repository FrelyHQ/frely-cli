# Two-tier credentials and MCP authorization

Status: implementation in the two-tier-auth worktree. Package publication, artifact signing, release upload and server deployment are separate operations.

## Layer one: basic features

Installation, help, version, base diagnostics, account sessions, Network sessions and Provider identity do not initialize the MCP secure store. The standalone build includes its runtime. The npm package requires Node.js 22 or newer and supports dependency installation with lifecycle scripts disabled.

Basic records use `frely/basic-credentials-v1` below `XDG_CONFIG_HOME`, or `~/.config`. Files are plaintext JSON. Directory protection uses owner permissions on POSIX and a current-user ACL on Windows. These permissions do not protect against a compromised OS user, administrator, readable backup or endpoint malware.

Only these namespaces enter basic storage:

| Namespace | Purpose |
| --- | --- |
| `frely-cli-basic-v1` | Restricted account access/refresh tokens |
| `frely-network` | Origin-scoped Network session |
| `frely-cli-provider-device-v1` | Provider/device transport identity; not an MCP execution key |

The account OAuth client is `frely-cli-basic`. Its scopes cover identity/profile and Provider device transport. A bearer session cannot use Owner routes, account-security changes, billing mutations, API-key export or an operation without an explicit allowed scope. A basic session can request an MCP authorization and revoke its own authorization, but cannot approve it.

Old account cookies and old `frely-cli` secure-store records do not migrate to plaintext. Upgrading requires a basic login. The old files and credential entries remain untouched. Existing Provider/device configurations may need rebinding because the new basic device identity has a separate namespace.

## Layer two: local MCP execution

`frely mcp` and `frely mcp setup` initialize the MCP store and create a separate Ed25519 key. The CLI persists that key before opening the approval page. The page displays the device, key fingerprint, workspace, permissions and duration. Approval needs an account cookie and a user action; a basic bearer token is rejected even when accompanied by a cookie.

| Rule | Value |
| --- | --- |
| Default authorization | 90 days |
| Accepted duration | 1–180 whole days |
| Approval request window | 15 minutes |
| Start time | Server approval time |
| End time | Approval time + requested days × 24 hours |
| Refresh, restart, reinstall | No extension |
| Repeated approval | Same record and end time |
| Renewal | New approval and key; stable device MCP URL; prior grant revoked |

The secure namespace is `frely-cli-mcp-authorization-v1`. It contains the MCP execution private key and the authorization metadata binding. `frely/mcp-v1/authorization.json` contains the public projection; it contains no private key or remote OAuth token. Changes to that projection cannot extend the protected grant.

MCP storage modes:

| Setting | Behavior |
| --- | --- |
| `FRELY_CREDENTIAL_STORE=auto` | System master key unless `FRELY_CREDENTIAL_KEY` is supplied |
| `FRELY_CREDENTIAL_STORE=system` | System master key |
| `FRELY_CREDENTIAL_STORE=encrypted-file` | Injected master key required |

System mode uses macOS Keychain, Windows Credential Manager or Linux Secret Service to protect a 32-byte random master key. AES-256-GCM files contain the MCP secrets. Linux system mode requires `secret-tool`, a D-Bus session and an unlocked Secret Service.

Headless deployments can inject `FRELY_CREDENTIAL_KEY`, a 32-byte random key represented as 64 hexadecimal characters. The CLI does not write this key beside the ciphertext, in a service definition, in command arguments or in logs. The deployment must supply the same key to its background process. Setting the key in an interactive shell does not provision a service secret. Loss of the key requires new authorization; ciphertext is not overwritten with a replacement key.

There is no plaintext fallback for MCP. Failure of this store does not affect layer one. Selecting another secure backend does not migrate existing grants between backends.

## Enforcement and lifecycle

The Relay checks the OAuth access token, exact MCP resource binding, device ownership and active execution authorization before forwarding a request. A WebSocket connection requires a second signature from the MCP execution key to gain execution capability. A Provider signature does not grant that capability. Forwarded MCP requests carry the authorization ID, and the CLI checks it against the active local lease.

The CLI checks the lease before queued work starts. A running lease uses wall time and elapsed time; startup checks the server. Timers use bounded chunks rather than one 90-day timeout. Expiry cancels MCP requests and closes the managed process set. Relay revocation checks notify connected clients without removing Provider capability. The stdio entry point uses the same authorization gate and polls the server.

Completed writes are not rolled back. An arbitrary shell command can create effects or detached processes outside the managed process set. Workspace selection is not a shell sandbox. Same-user malware and administrators are outside this credential boundary.

`frely mcp status` reads local metadata and does not access a keyring; it is not proof that the server still accepts a grant. `frely doctor --mcp` checks the protected credential and server state. `frely doctor` treats an unconfigured MCP as optional.

## Commands

```sh
frely login
frely doctor
frely mcp setup --workspace /path/to/project
frely mcp setup --workspace /path/to/project --days 180
frely mcp renew --days 180
frely mcp status --json
frely doctor --mcp
frely mcp url
frely mcp revoke
```

A valid setup without renewal does not extend the grant. Selecting another workspace requires a new approval. Renewal rotates the MCP execution key and preserves the device-bound MCP URL. Remote MCP OAuth credentials have a separate lifecycle and cannot extend the local execution grant.

A failed or interrupted approval can be retried with setup. The server caps pending requests at eight per user and expires them after 15 minutes. Pending secure records are not a permission to execute. This implementation does not resume an interrupted pending request from another CLI invocation.

## Installation and service distribution

`install.sh` and `install.ps1` consume standalone release artifacts and SHA-256 manifests from `FrelyHQ/frely-cli`. They install in the user's directory without Node/npm, root/admin elevation, keyring setup, dependency lifecycle scripts or an execution-policy override. `FRELY_RELEASE_DIR` selects an offline artifact directory; `FRELY_INSTALL_DIR` selects the user installation path.

Checksum comparison detects corruption or a mismatched artifact/manifest pair. It does not replace release signing or authenticate a compromised release publisher. macOS signing/notarization and Windows signing require a release procedure and platform verification. The patch does not bypass Gatekeeper, SmartScreen or enterprise policy.

The default POSIX installation path is `~/.local/bin`. The installer adds this path to supported shell profiles when needed. An existing parent shell keeps its original PATH; it can invoke the printed executable path. Windows updates the current process PATH and user PATH. Neither installer edits a system PATH.

Services use macOS LaunchAgents, Linux systemd user units or a Windows Task Scheduler entry for the logged-on user. They receive the config directory and credential mode, not the external master key. A Provider-only process does not require an MCP lease. Windows tasks and native credential operations require Windows acceptance tests; renderer/protocol tests do not prove OS behavior.

## Rollout

Deploy the additive database migration, matching Web authorization endpoints, OAuth Authorization Server, OAuth-protected MCP ingress and Device Relay enforcement before making the new CLI the supported client. A mixed deployment is not an accepted authorization configuration. Old private MCP URLs receive no implicit OAuth access. Existing users perform a basic login and MCP approval; no grant is created from a legacy cookie or device key.

Standalone CI produces unsigned verification artifacts. Uploading signed, verified artifacts to the public release is a release task, not an effect of running the tests or this patch.
