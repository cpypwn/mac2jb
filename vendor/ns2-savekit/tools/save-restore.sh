#!/bin/sh
# Put a pulled save back on the console, generically: any title, any space/type.
#
#   tools/save-restore.sh <run-directory> <program-id> <uid-hex> <save-directory>
#                         [--space N --type N] [--dry-run]
#
# <save-directory> is what tools/save-pull-root.cjs produced (a flat directory of the
# save's files plus our manifest.json). The order is the same discipline as injection,
# and for the same reason - every step can fail without losing the previous one:
#
#   1. pull the CURRENT save to saves/<id>-pre-restore-<stamp>   (the safety net)
#   2. build a restore manifest from <save-directory>            (hashes every file)
#   3. one transactional write: --restore --confirm-restore      (replaces differing bytes)
#   4. pull again and hash the result against the manifest
#
# A restore deliberately replaces live bytes that differ from what is being written,
# which is exactly what the plain write path refuses. The pre-restore backup in step 1
# is what makes that acceptable: it is the state you can go back to.
#
# The title must be allowed to be written: the built-in list covers the disposable
# titles this toolkit was developed on, and config/titles.local.json can add more
# (see config/titles.json for the shape; keep that file out of version control).
set -eu
run=${1:?usage: save-restore.sh <run> <program-id> <uid> <save-directory> [--space N --type N] [--dry-run]}
program=${2:?program id required}
uid=${3:?uid required}
source_dir=${4:?save directory required}
shift 4
space=1
type_arg=1
dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --space) space=$2; shift 2 ;;
    --type) type_arg=$2; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
here=$(dirname "$0")
root=$(cd "$here/.." && pwd)
stamp=$(date +%Y%m%d-%H%M%S)
slug=$(basename "$source_dir")
safety="$root/saves/$program-pre-restore-$stamp"
manifest="$root/staging-restore/$program-$stamp.json"

echo "restore plan"
echo "  title      $program  (space $space, type $type_arg)"
echo "  account    $uid"
echo "  from       $source_dir"
echo "  safety     $safety"
echo "  manifest   $manifest"

mkdir -p "$root/staging-restore"
node "$here/manifest-from-dir.cjs" "$source_dir" "$manifest" || { echo "cannot build a manifest from $source_dir" >&2; exit 1; }

if [ "$dry" = 1 ]; then
  echo "dry run: nothing has been written to the console"
  exit 0
fi

echo
echo "1/4 backing up the current save (the state you can return to)"
node "$here/save-pull-root.cjs" "$run" "$program" "$safety" "$uid" \
  --space "$space" --type "$type_arg" || { echo "the pre-restore backup failed; nothing was written" >&2; exit 1; }

echo
echo "2/4 writing the save back"
node "$here/save-write-stage.cjs" "$run" "$program" "$uid" "$safety" "$manifest" \
  --space "$space" --type "$type_arg" --restore --confirm-restore || { echo "write failed; the pre-restore backup is at $safety" >&2; exit 1; }

echo
echo "3/4 pulling the result"
verify="$root/saves/$program-post-restore-$stamp"
node "$here/save-pull-root.cjs" "$run" "$program" "$verify" "$uid" \
  --space "$space" --type "$type_arg" || { echo "restore written but the verification pull failed; backup at $safety" >&2; exit 1; }

echo
echo "4/4 verifying every restored file against the manifest"
node "$here/verify-save-manifest.cjs" "$verify" "$manifest" || { echo "restored bytes do not match the manifest" >&2; exit 1; }

echo
echo "restored $program from $source_dir"
echo "  pre-restore state  $safety"
echo "  read-back check    $verify"
