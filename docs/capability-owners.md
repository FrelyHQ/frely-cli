# Capability owners

Each capability below has one implementation. Before adding code that does something on this list, use the owner. Add a new capability to the table in the same change that introduces it. If an owner cannot do what you need, extend the owner instead of writing a second version beside it.

| Capability | Owner | Notes |
| --- | --- | --- |
| Account sign-in (browser device code, email code, resuming a stopped login) | `src/auth.ts` (`loginDevice`, `finishDeviceLogin`, `resumeDeviceLogin`, `initEmailDeviceLogin`) | Produces the basic account session only. It cannot control devices or call account tools. |
| Controlling devices and calling FrelyMCP or account tools (`frely devices/run/read/edit/permission`, `frely api`, Cloud item commands) | `src/controller/session.ts` (sign-in, tokens, refresh) and `src/controller/client.ts` (`openController`, calls, exit codes) | One approval per computer, tokens bound to the DPoP key. New commands that need FrelyMCP or Cloud tools call `openController`. Do not add another OAuth client, loopback listener or token store. |
| Authorizing this computer as a controlled device (device MCP grant) | `src/mcp-authorization.ts` | A different direction from the controller: this computer is the one being controlled. |
| Storing credentials | `src/credential-store.ts` and its `credential-*.ts` backends | Documented in `docs/credential-storage.md`. Callers choose a service name and never touch files or the keychain directly. |
| Device registration and calls to the relay | `src/device/control.ts` (`ensureDevice`, `relayFetch`) | |
| Opening a verification link in the browser | `src/auth.ts` (`openVerificationUrl`) | Honors `--no-browser` and `FRELY_NO_BROWSER`. |
| Waiting for an owner approval and then continuing | `src/controller/client.ts` (approval outcome, exit code 3) and `frely permission wait` | Known overlap: `waitForApproval` in `src/cloud.ts` (used by `frely api call --wait`) is a second wait loop. Fold it into this owner instead of copying it. |
| Running commands in the sandbox | `src/runtime/sandbox.ts`, `src/runtime/process-manager.ts` | |
| File transfer between devices | `src/runtime/transfer.ts`, `src/runtime/p2p.ts` | |
| Public link to a local web page | `src/share/` | |
| Sharing a model or service | `src/provider/` | |

`src/boundary.test.ts` already keeps the controller and the controlled side from importing each other. Keep new code on the right side of it.
