#!/bin/sh
set -eu

native_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
upstream_dir="$native_dir/upstream"
native_node=${NODE_BINARY:-node}

if ! command -v "$native_node" >/dev/null 2>&1; then
  echo "Node is unavailable: $native_node" >&2
  exit 1
fi

if [ "${1:-}" = --check ] && [ "$#" -eq 1 ]; then
  exec "$native_node" "$native_dir/verify-native.cjs" --all "$upstream_dir"
fi
if [ "$#" -ne 0 ]; then
  echo 'Usage: build-native.sh [--check]' >&2
  exit 2
fi

if [ "$(uname -s)" != Darwin ] || ! command -v brew >/dev/null 2>&1; then
  echo 'The native build requires macOS and Homebrew.' >&2
  exit 1
fi

llvm_dir=$(brew --prefix llvm)
lld_dir=$(brew --prefix lld)
vulkan_dir=$(brew --prefix vulkan-headers)
for tool in "$llvm_dir/bin/clang" "$llvm_dir/bin/llvm-objcopy" \
  "$llvm_dir/bin/llvm-nm" "$llvm_dir/bin/llvm-size" "$lld_dir/bin/ld.lld"; do
  if [ ! -x "$tool" ]; then
    echo "Missing $tool. Install llvm, lld and vulkan-headers with Homebrew." >&2
    exit 1
  fi
done
if [ ! -f "$vulkan_dir/include/vulkan/vulkan.h" ]; then
  echo 'Vulkan headers are missing. Install vulkan-headers with Homebrew.' >&2
  exit 1
fi

llvm_version=$("$llvm_dir/bin/clang" --version | sed -n '1s/.*version \([0-9.]*\).*/\1/p')
lld_version=$("$lld_dir/bin/ld.lld" --version | sed -n '1s/.* \([0-9][0-9.]*\) .*/\1/p')
vulkan_version=$(brew list --versions vulkan-headers | awk '{print $2}')
if [ "$llvm_version" != 23.1.4 ] || [ "$lld_version" != 23.1.4 ] || \
  [ "$vulkan_version" != 1.4.363.0 ]; then
  echo "Expected llvm/lld 23.1.4 and vulkan-headers 1.4.363.0; found $llvm_version/$lld_version/$vulkan_version" >&2
  exit 1
fi

tool_dir=$(mktemp -d "${TMPDIR:-/tmp}/mac2jb-hbl-toolchain.XXXXXX")
trap 'rm -rf "$tool_dir"' EXIT HUP INT TERM
ln -s "$native_dir/toolchain-gcc.py" "$tool_dir/aarch64-linux-gnu-gcc"
ln -s "$llvm_dir/bin/llvm-objcopy" "$tool_dir/aarch64-linux-gnu-objcopy"
ln -s "$llvm_dir/bin/llvm-nm" "$tool_dir/aarch64-linux-gnu-nm"
ln -s "$llvm_dir/bin/llvm-size" "$tool_dir/aarch64-linux-gnu-size"
cat > "$tool_dir/stat" <<'SH'
#!/bin/sh
if [ "$1" = '-c%s' ]; then
  shift
  exec /usr/bin/stat -f%z "$@"
fi
exec /usr/bin/stat "$@"
SH
chmod +x "$tool_dir/stat"

export MAC2JB_HBL_CLANG="$llvm_dir/bin/clang"
export MAC2JB_HBL_LLD_BIN="$lld_dir/bin"
export MAC2JB_HBL_VULKAN_INCLUDE="$vulkan_dir/include"
PATH="$tool_dir:$PATH"
export PATH

cd "$upstream_dir"
./launcher/build.sh
python3 sdk/tools/hbx-build.py apps/hello-cpu --clean
python3 sdk/tools/hbx-build.py apps/gpu-triangle --clean
python3 sdk/tools/hbx-build.py apps/mintnes --clean
"$native_node" "$native_dir/verify-native.cjs" --all "$upstream_dir" --write-marker
