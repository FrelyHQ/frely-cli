#!/bin/sh
set -eu
umask 077

# --quiet (agents): progress goes to a log that is shown only when the install fails. --email ADDRESS: after installing, send the sign-in code mail.
quiet=0 email=
log="$(mktemp "${TMPDIR:-/tmp}/frely-install-log.XXXXXX")"
fail() {
  if [ "${quiet:-0}" = 1 ] && [ -s "${log:-}" ]; then tail -n 40 "$log" >&2; fi
  printf '%s\n' "frely-cli install failed: $*" >&2; exit 1
}
note() { if [ "$quiet" = 1 ]; then printf "$@" >>"$log"; else printf "$@" >&2; fi; }
while [ $# -gt 0 ]; do
  case "$1" in
    --quiet|-q) quiet=1 ;;
    --email) [ $# -ge 2 ] || fail "--email needs an address."; email="$2"; shift ;;
    --email=*) email="${1#--email=}" ;;
    *) fail "Unknown option: $1 (use --quiet, --email <address>)." ;;
  esac
  shift
done
if [ -n "$email" ]; then
  case "$email" in *[!A-Za-z0-9.@_+-]*|*@*@*|@*|*@|*@*[!.]@*) fail "--email must be a plain address like name@example.com." ;; esac
  case "$email" in *@*.*) [ "${#email}" -le 254 ] || fail "--email is too long." ;; *) fail "--email must be a plain address like name@example.com." ;; esac
fi
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
# downloaded from npmmirror (China CDN) and then npmjs. FRELY_INSTALL_SOURCES narrows or reorders the list; unless it (or
# FRELY_RELEASE_DIR) is set, github and npmmirror are probed in parallel and the faster one goes first (see probe_sources).
package="@frelyhq/cli-$os-$arch$libc"
sources="${FRELY_INSTALL_SOURCES:-github npmmirror npmjs}"
install_dir="${FRELY_INSTALL_DIR:-$HOME/.local/bin}"
case "$install_dir" in /*) ;; *) fail "FRELY_INSTALL_DIR must be an absolute path." ;; esac
[ ! -L "$install_dir" ] || fail "Install directory must not be a symbolic link."
mkdir -p "$install_dir"
[ -w "$install_dir" ] || fail "Install directory is not writable by this user."
# Download into the destination filesystem so replacement uses rename, not a partial copy.
stage="$(mktemp -d "$install_dir/.frely-install.XXXXXX")"
trap 'rm -rf "$stage" "$log"' EXIT HUP INT TERM
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
# GitHub carries each executable gzip-compressed (<asset>.gz); the .sha256 beside it is the checksum of the decompressed file.
# Releases published before gzip assets existed have only the plain executable, so a missing .gz falls back to it.
from_github() {
  if [ "$version" = latest ]; then base="$github/latest/download"; else base="$github/download/v${version#v}"; fi
  fetch "$base/$asset.sha256" "$stage/$asset.sha256" || return 1
  if fetch "$base/$asset.gz" "$stage/$asset.gz"; then
    # Cap the decompressed size (200 MB); a truncated file fails the checksum below.
    gzip -dc "$stage/$asset.gz" | head -c 209715200 > "$stage/$asset"; rm -f "$stage/$asset.gz"
  else
    fetch "$base/$asset" "$stage/$asset" || return 1
  fi
  verify "$stage/$asset" "$stage/$asset.sha256"
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
# probe_sources: rank github and npmmirror by the speed of the first ~2 MB of the real download (4 s for the whole probe).
# A source that delivered nothing counts as failed; both failing keeps the default order. npmjs is never probed and stays last.
probe_one() { # probe_one URL -> "<bytes> <bytes-per-second>"
  curl --silent --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 4 --max-time "${2:-4}" \
    --range 0-1999999 -o /dev/null -w '%{size_download} %{speed_download}' "$1" 2>/dev/null || true
}
probe_speed() { # probe_speed "<bytes> <speed>" -> integer speed, 0 when nothing arrived
  case "$1" in *[!0-9.\ ]*|'') echo 0; return ;; esac
  size="${1%% *}" speed="${1#* }"; size="${size%%.*}" speed="${speed%%.*}"
  case "$size$speed" in *[!0-9]*|'') echo 0; return ;; esac
  if [ "$size" -gt 0 ]; then echo "$speed"; else echo 0; fi
}
probe_github() {
  if [ "$version" = latest ]; then base="$github/latest/download"; else base="$github/download/v${version#v}"; fi
  probe_speed "$(probe_one "$base/$asset.gz")" > "$stage/probe.github"
}
probe_npmmirror() {
  registry=https://registry.npmmirror.com wanted="${version#v}" started="$(date +%s)"
  if [ "$version" = latest ]; then
    curl --silent --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 4 --max-time 4 "$registry/$package/latest" \
      -o "$stage/probe.meta" 2>/dev/null || { echo 0 > "$stage/probe.npmmirror"; return 0; }
    wanted="$(sed -n 's/.*"version": *"\([0-9][0-9.]*\)".*/\1/p' "$stage/probe.meta" | head -n 1)"
  fi
  case "$wanted" in *[!0-9.]*|'') echo 0 > "$stage/probe.npmmirror"; return 0 ;; esac
  left=$((4 - $(date +%s) + started)); [ "$left" -ge 1 ] || left=1
  probe_speed "$(probe_one "$registry/$package/-/${package##*/}-$wanted.tgz" "$left")" > "$stage/probe.npmmirror"
}
probe_sources() {
  [ -z "${FRELY_INSTALL_SOURCES:-}" ] && [ -z "${FRELY_RELEASE_DIR:-}" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  probe_github & probe_npmmirror &
  wait
  github_speed="$(cat "$stage/probe.github" 2>/dev/null || echo 0)" npmmirror_speed="$(cat "$stage/probe.npmmirror" 2>/dev/null || echo 0)"
  case "$github_speed$npmmirror_speed" in *[!0-9]*|'') return 0 ;; esac
  if [ "$npmmirror_speed" -gt "$github_speed" ]; then sources="npmmirror github npmjs"; fi
}
probe_sources
downloaded=
for source in $sources; do
  case "$source" in
    github) from_github 2>/dev/null && downloaded=github ;;
    npmmirror) from_npm https://registry.npmmirror.com 2>/dev/null && downloaded=npmmirror ;;
    npmjs) from_npm https://registry.npmjs.org 2>/dev/null && downloaded=npmjs ;;
    *) fail "Unknown install source: $source (use github, npmmirror, npmjs)." ;;
  esac
  [ -z "$downloaded" ] || break
  rm -rf "$stage/$asset" "$stage/$asset.gz" "$stage/$asset.sha256" "$stage/npm" "$stage/package.tgz" "$stage/meta.json"
  note 'Frely: %s unavailable or failed verification; trying the next source.\n' "$source"
done
[ -n "$downloaded" ] || fail "No source supplied a verified release (checksum mismatch or no connection); installation was not changed."
note 'Frely: using %s\n' "$downloaded"
chmod 755 "$stage/$asset"
"$stage/$asset" --version >/dev/null || fail "The downloaded executable could not run."
[ ! -L "$install_dir/frely" ] || fail "Existing frely is a symbolic link; choose another FRELY_INSTALL_DIR."
mv -f "$stage/$asset" "$install_dir/frely"

# Default user bin becomes available in new shells. Profile edits are best-effort: the
# executable is already installed and a profile policy must not turn that into a failure.
add_user_bin_to_profile() {
  profile="$1"
  if [ -L "$profile" ]; then
    note 'Frely: skipped symbolic-link shell profile: %s\n' "$profile"
    return 0
  fi
  if [ -e "$profile" ] && [ ! -f "$profile" ]; then
    note 'Frely: skipped non-file shell profile: %s\n' "$profile"
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
first_frely="$(command -v frely 2>/dev/null || true)"
if [ -n "$first_frely" ] && [ "$first_frely" != "$install_dir/frely" ]; then
  first_version="$("$first_frely" --version 2>/dev/null || true)"
  new_version="$("$install_dir/frely" --version 2>/dev/null || true)"
  if [ -n "$first_version" ] && [ "$first_version" != "$new_version" ]; then
    printf "Frely: warning: 'frely' on PATH resolves to %s (version %s), not the one just installed (%s). Remove it, put %s first on PATH, or run %s.\n" "$first_frely" "$first_version" "$new_version" "$install_dir" "$install_dir/frely" >&2
  fi
fi
note '%s\n' 'Basic commands require no keyring setup. MCP authorization begins with frely link on.'
case ":${PATH:-}:" in *":$install_dir:"*) ;; *) note 'This terminal can use %s; new shells use frely.\n' "$install_dir/frely" ;; esac
# Sign-in step 1: the mail goes out now so the user only has to read the 6 digits back (finish with: frely login --code <code> --host <host>).
if [ -n "$email" ]; then
  if [ "$quiet" = 1 ]; then "$install_dir/frely" login --email "$email" --no-wait --quiet
  else "$install_dir/frely" login --email "$email" --no-wait; fi || fail "Frely was installed, but the sign-in code could not be sent. Run: $install_dir/frely login --email $email --no-wait"
fi
