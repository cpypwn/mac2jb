#!/usr/bin/env python3
"""Build a save-write-stage manifest that installs a flat save backup.

  python3 build-editor-manifest.py <source-dir> <backup-dir> <out.json>

Every non-hidden file in <source-dir> becomes an entry at the save root. A file
that already exists in <backup-dir> is marked replace=true, which makes
save-write-stage.cjs verify the live bytes against that backup before it
overwrites them; a file that is not in the backup is add-only.

Hidden files are skipped: .nx_save_meta.bin is JKSV bookkeeping, not save data.
"""
import json
import os
import re
import sys

SAFE = re.compile(r'^[A-Za-z0-9_.-]+$')


def main(argv):
    if len(argv) != 4:
        sys.exit(__doc__)
    source, backup, out = argv[1:]
    names = sorted(name for name in os.listdir(source)
                   if not name.startswith('.'))
    if not names:
        sys.exit('no files in ' + source)
    present = set(os.listdir(backup)) if os.path.isdir(backup) else set()
    files, total, replaced = [], 0, 0
    for name in names:
        if not SAFE.match(name) or os.path.isdir(os.path.join(source, name)):
            sys.exit('refusing unsafe or nested entry: ' + name)
        size = os.path.getsize(os.path.join(source, name))
        total += size
        entry = {'path': '/' + name, 'local': os.path.join(source, name)}
        if name in present:
            entry['replace'] = True
            replaced += 1
        files.append(entry)
    manifest = {
        'title': 'Seedsow Lullaby demo -- seedsow-lua-editor v0.1.2 save',
        'source': source,
        'backup': backup,
        'files': files,
    }
    with open(out, 'w') as handle:
        json.dump(manifest, handle, indent=2)
        handle.write('\n')
    print('%s: %d files, %d replace, %d add, %.1f MiB'
          % (out, len(files), replaced, len(files) - replaced, total / 1048576.0))


if __name__ == '__main__':
    main(sys.argv)
