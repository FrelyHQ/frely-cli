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
github="https://github.com/FrelyHQ/frely-cli/releases"
mirror="${FRELY_RELEASE_MIRROR:-https://dl.frely.cloud/cli}"
case "$mirror" in off|https://*) ;; *) fail "FRELY_RELEASE_MIRROR must be an https URL or off." ;; esac
install_dir="${FRELY_INSTALL_DIR:-$HOME/.local/bin}"
case "$install_dir" in /*) ;; *) fail "FRELY_INSTALL_DIR must be an absolute path." ;; esac
[ ! -L "$install_dir" ] || fail "Install directory must not be a symbolic link."
mkdir -p "$install_dir"
[ -w "$install_dir" ] || fail "Install directory is not writable by this user."
# Download into the destination filesystem so replacement uses rename, not a partial copy.
stage="$(mktemp -d "$install_dir/.frely-install.XXXXXX")"
trap 'rm -rf "$stage"' EXIT HUP INT TERM
# fetch URL DESTINATION: a system HTTPS downloader only; FRELY_RELEASE_DIR serves a local release directory for tests.
fetch() {
  if [ -n "${FRELY_RELEASE_DIR:-}" ]; then
    cp "$FRELY_RELEASE_DIR/${1##*/}" "$2"
  elif command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 10 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget --https-only --quiet --timeout=20 "$1" -O "$2"
  else fail "A system HTTPS downloader (curl or wget) is required."; fi
}
# verify_release: the downloaded executable must match the checksum published beside it.
verify_release() {
  expected="$(awk 'NR == 1 { print $1 }' "$stage/$asset.sha256")"
  case "$expected" in *[!0-9a-fA-F]*|'') return 1 ;; esac
  [ "${#expected}" -eq 64 ] || return 1
  if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$stage/$asset" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$stage/$asset" | awk '{print $1}')"
  else fail "A system SHA-256 verifier is required."; fi
  [ "$actual" = "$expected" ]
}
# The static mirror is reachable from mainland China; any mirror problem (lookup, download, checksum) falls back to GitHub as a whole.
downloaded=
if [ "$mirror" != off ] && [ -z "${FRELY_RELEASE_DIR:-}" ]; then
  mirror="${mirror%/}"
  mirror_version="${version#v}"
  if [ "$version" = latest ]; then
    mirror_version=
    if fetch "$mirror/latest" "$stage/latest" 2>/dev/null; then mirror_version="$(awk 'NR == 1 { print $1 }' "$stage/latest")"; fi
    case "$mirror_version" in *[!0-9.]*|'') mirror_version= ;; esac
  fi
  if [ -n "$mirror_version" ] && fetch "$mirror/v$mirror_version/$asset" "$stage/$asset" 2>/dev/null && fetch "$mirror/v$mirror_version/$asset.sha256" "$stage/$asset.sha256" 2>/dev/null && verify_release 2>/dev/null; then
    downloaded=1
  else rm -f "$stage/$asset" "$stage/$asset.sha256"; fi
fi
if [ -z "$downloaded" ]; then
  if [ "$version" = latest ]; then base="$github/latest/download"; else base="$github/download/v${version#v}"; fi
  fetch "$base/$asset" "$stage/$asset"
  fetch "$base/$asset.sha256" "$stage/$asset.sha256"
  verify_release || fail "Release checksum mismatch or invalid; installation was not changed."
fi
chmod 755 "$stage/$asset"
"$stage/$asset" --version >/dev/null || fail "The downloaded executable could not run."
[ ! -L "$install_dir/frely" ] || fail "Existing frely is a symbolic link; choose another FRELY_INSTALL_DIR."
mv -f "$stage/$asset" "$install_dir/frely"

# Default user bin becomes available in new shells. Profile edits are best-effort: the
# executable is already installed and a profile policy must not turn that into a failure.
add_user_bin_to_profile() {
  profile="$1"
  if [ -L "$profile" ]; then
    printf 'Frely: skipped symbolic-link shell profile: %s\n' "$profile" >&2
    return 0
  fi
  if [ -e "$profile" ] && [ ! -f "$profile" ]; then
    printf 'Frely: skipped non-file shell profile: %s\n' "$profile" >&2
    return 0
  fi
  if grep -Fq '# Frely user bin' "$profile" 2>/dev/null; then return 0; fi
  if ! printf '\n%s\n%s\n' '# Frely user bin' 'export PATH="$HOME/.local/bin:$PATH"' >> "$profile"; then
    printf 'Frely: could not update shell profile: %s\n' "$profile" >&2
  fi
}
if [ "$install_dir" = "$HOME/.local/bin" ] && [ "${FRELY_INSTALL_NO_PROFILE:-0}" != 1 ]; then
  case ":${PATH:-}:" in *":$install_dir:"*) ;; *)
    case "${SHELL##*/}" in
      zsh) add_user_bin_to_profile "$HOME/.zshrc" ;;
      bash)
        add_user_bin_to_profile "$HOME/.bashrc"
        if [ -e "$HOME/.bash_profile" ]; then add_user_bin_to_profile "$HOME/.bash_profile"
        elif [ -e "$HOME/.bash_login" ]; then add_user_bin_to_profile "$HOME/.bash_login"
        else add_user_bin_to_profile "$HOME/.profile"; fi
        ;;
      *) add_user_bin_to_profile "$HOME/.profile" ;;
    esac
  ;; esac
fi
printf 'Installed Frely %s at %s\n' "$("$install_dir/frely" --version)" "$install_dir/frely"
printf '%s\n' 'Basic commands require no keyring setup. MCP authorization begins with frely mcp start.'
case ":${PATH:-}:" in *":$install_dir:"*) ;; *) printf 'This terminal can use %s; new shells use frely.\n' "$install_dir/frely" ;; esac
