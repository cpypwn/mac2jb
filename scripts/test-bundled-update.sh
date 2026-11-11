#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK_UPDATE_TEST="$(mktemp -d "${TMPDIR:-/tmp}/mac2jb-bundled-update.XXXXXX")"
trap 'rm -rf "$TASK_UPDATE_TEST"' EXIT
xcrun swiftc -swift-version 5 -target arm64-apple-macos14.0 \
  "$ROOT/gui/BundledUpdateChecker.swift" "$ROOT/scripts/test-bundled-update.swift" \
  -o "$TASK_UPDATE_TEST/tests"
"$TASK_UPDATE_TEST/tests" "$ROOT"
