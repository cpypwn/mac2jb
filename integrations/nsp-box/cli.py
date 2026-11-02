import argparse
import hashlib
import json
import signal
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / 'src'))

import dlc
import engine

CANCEL = threading.Event()


def emit(kind, **values):
    print(json.dumps({'type': kind, **values}, ensure_ascii=False), flush=True)


def verify_included():
    root = Path(__file__).resolve().parent
    manifest = json.loads((root / 'provenance.json').read_text())
    if manifest.get('revision') != 'ea25556fdf88f3368d5cadf049a0558afcfaa5a4':
        raise ValueError('The NSP-Box source pin is invalid.')
    for name, expected in manifest['files'].items():
        file = root / name
        if file.is_symlink() or not file.is_file():
            raise ValueError('An included NSP-Box file is missing or linked.')
        actual = hashlib.sha256(file.read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError('An included NSP-Box file has changed: ' + name)


def run(args):
    source = Path(args.source).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    if output.suffix.lower() != '.nsp':
        raise ValueError('Choose an .nsp output filename.')
    if output.exists():
        raise FileExistsError('The selected NSP already exists. Choose another filename.')

    def progress(stage, percent):
        emit('progress', stage=str(stage), percent=round(float(percent), 1))

    if args.dlc:
        snapshots = dlc.find_snapshots(source, args.title_id)
        if not snapshots:
            raise ValueError('No complete DLC snapshot was found.')
        report = dlc.build(snapshots[0], output, verify_output=True,
                           base_game=args.base_game or None, notify=progress,
                           cancel=CANCEL)
    else:
        snapshots, _ = engine.find_snapshots(source)
        snapshot = snapshots[0]
        report = engine.build(snapshot, output, args.title or snapshot.title,
                              args.display_version or ('dump-' + str(snapshot.version)
                                                       if snapshot.version else 'Snapshot'),
                              args.artwork or None, verify=True, notify=progress,
                              package_folder=False, cancel=CANCEL)
    emit('result', report=report)


def main():
    parser = argparse.ArgumentParser(description='NSP-Box portable Mac package adapter')
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--source', default='')
    parser.add_argument('--output', default='')
    parser.add_argument('--dlc', action='store_true')
    parser.add_argument('--title', default='')
    parser.add_argument('--display-version', default='')
    parser.add_argument('--artwork', default='')
    parser.add_argument('--title-id', default='')
    parser.add_argument('--base-game', default='')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: CANCEL.set())
    try:
        if args.self_test:
            from PIL import Image
            verify_included()
            if engine.VERSION != '3.0.0' or Image is None:
                raise ValueError('The included NSP-Box runtime is incomplete.')
            emit('self-test', message='NSP-Box portable runtime ready; no package built.')
            return 0
        if not args.source or not args.output:
            raise ValueError('Choose a source folder and NSP destination.')
        run(args)
    except InterruptedError:
        emit('cancelled', message='Package build canceled; the partial NSP was removed.')
        return 130
    except Exception as error:
        emit('error', message=str(error))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
