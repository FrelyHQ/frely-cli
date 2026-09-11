#!/bin/sh
set -eu

VERSION="0.3.0"
SHA256="377a759dfb0eeb027cdc1ba1869657e81b524b99e4623ee915232a4260e581dd"
ARTIFACT_BASE_URL="${FRELY_CLI_ARTIFACT_BASE_URL:-https://app.frely.cloud/downloads/frely-cli}"
ARTIFACT_URL="${ARTIFACT_BASE_URL}/frely-cli-${VERSION}.tgz"

fail() {
  printf '%s\n' "frely-cli install failed: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js 22 or newer is required; found $(node --version)."

if [ -n "${FRELY_CLI_PACKAGE:-}" ]; then
  printf 'Installing %s...\n' "$FRELY_CLI_PACKAGE"
  npm install --global "$FRELY_CLI_PACKAGE"
else
  command -v curl >/dev/null 2>&1 || fail "curl is required."
  TMP="$(mktemp -t frely-cli.XXXXXX.tgz)"
  trap 'rm -f "$TMP"' EXIT HUP INT TERM
  printf 'Downloading Frely CLI %s...\n' "$VERSION"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --output "$TMP" "$ARTIFACT_URL"

  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_SHA256="$(sha256sum "$TMP" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL_SHA256="$(shasum -a 256 "$TMP" | awk '{print $1}')"
  else
    fail "sha256sum or shasum is required."
  fi
  [ "$ACTUAL_SHA256" = "$SHA256" ] || fail "artifact checksum mismatch."

  NPM_MAJOR="$(npm --version | cut -d. -f1)"
  if [ "$NPM_MAJOR" -ge 11 ]; then
    npm install --global --allow-scripts=keytar "$TMP"
  else
    npm install --global "$TMP"
  fi
fi

command -v frely >/dev/null 2>&1 || fail "npm installed the package but the frely command is not on PATH."
printf '%s\n' "Installed frely $(frely --version)."
printf '%s\n' "Next: run 'frely login', then 'frely mcp setup --workspace <path>'."
