# ns2-savekit

read, back up, restore and modify save data for **any Switch 2 title**, whether
it is installed, on a card, or has no card inserted, over a live
[ns2jb](https://gitlab.com/kurumuz/ns2jb) session. the save path is
not game-specific: it opens a title's save archive, moves files in or out,
commits, and verifies by hash.

the same access is then used for one more thing: an Artemis save can be
retargeted so the game resumes *our* Lua instead of its own script. that is the "save
launch" half (`payloads/`, `tools/artemis-save.py`); the save half works on any
title you own.

the exploit is **not** here. nothing in this repo is exploit code, keys, or game
content.

## what you need

- a **patched** `ns2jb` checkout (the local `~/ns2jb-rpc` checkout, or `run.cjs`
  from ns2jb), an exploit session held open, and the run folder it prints
  (`runs/switch2-XXXXXX`, containing `switch2/ro/root/current-root.json`).
- firmware 23.0.1 and SmileBASIC 4 (retail) to deliver the exploit.
- node (no npm install; nothing to build).

## quick start

```sh
# 0. patch the engine once, before the first run. the host copies engine/ into
#    every run folder at startup, so patch first, then start a new session.
sh patches/apply.sh ~/ns2jb

# 1. start the host and leave it running. <local ip> is THIS computer's LAN ip:
#    the console dials back, so it must be reachable from the switch.
cd ~/ns2jb-rpc && node run.cjs --rpc <local ip>
#   -> run folder: runs/switch2-XXXXXX

# 2. in a freshly opened SmileBASIC, with a.b.c.d = the four octets of <local ip>:
#      RUN
#      REMOVE NSR,&H60000000,&H3FFFFFFF
#      V=START(39380,a,b,c,d,0,0,0,0)

# 3. back here, drive everything from the menu
node tools/kit.cjs                    # newest run folder, or:
node tools/kit.cjs ~/ns2jb-rpc/runs/switch2-XXXXXX
```

the patch step is not optional; skip it only if the checkout already has the
changes. `docs/PATCHED-ENGINE.md` explains what each patch fixes.

## the kit

`tools/kit.cjs` adds no save logic of its own: it shells out to the proven
scripts and prints the exact command before each one.

| menu | what it does |
| --- | --- |
| list | list the files in a save (read-only) |
| backup | pull the save into `saves/<game>/user-<uid>/<timestamp>` |
| replace | write files from a directory, in one transaction |
| delete | remove one file at the save root |
| verify | pull again and compare every file with the backup |
| all saves (a) | list every archive the console's save index knows, cartridge saves included, no titledb |
| pull batch (p) | pull the next pending archives from that inventory (default 5) |
| launcher / editor | Artemis only: install the payload set or the Seedsow Lua Editor save |
| alula launcher | Artemis demo only: install alula's upstream Artemis Launcher against an immutable original baseline, verify it, or roll it back safely (the menu number moves with the title's other entries; read the label) |
| Artemis HTTP (`--http`) | no ns2jb session: health, Lua, stat, download, upload, delete and explicit-file backup over the launcher's port 8080 |

writes are fenced:

- read-only by default; a write needs a prior backup and compares the live
  bytes against it before replacing anything;
- only titles on the allowlist (`config/titles.json`, plus your
  `config/titles.local.json`) can be written;
- one open, one commit, then every file is read back and hashed;
- paths must be `/name`; `..`, nested paths and absolute paths are rejected.

several save operations per boot usually work; restart the console only if one
actually fails. the one thing that reliably breaks the next session is leaving a
previous one open (`--keep-open`, a diagnostic only).

titles are listed from every storage ncm has a database for (internal, sd card,
game card), and named from the console's own control data, not from a catalogue:
that is the only way a switch 2 title gets a name. the name comes out of the
title's control NCA (the read ouncecake falls back to; its ns reader did not answer
on this console), so a japanese title can carry its japanese name. names are cached
in `config/titles.nacp.json`; `--no-names` skips the read.

ncm's list is the **application** list; the save store is a different index.
`save-inventory.cjs` asks fs:srv for every save archive directly, so a title
whose card is out (or whose program was removed) can still have its save listed
and pulled. that is also why a cartridge save survives without the cartridge.

## any title, by hand

```sh
# back up
node tools/save-pull-root.cjs <run> <title-id> saves/botw <uid>
node tools/pull-all.cjs <run> saves/all --batch 4      # every archive it finds
node tools/saves-report.cjs saves/all                  # what was pulled

# whole store: list every archive, then pull from the inventory
node tools/save-inventory.cjs <run> --json saves/inventory.json --names
node tools/pull-inventory.cjs <run> saves/from-inventory \
  --inventory saves/inventory.json --space 1 --type 1

# restore a pulled directory (back up -> write -> pull -> verify, in that order)
sh tools/save-restore.sh <run> <title-id> <uid> saves/botw [--space N --type N]
```

`<uid>` is the 16-byte account uid in hex; `--list-uids` prints them. the pull
prints `mounted space=… type=… uid=…` - read that line, it is how you learn that
the right archive opened. `save-inventory.cjs` is the no-catalogue path: it lists
every archive in the save index and writes JSON; `pull-inventory.cjs` pulls exact
identities from it, five at a time by default (`--limit 0` = all pending), and
resumes from `inventory-progress.json` after a reboot. `docs/RESTORE.md` covers
the restore path and its limits; `docs/SAVE-ARCHIVES.md` covers which archive an
open selects.

## save launch (the Artemis half)

an Artemis slot save stores where execution resumes. retarget that pointer at
`save:/name.asb` and the game resumes there; an ASB is a plain Lua container, so
a few commands put our chunk in front of the engine. a second, zero-edit entry
point is the suspend file: `save_prefix="save"` + `save_suspend=9999` makes the
game look for `save9999.dat` at boot.

- `docs/LAUNCHER.md` - the chain, what is proven on hardware, what is blocked.
- `tools/build-untethered.sh` - build the stub + body + suspend launcher from a
  backup; `tools/inject-launcher.sh` - backup, build, write, pull and verify.
- the stub/body split is built and smoke-tested, not yet installed on hardware.

### alula's Artemis Launcher (a separate launcher)

[alula/switch-artemis-launcher](https://github.com/alula/switch-artemis-launcher)
is a different thing from the payload above: a boot menu with a Hello World slot,
an HTTP Lua server on port 8080 and a `<name>2.lua` update mechanism. kit option
**8** installs it into a supported **demo** save; option 4 is unchanged.

```sh
node tools/artemis-launcher.cjs install <run> --title 010042d022aea000 \
  --uid <uid> --backup <pre-install-backup> --confirm
node tools/artemis-launcher.cjs verify  <run> --title 010042d022aea000 --uid <uid> \
  --backup <pre-install-backup>
node tools/artemis-launcher.cjs restore <run> --title 010042d022aea000 --uid <uid> \
  --backup <pre-install-backup> --confirm-restore
```

- supported titles: `010042d022aea000` (Seedsow demo) and `010012900d38a000`
  (Nora 2 demo). full games and other titles are refused.
- the pinned upstream revision is downloaded at install time and every file is
  checked against a recorded SHA-256; nothing third-party is bundled.
- it writes 7 files: six upstream scripts/font plus a `save9999.dat` rebuilt from
  the game's own suspend save, so no older upstream save container is written
  over yours. `saveg.dat` and `system.dat` are not touched.
- both launchers own `save9999.dat`, so only one can be the boot path at a time.
  the editor's files are not touched and do not collide.
- [docs/ARTEMIS-LAUNCHER.md](docs/ARTEMIS-LAUNCHER.md) has the compatibility
  matrix, the 2026-11-01 hardware report (firmware 23.0.1, Seedsow demo 1.0.0),
  the backup/restore evidence and the known limits - including that the
  minus-at-startup update bypass was **not** observed on demo 1.0.0.

## Artemis HTTP transport (no ns2jb)

The installed Artemis Launcher serves `/status`, `/eval`, `/save` and `/delete`
on port 8080. `tools/artemis-http.cjs` uses only those endpoints, so it works
while the game is running and **no RPC session is held**:

```sh
node tools/artemis-http.cjs discover --subnet 192.168.1
node tools/artemis-http.cjs health   --host <console-ip>
node tools/artemis-http.cjs eval     --host <console-ip> --code 'print("hello world")'
node tools/artemis-http.cjs get      --host <console-ip> --path save:/file.bin --out file.bin
node tools/artemis-http.cjs put      --host <console-ip> --path save:/note.txt --in note.txt
node tools/artemis-http.cjs rm       --host <console-ip> --path save:/note.txt
node tools/artemis-http.cjs backup   --host <console-ip> --out backup/
node tools/kit.cjs --http <console-ip>   # menu for the same transport
```

- downloads are bounded `/eval` hex reads with chunk hashes, a final SHA-256,
  resume state and local atomic promotion;
- uploads are direct `/save` up to the server body cap, or chunked `/eval`
  appends above it (non-atomic: `os.rename` on `save:/` is refused on hardware);
  the reported hash is read back from the console and compared, and an
  interrupted upload is reported as incomplete;
- the backup is **explicit-file, complete:false** - the server has no directory
  listing - so it cannot authorize a destructive full restore;
- protected launcher files are refused for write/delete, and other titles' saves
  are not reachable.

Full details, hardware results (4/16/64 KiB, binary, relaunch) and limitations:
[docs/ARTEMIS-HTTP.md](docs/ARTEMIS-HTTP.md).

## troubleshooting

| what you see | what it means | what to do |
| --- | --- | --- |
| `0x7d402` for every account | the game has not made a save yet | launch it and close it fully (Home -> X -> Close), then retry |
| `0xe02` opening a save | the app hosting the exploit holds its own save (SmileBASIC 4) | pull that title from a session hosted by a different app |
| `0x7d402` for a Cache archive the inventory lists | the archive exists but did not open at rank 0/index 0 | attribute unresolved; leave it for a later probe |
| `could not tell whether … has save data` / `exited without listing anything` | the read-only probe never listed an archive; an older puller called that "no save" (issue #2) | update the tools; the kit now names this instead of calling the save absent |
| `Directory exceeds the N-entry probe limit` | your copy predates the raised limit; the old pull gave up at 2048 entries in one directory | use the current tools (65536 in `tools/lib/save-tree.cjs`); no real save is that busy |
| `INCOMPLETE PULL` (exit 5) | a file in the save refused a read-only open, so it was not pulled | the file is named above and listed as `failed` in `manifest.json`; re-run to retry - the pull is read-only |
| `could not list installed applications` / `could not list accounts` | one of `inventory.cjs`'s two enumerations failed; the lines under it are the child's own error and a hint | follow the hint; an account failure can be worked around with `node tools/inventory.cjs <run> <uid>` |
| `EEXIST …-ncm-system-programs.bin` | the engine checkout is unpatched | `sh patches/apply.sh ~/ns2jb`, then start a new run - an existing run folder keeps the old engine copy |
| `ListAllUsers: transport 0xf601` | the engine has no CMIF pointer descriptors; not a console fault | apply the patches and start a new run |
| `SESSION LOST` / `transport 0xf601` during a pull or write | the console stopped answering | restart the console, reopen SmileBASIC, start a new session |
| `NO LIVE HOST` / `memory.sock` | the session folder is stale or gone | start the host again and use the run folder it prints |
| title listed without `✔` | it is not on your write allowlist | add its id to `config/titles.local.json` |
| names are missing, ids only | the console gave no name for that id (no control data, or the read was refused) and titledb is a Switch 1 catalogue, so it cannot name a Switch 2 title | paste the stub the tools print into `config/titles.local.json`; console names that were read are cached in `config/titles.nacp.json` |

## tests

offline, no console, no network:

```sh
node tests/test_kit_probe.cjs        # kit save detection (5)
node tests/test_inventory.cjs        # inventory reporting (7)
node tests/test_save_attr.cjs        # save attribute packing (9)
node tests/test_save_tree.cjs        # save walk: types, failures, limit (6)
node tests/test_app_storages.cjs     # app list: storages, dedupe (8)
node tests/test_nacp.cjs             # console name block, plain and deflated (9)
node tests/test_console_names.cjs    # ns name read: services, buffers (11)
node tests/test_content_names.cjs    # control-NCA name read (7)
node tests/test_titles.cjs           # name layers and the console cache (10)
node tests/test_restore_manifest.cjs # generic restore path (6)
node tests/test_artemis_launcher.cjs # alula launcher: staging, backups, receipts, rollback (47)
node tests/test_delete_result.cjs    # delete result propagation (14)
node tests/test_artemis_http.cjs     # HTTP transport, chunking, resume (35)
node tests/test_nso_verify.cjs       # NSO0 parsing, LZ4, hashes (13)
node tests/test_smb_meta.cjs         # META name block surgery (5)
sh   tests/test_inject_dryrun.sh     # injection builder/manifest (3)
lua  tests/test_payload_lua.lua      # launcher payload decisions (13)
lua  tests/test_metadata_lua.lua     # name/thumbnail writer (12)
python3 tests/test_offline.py        # save/ASB encoders (8)
```

## layout

```
tools/     pull/write/restore/list/inventory, ASB encoder, launcher builders
payloads/  Lua that runs inside the game: launcher stub, body, metadata
patches/   the engine patches the tools need (apply before the first run)
config/    write allowlist template (local config files are gitignored)
docs/      LAUNCHER, RESTORE, SAVE-ARCHIVES, TECHNICAL, PATCHED-ENGINE, RESULTS
tests/     offline suites; none of them prove console behaviour
```

the controller/esp32 work lives in
[ns2-console](https://github.com/dougchansan/ns2-console); the content/asset
pipeline is in [ns2-assets](https://github.com/dougchansan/ns2-assets).

## credits and licence

our code is MIT (see [LICENSE](LICENSE)). third-party components and links are
listed in [NOTICE](NOTICE): ns2jb (the exploit, linked not vendored), Seedsow Lua
Editor (0BSD; its save is downloaded, never bundled), titledb (MIT, names only),
and the Artemis engine (no affiliation, no game content).
