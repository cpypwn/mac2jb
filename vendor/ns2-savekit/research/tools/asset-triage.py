#!/usr/bin/env python3
"""Classify a dumped romfs tree by container magic, before decoding anything.

    python3 tools/asset-triage.py <romfs-dir> [--json out.json]

Prints one row per format: how many files, total bytes, the versions seen, and a
few example paths. The point is to answer "what do we actually have to decode"
from evidence instead of from a list of formats we hope are there.

Recognised magics are the ones a Switch content dump produces: BFRES (models,
skeleton, materials), BNTX (textures), BFSHA/BFSHP/BFSTM/BFANM/BFRES-adjacent
containers, SARC/SZS, and the Yaz0/zstd wrappers that hide them.
"""
import json
import os
import struct
import sys
from collections import Counter, defaultdict

MAGICS = {
    b'FRES': ('BFRES', 'model / skeleton / material / embedded texture'),
    b'BNTX': ('BNTX', 'texture container'),
    b'FFNT': ('FFNT', 'font'),
    b'BFSTM': ('BFSTM', 'audio stream'),
    b'BFSAR': ('BFSAR', 'audio archive'),
    b'BFGRP': ('BFGRP', 'group'),
    b'BFRES': ('BFRES', 'model'),
    b'SARC': ('SARC', 'archive'),
    b'Yaz0': ('Yaz0', 'compressed (Nintendo)'),
    b'\x28\xb5\x2f\xfd': ('zstd', 'compressed (zstd)'),
    b'BCH': ('BCH', '3DS model'),
    b'FLYT': ('FLYT', 'layout'),
    b'BNSH': ('BNSH', 'shader'),
    b'BNSHB': ('BNSHB', 'shader'),
    b'GRP1': ('GRP1', 'group'),
}


def classify(path):
    try:
        with open(path, 'rb') as handle:
            head = handle.read(16)
    except OSError:
        return None
    for magic, (name, note) in MAGICS.items():
        if not head.startswith(magic):
            continue
        version = None
        # The two containers pack their version differently and at different
        # offsets: BFRES has an 8-byte magic ("FRES    ") and major in the low
        # byte at 0x08; BNTX has major in bits 16-23 of the word at 0x04.
        try:
            if name == 'BFRES' and len(head) >= 12:
                version = '0x%08x' % struct.unpack('<I', head[8:12])[0]
            elif name == 'BNTX' and len(head) >= 8:
                version = '0x%08x' % struct.unpack('<I', head[4:8])[0]
        except struct.error:
            version = None
        return name, note, version
    return None


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    root = argv[1]
    out = argv[argv.index('--json') + 1] if '--json' in argv else None

    rows = defaultdict(lambda: {'files': 0, 'bytes': 0, 'versions': Counter(), 'examples': []})
    unknown = Counter()
    total = 0
    for directory, _, names in os.walk(root):
        for name in names:
            path = os.path.join(directory, name)
            try:
                size = os.path.getsize(path)
            except OSError:
                continue
            total += size
            found = classify(path)
            key = found[0] if found else ('other:' + os.path.splitext(name)[1].lower())
            row = rows[key]
            row['files'] += 1
            row['bytes'] += size
            if found and found[2]:
                row['versions'][found[2]] += 1
            if len(row['examples']) < 3:
                row['examples'].append(os.path.relpath(path, root))
            if not found:
                unknown[os.path.splitext(name)[1].lower()] += 1

    ordered = sorted(rows.items(), key=lambda item: -item[1]['bytes'])
    print('%12s %8s %10s  %s' % ('bytes', 'files', 'format', 'versions / examples'))
    for name, row in ordered:
        versions = ', '.join('%s x%d' % (v, n) for v, n in row['versions'].most_common(4))
        print('%12d %8d %10s  %s' % (row['bytes'], row['files'], name, versions))
        for example in row['examples'][:2]:
            print('%30s %s' % ('', example))
    print('\n%d files, %.1f MiB total' % (sum(r['files'] for r in rows.values()), total / 1048576.0))
    if unknown:
        print('unrecognised extensions: ' +
              ', '.join('%s x%d' % (ext or '(none)', n) for ext, n in unknown.most_common(10)))

    if out:
        with open(out, 'w') as handle:
            json.dump({name: {'files': row['files'], 'bytes': row['bytes'],
                              'versions': dict(row['versions']),
                              'examples': row['examples']}
                       for name, row in rows.items()}, handle, indent=1)
        print('wrote ' + out)


if __name__ == '__main__':
    main(sys.argv)
