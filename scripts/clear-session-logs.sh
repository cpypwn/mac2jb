#!/bin/bash
# Purge only mac2jb GUI host logs after the active host has stopped.
set -euo pipefail
cd "$(dirname "$0")/.."
runs='vendor/ns2jb/runs'
[[ -d "$runs" ]] || { echo 'No session logs to remove.'; exit 0; }
active="$runs/mac2jb-active-connect.txt"
if [[ -f "$active" && ! -L "$active" ]]; then
  pid=$(head -n 1 "$active" || true)
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    echo 'A recorded host process is running; stop it before deleting logs.' >&2
    exit 1
  fi
fi
find "$runs" -maxdepth 1 -type f -name 'mac2jb-gui-host-*.log' -print -delete
printf 'Old mac2jb GUI host logs removed. The active pairing file was not touched.\n'
