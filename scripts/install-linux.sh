#!/bin/sh
# Installs CRT Terminal on Debian, Ubuntu and derivatives from its APT repository, so `sudo apt upgrade` keeps it up to
# date (docs/packaging.md#apt-repository):
#
#   curl -fsSL https://raw.githubusercontent.com/Kab0tan/custom-retro-term/main/scripts/install-linux.sh | sudo sh
#
# It writes the same two files as the .deb's install script, then installs the package. CRT_TERMINAL_REPO=owner/repo
# points it at a fork.
set -eu

REPO=${CRT_TERMINAL_REPO:-Kab0tan/custom-retro-term}
BASE=https://github.com/$REPO/releases/latest/download
KEYRING=/usr/share/keyrings/crt-terminal-archive-keyring.gpg
SOURCES=/etc/apt/sources.list.d/crt-terminal.sources

fail() {
  echo "crt-terminal: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "run as root: curl -fsSL <this script's URL> | sudo sh"
command -v apt-get >/dev/null 2>&1 || fail "apt not found. On other distributions use the AppImage: https://github.com/$REPO/releases/latest"
ARCH=$(dpkg --print-architecture)
[ "$ARCH" = amd64 ] || fail "no .deb for $ARCH yet. Try the AppImage: https://github.com/$REPO/releases/latest"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO- "$1"; }
else
  fail "needs curl or wget"
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
fetch "$BASE/crt-terminal-archive-keyring.gpg" > "$TMP" || fail "could not download the signing key from $BASE"
[ -s "$TMP" ] || fail "the signing key downloaded from $BASE is empty"
install -D -m 0644 "$TMP" "$KEYRING"

cat > "$SOURCES" <<EOF
Types: deb
URIs: $BASE/
Suites: ./
Signed-By: $KEYRING
EOF
chmod 0644 "$SOURCES"

apt-get update
apt-get install -y crt-terminal
echo "CRT Terminal is installed. Updates come with: sudo apt update && sudo apt upgrade"
