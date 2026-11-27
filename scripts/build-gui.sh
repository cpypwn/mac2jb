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
export PYTHONDONTWRITEBYTECODE=1
NODE_LICENSE="$ROOT/packaging/licenses/node-v24.22.1-LICENSE.txt"
[[ -x "$NODE_BINARY" && -f "$NODE_LICENSE" ]] || {
  echo 'This GUI build requires Node v24.22.1 and its included matching LICENSE.' >&2
  echo 'Set NODE_BINARY to an official Node v24.22.1 macOS arm64/universal executable.' >&2
  exit 1
}
[[ "$("$NODE_BINARY" --version)" == v24.22.1 ]] || {
  echo 'Node version must match the bundled v24.22.1 LICENSE and provenance.' >&2; exit 1;
}
if ! "$NODE_BINARY" -e 'require.resolve("terser", {paths: [process.argv[1]]})' \
  "$ROOT/vendor/CivSwitch/installer-creator" >/dev/null 2>&1; then
  npm ci --prefix vendor/CivSwitch/installer-creator --ignore-scripts --no-audit --no-fund
fi
"$NODE_BINARY" -e 'require(require.resolve("terser", {paths: [process.argv[1]]}))' \
  "$ROOT/vendor/CivSwitch/installer-creator"
mkdir -p "$BUILD"
xcrun swiftc -swift-version 5 -target arm64-apple-macos14.0 \
  gui/SessionDataCleanup.swift scripts/test-session-data-cleanup.swift \
  -o "$BUILD/test-session-data-cleanup"
"$BUILD/test-session-data-cleanup"
xcrun swiftc -swift-version 5 -target arm64-apple-macos14.0 \
  gui/CivSwitchModel.swift scripts/test-civswitch-model.swift \
  -o "$BUILD/test-civswitch-model"
"$BUILD/test-civswitch-model"
if ! python3 scripts/prepare-homebrew-runtime.py --check; then
  python3 scripts/prepare-homebrew-runtime.py
fi
if ! NODE_BINARY="$NODE_BINARY" sh integrations/mintbrew-native/build-native.sh --check >/dev/null; then
  NODE_BINARY="$NODE_BINARY" sh integrations/mintbrew-native/build-native.sh
fi
sh integrations/mintbrew-native/upstream/apps/mintnes/tests/run.sh
MAC2JB_HBLAUNCHER_FONT="$BUILD/homebrew/fonts/DejaVuSans.ttf" \
  "$BUILD/homebrew/python/bin/python3" vendor/MintBrew/homebrew-launcher/launcher-text.py
for stage in vert frag comp; do
  "$BUILD/homebrew/bin/glslangValidator" -V -Os -g0 --target-env vulkan1.0 \
    "vendor/MintBrew/homebrew-launcher/shaders/launcher.$stage" \
    -o "vendor/MintBrew/homebrew-launcher/shaders/launcher.$stage.spv"
  "$BUILD/homebrew/bin/spirv-val" --target-env vulkan1.0 \
    "vendor/MintBrew/homebrew-launcher/shaders/launcher.$stage.spv"
done
"$NODE_BINARY" scripts/prepare-bootstrap.cjs --check
"$NODE_BINARY" scripts/prepare-host-profiles.cjs --check
"$NODE_BINARY" scripts/prepare-seedsow-host.cjs --check
"$NODE_BINARY" scripts/gui-offline-ethernet.cjs --self-test
"$NODE_BINARY" --test scripts/test-gui-offline-ethernet.cjs
bash -n integrations/offline-ethernet/helper.sh
perl -c integrations/offline-ethernet/Responder.pl
bash scripts/test-usb-typing-timing.sh
bash scripts/test-typing-preferences.sh
bash scripts/test-network-selection.sh
osacompile -o "$BUILD/offline-ethernet.scpt" scripts/offline-ethernet-launch.applescript
"$NODE_BINARY" integrations/civswitch/verify.cjs --source
civswitch_tests=(integrations/civswitch/probe.test.cjs integrations/civswitch/send-payload.test.cjs integrations/civswitch/install-persistent.test.cjs integrations/civswitch/fs-host.test.cjs scripts/test-civswitch-hid.cjs)
if [ -f integrations/civswitch/send-hello.test.cjs ] && [ -f integrations/civswitch/send-hello.cjs ]; then
    civswitch_tests+=(integrations/civswitch/send-hello.test.cjs)
fi
"$NODE_BINARY" --test "${civswitch_tests[@]}"
"$NODE_BINARY" --test integrations/kaihen/launch.test.cjs integrations/kaihen/ns2jb-launch.test.cjs
"$NODE_BINARY" --test integrations/seedsow-kaihen/launch.test.cjs
"$NODE_BINARY" integrations/seedsow-semi-untethered/upload.cjs --check
"$NODE_BINARY" --test integrations/civswitchfs-kaihen/launch.test.cjs
"$NODE_BINARY" --test integrations/artemis-fs/fs-host.test.cjs
"$NODE_BINARY" --test scripts/test-cli-usb-fallback.cjs
"$NODE_BINARY" --test scripts/test-gui-discover-rpc.cjs
"$NODE_BINARY" --test scripts/test-homebrew-reentry.cjs scripts/test-gui-session.cjs scripts/test-gui-attach.cjs
"$NODE_BINARY" scripts/gui-savekit.cjs --self-test
"$NODE_BINARY" --test scripts/test-gui-savekit.cjs
bash scripts/test-artemis-update.sh
bash scripts/test-bundled-update.sh
bash scripts/test-artemis-http.sh
"$NODE_BINARY" scripts/gui-savekit-tools.cjs --self-test
"$NODE_BINARY" --test scripts/test-gui-savekit-tools.cjs
"$NODE_BINARY" --test scripts/test-savekit-file-hash.cjs
"$NODE_BINARY" --test vendor/ns2-savekit/tests/test_save_write_directories.cjs
"$NODE_BINARY" vendor/ns2-savekit/tests/test_delete_result.cjs
"$NODE_BINARY" --test vendor/ns2-savekit/tests/test_kit_delete.cjs
"$NODE_BINARY" vendor/ns2-savekit/tests/test_artemis_http.cjs
"$NODE_BINARY" --test vendor/ns2-savekit/tests/test_diagnose_ns2jb.cjs
"$NODE_BINARY" --test scripts/test-savekit-title-names.cjs
"$NODE_BINARY" --test scripts/test-seedsow-held-session.cjs
"$NODE_BINARY" --test scripts/test-custom-rpc-package.cjs
"$NODE_BINARY" --test scripts/test-gui-modloader.cjs
"$NODE_BINARY" scripts/check-savekit-research.cjs
"$NODE_BINARY" --test integrations/mintbrew-native/contract.test.cjs
"$NODE_BINARY" --test integrations/mintbrew-native/host.test.cjs integrations/mintbrew-native/sd-roms.test.cjs scripts/test-kurumuz-native-ranges.cjs
"$NODE_BINARY" scripts/prepare-homebrew-apps.cjs --check
"$NODE_BINARY" scripts/prepare-mintbrew.cjs --check-source
"$NODE_BINARY" scripts/gui-ouncecake.cjs --self-test
"$NODE_BINARY" scripts/gui-ouncecake-civ7.cjs --self-test
PATH="$BUILD/homebrew/python/bin:$BUILD/homebrew/bin:$PATH" "$NODE_BINARY" --test \
  scripts/test-gui-ouncecake.cjs scripts/test-gui-ouncecake-civ7.cjs scripts/test-mintbrew-ouncecake.cjs scripts/test-ouncecake-server.cjs \
  integrations/mintbrew-ouncecake/ftp-bridge.test.cjs
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
xcrun clang -std=c11 -D_POSIX_C_SOURCE=200809L -O2 -Wall -Wextra \
  -target arm64-apple-macos14.0 -isysroot "$SDK" -Ivendor/libusbd/include \
  civswitch-hid.c -Lvendor/libusbd -lusbd -Wl,-rpath,@executable_path/vendor/libusbd \
  -framework CoreFoundation -framework IOKit -o "$BUILD/mac2jb-civswitch-hid"
codesign --force --sign - "$BUILD/mac2jb-civswitch-hid"
cp "$BUILD/mac2jb-civswitch-hid" "$PAYLOAD/"
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
chmod 700 "$PAYLOAD/node" "$PAYLOAD/mac2jb-send" "$PAYLOAD/mac2jb-commands" "$PAYLOAD/mac2jb-keyboard" "$PAYLOAD/mac2jb-civswitch-hid"
python3 scripts/package-gui-payload.py verify-minimum "$PAYLOAD"
python3 scripts/package-gui-payload.py stage "$ROOT" "$PAYLOAD" "$NODE_BINARY"
"$NODE_BINARY" "$PAYLOAD/scripts/gui-offline-ethernet.cjs" --self-test
bash -n "$PAYLOAD/integrations/offline-ethernet/helper.sh"
perl -c "$PAYLOAD/integrations/offline-ethernet/Responder.pl"
"$NODE_BINARY" "$PAYLOAD/integrations/civswitch/verify.cjs" --runtime
"$NODE_BINARY" "$PAYLOAD/integrations/seedsow-semi-untethered/upload.cjs" --check
if [ -f "$PAYLOAD/integrations/civswitch/send-hello.cjs" ]; then
    "$NODE_BINARY" --check "$PAYLOAD/integrations/civswitch/send-hello.cjs"
fi
"$NODE_BINARY" --check "$PAYLOAD/integrations/civswitch/send-payload.cjs"
"$NODE_BINARY" --check "$PAYLOAD/integrations/civswitch/install-persistent.cjs"
"$NODE_BINARY" --check "$PAYLOAD/integrations/civswitch/backup-single.js"
"$NODE_BINARY" --check "$PAYLOAD/integrations/civswitchfs-kaihen/launch.cjs"
"$NODE_BINARY" -e 'require(process.argv[1]).verifyAssets(process.argv[2])' \
  "$PAYLOAD/integrations/civswitchfs-kaihen/launch.cjs" "$PAYLOAD"
if [ -f "$PAYLOAD/integrations/civswitch/hello.js" ]; then
    "$NODE_BINARY" --check "$PAYLOAD/integrations/civswitch/hello.js"
fi
"$PAYLOAD/mac2jb-civswitch-hid" --payload "$PAYLOAD/integrations/civswitch/payload.txt" --dry-run
"$NODE_BINARY" "$PAYLOAD/scripts/check-savekit-research.cjs" --root "$PAYLOAD" --compare "$ROOT"
python3 scripts/package-gui-payload.py verify-runtime "$ROOT" "$PAYLOAD"

python3 scripts/package-gui-payload.py archive "$PAYLOAD" "$BUILD" "$SOURCE_ARCHIVE"
rm -rf "$BUILD/homebrew"

xcrun clang -target arm64-apple-macos14.0 -O2 -c gui/EmbeddedPayload.c -o "$BUILD/EmbeddedPayload.o"
mkdir -p "$STAGE/mac2jb.app/Contents/MacOS" "$STAGE/mac2jb.app/Contents/Resources"
GUI_SOURCES=()
GUI_SWIFT_FLAGS=(-D MAC2JB_GUI_BUILD)
TEST_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :MAC2JBTestBuild' "$ROOT/gui/Info.plist")"
for source in gui/*.swift; do GUI_SOURCES+=("$source"); done
if [[ "$TEST_BUILD" == true ]]; then GUI_SWIFT_FLAGS+=(-D MAC2JB_TEST_BUILD); fi
xcrun swiftc -swift-version 5 -target arm64-apple-macos14.0 -O \
  -module-cache-path "$BUILD/module-cache" \
  -framework SwiftUI -framework AppKit -framework CryptoKit \
  "${GUI_SWIFT_FLAGS[@]}" "${GUI_SOURCES[@]}" "$BUILD/PayloadMetadata.swift" "$BUILD/EmbeddedPayload.o" \
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
rm -rf "$BUILD/module-cache" "$BUILD/runtime.tar.gz"
# Exercise the actual embedded runtime before replacing a working app.
if ! "$STAGE/mac2jb.app/Contents/MacOS/mac2jb" --self-test > "$STAGE/runtime-self-test.log" 2>&1; then
  tail -n 80 "$STAGE/runtime-self-test.log" >&2
  echo 'Packaged app runtime self-test failed.' >&2
  exit 1
fi
tail -n 1 "$STAGE/runtime-self-test.log"
mkdir -p "$(dirname "$APP_OUTPUT")"
if [[ -e "$APP_OUTPUT" ]]; then rm -rf "$APP_OUTPUT"; fi
mv "$STAGE/mac2jb.app" "$APP_OUTPUT"
codesign --verify --deep --strict "$APP_OUTPUT"
echo "Created GUI app: $APP_OUTPUT"
echo "Corresponding source: $SOURCE_ARCHIVE"
