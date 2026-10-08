#!/usr/bin/env bash
# APT repository for the .deb, served straight from GitHub Releases (docs/packaging.md#apt-repository).
#
# apt reads a "flat" repository at https://github.com/<owner>/<repo>/releases/latest/download/: each release carries the
# .deb plus Packages, Release, InRelease and Release.gpg, and GitHub redirects /latest/download/<file> to the newest
# release. Run by .github/workflows/release.yml; needs gpg, and apt-ftparchive (apt-utils) for `index`.
#
#   scripts/apt-repo.sh package-files <dir>    keyring + source entry that the .deb's install script registers
#   scripts/apt-repo.sh index <deb-dir> <dir>  signed repository metadata for the .deb files in <deb-dir>
#
# Environment: APT_SIGNING_KEY (ASCII-armored private key), APT_SIGNING_KEY_PASSPHRASE (optional),
# GITHUB_REPOSITORY (owner/repo, set by GitHub Actions).
set -euo pipefail

KEYRING=crt-terminal-archive-keyring.gpg

case "${1:-}" in
  package-files | index) ;;
  *) sed -n '2,12p' "$0" >&2; exit 1 ;;
esac
: "${APT_SIGNING_KEY:?APT_SIGNING_KEY is not set}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set (owner/repo)}"

# Throwaway gpg home holding just the signing key.
GNUPGHOME=$(mktemp -d)
export GNUPGHOME
trap 'gpgconf --kill all >/dev/null 2>&1 || true; rm -rf "$GNUPGHOME"' EXIT
printf '%s\n' "$APT_SIGNING_KEY" | gpg --batch --quiet --import
KEY_ID=$(gpg --batch --list-secret-keys --with-colons | awk -F: '$1 == "fpr" { print $10; exit }')

sign() {
  gpg --batch --yes --pinentry-mode loopback --passphrase "${APT_SIGNING_KEY_PASSPHRASE:-}" --local-user "$KEY_ID" "$@"
}

case "${1:-}" in
  package-files)
    out=${2:?usage: apt-repo.sh package-files <dir>}
    mkdir -p "$out"
    gpg --batch --export "$KEY_ID" > "$out/$KEYRING"
    cat > "$out/crt-terminal.sources" <<EOF
Types: deb
URIs: https://github.com/$GITHUB_REPOSITORY/releases/latest/download/
Suites: ./
Signed-By: /usr/share/keyrings/$KEYRING
EOF
    ;;

  index)
    debs=${2:?usage: apt-repo.sh index <deb-dir> <dir>}
    out=${3:?usage: apt-repo.sh index <deb-dir> <dir>}
    mkdir -p "$out"
    cp "$debs"/*.deb "$out"/
    cd "$out"
    apt-ftparchive packages . > Packages
    gzip -9 -k -f Packages
    # Written outside the folder first: apt-ftparchive would otherwise list Release in itself.
    apt-ftparchive \
      -o APT::FTPArchive::Release::Origin="CRT Terminal" \
      -o APT::FTPArchive::Release::Label="CRT Terminal" \
      -o APT::FTPArchive::Release::Architectures="$(for f in ./*.deb; do dpkg-deb --field "$f" Architecture; done | sort -u | xargs)" \
      release . > ../Release.tmp
    mv ../Release.tmp Release
    sign --clearsign --output InRelease Release
    sign --armor --detach-sign --output Release.gpg Release
    gpg --batch --export "$KEY_ID" > "$KEYRING"
    rm ./*.deb # already in the release, uploaded by electron-builder
    ;;
esac
