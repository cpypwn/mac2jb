#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
controller="${1:-usb-drd1}"
case "$controller" in
  usb-drd0|usb-drd1|usb-drd3) ;;
  *) echo 'usage: bash scripts/test-controllers.sh [usb-drd0|usb-drd1|usb-drd3]' >&2; exit 2 ;;
esac
printf 'testing controller: %s\n' "$controller"
exec env MAC2JB_CONTROLLER="$controller" bash scripts/test-usb.sh
