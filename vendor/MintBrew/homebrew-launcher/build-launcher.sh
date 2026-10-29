#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/toolchain.sh
"$NODE" -e "require('./sdk/build.cjs').headers('homebrew-launcher/shaders').catch(e=>{console.error(e);process.exitCode=1})"
python3 homebrew-launcher/launcher-text.py
for stage in vert frag comp; do
 "${GLSLANG:-./tools/glslangValidator}" -V -Os -g0 --target-env vulkan1.0 "homebrew-launcher/shaders/launcher.$stage" -o "homebrew-launcher/shaders/launcher.$stage.spv"
 "${SPIRV_VAL:-./tools/spirv-val}" --target-env vulkan1.0 "homebrew-launcher/shaders/launcher.$stage.spv"
done
"$NODE" apps/hello-world/build.cjs
if [[ ${1:-} == --check ]]; then
 bash scripts/build-checks.sh
 "$NODE" --test homebrew-launcher/*.test.cjs smilebasic/*.test.cjs sdk/tests/*.test.cjs
 "$NODE" homebrew-launcher/launcher-desktop-check.cjs
fi
