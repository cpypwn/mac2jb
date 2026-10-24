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

shasum -a 256 -c assets/bootstrap.bas.sha256
bash scripts/install-driver.sh --verify
(cd vendor/ns2jb && shasum -a 256 -c SHA256SUMS >/dev/null)
# Force a fresh GUI-payload build so stale CLI artifacts cannot retain the
# builder's newer default deployment target. The regular CLI defaults stay as-is.
MACOSX_DEPLOYMENT_TARGET=14.0 make -B

STAGE="$(mktemp -d "$BUILD/stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
PAYLOAD="$STAGE/runtime"
mkdir -p "$PAYLOAD/vendor/libusbd" "$PAYLOAD/licenses"
# GUI-only tuning and progress must never change the legacy CLI executables.
SDK="$(xcrun --sdk macosx --show-sdk-path)"
for tool in send commands; do
  source=commands.c
  [[ "$tool" == send ]] && source=sender.c
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
# Reject Homebrew or other machine-local library dependencies.
while IFS= read -r dependency; do
  case "$dependency" in /usr/lib/*|/System/Library/*) ;;
    *) echo "Node depends on a non-system library: $dependency" >&2; exit 1 ;;
  esac
done < <(otool -L "$PAYLOAD/node" | tail -n +2 | awk '{print $1}')
cp "$NODE_LICENSE" "$PAYLOAD/licenses/node-LICENSE.txt"
chmod 700 "$PAYLOAD/node" "$PAYLOAD/mac2jb-send" "$PAYLOAD/mac2jb-commands"
python3 - "$PAYLOAD" <<'PY'
import re, subprocess, sys
from pathlib import Path
root = Path(sys.argv[1])
for name in ['node', 'mac2jb-send', 'mac2jb-commands', 'vendor/libusbd/libusbd.dylib']:
    info = subprocess.check_output(['xcrun', 'vtool', '-show-build', str(root/name)], text=True)
    versions = re.findall(r'\bminos\s+(\d+(?:\.\d+)*)', info)
    if not versions: raise SystemExit('Missing deployment target: '+name)
    for version in versions:
        parts = tuple(map(int, version.split('.')))
        parts += (0,) * (3-len(parts))
        if parts > (14, 0, 0): raise SystemExit(name+' requires macOS '+version+', above GUI minimum 14.0')
    print(name+': minimum macOS '+', '.join(versions))
PY

# Assemble a strict source whitelist. Never traverse this build directory,
# session directories, logs, Git metadata, or Xcode user state. Only the tested
# driver under drivers/ is allowed; vendor prebuilt kexts remain excluded.
python3 - "$ROOT" "$PAYLOAD" "$NODE_BINARY" <<'PY'
import hashlib, json, shutil, sys
from pathlib import Path
root, payload, node = map(Path, sys.argv[1:])
source = payload / 'source'
source.mkdir()
files = ['README.md', 'LICENSE', '.gitignore', 'Makefile', 'sender.c', 'commands.c',
         'indent-test.bas', 'upstream.lock', 'mac2jb.command', 'setup.sh',
         'fetch-bootstrap.sh', 'make-release-zip.command']
folders = ['gui', 'scripts', 'packaging', 'docs', 'drivers', 'assets', 'vendor', '.github']
blocked = {'.git', 'runs', '__pycache__', 'xcuserdata', 'project.xcworkspace',
           'usb_device', '.DS_Store'}
suffixes = {'.o', '.dylib', '.log', '.pyc', '.bak', '.xcuserstate'}
def safe(path):
    if 'usbgadget.kext' in path.parts and 'drivers' not in path.parts: return False
    return (not any(part in blocked or part.startswith('._') for part in path.parts)
            and path.suffix not in suffixes and not path.is_symlink())
def copy(src, dst):
    if not safe(src.relative_to(root)) or not safe(src): return
    if src.is_file():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
for name in files:
    if (root/name).exists(): copy(root/name, source/name)
for name in folders:
    if (root/name).exists():
        for src in sorted((root/name).rglob('*')): copy(src, source/src.relative_to(root))
for name in ['vendor/ns2jb', 'assets', 'drivers']:
    for src in sorted((root/name).rglob('*')): copy(src, payload/src.relative_to(root))
for name in ['scripts/gui-host.cjs', 'scripts/install-driver.sh', 'packaging/NOTICE.md']:
    if not (root/name).is_file(): raise SystemExit('Missing GUI build input: '+name)
    copy(root/name, payload/name)
provenance = {
    'version': 'v24.22.1', 'platform': 'darwin-arm64',
    'origin': 'arm64 slice of locally installed official Node.js distribution',
    'upstream': 'https://nodejs.org/dist/v24.22.1/',
    'licenseSource': 'https://raw.githubusercontent.com/nodejs/node/v24.22.1/LICENSE',
    'installedBinarySha256': hashlib.sha256(node.read_bytes()).hexdigest(),
    'bundledArm64Sha256': hashlib.sha256((payload/'node').read_bytes()).hexdigest(),
    'licenseSha256': hashlib.sha256((payload/'licenses/node-LICENSE.txt').read_bytes()).hexdigest(),
}
(payload/'licenses/node-provenance.json').write_text(json.dumps(provenance, indent=2)+'\n')
PY

python3 - "$PAYLOAD" "$BUILD" <<'PY'
import gzip, hashlib, json, os, sys, tarfile, zipfile
from pathlib import Path
payload, build = map(Path, sys.argv[1:])
archive = build/'runtime.tar.gz'
with archive.open('wb') as stream, gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0) as gz:
    with tarfile.open(fileobj=gz, mode='w', format=tarfile.USTAR_FORMAT) as tar:
        for path in sorted(payload.rglob('*')):
            relative = path.relative_to(payload).as_posix()
            if path.is_symlink(): raise SystemExit('Refusing archive symlink: '+relative)
            entry = tar.gettarinfo(str(path), arcname=relative)
            entry.uid = entry.gid = 0; entry.uname = entry.gname = ''; entry.mtime = 0
            entry.mode = 0o700 if path.is_dir() or relative in ('node','mac2jb-send','mac2jb-commands') else 0o600
            if path.is_file():
                with path.open('rb') as file: tar.addfile(entry, file)
            elif path.is_dir(): tar.addfile(entry)
            else: raise SystemExit('Unsupported archive file: '+relative)
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(build/'PayloadMetadata.swift').write_text('enum EmbeddedPayloadMetadata { static let sha256 = '+json.dumps(digest)+' }\n')
with zipfile.ZipFile(build/'mac2jb-0.3.1-source.zip', 'w', compression=zipfile.ZIP_DEFLATED) as zipped:
    for path in sorted((payload/'source').rglob('*')):
        if path.is_file(): zipped.write(path, 'mac2jb/'+path.relative_to(payload/'source').as_posix())
print('Embedded runtime SHA-256:', digest)
PY

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
codesign --force --sign - "$STAGE/mac2jb.app"
codesign --verify --strict "$STAGE/mac2jb.app"
mkdir -p "$(dirname "$APP_OUTPUT")"
if [[ -e "$APP_OUTPUT" ]]; then rm -rf "$APP_OUTPUT"; fi
mv "$STAGE/mac2jb.app" "$APP_OUTPUT"
echo "Created GUI app: $APP_OUTPUT"
echo "Corresponding source: $BUILD/mac2jb-0.3.1-source.zip"
