#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Super File Bros. needs Node.js. Install Node.js 22+ from https://nodejs.org/ and reopen this launcher.'
  exit 1
fi
exec node start.cjs "$@"
