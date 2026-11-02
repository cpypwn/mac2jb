#!/usr/bin/env python3
"""Parse Mario Kart World texture containers (BNTX with the `Ounc` container).

  python3 tools/bntx_ounce.py <file.bntx> [...]     # one line per texture
  python3 tools/bntx_ounce.py --dir <Tex-dir>      # inventory, .zs decompressed on the fly

The structure follows the documented BNTX layout (epd-libraries/bntxlibrary
docs/Structure.md): the 0x20-byte header, then the texture container at 0x20 -
which in these files has magic `Ounc` instead of `NX  ` but the same fields
(count, info array, data, dic, pools). Each `BRTI` block then gives flags,
dimension, tile mode, mip count, format, width/height/depth, layout and size.

The payload is compressed with Nintendo's `Ounce` codec (the names end in
`.Ounce64` and the size is far below any block-compressed format, e.g. 813x813
with 10 mips in 241,664 bytes). The decoder is in the game's `sdk` module
(`IsOunce`, `GpuOunce`), not in this tool - so this reports metadata only and
says so, rather than pretending a decode happened.
"""
import struct
import subprocess
import sys
import tempfile


def u32(b, o):
    return struct.unpack_from('<I', b, o)[0]


def u16(b, o):
    return struct.unpack_from('<H', b, o)[0]


def parse(path):
    b = open(path, 'rb').read()
    if b[:4] != b'BNTX':
        raise ValueError('not a BNTX file')
    container = b[0x20:0x24]
    count = u32(b, 0x24)
    array = u32(b, 0x28)
    data = u32(b, 0x30)
    out = []
    for i in range(count):
        brti = u32(b, array + i * 8) if count > 1 else u32(b, array)
        if b[brti:brti + 4] != b'BRTI':
            continue
        name_off = u32(b, brti + 0x60)
        # Names live in the _STR table as pascal strings (u16 length, then chars).
        if name_off and name_off + 2 <= len(b):
            length = u16(b, name_off)
            name = b[name_off + 2:name_off + 2 + length].decode('utf-8', 'replace')
        else:
            name = ''
        width, height = u32(b, brti + 0x24), u32(b, brti + 0x28)
        out.append({
            'container': container.decode('ascii', 'replace'),
            'name': name,
            'format': u32(b, brti + 0x1c),
            'mips': u16(b, brti + 0x16),
            'width': width, 'height': height,
            'depth': u32(b, brti + 0x2c),
            'layers': u32(b, brti + 0x30),
            'size': u32(b, brti + 0x50),
            'alignment': u32(b, brti + 0x54),
            'channel': u32(b, brti + 0x58),
            'data_offset': data,
            'file_size': len(b),
        })
    return out


def show(entry):
    px = max(entry['width'] * entry['height'], 1)
    bpp = entry['size'] / px
    return ('%-52s %4dx%-4d mips %-2d fmt 0x%08x size %7d (%5.2f B/px) %s' % (
        entry['name'][:52], entry['width'], entry['height'], entry['mips'],
        entry['format'], entry['size'], bpp, entry['container']))


def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)
    if args[0] == '--dir':
        import glob
        import os
        files = sorted(glob.glob(os.path.join(args[1], '*.bntx.zs')))[:20]
        for path in files:
            with tempfile.NamedTemporaryFile(suffix='.bntx', delete=False) as tmp:
                out = tmp.name
            subprocess.run(['zstd', '-d', '-q', '-f', path, '-o', out], check=True)
            for entry in parse(out):
                print(show(entry))
            os.unlink(out)
        return
    for path in args:
        for entry in parse(path):
            print(show(entry))


if __name__ == '__main__':
    main()
