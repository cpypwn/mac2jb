#!/usr/bin/env bash
# Build every firmware variant: pico1/pico2 x us/jis.
# Needs PICO_SDK_PATH set; run npm install once for compress.js.
set -u
cd "$(dirname "$0")"
: "${PICO_SDK_PATH:?PICO_SDK_PATH is not set}"

fail=0
build() { # <name> <extra cmake args...>
    local name=$1; shift
    echo "=== build-$name ==="
    if ! cmake -B "build-$name" -G Ninja "$@" -DPICO_SDK_PATH="$PICO_SDK_PATH"; then
        echo "[build-$name] CONFIGURE FAILED"; fail=1; return
    fi
    if ! cmake --build "build-$name"; then
        echo "[build-$name] BUILD FAILED"; fail=1
    fi
}

echo "=== payload ==="
if command -v node >/dev/null 2>&1; then
    node compress.js || { echo "payload generation FAILED (npm install?)"; exit 1; }
else
    echo "node not found - using existing payload.txt"
fi

build pico2     -DPICO_BOARD=pico2 -DCIV7_TARGET_NAME=civ7-pico2
build pico1     -DPICO_BOARD=pico  -DCIV7_TARGET_NAME=civ7-pico1
build pico2-jis -DPICO_BOARD=pico2 -DCIV7_TARGET_NAME=civ7-pico2-jis -DCIV7_KEYBOARD_LAYOUT=jis
build pico1-jis -DPICO_BOARD=pico  -DCIV7_TARGET_NAME=civ7-pico1-jis -DCIV7_KEYBOARD_LAYOUT=jis

echo
echo "=== UF2 artifacts ==="
for f in build-pico2/src/civ7-pico2.uf2 \
         build-pico1/src/civ7-pico1.uf2 \
         build-pico2-jis/src/civ7-pico2-jis.uf2 \
         build-pico1-jis/src/civ7-pico1-jis.uf2; do
    if [ -f "$f" ]; then
        ls -la "$f" | awk '{printf "  %9d  %s\n", $5, $9}'
    else
        echo "  MISSING   $f"; fail=1
    fi
done
exit $fail
