#!/bin/sh
# Offline build using the pinned, included sources. Do not clone over vendor/.
set -eu
cd "$(dirname "$0")"
bash scripts/check.sh
make
printf '\nBuild complete. Verify with: ./mac2jb-send --help\n'
printf 'To launch the guided workflow: bash mac2jb.command\n'
