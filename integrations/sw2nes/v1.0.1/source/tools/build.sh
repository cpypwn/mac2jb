#!/bin/sh
# Build QuickNES + bridge into dist/runtime/quicknes.js (wasm2js, no WebAssembly).
# Usage: EMSDK=/path/to/emsdk tools/build.sh
#   QUICKNES=/path/to/QuickNES_Core (default: third_party/QuickNES_Core)
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
: "${EMSDK:?Set EMSDK to an emsdk checkout with 3.1.74 activated}"
. "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
emcc --version | head -1 | grep -q '3\.1\.74' || { echo "Need Emscripten 3.1.74" >&2; exit 1; }
src=${QUICKNES:-$root/third_party/QuickNES_Core}/nes_emu
out=$root/dist/runtime
obj=$root/build/obj
mkdir -p "$out" "$obj"

files="abstract_file apu_state Blip_Buffer Effects_Buffer Multi_Buffer Nes_Apu Nes_Buffer
Nes_Cart Nes_Core Nes_Cpu nes_data Nes_Effects_Buffer Nes_Emu Nes_File Nes_Fme7_Apu
Nes_Mapper Nes_Vrc7 emu2413 emu2413_state Nes_Namco_Apu Nes_Oscs Nes_Ppu Nes_Ppu_Impl
Nes_Ppu_Rendering Nes_State nes_util Nes_Vrc6_Apu Data_Reader"
mappers=$(ls "$src"/mappers/*.cpp 2>/dev/null || true)

OPT=${OPT:--O3}
# JS_CPU=1 (default): run the 6502 in generated JavaScript (native/cpu_lib.js) instead of C.
JSCPU_CFLAGS=""; JSCPU_LINK=""; JSCPU_EXPORTS=""
if [ "${JS_CPU:-1}" = "1" ]; then
  [ -n "${SKIP_GEN:-}" ] || SW2NES_PROFILE=${STAGE_PROFILE:-0} python3 "$root/tools/gen_cpu.py" >/dev/null
  JSCPU_CFLAGS="-DSW2NES_JS_CPU -DSW2NES_JS_CONVERT ${JS_BG_FLAG--DSW2NES_JS_BG}"; JSCPU_LINK="--js-library $root/native/cpu_lib.js --js-library $root/native/convert_lib.js --js-library $root/native/ppu_lib.js"
  JSCPU_EXPORTS=',"_sw2nes_cpu_read","_sw2nes_cpu_read_ppu","_sw2nes_cpu_write"'
fi
# STAGE_PROFILE=1: per-stage timers (nes_prof) for diagnostics builds only.
if [ "${STAGE_PROFILE:-0}" = "1" ]; then
  JSCPU_CFLAGS="$JSCPU_CFLAGS -DSW2NES_PROFILE"; JSCPU_EXPORTS="$JSCPU_EXPORTS"',"_nes_prof","_nes_prof_ptr"'
fi
CFLAGS="$OPT $JSCPU_CFLAGS -DNO_UNALIGNED_ACCESS -DSW2NES_ALIGNED_BG -mbulk-memory ${EXTRA_CFLAGS:-} -flto -fno-exceptions -fno-rtti -I$src -DNDEBUG -Wno-everything"
objs=""
for f in $files; do
  emcc $CFLAGS -c "$src/$f.cpp" -o "$obj/$f.o"; objs="$objs $obj/$f.o"
done
for m in $mappers; do
  b=$(basename "$m" .cpp); emcc $CFLAGS -c "$m" -o "$obj/m_$b.o"; objs="$objs $obj/m_$b.o"
done
emcc $CFLAGS -c "$root/native/bridge.cpp" -o "$obj/bridge.o"

exports='["_malloc","_free","_nes_rom_alloc","_nes_load","_nes_unload","_nes_reset","_nes_frame","_nes_video","_nes_width","_nes_height","_nes_audio","_nes_audio_take","_nes_set_audio_ratio","_nes_convert","_nes_palette_buffer","_nes_use_palette","_nes_set_audio","_nes_prg","_nes_prg_size","_nes_set_format16","_nes_bytes_per_pixel","_nes_invalidate_video","_nes_reconvert","_nes_test_force_heavy","_nes_sample_rate","_nes_has_battery","_nes_sram","_nes_sram_size","_nes_ram","_nes_state_save","_nes_state_buffer","_nes_state_load"'"$JSCPU_EXPORTS"']'
emcc $OPT -mbulk-memory ${EXTRA_CFLAGS:-} ${PROFILE:+--profiling} -flto $JSCPU_LINK $objs "$obj/bridge.o" -o "$out/${OUT_NAME:-quicknes.js}" \
  -sWASM=0 -sSINGLE_FILE=1 -sMODULARIZE=1 -sEXPORT_NAME=QuickNESCore \
  -sENVIRONMENT=web,node -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=0 \
  -sINITIAL_MEMORY=16777216 -sSTACK_SIZE=262144 -sASSERTIONS=0 \
  ${ALIGN_LOWERING:+-sBINARYEN_EXTRA_PASSES=alignment-lowering} -sDYNAMIC_EXECUTION=0 \
  -sEXPORTED_FUNCTIONS="$exports" \
  "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAP16','HEAPU32','HEAPF64','UTF8ToString']"
ls -l "$out/${OUT_NAME:-quicknes.js}"
