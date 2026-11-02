#!/bin/sh
# Build the untethered launcher set for one save:
#   ns2jb.asb      stub ASB; runs the slot-4 program, else ns2jb.lua
#   sscode004.lua  the body as editor slot 4 (console-editable, Save + publish)
#   ns2jb.lua      the same body as a direct file (fallback)
#   save9999.dat   suspend launcher resuming at save:/ns2jb.asb
#   manifest.json  for tools/save-write-stage.cjs
#   ./tools/build-untethered.sh <backup-directory> <output-directory>
set -eu
base=${1:?usage: build-untethered.sh <backup-directory> <output-directory>}
out=${2:?usage: build-untethered.sh <backup-directory> <output-directory>}
here=$(dirname "$0")
# BODY picks the program the stub runs; EXTRA names one more payload file to ship
# beside it (the launcher ships its NSO verifier this way).
body="${BODY:-$here/../payloads/ns2jb.lua}"
extra="${EXTRA:-}"
stub="$here/../payloads/ns2jb-stub.lua"
mkdir -p "$out"
# The suspend launcher is a retargeted copy of a real save. Prefer the native
# autosave; fall back to the newest numbered slot for titles that never wrote
# one (Nora has only save0001.dat).
seed="$base/autosave.dat"
if [ ! -f "$seed" ]; then
  seed=$(ls -1 "$base"/save[0-9][0-9][0-9][0-9].dat 2>/dev/null | sort | tail -1)
fi
if [ -z "$seed" ] || [ ! -f "$seed" ]; then
  echo "no save blob to build from in $base (need autosave.dat or saveNNNN.dat)" >&2
  exit 1
fi
echo "launcher base: $seed"
python3 "$here/artemis-save.py" asb "$stub" ns2jb_boot "$out/ns2jb.asb"
cp "$body" "$out/ns2jb.lua"
cp "$body" "$out/sscode004.lua"
if [ -n "$extra" ]; then
  cp "$extra" "$out/$(basename "$extra")"
fi
python3 "$here/artemis-save.py" launch "$seed" ns2jb.asb "$out/save9999.dat"
python3 - "$out" "$base" <<'PY'
import json, os, sys
out, base = sys.argv[1], sys.argv[2]
present = set(os.listdir(base)) if os.path.isdir(base) else set()
files = []
names = ['ns2jb.asb', 'save9999.dat', 'ns2jb.lua', 'sscode004.lua']
names += sorted(n for n in os.listdir(out)
                if n not in names and n.endswith('.lua'))
for name in names:
    entry = {'path': '/' + name, 'local': os.path.join(out, name)}
    entry['sha256'] = __import__('hashlib').sha256(
        open(os.path.join(out, name), 'rb').read()).hexdigest()
    entry['size'] = os.path.getsize(os.path.join(out, name))
    if name in present:
        entry['replace'] = True
    files.append(entry)
json.dump({'title': 'Seedsow Lullaby demo -- untethered launcher',
           'purpose': 'boot stub + editor slot 4 body + suspend launcher',
           'files': files}, open(os.path.join(out, 'manifest.json'), 'w'), indent=2)
print('manifest files: ' + ', '.join(
    f['path'] + (' (replace)' if f.get('replace') else ' (add)') for f in files))
PY
echo "built $out/manifest.json"
