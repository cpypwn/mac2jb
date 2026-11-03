# Technical notes

Two parts: how a save file becomes code execution, and the CMIF
pointer-buffer layout the write path needs.

---

# Nora / Artemis launch-time save exploit — findings so far

Goal: 3DS-style save exploit — code execution right after launching the game
from the home screen, eventually untethered from SmileBASIC.

## 1. Save containers are Pluto 2.2 persisted Lua tables

Every `BOW*` container stores its "variables" as **Pluto** (Ben Sunshine-Hill,
`Neopallium/pluto` 2.2, Lua 5.1) blobs. Verified by loading the game's own
blobs locally with Lua 5.1.5 + pluto:

| file | magic | variables |
| --- | --- | --- |
| `saveg.dat` | BOWG | `g.config`, `g.script`, `g.system` |
| `system.dat` | BOWX | `s.*` (s.savepath, s.datapath, s.bgmvol, …) |
| `save0001.dat`, `autosave.dat`, `save9999.dat` | BOWS | `scr`, `btn`, `log`, `varistack`, `bselstack` (bank object = field 30, vars = bank field 2) |

Pluto format (per value): `int firstTime`, then `int ref`, `int type` when
firstTime=1 (Lua 5.1 type codes: nil 0, boolean 1, lightuserdata 2, number 3,
string 4, table 5, function 6, userdata 7, thread 8, proto 9, upval 10).
Strings: `size_t len` + bytes. Tables: `int special` (0), metatable value,
then key/value pairs, terminated by a nil value (firstTime=0, ref=0).
Functions are persisted (Lua closures: nups byte, proto, upvalues, fenv) and
restored on unpersist — so a crafted blob can carry Lua **bytecode**.

Local toolchain (host):

```
/tmp/lua-5.1.5/src/lua          # built Lua 5.1.5
/tmp/pluto.so                   # pluto 2.2 built as a bundle, needs pdep/luaconf.h copied from Lua src
pluto-probe/extract.cjs         # dump BOW* string maps to *.blob files
pluto-probe/make-config.lua     # build the crafted g.config blob
make-saveg.cjs                  # rewrap saveg.dat (BOWG) around a new g.config
```

## 2. Boot sequence reads attacker-controlled Pluto blobs

`system/first.iet` → `system_initlua` → `system_loadinglua` →
`system_dataloading` → `system_initialize` → `system_starting` → title.

`system_dataloading()` (system/init.lua):

```lua
load_system()                       -- sys  = fload_pluto("g.system")
load_global()                       -- gscr = fload_pluto("g.script")
conf = fload_pluto(init.save_config)-- conf = fload_pluto("g.config")
if not conf then ... else
  if conf and (not conf.bgm or not conf.se or not conf.voice
               or not conf.aspeed or not conf.mspeed) then ... end
end
```

`fload_pluto(name)` = `pluto.unpersist({}, e:var(name))` — the blob comes
straight out of `saveg.dat`. Unpersisting a table **restores its metatable**,
so `__index` on the first missing key runs arbitrary Lua bytecode at boot,
before the title screen and without any input.

## 3. First payload

`pluto-probe/make-config.lua` takes the real `g.config` table, drops `bgm`
(the first key the boot code reads), and attaches

```lua
{ __index = function(t, k)
    -- once: write ns2jb.txt into the save dir, queue a dialog
    e:tag { "dialog", title = "ns2jb", message = "doug pwned the switch 2" }
    return defaults[k]   -- 1 for bgm/se/voice/aspeed/mspeed
  end }
```

`make-saveg.cjs` rewrites the BOWG container (single object at 0, fields
1 = read_lines, 2 = string map) keeping `g.script`/`g.system` byte-identical.

Written to both Nora user saves (`/saveg.dat`) through the promoted fsp-srv
root; originals kept in `saves/prefinal-uid0/`, `saves/prefinal-uid1/`.

## 4. Tools added

- `save-delete-root.cjs <run> <title> <uid> <path>` — delete a save-dir file
  (IFileSystem cmd 1) + commit.
- `save-write-root.cjs` now creates the file first (CreateFile cmd 0) when
  OpenFile returns 0x202, and skips directories during verification.

## 5. Next steps

1. Confirm the dialog / `ns2jb.txt` on a real launch.
2. From the payload, test `e:include(<savepath>/x.lua)` for persistence.
3. Escalate: keep Lua execution on every boot, then look for a memory
   read/write primitive from inside the game process.

---

# CMIF pointer buffers, account uids, and reading another title's save

Status: pointer buffers are implemented in `engine/shared/ipc.cjs` without changing the
map-alias path. `acc:u0` enumeration works. With the raw AccountUid bytes and the
exploit's promoted fsp-srv root, **another title's save opens read-only and its files are
readable**. The earlier "FS 1002 for everything" result was a byte-order bug in our own
uid encoding, not FS behaviour.

## Descriptor encoding (HIPC statics, not 3-word buffer descriptors)

CMIF "pointer" buffers are HIPC *static* buffers. They are not a fourth kind of the
3-word map-alias descriptor, and there is no per-descriptor type nibble. The only 4-bit
type is the CMIF command type in header word 0 (4 = `CmifCommandType_Request`).

### In pointer (send static, `pointers.send`)

2 words / 8 bytes, stored before the map-alias descriptors:

    word 0: index:6 | (address >> 36):6 << 6 | ((address >> 32) & 0xF):4 << 12 | size:16 << 16
    word 1: address low 32 bits

`size` is 16-bit. Counted in header word 0 bits 16..19 (`num_send_statics`).

### Out pointer (recv static, `pointers.receive`)

Two things are appended for every out pointer:

1. One `u16` size in the CMIF data words at
   `data_words + 0x20 + in_data_size` (0x10 message padding + 0x10 `CmifInHeader`),
   only for non-fixed out pointers.
2. One 8-byte recv-list entry *after* the data words:

       word 0: address low 32 bits
       word 1: (address >> 32) & 0xFFFF | size:16 << 16

   The recv list starts at `data_words + num_data_words * 4`.

Header word 1 bits 10..13 hold `recv_static_mode`: 0 = none, `2 + N` = N recv statics
(2 alone means "auto"). `num_data_words` grows by `ceil(2 * N_unfixed / 4)`.

These offsets match libnx (`cmifMakeRequest` / `cmifRequestOutPointer` /
`hipcMakeRecvStatic`) and libstratosphere
(`GetUnfixedOutPointerSizeOffset() = in_data + sizeof(CmifInHeader) + 0x10`).

## API

```js
const {packet} = require('./engine/shared/ipc.cjs');
packet(command, input, {
  pid, copies, send, receive,              // unchanged map-alias path
  pointers: {
    send:    [{address, size, index?}],    // optional; index defaults to array index
    receive: [{address, size, fixed?}],    // fixed: no u16 size-table entry
  },
});
```

`descriptor()`, the map-alias counting, and `response()` are byte-identical to the
previous implementation for all existing call shapes (`test-ipc-pointers.cjs` checks the
layout; the live `test-save-abi.cjs` re-run still reports `0x320002` for the zero-uid case).

## The uid bug

An `AccountUid` is 16 raw bytes = two little-endian `u64`s. Printing it as two big-endian
hex numbers and then `Buffer.from(text, 'hex')` swaps each 8-byte word. Every earlier
`fsp-srv` request used that swapped value, so no save matched: uid 0 gave FS 6400 and any
"real" uid gave FS 1002 (`TargetNotFound`). The raw bytes from acc:u0 are
`53 9f d2 77 52 77 00 10 a6 ec 49 84 c5 6d 36 64` for the first user; the *numeric* hex
`1000775277d29f53...` is not an acceptable substitute for `FsSaveDataAttribute::uid`.

## Results on the held run (`runs/switch2-LJqn5w`, SW 23.0.1, SD removed)

`acc:u0` after command 140 (send-pid) -> `0x0`:

| call | result |
|---|---|
| 0 `GetUserCount`, no buffers | `0x0`, inline u32 = 3 (Switch-1 inline ABI; a pointer form is accepted but the value stays inline) |
| 2 `ListAllUsers`, pointer out 0x80 | `0x0`, 3 raw uids |

`fsp-srv` (space 1, type Account):

| session | uid | cmd | result |
|---|---|---|---|
| app's own `fsp-srv` | swapped | 51/53 | FS 1002 (not found) - the bug |
| app's own `fsp-srv` | all zero | 51/53 | FS 6400 |
| app's own `fsp-srv` | raw uid 0 | 51/53 | FS 6400 for other titles (access control) |
| app's own `fsp-srv` | raw uid 0, own save | 51/53 | FS 0xe02 (already mounted by the app) |
| promoted root (`pid=1`) | raw uid 0 | 53 | **`0x0` + save filesystem handle** |
| promoted root | raw uid 0 | 51 after 53 | FS 0xe02 (save locked by our read-only open) |

The promoted root is the exploit's own dedicated fsp-srv session whose cached PID fields
were set to 1 (`ro/root/current-root.json`). FS resolves the client's program id from that
cached PID, so the save-data access check passes and other titles' saves resolve. A
read-only open holds the save exclusively: a second open (read-only or read-write) returns
`0xe02` (`TargetLocked`) until the handle is closed.

## Save inventory (what FS actually knows)

The all-space info reader (cmd 60) and the User-space reader (cmd 61, space 1) both work
through the promoted root and list 12 User-space saves (`id`, type, raw uid, app id, size):

| id | type | uid | app id | size |
|---|---|---|---|---|
| 36 | Account | uid0 | 010012900d38a000 (Nora) | 67,616,768 |
| 32 | Account | uid0 | 0100c9100b06a000 (SmileBASIC) | 88,784,896 |
| 40 | Cache | - | 0100c9100b06a000 | 1,392,640 |
| 9 | Account | uid0 | 0100b4b00f9f6000 | 55,033,856 |
| 25/26 | Account | uid0/uid1 | 0400c3f00006e000 (MKW) | 151,109,632 each |
| 23/24 | Account | uid0/uid1 | 0100ee5021c9e000 | 67,616,768 each |
| 38 | Account | uid0 | 010152000022000 | 108,937,216 |
| 39 | Device | - | 010152000022000 | 68,960,256 |
| 34 | Account | uid1 | 0100abf008968000 | 8,732,672 |
| 35 | Bcat | - | 0100abf008968000 | 69,910,528 |

Nora's *save* still exists even though its *program* is no longer in NCM's application
list (cmd 201 -> FS 6605 `ProgramInfoNotFound`): the game was removed, the save was kept.

## Read result: Nora's save

`save-pull-root.cjs` opened save id 36 read-only and dumped it:

```
/save0001.dat   26549
/save0001.png   87240
/save0062.dat   35991
/system.dat      2231
/saveg.dat       2851
```

Format (Artemis engine): `BOWS` / `BOWG` / `BOWX`, `u32` version `1002`, `u32` inflated
size, then a zlib stream. Example payload head after inflate: `1.80.mw.adv`, `macro.iet`,
`system/first.iet`, `s.bgmvol`, `400`, `s.segain.1`, `1000`. The `.dat` files inflate
exactly to their declared size, so they can be decoded, edited, recompressed and written
back.

## Next: writing

1. Release the read-only handle, then open with command 51 (read-write) through the
   promoted root; keep the handle mapping and restore/close discipline.
2. Use the IFileSystem write path (CreateFile/WriteFile/Flush + save commit) so the save
   journal is committed; never leave a half-written save.
3. Compress the edited `BOWS` payload with zlib, fix the `u32` size, write, commit, then
   re-open read-only and verify by re-dumping.

## Files

* `engine/shared/ipc.cjs` - pointer descriptors, map-alias path unchanged
* `test-ipc-pointers.cjs` - layout checks (no console)
* `test-acc-uid.cjs` - acc:u0 uid enumeration + fsp-srv 51 retry (raw uid)
* `save-pull-root.cjs` - read-only dump of another title's save through the promoted root
* `saves/010012900D38A000/` - Nora's dumped save

## Write path (verified)

`save-write-root.cjs <run> <program-id> <raw-uid> <save-path> <local-file> [verify-dir]`
opens the save read-write through the promoted root (cmd 51), then:

```
IFileSystem 8  OpenFile(path, mode 3)
IFile       3  SetSize(size)
IFile       1  Write(offset, map-alias in buffer mode 1)   # 0x40000 chunks
IFile       2  Flush
IFileSystem 10 Commit
```

then closes and re-opens read-only and hashes every file. Buffers use map-alias mode 1
because the file I/O attributes include `HipcMapTransferAllowsNonSecure`.

Round trip 1: `/system.dat` rewritten byte-identically (2231 bytes), commit `0x0`,
re-dump matched all five files.

Round trip 2 (first craft): `system.dat` (`BOWX`) is a `u32` pair count plus
length-prefixed key/value strings. `s.bgmvol` changed 400 -> 1000, the container was
rebuilt (new u32 size + zlib), written and committed. A fresh `save-pull-root.cjs` shows
`/system.dat` at 2224 bytes with `s.bgmvol = 1000`, a valid directory, and the other four
files byte-identical to the pristine dump. Pristine backup: `saves/010012900D38A000/`;
crafted files: `saves/010012900D38A000-work/system.dat.crafted` and the re-pulled
`saves/010012900D38A000-crafted/`.

The global/slot banks (`BOWG` field 2, `BOWS` field 30) are a different, older v1002
encoding than the v1003 `Strings()` layout used by artemis-compat; the `bgm_*` / `scene`
unlock records live there. BOWS fields 24/26 (text and layer command lists: `u32` count,
layer name, command count, `u32` source line, command name, attribute map) and the BOWX
pair bank are decoded; the v1002 variable bank is the remaining piece for unlock edits.

## v1002 variable banks (decoded)

Both banks are the same shape as the BOWX pair bank: `u32 count`, then repeated
`u32 key_len, key, u32 value_len, value`. Values may be raw binary blobs.

`BOWG` root field 2 (global save `saveg.dat`):

| key | value | contents |
|---|---|---|
| `g.script` | 8293 bytes | scene/event/BGM seen list - `scene`, `event06`, `bgm_134`... |
| `g.system` | 967 bytes | save-slot metadata - `saveslot`, `date`, `title`, `file`, `last`, `quick` |
| `g.config` | 3750 bytes | config/flags - `selsave`, `sysvo`, `window`, `asave`, `qsave`, `fl_s005` |

`BOWS` bank (slot save `save0001.dat`, field 30) is a variable map with `scr`
(a serialized script-command stack: `path`, `face`, `time`, `mode`, `file`, `name`,
`bgm`, `bg`, `cutin`, ...), `varistack`, `tagstack`, `game.width`, `game.height`, and
the same nested command/layer structures as fields 24/26. The slot save therefore carries
the engine's resume/script state, not just display text.

## Engine availability check

`root-native-code-open` for `0x010012900D38A000` on this console:

| storage | result |
|---|---|
| 2 (game card) | FS 0x408 (1032) |
| 4 (built-in user) | FS 0x408 (1032) |
| 5 (SD) | FS 0xA08 (2568) |

NCM's BuiltInUser application list has 6 entries and does not include Nora, and
`fsOpenDataStorageByProgramId` returns FS 6605 for it. The save exists, but the program
is not installed/inserted, so the engine binary cannot be dumped for analysis yet.
