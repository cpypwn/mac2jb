# Froggy Road

A small 2D top-down, 8-bit style frog-crossing game built for
**GPUBrewLauncher**. Cross two roads, avoid the cars, and fill all five goal
pads before the timer runs out.

## Install and run

The folder is a complete launcher app package. Either copy it into the
launcher's `apps/` folder, or point the launcher at this folder's parent. Run
this from the GPUBrewLauncher project folder:

```sh
HB_APPS_DIR=/path/to/your/app-library ./start.sh
```

`./start.sh` detects the computer's LAN address. If the computer has both Wi-Fi
and Ethernet, choose the one on the console's network. Refresh the app menu
after copying or rebuilding the package.

## Controls

| Input | Action |
| --- | --- |
| D-pad | Move one cell |
| Left stick | Flick to move one cell; recentre before the next flick |
| A | Restart after a win or game over |
| B or Minus | Return to GPUBrewLauncher |

## Rules

- Start at the bottom centre and reach row 12 at the top.
- Each of the five goal pads gives 100 points plus a time bonus.
- Filling all five pads wins the round and adds 1,000 points.
- Every forward step is worth 10 points.
- Cars and the 45-second timer cost a life. Hedges block the way. You start
  with three lives.
- The best score is kept while the app is running. Returning to the launcher
  resets it, because app state is not persistent.

## Package files

| Path | Purpose |
| --- | --- |
| `app.json` | Launcher manifest: shaders, icon, state, atlas and six PCM effects |
| `shaders/app.comp` | Game logic, input, traffic, collisions, timer and scoring |
| `shaders/app.frag` | Procedural 8-bit board, sprites, HUD and overlays |
| `shaders/game.glsl` | Shared board geometry and deterministic car positions |
| `shaders/text.glsl` | Generated atlas rectangle constants |
| `assets/state.bin` | Initial 1,024-byte app state |
| `assets/font.bin` | 1024x2048 pixel-font atlas |
| `assets/icon.png` | 256x256 launcher icon |
| `sounds/*.pcm` | Raw 48 kHz stereo signed-16-bit effects |
| `assets.py` | Regenerates the atlas, state, icon and sounds |
| `build.cjs` | Builds the shaders with the shared SDK |
| `check.cjs` | Desktop compute and fragment checks |

## Rebuild

The SDK path is found automatically when this folder is inside the launcher's
`apps/` folder. From a standalone location, set `HB_SDK` to the shared SDK and
make sure `glslangValidator` and `spirv-val` are on `PATH` (or set
`GLSLANG`/`SPIRV_VAL`). If you change the atlas, icon, state or sounds, run
`python3 assets.py` first.

```sh
HB_SDK=/path/to/GPUBrewLauncher/sdk node build.cjs
```

Run the checks from the same environment:

```sh
node check.cjs
```

The check builds the launcher's desktop Vulkan helpers if needed. If this
package is outside the launcher's `apps/` folder, set
`HB_LAUNCHER=/path/to/GPUBrewLauncher`. If the Vulkan headers are in a
nonstandard location, set `HB_VULKAN_INCLUDE` and `HB_VULKAN_LINK` (for example,
`-l:libvulkan.so.1` when only the runtime library is installed).

The check renders four previews into `previews/`: `play.png`, `win.png`,
`gameover.png` and `dying.png`. It exercises the actual SPIR-V compute shader,
not a JavaScript model of the game.
