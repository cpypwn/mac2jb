#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p .build-gui
xcrun swiftc -swift-version 5 -target arm64-apple-macos14.0 \
  gui/ArtemisHTTPView.swift gui/NetworkSelection.swift gui/GlassStyle.swift \
  scripts/test-artemis-http.swift -o .build-gui/test-artemis-http
.build-gui/test-artemis-http
