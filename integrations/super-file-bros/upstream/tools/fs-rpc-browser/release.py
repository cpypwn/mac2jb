#!/usr/bin/python3
"""Whitelist-only portable release. Never package data, sessions or credentials."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile
import tarfile
import gzip
import re
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
VERSION = '0.1.0'


def build():
    base = ROOT / 'dist/super-file-bros'
    stage = base / 'super-file-bros'
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    files = [
        'tools/fs-rpc-browser/start.cjs', 'tools/fs-rpc-browser/server.cjs',
        'tools/fs-rpc-browser/brand.cjs', 'tools/fs-rpc-browser/requirements.cjs',
        'tools/fs-rpc-browser/install.cjs', 'tools/fs-rpc-browser/test.cjs', 'tools/fs-rpc-browser/release.py',
        *['tests/' + name + '.test.cjs' for name in ['fs-rpc-browser', 'fs-rpc-downloads', 'fs-rpc-discovery', 'fs-rpc-writes', 'dolphin-fs-rpc', 'super-file-bros-release']],
        'tools/fs-rpc-browser/file-managers.cjs', 'tools/fs-rpc-browser/discovery.cjs', 'tools/fs-rpc-browser/downloads.cjs', 'tools/fs-rpc-browser/zip.cjs',
        'tools/fs-rpc-browser/ui/index.html', 'tools/fs-rpc-browser/ui/app.js', 'tools/fs-rpc-browser/ui/style.css',
        'tools/dolphin-fs-rpc/library.cjs', 'tools/dolphin-fs-rpc/control.cjs',
        'tools/dolphin-fs-rpc/service.cjs', 'tools/dolphin-fs-rpc/writes.cjs', 'tools/dolphin-fs-rpc/storage.cjs', 'tools/dolphin-fs-rpc/ftp-client.cjs',
        'modules/iz-exchange/server/games.cjs', 'core/session/ledger.cjs',
        'core/console/host/ftp-native.cjs', 'core/console/host/ftp-server.cjs',
        'core/console/native/client.cjs', 'core/console/native/six.cjs',
        'core/console/abi/ftp-functions.json', 'core/console/abi/thread-code.json',
        'core/console/abi/sdk-checks.cjs', 'core/console/abi/sdk-checks.json', 'LICENSE',
    ]
    assets = ROOT / 'tools/fs-rpc-browser'
    for folder in ['launchers', 'release-assets']:
        files.extend(str(file.relative_to(ROOT)) for file in sorted((assets / folder).rglob('*')) if file.is_file())
    documents = ['README.md', 'DISCLAIMER.md', 'THIRD_PARTY_NOTICES.md', 'RELEASE_NOTES.md']
    files.extend('tools/fs-rpc-browser/' + name for name in documents)
    vendor = ROOT / 'modules/iz-exchange/server/ouncecake'
    for file in vendor.rglob('*'):
        if any(part in ('.git', 'node_modules', '__pycache__') for part in file.relative_to(vendor).parts):
            continue
        if file.is_symlink():
            raise RuntimeError('Unexpected vendor symlink: ' + str(file))
        if file.is_file() and file.name != 'README.md':
            files.append(str(file.relative_to(ROOT)))
    for relative in files:
        source, target = ROOT / relative, stage / relative
        if not source.is_file() or source.is_symlink():
            raise RuntimeError('Invalid release source: ' + relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    for name in documents:
        shutil.copyfile(assets / name, stage / name)
    for file in sorted((assets / 'launchers').iterdir()):
        target = stage / file.name
        data = file.read_bytes()
        if file.suffix == '.cmd':
            data = data.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
        target.write_bytes(data)
        target.chmod(0o755 if file.suffix in ('.sh', '.command') else 0o644)
    for file in sorted((assets / 'release-assets').rglob('*')):
        if file.is_file():
            target = stage / file.relative_to(assets / 'release-assets')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, target)
    (stage / 'start.cjs').write_text("require('./tools/fs-rpc-browser/start.cjs').main().catch(e=>{console.error(e.message);process.exitCode=1;});\n")
    (stage / 'package.json').write_text(json.dumps({'name': 'super-file-bros', 'version': VERSION,
        'private': True, 'description': 'Nintendo Switch 2 file manager for held FS RPC sessions',
        'license': 'GPL-2.0-only', 'engines': {'node': '>=20.20'},
        'scripts': {'start': 'node start.cjs', 'test': 'node tools/fs-rpc-browser/test.cjs',
                    'build': 'python3 tools/fs-rpc-browser/release.py'}}, indent=2) + '\n')
    (stage / '.gitignore').write_text('/data/\n/dist/\nnode_modules/\n*.log\n.DS_Store\n')
    targets = {
        'windows': {'runtime': 'win32', 'launchers': ['Start Windows.cmd', 'Install Windows.cmd'],
                    'start': 'Double-click **Start Windows.cmd**.', 'install': 'Run **Install Windows.cmd** to add a Start menu shortcut.'},
        'macos': {'runtime': 'darwin', 'launchers': ['Start macOS.command', 'Install macOS.command', 'start.sh', 'Install shortcut.sh'],
                  'start': 'Double-click **Start macOS.command**, or run `sh "Start macOS.command"` in Terminal.', 'install': 'Run **Install macOS.command** to add a shortcut to your user Applications folder.'},
        'linux': {'runtime': 'linux', 'launchers': ['start.sh', 'Install shortcut.sh'],
                  'start': 'Run `sh start.sh` in a terminal inside this folder.', 'install': 'Run `sh "Install shortcut.sh"` to add a user application-menu shortcut.'},
    }
    write_manifest(stage, 'source')
    products = []
    for platform, options in targets.items():
        destination = base / 'platforms' / platform / 'super-file-bros'
        if destination.exists():
            shutil.rmtree(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(stage, destination)
        for launcher in (assets / 'launchers').iterdir():
            if launcher.name not in options['launchers']:
                (destination / launcher.name).unlink(missing_ok=True)
        (destination / 'PACKAGE.json').write_text(json.dumps({'name': 'Super File Bros.', 'version': VERSION,
            'platform': platform, 'nodePlatform': options['runtime'], 'nodeRequired': True,
            'architecture': 'Uses the architecture of the installed Node.js runtime'}, indent=2) + '\n')
        (destination / 'START_HERE.md').write_text(
            '# Super File Bros. for ' + {'windows': 'Windows', 'macos': 'macOS', 'linux': 'Linux'}[platform] + '\n\n'
            '1. Install Node.js 20.20 or newer (22+ recommended) from https://nodejs.org/ if needed.\n'
            '2. Extract the entire package to a writable folder and keep its files together.\n'
            '3. ' + options['start'] + '\n'
            '4. Keep your existing ns2jb2 or ns2jb FS RPC connection running. The active run folder is detected from saved settings or nearby sessions; enter the console IPv4 if needed.\n'
            '5. Read **README.md** for the full connection, transfer and file-management instructions.\n\n'
            + options['install'] + ' Shortcuts reference this folder; keep it in place. No administrator privileges are required.\n\n'
            '**Use caution:** modifying, corrupting or deleting files can have unexpected consequences. Back up important data first. Folder deletion is permanent and recursive. Read **DISCLAIMER.md** before making changes.\n\n'
            'This is a portable source package. Node.js is required separately; it is not a standalone native executable. All project instructions and interface text are in English.\n')
        manifest = write_manifest(destination, platform)
        reject_cyrillic(destination)
        suffix = '.tar.gz' if platform == 'linux' else '.zip'
        archive = base / ('super-file-bros-' + VERSION + '-' + platform + suffix)
        if platform == 'linux':
            write_tar(destination, archive)
        else:
            write_zip(destination, archive)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        shutil.copyfile(destination / 'SOURCE-MANIFEST.json', base / ('SOURCE-MANIFEST-' + platform + '.json'))
        products.append({'platform': platform, 'archive': str(archive), 'bytes': archive.stat().st_size,
                         'sha256': digest, 'files': len(manifest) + 1})
    expected = {Path(product['archive']).name for product in products}
    for pattern in ['super-file-bros-*.zip', 'super-file-bros-*.tar.gz']:
        for previous in base.glob(pattern):
            if previous.name not in expected:
                previous.unlink()
    (base / 'SOURCE-MANIFEST.json').unlink(missing_ok=True)
    shutil.copyfile(stage / 'RELEASE_NOTES.md', base / 'RELEASE_NOTES.md')
    (base / 'SHA256SUMS').write_text(''.join(product['sha256'] + '  ' + Path(product['archive']).name + '\n' for product in products))
    print(json.dumps({'version': VERSION, 'packages': products}))
    return stage


def write_manifest(stage, platform):
    manifest = {}
    for file in sorted(stage.rglob('*')):
        if file.is_file() and file.relative_to(stage).as_posix() != 'SOURCE-MANIFEST.json':
            manifest[file.relative_to(stage).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
    (stage / 'SOURCE-MANIFEST.json').write_text(json.dumps({'version': VERSION, 'platform': platform, 'files': manifest}, indent=2) + '\n')
    return manifest


def reject_cyrillic(stage):
    for file in sorted(stage.rglob('*')):
        if not file.is_file():
            continue
        if re.search(r'[\u0400-\u04ff]', file.relative_to(stage).as_posix()):
            raise RuntimeError('Cyrillic filename in release: ' + file.name)
        try:
            text = file.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            continue
        if re.search(r'[\u0400-\u04ff]', text):
            raise RuntimeError('Cyrillic text in release: ' + str(file.relative_to(stage)))


def executable(file):
    return file.suffix in ('.sh', '.command')


def write_zip(stage, archive):
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as out:
        for file in sorted(stage.rglob('*')):
            if not file.is_file():
                continue
            info = zipfile.ZipInfo('super-file-bros/' + file.relative_to(stage).as_posix(), (2026, 10, 30, 0, 0, 0))
            info.external_attr = (0o100755 if executable(file) else 0o100644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            out.writestr(info, file.read_bytes())


def write_tar(stage, archive):
    epoch = int(datetime(2026, 10, 30, tzinfo=timezone.utc).timestamp())
    with archive.open('wb') as raw:
        with gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0, compresslevel=9) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as out:
                for file in sorted(stage.rglob('*')):
                    if not file.is_file():
                        continue
                    info = out.gettarinfo(str(file), arcname='super-file-bros/' + file.relative_to(stage).as_posix())
                    info.uid = info.gid = 0
                    info.uname = info.gname = ''
                    info.mtime = epoch
                    info.mode = 0o755 if executable(file) else 0o644
                    info.pax_headers = {}
                    with file.open('rb') as data:
                        out.addfile(info, data)


if __name__ == '__main__':
    build()
