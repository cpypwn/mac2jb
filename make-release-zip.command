#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
for path in README.md LICENSE .gitignore Makefile sender.c commands.c indent-test.bas upstream.lock vendor/libusbd/Makefile vendor/ns2jb/run.cjs assets/bootstrap.bas assets/bootstrap.bas.sha256; do
  [[ -e "$path" ]] || { echo "missing package input: $path" >&2; exit 1; }
done
shasum -a 256 -c assets/bootstrap.bas.sha256
[[ ! -e vendor/.git ]] || { echo 'nested git metadata detected' >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/mac2jb"
for item in README.md LICENSE .gitignore Makefile sender.c commands.c INDENT-TEST.md indent-test.bas upstream.lock make-release-zip.command scripts assets vendor; do
  [[ ! -e "$item" ]] || cp -R "$item" "$TMP/mac2jb/"
done
find "$TMP/mac2jb" -type f \( -name '.DS_Store' -o -name '._*' -o -name '*.o' -o -name '*.dylib' -o -name 'mac2jb-send' -o -name 'mac2jb-commands' \) -delete
OUT="$PWD/mac2jb-complete.zip"
rm -f "$OUT"
(cd "$TMP" && /usr/bin/ditto -c -k --keepParent mac2jb "$OUT")
echo "created: $OUT"
