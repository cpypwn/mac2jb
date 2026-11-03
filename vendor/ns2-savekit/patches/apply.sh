#!/bin/sh
# Apply every patch in this directory to an ns2jb checkout.
#   sh patches/apply.sh /path/to/ns2jb
set -eu
target=${1:?usage: apply.sh <ns2jb-checkout>}
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for patch in "$here"/*.diff; do
  echo "applying $(basename "$patch")"
  git -C "$target" apply -3 "$patch"
done
for f in engine/shared/ipc.cjs engine/switch2/app/mounted-save.cjs engine/lib/bridge.cjs \
         engine/switch2/app/session.cjs engine/switch2/memory/probe-reserved-gap.cjs \
         engine/switch2/retained/find-metadata.cjs engine/switch2/ro/ncm.cjs run.cjs; do
  [ -f "$target/$f" ] && node --check "$target/$f"
done
echo "patched and syntax-checked: $target"
