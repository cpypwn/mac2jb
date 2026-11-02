#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK_NETWORK_TEST="$(mktemp -d "${TMPDIR:-/tmp}/mac2jb-network-tests.XXXXXX")"
trap 'rm -rf "$TASK_NETWORK_TEST"' EXIT
xcrun swiftc -parse-as-library -swift-version 5 -target arm64-apple-macos14.0 \
  -module-cache-path "$ROOT/.build-gui/module-cache" \
  -framework AppKit -framework CryptoKit \
  "$ROOT/gui/NetworkSelection.swift" "$ROOT/gui/SessionModel.swift" "$ROOT/gui/SessionRecovery.swift" "$ROOT/gui/SessionDataCleanup.swift" \
  "$ROOT/gui/SessionRunMode.swift" "$ROOT/gui/SmileBASICEdition.swift" "$ROOT/gui/WorkflowProgress.swift" \
  "$ROOT/gui/PostBootstrapCommand.swift" "$ROOT/gui/HostProfile.swift" \
  "$ROOT/gui/BootstrapLineProgress.swift" \
  "$ROOT/gui/PostRunSessionState.swift" "$ROOT/gui/OunceCakeSession.swift" "$ROOT/gui/StremioAccount.swift" \
  "$ROOT/gui/BuildIdentity.swift" "$ROOT/gui/Runtime.swift" "$ROOT/scripts/test-network-selection.swift" \
  -o "$TASK_NETWORK_TEST/tests"
"$TASK_NETWORK_TEST/tests"
