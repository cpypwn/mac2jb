#!/bin/sh
set -eu
app_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$app_dir/tests/build"
host_cc=${HOST_CC:-cc}
"$host_cc" -std=gnu11 -O2 -Wall -Wextra -Werror -I"$app_dir/src" \
  "$app_dir/tests/core-test.c" "$app_dir/src/core.c" "$app_dir/src/audio.c" \
  -o "$app_dir/tests/build/core-test"
"$app_dir/tests/build/core-test" "$app_dir/assets/Diamond Chase.nes"
"$host_cc" -std=gnu11 -O2 -Wall -Wextra -Werror -I"$app_dir/src" \
  "$app_dir/tests/sprite0-wait-test.c" "$app_dir/src/audio.c" \
  -o "$app_dir/tests/build/sprite0-wait-test"
"$app_dir/tests/build/sprite0-wait-test"
"$host_cc" -std=gnu11 -O2 -Wall -Wextra -Werror -DMINTNES_AUDIO_TEST -I"$app_dir/src" \
  "$app_dir/tests/audio-test.c" "$app_dir/src/audio.c" \
  -o "$app_dir/tests/build/audio-test"
"$app_dir/tests/build/audio-test"
"$host_cc" -std=gnu11 -O2 -Wall -Wextra -Werror -I"$app_dir/tests" \
  -I"$app_dir/src" -I"$app_dir/../../sdk/include" \
  "$app_dir/tests/output-test.c" "$app_dir/src/output.c" \
  -o "$app_dir/tests/build/output-test"
"$app_dir/tests/build/output-test"
"$host_cc" -std=gnu11 -O2 -Wall -Wextra -Werror -I"$app_dir/src" \
  -I"$app_dir/../../sdk/include" "$app_dir/tests/app-control-test.c" \
  "$app_dir/src/app.c" "$app_dir/src/core.c" "$app_dir/src/audio.c" \
  -o "$app_dir/tests/build/app-control-test"
"$app_dir/tests/build/app-control-test" "$app_dir/assets/Diamond Chase.nes"
