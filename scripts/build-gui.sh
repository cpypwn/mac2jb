#!/bin/bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || {
  echo 'Build the GUI on an Apple Silicon Mac.' >&2; exit 1;
}
APP_OUTPUT="${1:-$ROOT/build/mac2jb.app}"
[[ "$APP_OUTPUT" == *.app ]] || { echo 'Output must be an .app path.' >&2; exit 1; }
APP_OUTPUT="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$APP_OUTPUT")"
BUILD="$ROOT/.build-gui"
APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/gui/Info.plist")"
[[ "$APP_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
  echo 'The app version must be a stable three-part version.' >&2; exit 1;
}
SOURCE_ARCHIVE="$BUILD/mac2jb-$APP_VERSION-source.zip"
NODE_BINARY="${NODE_BINARY:-/usr/local/bin/node}"
NODE_LICENSE="$ROOT/packaging/licenses/node-v24.22.1-LICENSE.txt"
[[ -x "$NODE_BINARY" && -f "$NODE_LICENSE" ]] || {
  echo 'This GUI build requires Node v24.22.1 and its included matching LICENSE.' >&2
  echo 'Set NODE_BINARY to an official Node v24.22.1 macOS arm64/universal executable.' >&2
  exit 1
}
[[ "$("$NODE_BINARY" --version)" == v24.22.1 ]] || {
  echo 'Node version must match the bundled v24.22.1 LICENSE and provenance.' >&2; exit 1;
}
mkdir -p "$BUILD"
if ! python3 scripts/prepare-homebrew-runtime.py --check; then
  python3 scripts/prepare-homebrew-runtime.py
fi
MAC2JB_HBLAUNCHER_FONT="$BUILD/homebrew/fonts/DejaVuSans.ttf" \
  "$BUILD/homebrew/python/bin/python3" vendor/MintBrew/homebrew-launcher/launcher-text.py
for stage in vert frag comp; do
  "$BUILD/homebrew/bin/glslangValidator" -V -Os -g0 --target-env vulkan1.0 \
    "vendor/MintBrew/homebrew-launcher/shaders/launcher.$stage" \
    -o "vendor/MintBrew/homebrew-launcher/shaders/launcher.$stage.spv"
  "$BUILD/homebrew/bin/spirv-val" --target-env vulkan1.0 \
    "vendor/MintBrew/homebrew-launcher/shaders/launcher.$stage.spv"
done
"$NODE_BINARY" integrations/blitbun/doom-engine/build.cjs --check
chmod 700 integrations/blitbun/doom-engine/doom-headless
[[ "$(lipo -archs integrations/blitbun/doom-engine/doom-headless)" == arm64 ]] || {
  echo 'The bundled Freedoom engine must be arm64.' >&2; exit 1;
}
while IFS= read -r dependency; do
  case "$dependency" in /usr/lib/*|/System/Library/*) ;;
    *) echo "Freedoom engine depends on a non-system library: $dependency" >&2; exit 1 ;;
  esac
done < <(otool -L integrations/blitbun/doom-engine/doom-headless | tail -n +2 | awk '{print $1}')

"$NODE_BINARY" scripts/prepare-bootstrap.cjs --check
"$NODE_BINARY" scripts/prepare-host-profiles.cjs --check
"$NODE_BINARY" scripts/prepare-homebrew-apps.cjs --check
"$NODE_BINARY" scripts/prepare-mintbrew.cjs --check-source
"$NODE_BINARY" scripts/prepare-izlauncher.cjs --check-source
"$NODE_BINARY" scripts/gui-ouncecake.cjs --self-test
shasum -a 256 -c assets/bootstrap.bas.sha256
bash scripts/install-driver.sh --verify
(cd vendor/ns2jb && shasum -a 256 -c SHA256SUMS >/dev/null)
(cd vendor/HBLauncher && shasum -a 256 -c ../../packaging/HBLauncher-v0.2.0-SHA256SUMS >/dev/null)
(cd vendor/GPUBrewLauncher && shasum -a 256 -c ../../packaging/GPUBrewLauncher-SHA256SUMS >/dev/null)
# force a fresh gui payload build to retain the macos 14 deployment target.
MACOSX_DEPLOYMENT_TARGET=14.0 make -B

# keep signing inputs outside synced folders that can add resource fork metadata.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/mac2jb-gui.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
PAYLOAD="$STAGE/runtime"
mkdir -p "$PAYLOAD/vendor/libusbd" "$PAYLOAD/licenses"
# compile gui payload tools without changing the cli executables.
SDK="$(xcrun --sdk macosx --show-sdk-path)"
for tool in send commands keyboard; do
  source=commands.c
  [[ "$tool" == send ]] && source=sender.c
  [[ "$tool" == keyboard ]] && source=keyboard.c
  xcrun clang -std=c11 -D_POSIX_C_SOURCE=200809L -DMAC2JB_GUI=1 -O2 -Wall -Wextra \
    -target arm64-apple-macos14.0 -isysroot "$SDK" -Ivendor/libusbd/include \
    "$source" -Lvendor/libusbd -lusbd -Wl,-rpath,@executable_path/vendor/libusbd \
    -framework CoreFoundation -framework IOKit -o "$BUILD/mac2jb-$tool"
  codesign --force --sign - "$BUILD/mac2jb-$tool"
  cp "$BUILD/mac2jb-$tool" "$PAYLOAD/"
done
cp vendor/libusbd/libusbd.dylib "$PAYLOAD/vendor/libusbd/"
if [[ "$(lipo -archs "$NODE_BINARY")" == *x86_64* ]]; then
  lipo "$NODE_BINARY" -thin arm64 -output "$PAYLOAD/node"
else
  [[ "$(lipo -archs "$NODE_BINARY")" == arm64 ]] || { echo 'Node must contain arm64.' >&2; exit 1; }
  cp "$NODE_BINARY" "$PAYLOAD/node"
fi
while IFS= read -r dependency; do
  case "$dependency" in /usr/lib/*|/System/Library/*) ;;
    *) echo "Node depends on a non-system library: $dependency" >&2; exit 1 ;;
  esac
done < <(otool -L "$PAYLOAD/node" | tail -n +2 | awk '{print $1}')
cp "$NODE_LICENSE" "$PAYLOAD/licenses/node-LICENSE.txt"
cp -R "$BUILD/homebrew" "$PAYLOAD/homebrew"
chmod 700 "$PAYLOAD/node" "$PAYLOAD/mac2jb-send" "$PAYLOAD/mac2jb-commands" "$PAYLOAD/mac2jb-keyboard"
python3 scripts/package-gui-payload.py verify-minimum "$PAYLOAD"
python3 scripts/package-gui-payload.py stage "$ROOT" "$PAYLOAD" "$NODE_BINARY"

"$NODE_BINARY" scripts/prepare-homebrew-apps.cjs --install "$PAYLOAD/vendor/HBLauncher/apps"
"$NODE_BINARY" scripts/prepare-homebrew-apps.cjs --install "$PAYLOAD/vendor/GPUBrewLauncher/apps"
"$NODE_BINARY" scripts/prepare-mintbrew.cjs --prepare "$PAYLOAD"
"$NODE_BINARY" "$PAYLOAD/scripts/prepare-mintbrew.cjs" --check-runtime "$PAYLOAD"

python3 scripts/package-gui-payload.py archive "$PAYLOAD" "$BUILD" "$SOURCE_ARCHIVE"

xcrun clang -target arm64-apple-macos14.0 -O2 -c gui/EmbeddedPayload.c -o "$BUILD/EmbeddedPayload.o"
mkdir -p "$STAGE/mac2jb.app/Contents/MacOS" "$STAGE/mac2jb.app/Contents/Resources"
xcrun swiftc -swift-version 5 -target arm64-apple-macos14.0 -O \
  -module-cache-path "$BUILD/module-cache" \
  -framework SwiftUI -framework AppKit -framework CryptoKit \
  gui/*.swift "$BUILD/PayloadMetadata.swift" "$BUILD/EmbeddedPayload.o" \
  -Xlinker -sectcreate -Xlinker __DATA -Xlinker __mac2jb -Xlinker "$BUILD/runtime.tar.gz" \
  -o "$STAGE/mac2jb.app/Contents/MacOS/mac2jb"
cp gui/Info.plist "$STAGE/mac2jb.app/Contents/Info.plist"
xcrun swiftc -parse-as-library -swift-version 5 -target arm64-apple-macos14.0 -O \
  -module-cache-path "$BUILD/module-cache" -framework SwiftUI -framework AppKit \
  gui/KeyboardMark.swift scripts/make-app-icon.swift -o "$BUILD/make-app-icon"
"$BUILD/make-app-icon" "$BUILD/mac2jb.iconset" "$STAGE/mac2jb.app/Contents/Resources/mac2jb.icns"
xattr -cr "$STAGE/mac2jb.app"
codesign --force --sign - "$STAGE/mac2jb.app"
codesign --verify --strict "$STAGE/mac2jb.app"
mkdir -p "$(dirname "$APP_OUTPUT")"
if [[ -e "$APP_OUTPUT" ]]; then rm -rf "$APP_OUTPUT"; fi
mv "$STAGE/mac2jb.app" "$APP_OUTPUT"
codesign --verify --deep --strict "$APP_OUTPUT"
echo "Created GUI app: $APP_OUTPUT"
echo "Corresponding source: $SOURCE_ARCHIVE"
