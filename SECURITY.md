# Security policy

Please do not report security vulnerabilities in a public issue or pull
request.

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/FrelyHQ/frely-cli/security/advisories/new>

If private reporting is unavailable, contact the Frely maintainers through a
private support channel and do not include credentials, private MCP URLs,
access tokens, or sensitive workspace contents in the report.

## Scope

Reports about the following areas are especially important:

- account credentials and OS credential-store handling;
- device identity, enrollment, connection grants, and revocation;
- private MCP bearer URLs and Device Relay transport;
- workspace boundary, symlink handling, file writes, and process controls;
- installer, background-service, and release-pipeline behavior.

## Security model

`frely-cli` is a local runtime. Its shell and persistent-process tools execute
with the current OS user's permissions; the selected workspace is a working
directory boundary, not a sandbox. The private MCP URL is a bearer credential
and must be treated like a password. Do not assume that source availability
removes the need to trust the configured Frely Relay deployment.

## Supported versions

Security fixes target the latest released version and the current `main`
branch. Older versions may not receive fixes; update before investigating a
report when possible.
