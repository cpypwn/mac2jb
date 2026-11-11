#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Verify required release files exist.
for path in \
    README.md \
    LICENSE \
    .gitignore \
    .github \
    Makefile \
    sender.c \
    commands.c \
    keyboard.c \
    civswitch-hid.c \
    indent-test.bas \
    upstream.lock \
    vendor/libusbd/Makefile \
    vendor/libusbd/LICENSE-APSL-2.0.txt \
    vendor/macos_usb_gadget_poc/LICENSE-APSL-2.0.txt \
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
    .github \
    Makefile \
    sender.c \
    commands.c \
    keyboard.c \
    civswitch-hid.c \
    mac2jb.command \
    setup.sh \
    fetch-bootstrap.sh \
    INDENT-TEST.md \
    indent-test.bas \
    upstream.lock \
    make-release-zip.command \
    scripts \
    stremio \
    integrations \
    gui \
    packaging \
    drivers \
    assets \
    vendor
do
    if [[ -e "$item" ]]; then
        cp -R "$item" "$TMP/mac2jb/"
    fi
done

# Record the source build identity.
python3 - "$PWD/gui/Info.plist" "$TMP/mac2jb" <<'PYTEST'
import json, plistlib, sys
from pathlib import Path
info, stage = map(Path, sys.argv[1:])
test = plistlib.loads(info.read_bytes()).get('MAC2JBTestBuild') is True
(stage/'packaging/test-build.json').write_text(json.dumps({'testBuild':test})+'\n')
PYTEST

# Exclude generated runtime data, memory captures, and session logs.
rm -rf "$TMP/mac2jb/vendor/ns2jb/runs"
rm -rf "$TMP/mac2jb/vendor/ns2jb/dumps"
rm -rf "$TMP/mac2jb/vendor/HBLauncher/runs" "$TMP/mac2jb/vendor/HBLauncher/tools" "$TMP/mac2jb/vendor/HBLauncher/dist"
rm -rf "$TMP/mac2jb/vendor/GPUBrewLauncher/runs" "$TMP/mac2jb/vendor/GPUBrewLauncher/tools" "$TMP/mac2jb/vendor/GPUBrewLauncher/dist"
for removed in \
    vendor/IZ2S-Platform vendor/IZDOOM vendor/BlitBun \
    vendor/ns2jb-hosts/izmysh-legacy \
    vendor/MintBrew/apps/izdoom vendor/MintBrew/apps/iz-exchange \
    integrations/izlauncher-shell integrations/blitbun integrations/vacootube \
    integrations/civswitch-control-center vendor/CivSwitch-ControlCenter \
    integrations/izdoom integrations/mintbrew-iz-exchange \
    integrations/super-file-bros integrations/civswitch/izlauncher-save \
    scripts/gui-izlauncher.cjs scripts/gui-civswitch-izlauncher.cjs \
    scripts/gui-civswitch-izlauncher-save.cjs scripts/prepare-izlauncher.cjs \
    scripts/check-izlauncher-runtime.cjs scripts/izlauncher-modules.cjs \
    scripts/izlauncher-panel.cjs scripts/stage-custom-izmodule.cjs \
    scripts/build-seedsow-full-showcase.cjs \
    integrations/civswitch/hello.js integrations/civswitch/send-hello.cjs \
    integrations/civswitch/send-hello.test.cjs \
    integrations/balatro-rce/balatro-cpypwn-showcase.zip \
    integrations/balatro-rce/showcase.lua integrations/balatro-rce/build-showcase.py \
    integrations/seedsow-lua \
    integrations/ns2jb-showcase \
    integrations/artemis/cpypwn-showcase.lua \
    integrations/artemis/cpypwn-kaleidoscope.lua \
    integrations/artemis/cpypwn-full-showcase.lua \
    integrations/artemis/README-seedsow-full-showcase.txt \
    integrations/artemis/seedsowhax-v1-mac2jb.zip \
    integrations/artemis/norahax-v1-mac2jb.zip \
    integrations/artemis/seedsowhax-v2-mac2jb.zip \
    integrations/artemis/norahax-v2-mac2jb.zip \
    integrations/artemis/hamihax-v2-mac2jb.zip \
    integrations/artemis/norahax-nora1-mac2jb.zip \
    integrations/gravcirc-rce/GC-v1.1-cpypwn-showcase.zip \
    integrations/gravcirc-rce/cpypwn-circuit-showcase.lua \
    integrations/gravcirc-rce/build-cpypwn-save.py \
    integrations/gravcirc-rce/send-showcase.py \
    packaging/IZ2S-Platform-provenance.json packaging/IZ2S-Platform-SHA256SUMS \
    packaging/IZMYSH-legacy-provenance.json packaging/IZMYSH-legacy-SHA256SUMS \
    packaging/IZCIVSwitch-izlauncher-save.json
do
    rm -rf "$TMP/mac2jb/$removed"
done

# A source package must not include executable kernel extensions, machine-local
# Xcode data, or the unused unlicensed upstream USB-device example.
rm -rf "$TMP/mac2jb/vendor/macos_usb_gadget_poc/usbgadget.kext" \
       "$TMP/mac2jb/vendor/macos_usb_gadget_poc/usb_device"
find "$TMP/mac2jb" -type d \( -name xcuserdata -o -name project.xcworkspace -o -name __pycache__ -o -name '*.dSYM' \) -prune -exec rm -rf {} +

# Remove compiled binaries and local artifacts.
find "$TMP/mac2jb" -type f \( \
    -name '.DS_Store' -o \
    -name '._*' -o \
    -name '*.o' -o \
    -name '*.pyc' -o \
    -name '*.dylib' -o \
    -name 'mac2jb-send' -o \
    -name 'mac2jb-commands' -o \
    -name 'mac2jb-keyboard' -o \
    -name '*.log' -o \
    -name '*.xcuserstate' -o \
    -name '*.kate-swp' \
\) -delete

# Remove additional Git metadata if present.
find "$TMP/mac2jb" -name '.git' -type d -prune -exec rm -rf {} +

# Create release archive.
OUT="$PWD/mac2jb-complete.zip"
rm -f "$OUT"

(
    cd "$TMP"
    /usr/bin/ditto -c -k --norsrc --keepParent mac2jb "$OUT"
)

echo "Created release archive: $OUT"
echo "Runtime session data excluded."
