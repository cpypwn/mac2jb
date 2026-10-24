#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$(mktemp -d "${TMPDIR:-/tmp}/mac2jb-workflow-tests.XXXXXX")"
trap 'rm -rf "$BUILD"' EXIT
xcrun swiftc -swift-version 5 -module-cache-path "$BUILD/module-cache" \
  "$ROOT/gui/WorkflowProgress.swift" "$ROOT/scripts/test-workflow-progress.swift" \
  -o "$BUILD/workflow-progress-tests"
"$BUILD/workflow-progress-tests"
