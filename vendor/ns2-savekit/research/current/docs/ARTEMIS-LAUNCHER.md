# alula Artemis Launcher

An installer for [alula's switch-artemis-launcher](https://github.com/alula/switch-artemis-launcher),
plus the hardware report from installing it through this toolkit's save pipeline.

The launcher is **not vendored**. `tools/artemis-launcher.cjs` downloads the
pinned upstream revision at run time, checks every file it uses against a
recorded SHA-256, and only then stages it. No upstream script, font bytes or game
save is stored in this repository.

| | |
| --- | --- |
| upstream | <https://github.com/alula/switch-artemis-launcher> |
| revision | `b9e6de82934dfda1f2c6219aaf305ed980a3d1ba` (tag `v1`) |
| supported titles | `010042d022aea000` Seedsow Lullaby **Demo**, `010012900d38a000` Nora 2 **Demo** |
| unsupported | the full games, and every other title (refused before a save is opened) |
| installed here | Seedsow Lullaby (demo), installed 2026-11-01 and verified on hardware |

## Three different launchers, deliberately kept apart

| | Seedsow Lua Editor | our ns2jb launcher (kit entry 4) | alula Artemis Launcher (separate kit entry) |
| --- | --- | --- | --- |
| made by | [DialingSpoon527](https://github.com/DialingSpoon527/seedsow-lua-editor) | this repository | [alula](https://github.com/alula/switch-artemis-launcher) |
| gets you | an on-console Lua editor in slots 1-3 | a headless body that runs at every boot | a menu: Hello World slot, HTTP Lua server, update mechanism |
| files | 275, its own slots | `ns2jb.asb`, `ns2jb.lua`, `save9999.dat` | `core.lua`, `inject.iet`, `inject.lua`, `http.lua`, `exploita.lua`, `proggy.ttf`, `save9999.dat` |
| boot trigger | its own slots | `save9999.dat` | `save9999.dat` |
| status | installed and used on hardware | built; its kit entry is unchanged | **installed and tested on hardware** (this doc) |

The editor and the two launchers do not share file names, so the editor's files
survive an Artemis Launcher install untouched. The two launchers **do** share the
one boot trigger, `save9999.dat`, so they are alternatives: installing one
replaces the other's boot path. The existing payload entry is not modified; this
is a separate entry and a separate tool.

## What it writes

Only these seven files, and nothing else:

```
add      /core.lua        the per-game core (upstream seedsow_save/ or nora2_save/)
add      /exploita.lua    upstream Hello World payload
add      /http.lua        upstream remote Lua HTTP server
add      /inject.iet      upstream startup loader + launcher menu
add      /inject.lua      upstream launcher
add      /proggy.ttf      upstream console font
replace  /save9999.dat    rebuilt from the game's own suspend save, retargeted at inject.iet
```

`save9999.dat` is **not** upstream's `common/save9999.dat`. That file is a
version-1002 container made from the upstream author's own save; writing it over
a version-1003 save would replace game state. The installer instead takes the
backup's own `save9999.dat` and uses `tools/artemis-save.py launch` to point its
caret at `save:/inject.iet`, keeping the container version and the resume data.
That is why the installed trigger hashes differently from either input but is
still the game's own file.

`saveg.dat` and `system.dat` are **not** written. Upstream's release contains the
author's copies; ours are the game's current files and are left alone.

## Prerequisites

- a **patched** `ns2jb` checkout, a live RPC session and its run folder
  (`switch2/ro/root/current-root.json` present), as for every other write;
- the target demo installed and launched once, so its save archive exists;
- the title on the write allowlist (`config/titles.local.json` is local and
  gitignored; the public list stays empty);
- the account uid, either passed with `--uid` or present in the local
  `config/uids.json`;
- a **complete, identity-bearing backup** for install/verify/restore. A backup
  pulled by the current `save-pull-root.cjs` records the full program id and
  account uid. Backups made before that change are "legacy": they can be
  inspected and staged, but they cannot authorize a write or a restore (see
  [Backup integrity](#backup-integrity));
- `node` 20+, `python3`, `curl`, `tar` (curl/tar only for the first download).

Firmware and game version:

- **firmware 23.0.1** is the version measured here and the version upstream
  targets. Nothing in this installer checks firmware; the exploit path it depends
  on is the SmileBASIC 4 -> ns2jb one, which is firmware-specific. A different
  firmware is untested.
- **Seedsow Lullaby Demo Ver. 1.0.0** is the build measured here. Its `main`
  matches the offsets in upstream's `core.lua` (verified by disassembly of the
  dumped `main` and by running it: `main @`, `sdk @`, `running on: Ounce`).

## Using it

From the kit (`node tools/kit.cjs`, pick a supported demo). The entry is the one
labelled **`Install alula Artemis Launcher`**. Its number is **not fixed**: the
kit inserts or omits entries by title, so on this save the list is

```
1) List files in this save (read-only)      [save op]
2) Save: back this save up                   [save op]
3) Replace: write files from a directory     [save op]
4) Install payload files (Artemis launcher)  [save op]   <- our ns2jb launcher
5) Install the Seedsow Lua Editor save       [save op]
6) Delete a file (optional)                  [save op]
7) Verify: compare the save with what we wrote [save op]
8) Install alula Artemis Launcher            [save op]   <- this installer
9) Back to the title list
```

but a title with no Artemis files shows only entries 1-3 plus delete/verify/back,
and the alula entry itself appears only for the two supported demos. Read the
label, not the number.

Selecting it backs the save up first if there is no backup yet, shows the plan
(every file with its size and hash, add vs replace), and writes only after `y`.
Then it pulls the save again and checks every entry against the manifest, and it
records an installation receipt.

By hand:

```sh
# build the plan from a local backup with a verified checkout (no console)
node tools/artemis-launcher.cjs plan \
  --title 010042d022aea000 \
  --backup saves/Seedsow-Lullaby-demo/user-<uid8>/<timestamp> \
  --source /path/to/verified/switch-artemis-launcher

# install; --confirm is the explicit write authorization
node tools/artemis-launcher.cjs install <run> \
  --title 010042d022aea000 --uid <32-hex> \
  --backup saves/Seedsow-Lullaby-demo/user-<uid8>/<timestamp> --confirm

# pull again and compare against the manifest
node tools/artemis-launcher.cjs verify <run> --title 010042d022aea000 --uid <32-hex> \
  --backup saves/Seedsow-Lullaby-demo/user-<uid8>/<timestamp>
```

`install` checks `--confirm` before it pulls or stages anything; use `plan`
(or `install --dry-run`) to inspect without authorizing. Exit codes: `0` done
and verified, `2` bad usage / missing authorization, `3` session lost, `4` no
live host, `5` unsupported title, `6` missing or invalid prerequisite (no
backup, legacy backup, no upstream), `7` conflict, `8` verification failed.

The download cache is `~/.cache/ns2-savekit/artemis-launcher/<commit>/`. Every
use re-hashes the files, so a cache edit is refused rather than installed.
`--source` accepts a local checkout for offline use, with the same hash gate.
`ARTEMIS_CACHE` moves the cache.

### Staging

Rebuilding the payload never deletes an arbitrary directory:

- staging lives under `<repo>/staging/alula-artemis/<title-id>` or the OS temp
  directory; `--out` must resolve inside one of those. The repository root, the
  home directory, the filesystem root and unrelated existing directories are
  refused;
- an existing staging directory is only replaced when it carries
  `.artemis-staging.json` for the same title. It is built in a marked sibling,
  then promoted with `rename()`;
- a failed build discards only that sibling. The previous staged payload and its
  manifest are left byte-for-byte intact;
- symlinked targets and symlinked parents that escape the allowed roots are
  refused;
- an unmarked staging directory from an older version is adopted only if it
  contains exactly the expected files, every launcher file matches the pinned
  release and the trigger parses as our retarget. Adoption writes the marker;
  it never deletes or overwrites unrelated content.

## Backup integrity

Every write and restore is authorized by a backup, so a directory name is not
enough. `tools/lib/artemis-backup.cjs` checks all of this before a console
operation, for staging, install, verify and restore alike:

- `manifest.json` parses, lists a non-empty `entries` array, `partial` is not
  true, and `failed` is empty;
- the `files` count and `bytes` total agree with the entries;
- every path is a safe flat save path, with no duplicates;
- every entry names a regular file (not a symlink) whose size and SHA-256 match;
- the boot trigger exists in the backup and matches its entry;
- for install/verify/restore, the manifest records the full 16-hex program id
  and 32-hex account uid, and they match `--title` / `--uid`.

The truncated `uid=...` in the human-readable `archive` line is **not** identity:
two accounts can share that prefix. A legacy backup without full identity is
refused for install/verify/restore with a message to pull a new backup.

## Original baseline and update records

A backup proves the "before" state. It does not prove that a file now on the
console was written by this installer - the user may have edited a launcher
script, or a second installation may be present. There are two record kinds,
kept apart on purpose:

- **original** - the state before the *first* Artemis install. Written once with
  an atomic create-if-absent (`link`), never replaced. It is the rollback
  baseline: backup path + manifest SHA-256 + trigger SHA-256 + identity, the
  installed file list with `add|replace` and original hashes, and timestamps.
- **transaction** - one install/update/restore attempt. A reinstall writes a new
  transaction; it never touches the original. It records the pre-state snapshot,
  the expected installed files, a link to the original (`originalSha256`) and
  restore progress (`trigger`, `deleted[]`).

Location (0700, files 0600, override `ARTEMIS_STATE`; never committed, contains
the full account uid):

```
~/.local/state/ns2-savekit/artemis-launcher/receipts/
  <title-id>-<sha256(title:uid)[0:16]>.original.json
  <title-id>-<sha256(title:uid)[0:16]>.transactions/<timestamp>-<rand>.json
  <title-id>-<sha256(title:uid)[0:16]>.json          # first design, read-only
```

A receipt written by the first version of this tool is adopted into the new
original record (copied, not re-derived) the first time the new code sees it.

### First install, reinstall and updates

- The **first install** validates that its backup does not already contain the
  pinned launcher (a post-install snapshot is refused as a baseline), writes the
  immutable original record, then performs the console transaction. If the
  console write is interrupted, the baseline still describes the true pre-install
  state and a retry completes the install.
- A **reinstall** pulls the live save read-only and stages against it. If every
  staged file already matches the live save, it verifies and stops: no write, no
  transaction, original unchanged. Otherwise it writes a transaction, performs
  one commit, and records success or `install-failed`. The original is never
  rewritten, so rollback still targets the pre-first-install state.
- A failed update leaves the original baseline and its backup intact; the
  transaction records the failure.

## Conflicts

- **Another file with a launcher name already exists in the save** (for example a
  user's own `core.lua`): the plan reports it and the install exits `7`. Only
  `save9999.dat` may be replaced.
- **`save9999.dat` is missing**: exits `6`. That save has no suspend trigger, so
  this launcher has no way to run.
- **A launcher file was modified after installation**: restore reports
  `modified` and refuses to delete it. The same applies to a missing file, an
  unexpected launcher-named file, or a trigger that matches neither the
  installed nor the restored hash.
- **Our ns2jb launcher is installed**: both use `save9999.dat`. Installing
  Artemis Launcher replaces the boot path; `ns2jb.asb`, `ns2jb.lua` and
  `sscode004.lua` stay in the save. Restoring the pre-install `save9999.dat`
  brings the ns2jb boot path back.
- **The Seedsow Lua Editor** is not touched: none of its files collide. While
  Artemis Launcher owns the boot trigger the game does not reach its own slot
  menu, so the editor is only reachable again after a restore.
- **Upstream update files** (`core2.lua`, `http2.lua`, `inject2.lua`) are
  reported during restore and never deleted: they are not ours.

## Verification

After the write the installer pulls the save again and runs
`tools/verify-save-manifest.cjs` against the staged manifest. A manual check:

```sh
node tools/save-pull-root.cjs <run> 010042d022aea000 /tmp/check <uid> --space 1 --type 1
node tools/verify-save-manifest.cjs /tmp/check staging/alula-artemis/010042d022aea000/manifest.json
```

The save-level proof is stronger than "the files are there": compare the
pre-install backup with the post-install pull. In the hardware run below, exactly
six files were added, one was replaced, and **289 files were byte-identical**.

## Rollback

Restore always targets the state before the **first** install, using the
immutable original record (not the latest post-install snapshot). It first reads
the live save (read-only) and compares it with every recorded state:

```sh
# preflight only: pull, compare, print the plan, change nothing
node tools/artemis-launcher.cjs restore <run> --title 010042d022aea000 --uid <32-hex>   --confirm-restore --dry-run

# perform it
node tools/artemis-launcher.cjs restore <run> --title 010042d022aea000 --uid <32-hex>   --confirm-restore
```

The staged boot trigger is written into a private temporary directory and the
writer is run with that directory as its working directory, because the manifest
names the trigger relatively. Restoration therefore behaves the same from any
operator directory; the staging directory is removed on success, failure or
exception. Order of operations: validate the original record and its backup;
pull the live save; find the recorded state it matches (original install, any transaction's
post-state or pre-state); refuse if a launcher file was modified, is missing, or
an unowned launcher file appears; mark a restore transaction `restoring`; write
the original backup's `save9999.dat`; delete only the files the first install
added; pull again and check the trigger equals the original backup and every
added file is gone; mark the transaction `restored`.

If a launcher file was edited after installation, restore reports `modified` and
does not delete it. If a deletion fails, the trigger is already restored (the
game boots normally), the transaction records `restore-failed`, and re-running
resumes: removed files are skipped and the preflight verifies what is left.

`save-delete-root` exits non-zero when `DeleteFile` fails, reopens the file
read-only and checks the root listing to prove it is absent; a missing file exits
`10`, which restore treats as already done. A successful deletion requires
`DeleteFile == 0`, an explicit successful commit and a verified-absent
read-back; a missing commit result is never treated as success. A successful deletion requires
`DeleteFile == 0`, an explicit `Commit == 0` and a verified-absent read-back; a
missing commit result is never treated as success. The canonical FS result for "not
found" is `0x202` (module 1, description 2, the same value
`save-write-stage.cjs` checks); a bare `0x2` is an unknown result and fails
closed.

`--uid` may be omitted when exactly one record exists for the title. If
`--backup` is passed it must be the original baseline's backup: a later snapshot
is refused rather than substituted.

### Installs made before records (legacy migration)

An installation made before the record system has no original baseline. Adopt it
conservatively instead of inventing one:

```sh
node tools/artemis-launcher.cjs migrate-legacy \
  --title 010042d022aea000 --uid <32-hex> \
  --backup <pre-install backup> \
  --snapshot <read-only pull of the installed save> \  # or pass a run directory
  --confirm-migration
```

`migrate-legacy`:

1. validates the original backup (sizes, SHA-256, trigger);
2. verifies the installed payload against the pinned upstream files;
3. verifies the installed trigger equals the deterministic retarget of the
   original backup's trigger;
4. establishes the full uid from independently verified evidence - an
   identity-bearing live pull, or the local `config/uids.json` entry - and never
   from the truncated `uid=` label;
5. writes an immutable original record plus a migration attestation that names
   the evidence, and leaves the original backup byte-for-byte untouched.

It refuses if the snapshot is missing a launcher file, differs from the pinned
release, has the wrong trigger, or if identity cannot be established. No
destructive operation runs during migration.

After migration, restore accepts the identity-less legacy backup **only**
through a dedicated validation path: the backup's manifest SHA-256 and trigger
must equal the immutable original record, the record's title/account must match,
the installed payload must equal the pinned release, the trigger must equal a
freshly recomputed deterministic transformation, and the migration attestation
must name the same backup, trigger, installed-snapshot manifest, identity
evidence and pinned upstream revision. A modern identity-bearing backup still
goes through the strict identity check. Neither path invents identity or
modifies the legacy backup.

After migration, restore accepts the identity-less legacy backup **only**
through a dedicated validation path: the backup's manifest SHA-256 and trigger
must equal the immutable original record, the record's title/account must match,
the installed payload must equal the pinned release, the trigger must equal a
freshly recomputed deterministic transformation, and the migration attestation
must name the same backup, trigger, installed-snapshot manifest, identity
evidence and pinned upstream revision. A modern identity-bearing backup still
goes through the strict identity check. Neither path invents identity or
modifies the legacy backup.

Without a record, `restore` refuses automatic cleanup. The only fallback is
`--adopt-legacy`, which independently establishes ownership by requiring every
live launcher file to equal the pinned release and the live trigger to match the
deterministic retarget; anything else is refused. It writes no record.

## Temporary hardware-test files

The 2026-11-01 recovery experiment staged `save:/inject2.lua` (an update file
that writes `save:/inject2-ran.txt`) to prove whether the minus-at-startup bypass
worked. Both were **removed from the save** on 2026-11-01 at 21:19 via the
launcher's HTTP `DELETE`, and a live `/eval` at 22:50 confirmed both are still
absent (`inject2.lua ABSENT`, `inject2-ran.txt ABSENT`, transcript section 10).
They are not deleted automatically by any tool; if a later experiment leaves
them, remove them with the save you are authorised to write:

```sh
curl -X DELETE 'http://<console>:8080/delete?path=save:/inject2.lua'
curl -X DELETE 'http://<console>:8080/delete?path=save:/inject2-ran.txt'
# or, through the toolkit's session:
node tools/save-delete-root.cjs <run> 010042d022aea000 <uid> /inject2.lua
node tools/save-delete-root.cjs <run> 010042d022aea000 <uid> /inject2-ran.txt
```

Leaving them does not break the game (the restored trigger no longer loads the
launcher), but `inject2.lua` would override `inject.lua` on a future install of
this launcher.

## Hardware test report — 2026-11-01

Environment: retail Switch 2, firmware **23.0.1** (`docs/images/2026-11-01-console-firmware-23.0.1.png`),
Seedsow Lullaby Demo **Ver. 1.0.0** (`docs/images/2026-11-01-seedsow-demo-version.png`),
the demo's own account (uid not recorded in this repository), ns2jb-rpc session `switch2-rIh6OU`
(dial-back from the console, so no console IP is baked into anything here).
Upstream revision `b9e6de82934dfda1f2c6219aaf305ed980a3d1ba`.
The sanitised command/output transcript is
[`artemis-launcher-2026-11-01.txt`](artemis-launcher-2026-11-01.txt).

| test | result | evidence |
| --- | --- | --- |
| A. launcher screen at boot | **pass** | `docs/images/2026-11-01-artemis-launcher.png` — "switch-artemis-launcher by alula", A/B/Y menu, Proggy font |
| B. slot A Hello World | **pass** | `docs/images/2026-11-01-artemis-hello-ounce.png` — core init, arb r/w, `main @ 0x2e24206000`, `sdk @ 0x2e581bb000`, `running on: Ounce`, then `hello world` |
| C. remote Lua server | **pass** | `docs/images/2026-11-01-artemis-http-server.png`; `GET /status` -> 200; `POST /eval print("hello world")` -> `status: ok / output: hello world`; `print(_G.n2h.platform)` -> `Ounce` |
| D. save upload/delete | **pass** | `PUT /save?path=save:/artemis-probe-20261101.bin` -> 51 bytes; read back equal; `DELETE` -> deleted; follow-up read -> `GONE` |
| E. memory / native interface | **pass** | arb r/w self-test, module base leaks, `svcGetInfo` platform check -> `Ounce`, `TPIDRRO_EL0` read; all non-destructive |
| F. persistence | **partial** | close + relaunch -> launcher again; full power cycle + relaunch -> launcher again; minus at the menu -> recovery mode; **startup minus skip-update not observed** |
| G. compatibility | **pass, with a documented conflict** | editor files byte-identical (289 unchanged); boot trigger is single-owner, so ns2jb boot is displaced until restore |

The HTTP server and the installation were re-checked on 2026-11-01 22:32
without an RPC session: `/status`, `/eval` (`hello world`, `Lua 5.1`, `Ounce`),
a uniquely named save file written/read/deleted, protected-file and traversal
refusals, close+relaunch, and a byte-for-byte hash match of all seven installed
files against the staged payload (transcript section 9).

Save evidence:

- pre-install backup `saves/Seedsow-Lullaby-demo/user-<uid8>/2026-11-01_2055`:
  **290 files, 4,665,778 bytes**, per-file SHA-256 in its `manifest.json`;
- install: **7 files, 104,236 bytes**, `commit -> 0x0`, seven read-back hashes
  match the manifest;
- post-install pull: **296 files**; diff against the backup = 6 added
  (`core.lua`, `exploita.lua`, `http.lua`, `inject.iet`, `inject.lua`,
  `proggy.ttf`), 1 replaced (`save9999.dat`, `d149d71b…` -> `ca472410…`),
  **289 unchanged**.

Staged hashes (SHA-256):

```
core.lua      54d25862dc0d796985ebe69f34a345df16671c97372d67062769d28c293d4ed6
exploita.lua  a84bb1230b2edd73f469afd5aba69b3ca191e6c25b444cf93d23342b64d6af18
http.lua      2985b8f7040fc40c7e2c18e5cf857c3c5d14c0b9d081ef0a1a8742eab6f026a1
inject.iet    bf79a739584de93d1569523a8a87e7ef8ce65edcf073b5d2ba37453c4085ada4
inject.lua    fcc6b5877084df15b45dfbd8c955ee4f802add7030f1c98f3006794f8949a08b
proggy.ttf    527d2a443ce051f93f7e77b855609722b8cb220a9f104b4aa037be5c90b71324
save9999.dat  ca47241097a250615e6a1a5c263f86b16729691d91740754a791c6006e1cd63c
              (rebuilt from the backup's d149d71bf87f160825084c952575c620802ca562db894962be2ca0cc818ab342;
              full hash in the staging manifest)
```

### Rollback hardware validation

The destructive restore path has **not** been run on hardware: three controlled
ns2jb acquisitions on 2026-11-02 failed at stage 2/4 before any save operation.
See [ARTEMIS-ROLLBACK-HARDWARE.md](ARTEMIS-ROLLBACK-HARDWARE.md) for the attempt
log, the blocked test matrix and the remaining hardware requirements. Offline
restore tests pass, but they are not a hardware validation.

### Review-fix validation status (2026-11-01, after the hardware run)

The staging, receipt, backup-integrity and delete-propagation fixes landed after
this hardware run. No live RPC session could be obtained: six fresh-boot
acquisitions failed at ns2jb stage 2/4, each with a different timing miss.

1. `Native batch did not terminate; resources retained`
2. `Clean alias did not qualify within its attempt limit`
3. `The bounded native leak contains no qualified, encodable link`
4. `General-heap allocation changed while the cache was retained`
5. `Overwrite missed the qualified canary`
6. `Native batch did not terminate; resources retained` (second occurrence)

A further attempt used `NS2_TMP_FALLBACK=1` after a fresh power cycle; the tmp
mount was above the fallback threshold, so that path was not the cause. The
console was restored to the HOME menu by a power cycle after each wedged
attempt; no save operation was issued in any of them, so nothing on the console
changed. Validation for the new destructive paths is therefore **offline only**
(47 installer tests + 14 delete-result tests). Still to prove on hardware: a
fresh identity-bearing pull feeding a receipt; receipt-driven restore
preflight/`--dry-run`; refusal of a modified launcher file; `save-delete-root`
propagation; and the post-rollback pull.

What *was* re-validated on hardware without a session (22:32): the installed
launcher still boots, persists across close/relaunch, and its HTTP server
answers `/status`, `/eval`, save upload/read/delete and the protected-file and
path-traversal refusals. All seven installed files hash identically to the
staged payload (transcript section 9). This proves the installation was not
disturbed by the review work; it does not exercise the receipt/restore code.

The Seedsow installation described above predates receipts, so its rollback uses
the conservative `--adopt-legacy` path (live bytes must equal the pinned release)
rather than a receipt-driven restore.

### What remains untested

- **Nora 2 demo** (`010012900d38a000`): the code path is implemented and unit
  tested, but no hardware install was performed in this session. A later
  hardware attempt (2026-11-01 21:40-21:50) stopped **before** the installer
  ran: ns2jb's stage-2/4 FS-root acquisition failed twice on fresh boots
  (`Native batch did not terminate; resources retained`, then `Clean alias did
  not qualify within its attempt limit`). No Nora save was opened or written;
  the Seedsow installation was untouched.
- **Startup update bypass** (minus held through resume): not effective on demo
  1.0.0 in two attempts. Upstream's fail-safe should be treated as unverified.
- **Other firmware** and other demo builds: only 23.0.1 / Ver. 1.0.0 measured.
- **The full games**: unsupported upstream and refused by this installer.
- **Long-term behaviour**: measured across a close/relaunch and one cold boot,
  not across many boots.

## Security notes

- The HTTP server is **unauthenticated** and listens on TCP 8080. Keep the
  console on a trusted, isolated LAN; never forward the port.
- `POST /eval` is arbitrary Lua inside the game. It is not a sandbox.
- `/eval` can write files under `save:/`; upstream protects the launcher files
  (`core.lua`, `inject.iet`, `inject.lua`, `http.lua`, `proggy.ttf`,
  `save9999.dat`, `saveg.dat`, `system.dat`) from `/save` and `/delete`.
- This is save-based persistence: the launcher runs when *this game* loads. It is
  not a cold-boot jailbreak and does not survive deleting the save.

## Credits

- [alula/switch-artemis-launcher](https://github.com/alula/switch-artemis-launcher) —
  the launcher, the exploit chain, the HTTP server and the update mechanism. Not
  vendored; downloaded and verified at install time.
- Upstream's own credits: [n0llptr/remote_lua_loader](https://github.com/n0llptr/remote_lua_loader),
  [Gezine/ArtemisLuaLoader](https://github.com/Gezine/ArtemisLuaLoader), and the
  Proggy Clean TT font by Tristan Grimmer (redistributed by upstream, downloaded
  here, not bundled).
- [ns2jb](https://gitlab.com/kurumuz/ns2jb) — the exploit that provides the save
  session every write goes through.
