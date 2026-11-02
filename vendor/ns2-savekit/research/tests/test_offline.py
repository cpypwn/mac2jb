#!/usr/bin/env python3
"""Offline tests for the save/ASB tooling.

  python3 tests/test_offline.py

These prove the encoders round-trip and the manifest builder makes the decisions
it claims to. They say nothing about console behaviour; see docs/RESULTS.md for
what was actually observed on hardware.
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'tools'))

import importlib.util


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


artemis = load_module('artemis_save', os.path.join(ROOT, 'tools', 'artemis-save.py'))


def synthetic_save(magic=b'BOWG', version=1003, entries=None):
    """Build a minimal container: one object, fields, index, trailer."""
    entries = entries or {1: b'\x01\x00\x00\x00', 2: b'\x02\x00\x00\x00'}
    fields = b''
    offsets = {}
    for key in sorted(entries):
        offsets[key] = len(fields)
        fields += entries[key]
    body = artemis.IndexedSave.make_body(fields, {0: offsets})
    return magic + struct.pack('<II', version, len(body)) + zlib.compress(body, 9)


class IndexedSaveTests(unittest.TestCase):
    def test_round_trip(self):
        data = synthetic_save()
        save = artemis.IndexedSave(data)
        self.assertEqual(save.magic, b'BOWG')
        self.assertEqual(save.version, 1003)
        self.assertEqual(save.num(0), 1)
        self.assertEqual(save.num(4), 2)
        self.assertEqual(artemis.IndexedSave.make_body(save.fields, save.groups), save.body)

    def test_rejects_bad_magic_and_version(self):
        for magic, version in ((b'XXXX', 1003), (b'BOWG', 999)):
            with self.assertRaises(ValueError):
                artemis.IndexedSave(synthetic_save(magic, version))

    def test_apply_relocates_offsets(self):
        save = artemis.IndexedSave(synthetic_save(entries={1: b'\x01\x00\x00\x00', 2: b'\x02\x00\x00\x00'}))
        edited = artemis.IndexedSave(save.apply([artemis.Edit(0, artemis.u32(1), artemis.u32(9))]))
        self.assertEqual(edited.num(0), 9)
        self.assertEqual(edited.num(4), 2)

    def test_apply_refuses_mismatched_bytes(self):
        save = artemis.IndexedSave(synthetic_save())
        with self.assertRaises(ValueError):
            save.apply([artemis.Edit(0, artemis.u32(5), artemis.u32(1))])


class AsbTests(unittest.TestCase):
    def test_encode_decode_round_trip(self):
        source = 'function f(engine)\n  return 1\nend'
        data = artemis.encode_asb([('lua', {'script': source}),
                                   ('calllua', {'function': 'f'}),
                                   ('wait', {'time': '0', 'input': '0'}),
                                   ('stop', {})])
        self.assertTrue(data.startswith(b'ASB\0\0'))
        commands = artemis.decode_asb(data)
        self.assertEqual([c[0] for c in commands], ['lua', 'calllua', 'wait', 'stop'])
        self.assertEqual(commands[0][2]['script'], source)
        self.assertEqual(commands[1][2]['function'], 'f')

    def test_decode_rejects_junk(self):
        with self.assertRaises(ValueError):
            artemis.decode_asb(b'ASB\0\0' + b'\x00' * 8)


class ManifestTests(unittest.TestCase):
    def test_replace_flags_follow_the_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = os.path.join(tmp, 'source')
            backup = os.path.join(tmp, 'backup')
            os.makedirs(source)
            os.makedirs(backup)
            for name in ('a.dat', 'b.dat'):
                open(os.path.join(source, name), 'wb').write(name.encode())
            open(os.path.join(backup, 'a.dat'), 'wb').write(b'old')
            out = os.path.join(tmp, 'manifest.json')
            subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'build-editor-manifest.py'),
                            source, backup, out], check=True)
            files = {entry['path']: entry for entry in json.load(open(out))['files']}
            self.assertEqual(files['/a.dat'].get('replace'), True)
            self.assertNotIn('replace', files['/b.dat'])

    def test_hidden_files_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = os.path.join(tmp, 'source')
            os.makedirs(source)
            open(os.path.join(source, 'visible.dat'), 'wb').write(b'x')
            open(os.path.join(source, '.nx_save_meta.bin'), 'wb').write(b'x')
            out = os.path.join(tmp, 'manifest.json')
            subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'build-editor-manifest.py'),
                            source, os.path.join(tmp, 'missing-backup'), out], check=True)
            paths = [entry['path'] for entry in json.load(open(out))['files']]
            self.assertEqual(paths, ['/visible.dat'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
