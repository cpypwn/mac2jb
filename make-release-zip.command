#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
for path in vendor/libusbd/Makefile vendor/macos_usb_gadget_poc/README.md vendor/ns2jb/run.cjs assets/bootstrap.bas assets/bootstrap.bas.sha256 upstream.lock; do
  [[ -e "$path" ]] || { echo "Missing bundled item: $path" >&2; exit 1; }
done
shasum -a 256 -c assets/bootstrap.bas.sha256
[[ ! -e vendor/.git ]] || { echo 'Nested Git metadata detected' >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/mac2jb"
for item in README.md LICENSE .gitignore Makefile sender.c indent-test.bas upstream.lock make-release-zip.command scripts assets vendor; do
  cp -R "$item" "$TMP/mac2jb/"
done
find "$TMP/mac2jb" -name '.DS_Store' -o -name '._*' -o -name '*.o' -o -name '*.dylib' | while IFS= read -r file; do rm -f "$file"; done
rm -f mac2jb-complete.zip
OUT="$PWD/mac2jb-complete.zip"
(cd "$TMP" && ditto -c -k --keepParent mac2jb "$OUT")
echo "Created: $PWD/mac2jb-complete.zip"
