#!/usr/bin/env python3
"""Extract geometry from a Mario Kart World BFRES (nn::g3d2, version 10.2.x).

  python3 tools/bfres10.py <model.bfres> <out.obj> [--preview out.png] [--tex-dir DIR]

Verified against real files:

  header   0x28 -> ResModel (FMDL), 0x1c pool size (GPU region = tail of file)
  FMDL     0x28 -> ResShape array, 0x68/0x6a/0x6c vertex/shape/material counts
  FSHP     0x60-byte blocks; 0x10 ResVertex, 0x18 mesh array, 0x52 material,
           0x5b mesh count
  FVTX     0x38 stride array, 0x48 data offset, 0x50 vertex count
  ResMesh  0x38-byte entries; 0x20 index offset, 0x2c index count

Index and vertex offsets are relative to the GPU region base. Positions are a
float3 inside the vertex record; the offset is not fixed (8 for the accel ring, 0
for the aerial sign, 16 and 20 for other shapes of the same model), so it is
detected per shape and validated. A record's first bytes are packed attributes,
not the position.
"""
import os
import struct
import sys
import warnings

import numpy as np

warnings.filterwarnings('ignore', category=RuntimeWarning)

SHAPE_SIZE = 0x60
MESH_SIZE = 0x38
SUFFIXES = ('_Alb', '_Nrm', '_Mix', '_Occ', '_Emm')
PREFIXES = ('CmnObj_', 'CmnTex_', 'Stage_', 'Driver_', 'Kart_', 'Map_', 'Tera')


def u32(b, o):
    return struct.unpack_from('<I', b, o)[0]


def u64(b, o):
    return struct.unpack_from('<Q', b, o)[0]


def u16(b, o):
    return struct.unpack_from('<H', b, o)[0]


def ptr(b, o):
    v = u32(b, o)
    return v if 0 < v < len(b) else None


def gpu_base(b):
    """GPU region size is the u32 at 0x16c (0x168 holds a constant 0x24)."""
    size = u32(b, 0x16c)
    if not 0 < size <= len(b):
        raise SystemExit('unexpected GPU pool size 0x%x' % size)
    return len(b) - size


def vertex_info(b, vertex):
    if bytes(b[vertex:vertex + 4]) != b'FVTX':
        raise SystemExit('no FVTX at %#x' % vertex)
    return {'vertex': vertex,
            'stride': u32(b, u64(b, vertex + 0x38)),
            'data': gpu_base(b) + u32(b, vertex + 0x48),
            'count': u32(b, vertex + 0x50)}


def parse(b):
    model = ptr(b, 0x28)
    if not model or bytes(b[model:model + 4]) != b'FMDL':
        raise SystemExit('no FMDL at 0x28')
    shapes = []
    shape_array = u64(b, model + 0x28)
    for i in range(u16(b, model + 0x6a)):
        shape = shape_array + i * SHAPE_SIZE
        if bytes(b[shape:shape + 4]) != b'FSHP':
            break
        meshes = []
        mesh_array = u64(b, shape + 0x18)
        for m in range(b[shape + 0x5b]):
            mesh = mesh_array + m * MESH_SIZE
            meshes.append({'index': gpu_base(b) + u32(b, mesh + 0x20),
                           'count': u32(b, mesh + 0x2c)})
        shapes.append({'shape': shape, 'vertex': vertex_info(b, u64(b, shape + 0x10)),
                       'meshes': meshes, 'material': u16(b, shape + 0x52)})
    return {'model': model, 'shapes': shapes, 'materials': u16(b, model + 0x6c)}


def position_offset(rec):
    """Pick the float3 offset whose three axes all span real geometry."""
    n, stride = rec.shape
    best = (0, -1.0)
    for off in range(0, stride - 11, 4):
        v = rec[:, off:off + 12].copy().view('<f4').reshape(n, 3).astype(np.float64)
        if not np.isfinite(v).all():
            continue
        rows = (np.abs(v) < 1e3).all(axis=1)
        if rows.sum() < 0.9 * n:
            continue
        q = v[rows]
        extent = float((q.max(axis=0) - q.min(axis=0)).min())
        if extent > best[1]:
            best = (off, extent)
    return best[0]


def shape_geometry(b, shape, shared_offset=None):
    """Positions and per-mesh index lists, or empty when the buffer is unusable."""
    v = shape['vertex']
    stride, count = v['stride'], v['count']
    raw = b[v['data']:v['data'] + stride * count]
    if (count == 0 or not 4 <= stride <= 256 or stride % 4 or len(raw) < stride * count):
        return np.zeros((0, 3)), []
    rec = raw.reshape(count, stride)

    off = position_offset(rec)
    if off + 12 > stride:
        return np.zeros((0, 3)), []
    probe = rec[:, off:off + 12].copy().view('<f4').reshape(count, 3).astype(np.float64)
    rows = (np.abs(probe) < 1e3).all(axis=1)
    if not (rows.mean() > 0.9 and np.isfinite(probe[rows]).all()):
        # A small buffer dominated by sentinel vertices: fall back to the offset
        # another shape with the same stride used.
        if shared_offset is not None and shared_offset + 12 <= stride:
            off = shared_offset
            probe = rec[:, off:off + 12].copy().view('<f4').reshape(count, 3).astype(np.float64)
        else:
            return np.zeros((0, 3)), []

    pos = probe
    finite = np.isfinite(pos).all(axis=1)
    inliers = finite & (np.abs(pos) < 1e3).all(axis=1)
    # Scale to the model: a character is ~2 units, a ring ~20.
    limit = max(10.0, 20.0 * float(np.median(np.abs(pos[inliers])))) if inliers.any() else 10.0
    pos[~finite | (np.abs(pos).max(axis=1) > limit)] = 0.0

    meshes = []
    for mesh in shape['meshes']:
        idx = b[mesh['index']:mesh['index'] + mesh['count'] * 2].copy().view('<u2').astype(np.int64)
        if len(idx) and idx.max() < count:
            meshes.append(idx)
    return pos, meshes


def skeleton(b, model=None):
    """FSKL as a bone list: name, parent index, and local transform.

    Bone headers are 0x58 bytes from the array pointer at FSKL+0x10: name pointer
    at +0x00, parent (s16, -1 for the root) at +0x22, scale at +0x30, rotation at
    +0x3c and translation at +0x4c. The rotation reads as Euler radians (a bone with
    1.57 on X is a quarter turn); it is exported as stored.
    """
    model = model or ptr(b, 0x28)
    fskl = u64(b, model + 0x18)
    if not fskl or bytes(b[fskl:fskl + 4]) != b'FSKL':
        return []
    array = u64(b, fskl + 0x10)
    count = u16(b, fskl + 0x38)
    bones = []
    for i in range(count):
        off = array + i * 0x58
        name_ptr = u32(b, off)
        name = ''
        if 0 < name_ptr < len(b):
            length = u16(b, name_ptr)
            if 0 < length < 64:
                name = b[name_ptr + 2:name_ptr + 2 + length].tobytes().decode('ascii', 'replace')
        bones.append({'index': i, 'name': name,
                      'parent': struct.unpack_from('<h', b, off + 0x22)[0],
                      'scale': [round(v, 6) for v in struct.unpack_from('<3f', b, off + 0x30)],
                      'rotation': [round(v, 6) for v in struct.unpack_from('<3f', b, off + 0x3c)],
                      'translation': [round(v, 6) for v in struct.unpack_from('<3f', b, off + 0x4c)]})
    return bones


def texture_references(b):
    """Pascal strings in the model that name a texture in the Tex directory."""
    refs = set()
    for off in range(0, len(b) - 4):
        length = u16(b, off)
        if not 6 <= length <= 64 or off + 2 + length > len(b):
            continue
        chunk = b[off + 2:off + 2 + length]
        if not all(32 <= c < 127 for c in chunk):
            continue
        text = chunk.tobytes().decode('ascii', 'replace')
        if text.startswith(PREFIXES) and any(s in text for s in SUFFIXES):
            refs.add(text)
    return sorted(refs)


def write_mtl(path, refs, tex_dir):
    albedo = next((r for r in refs if r.endswith('_Alb')), None)
    normal = next((r for r in refs if r.endswith('_Nrm')), None)
    mask = next((r for r in refs if r.endswith('_Mix')), None)
    emissive = next((r for r in refs if r.endswith('_Emm')), None)
    with open(path, 'w') as f:
        f.write('# generated by tools/bfres10.py\n')
        f.write('newmtl %s\n' % os.path.splitext(os.path.basename(path))[0])
        f.write('Kd 1.000 1.000 1.000\n')
        for ref, key in ((albedo, 'map_Kd'), (mask, 'map_Ks'), (emissive, 'map_Ke')):
            if ref:
                f.write('%s %s\n' % (key, os.path.join(tex_dir, ref + '.png')))
        if normal:
            f.write('map_Bump %s\n' % os.path.join(tex_dir, normal + '.png'))
        f.write('\n')


def write_obj(path, shapes, name, material=None):
    with open(path, 'w') as f:
        f.write('# %s\n' % name)
        if material:
            f.write('mtllib %s\n' % material)
            f.write('usemtl %s\n' % os.path.splitext(material)[0])
        base = 0
        for sname, pos, meshes in shapes:
            if len(pos) == 0:
                continue
            f.write('o %s\n' % sname)
            for p in pos:
                f.write('v %.6f %.6f %.6f\n' % tuple(p))
            for mi, idx in enumerate(meshes):
                f.write('g %s_m%d\n' % (sname, mi))
                for i in range(0, len(idx) - 2, 3):
                    a, b_, c = int(idx[i]), int(idx[i + 1]), int(idx[i + 2])
                    if a != b_ and b_ != c and a != c:
                        f.write('f %d %d %d\n' % (base + a + 1, base + b_ + 1, base + c + 1))
            base += len(pos)


def preview(path, pos, idx):
    from PIL import Image, ImageDraw
    w = h = 640
    img = Image.new('RGB', (w, h), (18, 18, 22))
    draw = ImageDraw.Draw(img)
    xy = pos[:, :2]
    lo, hi = xy.min(axis=0), xy.max(axis=0)
    scale = (w - 40) / max(float((hi - lo).max()), 1e-6)
    screen = [(w / 2 + (x - (lo[0] + hi[0]) / 2) * scale,
               h / 2 - (y - (lo[1] + hi[1]) / 2) * scale) for x, y in xy]
    for i in range(0, len(idx) - 2, 3):
        a, b_, c = int(idx[i]), int(idx[i + 1]), int(idx[i + 2])
        if a != b_ and b_ != c and a != c:
            draw.polygon([screen[a], screen[b_], screen[c]], outline=(90, 190, 255))
    img.save(path)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 2:
        raise SystemExit(__doc__)
    b = np.fromfile(args[0], dtype=np.uint8)
    model = parse(b)
    shapes_out = []
    offset_by_stride = {}
    lo = np.array([np.inf] * 3)
    hi = np.array([-np.inf] * 3)
    total_v = total_i = 0
    for si, shape in enumerate(model['shapes']):
        stride = shape['vertex']['stride']
        pos, meshes = shape_geometry(b, shape, offset_by_stride.get(stride))
        if len(pos) == 0:
            continue
        offset_by_stride.setdefault(stride, position_offset(
            b[shape['vertex']['data']:shape['vertex']['data'] + stride * shape['vertex']['count']]
            .reshape(shape['vertex']['count'], stride)))
        shapes_out.append(('s%d' % si, pos, meshes))
        lo = np.minimum(lo, pos.min(axis=0))
        hi = np.maximum(hi, pos.max(axis=0))
        total_v += len(pos)
        total_i += sum(len(m) for m in meshes)
    print('shapes %d  vertices %d  indices %d  materials %d  groups %d' % (
        len(model['shapes']), total_v, total_i, model['materials'],
        sum(len(m) for _, _, m in shapes_out)))
    if shapes_out:
        print('bounds x %.2f..%.2f  y %.2f..%.2f  z %.2f..%.2f' % (
            lo[0], hi[0], lo[1], hi[1], lo[2], hi[2]))
    refs = texture_references(b)
    mtl = None
    if refs:
        tex_dir = sys.argv[sys.argv.index('--tex-dir') + 1] if '--tex-dir' in sys.argv else 'tex'
        mtl = os.path.splitext(args[1])[0] + '.mtl'
        write_mtl(mtl, refs, tex_dir)
        print('textures: %s' % ', '.join(refs))
    write_obj(args[1], shapes_out, args[0].split('/')[-1], mtl and os.path.basename(mtl))
    print('wrote', args[1])
    if '--preview' in sys.argv and shapes_out:
        out = sys.argv[sys.argv.index('--preview') + 1]
        preview(out, shapes_out[0][1], shapes_out[0][2][0])
        print('wrote', out)


if __name__ == '__main__':
    main()
