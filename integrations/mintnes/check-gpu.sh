#!/bin/sh
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
app="$root/vendor/MintBrew/apps/mintnes"
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
clang -std=c11 -Wall -Wextra -Werror -I/opt/homebrew/include -L/opt/homebrew/lib \
  -Wl,-rpath,/opt/homebrew/lib "$app/offline-check.c" -lvulkan -o "$temporary/offline-check"
if [ -f /opt/homebrew/opt/molten-vk/etc/vulkan/icd.d/MoltenVK_icd.json ]; then
  export VK_ICD_FILENAMES=/opt/homebrew/opt/molten-vk/etc/vulkan/icd.d/MoltenVK_icd.json
fi
"$temporary/offline-check" "$app/app.comp.spv" "$app/assets/memory.bin" 40 "$temporary/move.bin"
MINTNES_MENU_SCENARIO=1 "$temporary/offline-check" "$app/app.comp.spv" "$app/assets/memory.bin" 1 "$temporary/menu.bin"
MINTNES_MINUS_SCENARIO=1 "$temporary/offline-check" "$app/app.comp.spv" "$app/assets/memory.bin" 32 "$temporary/minus.bin"
MINTNES_B_SCENARIO=1 "$temporary/offline-check" "$app/app.comp.spv" "$app/assets/memory.bin" 31 "$temporary/b.bin"
MINTNES_WIN_SCENARIO=1 "$temporary/offline-check" "$app/app.comp.spv" "$app/assets/memory.bin" 130 "$temporary/win.bin"
MINTNES_WIN_SCENARIO=1 "$temporary/offline-check" "$app/app.comp.spv" "$app/assets/memory.bin" 140 "$temporary/restart.bin"
node - "$root" "$temporary" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
const [root,dir]=process.argv.slice(2),appRoot=path.join(root,'vendor/MintBrew/apps/mintnes');
const service=require(path.join(root,'integrations/mintnes/service.cjs'));
const {make,spriteZero,chrRam,sprite8x16,apuStatus}=require(path.join(root,'integrations/mintnes/scroll-fixture.cjs'));
const app={files:{memory:{bytes:fs.readFileSync(path.join(appRoot,'assets/memory.bin'))}}};
for(const [name,options] of [['crossing',{scrollX:252,vertical:true}],['vertical',{scrollX:0,vertical:true}]]){
 const image=service.imageFor(app,make(options),[{title:name}],0);
 fs.writeFileSync(path.join(dir,name+'-image.bin'),image);
}
fs.writeFileSync(path.join(dir,'sprite-zero-image.bin'),service.imageFor(app,spriteZero(),[{title:'sprite zero'}],0));
fs.writeFileSync(path.join(dir,'chr-ram-image.bin'),service.imageFor(app,chrRam(),[{title:'chr ram'}],0));
fs.writeFileSync(path.join(dir,'sprite-8x16-image.bin'),service.imageFor(app,sprite8x16(),[{title:'sprite 8x16'}],0));
fs.writeFileSync(path.join(dir,'apu-status-image.bin'),service.imageFor(app,apuStatus(),[{title:'apu status'}],0));
NODE
"$temporary/offline-check" "$app/app.comp.spv" "$temporary/crossing-image.bin" 5 "$temporary/crossing.bin"
"$temporary/offline-check" "$app/app.comp.spv" "$temporary/vertical-image.bin" 5 "$temporary/vertical.bin"
"$temporary/offline-check" "$app/app.comp.spv" "$temporary/sprite-zero-image.bin" 1 "$temporary/sprite-zero.bin"
"$temporary/offline-check" "$app/app.comp.spv" "$temporary/chr-ram-image.bin" 5 "$temporary/chr-ram.bin"
"$temporary/offline-check" "$app/app.comp.spv" "$temporary/sprite-8x16-image.bin" 1 "$temporary/sprite-8x16.bin"
"$temporary/offline-check" "$app/app.comp.spv" "$temporary/apu-status-image.bin" 1 "$temporary/apu-status.bin"
python3 - "$temporary" <<'PY'
import collections
import pathlib
import struct
import sys

root=pathlib.Path(sys.argv[1])
def read(name):
    data=(root/name).read_bytes()
    return lambda index:struct.unpack_from('<I',data,index*4)[0]

move=read('move.bin')
assert move(6)==0 and move(7)==40
assert [move(256+i) for i in range(3)]==[29,24,0]
assert [move(45344+i) for i in range(4)]==[23,0,0,29]
assert move(43264+0x210c-0x2000)==1
assert collections.Counter(move(45600+i) for i in range(256*240))[32]>0
menu=read('menu.bin')
assert menu(19)==1 and menu(21)==1 and menu(22)==1
minus=read('minus.bin')
assert minus(19)==1 and minus(24)==0 and minus(57)==0
b=read('b.bin')
assert b(19)==0 and b(16)&2

win=read('win.bin')
assert win(6)==0 and [win(256+i) for i in range(3)]==[89,57,1]
assert win(43264+0x224c-0x2000)==2
restart=read('restart.bin')
assert restart(6)==0 and [restart(256+i) for i in range(3)]==[24,24,0]
assert restart(43264+0x224c-0x2000)==0
crossing=read('crossing.bin')
assert crossing(6)==0 and crossing(45600)==0x28 and crossing(45600+4)==0x30
vertical=read('vertical.bin')
assert vertical(6)==0 and vertical(45600)==0x28
assert vertical(43264)==1 and vertical(43264+1024)==2
sprite=read('sprite-zero.bin')
assert sprite(6)==0 and sprite(29)==32 and sprite(31)==0 and sprite(17)==8
assert sprite(45600)==0x28 and sprite(45600+48*256)==0x0f
chr_ram=read('chr-ram.bin')
assert chr_ram(6)==0 and chr_ram(61)==1 and chr_ram(35072+16)==0xff
assert chr_ram(45600)==0x28
sprite_8x16=read('sprite-8x16.bin')
assert sprite_8x16(6)==0 and sprite_8x16(29)==24 and sprite_8x16(256+3)==0x55
assert sprite_8x16(45600+16*256+16)==0x0f
assert sprite_8x16(45600+24*256+16)==0x30
assert sprite_8x16(45600+16*256+32)==0x30
assert sprite_8x16(45600+24*256+32)==0x0f
apu_status=read('apu-status.bin')
assert apu_status(6)==0 and [apu_status(256+i) for i in range(3)]==[15,6,0]
print('MintNES Vulkan ROM execution, movement, win, render, restart, mirroring, scrolling, sprite-zero split, CHR-RAM, 8x16 sprites and APU status passed')
PY
