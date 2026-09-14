#!/bin/sh
set -eu
umask 077

fail() { printf '%s\n' "frely-cli install failed: $*" >&2; exit 1; }
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail "Use install.ps1 on Windows." ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) fail "This CPU architecture has no Frely release artifact." ;; esac
libc=
if [ "$os" = linux ] && command -v ldd >/dev/null 2>&1; then
  case "$(ldd --version 2>&1 || true)" in *musl*) libc=-musl ;; esac
fi
asset="frely-$os-$arch$libc"
version="${FRELY_CLI_VERSION:-latest}"
case "$version" in *[!0-9A-Za-z._-]*|'') fail "Invalid release version." ;; esac
base="https://github.com/FrelyHQ/frely-cli/releases/latest/download"
if [ "$version" != latest ]; then base="https://github.com/FrelyHQ/frely-cli/releases/download/v${version#v}"; fi
install_dir="${FRELY_INSTALL_DIR:-$HOME/.local/bin}"
case "$install_dir" in /*) ;; *) fail "FRELY_INSTALL_DIR must be an absolute path." ;; esac
[ ! -L "$install_dir" ] || fail "Install directory must not be a symbolic link."
mkdir -p "$install_dir"
[ -w "$install_dir" ] || fail "Install directory is not writable by this user."
# Download into the destination filesystem so replacement uses rename, not a partial copy.
stage="$(mktemp -d "$install_dir/.frely-install.XXXXXX")"
trap 'rm -rf "$stage"' EXIT HUP INT TERM
fetch() {
  if [ -n "${FRELY_RELEASE_DIR:-}" ]; then
    cp "$FRELY_RELEASE_DIR/$1" "$stage/$1"
  elif command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 "$base/$1" -o "$stage/$1"
  elif command -v wget >/dev/null 2>&1; then
    wget --https-only --quiet "$base/$1" -O "$stage/$1"
  else fail "A system HTTPS downloader (curl or wget) is required."; fi
}
fetch "$asset"
fetch "$asset.sha256"
expected="$(awk 'NR == 1 { print $1 }' "$stage/$asset.sha256")"
case "$expected" in *[!0-9a-fA-F]*|'') fail "Invalid release checksum." ;; esac
[ "${#expected}" -eq 64 ] || fail "Invalid release checksum length."
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$stage/$asset" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$stage/$asset" | awk '{print $1}')"
else fail "A system SHA-256 verifier is required."; fi
[ "$actual" = "$expected" ] || fail "Release checksum mismatch; installation was not changed."
chmod 755 "$stage/$asset"
"$stage/$asset" --version >/dev/null || fail "The downloaded executable could not run."
[ ! -L "$install_dir/frely" ] || fail "Existing frely is a symbolic link; choose another FRELY_INSTALL_DIR."
mv -f "$stage/$asset" "$install_dir/frely"

# Default user bin becomes available in new login shells. Do not edit other users or system files.
if [ "$install_dir" = "$HOME/.local/bin" ] && [ "${FRELY_INSTALL_NO_PROFILE:-0}" != 1 ]; then
  case ":${PATH:-}:" in *":$install_dir:"*) ;; *)
    for profile in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zprofile" "$HOME/.zshrc"; do
      [ ! -L "$profile" ] || fail "Shell profile is a symbolic link; installation remains at $install_dir/frely."
      if ! grep -Fq '# Frely user bin' "$profile" 2>/dev/null; then
        printf '\n%s\n%s\n' '# Frely user bin' 'export PATH="$HOME/.local/bin:$PATH"' >> "$profile"
      fi
    done
  ;; esac
fi
printf 'Installed Frely %s at %s\n' "$("$install_dir/frely" --version)" "$install_dir/frely"
printf '%s\n' 'Basic commands require no keyring setup. MCP authorization begins with frely mcp.'
case ":${PATH:-}:" in *":$install_dir:"*) ;; *) printf 'This terminal can use %s; new shells use frely.\n' "$install_dir/frely" ;; esac
