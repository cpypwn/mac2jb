# Results

The save-kit part of the hardware log: save access, editor install, the
launcher in the save, metadata, and restore. The full log, including the
controller and harness work, is in
[ns2-console](https://github.com/dougchansan/ns2-console/blob/main/docs/RESULTS.md).

Everything here was run on a retail Switch 2 (system software with the microSD
Express support update, item 3 = **(B)**) against the installed Seedsow Lullaby
demo (`010042d022aea000`) and full game (`0100ee5021c9e000`), plus Nintendo
Switch Sports Resort (`04008e001f098000`). Nothing was emulated.

## Save access

| Action | Observed |
| --- | --- |
| Enumerate installed titles over the held session | 9 applications, `BuiltInUser` |
| Open a save that does not exist yet | `0x7d402` for all 3 accounts × 4 spaces × 2 types |
| Open an existing save | `space=User type=Account uid=539fd277…3664 -> ok` |
| Pull full game save | 70 files, 1,993,280 bytes |
| Pull again later (state changed) | 73 files, 2,021,377 bytes |
| Pull demo save after first launch | 9 files, 183,959 bytes |
| Pull save with 275 installed files | 275 files, 4,511,900 bytes |

`0x7d402` is the "no save data" answer, not "in use": a title that has never been
launched reports it for every combination, and it changes to `ok` once the game
creates its save.

## Save launch (Lua inside the game)

Payload v1, installed with the caret retarget `system/ui.asb` → `save:/ns2jb.asb`,
command index `4` → `1`, six event-handler names cleared. Boot produced a **black
screen**, and the pull afterwards returned:

```
/ns2jb-report.txt (1155 bytes)
/save9999.dat     (23367 bytes)   ← still present, not consumed
/ns2jb.asb        (3887 bytes)
```

Report contents (abridged):

```
ns2jb=Lua from save data is running
lua=Lua 5.1
io=table os=table debug=table package=table
os.execute=function io.popen=function debug.sethook=function package.loadlib=function
s.savepath=save:
s.datapath=game:
engine.type=userdata  engine.mt.__index=function
```

So: arbitrary Lua in the shipping game, entered from a save file, with the
engine's own handle. `save9999.dat` surviving means the launcher is not one-shot —
the engine's delete step only runs on its internal suspend path.

Payload v2 added capability probes and an exit through
`jump system/first.iet label="title"`. Boot: black, then **the title screen came
back** — the script ran and handed control back cleanly. Report (968 bytes):

```
open game:/                 -> ok (mount resolves; read returns nil)
open game:/system/init.lua  -> No such file
open save:/ns2jb.asb        -> ok  head="ASB\0\0…"
open sd:/                   -> No such file      (card out)
open /                      -> Invalid argument
open save:/../saveg.dat     -> No such file      (traversal normalised away)
os.execute('true') -> 0     io.popen -> 'popen' not supported
```

Conclusion: full Lua 5.1 with save write, no shell, no `sd:`, no traversal.

## Editor install (third-party save, no JKSV)

`Seedsow-Lua-Editor-Save.zip` v0.1.2 installed into the demo save with
`save-write-stage.cjs`: **275 files, 4,511,900 bytes, 9 replaces, 266 adds**, one
commit, read back and compared:

```
missing []   extra []   hash mismatches []   4,511,900 bytes
```

Then booted and loaded **slot 1**: the editor appeared, with
`Slot 4 sscode004.lua | 85 bytes | TEXT INSERT | Guard ON` and
`Ready. Choose slot 4-120; Save + publish makes it loadable after restart.
Airplane mode is fine.`

That is the released artifact running from a save we installed through our own
write path — no Switch 1, no JKSV, no Nintendo save transfer.

## Game dump (same held session)

OunceCake attached to the running session and mounted `base` + update `65536`
while the FS endpoint stayed live. Mirrored over FTP at ~7.5 MiB/s (74 MiB/s for
the small exefs):

| scope | files | size | manifest sha256 |
| --- | --- | --- | --- |
| whole tree | 95,987 | 20 GB | `76984046eb9721c8…` |
| `base/romfs` | 47,393 | 9.8 GB | `11a6487146b63786…` |
| `base/exefs` | 9 | 59.7 MiB | `67579bde2dfe52f7…` |
| `updates/65536/romfs` | 48,576 | 9.8 GB | `fa64d245cc0edccf…` |
| `updates/65536/exefs` | 9 | — | `41e479786dac1054…` |

## Untethered boot launcher in the demo save

Installed into `010042d022aea000` in one transaction, all four files verified
against a fresh backup before replacement and hashed back after the commit:

| file | bytes | sha256 (prefix) | role |
| --- | --- | --- | --- |
| `/ns2jb.asb` | 1946 | `f800caa253ec0c3a…` | stub: runs the slot-4 program, else `ns2jb.lua` |
| `/save9999.dat` | 27917 | `f19634f017d17b54…` | suspend launcher: `system/script.asb` #42 → `save:/ns2jb.asb` #1 |
| `/ns2jb.lua` | 1344 | `950fbade47f814af…` | body (fallback path) |
| `/sscode004.lua` | 1344 | `950fbade47f814af…` | body as editor slot 4 (`ssslot004.ref` names it) |

`commit -> 0x0`. The stub resolves its program through `ssslot004.ref`, so the
editor owns the loop: Choose slot 4, edit, Save + publish, restart.

## Console authoring limits and the editor's save path

The engine's text-entry dialog returns **at most 32 characters per entry**, and
the editor passes `textfieldsize='2048'` in vain. `Edit line` therefore replaces
a line with at most 32 characters and silently truncates longer ones, which is
why the payload is written with every line <= 32 characters.

The editor's own storage sequence was observed end to end: after one `Save file`
the save contained

```
ns2jb.lua      1142   (the saved edit)
ns2jb.lua.bak  1197   (previous version, kept for Restore .bak)
ns2jb.lua.new  1142   (staging copy, left behind)
```

so console-side saves do complete, and a bad save has a one-generation undo.

## SD card is not reachable from the game

With the microSD **inserted**, boot-time Lua reported:

```
sd no
sdw no
```

The game's VFS exposes `save:` and resolves `game:`, but not `sd:`. There is no
file channel to the card, so payload output cannot leave the save without an
exploit session (or the screen).

## One save operation per boot

The promoted-root save path crashes the host application with `2162-0002` often
enough that the toolkit assumes one save operation per boot: a pull, a write or a
delete, then restart the console. Two read-only opens in the same boot are enough
to trigger it (observed twice, most recently on a second `--list-only`).

`kit.cjs` prints that reminder after every operation it performs. It is not a
limitation of any single action - the same list runs fine as the first operation
of a boot - so the listing feature stays; the rule is what keeps it reliable.

## Measured: more than one operation per boot does work

The one-operation-per-boot rule is a risk heuristic, not a limit. Measured in a
single boot, back to back, with no restart between:

| step | operation | outcome |
| --- | --- | --- |
| 1 | `save-pull-root` (backup) | 289 files, 4,651,736 bytes |
| 2 | `save-write-stage` (payload install, one commit) | replace checks passed, committed |
| 3 | `save-pull-root --list-only` (verify) | listed 289 files; `ns2jb.asb` 1946, `save9999.dat` 28405 |

The session stayed `ready` throughout and reported 72,872 calls afterwards. So
three save operations in one boot succeeded here, where two had failed earlier the
same day (one of those with `--keep-open`, which left the previous session alive
and broke the *next* one at its first IPC).

What that means for the rules in the README: a restart between operations is
advice, not a requirement - it lowers the chance of the host dropping, but the
drop is probabilistic, not per-operation. `--keep-open` is still wrong: leaving a
session alive is what reliably breaks the next one.
## Failure modes observed (worth knowing before you try)

| Symptom | Cause | What fixed it |
| --- | --- | --- |
| `0x7d402` on every space/type | title has no save data, or the app is holding it | launch the game once; close it fully |
| `2162-0002` host crash | promoted-root save operation, ~3 in 5 attempts | one save op per boot, restart after |
| `FS acquisition did not complete` (console response timeout at stage 2/4) | app not freshly opened, or SD card inserted (changes the FS save allocation) | console restart, SD card out, fresh SmileBASIC |
| `find-metadata failed: No candidate reproduced the external allocator link` | timing-sensitive allocator state | console restart and retry |
| `Directory exceeds the 64/256-entry probe limit` | tool-side list cap, not a console fault | raised to 2048 entries |

## What these results do not prove

- Writes were verified by reading the committed bytes back, not by observing the
  game accept them in every case. Where the game did consume them (editor slot 1,
  suspend boot) that is stated.
- File hashes from the dump are local integrity hashes; FTPS here has no per-file
  digest, only a `SIZE` comparison per file.
- The offline tests in `tests/` cover encoders and manifest logic. They are not
  evidence about console behaviour.

---

# Next steps: untethered

# Next steps: untethered

"We are untethered" means: the game runs our code at boot, and we can change that
code, without SmileBASIC, an RPC session, or a PC in the loop. We are already
half-way there, and the remaining half is smaller than it looks.

## What already survives without the exploit

`save9999.dat` + `save:/ns2jb.asb` are ordinary files in the save. The engine
looks for the suspend slot at every boot (`save_prefix="save"`,
`save_suspend=9999`) and resumes it, so **every launch of the game runs our Lua
with no exploit present**. Verified: after a boot that ran the payload, the
launcher file was still there and still pointed at `save:/ns2jb.asb` — the
engine's delete-after-load step only runs on its own `suspend_load` path, which a
retargeted caret bypasses.

So the console no longer needs SmileBASIC to *execute* anything. What still needs
it is everything that moves bytes across the boundary:

| Still tethered | Because |
| --- | --- |
| editing the payload | `ns2jb.asb` is written from the Mac by `save-write-stage.cjs` |
| reading the payload's output | `ns2jb-report.txt` is pulled over fsp-srv |
| re-arming after a game update | the launcher blob is generated on the Mac |

Each of those has a console-only replacement.

## 1. Split the launcher into a stub and an editable body

Today `ns2jb.asb` embeds the whole payload, so changing behaviour means rewriting
the ASB from the Mac. Make it a stub that reads a Lua file and runs it:

```lua
function ns2jb_boot(engine)
  local base = engine:var("s.savepath")
  local file = io.open(base .. "/ns2jb.lua", "rb")
  if not file then return end
  local source = file:read("*a")
  file:close()
  local chunk = loadstring(source, "@" .. base .. "/ns2jb.lua")
  if chunk then pcall(chunk, engine) end
end
```

`ns2jb.lua` is not on the editor's protected list (`ssedit*`, `ssseed*`,
`ssboot*`, `ssethumb`, `sed01–03.`, `ssNNN.asb`), so the editor can write it with
**Save file** or **Save + publish**. That closes the authoring loop: edit on the
console, restart the game, code runs. The stub itself then never needs to change.

## 2. Output on screen instead of in a file

The reason our dialog never appeared during the first launch was that the
suspend-resume path restores a script position, not a drawn scene — nothing had
built the UI. That is no longer true once the editor or the title screen is up.
Have the payload end with a dialog (and keep the `jump system/first.iet
label="title"` fallback), so results are read on the TV instead of pulled.

If a file is still wanted, write it as Lua comments into a slot the editor can
open (`sscodeNNN.lua`) — the editor displays it with no PC involved.

## 3. Re-arm from the console

Re-arming is a byte copy, not a parse: keep a prebuilt retargeted blob in the
save (say `ns2jb-seed.bin`) and have the payload copy it to `save9999.dat`:

```lua
local src = io.open(base .. "/ns2jb-seed.bin", "rb"); local data = src:read("*a"); src:close()
local dst = io.open(base .. "/save9999.dat", "wb"); dst:write(data); dst:flush(); dst:close()
```

`io.open(..., "wb")` on `save:` is confirmed working from inside the game, so a
game update that removes the suspend file no longer costs an exploit session.

## 4. Keep both launchers

The editor's slot mechanism (`save0001.dat` → `save:/sed01.asb`) and our suspend
slot are independent. Keep them both: if a title update changes one, the other
still lands. The editor also gives a third thing we did not have — a way to run a
program **on demand** rather than only at boot.

## 5. Then the native work, still PC-free

With a self-updating boot payload, native-code experiments stop costing exploit
cycles. The v3 payload already sketches the loop: mutate a pluto blob, call
`unpersist`, flush a line per case, and guard against boot loops with a marker
file that disables the risky block after a crash. Once an input kills the
process, the same mechanism persists it for the next boot.

The remaining thing that genuinely wants the exploit is bulk exfiltration —
pulling multi-megabyte dumps off the console. OunceCake over FTP does that well
while a session is held, and it is not needed for anything else.

## Order I would do it in

1. Stub + `ns2jb.lua` loader (one exploit session to install, then never again).
2. Dialog output over a live UI (no session).
3. Seed blob + re-arm (no session).
4. Re-run the pluto fuzz from the boot payload and read the result on screen.
5. Only then spend console time on the malformed-BOWS/pluto native targets.

## Why a second save operation can drop the session (investigation)

Symptom: the first save operation of a boot usually succeeds; a second one often
ends with the host application reporting 2162-0002, or with `console response
timed out`.

What we can rule out: it is not the command interface (the correct commands and
shapes are proven - see the save-info reader numbers above), and it is not the
title or the space (every space behaves the same). What is left is the *lifetime*
of what we open:

1. each tool opens a save filesystem through the promoted root, then closes it;
2. each tool creates a session process and then calls cleanup, which tears down
   the handles it owns;
3. the promoted root itself lives in the exploited process, so anything that
   invalidates its handles affects the next operation.

`save-pull-root.cjs --keep-open` exists to tell those apart: it leaves the save
mounted and skips cleanup, so the next operation runs against a session that was
never torn down. Comparing `--keep-open` against the default across boots is the
experiment: if the second operation survives with `--keep-open`, the teardown is
what kills the session, not the save open itself, and the fix belongs in our
close/cleanup path rather than in the exploit.

---


---

*The sections between here and the next heading are controller/harness work, kept in the [full log](https://github.com/dougchansan/ns2-console/blob/main/docs/RESULTS.md).*

## NSO verification is implemented and tested (host side)

`tools/nso-verify.cjs` parses the header per switchbrew's NSO0 layout, checks magic,
version, reserved word, unknown flags, section file ranges (in order, non-overlapping,
inside the file), page-aligned memory offsets, module name at 0x100, and then LZ4
decompresses each compressed section and compares its SHA-256 with the hash in the
header. Section layout is confirmed by arithmetic on the real files:

```
main: text 0x108+0x1786d9 = rodata 0x1787e1; +0x98584 = data 0x210d65; +0xfbb5 ≈ 0x220d5a = filesize
```

Measured on three genuine exefs segments: `main` (module `Artemis`), `rtld`
(`nnrtld`), `sdk` (`nnSdk`) - **all three section hashes verify**, which is what
proves the LZ4 decoder rather than assuming it. `tests/test_nso_verify.cjs` builds
an uncompressed NSO, then corrupts it four ways; 13/13 pass:

```
synthetic uncompressed NSO passes           flipped byte in real NSO -> exit 3
text offset inside the header -> exit 3     truncated real NSO -> exit 3
data past EOF -> exit 3                     missing file -> exit 4 (not 3)
zeroed text -> exit 3                       --no-hash still checks structure
```

One real anomaly: the demo's `main` declares `bss = 0x22010c70` (~571 MB) while
`rtld` and `sdk` declare small bss. bss is not page aligned in any of them, so
alignment is only a note; 571 MB is large enough to be worth a second look, but the
file's hashes are intact, so the header is self-consistent.

## SmileBASIC program metadata: what is where

The prompt pointed at `saves/all/Seedsow-Lullaby-demo/f/###/META`; that path does not
exist. The SmileBASIC 4 save is a separate title (`saves/all/SmileBASIC-4-demo/`)
and contains exactly five files:

| file | size | content |
| --- | --- | --- |
| `f/###/META` | 11152 | header + name + thumbnail (below) |
| `f/###/TNS2` | 2986 | the `TXT:NS2` program (our bootstrap) |
| `f/###/T@BACKUP.TXT` | 2960 | `TXT:@BACKUP.TXT` |
| `config.dat` | 4416 | `c4BS` magic, then 64-byte-ish tool entries `#TOOL/SBSMILE.PRG`, `#TOOL/GAHAKU.PRG` |
| `tag.dat` | 14004 | **100% zero except one byte** - no tags set |

`META` is exactly `0x70 + 40*69*4 = 11152` bytes, and the 11040-byte tail renders a
crisp 40x69 32-bit gear-smiley icon (any other width/start gives a sheared image).
But the same offset 0x70 holds the UTF-16 text `PCPM0005` + `[WORKSPACE]`, and the
program list on screen does show `[WORKSPACE]` in the bottom-left of direct mode. So
the name bytes and the pixel data overlap, and one of two readings must be true:

1. the file is `0x70` header + `PCPM0005` + name + pixels, and the "crisp icon" is
   the icon area starting later than 0x70; or
2. the icon really starts at 0x70 and the name is painted into its first pixels.

Neither has been proven, and the prompt's "look at the files and mutate a backup" step
is exactly the experiment that settles it: rename the workspace on the console, pull
the save, diff `META`. That needs a live session and is the next metadata step.

## Name and artwork on the HOME MENU are not reachable from a save

This is the claim the mission asked to settle before promising anything, and the
answer is the pessimistic one:

- the tile's name and artwork on the HOME menu are metadata of the **title**, in its
  control data (the NACP inside the signed control NCA). Save data is a separate,
  writable archive; nothing in it is consulted for the tile;
- observed on this console: the HOME tile reads **`SmileBASIC 4`**, while the
  save-controlled workspace name is **`[WORKSPACE]`** and the store contains `NS2`.
  Three different strings - the menu is not reading our save for the tile;
- no NACP was available in this session to inspect directly (the exefs/romfs dumps on
  the host contain no control NCA), so the NACP statement rests on the platform
  layout plus that observation, **not** on a failed rename attempt.

Therefore the launcher entry that can honestly be renamed is the **program/project
entry inside SmileBASIC** (its name and thumbnail, in the save), or the Seedsow save's
own launcher path - not the HOME tile. No home-menu rename is claimed anywhere in
this repository.


---

*The sections between here and the next heading are controller/harness work, kept in the [full log](https://github.com/dougchansan/ns2-console/blob/main/docs/RESULTS.md).*

## SmileBASIC `META`: the name is 32 bytes inside the thumbnail

`META` is `0x70` header + `40*69*4 = 11040` bytes. The thumbnail is BGRA at `0x70`
(verified pixel-for-pixel against an independent decoder: 0 differing pixels), and
the file's first pixels are literally the metadata:

```
row 0, pixels 0..7:  50 43 50 4d | 30 30 30 35 | 5b 00 57 00 | ...
                     "PCPM"       "0005"        "[W"
```

So the layout is: 8-byte tag `PCPM0005` + a **NUL-terminated UTF-16 name, filling a
32-byte block** at `0x70..0x8f`, which overlaps the thumbnail's first 8 pixels (a
black margin, so nothing is visibly lost). `[WORKSPACE]` is 11 characters = 22 bytes
+ NUL = 24, exactly filling the block after the tag.

Consequences, stated as what is measured and what is not:

- measured: the name occupies at most 32 - 8 = 24 bytes, i.e. **11 characters plus
  NUL** in this sample, and the `[WORKSPACE]` label is what direct mode draws;
- not measured: whether the engine reads the name to the NUL (variable length) or to
  a fixed 32-byte boundary. **"Homebrew Launcher" (17 characters) does not fit the
  observed block**, so the launcher name will have to be shortened (e.g.
  `HOMEBREW`) unless a rename experiment shows the field grows;
- the experiment that settles it is: rename on the console, pull the save, diff
  `META` (`node tools/smb-meta.cjs diff old new`). It needs a live session.

`tag.dat` is 14003 zero bytes out of 14004, so no tags exist to carry a name;
`config.dat` is a `c4BS` list of tool programs (`#TOOL/SBSMILE.PRG`,
`#TOOL/GAHAKU.PRG`), not the program list.

## Payload v1 exists, and refuses to lie about execution

`payloads/ns2jb-launcher.lua` + `payloads/nso-verify.lua` implement the part of the
launcher the sandbox can actually do, and say so on screen:

| condition | dialog |
| --- | --- |
| no `sd:` at all (measured on this console) | `missing main on sd card` + `sd: not available in this sandbox` |
| `sd:` present, no `main` | `missing main on sd card` + `file not found` |
| `main` is not an NSO0, or is truncated | `invalid main on sd card` + the reason |
| `main` passes the header checks | `main verified: <module>` + sizes + `execution needs FS privileges - not done` |

It does **not** execute `main`, and the dialog says so: execution needs a native
loader with FS privileges, nothing measured gives the Lua sandbox one (io yes,
io.popen no, `sd:` refused, no native load proven), and the escalating step lives in
the BASIC bootstrap which needs a host. A payload that claimed to run `main` from
Lua would be reporting something that has not happened.

Offline tests (`lua tests/test_payload_lua.lua`, 13/13) drive the launcher against a
stubbed engine and filesystem, and run `nso-verify.lua` against the demo's real
`main`: structure accepted, `contentsVerified = false` (no LZ4 in the sandbox), and
the launcher's dialog says `contents not hashed`.


---

*The sections between here and the next heading are controller/harness work, kept in the [full log](https://github.com/dougchansan/ns2-console/blob/main/docs/RESULTS.md).*

## 2026-10-29 later still: the launcher entry is the PLAYMENU card, and names have rules

Done on the console in direct mode, with no exploit session: F12 opens TOPMENU,
`Projects` (up twice, A) opens the **PLAYMENU**, which is the list a user picks a
program from. Frame `2026-10-29-playmenu-card.png`.

```
PLAYMENU   [Local] Samples Published Works Public Key
  card: gear icon  [WORKSPACE]        (title)
        [WORKSPACE]                   (file name)
        2026.10.22 14:52:51  size 20275
  right: Title [WORKSPACE] / File Name [WORKSPACE] / User Name / Details / Tag
  footer: A Hold for Submenu   - Display Files   B Back   A/+ Run
```

So the thing that can honestly be renamed is **this card**: its Title, its File
Name and its geometry come from the project's save metadata (the `META` name and
its 40x69 icon), and it is what "launching from the console's own menu" means for
this chain. It is still not the HOME tile.

### Filenames: no spaces, at least 16 characters

| typed | console | evidence |
| --- | --- | --- |
| `SAVE "TXT:HOMEBREW"` | `OK`, and `FILES` then lists `TXT:HOMEBREW` | `2026-10-29-files-after-save.png` |
| `SAVE "TXT:HOMEBREW LAUNCHER"` | **`Illegal format (SAVE:1)`** | `2026-10-29-savename-illegal.png` |
| `SAVE "TXT:HOMEBREWLAUNCHER"` | accepted (16 chars) | the save dialog showed that File Name |

So `Homebrew Launcher` cannot be a filename: spaces are rejected outright. A
single-token name of 16 characters is accepted.

Two further facts from the same measurements:

- saving under a new filename does **not** change the project name: the bottom-left
  label stayed `[WORKSPACE]` and the PLAYMENU still showed one card, `[WORKSPACE]`.
  Files and projects are different things, and only the project card is pickable.
- the PLAYMENU's `Tag` field is empty, consistent with `tag.dat` being zeros.

### Negative result: the rename submenu did not open

`A Hold for Submenu` is advertised in the footer. Two pad holds (1.4 s and 2.0 s,
`/pro?a=1&raw=1` then release) left the screen unchanged. It is not known whether
this is the pad's A not reaching a "hold" handler, or the submenu needing a
different button; what is known is that the rename was **not** exercised from the
UI. The rename path that remains is the one this project is built around: write the
`META` name (and icon) into the save and read the card afterwards.


---

*The sections between here and the next heading are controller/harness work, kept in the [full log](https://github.com/dougchansan/ns2-console/blob/main/docs/RESULTS.md).*

### A save cannot be pulled from the title that hosts the exploit

Pulling retail SmileBASIC's own save (`0100c9100b06a000`) from a session hosted
**by retail SmileBASIC** fails for every combination, and the interesting one is:

```
space=User type=Account uid=539fd27752770010 -> 0xe02
space=<everything else>                      -> 0x7d402
```

`0xe02` is not `0x7d402` ("no save data"): the save exists, and the running
application holds it. So the metadata milestone cannot read SmileBASIC's save from
a SmileBASIC-hosted session at all; it needs a session hosted by another title (the
Seedsow demo), or the save pulled while SmileBASIC is not running. That is a real
constraint on the plan, and it was only visible by trying it.

### The second save-touching operation crashed the console with 2162-0002

The Seedsow demo pull (`010042d022aea000`, the backup before any write) died during
account enumeration with `Console response timed out; restart the application`, and
the console then showed **`2162-0002`** (frame `2026-10-29-2162-0002.png`). That is
the documented promoted-root failure (RESULTS, "2162-0002 host crash"), and it came
after `list-apps` plus one save probe in the same boot - consistent with "a restart
between save operations is advice, not a requirement, but the drop is
probabilistic".

The same frame records the console's system version: **23.0.1** (the error screen
prints `(X2) 23.0.1` next to the model/serial block).

So this boot achieved 4/4 and two read-only enumerations, and did not get a save
file: the backup for the wipe+inject milestone is still the 2026-10-28 copy in
`saves/Seedsow-Lullaby-demo/user-539fd277/2026-10-28_0244`, and the launcher set is
built from it (`tools/build-untethered.sh` with `BODY`/`EXTRA`, staged and hashed).


---

*The sections between here and the next heading are controller/harness work, kept in the [full log](https://github.com/dougchansan/ns2-console/blob/main/docs/RESULTS.md).*

### The promoted root handle can be stale by the time tools use it

`save-pull-root.cjs` took `rootHandle` from `ro/root/current-root.json` and sent cmd
53 to it; in run `switch2-i1FuBB` every send returned `0xf601`, while the same engine
happily enumerated accounts (`acc:u0`, 3 uids) in the same session. A fresh
`openService('fsp-srv')` + `Initialize` worked for cmd 18 in that same session. So
`current-root.json` is evidence that the root *was* promoted, not a live handle to
keep using after the RO stage.

### Two sessions lost, both inside a save-open sweep, with the console alive

`save-pull-root.cjs` sweeps 4 spaces x 5 types x every account uid - up to 60
`OpenSaveDataFileSystem` calls - before it opens the save it wants. Both attempts to
pull the Seedsow demo backup died inside that sweep (`SESSION LOST`), and the frames
show the console **alive in `RPC RUNNING`**, not crashed: the application is wedged
inside an unresolved IPC, exactly like the stage-2 wedges.

The fix applied to the tool: `--space N --type N` restricts the open to one
combination (the write tool already opens exactly one, User/Account, and has never
needed a sweep). The next session should pull with
`--space 1 --type 1`, which is also what `save-write-stage.cjs` assumes.


---

*The sections between here and the next heading are controller/harness work, kept in the [full log](https://github.com/dougchansan/ns2-console/blob/main/docs/RESULTS.md).*

## 2026-10-29 16:52: metadata can be written from either side

The name and thumbnail write path exists in two forms, both tested against the real
console sample:

| piece | what it does | proof |
| --- | --- | --- |
| `tools/smb-meta.cjs` | dump/diff/name/icon on a pulled META | `node tests/test_smb_meta.cjs` 7/7 |
| `payloads/ns2jb-metadata.lua` | the same surgery in Lua, for the console side | `lua tests/test_metadata_lua.lua` 15/15 |

Both keep the file at 11152 bytes and, on the real sample, change **only** the 32-byte
name block (`0x70..0x8f`) - verified byte by byte in both test suites. Two bugs found
while writing them, both mine: the slot's capacity must be the block's 22 bytes (not
the current string's, which shrank and then refused a name that fit), and the tag
lives in the thumbnail's first pixels, so replacing an icon deletes the tag and it
must be re-stamped.

The measured limit stands: **11 characters** (`HOMEBREW` fits, `HOMEBREWLAUNCHER`
does not). `--allow-overlap` writes past the block, into the thumbnail's black
margin, and is explicitly marked unproven on a console.


---

*The sections between here and the next heading are controller/harness work, kept in the [full log](https://github.com/dougchansan/ns2-console/blob/main/docs/RESULTS.md).*

## 2026-10-30 18:30: every installed save pulled, and the tool was silently doing nothing

With the arm reseated and travel set to **100** (95 no longer reaches the button), a
single boot ran the whole cycle unattended and reached 4/4, then `--after` pulled saves
inside that one session.

| title | files | size | hashes | opened as |
| --- | --- | --- | --- | --- |
| Seedsow Lullaby (demo) | 289 | 4.4 MiB | 289/289 | space=User type=Account |
| Seedsow Lullaby (full) | 75 | 2.0 MiB | 75/75 | space=User type=Account |
| Mario Kart World | 1 | 844 KiB | 1/1 | space=User type=Account |
| Nintendo Switch Sports Resort | 1 | 572 KiB | 1/1 | **space=User type=Device**, uid 000… |
| Nora to Oujo to Noraneko Heart 2 (trial) | 10 | 151 KiB | 10/10 | space=User type=Account |
| SmileBASIC 4 (demo) | 5 | 35 KiB | 5/5 | space=User type=Account |
| Pokemon Sword + Expansion Pass | 0 | 0 | – | space=User type=Account, **empty archive** |
| Wagamama High Spec (trial) | – | – | – | absent (0x7d402 everywhere) |
| SmileBASIC 4 (retail) | – | – | – | not readable: it hosts the exploit and holds its own save |

7 archives, 381 files, 8,341,142 bytes, every non-empty one re-verified against a
SHA-256 manifest written during the copy (`tools/verify-save-manifest.cjs`).

### The pull tool was a no-op, and it reported success

The first run of `pull-all` claimed "pulled 6/9" with **zero files on disk**. Cause: a
rewrite of `save-pull-root.cjs` had introduced `const flags = new Set([...known flag
names...])` and then tested `flags.has('--list-uids')`, `flags.has('--list-only')`,
`flags.has('--keep-open')` and `flags.has('--all')`. Testing membership of the *known*
set is constant, so every invocation behaved as all four flags at once: it printed the
account uids, listed, returned 0, and pull-all recorded a success. Two consequences
worth keeping: a green exit code is not evidence, and the archive is only real when
the files and their hashes are.

Also fixed: `pull-all` now treats "no save data" as an absent title and only stops on a
dropped session; it tries the targeted combination first and falls back to the pull
tool's sweep, recording the space/type that opened each title.

### What this says about generalising (and about Breath of the Wild)

The two limits that would matter for a large title are in the transfer, not in the
tool: files are read in 0x40000-byte chunks with a console-computed hash per chunk,
and a directory read is capped at 2048 entries. Both were exercised here (a 4.4 MiB
archive with 289 files), but a save with a very large single file or more than 2048
entries in one directory has not been. Nintendo Switch Sports Resort proves the
space/type discovery works: its save is a **Device** save with an all-zero uid, which
a User/Account-only tool would have reported as "no save data".


---

*The sections between here and the next heading are controller/harness work, kept in the [full log](https://github.com/dougchansan/ns2-console/blob/main/docs/RESULTS.md).*

## 2026-10-30 21:29: the launcher is in the save, hash-verified

The 21:23 boot reached 4/4 with **no acquisition error** - the first boot to pass the
native-link phase - and `inject-launcher.sh` ran inside that session:

```
1/4 backing up 010042d022aea000     -> saves/Seedsow-Lullaby-demo-backup-20261029-212538 (290 entries)
2/4 building the launcher set       5 files, 43,970 bytes
3/4 writing the set (one transaction)
     mounted read-write; writing /nso-verify.lua 4693 bytes
     nso-verify.lua  4693  (written ok)
     save9999.dat   28405  (written ok) ok
     ns2jb.lua       4463  (written ok) DIFFERS   <- replaced, as intended
     ns2jb.asb       1946  (written ok) ok
     sscode004.lua   4463  (written ok) DIFFERS   <- replaced, as intended
4/4 pulling the result and hashing it
```

The final step first reported `FAILED 285 problem(s) against 5 manifest entries`, which
was the verifier's fault, not the write's: a five-file manifest injected into a save
that already holds 290 files made every other file look "extra". `verify-save-manifest`
now checks the manifest's entries by default and only flags extras under `--strict`.
With that fixed, the pulled save verifies:

```
ok       /ns2jb.asb (1946 bytes)
ok       /save9999.dat (28405 bytes)
ok       /ns2jb.lua (4463 bytes)
ok       /sscode004.lua (4463 bytes)
ok       /nso-verify.lua (4693 bytes)
VERIFIED 5 files, 43970 bytes from the manifest
```

So the Seedsow demo save now contains the stub, the retargeted suspend launcher, the
launcher body in both places it is read from, and the NSO verifier - read back from the
console and hashed. This is an in-place replace/add, not a literal wipe: the game's own
290-file save is kept because the engine needs it to boot. The backup was taken as the
session's first operation, so the pre-injection state is on disk.

## 2026-10-30 21:37-22:32: the launcher is in the save, but it left no trace of running

Sequence: injected at 21:29 (verified), launched the **Seedsow Lullaby Demo** at 21:37,
then took a session at 22:24 (acquisition passed first time in three) and pulled the
save back at 22:31 to look for the launcher's own report.

What the console's save contains now (`saves/seedsow-after-boot`, 290 files):
our five files, unchanged and matching the manifest, plus `ns2jb-report.txt` - which is
**stale**: it reads `ns2jb body / lua Lua 5.1 / save save: / game game: / t 1793085216 /
sd no / sdw no / dump nil / dumpe not enough memory`, a capability probe from an
earlier payload, not the launcher's `ns2jb-launch.txt`.

The launcher's report file (`save:/ns2jb-launch.txt`, written unconditionally by
`staging-launcher/ns2jb.lua` line 68) is **absent**. So the honest reading is: the
injected suspend did not lead to our script running, or it ran and could not write -
and the console gave no way to tell, because after the account picker the screen went to
**no signal while the console stayed alive** (ping yes, USB mounted, pad adopted). That
is the documented HDMI fault, and it is also consistent with the black screen recorded
for this payload path earlier.

So "the demo boots the launcher" is **not** established. The injection is; execution is
not. The next experiment should make execution observable from the save alone: have the
launcher append a provenance line to a file the editor already writes
(`ssedit-session.txt` exists in the save and is known writable), so that a pull can
distinguish "never ran" from "ran but could not create its report".

Also measured this stretch: the acquisition's failure has moved past the canary. Six
consecutive boots all report `markerSelected: true` and `markerReproduced: true`, then
fail in four different later places:

| boot | error |
| --- | --- |
| 21:44 jE19V1 | Native batch did not terminate; resources retained |
| 21:50 7JfV2b | Clean alias did not qualify within its attempt limit |
| 22:04 zs5EQU | no qualified, encodable link candidate |
| 22:13 kHvUON | Native batch did not terminate; resources retained |
| 22:23 QUJHDI | Overwrite missed the qualified canary (the old flake) |

One boot in six passed all of it (21:23, which performed the injection). That yield,
not the canary, is now the limiting factor.

## 2026-10-30 23:59: provenance instrumentation, and a body-selection footgun

The launcher now appends one line to `save:/ns2jb-report.txt` **before** any check that
can fail, so a pull can distinguish "the script never ran" from "it ran and could not
create its own report" - the question the 21:37 boot could not answer.

Doing that exposed a footgun in the builder. `build-untethered.sh` defaults the body to
`payloads/ns2jb.lua`, which is a **2045-byte probe** (it is what wrote the stale
`ns2jb-report.txt` reading "ns2jb body"), while the injector passes
`BODY=payloads/ns2jb-launcher.lua` explicitly. Rebuilding by hand without `BODY`
therefore rebuilt staging with the wrong program - a 2045-byte probe instead of the
4463-byte launcher - and the only visible sign was a sha256 that had not changed. The
staging set is rebuilt with the injector's own body plus the instrumentation:
ns2jb.lua/sscode004.lua 5134 bytes, sha256 9b4859e0..., and `tests/test_payload_lua.lua`
13/13 (the line-width check caught my first, over-long comment).

## 2026-10-30 11:11: the restore path works on hardware, nested file included

Fifth attempt of the night (the first four died in acquisition) reached 4/4 and ran
`save-restore.sh` against the **Nora trial** save - a title with nothing to do with
Seedsow, chosen because it is the smallest save that has a nested file:

```
1/4 backing up the current save  10 files, 154384 bytes -> saves/010012900d38a000-pre-restore-...
2/4 writing the save back
    restore: /debug/lua/index.lua live 427B be68bef8e844deba... -> 427B be68bef8e844deba...
    ... 9 more, each logged live -> new
3/4 pulling the result          10 files, 154384 bytes
4/4 verifying                    ok x10
VERIFIED 10 files, 154384 bytes from the manifest
```

What this establishes:

- `--space 1 --type 1` selects the save explicitly (the pull printed
  `mounted space=User type=Account rank=0 index=0 uid=539f...`).
- **Nested directories work**: `/debug/lua/index.lua` was created under `/debug/lua`
  and read back byte-identical.
- The four-step order works: pre-restore backup, transactional write, re-pull, hash
  verification against the manifest.
- Every one of the 10 files matched the manifest on a fresh pull.

What it does **not** establish, and I will not claim: the source directory was a pull
of that same save, so the bytes restored were identical to the bytes live. The restore
branch ran (it logged `live -> new` instead of the replace-equality check), but the
case that matters for BOTW - **overwriting bytes that differ** - has not been
exercised. The mechanics after that decision are the same create/replace/commit path
that the Seedsow injection has used repeatedly, but "differs" itself is untested.

Yield note: 1 success in 5 boots tonight, and the successful one took 4 minutes of
acquisition after three late-stage failures on other boots.

## 2026-10-31 10:13: the enumeration fixes on hardware (run `switch2-wbYQOT`)

One boot, one session, three claims checked against the console itself.

### Applications come from every storage that has a database

`list-apps` asked BuiltInUser, SdCard and GameCard: 9 internal plus 1 gamecard
(Mario Kart 8 Deluxe, `0100152000022000`) = 10, with SdCard reported as "no
database" because the slot is empty. The old tool asked BuiltInUser alone and
would have listed 9 - the shape of issue #1, one storage short of the answer.

### Names come off the console

10 of 10 titles named from each title's control NCA - ouncecake's fallback path.
The ns reader did not answer on this build: `ns:ro` was not registered (0x615) and
`ns:am2`'s reader answered `0x5010`, then refused the send (`0xf601`). The names
are the NACP's own: five are japanese titles and carry the japanese name
(`プチコン4`, `ノラと皇女と野良猫ハート2体験版`, ...), which is the shell's name
for them, not an english catalogue's. Reading the control NCA first also matters
for order: with the ns attempt first, the gamecard title failed (9 of 10); with
the NCA read first, all 10 named.

### The save walk is type-based and complete

`--list-only` on the Seedsow demo listed 290 files / 4,665,778 bytes, nested
`system/` tree included, and a pull of that archive wrote 290 files that
`verify-save-manifest` matched by hash. Seedsow Lullaby (full) listed 75 files /
2,048,636 bytes. The walk classifies from the listing's directory-entry type, so
nothing was opened to decide what it was.

What this does **not** establish: a save holding a file whose read-only open is
refused (the case the walk now reports and exits 5 on) was not available here, and
the SD-card database path had no card to open. Breath of the Wild was not on this
console.

### A physical game's save pulls the same way

Mario Kart 8 Deluxe is the cartridge in the slot, so its title is in the gamecard
database (storage 2) only - the listing a BuiltInUser-only tool never saw. Its
save is an ordinary internal Account save: one file, `/userdata.dat`, 80,736 bytes,
pulled and matched by hash. The gamecard database is where the *title* comes from;
the save data itself stays on the console.

`inventory` on this session listed 8 archives for the first account, Mario Kart 8
Deluxe among them, and titled every row.

## 2026-11-01 11:20: the save-data index works on the promoted root - 17 User saves, no titledb

The kit had recorded that `OpenSaveDataInfoReader` (fs:srv 60/61/68) answered
`0x320002` and treated whole-store enumeration as unavailable. That was a session
bug, not a console limit: `probe-info-reader.cjs` and the old `save-list.cjs`
opened a **fresh** fsp-srv session, whose cached program id is not 1, so FS
rejected the reader. On the **promoted root handle** the same reader opens with a
one-byte space input (command 61) and returns `SaveDataInfo` records, 0x60 bytes
each, with the count inline:

```
node tools/save-inventory.cjs <run> --space 1 --names
```

Measured on `runs/switch2-kZvIBD` while the session was live, without a new boot:

| space | archives |
| --- | --- |
| 0 System | 111 |
| 1 User | 17 |
| 3 Temporary | 0 |
| 2 SdSystem / 4 SdUser | `0x137e02` (no SD card) |

The User list is the result that matters. It includes `0100152000022000`
(Mario Kart 8 Deluxe, Account + Device) and `0100abf008968000` (Pokemon Sword,
Account + Bcat) - **neither card is inserted and neither title is in NCM's
BuiltInUser list**. It also includes `0100f43008c44000` (Z-A, Account id 52 +
Bcat id 53) and `010012900d38a000` (Nora, whose program was removed from NCM).
The store is enumerable from the console alone; NCM's application list was the
wrong source, not the only source.

The reader is metadata only. Opening an archive is the operation that can wedge a
session, so enumerate first; the pull path and its batch limits are the next
entry.

## 2026-11-01 11:47: the inventory pull path works - six opens survived one boot

`pull-inventory.cjs` takes the exact `(space, type, uid, app id)` from the
inventory JSON, so NCM and titledb are out of the pull path entirely. Tested on
the same held boot as the inventory:

| # | archive | result |
| --- | --- | --- |
| 1 | Z-A Account id 52 | 1 file, 3,186,611 bytes |
| 2 | Pokemon Sword Account id 34 | 0 files - the index's 8,732,672 is allocation; the save is created-but-unused |
| 3 | Switch Sports Device id 47 | 1 file, 586,140 bytes, SHA-256 matched the manifest |
| 4 | SmileBASIC Cache id 51 | `0x7d402` at rank 0/index 0 - attribute unresolved, not absent |
| 5 | Switch Sports Bcat id 48 | 43 files, 403,373 bytes (index allocation 7,684,096) |
| 6 | Z-A Account id 52 again | 1 file, 3,186,611 bytes, same SHA-256 |

The session was still `ready: true` (55,058 calls) after the sixth attempt, so the
one-per-boot rule is a risk measured on other boots, not a hard cap. The tool now
defaults to a batch of up to five (`--limit 0` = every pending archive) and still
stops at the first session loss, because a lost 4/4 costs a boot to reacquire.

Two tool bugs surfaced. `save-pull-root` prints its `done:` line on stderr, and
the puller's first success test only looked at stdout, so a valid 0-file pull was
recorded as a failure; fixed by testing stdout+stderr and recording `files: 0` as
done. And a Cache archive is in the index but did not open at rank 0/index 0; it is
now recorded as a retry, not as absent.

## 2026-11-01 12:30: the rest of the User store - 15/17 archives, two blockers

The default batch was raised to five and two more batches ran on the same boot.
Total for the User space: **15 of 17 archives, 525 files, 16,445,572 bytes**. The
session was still `ready: true` (69,718 calls) after roughly 20 open attempts, so
the old one-per-boot limit is not a hard cap. It remains a risk on other boots,
so the batch still stops at the first session loss.

The two blockers are host-specific, not discovery failures:

- **SmileBASIC 4 Account id 32 -> `0xe02`.** SmileBASIC is the application hosting
  the exploit, so it holds its own save. Retry from a different host app.
- **SmileBASIC 4 Cache id 51 -> `0x7d402` at rank 0/index 0.** The archive is in
  the index; the open attribute is unresolved (the Cache problem from 11:47).

Empty archives (allocation > 0, zero files) are real: Pokemon Sword Account
(8.7 MB allocation), MK8DX Device (68.9 MB), Pokemon Sword Bcat (69.9 MB). The
index `size` is allocation throughout: MK8DX Account said 108.9 MB and pulled
80,736 bytes; Mario Kart World said 151.1 MB and pulled 864,156 / 1,248,964 bytes.
