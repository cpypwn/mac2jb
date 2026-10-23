
#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Verify required release files exist.
for path in \
    README.md \
    LICENSE \
    .gitignore \
    Makefile \
    sender.c \
    commands.c \
    indent-test.bas \
    upstream.lock \
    vendor/libusbd/Makefile \
    vendor/ns2jb/run.cjs \
    assets/bootstrap.bas \
    assets/bootstrap.bas.sha256
do
    [[ -e "$path" ]] || {
        echo "Missing package input: $path" >&2
        exit 1
    }
done

# Verify bootstrap integrity.
shasum -a 256 -c assets/bootstrap.bas.sha256

# Reject nested Git metadata.
[[ ! -e vendor/.git ]] || {
    echo "Nested Git metadata detected" >&2
    exit 1
}

# Create temporary packaging directory.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/mac2jb"

# Copy release source files.
for item in \
    README.md \
    LICENSE \
    .gitignore \
    Makefile \
    sender.c \
    commands.c \
    INDENT-TEST.md \
    indent-test.bas \
    upstream.lock \
    make-release-zip.command \
    scripts \
    assets \
    vendor
do
    if [[ -e "$item" ]]; then
        cp -R "$item" "$TMP/mac2jb/"
    fi
done

# CRITICAL: Remove all ns2jb runtime data.
# These files may contain pairing tokens,
# memory captures, and session logs.
rm -rf "$TMP/mac2jb/vendor/ns2jb/runs"

# Remove compiled binaries and local artifacts.
find "$TMP/mac2jb" -type f \( \
    -name '.DS_Store' -o \
    -name '._*' -o \
    -name '*.o' -o \
    -name '*.dylib' -o \
    -name 'mac2jb-send' -o \
    -name 'mac2jb-commands' \
\) -delete

# Remove additional Git metadata if present.
find "$TMP/mac2jb" -name '.git' -type d -prune -exec rm -rf {} +

# Create release archive.
OUT="$PWD/mac2jb-complete.zip"
rm -f "$OUT"

(
    cd "$TMP"
    /usr/bin/ditto -c -k --keepParent mac2jb "$OUT"
)

echo "Created release archive: $OUT"
echo "Runtime session data excluded."
