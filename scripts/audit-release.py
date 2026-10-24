#!/usr/bin/env python3
"""CI release ZIP audit: validate source-only distribution and required licenses."""
import re
import sys
import zipfile
from pathlib import PurePosixPath

if len(sys.argv) != 2:
    raise SystemExit('usage: python3 scripts/audit-release.py mac2jb-complete.zip')

archive = sys.argv[1]
required = {
    'mac2jb/LICENSE',
    'mac2jb/vendor/libusbd/LICENSE',
    'mac2jb/vendor/libusbd/LICENSE-APSL-2.0.txt',
    'mac2jb/vendor/macos_usb_gadget_poc/LICENSE-APSL-2.0.txt',
    'mac2jb/vendor/macos_usb_gadget_poc/usbgadget/LICENSE',
    'mac2jb/vendor/ns2jb/run.cjs',
    'mac2jb/assets/bootstrap.bas',
    'mac2jb/mac2jb.command',
    'mac2jb/setup.sh',
    'mac2jb/vendor/macos_usb_gadget_poc/usbgadget/usbgadget.xcodeproj/project.pbxproj',
}
block_names = ('mac2jb-send', 'mac2jb-commands', '.DS_Store')
block_suffixes = ('.o', '.dylib', '.log', '.xcuserstate', '.pyc', '.bak')
violations = []
with zipfile.ZipFile(archive) as z:
    names = set(z.namelist())
    for missing in sorted(required - names):
        violations.append('missing required file: ' + missing)
    for path in sorted(names):
        p = PurePosixPath(path)
        if path.startswith('/') or '..' in p.parts or '\\' in path:
            violations.append('unsafe archive path: ' + path)
        if '.git' in p.parts or '__MACOSX' in p.parts or 'runs' in p.parts and 'vendor/ns2jb/' in path:
            violations.append('Git metadata or ns2jb runtime data: ' + path)
        if ('usbgadget.kext' in p.parts or 'usb_device' in p.parts or
            'xcuserdata' in p.parts or 'project.xcworkspace' in p.parts or p.name.startswith('._') or
            p.name in block_names or p.suffix in block_suffixes):
            violations.append('excluded binary/local/unused file: ' + path)
        if path.startswith('mac2jb/') and not path.startswith('mac2jb/vendor/ns2jb/') and p.suffix in ('.md', '.c', '.h', '.command', '.sh', '.cjs', '.txt') and not path.endswith('LICENSE-APSL-2.0.txt'):
            body = z.read(path) if not path.endswith('/') else b''
            if re.search(rb'V=START\(\d+(?:,\d+){8}\)', body):
                violations.append('literal live-looking pairing string: ' + path)

if violations:
    for v in violations:
        print('FAIL:', v, file=sys.stderr)
    raise SystemExit(1)
print(f'PASS: {archive} contains expected source and licenses without excluded artifacts.')
