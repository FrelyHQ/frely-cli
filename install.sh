#!/bin/sh
set -eu

PACKAGE="${FRELY_CLI_PACKAGE:-frely-cli@${FRELY_CLI_VERSION:-latest}}"

fail() {
  printf '%s\n' "frely-cli install failed: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js 22 or newer is required; found $(node --version)."

NPM_MAJOR="$(npm --version | cut -d. -f1)"
printf 'Installing %s...\n' "$PACKAGE"
if [ "$NPM_MAJOR" -ge 11 ]; then
  npm install --global --allow-scripts=keytar "$PACKAGE"
else
  npm install --global "$PACKAGE"
fi

command -v frely >/dev/null 2>&1 || fail "npm installed the package but the frely command is not on PATH."
printf '%s\n' "Installed frely $(frely --version)."
printf '%s\n' "Next: run 'frely login', then 'frely mcp setup --workspace <path>'."
