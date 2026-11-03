#!/bin/sh
# Back up a title's save, inject the launcher set, then verify every file by hash.
#
#   tools/inject-launcher.sh <run-directory> [program-id] [uid-hex]
#
# Defaults are the Seedsow Lullaby demo and the account uid this console uses; both
# live in config/ so nothing console-specific is baked in here.
#
# The steps are deliberately separate and each one is verified before the next:
#
#   --dry-run            build the set and print the plan; touch nothing on the console
#
#   1. pull the save to saves/<game>-backup-<stamp>   (the backup the write needs)
#   2. build the launcher set into staging-launcher/  (stub + suspend launcher +
#      launcher body + NSO verifier, each with a sha256 in its manifest)
#   3. one transactional write with save-write-stage  (replace-verified, committed)
#   4. pull again and hash the result against the manifest
#
# Every step opens the save, so a wedged session after step 1 still leaves a good
# backup; that is the order, not an accident. Exit codes follow the toolkit's:
#   0 done and verified, 3 session lost, 4 no live host, 1 anything else.
set -eu
dry=0
positional=""
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then dry=1; else positional="$positional $arg"; fi
done
# shellcheck disable=SC2086
set -- $positional
run=${1:?usage: inject-launcher.sh <run-directory> [program-id] [uid-hex] [--dry-run]}
program=${2:-010042d022aea000}
uid=${3:-539fd27752770010a6ec4984c56d3664}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
stamp=$(date +%Y%m%d-%H%M%S)
name=$(python3 - "$root/config/titles.json" "$program" <<'PY'
import json, sys
names = json.load(open(sys.argv[1])).get('names', {})
name = names.get(sys.argv[2]) or sys.argv[2]
import re
print(re.sub(r'[^A-Za-z0-9._-]+', '-', name).strip('-'))
PY
)
backup="$root/saves/$name-backup-$stamp"
verify="$root/saves/$name-verify-$stamp"
staging="$root/staging-launcher"

say() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { say "FAILED: $*"; exit 1; }

if [ "$dry" -eq 1 ]; then
  # Dry run: build from the newest local backup so the manifest and hashes can be
  # inspected without a console. Nothing is pulled and nothing is written.
  source_backup=$(ls -dt "$root"/saves/*backup-*/ 2>/dev/null | head -1)
  if [ -z "$source_backup" ]; then
    source_backup=$(ls -dt "$root"/saves/*/user-*/ 2>/dev/null | head -1)
  fi
  [ -n "$source_backup" ] || fail "no local backup to build from (run without --dry-run once)"
  # A name-based pull nests the files under a timestamp directory, so step into the
  # newest subdirectory when the top level has no save blob.
  has_blob() { [ -f "$1/autosave.dat" ] || ls "$1"/save[0-9][0-9][0-9][0-9].dat >/dev/null 2>&1; }
  if ! has_blob "$source_backup"; then
    deeper=$(ls -dt "$source_backup"*/ 2>/dev/null | head -1)
    if [ -n "$deeper" ] && has_blob "$deeper"; then source_backup=$deeper; fi
  fi
  say "dry run: building from $source_backup"
  BODY="$root/payloads/ns2jb-launcher.lua" EXTRA="$root/payloads/nso-verify.lua" \
    sh "$here/build-untethered.sh" "$source_backup" "$staging" || fail "builder failed"
  say "dry run: would pull $program to $backup"
  say "dry run: would write $(python3 -c "import json;print(len(json.load(open('$staging/manifest.json'))['files']))") files with save-write-stage"
  say "dry run: would pull to $verify and verify against the manifest"
  exit 0
fi

say "1/4 backing up $program to $backup"
if ! node "$here/save-pull-root.cjs" "$run" "$program" "$backup" "$uid" --space 1 --type 1; then
  say "the backup did not complete; nothing was written"
  exit 3
fi
count=$(find "$backup" -type f | wc -l | tr -d ' ')
[ "$count" -gt 0 ] || fail "backup is empty"
say "    backup holds $count files"

say "2/4 building the launcher set"
BODY="$root/payloads/ns2jb-launcher.lua" EXTRA="$root/payloads/nso-verify.lua" \
  sh "$here/build-untethered.sh" "$backup" "$staging" || fail "builder failed"
say "    $(python3 -c "import json;print(len(json.load(open('$staging/manifest.json'))['files']))") files staged"

say "3/4 writing the set (one transaction)"
if ! node "$here/save-write-stage.cjs" "$run" "$program" "$uid" "$backup" "$staging/manifest.json"; then
  say "the write failed; the backup at $backup is intact"
  exit 3
fi

say "4/4 pulling the result and hashing it against the manifest"
node "$here/save-pull-root.cjs" "$run" "$program" "$verify" "$uid" --space 1 --type 1 \
  || fail "verify pull failed (the write may still be good; re-pull before believing that)"
if ! node "$here/verify-save-manifest.cjs" "$verify" "$staging/manifest.json"; then
  fail "the pulled save does not match the manifest"
fi
say "done: backup $backup, verified $verify"
