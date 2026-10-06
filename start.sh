#!/bin/sh
# Install Frely, sign in (the browser page also registers new accounts), then print the MCP URL.
# install.sh stays the install-only script; this one continues into the MCP flow.
set -eu

fail() { printf '%s\n' "frely start failed: $*" >&2; exit 1; }
install_dir="${FRELY_INSTALL_DIR:-$HOME/.local/bin}"

# install.sh next to this file (a checkout, tests); otherwise the copy served beside start.sh.
here=
if [ -f "$0" ]; then here="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || here=; fi
if [ -n "$here" ] && [ -f "$here/install.sh" ]; then
  sh "$here/install.sh"
else
  url="${FRELY_INSTALLER_URL:-https://cli.frely.cloud/install.sh}"
  case "$url" in https://*) ;; *) fail "FRELY_INSTALLER_URL must be an https URL." ;; esac
  if command -v curl >/dev/null 2>&1; then curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 "$url" | sh
  elif command -v wget >/dev/null 2>&1; then wget --https-only --quiet "$url" -O - | sh
  else fail "A system HTTPS downloader (curl or wget) is required."; fi
fi
frely="$install_dir/frely"
[ -x "$frely" ] || fail "Frely was not installed at $frely."

# The next steps need a browser approval and a person at the terminal; `curl | sh` has no stdin, so read the terminal.
if ! (: </dev/tty) 2>/dev/null; then
  printf '%s\n' "No terminal is available here. Run these commands in a terminal:" "  $frely login" "  $frely mcp start" >&2
  exit 0
fi

if ! "$frely" doctor --json 2>/dev/null </dev/null | grep -Eq '"account": ?"[^"]*[Nn]ot logged in'; then
  printf '%s\n' "Frely: already signed in." >&2
else
  printf '%s\n' "Frely: opening the browser to sign in. New to Frely? The same page creates an account." >&2
  "$frely" login </dev/tty
fi

# The workspace is the directory remote clients can reach. Default: where this command ran (never /).
workspace="${FRELY_WORKSPACE:-$(pwd)}"
[ "$workspace" != / ] || workspace="$HOME"
printf '%s\n' "Frely: enabling device MCP for $workspace (add more later with: frely mcp workspace add <path>)." >&2
"$frely" mcp start --workspace "$workspace" </dev/tty
