#!/usr/bin/env python3
"""Audit complete source distributions and the explicitly approved driver."""
import re
import hashlib
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
    'mac2jb/drivers/README.md',
    'mac2jb/drivers/LICENSE',
    'mac2jb/drivers/LICENSE-APSL-2.0.txt',
    'mac2jb/drivers/SHA256SUMS',
    'mac2jb/scripts/install-driver.sh',
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
        approved_driver = path.startswith('mac2jb/drivers/usbgadget.kext/')
        if ('usbgadget.kext' in p.parts and not approved_driver or 'usb_device' in p.parts or
            'xcuserdata' in p.parts or 'project.xcworkspace' in p.parts or p.name.startswith('._') or
            p.name in block_names or p.suffix in block_suffixes):
            violations.append('excluded binary/local/unused file: ' + path)
        if path.startswith('mac2jb/') and not path.startswith('mac2jb/vendor/ns2jb/') and p.suffix in ('.md', '.c', '.h', '.command', '.sh', '.cjs', '.txt') and not path.endswith('LICENSE-APSL-2.0.txt'):
            body = z.read(path) if not path.endswith('/') else b''
            if re.search(rb'V=START\(\d+(?:,\d+){8}\)', body):
                violations.append('literal live-looking pairing string: ' + path)
    driver_files = {
        'Contents/Info.plist': 'c38786b3eb1b51055505bca54c88df77b797e1785c146ec1d54ee3273a934faf',
        'Contents/MacOS/usbgadget': 'a32119c7908098c49c2540a17aad4d172378de969885ad4f4a752bdb8ef91308',
    }
    prefix = 'mac2jb/drivers/usbgadget.kext/'
    for suffix, expected in driver_files.items():
        name = prefix + suffix
        if name not in names or hashlib.sha256(z.read(name)).hexdigest() != expected:
            violations.append('missing or changed approved unsigned driver: ' + name)
    for name in names:
        if name.startswith(prefix) and not name.endswith('/') and name[len(prefix):] not in driver_files:
            violations.append('unexpected driver file or signing metadata: ' + name)

if violations:
    for v in violations:
        print('FAIL:', v, file=sys.stderr)
    raise SystemExit(1)
print(f'PASS: {archive} contains expected source, licenses, and the approved unsigned driver without excluded artifacts.')
