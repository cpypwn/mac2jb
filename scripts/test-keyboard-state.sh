#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK_KEYBOARD_TEST="$(mktemp -d "${TMPDIR:-/tmp}/mac2jb-keyboard-state.XXXXXX")"
trap 'rm -rf "$TASK_KEYBOARD_TEST"' EXIT
xcrun swiftc -parse-as-library -swift-version 5 -target arm64-apple-macos14.0 \
  -module-cache-path "$ROOT/.build-gui/module-cache" -framework AppKit -framework SwiftUI -framework CryptoKit \
  "$ROOT/gui/KeyboardCaptureView.swift" "$ROOT/gui/NetworkSelection.swift" "$ROOT/gui/SessionModel.swift" \
  "$ROOT/gui/SessionRecovery.swift" "$ROOT/gui/SessionDataCleanup.swift" "$ROOT/gui/SessionRunMode.swift" "$ROOT/gui/SmileBASICEdition.swift" "$ROOT/gui/HostProfile.swift" \
  "$ROOT/gui/PostBootstrapCommand.swift" "$ROOT/gui/WorkflowProgress.swift" "$ROOT/gui/BootstrapLineProgress.swift" \
  "$ROOT/gui/PostRunSessionState.swift" "$ROOT/gui/OunceCakeSession.swift" "$ROOT/gui/StremioAccount.swift" \
  "$ROOT/gui/BuildIdentity.swift" "$ROOT/gui/Runtime.swift" \
  "$ROOT/scripts/test-keyboard-state.swift" "$ROOT/scripts/test-keyboard-text.swift" -o "$TASK_KEYBOARD_TEST/tests"
"$TASK_KEYBOARD_TEST/tests"
