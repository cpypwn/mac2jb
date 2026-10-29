#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
preview_dir="$repo_root/build/mintbrew-desktop-preview"
app_dir="$preview_dir/MintBrew Desktop Preview.app"
binary="$app_dir/Contents/MacOS/MintBrew Desktop Preview"
state="${1:-$preview_dir/state.bin}"
atlas="${2:-$preview_dir/atlas.bin}"
shaders="$repo_root/vendor/MintBrew/homebrew-launcher/shaders"

if [[ ! -f "$state" || ! -f "$atlas" ]]; then
  echo "stage state.bin and atlas.bin in $preview_dir first" >&2
  exit 1
fi

mkdir -p "$app_dir/Contents/MacOS"
clang -std=c11 -Wall -Wextra -Werror \
  -I/opt/homebrew/include -L/opt/homebrew/lib -Wl,-rpath,/opt/homebrew/lib \
  "$repo_root/scripts/dev-mintbrew-window.c" -lvulkan -lglfw \
  -framework OpenGL -framework Cocoa -framework IOKit -framework CoreVideo \
  -o "$binary"
cat > "$app_dir/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>MintBrew Desktop Preview</string>
  <key>CFBundleDisplayName</key><string>MintBrew Desktop Preview</string>
  <key>CFBundleIdentifier</key><string>io.mac2jb.mintbrew-desktop-preview</string>
  <key>CFBundleExecutable</key><string>MintBrew Desktop Preview</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
PLIST

export VK_ICD_FILENAMES=/opt/homebrew/opt/molten-vk/etc/vulkan/icd.d/MoltenVK_icd.json
open -n -a "$app_dir" --args "$state" "$atlas" "$shaders"
echo "$app_dir"
