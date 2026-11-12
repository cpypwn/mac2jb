# SW2NES

A NES emulator for the Nintendo Switch 2, packaged as a `.civapp` for
[CivHomebrew](https://github.com/XITRIX/CivHomebrew). It runs the
[QuickNES](https://github.com/libretro/QuickNES_Core) core inside
CivHomebrew's browser engine, which runs JavaScript only (no JIT,
WebAssembly or WebGL). The whole emulator is therefore compiled to plain
JavaScript, and the hottest parts are hand-written JavaScript.

No game ROMs are included or provided.

## Features

- Locked 60 fps, display-synchronised presentation and integer scaling
- Two players (a second controller is detected automatically)
- 4 save-state slots per game, optional auto-load of the latest state, battery saves
- Per-game or global settings
- Aspect ratio (1:1, 8:7, 4:3, Stretch), Integer/Fit scaling, overscan crop
- CRT filters aligned to the pixel grid: scanlines (soft/normal/bold), aperture grille, scanlines + grille, LCD matrix, screen door
- Colour palettes generated from an NTSC composite decode (Default, Vivid, Natural, Warm, Soft, Greyscale)
- Face button remapping with turbo (10/15/20/30 Hz)
- Game Genie codes (on-screen editor, or a `.gg` text file next to the ROM)
- Volume and audio low-pass filter
- Favourites and recently played lists
- Stats overlay with frame-time graph

## Installing

1. In CivHomebrew, enable the FTP server.
2. Upload `sw2nes.civapp` (from a release, or built yourself) into the `Install civapp` folder. CivHomebrew installs it automatically.
3. Upload your `.nes` files into `Root/nes`.
4. Launch **SW2NES** from CivHomebrew.

Game Genie codes can also be uploaded as `Root/nes/<game name>.gg`, one code per
line with an optional description, for example `SXIOPO Infinite lives`.

## Controls

| Switch 2 | NES / app |
| --- | --- |
| D-pad / left stick | D-pad |
| A, B | NES A (default) |
| X, Y | NES B (default) |
| + / - | Start / Select |
| L + R | In-game menu (press again to close) |

All face buttons can be remapped in Settings, including turbo.

## Building

Requirements: [Emscripten](https://emscripten.org/) 3.1.74 (via emsdk), Python 3 and Node.js.

```sh
# Emulator runtime (QuickNES + bridge, compiled to plain JavaScript)
EMSDK=/path/to/emsdk ALIGN_LOWERING=1 tools/build.sh
# Package the app
python3 tools/package_payload.py --directory . --non-interactive --release 1.0.0 -o dist/sw2nes.civapp
```

`tools/build.sh` regenerates `native/cpu_lib.js` (the JavaScript 6502 core) from
`tools/gen_cpu.py`. Build options are described at the top of the script.

## Layout

| Path | Contents |
| --- | --- |
| `app/sw2nes.js` | The app: game list, settings, menus, game loop, video/audio output |
| `app/native.js` | Console access through CivHomebrew: files, controllers, live video texture, AudioOut |
| `native/bridge.cpp` | C interface between QuickNES and the app (frames, audio, states, palettes) |
| `native/*_lib.js` | Hand-written JavaScript for the 6502 CPU, pixel conversion and background rendering |
| `tools/` | Build, packaging, CPU generator, icon generator |
| `bench/` | Tests and benchmarks: browser previews (`preview*.html`), console mock, differential tests |
| `third_party/QuickNES_Core` | QuickNES with SW2NES patches (marked `SW2NES_`) |

## Testing

```sh
# Reference build (C CPU) and differential test: the JavaScript core must match
EMSDK=/path/to/emsdk ALIGN_LOWERING=1 JS_CPU=0 OUT_NAME=ref.js tools/build.sh
node bench/diff.cjs dist/runtime/ref.js dist/runtime/quicknes.js 20000 path/to/roms/*.nes

# UI tests in headless Chrome (browser preview and console mock)
node bench/ui-test.mjs /tmp/shots preview.html
node bench/ui-test.mjs /tmp/shots preview-native.html
```

The browser previews need a ROM at `bench/test.nes`, which is not included.

## Licence

SW2NES is free software under the GNU General Public License v2 (see `LICENSE`),
the same licence as QuickNES (by Shay Green / blargg; libretro QuickNES_Core).
