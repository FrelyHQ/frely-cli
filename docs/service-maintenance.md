# Device Relay service maintenance

Normal updates on supported macOS/Linux installations preserve device identity, the MCP address, credentials, workspace and authorization expiry. `frely update` restores a matching service that was running. A runtime with automatic refresh support also loads updates made by its original installer at the same path after active work finishes. No extra stop/start commands are part of that normal flow.

## Turning remote control off

```sh
frely link off
frely link status
```

`frely link off` revokes device MCP execution authorization for every client, writes a local lock and uninstalls the background service; when local Providers or background services exist, the service keeps running in standby mode. Only `frely link on` on this computer turns it on again. There is no separate pause command.

Update scripts (`start.sh`, `start.ps1` and the Windows command printed by `frely update`) stop the installed service with the internal `frely mcp service stop` before replacing the binary and start it again with `frely mcp service start`. These internal commands never prompt and are not listed in help.

## One-time transition from older runtimes

An already-running old process cannot gain automatic refresh code merely because files on disk changed. If doctor shows an old runtime without refresh support, finish its tasks, update by running the start script again, which stops the service and starts it on the new binary. Subsequent supported updates handle service switching.

An old service without a private maintenance endpoint also cannot be drained by `frely update`; it gives local-terminal guidance. Do not restart the service through the MCP session that depends on it.

## Boundaries and diagnosis

- `frely doctor` distinguishes the installed CLI version from the observed running service version. A runtime with refresh support reports that it will switch after work finishes and installation passes startup validation.
- Automatic refresh checks every five seconds and requires two matching observations. Missing/changing files or a failing new CLI keep the loaded process running. An external installer owns any repair or rollback of files it replaced.
- Calls, managed processes and buffered response output defer switching. This includes work started through MCP. Persistent tasks can postpone activation until they end; control calls remain available while waiting.
- The transport reconnects using existing identity and authorization. A short disconnection is possible. Heartbeats confirm device-to-Relay transport; verify client OAuth and an end-to-end call separately when diagnosing a failure.
- Runtime restart does not preserve process handles/output stored in the previous runtime, renew expired authorization, or replay writes with unknown outcomes.
- Keep the existing installer and path. Switching npm/Bun/standalone installations, changing Node paths, and source/link or foreground runs require their own maintenance. Setup with the original workspace can regenerate a service definition when the launch path needs changing; routine updates do not run setup or renew.
- Windows `frely update` prints installation-specific PowerShell instructions. Automatic external-install refresh is currently limited to macOS/Linux services.
