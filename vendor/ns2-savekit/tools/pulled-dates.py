#!/usr/bin/env python3
"""Slot dates from an already-pulled Artemis save.

  python3 tools/pulled-dates.py <archive-directory> [--pluto PATH] [--lua PATH]

Where the date actually lives: not in system.dat (that holds engine flags such as
s.savepath and s.engineversion), and not in the slot blobs or their thumbnails
(the PNGs carry no tIME chunk). It is in saveg.dat -> variable g.system, which is
a pluto-serialised Lua table containing sys.saveslot[slot] = {file, date, title}.

pluto is an external dependency; this reads it with the lua binary and the pluto
bundle, so pass their paths or put them where the defaults expect them.
"""
import argparse
import importlib.util
import os
import struct
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def load_artemis():
    spec = importlib.util.spec_from_file_location(
        'artemis_save', os.path.join(HERE, 'artemis-save.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DUMP = r'''
local lib = package.loadlib(os.getenv("PLUTO_PATH"), "luaopen_pluto")
assert(lib, "cannot load pluto from " .. tostring(os.getenv("PLUTO_PATH")))
lib()
local f = assert(io.open(os.getenv("BLOB_PATH"), "rb"))
local t = pluto.unpersist({}, f:read("*a"))
f:close()
if type(t) ~= "table" or type(t.saveslot) ~= "table" then os.exit(2) end
local function stamp(d)
  if type(d) == "number" then return d end
  if type(d) == "table" then
    -- some slots store {year, month, day, hour, min, sec}
    local y, mo, dd = d[1], d[2], d[3]
    if y and mo and dd then return os.time{year=y, month=mo, day=dd,
      hour=d[4] or 0, min=d[5] or 0, sec=d[6] or 0} end
    if d.date then return stamp(d.date) end
  end
  return nil
end
for slot, entry in pairs(t.saveslot) do
  if type(entry) == "table" then
    local when = stamp(entry.date)
    if when then
      print(string.format("%s\t%d\t%s", tostring(slot), when, tostring(entry.file or "")))
    end
  end
end
'''


def variables(data, field):
    save = load_artemis().IndexedSave(data)
    root = save.groups[0]
    if field not in root:
        return {}
    offset = root[field]
    count = struct.unpack_from('<I', save.fields, offset)[0]
    cursor = offset + 4
    out = {}
    for _ in range(count):
        size = struct.unpack_from('<I', save.fields, cursor)[0]
        key = save.fields[cursor + 4:cursor + 4 + size]
        cursor += 4 + size
        size = struct.unpack_from('<I', save.fields, cursor)[0]
        out[key.decode()] = save.fields[cursor + 4:cursor + 4 + size]
        cursor += 4 + size
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('archive')
    parser.add_argument('--pluto', default='/tmp/pluto.so')
    parser.add_argument('--lua', default='/tmp/lua-5.1.5/src/lua')
    args = parser.parse_args()

    saveg = os.path.join(args.archive, 'saveg.dat')
    if not os.path.exists(saveg):
        sys.exit('no saveg.dat in ' + args.archive)
    blob = variables(open(saveg, 'rb').read(), 2).get('g.system')
    if not blob:
        sys.exit('no g.system variable: not an Artemis save?')

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'g.system.blob')
        script = os.path.join(tmp, 'dump.lua')
        open(path, 'wb').write(blob)
        open(script, 'w').write(DUMP)
        env = dict(os.environ, BLOB_PATH=path, PLUTO_PATH=args.pluto)
        result = subprocess.run([args.lua, script], capture_output=True, text=True, env=env)
    if result.returncode != 0:
        sys.exit('could not read the slot table: ' + (result.stderr.strip().splitlines() or ['?'])[-1])

    rows = []
    for line in result.stdout.splitlines():
        slot, date, name = (line.split('\t') + ['', ''])[:3]
        try:
            stamp = int(date)
        except ValueError:
            continue
        rows.append((stamp, slot, name))
    rows.sort(reverse=True)
    print('slot  saved                file')
    for stamp, slot, name in rows:
        when = time.strftime('%Y-%m-%d %H:%M', time.localtime(stamp))
        print(f'{slot:>4}  {when:16}  {name}')


if __name__ == '__main__':
    main()
