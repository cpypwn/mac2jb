#!/bin/sh
# Rebuild the save-stage artefacts from a pulled backup of the target save.
#   ./build-stage.sh saves/SeedsowFull-ns2jb-base staging-ns2jb
set -eu
base=${1:?usage: build-stage.sh <backup-directory> [output-directory]}
out=${2:-staging-ns2jb}
mkdir -p "$out"
python3 "$(dirname "$0")/artemis-save.py" asb payloads/ns2jb-boot.lua ns2jb_boot "$out/ns2jb.asb"
python3 "$(dirname "$0")/artemis-save.py" launch "$base/autosave.dat" ns2jb.asb "$out/save9999.dat"
cat > "$out/manifest.json" <<JSON
{
  "title": "Seedsow Lullaby",
  "base": "$base/autosave.dat",
  "purpose": "suspend slot 9999 resumes at save:/ns2jb.asb",
  "files": [
    {"path": "/ns2jb.asb", "local": "$out/ns2jb.asb"},
    {"path": "/save9999.dat", "local": "$out/save9999.dat"}
  ]
}
JSON
echo "built $out/manifest.json"
