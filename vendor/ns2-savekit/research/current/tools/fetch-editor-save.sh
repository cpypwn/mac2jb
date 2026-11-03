#!/bin/sh
# Fetch the official Seedsow Lua Editor save release (0BSD) and unpack it flat.
#   ./tools/fetch-editor-save.sh /tmp/seed [version]
# Nothing is redistributed by this repository; the zip comes from GitHub.
set -eu
dest=${1:?usage: fetch-editor-save.sh <destination-directory> [version]}
version=${2:-v0.1.2}
url="https://github.com/DialingSpoon527/seedsow-lua-editor/releases/download/${version}/Seedsow-Lua-Editor-Save.zip"
mkdir -p "$dest"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "downloading $url"
curl -fsSL -o "$tmp/save.zip" "$url"
unzip -oq "$tmp/save.zip" -d "$dest"
count=$(find "$dest" -maxdepth 1 -type f ! -name '.*' | wc -l | tr -d ' ')
echo "unpacked $count files into $dest"
echo "next: python3 tools/build-editor-manifest.py $dest <backup-directory> staging/manifest.json"
