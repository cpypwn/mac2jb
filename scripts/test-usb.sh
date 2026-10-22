#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -x ./mac2jb-send ]] || { echo 'build first: make' >&2; exit 1; }
echo 'test will type hello into the focused editor on the usb host.'
export MAC2JB_CONTROLLER="${MAC2JB_CONTROLLER:-usb-drd1}"
exec ./mac2jb-send assets/hello.txt --delay-ms 150 "$@"
