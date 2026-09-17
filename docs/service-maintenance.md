# Device Relay service maintenance

Normal upgrades on supported macOS/Linux installations preserve device identity, the MCP address, credentials, workspace and authorization expiry. `frely upgrade` restores a matching service that was running. A runtime with automatic refresh support also loads updates made by its original installer at the same path after active work finishes. No extra stop/start commands are part of that normal flow.

## Manual pause and resume

```sh
frely mcp service stop
frely mcp service start
frely doctor
```

Use stop to pause the device's shared remote service and start to resume it. This service also carries any configured local Provider traffic. These commands do not revoke server authorization. Stop is an explicit service operation and can interrupt work; finish tasks before using it. A stopped service is not revived by installation refresh.

`frely mcp service uninstall` removes the background service. `frely mcp revoke` revokes device MCP execution authorization; it is a different operation.

## One-time transition from older runtimes

An already-running old process cannot gain automatic refresh code merely because files on disk changed. If doctor shows an old runtime without refresh support, finish its tasks, update using the original installer and perform one stop/start in a local terminal. Subsequent supported upgrades handle service switching.

An old service without a private maintenance endpoint also cannot be drained by `frely upgrade`; it gives local-terminal guidance. Do not restart the service through the MCP session that depends on it.

## Boundaries and diagnosis

- `frely doctor` distinguishes the installed CLI version from the observed running service version. A runtime with refresh support reports that it will switch after work finishes and installation passes startup validation.
- Automatic refresh checks every five seconds and requires two matching observations. Missing/changing files or a failing new CLI keep the loaded process running. An external installer owns any repair or rollback of files it replaced.
- Calls, managed processes and buffered response output defer switching. This includes work started through MCP. Persistent tasks can postpone activation until they end; control calls remain available while waiting.
- The transport reconnects using existing identity and authorization. A short disconnection is possible. Heartbeats confirm device-to-Relay transport; verify client OAuth and an end-to-end call separately when diagnosing a failure.
- Runtime restart does not preserve process handles/output stored in the previous runtime, renew expired authorization, or replay writes with unknown outcomes.
- Keep the existing installer and path. Switching npm/Bun/standalone installations, changing Node paths, and source/link or foreground runs require their own maintenance. Setup with the original workspace can regenerate a service definition when the launch path needs changing; routine upgrades do not run setup or renew.
- Windows `frely upgrade` prints installation-specific PowerShell instructions. Automatic external-install refresh is currently limited to macOS/Linux services.
