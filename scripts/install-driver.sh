#!/bin/bash
# Shared GUI/CLI installer. Never changes SIP or startup security policy.
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRIVER="$ROOT/drivers/usbgadget.kext"
verify() {
  [[ -d "$DRIVER" && ! -L "$DRIVER" ]] || { echo 'Bundled driver is missing.' >&2; exit 1; }
  [[ -z "$(find "$DRIVER" -type l -print)" ]] || { echo 'Driver links are not permitted.' >&2; exit 1; }
  [[ "$(find "$DRIVER" -type f | wc -l | tr -d ' ')" == 2 ]] || { echo 'Unexpected driver files.' >&2; exit 1; }
  (cd "$DRIVER" && shasum -a 256 -c "$ROOT/drivers/SHA256SUMS")
}
verify
[[ "${1:-}" == --verify ]] && exit 0
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'Apple Silicon macOS is required.' >&2; exit 1; }
[[ "$(csrutil status)" == 'System Integrity Protection status: disabled.' ]] || {
  echo 'Disable SIP in macOS Recovery before installing this unsigned driver. See the README.' >&2; exit 1;
}
if [[ "$EUID" != 0 ]]; then
  exec sudo /bin/bash "$0"
fi
# Stage under a root-owned directory and verify again before installing.
STAGE="$(mktemp -d /Library/Extensions/.mac2jb-driver.XXXXXX)"
trap 'rmdir "$STAGE" 2>/dev/null || true' EXIT
ditto "$DRIVER" "$STAGE/usbgadget.kext"
DRIVER="$STAGE/usbgadget.kext"
verify
chown -R root:wheel "$DRIVER"
find "$DRIVER" -type d -exec chmod 755 {} +
find "$DRIVER" -type f -exec chmod 644 {} +
chmod 755 "$DRIVER/Contents/MacOS/usbgadget"
TARGET=/Library/Extensions/usbgadget.kext
if [[ -e "$TARGET" || -L "$TARGET" ]]; then
  BACKUP="/Library/Extensions/.mac2jb-usbgadget-backup-$(uuidgen)"
  mv "$TARGET" "$BACKUP"
  echo "Previous driver preserved at: $BACKUP"
fi
mv "$DRIVER" "$TARGET"
touch /Library/Extensions/.mac2jb-usbgadget-restart-required
chmod 644 /Library/Extensions/.mac2jb-usbgadget-restart-required
sync
echo 'Driver installed. Restart after macOS approval, then verify loading and USB input.'
kmutil load -p "$TARGET"
