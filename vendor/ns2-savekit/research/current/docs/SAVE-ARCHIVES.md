# Save archives: what the open call selects

`save-pull-root.cjs` mounts a save with fsp-srv's
[`OpenReadOnlySaveDataFileSystem`](https://switchbrew.org/wiki/Filesystem_services#OpenReadOnlySaveDataFileSystem)
(command 53). It takes exactly two inputs, and they identify **one** archive:

- a `u8` [`SaveDataSpaceId`](https://switchbrew.org/wiki/Filesystem_services#SaveDataSpaceId)
  (the storage: User 1, SdUser 4, System 0, Temporary 3, plus the Proper/SafeMode
  variants),
- a 0x40-byte [`SaveDataAttribute`](https://switchbrew.org/wiki/Filesystem_services#SaveDataAttribute):

| offset | field | meaning |
| --- | --- | --- |
| 0x00 | ReferenceId / ApplicationId | the game id; `0` means "the current process's save", not "all saves" |
| 0x08 | UserId (16) | an account, or `0` for **savecommon** |
| 0x18 | StaticSaveDataId | system saves only |
| 0x20 | Type | SaveDataType |
| 0x21 | Rank | Primary 0 / Secondary 1 |
| 0x22 | Index (u16) | archive index, meaningful for Cache |

There is no wildcard: this call cannot mount "the save data partition" or every
title's save. Enumerating archives is `OpenSaveDataInfoReader` (60/61). The
reader **does** work, but only on the promoted root handle: command 60 opens an
all-space reader, command 61 takes a one-byte space id. A fresh `fsp-srv` session
gets `0x320002`/`0x2ee002`, which is what an earlier probe measured and why this
document used to call the reader unavailable. `save-inventory.cjs` opens it
read-only and reads pages of `SaveDataInfo` records (see below).

## The whole store: enumerate first

`save-inventory.cjs` asks FS for its own index instead of walking NCM's
installed-application list or probing attributes. It needs no titledb and no
knowledge of which cards are inserted:

```sh
node tools/save-inventory.cjs <run-directory> --space 1 --names
node tools/save-inventory.cjs <run-directory> --json saves/inventory.json
```

Measured on 2026-11-01 (`runs/switch2-kZvIBD`, SW 23.0.1): **128 archives** total
— 111 System, 17 User, 0 Temporary, and the SD spaces unavailable with no card.
The 17 User archives are the useful part. They included:

| app id | archive | why it matters |
| --- | --- | --- |
| `0100f43008c44000` | Account + Bcat | Pokémon Legends: Z-A, card inserted |
| `0100152000022000` | Account + Device | Mario Kart 8 Deluxe, **card not inserted** |
| `0100abf008968000` | Account + Bcat | Pokémon Sword, **card not inserted** |
| `010012900d38a000` | Account | Nora trial, program removed from NCM |
| `010042d022aea000` | Account | Seedsow demo |
| `0100c9100b06a000` | Account + Cache | SmileBASIC 4 |
| `0100ee5021c9e000` | Account per user | Seedsow full |
| `0400c3f00006e000` | Account per user | Mario Kart World |
| `0100b4b00f9f6000` | Account | SmileBASIC 4 demo |
| `04008e001f098000` | Bcat + Device | Switch Sports Resort |

That list is the answer to "the save is in system memory, so why can't the kit
see it": the kit was asking the wrong service (NCM applications) instead of the
save-data index. The archive is addressed by `(space, application id, uid,
type)`, and the index supplies all four, including titles whose card is gone.

The reader is metadata only, and its `size` is the archive allocation, not the
sum of file bytes (Z-A: 17,121,280 in the index, 3,186,611 pulled).

## Pulling from the inventory

`pull-inventory.cjs` consumes that JSON and pulls the exact archive identity,
with no NCM and no titledb:

```sh
node tools/pull-inventory.cjs <run> saves/from-inventory \
  --inventory saves/inventory.json --space 1 --type 1
```

It defaults to a batch of up to **five** per run (`--limit 0` pulls every pending
archive) and keeps `inventory-progress.json`, so a reboot resumes at the next
entry. The batch stops at the first session loss. On 2026-11-01 one boot took 20
open attempts without wedging and pulled 15 of the 17 User archives (525 files,
16.4 MB). Two were blocked: SmileBASIC 4's own Account save (`0xe02` - the app
hosting the exploit holds it) and its Cache archive (`0x7d402` - attribute
unresolved). The old one-per-boot rule is an empirical risk, not a hard cap.

Empty archives are real: the index reported an 8.7 MB Pokémon Sword Account
archive, but the mounted filesystem had **zero files**. That is a created-but-
unused save, not a broken pull. The manifest records `files: 0` and the entry is
marked done, not failed.

## What each SaveDataType needs

From `libnx`'s `FsSaveDataAttribute` and JKSV's `fs::mountSave` (the save manager
that enumerates with the info reader and mounts each entry):

| Type | Attribute | Open command |
| --- | --- | --- |
| 1 Account | game id + user (or uid 0 for savecommon) + Rank + Index | 51/53 |
| 3 Device | game id only — every other field zero | 51/53 |
| 2 Bcat | game id only | 51/53 |
| 5 Cache | game id + Index | 51/53 |
| 4 Temporary | game id only | 51/53 |
| 0 System / 6 SystemBcat | `StaticSaveDataId` (+ user), ReferenceId 0 | 52 |

Space is normally `1` (User). A save moved to the SD card is `4` (SdUser);
Temporary is `3`; System and SystemBcat live in `0`.

## A title can own several archives

JKSV's list is per *archive*, not per title, and it can show more than one for
the same game:

- one **Account** save per user, and sometimes an additional **common** Account
  save (`uid 0`) for data shared across users;
- a **Device** save for settings shared by every user (SmileBASIC 4 retail is
  one that the toolkit has pulled this way);
- **Bcat** archives for downloaded content, and **Cache** archives;
- a second Account archive with `Rank = Secondary` or a non-zero `Index` for
  games that keep a backup or multiple save sets at the archive level.

The first version of this tool opened the first attribute that succeeded and
stopped, so a title with a common or secondary archive came back incomplete.

## What the toolkit tries now

Default (stops at the first archive that opens):

| field | values |
| --- | --- |
| space | 1 User, 4 SdUser |
| type | 1 Account, 3 Device, 2 Bcat, 5 Cache, 4 Temporary |
| user | every account, then uid 0 |
| rank | 0 |
| index | 0 |
| static id | 0 |

`--all` keeps going after the first success and pulls every archive it can open
into `output/archive-spaceN-typeN-rankN-indexN-<uid>/`. It also tries `rank 0`
and `rank 1`. It is opt-in because a long sweep is what wedges a session
(`docs/RESULTS.md`): narrow it with `--space`, `--type`, `--rank`, `--index`.

Targeted knobs: `--space N`, `--type N`, `--rank N`, `--index N`,
`--static-id N`, plus the positional uid. `--list-only` reports what would be
pulled; `--list-uids` prints the console's accounts.

The kit does not use that sweep to decide which account has a save. It probes
`space=1 type=Account` (then `space=4`) for one account at a time, so an empty
account costs two targeted probes (up to four opens) rather than a twenty-open
sweep. Only when no account has its own archive does it scan the shared
Device/Bcat/Cache/Temporary shapes once, with uid 0. A probe that exits 0
without a listing is reported as a tool problem, never as "no save data".

## The tree inside a save is a different problem

Games lay out their archive however they like, and that needs no per-game code:
the walk starts at `/`, lists directories, and recurses. Breath of the Wild is
the usual example: `0`…`8` slot folders, `album/`, `pict_book/`, `tracker/`,
`option.sav` — the reference 100% save has [227 files](https://github.com/Torphedo/BOTW-CompletedSaveFile)
in that tree. The toolkit already pulls nested trees (`saves/all/Seedsow-Lullaby-full/system/ui/`
and `saves/all/SmileBASIC-4-demo/f/###/` are two levels deep).

What differs between games is **which archives** the attribute selects, above.

## What the walk calls a file

The console's directory listing reports each entry's type, and this build reports
`Directory = 0` and `File = 1` (a file's type byte is 1 - see the `tmp.dat` reset
in `RESULTS.md`). The walk in `lib/save-tree.cjs` recurses on `Directory` and
reads on `File`, so a listing (`--list-only`) and a pull traverse identically.

It used to try a read-only open on every entry and call a failed open a
directory. A real file that refused that open was recursed into, found empty
there, and dropped without a word - the "not catching all the file structure"
report. A file that will not open is now named on stderr, recorded as `failed` in
the manifest, and makes the pull exit 5, so a partial save cannot pass for a
complete one. The pull is read-only throughout: a failed file costs a retry, not
data.

One directory may hold up to 65536 entries. `ReadDirectory` returns four per
call, so that number is only a loop bound, but the old 2048 aborted the whole pull
of a save that went past it.

## Known limits

- The inventory now carries Rank and Index too, but every entry on this console
  read zero and a Cache archive still did not open at rank 0/index 0, so the
  Cache attribute is unresolved. `--rank`/`--index` remain the knobs to try.
- `--all` is a sweep. On this console a 60-open sweep has wedged sessions, so the
  default stops early and `--all` warns.
- The write path (`save-write-stage.cjs`) still opens exactly User/Account
  (space 1, type 1), because that is the only combination it has been tested
  with. Restoring a Device or common save needs the same knobs added there.
- The save-data **meta file** (`OpenSaveDataMetaFile`, cmd 80) is not part of the
  mounted filesystem and is not pulled.
