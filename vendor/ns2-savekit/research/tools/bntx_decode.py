#!/usr/bin/env python3
"""Decode Mario Kart World textures (BNTX `Ounc` containers) to PNG.

  python3 tools/bntx_decode.py <file.bntx> <out.png> [--mip N]

Formats: nn::gfx::ImageFormat = (ChannelFormat << 8) | TypeFormat, so 0x3406 is
ASTC 8x8 SRGB, 0x3401 ASTC 8x8 Unorm, 0x1f0a BC6H UF16, 0x0a01 R16 Unorm.

The surface is block-linear (Tegra GOBs of 64 bytes x 8 rows) with the Switch 2
"native tiling" variant of the GOB swizzle, taken from the Eden-NS2 patch's
block_linear_unswizzle_2d.comp:

    uint offset = SwizzleTable(pos.y * 64 + pos.x);
    if (native_tiling) {
        uint difference = ((offset >> 5) ^ (offset >> 6)) & 1;
        offset ^= (difference << 5) | (difference << 6);
    }

where SwizzleTable indexes the 8-word table below by pos >> 4 and returns a
16-byte slot inside the GOB. Without the native_tiling flip the image comes out
as correct regions with an 8-pixel mosaic.
"""
import math
import struct
import sys

import numpy as np
from PIL import Image

try:
    import texture2ddecoder as t2d
except ImportError:
    t2d = None

SWIZZLE = (0x12100200, 0x13110301, 0x16140604, 0x17150705,
           0x1a180a08, 0x1b190b09, 0x1e1c0e0c, 0x1f1d0f0d)

# channel -> (name, block_w, block_h, bytes_per_block)
CHANNELS = {0x2d: ('ASTC_4x4', 4, 4, 16), 0x2e: ('ASTC_5x4', 5, 4, 16),
            0x2f: ('ASTC_5x5', 5, 5, 16), 0x30: ('ASTC_6x5', 6, 5, 16),
            0x31: ('ASTC_6x6', 6, 6, 16), 0x32: ('ASTC_8x5', 8, 5, 16),
            0x33: ('ASTC_8x6', 8, 6, 16), 0x34: ('ASTC_8x8', 8, 8, 16),
            0x35: ('ASTC_10x5', 10, 5, 16), 0x36: ('ASTC_10x6', 10, 6, 16),
            0x37: ('ASTC_10x8', 10, 8, 16), 0x38: ('ASTC_10x10', 10, 10, 16),
            0x39: ('ASTC_12x10', 12, 10, 16), 0x3a: ('ASTC_12x12', 12, 12, 16),
            0x1f: ('BC6H', 4, 4, 16),
            0x20: ('BC7U', 4, 4, 16), 0x1a: ('BC1', 4, 4, 8),
            0x1c: ('BC3', 4, 4, 16), 0x1d: ('BC4', 4, 4, 8),
            0x1e: ('BC5', 4, 4, 16), 0x0a: ('R16', 1, 1, 2),
            0x0b: ('R8G8B8A8', 1, 1, 4), 0x0c: ('B8G8R8A8', 1, 1, 4),
            0x12: ('R16G16', 1, 1, 4), 0x15: ('R16G16B16A16', 1, 1, 8),
            0x14: ('R32', 1, 1, 4), 0x17: ('R32G32', 1, 1, 8),
            0x19: ('R32G32B32A32', 1, 1, 16), 0x0e: ('R10G10B10A2', 1, 1, 4),
            0x09: ('R8G8', 1, 1, 2), 0x02: ('R8', 1, 1, 1)}
TYPES = {0x01: 'Unorm', 0x02: 'Snorm', 0x03: 'UInt', 0x04: 'SInt', 0x05: 'Float',
         0x06: 'SRGB', 0x07: 'Depth', 0x0a: 'UFloat'}


def u32(b, o):
    return struct.unpack_from('<I', b, o)[0]


def u16(b, o):
    return struct.unpack_from('<H', b, o)[0]


def u64(b, o):
    return struct.unpack_from('<Q', b, o)[0]


def swizzle_offset(x, y, native=True):
    pos = (y & 7) * 64 + (x & 63)
    i = pos >> 4
    h = (SWIZZLE[i // 4] >> ((i % 4) * 8)) & 0xff
    off = (h << 4) | (pos & 0xf)
    if native:
        d = ((off >> 5) ^ (off >> 6)) & 1
        off ^= (d << 5) | (d << 6)
    return off


def describe(b, brti):
    fmt = u32(b, brti + 0x1c)
    channel, type_ = fmt >> 8, fmt & 0xff
    name, bw, bh, bpb = CHANNELS.get(channel, ('unknown', 1, 1, 4))
    return {'format': fmt, 'channel': name, 'type': TYPES.get(type_, hex(type_)),
            'block_w': bw, 'block_h': bh, 'bpb': bpb,
            'width': u32(b, brti + 0x24), 'height': u32(b, brti + 0x28),
            'mips': u16(b, brti + 0x16), 'size': u32(b, brti + 0x50),
            'layers': u32(b, brti + 0x30) or 1,
            'name_ptr': u32(b, brti + 0x60)}


def texture_name(b, ptr):
    if not ptr:
        return ''
    n = u16(b, ptr)
    return b[ptr + 2:ptr + 2 + n].decode('utf-8', 'replace')


def deswizzle(raw, row_bytes, rows, native=True):
    out = np.zeros(rows * row_bytes, dtype=np.uint8)
    gobs_x = (row_bytes + 63) // 64
    gobs_y = (rows + 7) // 8
    for gy in range(gobs_y):
        for gx in range(gobs_x):
            base = (gy * gobs_x + gx) * 512
            for y in range(gy * 8, min(rows, (gy + 1) * 8)):
                for x in range(gx * 64, min(row_bytes, (gx + 1) * 64), 16):
                    o = base + swizzle_offset(x, y, native)
                    n = min(16, row_bytes - x)
                    if o + n <= len(raw):
                        out[y * row_bytes + x:y * row_bytes + x + n] = raw[o:o + n]
    return out


def decode(info, blocks, width, height):
    name = info['channel']
    if t2d is None:
        raise SystemExit('texture2ddecoder is required: pip install texture2ddecoder')
    if name.startswith('ASTC'):
        return np.frombuffer(t2d.decode_astc(blocks.tobytes(), width, height,
                                             info['block_w'], info['block_h']),
                             dtype=np.uint8).reshape(height, width, 4)
    if name == 'BC6H':
        return np.frombuffer(t2d.decode_bc6(blocks.tobytes(), width, height),
                             dtype=np.uint8).reshape(height, width, 4)
    if name in ('BC1', 'BC4'):
        return np.frombuffer(t2d.decode_bc1(blocks.tobytes(), width, height),
                             dtype=np.uint8).reshape(height, width, 4)
    if name in ('BC3', 'BC5', 'BC7U'):
        fn = {'BC3': t2d.decode_bc3, 'BC5': t2d.decode_bc5, 'BC7U': t2d.decode_bc7}[name]
        return np.frombuffer(fn(blocks.tobytes(), width, height), dtype=np.uint8).reshape(height, width, 4)
    if name == 'R16':
        v = blocks.view('<u2').astype(np.float32) / 65535.0
        g = np.clip(v * 255, 0, 255).astype(np.uint8)
        return np.dstack([g, g, g, np.full_like(g, 255)])
    if name in ('R16G16', 'R16G16B16A16', 'R32G32', 'R32G32B32A32', 'R32'):
        # Uncompressed multi-channel: normalise per component. Float types are
        # tone mapped; unorm types are scaled from their integer range.
        floating = info['type'] in ('Float', 'UFloat')
        dtype = {'R16G16': '<f2' if floating else '<u2',
                 'R16G16B16A16': '<f2' if floating else '<u2',
                 'R32': '<f4', 'R32G32': '<f4', 'R32G32B32A32': '<f4'}[name]
        ncomp = {'R16G16': 2, 'R16G16B16A16': 4, 'R32': 1, 'R32G32': 2,
                 'R32G32B32A32': 4}[name]
        v = blocks[:width * height * ncomp * np.dtype(dtype).itemsize].view(dtype)
        v = v.reshape(height, width, ncomp).astype(np.float32)
        if floating:
            v = np.clip(v, 0.0, 1.0) if v.max() <= 1.5 else v / max(v.max(), 1e-6)
            v = np.clip(v * 255.0, 0, 255)
        else:
            scale = 65535.0 if np.dtype(dtype).itemsize == 2 else 4294967295.0
            v = v / scale * 255.0
        while v.shape[2] < 3:
            v = np.concatenate([v, v[..., :1]], axis=2)
        out = v[..., :3].astype(np.uint8)
        alpha = np.full(out.shape[:2] + (1,), 255, np.uint8)
        return np.concatenate([out, alpha], axis=2)
    if name == 'R8':
        g = blocks[:width * height].reshape(height, width)
        return np.dstack([g, g, g, np.full_like(g, 255)])
    if name == 'R8G8':
        v = blocks[:width * height * 2].reshape(height, width, 2)
        g = v[..., 0]
        return np.dstack([g, g, g, np.full_like(g, 255)])
    if name == 'B8G8R8A8':
        v = blocks.reshape(height, width, 4)[..., [2, 1, 0, 3]]
        return v
    if name == 'R8G8B8A8':
        return blocks.reshape(height, width, 4)
    raise ValueError('unsupported channel ' + name)


def decode_texture(b, mip=0, layer=0):
    """Decode one mip/layer of a BNTX (Ounc) file. Returns (info, rgba).

    Array and cubemap surfaces store each layer's full mip chain contiguously, so a
    layer's mip N sits at layer_stride * layer + (offset of mip N in layer 0).
    """
    brti = u32(b, u32(b, 0x28))
    info = describe(b, brti)
    info['name'] = texture_name(b, info['name_ptr'])
    layers = info['layers']
    layer_stride = info['size'] // layers if layers > 1 else 0
    mip_ptr = u64(b, brti + 0x2a0 + mip * 8) + layer * layer_stride
    width = max(1, info['width'] >> mip)
    height = max(1, info['height'] >> mip)
    row_bytes = math.ceil(width / info['block_w']) * info['bpb']
    rows = math.ceil(height / info['block_h'])
    raw = np.frombuffer(b[mip_ptr:mip_ptr + info['size']], dtype=np.uint8)
    linear = deswizzle(raw, row_bytes, rows)
    blocks = np.frombuffer(linear.tobytes(), dtype=np.uint8)
    return info, decode(info, blocks, width, height)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 2:
        raise SystemExit(__doc__)
    mip = int(sys.argv[sys.argv.index('--mip') + 1]) if '--mip' in sys.argv else 0
    layer = int(sys.argv[sys.argv.index('--layer') + 1]) if '--layer' in sys.argv else 0
    b = open(args[0], 'rb').read()
    info, rgba = decode_texture(b, mip, layer)
    print('%s  %dx%d mips %d layers %d  %s/%s  size %d' % (
        info['name'], info['width'] >> mip, info['height'] >> mip, info['mips'],
        info['layers'], info['channel'], info['type'], info['size']))
    Image.fromarray(rgba, 'RGBA').save(args[1])
    print('wrote', args[1], '%dx%d' % (rgba.shape[1], rgba.shape[0]))


if __name__ == '__main__':
    main()
