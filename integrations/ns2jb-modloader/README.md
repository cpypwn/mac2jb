# ns2jb-modloader

Load **RomFS and ExeFS mods by Title ID** on Switch 2, directly from microSD.

Requires a microSD or microSD Express card and an existing [ns2jb](https://gitlab.com/kurumuz/ns2jb) **FS 4/4 session with RPC running**.

[Download](https://github.com/SebaaMG/ns2jb-modloader/releases/latest) and extract the ZIP on your PC.

**Mod compatibility:** Some older Switch 1 ExeFS mods need updates for games that changed from 32-bit to 64-bit, such as Mario Kart 8 Deluxe. Most Switch 1 games were already 64-bit. RomFS mods may still work if the game's file formats and paths are unchanged.

**PC:** Linux/WSL and Node.js 22+ (the runtime used for ns2jb).

## 1. Add your mods

Copy the contents of `sd-card-root/` from the extracted ZIP to your SD card root. This creates `SD:/ns2jb-modloader/contents/`.

*You can drag and drop your Atmosphère `contents` folder into `SD:/ns2jb-modloader/` (as long as your mods are compatible).*

To add a mod manually, put its `romfs/` and `exefs/` folders under **`SD:/ns2jb-modloader/contents/<TITLE_ID>/`**, using the game's 16-digit Title ID. If included, copy `exefs_patches/` beside `contents/`. You can have mods for several games together:

```text
ns2jb-modloader/                     # On the SD card root
├── contents/
│   ├── 0400c3f00006e000/              # Mario Kart World
│   │   └── romfs/
│   │       ├── System/              # MOD 1 - 200cc
│   │       │   └── GymlArchive/
│   │       │       └── ...200cc files...
│   │       ├── Model/               # MOD 2 - character model
│   │       └── Tex/                 # MOD 2 - model texture
│   └── ...other game's Title ID.../
│       ├── romfs/
│       └── exefs/
└── exefs_patches/                    # If included with the mod
    └── ...patch name.../
        └── <BUILD_ID>.ips
```

Combine each game's mods in the same `romfs/` or `exefs/` folder. One installation handles all included games.

For example, if you want to install the 200cc mod for Mario Kart World and the download contains `200cc/romfs/System/GymlArchive/`, copy its `romfs/` folder into `SD:/ns2jb-modloader/contents/0400c3f00006e000/`. Keep the paths inside `romfs/` unchanged.

`exefs/` contains complete files such as `main` or `subsdk0`. IPS/IPS32 patches go in `exefs_patches/<PATCH_NAME>/<BUILD_ID>.ips`; keep their filenames unchanged.

## 2. Load your mods

With the **SD card inserted in your Switch 2** and **FS 4/4 verified and RPC running**, keep the ns2jb host open. Open another terminal and run these commands, replacing the example path with the path to the extracted `ModLoader/` folder:

```sh
cd "/path/to/extracted/zip/ModLoader"
node load.cjs
```

The loader detects the active session and loads all mods from the SD. Wait for **READY**, then continue to step 3.

## 3. Open your games

Once the installer says **READY**:

1. Stop the terminal running the ns2jb host with **Ctrl+C** and let ns2jb finish cleanup.
2. Close SmileBASIC **without restarting** the Switch 2.
3. Open any of the games whose mods you installed.

Keep the microSD inserted. You can disconnect the PC and switch between modded games; the loader stays active until the console reboots.

## Notes

- **Formats:** RomFS replacements, new files/directories and `romfs.bin`; ExeFS files, `.stub`, `exefs.nsp` and IPS/IPS32 patches. Runtime cheats/plugins need a separate runtime.
- **Session selection:** If automatic detection is unavailable, use `node load.cjs --run-dir "/path/to/ns2jb/runs/switch2-SESSION"`.
- **Rebuilding from source:** `node tools/build.cjs` requires Zig 0.15.2. The release includes the built components; Python is only needed for the developer checks in `native/verify.py`.
- **Cards:** Regular microSD tested on firmware 23.0.1. microSD Express uses the same filesystem interface but still needs hardware testing.
- **Sessions:** Install once per boot. After a failed native operation, reboot before trying again.

Game assets, firmware, keys and mods are not included. [GPL-2.0](LICENSE).

**Credits:** [pepsipu](https://gitlab.com/pepsipu/ns2jb), [Kurumuz](https://gitlab.com/kurumuz/ns2jb). Bundled game-mount helpers adapted from [IZ2S / OunceCake](https://github.com/byizmysh/IZ2S-Platform), with installed ELicense handling from [Cellenseres/OunceCake](https://github.com/Cellenseres/OunceCake) (GPL-2.0; see `lib/game-files/COPYING`). ZBIC decompression uses [Atmosphère's Zstandard fork](https://github.com/Atmosphere-NX/Atmosphere/blob/6b0c077b4c608a3a2ee712b8dc35fee87ceb62e8/libraries/libstratosphere/source/util/zstd.inc), bundled under GPL-2.0 in `native/vendor/zstd/`. No separate OunceCake download is required.
