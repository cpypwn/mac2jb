#!/usr/bin/env python3
"""Build and patch Artemis-engine save data and ASB v0 script files.

Two operations are needed to make the engine run our Lua from save data alone:

  asb     encode a Lua function into an ASB v0 script record file
  launch  retarget a save slot's execution pointer at that script

The save container is BOWG/BOWS/BOWX version 1002/1003: a zlib-compressed body
followed by a two-level index (object start -> field id -> absolute offset).
The structure below follows the reference implementation in
DialingSpoon527/seedsow-lua-editor tools/{asb,indexed_save}.py, which is the
only public documentation of the layout.

  python3 artemis-save.py asb    <in.lua> <function-name> <out.asb>
  python3 artemis-save.py launch <in.dat> <script-name> <out.dat>
  python3 artemis-save.py show   <file.dat>
"""
import struct
import sys
import zlib
from dataclasses import dataclass


def u32(value):
    return struct.pack('<I', value)


def string(value):
    if isinstance(value, str):
        value = value.encode('utf-8')
    return u32(len(value)) + value


@dataclass(frozen=True)
class Edit:
    start: int
    before: bytes
    after: bytes


class IndexedSave:
    def __init__(self, data):
        self.magic, self.version, size = struct.unpack_from('<4sII', data)
        if self.magic not in (b'BOWS', b'BOWG', b'BOWX') or self.version not in (1002, 1003):
            raise ValueError('unsupported save container')
        obj = zlib.decompressobj()
        self.body = obj.decompress(data[12:]) + obj.flush()
        if not obj.eof or obj.unused_data or len(self.body) != size:
            raise ValueError('invalid compressed body')
        self.index_start = struct.unpack_from('<I', self.body, len(self.body) - 4)[0]
        if not 0 <= self.index_start < len(self.body) - 4:
            raise ValueError('index pointer outside body')
        self.fields = self.body[:self.index_start]
        cursor = self.index_start

        def read():
            nonlocal cursor
            if cursor + 4 > len(self.body) - 4:
                raise ValueError('truncated index')
            value = struct.unpack_from('<I', self.body, cursor)[0]
            cursor += 4
            return value

        self.groups = {}
        for _ in range(read()):
            base, length = read(), read()
            entries = {}
            for _ in range(length):
                key = read()
                entries[key] = read()
            self.groups[base] = entries
        if cursor != len(self.body) - 4 or 0 not in self.groups:
            raise ValueError('index does not end at trailer')
        if self.make_body(self.fields, self.groups) != self.body:
            raise ValueError('index round trip differs')

    @staticmethod
    def make_body(fields, groups):
        index = bytearray(u32(len(groups)))
        for base, entries in groups.items():
            index += u32(base) + u32(len(entries))
            for key, offset in entries.items():
                index += u32(key) + u32(offset)
        return fields + index + u32(len(fields))

    def lp(self, offset):
        size = struct.unpack_from('<I', self.fields, offset)[0]
        if offset + 4 + size > len(self.fields):
            raise ValueError('string outside fields')
        return self.fields[offset + 4:offset + 4 + size]

    def num(self, offset):
        return struct.unpack_from('<I', self.fields, offset)[0]

    def apply(self, edits):
        edits = sorted(edits, key=lambda item: item.start)
        previous_end = 0
        parts = []
        for edit in edits:
            end = edit.start + len(edit.before)
            if not edit.before or edit.start < previous_end or end > len(self.fields):
                raise ValueError('overlapping or invalid field edit')
            if self.fields[edit.start:end] != edit.before:
                raise ValueError('unexpected field bytes at %#x' % edit.start)
            parts += [self.fields[previous_end:edit.start], edit.after]
            previous_end = end
        parts.append(self.fields[previous_end:])
        fields = b''.join(parts)

        def relocate(offset):
            delta = 0
            for edit in edits:
                if offset <= edit.start:
                    break
                end = edit.start + len(edit.before)
                if offset < end:
                    raise ValueError('indexed offset %#x points into an edited field' % offset)
                delta += len(edit.after) - len(edit.before)
            return offset + delta

        groups = {relocate(base): {key: relocate(offset) for key, offset in entries.items()}
                  for base, entries in self.groups.items()}
        body = self.make_body(fields, groups)
        result = self.magic + u32(self.version) + u32(len(body)) + zlib.compress(body, 9)
        check = IndexedSave(result)
        if check.fields != fields or check.groups != groups:
            raise ValueError('edited index failed round trip')
        return result


def encode_asb(commands):
    data = bytearray(b'ASB\0\0' + u32(len(commands)))
    for line, (name, params) in enumerate(commands, 1):
        data += u32(0) + string(name) + b'\0' + u32(line) + u32(len(params))
        for key, value in params.items():
            data += string(key) + b'\0' + string(value) + b'\0'
    return bytes(data)


def decode_asb(data):
    if data[:5] != b'ASB\0\0':
        raise ValueError('unexpected ASB header')
    offset = 5

    def number():
        nonlocal offset
        value = struct.unpack_from('<I', data, offset)[0]
        offset += 4
        return value

    commands = []
    for _ in range(number()):
        kind = number()
        size = number()
        name = data[offset:offset + size].decode('utf-8')
        offset += size
        if data[offset] != 0:
            raise ValueError('missing ASB string terminator')
        offset += 1
        if kind == 1:
            continue
        if kind != 0:
            raise ValueError('unexpected ASB record kind')
        line, count = number(), number()
        params = {}
        for _ in range(count):
            size = number()
            key = data[offset:offset + size].decode('utf-8')
            offset += size + 1
            size = number()
            value = data[offset:offset + size].decode('utf-8')
            offset += size + 1
            params[key] = value
        commands.append((name, line, params))
    if offset != len(data):
        raise ValueError('unconsumed ASB bytes')
    return commands


# Root-object field ids that hold the names of event handlers the engine looks
# up in the currently loaded ASB. They are cleared when execution is retargeted
# so the engine does not call functions that the new script does not define.
HANDLER_FIELDS = ((34, 'vsync'), (38, 'keyClickStart'), (50, 'keyClickEnd'),
                  (69, 'store'), (70, 'restore'), (80, 'exskip_end'))


def launch(source, script_name):
    """Retarget a save slot so restoring it runs save:/<script_name>."""
    save = IndexedSave(source)
    root = save.groups[0]
    caret = save.groups[root[3]]
    edits = []
    for field, want in ((1, 0), (4, 1)):
        have = save.num(caret[field])
        if have != want:
            edits.append(Edit(caret[field], u32(have), u32(want)))
    target = 'save:/' + script_name
    have = save.lp(caret[3])
    if have != target.encode():
        edits.append(Edit(caret[3], string(have), string(target)))
    for field, name in HANDLER_FIELDS:
        if field not in root:
            continue
        have = save.lp(root[field])
        if have and have != name.encode():
            raise ValueError('field %d holds %r, expected %r' % (field, have, name))
        if have:
            edits.append(Edit(root[field], string(have), string('')))
    return save.apply(edits), edits


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    command = argv[1]
    if command == 'asb' and len(argv) == 5:
        source = open(argv[2], 'rb').read()
        name = argv[3]
        text = source.decode('utf-8')
        if 'function ' + name + '(' not in text:
            raise SystemExit('source does not define function %s' % name)
        data = encode_asb([('lua', {'script': text}),
                           ('calllua', {'function': name}),
                           ('wait', {'time': '0', 'input': '0'}),
                           ('stop', {})])
        open(argv[4], 'wb').write(data)
        names = [(n, p) for n, _, p in decode_asb(data)]
        print('%s: %d bytes, commands %s' % (argv[4], len(data), [n for n, _ in names]))
    elif command == 'launch' and len(argv) == 5:
        data, edits = launch(open(argv[2], 'rb').read(), argv[3])
        open(argv[4], 'wb').write(data)
        print('%s: retargeted to save:/%s with %d edit(s)' % (argv[4], argv[3], len(edits)))
        for edit in edits:
            print('  @%#06x %r -> %r' % (edit.start, edit.before[:24], edit.after[:24]))
        patched = IndexedSave(data)
        root = patched.groups[0]
        caret = patched.groups[root[3]]
        print('  verify: script=%r command=%d' % (patched.lp(caret[3]).decode(), patched.num(caret[4])))
    elif command == 'show' and len(argv) == 3:
        save = IndexedSave(open(argv[2], 'rb').read())
        root = save.groups[0]
        caret = save.groups[root[3]]
        print('%s: %s v%d body=%d objects=%d' % (argv[2], save.magic.decode(), save.version,
                                                 len(save.body), len(save.groups)))
        print('  script=%r command=%d stack=%r' % (save.lp(caret[3]).decode(), save.num(caret[4]),
                                                   save.lp(root[4])[:40]))
        for field, _ in HANDLER_FIELDS:
            if field in root:
                print('  handler[%d]=%r' % (field, save.lp(root[field]).decode()))
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv)
