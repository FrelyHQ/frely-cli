#!/bin/sh
# Install Frely, then `frely mcp start`: sign in through the browser when needed (the page also registers
# new accounts), approve device MCP and print the MCP URL. install.sh stays the install-only script.
set -eu

fail() { printf '%s\n' "frely start failed: $*" >&2; exit 1; }
install_dir="${FRELY_INSTALL_DIR:-$HOME/.local/bin}"

# install.sh next to this file (a checkout, tests); otherwise the copy served beside start.sh.
here=
if [ -f "$0" ]; then here="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || here=; fi
if [ -n "$here" ] && [ -f "$here/install.sh" ]; then
  sh "$here/install.sh"
else
  url="${FRELY_INSTALLER_URL:-https://frely.cloud/install.sh}"
  case "$url" in https://*) ;; *) fail "FRELY_INSTALLER_URL must be an https URL." ;; esac
  if command -v curl >/dev/null 2>&1; then curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 "$url" | sh
  elif command -v wget >/dev/null 2>&1; then wget --https-only --quiet "$url" -O - | sh
  else fail "A system HTTPS downloader (curl or wget) is required."; fi
fi
frely="$install_dir/frely"
[ -x "$frely" ] || fail "Frely was not installed at $frely."

# Default workspace: the home directory (credential and start-up files stay protected); FRELY_WORKSPACE picks another.
if [ -n "${FRELY_WORKSPACE:-}" ]; then exec "$frely" mcp start --workspace "$FRELY_WORKSPACE" </dev/null
else exec "$frely" mcp start </dev/null; fi
