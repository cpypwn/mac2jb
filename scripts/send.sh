#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f assets/bootstrap.bas ]] || { echo 'bootstrap.bas is missing; download the complete mac2jb release.' >&2; exit 1; }
[[ -x ./mac2jb-send ]] || { echo 'Build first: make' >&2; exit 1; }
exec ./mac2jb-send assets/bootstrap.bas "$@"
