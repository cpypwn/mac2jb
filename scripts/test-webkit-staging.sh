#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK_WEBKIT_TEST="$(mktemp -d "${TMPDIR:-/tmp}/mac2jb-webkit-staging.XXXXXX")"
trap 'rm -rf "$TASK_WEBKIT_TEST"' EXIT
xcrun swiftc -swift-version 5 -target arm64-apple-macos14.0 \
  -module-cache-path "$TASK_WEBKIT_TEST/module-cache" \
  -framework SwiftUI -framework AppKit -framework CryptoKit \
  "$ROOT/gui/NetworkSelection.swift" "$ROOT/gui/WebKitResearchModel.swift" \
  "$ROOT/scripts/test-webkit-staging.swift" -o "$TASK_WEBKIT_TEST/tests"
"$TASK_WEBKIT_TEST/tests" \
  "$ROOT/vendor/switch2-captive-portal-research" \
  "$ROOT/packaging/switch2-browser-research-provenance.json"
