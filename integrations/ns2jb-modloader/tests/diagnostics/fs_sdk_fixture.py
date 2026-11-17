"""Resolve SDK mutex fixtures using the product's FS qualifier, not firmware tables."""
import json, subprocess


def load_sdk_mutex(root, capture):
    validation = json.loads(subprocess.check_output([
        'node', '-e', "const fs=require('node:fs');process.stdout.write(JSON.stringify(require('./lib/native.cjs').validateCapture(fs.readFileSync(process.argv[1]))));",
        str(capture.resolve()),
    ], cwd=root))
    layout = validation.get('layout')

    def offset(reference):
        if not layout:
            return reference
        direct = layout['offsets'].get(str(reference))
        if direct is not None:
            return direct
        for entry in layout['ranges']:
            if entry['offset'] <= reference < entry['offset'] + entry['size']:
                return entry['actual'] + reference - entry['offset']
        raise AssertionError('Unqualified fixture reference')

    lock, unlock = offset(0x2187d0), offset(0x218870)
    start = lock & ~4095
    end = (unlock + 0x48 + 4095) & ~4095
    return capture.read_bytes()[start:end], start, lock, unlock
