#!/bin/sh
set -eu
exec "${NODE:-node}" "$(dirname -- "$0")/tools/module.cjs" install "$@"
