# CLI self-upgrade

Status: implemented and verified on macOS 2026-09-17. Approved command simplification and Windows manual-upgrade scope are included.

## User contract

- `frely upgrade` is the only upgrade command. No check, version, force, channel or JSON switches.
- `frely doctor` checks the installed version, installation source and latest stable release. `doctor --json` provides structured diagnostics. Release lookup has a deadline; an unavailable release source is informational and does not break offline diagnostics.
- Update the installation being executed, using its original distribution and prefix. Do not migrate npm, Bun or standalone installations, change PATH, edit project dependencies or repair a package manager's global lockfile.
- macOS/Linux perform supported upgrades. Windows prints an installation-specific PowerShell command; no replacement helper, scheduled upgrade task or new resident updater.
- Source checkouts, local links, temporary runners, unidentified installations, and mismatched background-service paths are not changed. Explain the appropriate manual action.
- Resolve one stable version and pin all downloads/install commands to it. Equal/newer installed versions are no-ops. Verify standalone SHA-256 and startup before replacement. Preserve an old standalone copy until startup succeeds. Package-manager recovery is best effort, not an atomic rollback.

## Service behavior

Preserve credentials, device identity, MCP URL, authorization expiry, workspace and Provider configuration. Restart only a previously active matching service. A stopped/uninstalled service stays stopped/uninstalled. Do not run MCP setup or renew as part of an upgrade.

Already-running managed macOS/Linux services also detect external updates of their own supported installation. They observe stable local file metadata twice, verify the replacement CLI starts, and exit after work and buffered output drain so the existing supervisor loads the replacement. Running calls and managed processes defer this switch without blocking new control calls. The watcher never installs software, edits a service definition, enables a stopped service, or moves between installation paths. It does not run in foreground or source/link installations; Windows remains manual.

Both paths share the maintenance gate. Automatic refresh cannot release the explicit upgrader's gate, and the private endpoint returns busy when automatic refresh owns the gate. Runtime observations advertise refresh support; doctor distinguishes an automatic switch pending completion from a legacy runtime needing manual maintenance.

POSIX services expose a private, process-specific local maintenance socket. The upgrade holds a connection while the service rejects new requests and waits for existing work to finish. Running managed processes or a timeout cancel the upgrade without stopping the service. Closing the maintenance connection resumes admission. This does not add a resident process.

Old services without maintenance support, foreground services and upgrade requests inside the MCP execution being maintained require a local-terminal action. Do not introduce asynchronous remote upgrade jobs. Report the limitation instead of killing the caller or existing work.

Report installation, service startup/version, and Relay connectivity separately. Do not roll back a working installation solely because the network is offline or authorization expired. Add CLI version, launch path and start time to runtime diagnostics. Windows guidance includes the prior service state and tells users to finish work before restarting.

## Verification

Cover installation ownership and custom prefixes; source/link/npx protection; pinned version resolution; checksum failure; startup failure and standalone restore; package-manager failures; maintenance admission and busy processes; active/stopped service restoration; doctor offline behavior; CLI argument rejection. Run type checks, tests and build. Native Windows replacement is outside scope because Windows emits commands only.

## Verification results

- TypeScript check/build and 124 tests passed.
- macOS arm64: packed npm installation, custom-prefix detection, standalone build/startup, and installer checksum rejection passed.
- Windows: generated PowerShell command, original package manager/prefix, quoting and no-mutation behavior tested; commands were not executed on a Windows host.
- Linux: service-command parsing and maintenance behavior covered by tests; native systemd lifecycle remains a platform acceptance check.
- No production installation or live Device Relay service was upgraded during verification. No release was published.

## Seamless service refresh follow-up

Worktree branch: `feat/seamless-service-upgrade-20260917`, based on the committed self-upgrade implementation. No production service is restarted by development or verification.

The first transition from a runtime without refresh support still requires the legacy maintenance procedure. Support becomes active when the updated runtime starts. An installation upgrade does not extend authorization, repair expired OAuth, preserve managed process handles after restart, or promise uninterrupted transport. Unknown-outcome writes are never replayed.

Verification covers stable/partial package replacement, startup rejection, active requests and managed processes, manual stop during verification, maintenance ownership contention, overlapping polls, and runtime diagnostic guidance. Native platform service activation is a separate acceptance check.

Follow-up verification: TypeScript check/build and all 134 tests passed. macOS arm64 standalone compilation and smoke passed without Node/npm/Bun on PATH. No live LaunchAgent, systemd unit, production installation, or active MCP connection was restarted; native Linux/Windows lifecycle acceptance was not performed.
