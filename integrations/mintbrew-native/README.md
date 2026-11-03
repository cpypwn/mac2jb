# Native HBLauncher packages

This directory contains HBLauncher ABI 3 source pinned to upstream commit
`18b4748ba98eeac7df17beb5d3418985eb74897c`. The native runtime source is
under `upstream/`. The Mac build uses Homebrew LLVM and LLD 23.1.4 plus Vulkan
headers 1.4.363.0. Its compiler wrapper targets freestanding AArch64 ELF;
no Linux runtime libraries are used for the launcher or SDK samples.

```sh
brew install llvm lld vulkan-headers
integrations/mintbrew-native/build-native.sh
integrations/mintbrew-native/build-native.sh --check
```

The build writes the launcher image to `upstream/launcher/build/` and Hello CPU,
GPU Triangle, and MintNES packages to their respective `upstream/apps/*/build/`
directories. `build-report.json` records the verified image hashes. Only the
four `code.bin`, `data.bin`, and `report.json` sets are included as prebuilt
source artifacts; the ELF and object files can be regenerated with the command
above. Building and checking an image on a Mac does not confirm that it runs on
a Switch.

The runtime scans its `apps/` directory, or the directory passed with
`--apps`. Place a user-built ABI 3 package there as one folder containing its
`manifest.json` and `build/code.bin`, `build/data.bin`, and
`build/report.json`. Check it before launch:

```sh
node integrations/mintbrew-native/verify-native.cjs --package /path/to/package
node integrations/mintbrew-native/verify-native.cjs --apps-dir /path/to/runtime/apps
```

MintNES is a native CPU port of mac2jb's earlier GPU emulator. It lists
`.nes` files supplied as package assets when the native session starts. The
bundled Diamond Chase ROM is MIT licensed; its license is in
`upstream/apps/mintnes/ROM-LICENSE`. Additional ROMs must use mapper 0, a
16 or 32 KB PRG bank and at most 8 KB of CHR ROM, with no trainer or NES 2.0
header. The menu scrolls through available ROMs and X refreshes ROMs added to
or removed from the Mac MintNES folder while the session is open. MintNES presses
NES Start once after a short loading delay unless you press Plus first. Plus is
NES Start, X is Select, and A/B are the NES A/B buttons during play. A short Minus
press returns to the ROM list, and holding Minus returns to the launcher.

[Animal Crossing](https://github.com/ravensclawx/AnimalCrossing-HBLauncher)
and [Twilight Princess](https://github.com/ravensclawx/TwilightPrincess-HBLauncher)
have separate upstream build instructions. They use HBLauncher's Linux
personality and require a patched AArch64 musl toolchain, their own build
dependencies, a running external file server, and a user-supplied supported
GameCube disc image. Their packages and game data are not bundled here. Build
each package following its upstream README, copy its package directory into
the runtime `apps/` folder, and run the package verifier above before testing.
