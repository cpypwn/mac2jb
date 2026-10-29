#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="$ROOT/overlay/server/local-package/vacootube-audio"
swiftc -parse-as-library -O -target arm64-apple-macos14.2 \
  -framework CoreAudio -framework AudioToolbox \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist \
  -Xlinker "$ROOT/audio-capture-info.plist" \
  "$ROOT/audio-capture.swift" -o "$OUTPUT"
codesign --force --sign - "$OUTPUT"
xcrun vtool -show-build "$OUTPUT"
