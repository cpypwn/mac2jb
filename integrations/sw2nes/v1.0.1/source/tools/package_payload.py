#!/usr/bin/env python3
"""Standalone .civapp v1 packager: copy this file into any repository.

Python 3.10+ standard library only. Build from payload.json or explicit flags;
use --non-interactive --no-save-metadata in CI and --inspect FILE to validate.
Adapted from XITRIX/CivHomebrew, revision
3acfcbbc26759f99c2b5de515fa071f88a4599d8 (packager and format validation).
"""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import struct
import sys
import tempfile

MAX_SOURCE = 32*1024*1024
MAX_FRAME = 48*1024*1024


def text_length(value):
    return len(value.encode('utf-16-le'))//2


def validate_updates(value):
    if value is None:
        return
    if not isinstance(value, dict) or type(value.get('schema')) is not int or value['schema'] != 1:
        raise ValueError('App updates require schema 1 or null to disable')
    url = value.get('releasesUrl')
    match = isinstance(url, str) and re.fullmatch(r'https://github\.com/([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9_.-]{1,100})/releases/latest/?', url)
    if not match or match[2] in ('.', '..'):
        raise ValueError('Releases URL must be https://github.com/OWNER/REPO/releases/latest')
    if 'asset' in value and (not isinstance(value['asset'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\.civapp', value['asset'])):
        raise ValueError('Update asset must be a .civapp filename, without directories')


def validate_extensions(value):
    count = 0
    def visit(v, depth):
        nonlocal count
        count += 1
        if count > 2048 or depth > 8:
            raise ValueError('Manifest extensions are too complex')
        if v is None or isinstance(v, (str, bool)):
            return
        if isinstance(v, (int, float)):
            import math
            try:
                finite = math.isfinite(v)
            except OverflowError:
                finite = False
            if not finite:
                raise ValueError('Invalid manifest extension number')
            return
        if isinstance(v, list):
            for item in v:
                visit(item, depth + 1)
            return
        if not isinstance(v, dict):
            raise ValueError('Invalid manifest extension value')
        for key, item in v.items():
            if not isinstance(key, str) or not key or text_length(key) > 80 or re.search(r'[\x00-\x1f\x7f]', key) or key in ('__proto__', 'prototype', 'constructor'):
                raise ValueError('Invalid manifest extension key')
            visit(item, depth + 1)
    if not isinstance(value, dict):
        raise ValueError('Manifest extensions must be an object')
    visit(value, 0)
    if len(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')) > 16384:
        raise ValueError('Manifest extensions exceed 16 KiB')


def validate(p):
    if not isinstance(p, dict) or p.get('format') != 'civswitch-app' or type(p.get('version')) is not int or p['version'] != 1:
        raise ValueError('Unsupported .civapp format/version')
    if not isinstance(p.get('id'), str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,47}', p['id']):
        raise ValueError('ID must use lowercase letters, digits and hyphens (1–48 characters)')
    name = p.get('name')
    if not isinstance(name, str) or not name.strip() or text_length(name) > 80 or re.search(r'[\x00-\x1f\x7f]', name):
        raise ValueError('Name must be 1–80 printable characters')
    scripts = p.get('scripts')
    if not isinstance(scripts, list) or not 1 <= len(scripts) <= 64:
        raise ValueError('Package requires 1–64 ordered JavaScript scripts')
    total, names, directories = 0, set(), set()
    for s in scripts:
        if not isinstance(s, dict) or not isinstance(s.get('name'), str):
            raise ValueError('Invalid script')
        n = s['name']
        if len(n) > 160 or not re.fullmatch(r'[A-Za-z0-9_./-]+\.js', n) or any(c in ('', '.', '..') for c in n.split('/')) or n.lower() in names or n.lower() in directories:
            raise ValueError('Invalid or duplicate script name')
        names.add(n.lower())
        parts=n.lower().split('/')[:-1]
        while parts:
            parent='/'.join(parts)
            if parent in names: raise ValueError('Script file/directory path conflict')
            directories.add(parent);parts.pop()
        if not isinstance(s.get('source'), str) or not s['source'].strip():
            raise ValueError('Empty script')
        total += len(s['source'].encode('utf-8'))
    if total > MAX_SOURCE:
        raise ValueError('Scripts exceed 32 MiB')
    m = p.get('metadata', {})
    if not isinstance(m, dict):
        raise ValueError('Invalid metadata')
    for key, limit in [('author', 80), ('release', 32), ('description', 500)]:
        v = m.get(key, '')
        if not isinstance(v, str) or text_length(v) > limit or re.search(r'[\x00-\x1f\x7f]', v):
            raise ValueError('Invalid '+key+' metadata')
    if type(m.get('api', 1)) is not int or m.get('api', 1) != 1:
        raise ValueError('Unsupported launcher API')
    if 'extensions' in m:
        validate_extensions(m['extensions'])
        if 'updates' in m['extensions']:
            validate_updates(m['extensions']['updates'])
    icon = p.get('icon', '')
    if not isinstance(icon, str):
        raise ValueError('Invalid PNG icon')
    if icon:
        if not icon.startswith('data:image/png;base64,'):
            raise ValueError('Icon must be a PNG data URL')
        raw = base64.b64decode(icon[22:], validate=True)
        if not 33 <= len(raw) <= 512*1024 or raw[:8] != b'\x89PNG\r\n\x1a\n' or raw[12:16] != b'IHDR' or struct.unpack('>II', raw[16:24]) != (256, 256):
            raise ValueError('Icon must be a 256×256 PNG, at most 512 KiB')
    if len(wire_json(p)) > MAX_FRAME:
        raise ValueError('Package exceeds 48 MiB serialized limit')
    return p


def wire_json(p):
    # Keep the transport ASCII even when metadata or a small UI script contains
    # Unicode. Gameface can then parse large embedded data without promoting the
    # entire JSON frame to a two-byte string. JSON escapes preserve source text.
    return json.dumps(p, ensure_ascii=True, separators=(',', ':')).encode('ascii')


def inside(root, relative):
    if not isinstance(relative, str) or '\\' in relative or ':' in relative or any(x in ('', '.', '..') for x in relative.split('/')):
        raise ValueError('Manifest paths must be canonical relative paths')
    path = (root/relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('Manifest path escapes the package directory')
    return path


def pack_directory(directory, manifest=None):
    if manifest is None:
        manifest = json.loads((directory/'payload.json').read_text(encoding='utf-8'))
    if not isinstance(manifest, dict):
        raise ValueError('payload.json must contain an object')
    scripts = manifest.get('scripts', ['app.js'])
    if not isinstance(scripts, list) or not scripts or len(scripts) > 64:
        raise ValueError('Manifest scripts must be an ordered list')
    icon_path = manifest.get('icon', 'icon.png')
    icon = inside(directory, icon_path) if icon_path is not None else None
    if icon is not None and 'icon' in manifest and not icon.is_file():
        raise ValueError('Manifest icon is missing')
    metadata = {k: manifest.get(k, '') for k in ('author', 'release', 'description')}
    metadata['api'] = manifest.get('api', 1)
    if 'extensions' in manifest:
        metadata['extensions'] = manifest['extensions']
    p = {'format':'civswitch-app', 'version':1, 'id':manifest['id'], 'name':manifest['name'],
         'metadata':metadata, 'scripts':[], 'icon':''}
    for name in scripts:
        path = inside(directory, name)
        if path.stat().st_size > MAX_SOURCE:
            raise ValueError('Script exceeds 32 MiB')
        p['scripts'].append({'name':name, 'source':path.read_text(encoding='utf-8')})
    if icon is not None and icon.is_file():
        if icon.stat().st_size > 512*1024:
            raise ValueError('Icon exceeds 512 KiB')
        p['icon'] = 'data:image/png;base64,'+base64.b64encode(icon.read_bytes()).decode('ascii')
    return validate(p)


def read_package(path, app_id=None, name=None):
    if path.is_dir():
        return pack_directory(path)
    if path.stat().st_size > MAX_FRAME:
        raise ValueError('Input exceeds 48 MiB')
    if path.suffix == '.civapp':
        return validate(json.loads(path.read_text(encoding='utf-8')))
    if path.suffix != '.js':
        raise ValueError('Use a .civapp package, package directory, or .js file')
    return validate({'format':'civswitch-app','version':1,'id':app_id or path.stem.lower().replace('_','-'),
                     'name':name or path.stem,'metadata':{'api':1},'icon':'',
                     'scripts':[{'name':'app.js','source':path.read_text(encoding='utf-8')}]})


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.'+path.name+'.', delete=False) as f:
            temporary = Path(f.name)
            f.write(data)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def build(args):
    interactive = not args.non_interactive and sys.stdin.isatty()

    def ask(label, flag, default=None, optional=False):
        if not interactive:
            raise ValueError(f'Missing {label}; supply {flag} (non-interactive input)')
        while True:
            value = input(label+(f' [{default}]' if default is not None else '')+': ').strip()
            if value:
                return value
            if default is not None:
                return default
            if optional:
                return ''
            print(label+' is required.')

    if args.directory is not None and args.directory_option is not None:
        raise ValueError('Use either the directory argument or --directory, not both')
    directory = args.directory_option or args.directory
    root = Path(directory or ask('Payload directory', '--directory')).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f'Payload directory does not exist: {root}')
    manifest_path = root/'payload.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else {}
    if not isinstance(manifest, dict):
        raise ValueError('payload.json must contain an object')
    manifest = dict(manifest)
    for key, option, label, flag in (
        ('name', args.name, 'App name', '--name'),
        ('id', args.id, 'Stable app ID', '--id'),
        ('author', args.creator, 'Creator', '--creator'),
        ('release', args.version, 'Version', '--version'),
    ):
        if option is not None:
            manifest[key] = option
        elif not isinstance(manifest.get(key), str) or not manifest[key].strip():
            default = None
            if key == 'id':
                default = re.sub(r'[^a-z0-9]+', '-', manifest['name'].lower()).strip('-')[:48] or 'my-app'
            manifest[key] = ask(label, flag, default=default)
        if not manifest[key].strip():
            raise ValueError(label+' must not be empty')
    if args.description is not None:
        manifest['description'] = args.description
    elif 'description' not in manifest:
        manifest['description'] = ask('Description (optional)', '--description', optional=True) if interactive else ''
    manifest['api'] = args.api if args.api is not None else manifest.get('api', 1)
    extensions = dict(manifest.get('extensions', {}))
    update_configured = 'updates' in extensions
    updates = extensions.get('updates')
    if args.no_updates:
        if args.update_asset is not None:
            raise ValueError('--no-updates cannot be combined with --update-asset')
        extensions['updates'] = None
    else:
        url = args.releases_url
        if url is None and not update_configured and interactive:
            url = ask('GitHub releases URL for app updates (optional)', '--releases-url', optional=True)
        if url is not None:
            if url:
                updates = dict(updates) if isinstance(updates, dict) else {}
                updates.update(schema=1, releasesUrl=url.rstrip('/'))
                validate_updates({'schema': 1, 'releasesUrl': updates['releasesUrl']})
                if args.update_asset is None and interactive:
                    asset = ask('Update asset filename (blank: discover one .civapp)', '--update-asset', default=updates.get('asset', ''))
                    if asset:
                        updates['asset'] = asset
                    else:
                        updates.pop('asset', None)
                extensions['updates'] = updates
            else:
                extensions['updates'] = None
        if args.update_asset is not None:
            updates = extensions.get('updates')
            if not isinstance(updates, dict):
                raise ValueError('--update-asset requires --releases-url or saved update settings')
            updates = dict(updates)
            if args.update_asset:
                updates['asset'] = args.update_asset
            else:
                updates.pop('asset', None)
            extensions['updates'] = updates
    if extensions:
        manifest['extensions'] = extensions
    if args.script is not None:
        manifest['scripts'] = args.script
    elif 'scripts' not in manifest:
        candidates = sorted(p.name for p in root.glob('*.js') if p.is_file())
        if (root/'app.js').is_file():
            default = 'app.js'
        else:
            default = candidates[0] if len(candidates) == 1 else None
        # Even a plausible app.js can depend on other scripts: confirm launch order.
        print('List dependencies first and the app entry script last.')
        manifest['scripts'] = [s.strip() for s in ask('Ordered scripts (comma separated)', '--script (repeat in launch order)', default=default).split(',')]
    if args.no_icon:
        manifest['icon'] = None
    elif args.icon is not None:
        # A typo in an explicit CI input must fail, rather than silently dropping artwork.
        if not inside(root, args.icon).is_file():
            raise ValueError(f'Icon does not exist: {args.icon}')
        manifest['icon'] = args.icon
    elif manifest.get('icon', 'icon.png') is not None:
        candidate = manifest.get('icon', 'icon.png')
        if inside(root, candidate).is_file():
            manifest['icon'] = candidate
        else:
            print(f'No icon found at {candidate}. Expected a 256×256 PNG.')
            if not interactive:
                raise ValueError('Missing icon; supply --icon PATH or explicitly allow no icon with --no-icon')
            answer = ask('Continue without an icon? (y/N)', '--no-icon', default='n')
            if answer.lower() not in ('y', 'yes'):
                raise ValueError('Packaging cancelled; add an icon and run again')
            manifest['icon'] = None
    package = pack_directory(root, manifest=manifest)
    output = (args.output.expanduser().resolve() if args.output else root/'dist'/(manifest['id']+'.civapp'))
    if output.suffix != '.civapp':
        raise ValueError('Output filename must end in .civapp')
    inputs = [manifest_path.resolve()]+[inside(root, s) for s in manifest['scripts']]
    if manifest.get('icon') is not None:
        inputs.append(inside(root, manifest['icon']))
    if output in inputs:
        raise ValueError('Output would overwrite a package input')
    # Validate everything before publishing output or updating reusable metadata.
    atomic_write(output, wire_json(package)+b'\n')
    if not args.no_save_metadata:
        atomic_write(manifest_path, (json.dumps(manifest, ensure_ascii=False, indent=2)+'\n').encode('utf-8'))
        print(f'Metadata saved: {manifest_path}')
    print(f"Packed {package['name']}: {output} ({output.stat().st_size:,} bytes, {len(package['scripts'])} scripts)")
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inspect', type=Path, metavar='FILE', help='Validate and summarize a .civapp file instead of packaging')
    parser.add_argument('directory', nargs='?', help='Existing payload directory (prompted when omitted)')
    parser.add_argument('--directory', dest='directory_option', help='CI alternative to the directory argument')
    parser.add_argument('-o', '--output', type=Path, help='Output .civapp; default: PAYLOAD/dist/ID.civapp')
    parser.add_argument('--id', help='Stable installation ID, reused for updates')
    parser.add_argument('--name', help='App display name')
    parser.add_argument('--creator', '--author', dest='creator', help='App creator')
    parser.add_argument('--version', '--release', dest='version', help='App release version, not the package format version')
    parser.add_argument('--description', help='Optional short description')
    parser.add_argument('--api', type=int, choices=[1], help='Launcher API version (default: 1)')
    updates = parser.add_mutually_exclusive_group()
    updates.add_argument('--releases-url', help='GitHub https://github.com/OWNER/REPO/releases/latest URL for app updates')
    updates.add_argument('--no-updates', action='store_true', help='Disable app updates and remember this choice')
    parser.add_argument('--update-asset', help='Exact .civapp release asset name; empty string enables automatic discovery')
    parser.add_argument('--script', action='append', help='Relative JS path; repeat in launch order, entry script last')
    icons = parser.add_mutually_exclusive_group()
    icons.add_argument('--icon', help='Relative path to a 256×256 PNG inside the payload directory')
    icons.add_argument('--no-icon', action='store_true', help='Explicitly package without artwork; remember this choice')
    parser.add_argument('--non-interactive', action='store_true', help='Never prompt; missing required settings are errors')
    parser.add_argument('--no-save-metadata', action='store_true', help='Do not create/update payload.json (read-only CI sources)')
    args = parser.parse_args(argv)
    try:
        if args.inspect is not None:
            if any(value is not None and value is not False for key, value in vars(args).items() if key != 'inspect'):
                raise ValueError('--inspect cannot be combined with packaging arguments')
            if args.inspect.suffix != '.civapp' or not args.inspect.is_file():
                raise ValueError('Use a .civapp package file')
            package = read_package(args.inspect)
            print(json.dumps({k:v for k,v in package.items() if k not in ('scripts','icon')}, indent=2, ensure_ascii=False))
            print('Scripts: '+', '.join(s['name'] for s in package['scripts']))
            print('Icon: '+('256×256 PNG' if package.get('icon') else 'letter fallback'))
            return 0
        build(args)
    except (OSError, ValueError, KeyError, TypeError, EOFError) as error:
        parser.exit(1, f'Stopped: {error}\n')
    except KeyboardInterrupt:
        print('\nPackaging cancelled.', file=sys.stderr)
        return 130
    return 0


if __name__ == '__main__':
    sys.exit(main())
