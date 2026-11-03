import argparse
import hashlib
import importlib.util
import json
import shutil
import sys
from pathlib import Path


TITLE_ID = '010012900d38a000'
SCRIPT_NAME = 'norahax-entry-v3.asb'
MODULE_PATH = Path(__file__).resolve().parents[2] / 'vendor/ns2-savekit/research/tools/artemis-save.py'


def load_artemis():
    spec = importlib.util.spec_from_file_location('artemis_save', MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_thumbnail(path):
    data = path.read_bytes()
    if (len(data) > 1024 * 1024 or data[:8] != b'\x89PNG\r\n\x1a\n' or
            data[8:12] != (13).to_bytes(4, 'big') or data[12:16] != b'IHDR' or
            data[16:24] != (256).to_bytes(4, 'big') + (144).to_bytes(4, 'big') or
            data[24:29] != bytes([8, 2, 0, 0, 0])):
        raise ValueError('The Nora thumbnail must be a 256 x 144 RGB PNG')
    return data


def read_backup(source):
    manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('titleId', '').lower() != TITLE_ID:
        raise ValueError('Expected the Nora to Oujo to Noraneko Heart 2 trial save')
    entries = manifest.get('entries')
    if not isinstance(entries, list) or not entries:
        raise ValueError('The backup manifest has no entries')
    files = {}
    for entry in entries:
        name = entry['path'].removeprefix('/')
        if '/' in name or name in files or name in ('', '.', '..'):
            raise ValueError('The backup has an unsupported file path')
        data = (source / name).read_bytes()
        if len(data) != entry['size'] or digest(data) != entry['sha256']:
            raise ValueError('Backup verification failed: ' + name)
        files[name] = data
    if not {'save0001.dat', 'save0001.png', 'saveg.dat', 'system.dat'} <= files.keys():
        raise ValueError('The provided Luna slot and global save files are required')
    if SCRIPT_NAME in files:
        raise ValueError('The proof script name already exists in the backup')
    return manifest, files


def patch_nora_slot(artemis, data):
    save = artemis.IndexedSave(data)
    if save.magic != b'BOWS' or save.version != 1002:
        raise ValueError('The slot has an unreviewed save format')
    root = save.groups[0]
    outer = save.groups[root[3]]
    if (save.num(outer[1]), save.num(outer[2]), save.lp(outer[3]), save.num(outer[4])) != (
            0, 1, b'system/save.asb', 3):
        raise ValueError('The outer Nora save frame is not in the reviewed state')
    expected = artemis.u32(1) + artemis.string('function') + artemis.string('clickEnd')
    if save.num(root[4]) != 1:
        raise ValueError('The Nora save stack is not in the reviewed state')
    frame = save.groups.get(root[4] + 4)
    expected_frame = (1, 0, b'system/script.asb', 38)
    if frame is None or (save.num(frame[1]), save.num(frame[2]),
                         save.lp(frame[3]), save.num(frame[4])) != expected_frame:
        raise ValueError('The nested Nora script frame is not in the reviewed state')
    command = save.groups[frame[8]]
    if (save.num(command[2]) != 66 or save.lp(command[3]) != b'calllua'
            or save.fields[command[4]:command[4] + len(expected)] != expected):
        raise ValueError('The Nora clickEnd command is not in the reviewed state')
    outer_command = save.groups[outer[8]]
    if (save.num(outer_command[2]), save.lp(outer_command[3]),
            save.num(outer_command[4])) != (0, b'', 0):
        raise ValueError('The outer Nora command is not in the reviewed state')
    edits = [
        artemis.Edit(root[4], artemis.u32(1), artemis.u32(0)),
        artemis.Edit(outer[2], artemis.u32(1), artemis.u32(0)),
        artemis.Edit(outer[3], artemis.string('system/save.asb'), artemis.string('save:/' + SCRIPT_NAME)),
        artemis.Edit(outer[4], artemis.u32(3), artemis.u32(1)),
    ]
    for field, name in artemis.HANDLER_FIELDS:
        current = save.lp(root[field])
        if current != name.encode():
            raise ValueError('Unexpected Nora event handler at field ' + str(field))
        edits.append(artemis.Edit(root[field], artemis.string(name), artemis.string('')))
    patched_data = save.apply(edits)
    patched = artemis.IndexedSave(patched_data)
    patched_root = patched.groups[0]
    patched_outer = patched.groups[patched_root[3]]
    patched_command = patched.groups[patched_outer[8]]
    if (patched.num(patched_root[4]), patched.num(patched_outer[1]),
            patched.num(patched_outer[2]), patched.lp(patched_outer[3]),
            patched.num(patched_outer[4]), patched.num(patched_command[2]),
            patched.lp(patched_command[3]), patched.num(patched_command[4])) != (
            0, 0, 0, ('save:/' + SCRIPT_NAME).encode(), 1, 0, b'', 0):
        raise ValueError('The patched Nora launcher did not validate')
    return patched_data, edits


def build(source, destination, thumbnail=None):
    source = source.resolve()
    destination = destination.resolve()
    if destination.exists() or source == destination or source in destination.parents:
        raise ValueError('Choose a new output directory outside the original backup')
    artemis = load_artemis()
    manifest, files = read_backup(source)
    replacement_thumbnail = read_thumbnail(thumbnail) if thumbnail else None
    source_text = (Path(__file__).with_name('probe.lua')).read_text(encoding='utf-8')
    if 'function norahax_probe_v3(' not in source_text:
        raise ValueError('The probe function is missing')
    script = artemis.encode_asb([
        ('lua', {'script': source_text}),
        ('calllua', {'function': 'norahax_probe_v3'}),
        ('wait', {'time': '0', 'input': '0'}),
        ('stop', {}),
    ])
    if [name for name, _, _ in artemis.decode_asb(script)] != ['lua', 'calllua', 'wait', 'stop']:
        raise ValueError('ASB round-trip validation failed')
    source_save = artemis.IndexedSave(files['save0001.dat'])
    source_root = source_save.groups[0]
    source_outer = source_save.groups[source_root[3]]
    source_inner = source_save.groups[source_root[4] + 4]
    patched, edits = patch_nora_slot(artemis, files['save0001.dat'])
    original = destination / 'original'
    stage = destination / 'stage'
    write_files = destination / 'write-files'
    original.mkdir(parents=True)
    stage.mkdir()
    write_files.mkdir()
    for name, data in files.items():
        (original / name).write_bytes(data)
    shutil.copyfile(source / 'manifest.json', original / 'manifest.json')
    (stage / 'save0001.dat').write_bytes(patched)
    (stage / SCRIPT_NAME).write_bytes(script)
    (write_files / 'save0001.dat').write_bytes(patched)
    (write_files / SCRIPT_NAME).write_bytes(script)
    if replacement_thumbnail is not None:
        (stage / 'save0001.png').write_bytes(replacement_thumbnail)
        (write_files / 'save0001.png').write_bytes(replacement_thumbnail)
    write_manifest = {
        'files': [
            {'path': '/save0001.dat', 'local': 'stage/save0001.dat', 'replace': True},
            {'path': '/' + SCRIPT_NAME, 'local': 'stage/' + SCRIPT_NAME},
            *([{'path': '/save0001.png', 'local': 'stage/save0001.png', 'replace': True}]
              if replacement_thumbnail is not None else []),
        ],
    }
    (stage / 'save-write-manifest.json').write_text(json.dumps(write_manifest, indent=2) + '\n', encoding='utf-8')
    verification = {
        'titleId': TITLE_ID,
        'status': 'experimental v3 diagnostic; validated offline, not tested on the console',
        'sourceArchive': manifest['archive'],
        'sourceFiles': {name: digest(data) for name, data in files.items()},
        'stageFiles': {'save0001.dat': digest(patched), SCRIPT_NAME: digest(script),
                       **({'save0001.png': digest(replacement_thumbnail)}
                          if replacement_thumbnail is not None else {})},
        'editedFields': len(edits),
        'sourceResume': {'outer': source_save.lp(source_outer[3]).decode(),
                         'outerState': source_save.num(source_outer[2]),
                         'outerCommand': source_save.num(source_outer[4]),
                         'inner': source_save.lp(source_inner[3]).decode(),
                         'innerCommand': source_save.num(source_inner[4])},
        'stageResume': {'outer': 'save:/' + SCRIPT_NAME, 'outerState': 0, 'outerCommand': 1,
                        'stackDepth': 0},
    }
    (destination / 'verification.json').write_text(json.dumps(verification, indent=2) + '\n', encoding='utf-8')
    shutil.copyfile(Path(__file__).with_name('write-proof.cjs'), destination / 'write-proof.cjs')
    return verification


def main():
    parser = argparse.ArgumentParser(description='Build an offline Nora Lua entry diagnostic from a clean trial save')
    parser.add_argument('--backup', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--thumbnail', type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(build(args.backup, args.output, args.thumbnail), indent=2))
    except (OSError, KeyError, ValueError, IndexError) as error:
        parser.exit(1, 'Build failed: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
