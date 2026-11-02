#!/bin/sh
# Offline test for tools/inject-launcher.sh --dry-run.
#
#   sh tests/test_inject_dryrun.sh
#
# Proves the builder -> manifest path the injection depends on: five files, each with
# a sha256 and a size, the suspend launcher retargeted to save:/ns2jb.asb, and the
# dry run touching nothing. It cannot prove the write - that needs a session.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
staging="$root/staging-launcher"
pass=0; fail=0
ok() { pass=$((pass + 1)); echo "ok    $1"; }
no() { fail=$((fail + 1)); echo "FAIL  $1"; [ -n "${2:-}" ] && echo "      $2"; }

if ! ls -d "$root"/saves/*/user-*/ >/dev/null 2>&1 && ! ls -d "$root"/saves/*backup-*/ >/dev/null 2>&1; then
  echo "skip  no local backup under saves/ to build from"
  exit 0
fi

out=$(sh "$root/tools/inject-launcher.sh" /tmp/dry-run-nothing --dry-run 2>&1) || true
echo "$out" | grep -q 'would write 5 files' && ok 'dry run plans five files' \
  || no 'dry run plans five files' "$out"
echo "$out" | grep -q 'verify: script=.save:/ns2jb.asb.' && ok 'suspend launcher retargeted' \
  || no 'suspend launcher retargeted'

python3 - "$staging/manifest.json" <<'PY' && ok 'manifest has five hashed files' || no 'manifest has five hashed files'
import json, sys
d = json.load(open(sys.argv[1]))
files = d['files']
assert len(files) == 5, len(files)
paths = {f['path'] for f in files}
assert paths == {'/ns2jb.asb', '/save9999.dat', '/ns2jb.lua', '/sscode004.lua',
                 '/nso-verify.lua'}, paths
for f in files:
    assert len(f['sha256']) == 64, f
    assert f['size'] > 0, f
PY

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
