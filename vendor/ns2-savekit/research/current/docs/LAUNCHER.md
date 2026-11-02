# The launcher chain, as built

This is the one-page picture: what the chain is, which links are proven on hardware,
which are built but unproven, and which are blocked. Every claim points at the
measurement that supports it in [RESULTS.md](RESULTS.md); nothing here is asserted
without one. Frames are in `docs/images/`.

## The chain

```
HOME menu ──▶ SmileBASIC 4 (retail) ──▶ bootstrap (TXT:NS2) ──▶ V=START / 4-of-4
                                                                      │
                                                          promoted fsp-srv root (pid 1)
                                                                      │
                                                          write the Seedsow demo save
                                                                      │
                                        boot Seedsow demo ──▶ engine resumes save9999.dat
                                                                      │
                                                    save:/ns2jb.asb (stub) ──▶ ns2jb.lua
                                                                      │
                                      look for `main` on the SD card, verify it, report
```

Two of these links are *not* what a first reading suggests, and both are settled:

- **The HOME tile cannot be renamed.** Its name and artwork are title metadata in the
  signed control NCA (NACP), not save data. Measured: the tile reads `SmileBASIC 4`
  while the save-controlled project is `[WORKSPACE]` and the store holds `NS2` - three
  different strings, so the menu is not reading our save. No NACP was available to
  inspect, and RESULTS states that limit rather than papering over it.
- **The pickable entry that *can* be renamed is SmileBASIC's PLAYMENU card.** Measured
  on the console: `F12` -> TOPMENU -> Projects shows one card with Title and File Name
  `[WORKSPACE]` and the 40x69 gear thumbnail from `save:/f/###/META`
  (`2026-10-29-playmenu-card.png`).

## Link by link

| link | state | evidence |
| --- | --- | --- |
| Keyboard HID input into SmileBASIC | **proven** | `PRINT 1` -> `1`; the earlier "`/type` delivers nothing" was a hardcoded `/status` string, not the firmware |
| Pro Controller persona for the home menu | **proven** | `handshake:true`, `pairStep:4`, OCR-driven tile selection |
| OTA between personas, unattended | **proven** | `pro-2` and `hid-kb-1` both flashed and verified by `/status`; one runs the pad, the other types |
| Bootstrap to 4-of-4 | **proven, flaky** | 4 held roots (`uy0bDz`, `i1FuBB`, …) plus 39 earlier successes on disk; failures are canary/native-batch races |
| Promoted fsp-srv root usable by tools | **proven** | `list-apps` 9 titles, `ListAllUsers` 3 accounts, `save-pull-root` opens saves |
| `OpenSdCardFileSystem` (cmd 18) | **answered, card absent** | accepted on firmware 23.0.1 -> `result 0x320002`, no handle; a `pid`-flagged packet instead returns transport `0xf601` |
| Save write path | **proven earlier, unproven today** | the 275-file editor install and four committed writes in RESULTS; today's pulls died inside a 60-open sweep, now replaced by `--space/--type` |
| Suspend launcher runs Lua at boot | **proven** | `save9999.dat` retarget -> `save:/ns2jb.asb`, report written by the game |
| Stub -> body | **proven** | `ssslot004.ref` / `ns2jb.lua` resolution, editor slot 4 |
| `main` on SD: missing message | **built, unproven on console** | `payloads/ns2jb-launcher.lua` prints `missing main on sd card`; tested against a stub engine (13/13) |
| `main` execution with FS privileges | **not implemented** | nothing measured gives the Lua sandbox a native loader; the payload says so on screen instead of claiming it |
| Project name/artwork write | **built, unproven on console** | `tools/smb-meta.cjs` (7/7) and `payloads/ns2jb-metadata.lua` (15/15) change only the 32-byte name block on the real sample |
| Artwork chooser | **data path built, UI partial** | [ns2-assets](https://github.com/dougchansan/ns2-assets) (`artwork-build.cjs` + `ns2jb-artwork.lua`, 8/8); selection is a file, not a drawn grid, because only `dialog`/`jump` tags are proven |
| Wipe + inject, hash-verified | **built, unproven on console** | `tools/inject-launcher.sh` (backup -> build -> one write -> pull and verify), `--dry-run` exercised |

## The measured limits that shape the design

- **Project names are 11 characters.** `META` is `0x70` header + `40*69*4`; the tag
  `PCPM0005` plus a NUL-terminated UTF-16 name fill a 32-byte block that `[WORKSPACE]`
  fills exactly. `HOMEBREW` fits; `HOMEBREWLAUNCHER` does not. Writing past the block
  (`--allow-overlap`) overwrites thumbnail pixels and is marked unproven.
- **Filenames cannot contain spaces.** `SAVE "TXT:HOMEBREW LAUNCHER"` ->
  `Illegal format (SAVE:1)`; `HOMEBREWLAUNCHER` (16 characters) is accepted.
- **`sd:` is refused in-game** (`open sd:/` -> No such file, with the card out; `FILES`
  exposes only `TXT:`), so the SD check has to run from the FS root, not the sandbox.
- **Text dialogs and editor lines cap at 32 characters**, which is why payload lines
  are written short.
- **The save has ~66 MB free** and the `tmp` mount ~0.5 MB; the latter is reset by the
  cleanup step because a failed attempt leaves its extent tree inside `tmp.dat`.

## Operating rules (measured, not stylistic)

1. **One RPC session per boot.** If the session disconnects, hard-restart the console.
   A wedged application does not accept a second host: a recovered prompt answered
   `PRINT 1` and then died on the first `LOAD` (RESULTS, 17:02). The harness enforces
   this through `.harness-state.json` and exits 6 rather than starting a second host.
2. **A power cycle must be observed, not assumed.** After the 16 s hold the harness
   waits for a no-signal capture or the board reporting unmounted. If neither appears
   it says the hold did not reach the button and exits 4, because a failed hold
   recorded as a fresh boot is what would let rule 1 be broken by accident.
3. **One save operation per attempt** where possible, and never `--keep-open`: leaving
   a save mounted breaks the next session.
4. **Back up before every write**, and verify by hash after - `inject-launcher.sh`
   is ordered that way for that reason.

## What is blocked, and on what

| blocker | consequence | owner |
| --- | --- | --- |
| The fingerbot does not reach the power button | the console is wedged in a native call and cannot be power-cycled; no save work is reachable | operator: reseat the arm |
| No microSD Express card inserted | cmd 18 cannot return a filesystem, so "`main` on SD" cannot be exercised end to end | operator: insert a card |
| Stage 2 qualifies only sometimes | each attempt costs a boot; the repeat-after-qualification is now pinned to the qualifying offset (unproven) | next session |
| No drawing/input API known for the engine | the chooser selects from a file instead of a grid | future: probe the engine's tags |

## The order the next session should run in

1. `node ~/ns2-console/tools/harness.cjs full --after 'node tools/save-pull-root.cjs "$RUN" 010042d022aea000 … --space 1 --type 1'`
   - the backup is the first save operation, because everything else can be redone
   from it.
2. `tools/inject-launcher.sh <run>` - build, write, pull and verify.
3. Boot the demo: the launcher runs and reports `missing main on sd card` (with a card
   present, it reports invalid/verified instead).
4. Read the host save's `META`, apply a chosen name and artwork, and check the PLAYMENU
   card - the rename that is actually available.
