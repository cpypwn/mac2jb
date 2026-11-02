# Pull and restore a save (any title, including BOTW)

The save kit does two things to any title's save: **pull** it (read every file, hashed)
and **restore** it (put a pulled copy back). Both go through the same promoted
`fsp-srv` root that the SmileBASIC exploit produces, and neither is tied to Seedsow —
that title is only where the exploit is delivered.

What this is *not*: a way to run code in another game. Restoring BOTW saves works from
the SmileBASIC side; it does not make BOTW itself run anything of ours.

## Prerequisites

- The console is on firmware **23.0.1** with the `ns2jb` engine checked out, and
  SmileBASIC 4 (retail) is installed to host the exploit.
- One boot gives **one RPC session** (`docs/LAUNCHER.md`, rule 1). Pull and restore are
  separate sessions, so the usual cycle is: boot → pull; boot → restore; boot → verify.
- A pulled directory as the source for a restore: `saves/<something>/` with the save's
  files (and optionally our `manifest.json`).

## Pull

```sh
# one title; --space/--type only if the default (User/Account) is wrong
node tools/save-pull-root.cjs <run> <title-id> saves/botw <uid> --space 1 --type 1

# or discover every installed title's combination, one archive per sentence
node tools/pull-all.cjs <run> saves/all --batch 4
node tools/saves-report.cjs saves/all        # what was pulled, and how it opened
```

`<run>` is a live run directory (`~/ns2jb-rpc/runs/switch2-*`) with
`switch2/ro/root/current-root.json` present. `<uid>` is the 16-byte account uid in hex
(e.g. `539fd27752770010a6ec4984c56d3664`); `--list-uids` prints them.

The pull prints `mounted space=… type=… uid=…` — **read that line**. It is how you learn
that BOTW opened as User/Account rather than something else, and it is the first thing
to check if a pull comes back empty. Every file is hashed as it is copied, and a
`manifest.json` is written beside them.

## Restore

```sh
sh tools/save-restore.sh <run> <title-id> <uid> saves/botw [--space N --type N]
```

Four steps, in this order, each verified before the next:

1. **pull the current save** to `saves/<title>-pre-restore-<stamp>` — the way back;
2. **build a restore manifest** from the source directory (sha256 + size per file);
3. **write it back** in one transaction, with `--restore --confirm-restore`;
4. **pull again and hash the result** against the manifest.

`--dry-run` builds the manifest and prints the plan without touching the console.

The write is transactional and re-read afterwards: the log shows each path with the
hash that was committed and read back, and any mismatch fails the run.

## Allow-listing a title (required for writes)

Writes are refused unless the title is on the allow list, because a save write is
destructive by nature. The built-in list is the disposable titles this kit was
developed on. Add your own in `config/titles.local.json` (gitignored):

```json
{ "write": [ { "id": "01007ef00011e000", "name": "Breath of the Wild" } ] }
```

That id is BOTW's (US/EU). Check it on the console before trusting it: it is the id
`list-apps` prints, and pulling it is a read-only way to confirm the save opens.

## Limits worth knowing before a BOTW restore

- **Files are replaced, never deleted.** If the current save has a file the backup does
  not, it stays. For BOTW that means restoring an older set does not remove newer save
  slots — delete those on the console first if you want the older state exactly.
- **Directory listings cap at 2048 entries** and reads are 0x40000-byte chunks with a
  console-side hash each. A 4.4 MiB / 289-file archive has worked; a save with one huge
  file has not been exercised.
- **Nested directories now work** (the write stage creates parents), but this is new:
  the first hardware round-trip is the Nora trial test, not a BOTW save.
- **BOTW itself has not been tested here.** It is not installed on this console. What is
  tested is the generic path: discovery (`User/Device` saves included), pull, restore,
  hash verification.
- A failed restore leaves the pre-restore backup on disk and says so. Nothing is
  deleted by a failed write.
