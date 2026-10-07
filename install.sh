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
# GitHub first; mainland China and other networks without GitHub fall back to the same build published as an npm package,
# downloaded from npmmirror (China CDN) and then npmjs. FRELY_INSTALL_SOURCES narrows or reorders the list.
package="@frelyhq/cli-$os-$arch$libc"
sources="${FRELY_INSTALL_SOURCES:-github npmmirror npmjs}"
install_dir="${FRELY_INSTALL_DIR:-$HOME/.local/bin}"
case "$install_dir" in /*) ;; *) fail "FRELY_INSTALL_DIR must be an absolute path." ;; esac
[ ! -L "$install_dir" ] || fail "Install directory must not be a symbolic link."
mkdir -p "$install_dir"
[ -w "$install_dir" ] || fail "Install directory is not writable by this user."
# Download into the destination filesystem so replacement uses rename, not a partial copy.
stage="$(mktemp -d "$install_dir/.frely-install.XXXXXX")"
trap 'rm -rf "$stage"' EXIT HUP INT TERM
# fetch URL DESTINATION: a system HTTPS downloader only. A stalled transfer (under 50 KB/s for 20 s) counts as unreachable.
# FRELY_RELEASE_DIR serves a local release directory for tests.
fetch() {
  if [ -n "${FRELY_RELEASE_DIR:-}" ]; then
    cp "$FRELY_RELEASE_DIR/${1##*/}" "$2"
  elif command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 8 --speed-limit 51200 --speed-time 20 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget --https-only --quiet --timeout=20 "$1" -O "$2"
  else fail "A system HTTPS downloader (curl or wget) is required."; fi
}
# verify FILE CHECKSUM_FILE: the executable must match the checksum published beside it.
verify() {
  expected="$(awk 'NR == 1 { print $1 }' "$2")"
  case "$expected" in *[!0-9a-fA-F]*|'') return 1 ;; esac
  [ "${#expected}" -eq 64 ] || return 1
  if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$1" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$1" | awk '{print $1}')"
  else fail "A system SHA-256 verifier is required."; fi
  [ "$actual" = "$expected" ]
}
from_github() {
  if [ "$version" = latest ]; then base="$github/latest/download"; else base="$github/download/v${version#v}"; fi
  fetch "$base/$asset" "$stage/$asset" && fetch "$base/$asset.sha256" "$stage/$asset.sha256" && verify "$stage/$asset" "$stage/$asset.sha256"
}
# from_npm REGISTRY: the package tarball holds package/frely and package/frely.sha256.
from_npm() {
  registry="$1" wanted="${version#v}"
  if [ "$version" = latest ]; then
    fetch "$registry/$package/latest" "$stage/meta.json" || return 1
    wanted="$(sed -n 's/.*"version": *"\([0-9][0-9.]*\)".*/\1/p' "$stage/meta.json" | head -n 1)"
  fi
  case "$wanted" in *[!0-9.]*|'') return 1 ;; esac
  fetch "$registry/$package/-/${package##*/}-$wanted.tgz" "$stage/package.tgz" || return 1
  mkdir -p "$stage/npm" && tar -xzf "$stage/package.tgz" -C "$stage/npm" || return 1
  verify "$stage/npm/package/frely" "$stage/npm/package/frely.sha256" || return 1
  mv -f "$stage/npm/package/frely" "$stage/$asset"
}
downloaded=
for source in $sources; do
  case "$source" in
    github) from_github 2>/dev/null && downloaded=github ;;
    npmmirror) from_npm https://registry.npmmirror.com 2>/dev/null && downloaded=npmmirror ;;
    npmjs) from_npm https://registry.npmjs.org 2>/dev/null && downloaded=npmjs ;;
    *) fail "Unknown install source: $source (use github, npmmirror, npmjs)." ;;
  esac
  [ -z "$downloaded" ] || break
  rm -rf "$stage/$asset" "$stage/$asset.sha256" "$stage/npm" "$stage/package.tgz" "$stage/meta.json"
  printf 'Frely: %s unavailable or failed verification; trying the next source.\n' "$source" >&2
done
[ -n "$downloaded" ] || fail "No source supplied a verified release (checksum mismatch or no connection); installation was not changed."
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
