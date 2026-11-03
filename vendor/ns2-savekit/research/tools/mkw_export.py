#!/usr/bin/env python3
"""Export one Mario Kart World model, or a whole directory of them.

  python3 tools/mkw_export.py <model.bfres.zs> <out-dir> [--tex-source DIR]
  python3 tools/mkw_export.py --all <Model-dir> <out-dir> [--jobs N] [--limit N]

Per model it writes, under <out-dir>/<model>/:

  <model>.obj          geometry, one group per mesh
  <model>.mtl          material with map_Kd / map_Ks / map_Ke / map_Bump
  ../tex/<name>.png    every referenced texture, decoded once and shared

`--all` walks a romfs Model directory. Textures go to a single shared cache so
models that reference the same texture decode it once; an existing PNG is reused,
so an interrupted run resumes.
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import numpy as np
from PIL import Image

import bfres10
import bntx_decode


def decompress(path, target):
    out = subprocess.run(['zstd', '-d', '-q', '-f', path, '-o', target], capture_output=True)
    if out.returncode != 0:
        raise SystemExit('zstd failed: ' + out.stderr.decode('utf-8', 'replace')[:200])
    return target


def export_texture(tex_source, ref, tex_cache):
    target = os.path.join(tex_cache, ref + '.png')
    if os.path.exists(target):
        return target
    source = os.path.join(tex_source, ref + '.bntx.zs')
    if not os.path.exists(source):
        return None
    raw = subprocess.run(['zstd', '-d', '-q', '-c', source], capture_output=True).stdout
    info, rgba = bntx_decode.decode_texture(raw, 0)
    os.makedirs(tex_cache, exist_ok=True)
    Image.fromarray(rgba, 'RGBA').save(target)
    return target


def export_model(model_path, out_root, tex_source=None, tex_cache=None):
    """Export one model. Returns a record describing what was written."""
    if tex_source is None:
        # romfs/Model/x.bfres.zs -> romfs/Tex
        tex_source = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(model_path))), 'Tex')
    name = os.path.basename(model_path).split('.bfres')[0]
    if '.anim.' in name or name.endswith('.anim'):
        # Animation-only BFRES: no FMDL, nothing to export as a mesh.
        return {'model': model_path, 'name': name, 'skipped': True, 'reason': 'animation'}
    out_dir = os.path.join(out_root, name)
    tex_cache = tex_cache or os.path.join(out_root, 'tex')
    os.makedirs(out_dir, exist_ok=True)
    obj = os.path.join(out_dir, name + '.obj')
    record = {'model': model_path, 'name': name, 'obj': obj}
    skeleton_path = os.path.join(out_dir, name + '.skeleton.json')
    if os.path.exists(obj):
        # A previous pass wrote the mesh; still fill in the skeleton if it predates
        # skeleton support.
        if not os.path.exists(skeleton_path):
            try:
                raw_path = os.path.join(out_dir, name + '.bfres')
                decompress(model_path, raw_path)
                b = np.fromfile(raw_path, dtype=np.uint8)
                bones = bfres10.skeleton(b, bfres10.parse(b)['model'])
                os.unlink(raw_path)
                if bones:
                    with open(skeleton_path, 'w') as f:
                        json.dump({'model': name, 'bones': bones}, f, indent=1)
                    record.update({'skeleton': len(bones), 'ok': True})
                    return record
            except Exception as error:
                record['error'] = str(error)[:160]
        record['skipped'] = True
        return record

    raw_path = os.path.join(out_dir, name + '.bfres')
    decompress(model_path, raw_path)
    try:
        b = np.fromfile(raw_path, dtype=np.uint8)
        model = bfres10.parse(b)
        if not model['shapes']:
            record['skipped'] = True
            record['reason'] = 'no shapes'
            return record
        shapes_out = []
        offset_by_stride = {}
        for si, shape in enumerate(model['shapes']):
            stride = shape['vertex']['stride']
            pos, meshes = bfres10.shape_geometry(b, shape, offset_by_stride.get(stride))
            offset_by_stride.setdefault(stride, bfres10.position_offset(
                b[shape['vertex']['data']:shape['vertex']['data'] +
                  stride * shape['vertex']['count']].reshape(shape['vertex']['count'], stride)))
            shapes_out.append(('s%d' % si, pos, meshes))

        bones = bfres10.skeleton(b, model['model'])
        if bones:
            with open(os.path.join(out_dir, name + '.skeleton.json'), 'w') as f:
                json.dump({'model': name, 'bones': bones}, f, indent=1)
        refs = bfres10.texture_references(b)
        decoded = [ref for ref in refs if export_texture(tex_source, ref, tex_cache)]
        mtl = os.path.join(out_dir, name + '.mtl')
        bfres10.write_mtl(mtl, decoded, os.path.join('..', 'tex'))
        bfres10.write_obj(obj, shapes_out, name, os.path.basename(mtl))
        record.update({'bones': len(bones),
                       'shapes': len(model['shapes']),
                       'groups': sum(len(m) for _, _, m in shapes_out),
                       'vertices': sum(len(p) for _, p, _ in shapes_out),
                       'indices': sum(len(m) for _, _, ms in shapes_out for m in ms),
                       'textures': len(decoded), 'refs': len(refs), 'ok': True})
    finally:
        if os.path.exists(raw_path):
            os.unlink(raw_path)
    return record


def batch(source, out_root):
    from multiprocessing import Pool
    jobs = int(sys.argv[sys.argv.index('--jobs') + 1]) if '--jobs' in sys.argv else 8
    limit = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else 0
    manifest = sys.argv[sys.argv.index('--manifest') + 1] if '--manifest' in sys.argv else None
    tex_source = (sys.argv[sys.argv.index('--tex-source') + 1]
                  if '--tex-source' in sys.argv else os.path.join(os.path.dirname(source), 'Tex'))
    models = sorted(os.path.join(source, n) for n in os.listdir(source) if n.endswith('.bfres.zs'))
    if limit:
        models = models[:limit]
    print('%d models -> %s (%d workers)' % (len(models), out_root, jobs), flush=True)
    tex_cache = os.path.join(out_root, 'tex')
    started = time.time()
    ok = failed = skipped = 0
    records = []
    with Pool(jobs) as pool:
        tasks = [(m, out_root, tex_source, tex_cache) for m in models]
        for record in pool.imap_unordered(_run, tasks, chunksize=2):
            records.append(record)
            if record.get('skipped'):
                skipped += 1
            elif record.get('ok'):
                ok += 1
            else:
                failed += 1
                print('FAIL %s: %s' % (record['model'], record.get('error')), flush=True)
            total = ok + failed + skipped
            if total and total % 100 == 0:
                print('  %d ok, %d failed, %d skipped (%.1f/s)' % (
                    ok, failed, skipped, total / max(time.time() - started, 1e-6)), flush=True)
    elapsed = time.time() - started
    print('finished: %d ok, %d failed, %d skipped in %.0fs' % (ok, failed, skipped, elapsed))
    if manifest:
        with open(manifest, 'w') as f:
            json.dump({'source': source, 'output': out_root, 'models': records,
                       'ok': ok, 'failed': failed, 'skipped': skipped,
                       'elapsed_s': round(elapsed, 1)}, f, indent=1)
        print('manifest ->', manifest)


def _run(args):
    model_path, out_root, tex_source, tex_cache = args
    try:
        return export_model(model_path, out_root, tex_source, tex_cache)
    except BaseException as error:
        return {'model': model_path, 'name': os.path.basename(model_path), 'ok': False,
                'error': str(error)[:200]}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 2:
        raise SystemExit(__doc__)
    if '--all' in sys.argv:
        batch(args[0], args[1])
        return
    record = export_model(args[0], args[1],
                          sys.argv[sys.argv.index('--tex-source') + 1]
                          if '--tex-source' in sys.argv else None)
    print('%s: %s shapes, %s groups, %s vertices, %s indices, %s/%s textures' % (
        record['name'], record.get('shapes'), record.get('groups'), record.get('vertices'),
        record.get('indices'), record.get('textures'), record.get('refs')))
    print('wrote', record['obj'])


if __name__ == '__main__':
    main()
