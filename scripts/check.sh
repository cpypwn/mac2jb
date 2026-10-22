#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo 'mac2jb preflight'
[[ "$(uname -s)" == Darwin ]] || { echo 'Sender requires macOS.' >&2; exit 1; }
[[ "$(uname -m)" == arm64 ]] || { echo 'Sender targets Apple Silicon arm64.' >&2; exit 1; }
for item in vendor/libusbd/Makefile vendor/macos_usb_gadget_poc/README.md vendor/ns2jb/run.cjs vendor/ns2jb/engine assets/bootstrap.bas; do
  [[ -e "$item" ]] || { echo "Missing offline component: $item" >&2; exit 1; }
done
[[ -f upstream.lock ]] || { echo 'Missing upstream.lock' >&2; exit 1; }
shasum -a 256 -c assets/bootstrap.bas.sha256
command -v xcrun >/dev/null || { echo 'Missing Xcode command line tools.' >&2; exit 1; }
command -v node >/dev/null || { echo 'Node.js 22+ must be installed locally; bundled code cannot replace the runtime.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0])<22) process.exit(1)' || { echo 'Node >=22 required' >&2; exit 1; }
echo 'Bundled dependencies found. This does not verify USB device support or driver installation.'
