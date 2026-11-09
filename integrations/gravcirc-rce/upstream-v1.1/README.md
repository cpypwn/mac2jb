# Gravity Circuit Switch RCE

Userland code execution on Nintendo Switch through Gravity Circuit save data.

The save replaces the game's entry point with a networked Lua REPL and FTP server.
No cartridge modification, no romfs patches, no title update needed.
The exploit runs entirely in userland through the game's own LuaJIT runtime and SDK.

![Screenshot](docs/screenshot.jpg)

## What this is

**A proof of concept, not a product.** This is a research and instrumentation tool
that demonstrates save data exploitation in LÖVE engine games on Nintendo Switch.

- Verified on Switch 1 hardware (Gravity Circuit v1.0 and v1.2.1, title `01008D9019128000`)
- Supports both Gravity Circuit v1.0 and v1.2.1 (the current eShop update). The
  launcher selects the right offset profile at runtime by matching the code
  signature of `love.graphics.present`, so both builds work from the same save
- Should work on Switch 2 as well, since the vulnerability is in the game's runtime,
  not the console firmware. I haven't been able to test it because I don't have access
  to a Switch 2, but there's no technical reason it wouldn't work if the save data
  can be transferred (e.g. via Nintendo's official save transfer)
- Userland only, does not bypass DRM, does not modify game files
- Entirely based on [balatro-switch-rce](https://github.com/Luminger/balatro-switch-rce)
  by Luminger, we adapted their JankFFI gadget chain and architecture for a different game

## Why this works

Gravity Circuit is a [LÖVE](https://love2d.org/) game. LÖVE uses PhysFS to mount
directories into a virtual filesystem. When the game calls `love.filesystem.setIdentity()`
with `appendidentity = false`, the save directory is **prepended** to the search path.

This means any file placed in the save directory shadows the game's own version:

```
Search order:  save:/.Gravity Circuit/  →  game romfs
               ↑ our main.lua wins
```

Since `conf.lua` is loaded before the save is mounted, it cannot be shadowed — but
`main.lua` can, and that's all we need.

## What you get

- **Status console** — on-screen overlay showing boot log, resolved addresses, and service status
- **RPC** on TCP `9026` — networked Lua REPL (use `tools/rpc.py`)
- **FTP** on TCP `5000`/`5001` — read/write access to the LÖVE virtual filesystem
- **Savedata log** — `gc_log.txt` in the save directory
- **Native call support** — full-ABI AArch64 calls via JankFFI gadget chain

### Native call chain

On Switch, LuaJIT's `ffi.C` and `ffi.load` do not work (no `dlsym`).
Native SDK calls are dispatched through a gadget chain adapted from
[balatro-switch-rce](https://github.com/Luminger/balatro-switch-rce):

```
BC_FUNCC hijack → thunk → launder → fiber_switch → ctx_restore → capture gadget → fiber_switch back
```

Module bases are resolved at runtime:
- `jit.util.funcinfo(love.graphics.present).addr` anchors the main binary
- GOT memcpy entry resolves the SDK base
- Both confirmed via MOD0 magic bytes

All offsets are in `src/gc/offsets.lua` (SDK 14.3.1.0).

### Supported builds

| Game version | Title version | `present` | `got_memcpy` | SDK module |
| --- | --- | --- | --- | --- |
| 1.0.0 | v0 | `0x239360` | `0x51a6e8` | 14.3.1.0 |
| 1.2.1 | v655360 | `0x289c40` | `0x54d9e0` | 14.3.1.0 (byte-identical NSO) |

The SDK module did not change between these two builds, so only the main-module
anchors differ. `resolve.lua` tries every profile for the running game and picks
the one whose `present_head` code signature matches. Adding support for another
update only needs a new profile in `offsets.lua`.

### LuaJIT build defects

The Switch build of LuaJIT 2.1.0-beta3 has the same defects documented in
[balatro-switch-rce](https://github.com/Luminger/balatro-switch-rce):
`lj_vm_ffi_call` linked onto padding, broken 64-bit literals, broken cdata equality,
and fatal metatype Lua metamethods. The gadget chain works around all of these.

## Build

```sh
python3 build.py -o GC-v1.1.zip
```

This generates the JKSV metadata (`.nx_save_meta.bin`) and packs the full
archive — no exported save or account data needed. The ZIP is ready to
copy to `JKSV/Gravity Circuit/` and restore.

## Install

The release ZIP is ready to import with JKSV, no extra steps needed:

1. Download the latest release ZIP from the [releases page](https://github.com/figurophobia/GravCirc-Switch-rce/releases)
2. Copy it to `JKSV/Gravity Circuit/` on the SD card
3. Open JKSV, select Gravity Circuit, restore from the ZIP

⚠️ **The restore replaces the current Gravity Circuit save.**

<details>
<summary>Building the ZIP yourself</summary>

```sh
python3 build.py -o GC-v1.1.zip
```

The script generates the JKSV metadata (`.nx_save_meta.bin`) automatically,
runs syntax checks, and packs everything into a ready-to-import archive.
No Switch, no exported save, no manual steps needed.

</details>

## Live use

```sh
# RPC — execute Lua on the console
python3 tools/rpc.py <console-ip> 'return 2+2'

# FTP — browse the virtual filesystem
curl --disable-epsv ftp://<console-ip>:5000/
curl --disable-epsv ftp://<console-ip>:5000/gc_log.txt
```

RPC and FTP are unauthenticated and unencrypted. Use on a trusted network only.

## Other LÖVE games

The save shadowing vulnerability affects any LÖVE game that uses `appendidentity = false`.
We have confirmed the same entry vector works on **Kingdom Rush** (LÖVE 0.10.2) on PC,
but Switch offsets and gadget adaptation are still in progress. The architecture is
designed to support multiple games through per-game offset tables in `offsets.lua`.

## Acknowledgements

This project is **heavily based on** [balatro-switch-rce](https://github.com/Luminger/balatro-switch-rce)
by [Luminger](https://github.com/Luminger). The JankFFI dispatch chain, BC_FUNCC hijack
technique, module resolution strategy, FTP server, RPC protocol, and overall architecture
were all developed by Luminger for Balatro. We adapted their work for Gravity Circuit
(different SDK version, different offsets, different gadget byte patterns) and confirmed
that the same class of vulnerability exists across multiple LÖVE games on Switch.

Without balatro-switch-rce, this project would not exist. Full credit to Luminger
for the original research and implementation.

## Legal

This software is provided for educational and research purposes. Use of this software
may violate Nintendo's terms of service and can get a console banned.

## License

GPL-3.0 — see [LICENSE](LICENSE).
