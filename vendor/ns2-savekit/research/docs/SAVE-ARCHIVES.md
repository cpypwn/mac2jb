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
title's save. Enumerating archives is `OpenSaveDataInfoReader` (60/61/68), which
answers `0x320002` through the promoted root on this build (see
`probe-info-reader.cjs`), so the tool probes attributes instead.

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

## Known limits

- Without the info reader there is no way to learn an unknown `Index`. `--index`
  covers the cases a game is known to use; the default 0 is what nearly all
  Account saves use.
- `--all` is a sweep. On this console a 60-open sweep has wedged sessions, so the
  default stops early and `--all` warns.
- The write path (`save-write-stage.cjs`) still opens exactly User/Account
  (space 1, type 1), because that is the only combination it has been tested
  with. Restoring a Device or common save needs the same knobs added there.
- The save-data **meta file** (`OpenSaveDataMetaFile`, cmd 80) is not part of the
  mounted filesystem and is not pulled.
