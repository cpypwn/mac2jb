import json
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
tool = root / 'integrations/nsp-box/cli.py'
with tempfile.TemporaryDirectory(prefix='mac2jb-nsp-box-') as scratch:
    folder = Path(scratch)
    game = folder / 'Sample'
    (game / 'exefs').mkdir(parents=True)
    (game / 'romfs').mkdir()
    npdm = bytearray(0x100)
    npdm[:4] = b'META'
    struct.pack_into('<II', npdm, 0x70, 0x80, 0x80)
    npdm[0x80:0x84] = b'ACI0'
    struct.pack_into('<Q', npdm, 0x90, 0x0400111122220000)
    (game / 'exefs/main.npdm').write_bytes(npdm)
    (game / 'exefs/main').write_bytes(b'NSO0' + bytes(512))
    (game / 'romfs/hello.txt').write_text('hello from mac2jb\n')
    output = folder / 'Sample.nsp'
    command = [sys.executable, str(tool), '--source', str(game), '--output', str(output)]
    built = subprocess.run(command, text=True, capture_output=True, check=True)
    rows = [json.loads(line) for line in built.stdout.splitlines()]
    result = next(row['report'] for row in rows if row['type'] == 'result')
    assert result['verified'] and Path(result['output']).resolve() == output.resolve()
    assert output.is_file() and output.stat().st_size > 1000
    original = output.read_bytes()
    repeat = subprocess.run(command, text=True, capture_output=True)
    assert repeat.returncode != 0
    assert 'already exists' in repeat.stdout
    assert output.read_bytes() == original
    assert not list(folder.glob('*.partial'))
    sys.path.insert(0, str(root / 'integrations/nsp-box/src'))
    import engine
    snapshot = engine.find_snapshots(game)[0][0]
    raced = folder / 'Raced.nsp'
    def competing_file(stage, percent):
        if stage == 'Verifying container integrity' and not raced.exists():
            raced.write_bytes(b'external')
    try:
        engine.build(snapshot, raced, 'Sample', '1', notify=competing_file)
        raise AssertionError('Mac commit replaced a competing output')
    except FileExistsError:
        assert raced.read_bytes() == b'external'
    assert not list(folder.glob('*.partial'))

    dlc = folder / '0400111122221001'
    (dlc / 'romfs').mkdir(parents=True)
    (dlc / 'romfs/data.bin').write_bytes(b'addon')
    dlc_output = folder / 'Addon.nsp'
    command = [sys.executable, str(tool), '--source', str(dlc), '--output', str(dlc_output), '--dlc']
    built = subprocess.run(command, text=True, capture_output=True, check=True)
    rows = [json.loads(line) for line in built.stdout.splitlines()]
    assert next(row['report'] for row in rows if row['type'] == 'result')['verified']
    assert dlc_output.is_file()
    print('NSP-Box Mac game/DLC packaging, readback and no-overwrite checks passed')
