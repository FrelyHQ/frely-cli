#!/bin/sh
# Install Frely, then `frely link on`: sign in through the browser when needed (the page also registers
# new accounts), approve device MCP and print the MCP URL. install.sh stays the install-only script.
# Safe to re-run: it updates to the latest version and restarts the MCP background service on the new binary.
set -eu

# A pre-login install command passes FRELY_INSTALL_TOKEN (one-time). Only `frely link on` gets it;
# it is unset for the old binary and the installer.
install_token="${FRELY_INSTALL_TOKEN:-}"
unset FRELY_INSTALL_TOKEN

install_dir="${FRELY_INSTALL_DIR:-$HOME/.local/bin}"

# Stop a running background service before replacing the binary, so the restart below runs the new version.
# A failed stop (no service) is ignored; only a successful stop is remembered for resuming.
old="$install_dir/frely"
stopped=0
if [ -x "$old" ] && "$old" mcp stop </dev/null >/dev/null 2>&1; then stopped=1; fi

# Put the service we stopped back, so a failed update does not leave it stopped.
resume() { if [ "$stopped" = 1 ]; then "$old" mcp start --resume </dev/null >/dev/null 2>&1 || :; stopped=0; fi; }
fail() { resume; printf '%s\n' "frely start failed: $*" >&2; exit 1; }

# install.sh next to this file (a checkout, tests); otherwise the copy served beside start.sh.
here=
if [ -f "$0" ]; then here="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || here=; fi
if [ -n "$here" ] && [ -f "$here/install.sh" ]; then
  if ! sh "$here/install.sh"; then fail "install.sh failed."; fi
else
  url="${FRELY_INSTALLER_URL:-https://frely.cloud/install.sh}"
  case "$url" in https://*) ;; *) fail "FRELY_INSTALLER_URL must be an https URL." ;; esac
  if command -v curl >/dev/null 2>&1; then
    if ! curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 "$url" | sh; then fail "installation failed."; fi
  elif command -v wget >/dev/null 2>&1; then
    if ! wget --https-only --quiet "$url" -O - | sh; then fail "installation failed."; fi
  else fail "A system HTTPS downloader (curl or wget) is required."; fi
fi
frely="$install_dir/frely"
[ -x "$frely" ] || fail "Frely was not installed at $frely."

if [ -n "$install_token" ]; then FRELY_INSTALL_TOKEN="$install_token"; export FRELY_INSTALL_TOKEN; fi
# Default workspace: the home directory (credential and start-up files stay protected); FRELY_WORKSPACE picks another.
if [ -n "${FRELY_WORKSPACE:-}" ]; then exec "$frely" mcp start --workspace "$FRELY_WORKSPACE" </dev/null
else exec "$frely" mcp start </dev/null; fi
