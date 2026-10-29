# Source from a script that has already changed to the repository root.
export NODE="${NODE:-$(command -v node || true)}"
if [[ -z "$NODE" && -x ./tools/node ]]; then NODE=./tools/node; fi
if [[ -z "$NODE" ]]; then echo 'Install Node.js 22 or newer, or set NODE.' >&2; return 1; fi
export GLSLANG="${GLSLANG:-$(command -v glslangValidator || true)}"
export SPIRV_VAL="${SPIRV_VAL:-$(command -v spirv-val || true)}"
if [[ -z "$GLSLANG" ]]; then GLSLANG=./tools/glslangValidator; fi
if [[ -z "$SPIRV_VAL" ]]; then SPIRV_VAL=./tools/spirv-val; fi
