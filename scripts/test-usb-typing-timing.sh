#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TIMING_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/mac2jb-typing-tests.XXXXXX")"
trap 'rm -rf "$TIMING_BUILD"' EXIT
# dead-strip the uncalled sender entry point. no libusbd library is linked:
# every usb operation reachable by these tests is an in-process mock.
xcrun clang -std=c11 -D_POSIX_C_SOURCE=200809L -O2 -Wall -Wextra \
  -target arm64-apple-macos14.0 -I"$ROOT/vendor/libusbd/include" \
  "$ROOT/scripts/test-usb-typing-timing.c" -Wl,-dead_strip -o "$TIMING_BUILD/tests"
"$TIMING_BUILD/tests"
