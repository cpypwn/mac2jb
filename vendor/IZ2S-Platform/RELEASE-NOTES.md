# IZ2S Platform 0.16.0-rc.5

## What’s new in 0.16.0-rc.5

- Fix the empty module library in **IZPSlauncher**. The native process previously rejected every package requiring IZlauncher because it compared the module-format name with the new visual shell ID.
- IZPSlauncher now explicitly declares the IZlauncher module format it implements. The panel, startup selection and native library evaluate the same selected-shell contract; host and console-ABI checks remain enforced.
- Add regression checks that reproduce the native IZPSlauncher environment, publish a nonempty console picker and complete a browser-queued load through the package/catalog boundary using local mock storage.

## Download and install

Download **iz2s-platform-0.16.0-rc.5-file-exchange.tar.gz** and its `.sha256` file from this release. The automatic Source code archives are snapshots, not the prepared installation package.

```sh
sha256sum -c iz2s-platform-0.16.0-rc.5-file-exchange.tar.gz.sha256
tar -xzf iz2s-platform-0.16.0-rc.5-file-exchange.tar.gz
cd iz2s-platform
./install.sh --check
./install.sh
```

The installer creates a new versioned directory and prints its location. Start that installed copy with `start.sh` or its application shortcut. Existing settings and module installations are not overwritten; follow the FAQ when migrating an earlier installation.

Debian/Ubuntu and Arch-based Linux are supported by the installer. Linux x64 software/build/install checks passed. ARM64 remains a declared target with incomplete hardware validation. Windows and macOS are unsupported. The new IZPSlauncher shell was checked with desktop Vulkan; a physical Switch check has not been performed for this release.

Includes IZlauncher, IZPSlauncher, the IZMYSH engine and File Exchange. pepsipu and kurumuz remain explicit separate downloads in the panel. BlitBun and VacooTube remain separate module projects.

## Build from source

```sh
git clone https://github.com/byizmysh/IZ2S-Platform.git
cd IZ2S-Platform
git checkout v0.16.0-rc.5
node shells/izpslauncher/build.cjs
node shells/izlauncher/server/build-app.cjs
node distribution/verify.cjs
node --test distribution/tests/*.test.cjs
# Package a clean committed source tree:
node distribution/build.cjs
```

Requires Node.js 22+, Python 3/Pillow, DejaVu Sans, glslangValidator, spirv-val and the Linux dependencies listed in the installation guide. Review and commit changed generated assets before creating an archive; the builder records the source commit and refuses a dirty tree.

Read [README](README.md), [FAQ](FAQ.md), [support details](SUPPORT.md) and [development/testing guide](distribution/README-development.md). Component licenses and existing notices are retained; see LICENSE, LICENSE-SCOPE.md and THIRD_PARTY.json.
