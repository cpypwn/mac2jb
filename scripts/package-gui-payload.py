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


SOURCE_FILES = (
    'README.md', 'LICENSE', '.gitignore', 'Makefile', 'sender.c', 'commands.c',
    'keyboard.c', 'indent-test.bas', 'upstream.lock', 'mac2jb.command',
    'setup.sh', 'fetch-bootstrap.sh', 'make-release-zip.command',
)
SOURCE_FOLDERS = (
    'gui', 'scripts', 'packaging', 'drivers', 'assets', 'vendor', 'stremio',
    'integrations', '.github',
)
RUNTIME_FOLDERS = (
    'vendor/ns2jb', 'vendor/ns2jb-hosts', 'vendor/HBLauncher',
    'vendor/GPUBrewLauncher', 'vendor/MintBrew', 'vendor/IZ2S-Platform', 'vendor/IZDOOM',
    'vendor/OunceCake', 'assets', 'drivers', 'stremio',
    'integrations',
)
OMITTED_RUNTIME_FOLDERS = (
    'vendor/MintBrew/apps/mintnes',
    'vendor/MintBrew/apps/mintftp',
    'integrations/mintnes',
    'integrations/mintbrew-file-explorer',
    'integrations/izlauncher-shell',
    'integrations/blitbun',
    'integrations/vacootube',
    'homebrew/IZ2S-Platform',
)
RUNTIME_FILES = (
    'scripts/gui-host.cjs', 'scripts/gui-session.cjs', 'scripts/gui-dump.cjs',
    'scripts/gui-attach.cjs', 'scripts/rpc-attachment.cjs',
    'scripts/host-profiles.cjs', 'scripts/prepare-host-profiles.cjs',
    'packaging/host-profiles.json', 'scripts/gui-homebrew.cjs',
    'scripts/gui-stremio.cjs', 'scripts/check-homebrew-runtime.cjs',
    'scripts/gui-hblauncher.cjs', 'scripts/gui-mintbrew.cjs', 'scripts/prepare-mintbrew.cjs',
    'packaging/HBLauncher-v0.2.0-SHA256SUMS',
    'scripts/gui-gpubrewlauncher.cjs', 'packaging/GPUBrewLauncher-provenance.json',
    'packaging/GPUBrewLauncher-SHA256SUMS',
    'packaging/IZ2S-Platform-provenance.json',
    'packaging/IZ2S-Platform-SHA256SUMS', 'scripts/gui-keyboard.cjs',
    'scripts/prepare-homebrew-apps.cjs', 'scripts/check-stremio-runtime.cjs',
    'packaging/ftpd-sb-v0.1.0-SHA256SUMS',
    'packaging/ftpd-sb-v0.1.0-release-SHA256SUMS',
    'packaging/ftpd-sb-v0.1.0-provenance.json',
    'scripts/gui-ouncecake.cjs', 'packaging/OunceCake-provenance.json',
    'packaging/OunceCake-SHA256SUMS', 'packaging/OunceCake-upstream-SHA256SUMS',
    'packaging/stremio-display-SHA256SUMS',
    'packaging/stremio-sample-provenance.json', 'scripts/install-driver.sh',
)
BLOCKED_PARTS = {
    '.git', 'runs', 'dumps', '__pycache__', 'xcuserdata',
    'project.xcworkspace', 'usb_device', '.DS_Store',
}
BLOCKED_SUFFIXES = {
    '.o', '.dylib', '.log', '.pyc', '.bak', '.xcuserstate', '.kate-swp',
}
EXECUTABLES = {
    'node', 'mac2jb-send', 'mac2jb-commands', 'mac2jb-keyboard',
    'homebrew/bin/spirv-val', 'homebrew/bin/glslangValidator',
    'homebrew/python/bin/python3', 'homebrew/python/bin/python3.13',
}


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def verify_minimum(payload):
    targets = (
        'node', 'mac2jb-send', 'mac2jb-commands', 'mac2jb-keyboard',
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


def safe(relative, source):
    parts = relative.parts
    if parts[-2:] == ('packaging', 'test-build.json'):
        return False
    if parts[:4] == ('integrations', 'vacootube', 'upstream', 'runtime'):
        return False
    if parts == ('integrations', 'vacootube', 'overlay', 'server', 'local-package', 'vacootube-audio'):
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


def copy_file(root, source, destination):
    relative = source.relative_to(root)
    if not safe(relative, source) or not source.is_file():
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    if relative.as_posix() == 'integrations/blitbun/doom-engine/doom-headless':
        destination.chmod(0o700)
    return True


def copy_tree(root, folder, destination):
    base = root / folder
    if not base.exists():
        return
    for source in sorted(base.rglob('*')):
        copy_file(root, source, destination / source.relative_to(root))


def stage(root, payload, node):
    source = payload / 'source'
    source.mkdir()
    test_build = plistlib.loads((root / 'gui/Info.plist').read_bytes()).get('MAC2JBTestBuild') is True
    marker = json.dumps({'testBuild': test_build}, indent=2) + '\n'
    (payload / 'packaging').mkdir(parents=True, exist_ok=True)
    (source / 'packaging').mkdir(parents=True, exist_ok=True)
    (payload / 'packaging/test-build.json').write_text(marker)
    (source / 'packaging/test-build.json').write_text(marker)
    (payload / 'packaging/runtime-homebrew.json').write_text(
        json.dumps({'allowed': ['mintbrew', 'ouncecake']}, indent=2) + '\n'
    )
    for name in SOURCE_FILES:
        if (root / name).exists():
            copy_file(root, root / name, source / name)
    for folder in SOURCE_FOLDERS:
        copy_tree(root, folder, source)
    for folder in RUNTIME_FOLDERS:
        copy_tree(root, folder, payload)
    for folder in OMITTED_RUNTIME_FOLDERS:
        target = payload / folder
        if target.exists():
            shutil.rmtree(target)
    for name in RUNTIME_FILES:
        if not copy_file(root, root / name, payload / name):
            raise SystemExit('Missing GUI build input: ' + name)
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
    runtime_archive = build / 'runtime.tar.gz'
    with runtime_archive.open('wb') as stream:
        with gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode='w', format=tarfile.USTAR_FORMAT) as tar:
                for item in sorted(payload.rglob('*')):
                    relative = item.relative_to(payload).as_posix()
                    if any(relative == prefix or relative.startswith(prefix + '/')
                           for folder in OMITTED_RUNTIME_FOLDERS
                           for prefix in (folder, 'source/' + folder)):
                        continue
                    if item.is_symlink():
                        raise SystemExit('Refusing archive symlink: ' + relative)
                    entry = tar.gettarinfo(str(item), arcname=relative)
                    entry.uid = entry.gid = 0
                    entry.uname = entry.gname = ''
                    entry.mtime = 0
                    entry.mode = 0o700 if item.is_dir() or relative in EXECUTABLES else 0o600
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


def main(args):
    if len(args) == 2 and args[0] == 'verify-minimum':
        verify_minimum(Path(args[1]))
    elif len(args) == 4 and args[0] == 'stage':
        stage(Path(args[1]), Path(args[2]), Path(args[3]))
    elif len(args) == 4 and args[0] == 'archive':
        archive(Path(args[1]), Path(args[2]), Path(args[3]))
    else:
        raise SystemExit('usage: package-gui-payload.py verify-minimum PAYLOAD | stage ROOT PAYLOAD NODE | archive PAYLOAD BUILD SOURCE_ARCHIVE')


if __name__ == '__main__':
    main(sys.argv[1:])
