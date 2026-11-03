#!/usr/bin/env bash
# Build native.c for the host with ASan + UBSan, run it under test/harness.c, and check it with
# check.py and rclone (WebDAV and plain-HTTP backends). macOS only: the harness relies on BSD socket ABI.
#
# Usage: engine/oz-code/test/run.sh [port] [work-dir]   (defaults: 18080, engine/oz-code/.build/test)
set -euo pipefail

TEST_DIRECTORY="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIRECTORY="$(dirname "$TEST_DIRECTORY")"
PORT="${1:-18080}"
WORK="${2:-$SOURCE_DIRECTORY/.build/test}"
CC="${CC:-clang}"
mkdir -p "$WORK"

# native.c defines memcpy/memset/memmove for the console; rename them here so libc and ASan keep theirs.
"$CC" -std=c11 -g -O1 -fsanitize=address,undefined -fno-sanitize-recover=undefined -fno-omit-frame-pointer \
    -Wall -Wextra \
    -Dmemcpy=native_memcpy -Dmemset=native_memset -Dmemmove=native_memmove \
    -o "$WORK/harness" \
    "$TEST_DIRECTORY/harness.c" "$SOURCE_DIRECTORY/native.c" "$SOURCE_DIRECTORY/vendor/picohttpparser/picohttpparser.c"

# The harness serves until its stdin closes; a FIFO lets us close it at the end and collect sanitizer output.
rm -f "$WORK/stdin"
mkfifo "$WORK/stdin"
"$WORK/harness" "$PORT" "$WORK/manifest.tsv" < "$WORK/stdin" > "$WORK/harness.log" 2>&1 &
HARNESS=$!
exec 3> "$WORK/stdin"
until grep -q ready "$WORK/harness.log" 2>/dev/null; do
    kill -0 "$HARNESS" 2>/dev/null || { cat "$WORK/harness.log"; exit 1; }
    sleep 0.1
done

STATUS=0
python3 -I "$TEST_DIRECTORY/check.py" "$PORT" "$WORK/manifest.tsv" || STATUS=1

if command -v rclone > /dev/null; then
    for BACKEND in webdav http; do
        rm -rf "$WORK/rclone-$BACKEND"
        if rclone copy --transfers 4 --"$BACKEND"-url "http://127.0.0.1:$PORT/" ":$BACKEND:" "$WORK/rclone-$BACKEND" 2> "$WORK/rclone-$BACKEND.log"; then
            COUNT=$(find "$WORK/rclone-$BACKEND" -type f | wc -l | tr -d ' ')
            echo "rclone $BACKEND: copied $COUNT files"
            [ "$COUNT" = "$(wc -l < "$WORK/manifest.tsv" | tr -d ' ')" ] || { echo "FAIL: rclone $BACKEND file count"; STATUS=1; }
        else
            echo "FAIL: rclone $BACKEND (see $WORK/rclone-$BACKEND.log)"; STATUS=1
        fi
    done
fi

exec 3>&-
wait "$HARNESS" || STATUS=1
cat "$WORK/harness.log"

# The run above leaves server-closed connections in TIME_WAIT; restarting on the same port must still work.
if "$WORK/harness" "$PORT" "$WORK/manifest-restart.tsv" < /dev/null > "$WORK/restart.log" 2>&1; then
    echo "restart on port $PORT: ok"
else
    echo "FAIL: restart on port $PORT"; cat "$WORK/restart.log"; STATUS=1
fi
exit "$STATUS"
