#!/bin/bash
# Maintainer-only tool: snapshot upstream repos into ordinary tracked files.
# This script is deliberately NEVER run by the end-user setup.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1:-}" != '--I-am-the-maintainer' ]]; then
  echo 'This command fetches a NEW upstream snapshot. Run only when intentionally updating your fork:' >&2
  echo '  ./scripts/freeze-upstream.sh --I-am-the-maintainer' >&2
  exit 2
fi
command -v git >/dev/null || { echo 'Install git.' >&2; exit 1; }
for path in vendor/libusbd vendor/macos_usb_gadget_poc vendor/ns2jb; do
  if [[ -e "$path" ]]; then echo "Refusing to overwrite $path. Move it manually before an intentional refresh." >&2; exit 1; fi
done
mkdir -p vendor assets
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
printf '# Frozen upstream revisions (only changed by maintainer)\n' > upstream.lock
for spec in \
  'libusbd|https://github.com/shinyquagsire23/libusbd.git' \
  'macos_usb_gadget_poc|https://github.com/shinyquagsire23/macos_usb_gadget_poc.git' \
  'ns2jb|https://gitlab.com/pepsipu/ns2jb.git'; do
  name="${spec%%|*}"; url="${spec#*|}"
  echo "Fetching $name snapshot..."
  git clone --depth 1 "$url" "$work/$name"
  sha="$(git -C "$work/$name" rev-parse HEAD)"
  printf '%s %s %s\n' "$name" "$sha" "$url" >> upstream.lock
  rm -rf "$work/$name/.git"
  cp -R "$work/$name" "vendor/$name"
  # Keep only the MIT-licensed Xcode kext sources from the PoC snapshot.
  # Do not accidentally resurrect binaries or the unused USB-device demo.
  if [[ "$name" == macos_usb_gadget_poc ]]; then
    rm -rf "vendor/$name/usbgadget.kext" "vendor/$name/usb_device" \
           "vendor/$name/build_run.sh" "vendor/$name/load.sh" \
           "vendor/$name/unload.sh" "vendor/$name/check-kexts.sh"            "vendor/$name/usbgadget/usbgadget.xcodeproj/project.xcworkspace"
    find "vendor/$name" -type d -name xcuserdata -prune -exec rm -rf {} +
    cat > "vendor/$name/README.md" <<'POCNOTE'
# macos_usb_gadget_poc (trimmed upstream source)
Origin: https://github.com/shinyquagsire23/macos_usb_gadget_poc
Only the `usbgadget/` Xcode project and MIT-licensed kext source are retained.
The unused USB-device examples, precompiled kexts and machine-local files are excluded.
See `usbgadget/LICENSE` and the root `vendor/README.md`.
POCNOTE
  fi
done
cp vendor/ns2jb/bootstrap.bas assets/bootstrap.bas
# Keep the original ns2jb engine and host together; run in its own folder.
# Record an integrity fingerprint of the actual frozen text.
shasum -a 256 assets/bootstrap.bas > assets/bootstrap.bas.sha256
cat > vendor/README.md <<'NOTE'
These are ordinary, committed SOURCE SNAPSHOTS, not Git submodules.
The exact upstream revisions are recorded in ../upstream.lock.
Do not run freeze-upstream.sh during normal build or on end-user machines.
Keep third-party notices; confirm every upstream component is redistributable before publishing.
The macos_usb_gadget_poc snapshot is deliberately trimmed; review retained licenses after each refresh.
Do not assume ns2jb or macos_usb_gadget_poc have an open-source license; review rights before redistributing.
NOTE
printf '\nSnapshots staged. REVIEW licensing, security and changes, then git add vendor assets upstream.lock and commit.\n'
