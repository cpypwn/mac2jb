import argparse
import json
import tempfile
from pathlib import Path

import build


def rejects(artemis, source):
    try:
        build.patch_nora_slot(artemis, source)
    except ValueError:
        return
    raise AssertionError('An unreviewed Nora slot was accepted')


def test(backup, nested_backup=None, failed_backup=None):
    artemis = build.load_artemis()
    _, files = build.read_backup(backup)
    original = files['save0001.dat']
    save = artemis.IndexedSave(original)
    root = save.groups[0]
    outer = save.groups[root[3]]
    frames = []
    for frame in save.groups.values():
        try:
            if save.lp(frame[3]) == b'system/script.asb':
                frames.append(frame)
        except (KeyError, ValueError, IndexError):
            continue
    assert len(frames) == 1
    frame = frames[0]
    patched, edits = build.patch_nora_slot(artemis, original)
    assert len(edits) == 10
    assert patched != original
    assert files['save0001.dat'] == original
    check = artemis.IndexedSave(patched)
    patched_root = check.groups[0]
    patched_outer = check.groups[patched_root[3]]
    assert check.lp(patched_outer[3]) == ('save:/' + build.SCRIPT_NAME).encode()
    assert check.num(patched_outer[4]) == 1
    assert check.num(patched_outer[1]) == save.num(outer[1]) == 0
    assert check.num(patched_outer[2]) == 0
    assert save.num(outer[2]) == 1
    assert check.num(patched_root[4]) == 0
    assert save.num(root[4]) == 1
    assert all(check.lp(patched_root[field]) == b'' for field, _ in artemis.HANDLER_FIELDS)
    rejects(artemis, patched)
    wrong_command = save.apply([artemis.Edit(frame[4], artemis.u32(38), artemis.u32(39))])
    rejects(artemis, wrong_command)
    wrong_outer = save.apply([artemis.Edit(outer[4], artemis.u32(3), artemis.u32(4))])
    rejects(artemis, wrong_outer)
    if failed_backup is not None:
        rejects(artemis, (failed_backup / 'save0001.dat').read_bytes())
    with tempfile.TemporaryDirectory(prefix='nora-proof-test-') as temporary:
        output = Path(temporary) / 'proof'
        proof = build.build(backup, output, backup / 'save0001.png')
        commands = artemis.decode_asb((output / 'stage' / build.SCRIPT_NAME).read_bytes())
        assert [name for name, _, _ in commands] == ['lua', 'calllua', 'wait', 'stop']
        source = commands[0][2]['script']
        assert "function norahax_probe_v3(engine)" in source
        assert "title='cpypwn'" in source
        assert "Nora Lua entry reached" in source
        assert "engine:tag{'dialog'" in source
        assert proof['stageFiles']['save0001.png'] == build.digest(files['save0001.png'])
        assert (output / 'write-files/save0001.png').read_bytes() == files['save0001.png']
        manifest = json.loads((output / 'stage/save-write-manifest.json').read_text())
        assert manifest['files'][-1] == {
            'path': '/save0001.png', 'local': 'stage/save0001.png', 'replace': True}
        invalid = Path(temporary) / 'invalid.png'
        invalid.write_bytes(b'not a png')
        try:
            build.read_thumbnail(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError('Invalid thumbnail was accepted')
    if nested_backup is not None:
        _, nested_files = build.read_backup(nested_backup)
        rejects(artemis, nested_files['save0001.dat'])
    print('Nora v3 diagnostic: clean backup accepted; launch frame normalized; patched and wrong states rejected')


def main():
    parser = argparse.ArgumentParser(description='Check the guarded Nora v3 diagnostic against a private clean backup')
    parser.add_argument('--backup', type=Path, required=True)
    parser.add_argument('--nested-backup', type=Path)
    parser.add_argument('--failed-backup', type=Path)
    args = parser.parse_args()
    test(args.backup.resolve(), args.nested_backup.resolve() if args.nested_backup else None,
         args.failed_backup.resolve() if args.failed_backup else None)


if __name__ == '__main__':
    main()
