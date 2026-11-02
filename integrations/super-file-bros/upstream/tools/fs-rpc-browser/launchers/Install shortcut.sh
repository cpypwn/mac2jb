#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then printf '%s\n' 'Install Node.js 22+ from https://nodejs.org/ first.'; exit 1; fi
exec node tools/fs-rpc-browser/install.cjs
