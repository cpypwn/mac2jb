#!/usr/bin/env python3
import gzip
import hashlib
import json
import plistlib
import re
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

RUNTIME_MANIFEST = 'packaging/runtime-files.json'
PREPARED_RUNTIME_PATHS = {
    'vendor/MintBrew/apps/ftpd-sb/app.json',
    'vendor/MintBrew/apps/mintftp/app.json',
    'vendor/MintBrew/apps/ouncecake/app.json',
    'vendor/HBLauncher/apps/ftpd-sb/app.json',
    'vendor/GPUBrewLauncher/apps/ftpd-sb/app.json',
}
RESEARCH_ONLY_FOLDERS = (
    'integrations/gravcirc-fs',
    'integrations/balatro-fs',
)
EXCLUDED_PACKAGE_FOLDERS = (
    'integrations/kaihen-stremio',
    'vendor/ns2jb-hosts/cellenseres', 'vendor/ns2jb-hosts/astral',
)


SOURCE_FILES = (
    'README.md', 'LICENSE', '.gitignore', 'Makefile', 'sender.c', 'commands.c',
    'keyboard.c', 'civswitch-hid.c', 'indent-test.bas', 'upstream.lock', 'mac2jb.command',
    'setup.sh', 'fetch-bootstrap.sh', 'make-release-zip.command',
)
SOURCE_FOLDERS = (
    'gui', 'scripts', 'packaging', 'drivers', 'assets', 'vendor',
    'integrations', 'docs', 'tools/bootstrap-kit', 'tools/mcp', '.github',
)
RUNTIME_FOLDERS = (
    'vendor/ns2jb', 'vendor/ns2jb-hosts', 'vendor/ns2-savekit',
    'vendor/CivSwitch/installer-creator/node_modules',
    'vendor/OunceCake', 'vendor/OunceCake-Civ7', 'assets', 'drivers',
    'integrations',
)
OMITTED_RUNTIME_FOLDERS = (
    'vendor/MintBrew/apps/mintnes',
    'vendor/MintBrew/apps/mintftp',
    'integrations/mintnes',
    'integrations/luna-editor',
    'integrations/mintbrew-file-explorer',
    'integrations/mintbrew-native/upstream/apps/mintnes/tests/build',
    'integrations/mintbrew-native',
    'integrations/mintbrew-stremio', 'integrations/nsp-box',
    'integrations/civ-stremio', 'integrations/kaihen-stremio',
    'integrations/civhomebrew-catalog', 'integrations/sw2nes', 'integrations/jellyfin',
    'integrations/nup-support', 'integrations/browser-probes',
    'vendor/switch2-captive-portal-research',
)
PERSONAL_SHOWCASE_PATHS = (
    'scripts/build-seedsow-full-showcase.cjs',
    'integrations/civswitch/hello.js',
    'integrations/civswitch/send-hello.cjs',
    'integrations/civswitch/send-hello.test.cjs',
    'integrations/balatro-rce/showcase.lua',
    'integrations/balatro-rce/build-showcase.py',
    'integrations/seedsow-lua',
    'integrations/artemis/cpypwn-showcase.lua',
    'integrations/artemis/cpypwn-kaleidoscope.lua',
    'integrations/artemis/cpypwn-full-showcase.lua',
    'integrations/artemis/README-seedsow-full-showcase.txt',
    'integrations/artemis/seedsowhax-v1-mac2jb.zip',
    'integrations/artemis/norahax-v1-mac2jb.zip',
    'integrations/gravcirc-rce/cpypwn-circuit-showcase.lua',
    'integrations/gravcirc-rce/build-cpypwn-save.py',
    'integrations/gravcirc-rce/send-showcase.py',
)
BLOCKED_PARTS = {
    '.git', '.build', 'runs', 'dumps', '__pycache__', 'xcuserdata',
    'project.xcworkspace', 'usb_device', '.DS_Store',
}
BLOCKED_SUFFIXES = {
    '.o', '.dylib', '.log', '.pyc', '.bak', '.xcuserstate', '.kate-swp',
}
EXECUTABLES = {
    'node', 'mac2jb-send', 'mac2jb-commands', 'mac2jb-keyboard', 'mac2jb-civswitch-hid',
}

REMOVED_COMPONENTS = (
    'gui/CivSwitchControlCenterModel.swift',
    'gui/CivStremioModel.swift',
    'integrations/civ-stremio',
    'vendor/CivSwitch-ControlCenter',
    'integrations/civswitch-control-center',
    'vendor/IZ2S-Platform', 'vendor/IZDOOM', 'vendor/BlitBun',
    'vendor/ns2jb-hosts/izmysh-legacy', 'integrations/izlauncher-shell',
    'integrations/blitbun', 'integrations/vacootube', 'integrations/izdoom',
    'integrations/mintbrew-iz-exchange', 'integrations/super-file-bros',
    'integrations/civswitch/izlauncher-save',
    'vendor/MintBrew/apps/izdoom', 'vendor/MintBrew/apps/iz-exchange',
    'scripts/gui-izlauncher.cjs', 'scripts/gui-civswitch-izlauncher.cjs',
    'scripts/gui-civswitch-izlauncher-save.cjs', 'scripts/prepare-izlauncher.cjs',
    'scripts/check-izlauncher-runtime.cjs', 'scripts/izlauncher-modules.cjs',
    'scripts/izlauncher-panel.cjs', 'scripts/stage-custom-izmodule.cjs',
    'packaging/IZ2S-Platform-provenance.json',
    'packaging/IZ2S-Platform-SHA256SUMS',
    'packaging/IZMYSH-legacy-provenance.json',
    'packaging/IZMYSH-legacy-SHA256SUMS',
    'packaging/IZCIVSwitch-izlauncher-save.json',
)

def sha256_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def verify_minimum(payload):
    targets = (
        'node', 'mac2jb-send', 'mac2jb-commands', 'mac2jb-keyboard', 'mac2jb-civswitch-hid',
        'vendor/libusbd/libusbd.dylib',
    )
    for name in targets:
        info = subprocess.check_output(
            ['xcrun', 'vtool', '-show-build', str(payload / name)], text=True
        )
        versions = re.findall(r'\bminos\s+(\d+(?:\.\d+)*)', info)
        if not versions:
            raise SystemExit('Missing deployment target: ' + name)
        for version in versions:
            parts = tuple(map(int, version.split('.')))
            parts += (0,) * (3 - len(parts))
            if parts > (14, 0, 0):
                raise SystemExit(name + ' requires macOS ' + version + ', above GUI minimum 14.0')
        print(name + ': minimum macOS ' + ', '.join(versions))


def safe(relative, source, test_build=False):
    parts = relative.parts
    name = relative.as_posix()
    if any(name == prefix or name.startswith(prefix + '/') for prefix in EXCLUDED_PACKAGE_FOLDERS):
        return False
    removed = any(name == component or name.startswith(component + '/') for component in REMOVED_COMPONENTS)
    if removed:
        return False
    if parts[:3] == ('tools', 'mcp', 'node_modules') or (
        parts[:2] == ('tools', 'bootstrap-kit') and len(parts) > 2 and parts[2].startswith('generated')
    ):
        return False
    if parts[:3] in (
        ('integrations', 'ns2jb-modloader', 'state'),
        ('integrations', 'ns2jb-modloader', 'contents'),
        ('integrations', 'ns2jb-modloader', 'exefs_patches'),
    ):
        return False
    if parts[-2:] == ('packaging', 'test-build.json'):
        return False
    if len(parts) > 2 and parts[0] == 'vendor' and parts[1] in ('HBLauncher', 'GPUBrewLauncher') and parts[2] in ('tools', 'dist'):
        return False
    if 'usbgadget.kext' in parts and 'drivers' not in parts:
        return False
    return (
        not any(part in BLOCKED_PARTS or part.startswith('._') or part.endswith('.dSYM') for part in parts)
        and relative.suffix not in BLOCKED_SUFFIXES
        and not source.is_symlink()
    )


def copy_file(root, source, destination, test_build=False):
    relative = source.relative_to(root)
    if not safe(relative, source, test_build) or not source.is_file():
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    return True


def copy_tree(root, folder, destination, runtime=False, test_build=False):
    base = root / folder
    if not base.exists():
        return
    for source in sorted(base.rglob('*')):
        relative = source.relative_to(root)
        name = relative.as_posix()
        if not test_build and any(name == prefix or name.startswith(prefix + '/') for prefix in RESEARCH_ONLY_FOLDERS):
            continue
        if runtime and not test_build and relative.parts[:1] == ('integrations',) and not name.startswith((
            'integrations/mintbrew-native/upstream/', 'integrations/civswitch/fs-kit/port/'
        )) and (
            name.endswith(('.test.cjs', '.test.lua', '.test.py')) or relative.name == 'test.cjs'
        ):
            continue
        copy_file(root, source, destination / relative, test_build)


def runtime_manifest(root):
    manifest = json.loads((root / RUNTIME_MANIFEST).read_text())
    for field in ('copyFiles', 'requiredPaths', 'testRequiredPaths'):
        paths = manifest.get(field)
        if not isinstance(paths, list) or not all(isinstance(name, str) for name in paths):
            raise SystemExit('Invalid runtime manifest field: ' + field)
        if len(paths) != len(set(paths)) or any(
            not name or name.startswith('/') or '\\' in name or
            any(part in ('', '.', '..') for part in name.split('/')) or
            (field != 'testRequiredPaths' and any(
                name == prefix or name.startswith(prefix + '/') for prefix in RESEARCH_ONLY_FOLDERS
            ))
            for name in paths
        ):
            raise SystemExit('Unsafe or duplicate runtime manifest path: ' + field)
    return manifest


def stage(root, payload, node):
    manifest = runtime_manifest(root)
    source = payload / 'source'
    source.mkdir()
    test_build = plistlib.loads((root / 'gui/Info.plist').read_bytes()).get('MAC2JBTestBuild') is True
    marker = json.dumps({'testBuild': test_build}, indent=2) + '\n'
    (payload / 'packaging').mkdir(parents=True, exist_ok=True)
    (source / 'packaging').mkdir(parents=True, exist_ok=True)
    (payload / 'packaging/test-build.json').write_text(marker)
    (source / 'packaging/test-build.json').write_text(marker)
    copy_file(root, root / RUNTIME_MANIFEST, payload / RUNTIME_MANIFEST)
    (payload / 'packaging/runtime-homebrew.json').write_text(
        json.dumps({'allowed': ['ouncecake']}, indent=2) + '\n'
    )
    for name in SOURCE_FILES:
        if (root / name).exists():
            copy_file(root, root / name, source / name)
    for folder in SOURCE_FOLDERS:
        copy_tree(root, folder, source, test_build=test_build)
    for folder in RUNTIME_FOLDERS:
        copy_tree(root, folder, payload, runtime=True, test_build=test_build)
    always_omit = {
        'integrations/mintbrew-native',
        'integrations/mintbrew-stremio', 'integrations/nsp-box',
        'integrations/civ-stremio', 'integrations/kaihen-stremio',
        'integrations/civhomebrew-catalog', 'integrations/sw2nes', 'integrations/jellyfin',
        'integrations/nup-support', 'integrations/browser-probes',
        'vendor/switch2-captive-portal-research',
    }
    for folder in OMITTED_RUNTIME_FOLDERS:
        if test_build and folder not in always_omit:
            continue
        target = payload / folder
        if target.exists():
            shutil.rmtree(target)
    for name in manifest['copyFiles']:
        if not copy_file(root, root / name, payload / name):
            raise SystemExit('Missing GUI build input: ' + name)
    if not test_build:
        for name in PERSONAL_SHOWCASE_PATHS:
            for base in (payload, source):
                target = base / name
                if target.is_dir():
                    shutil.rmtree(target)
                elif target.exists():
                    target.unlink()
    required = manifest['requiredPaths'] + (manifest['testRequiredPaths'] if test_build else [])
    for name in required:
        if name in PREPARED_RUNTIME_PATHS:
            continue
        if not (payload / name).is_file():
            raise SystemExit('Missing GUI runtime file: ' + name)
    provenance = {
        'version': 'v24.22.1',
        'platform': 'darwin-arm64',
        'origin': 'arm64 slice of locally installed official Node.js distribution',
        'upstream': 'https://nodejs.org/dist/v24.22.1/',
        'licenseSource': 'https://raw.githubusercontent.com/nodejs/node/v24.22.1/LICENSE',
        'installedBinarySha256': sha256_file(node),
        'bundledArm64Sha256': sha256_file(payload / 'node'),
        'licenseSha256': sha256_file(payload / 'licenses/node-LICENSE.txt'),
    }
    (payload / 'licenses/node-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')


def archive(payload, build, source_archive):
    test_build = json.loads((payload / 'packaging/test-build.json').read_text())['testBuild'] is True
    runtime_archive = build / 'runtime.tar.gz'
    with runtime_archive.open('wb') as stream:
        with gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode='w', format=tarfile.USTAR_FORMAT) as tar:
                for item in sorted(payload.rglob('*')):
                    relative = item.relative_to(payload).as_posix()
                    if not test_build and any(relative == prefix or relative.startswith(prefix + '/')
                                              for folder in OMITTED_RUNTIME_FOLDERS
                                              for prefix in (folder, 'source/' + folder)):
                        continue
                    if item.is_symlink():
                        raise SystemExit('Refusing archive symlink: ' + relative)
                    entry = tar.gettarinfo(str(item), arcname=relative)
                    entry.uid = entry.gid = 0
                    entry.uname = entry.gname = ''
                    entry.mtime = 0
                    entry.mode = (
                        0o700 if item.is_dir() or relative in EXECUTABLES else 0o600
                    )
                    if item.is_file():
                        with item.open('rb') as file:
                            tar.addfile(entry, file)
                    elif item.is_dir():
                        tar.addfile(entry)
                    else:
                        raise SystemExit('Unsupported archive file: ' + relative)
    digest = sha256_file(runtime_archive)
    (build / 'PayloadMetadata.swift').write_text(
        'enum EmbeddedPayloadMetadata { static let sha256 = ' + json.dumps(digest) + ' }\n'
    )
    with zipfile.ZipFile(source_archive, 'w', compression=zipfile.ZIP_DEFLATED) as zipped:
        for item in sorted((payload / 'source').rglob('*')):
            if item.is_file():
                zipped.write(item, 'mac2jb/' + item.relative_to(payload / 'source').as_posix())
    print('Embedded runtime SHA-256:', digest)


def verify_runtime(root, payload):
    manifest = runtime_manifest(root)
    test_build = plistlib.loads((root / 'gui/Info.plist').read_bytes()).get('MAC2JBTestBuild') is True
    required = manifest['requiredPaths'] + (manifest['testRequiredPaths'] if test_build else [])
    for name in required:
        if not (payload / name).is_file():
            raise SystemExit('Missing GUI runtime file: ' + name)


def main(args):
    if len(args) == 2 and args[0] == 'verify-minimum':
        verify_minimum(Path(args[1]))
    elif len(args) == 4 and args[0] == 'stage':
        stage(Path(args[1]), Path(args[2]), Path(args[3]))
    elif len(args) == 4 and args[0] == 'archive':
        archive(Path(args[1]), Path(args[2]), Path(args[3]))
    elif len(args) == 3 and args[0] == 'verify-runtime':
        verify_runtime(Path(args[1]), Path(args[2]))
    else:
        raise SystemExit('usage: package-gui-payload.py verify-minimum PAYLOAD | stage ROOT PAYLOAD NODE | verify-runtime ROOT PAYLOAD | archive PAYLOAD BUILD SOURCE_ARCHIVE')


if __name__ == '__main__':
    main(sys.argv[1:])
