#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for name in game-compute-check game-render; do
 if [[ ${REBUILD_CHECKS:-0} == 1 || ! -x homebrew-launcher/$name || homebrew-launcher/$name.c -nt homebrew-launcher/$name ]]; then
  "${CC:-cc}" -O2 "homebrew-launcher/$name.c" -lvulkan -o "homebrew-launcher/$name"
 fi
done
