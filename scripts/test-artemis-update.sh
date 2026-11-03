#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK_ARTEMIS_TEST="$(mktemp -d "${TMPDIR:-/tmp}/mac2jb-artemis-update.XXXXXX")"
trap 'rm -rf "$TASK_ARTEMIS_TEST"' EXIT
xcrun swiftc -swift-version 5 -target arm64-apple-macos14.0 \
  "$ROOT/gui/ArtemisUpdateChecker.swift" "$ROOT/scripts/test-artemis-update.swift" \
  -o "$TASK_ARTEMIS_TEST/tests"
"$TASK_ARTEMIS_TEST/tests" "$ROOT/packaging/ArtemisLauncher-v1.json"
