#!/usr/bin/env python3
"""Batch-export Mario Kart World textures to PNG.

  python3 tools/bntx_batch.py <romfs-Tex-dir> <out-dir> [--jobs N] [--limit N]
                             [--mips] [--manifest path.json] [--force]

Walks every `*.bntx.zs` under the input, decompresses with `zstd`, decodes mip 0
(or every mip with --mips) through tools/bntx_decode.py, and writes PNGs under the
output directory with the same relative path. Existing PNGs are skipped, so an
interrupted run resumes. A JSON manifest records each texture's name, size,
format and any error.

The dump has ~140k textures and some are 8192x8192, so this is meant to run with
several workers in the background rather than interactively.
"""
import json
import os
import subprocess
import sys
import time
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import numpy as np
from PIL import Image

import bntx_decode


def decompress(path):
    out = subprocess.run(['zstd', '-d', '-q', '-c', path], capture_output=True)
    if out.returncode != 0:
        raise RuntimeError('zstd failed: ' + out.stderr.decode('utf-8', 'replace')[:120])
    return out.stdout


def export_one(job):
    source, target, mips, force = job
    started = time.time()
    record = {'source': source, 'target': target}
    try:
        if not force and not mips and os.path.exists(target):
            record['skipped'] = True
            return record
        b = decompress(source)
        info, rgba = bntx_decode.decode_texture(b, 0)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        Image.fromarray(rgba, 'RGBA').save(target)
        if mips:
            for m in range(1, info['mips']):
                try:
                    _, small = bntx_decode.decode_texture(b, m)
                    name, _ext = os.path.splitext(target)
                    Image.fromarray(small, 'RGBA').save('%s_mip%d.png' % (name, m))
                except Exception:
                    break
        record.update({k: info[k] for k in ('name', 'width', 'height', 'mips',
                                            'channel', 'type', 'format')})
        record['ok'] = True
        record['ms'] = round((time.time() - started) * 1000)
    except Exception as error:
        record['ok'] = False
        record['error'] = str(error)[:200]
    return record


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 2:
        raise SystemExit(__doc__)
    source, output = args[0], args[1]
    jobs = int(sys.argv[sys.argv.index('--jobs') + 1]) if '--jobs' in sys.argv else 8
    limit = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else 0
    manifest_path = sys.argv[sys.argv.index('--manifest') + 1] if '--manifest' in sys.argv else None
    mips = '--mips' in sys.argv
    force = '--force' in sys.argv

    files = []
    for root, _dirs, names in os.walk(source):
        for name in names:
            if name.endswith('.bntx.zs'):
                full = os.path.join(root, name)
                rel = os.path.relpath(full, source)[:-len('.bntx.zs')] + '.png'
                files.append((full, os.path.join(output, rel), mips, force))
    files.sort()
    if limit:
        files = files[:limit]
    print('%d textures -> %s (%d workers)' % (len(files), output, jobs), flush=True)

    done = failed = 0
    started = time.time()
    records = []
    with Pool(jobs) as pool:
        for record in pool.imap_unordered(export_one, files, chunksize=4):
            records.append(record)
            if record.get('skipped'):
                continue
            if record.get('ok'):
                done += 1
            else:
                failed += 1
                print('FAIL %s: %s' % (record['source'], record.get('error')), flush=True)
            total = done + failed
            if total % 100 == 0:
                rate = total / max(time.time() - started, 1e-6)
                print('  %d ok, %d failed, %.1f/s' % (done, failed, rate), flush=True)
    elapsed = time.time() - started
    print('finished: %d ok, %d failed in %.0fs (%.1f/s)' % (done, failed, elapsed,
                                                            (done + failed) / max(elapsed, 1e-6)))
    if manifest_path:
        # Merge with any previous manifest so resumed runs keep a cumulative record
        # instead of replacing it with just the files this run touched.
        merged = {}
        if os.path.exists(manifest_path):
            try:
                for entry in json.load(open(manifest_path)).get('textures', []):
                    merged[entry['source']] = entry
            except Exception:
                pass
        for entry in records:
            prev = merged.get(entry['source'])
            # A resume pass sees the same file as 'skipped'; keep the earlier record
            # that actually decoded it so the manifest stays informative.
            if prev and prev.get('ok') and not entry.get('ok'):
                continue
            merged[entry['source']] = entry
        all_entries = list(merged.values())
        with open(manifest_path, 'w') as f:
            json.dump({'source': source, 'output': output,
                       'textures': all_entries,
                       'ok': sum(1 for e in all_entries if e.get('ok')),
                       'failed': sum(1 for e in all_entries
                                     if not e.get('ok') and not e.get('skipped')),
                       'skipped': sum(1 for e in all_entries if e.get('skipped')),
                       'last_run': {'files': len(files), 'ok': done, 'failed': failed,
                                    'elapsed_s': round(elapsed, 1), 'jobs': jobs}}, f, indent=1)
        print('manifest -> %s (%d entries)' % (manifest_path, len(all_entries)))


if __name__ == '__main__':
    main()
