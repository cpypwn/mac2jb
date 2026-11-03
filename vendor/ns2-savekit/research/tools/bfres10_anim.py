#!/usr/bin/env python3
"""Skeletal animations from a Mario Kart World BFRES (.anim or a model).

  python3 tools/bfres10_anim.py <file.anim.bfres> [out.json]

Indexes every `FSKA` in the file: name, frame count, bone-animation count, curve
count and where its data lives. The FSKA header is 0x50 bytes:

  +0x04  size
  +0x08  name (NW string pointer)
  +0x20  offset of this animation's bone-anim header array
  +0x28  offset of its secondary array (bone-anim header array + 0x70)
  +0x40  frame count                 (30 for a 1-second clip at 30 fps)
  +0x44  curve count
  +0x48  baked size
  +0x4C  bone-animation count        (e.g. 55; clips target shared-rig names)

The animation data begins with a table of -1 entries, then per-bone default results
as floats (a bone's rest scale/rotation/translation), then the anim curve headers
and the frame/value pools. The curve-header layout is not decoded yet, so this tool
indexes clips rather than sampling them; the mesh side (tools/bfres10.py) already
exports each model's bone hierarchy.
"""
import json
import struct
import sys

import numpy as np


def u16(b, o):
    return struct.unpack_from('<H', b, o)[0]


def u32(b, o):
    return struct.unpack_from('<I', b, o)[0]


def u64(b, o):
    return struct.unpack_from('<Q', b, o)[0]


def nw_string(b, pointer):
    if not 0 < pointer < len(b) - 2:
        return ''
    length = u16(b, pointer)
    if not 0 < length < 128 or pointer + 2 + length > len(b):
        return ''
    return b[pointer + 2:pointer + 2 + length].tobytes().decode('ascii', 'replace')


def animations(b):
    """Every FSKA in the file, in header order."""
    array = u64(b, 0x58)
    count = u16(b, 0xe2)
    out = []
    if not array or bytes(b[array:array + 4]) != b'FSKA':
        return out
    for i in range(count):
        header = array + i * 0x50
        if bytes(b[header:header + 4]) != b'FSKA':
            break
        out.append({'index': i,
                    'name': nw_string(b, u32(b, header + 0x08)),
                    'size': u32(b, header + 0x04),
                    'frame_count': u32(b, header + 0x40),
                    'curves': u32(b, header + 0x44),
                    'bone_anims': u32(b, header + 0x4c),
                    'bone_data': u64(b, header + 0x20),
                    'curve_data': u32(b, header + 0x48)})
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not args:
        raise SystemExit(__doc__)
    b = np.fromfile(args[0], dtype=np.uint8)
    clips = animations(b)
    print('%d skeletal animations' % len(clips))
    for clip in clips[:10]:
        print('  %-24s %3d frames  %2d bone anims  %3d curves  data %#x' % (
            clip['name'], clip['frame_count'], clip['bone_anims'], clip['curves'],
            clip['curve_data']))
    if len(clips) > 10:
        print('  ... %d more' % (len(clips) - 10))
    if len(args) > 1:
        with open(args[1], 'w') as f:
            json.dump({'source': args[0], 'animations': clips}, f, indent=1)
        print('wrote', args[1])


if __name__ == '__main__':
    main()
