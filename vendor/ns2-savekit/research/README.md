# ns2-savekit

Read, back up, install and modify **save data for any installed Switch 2 game**,
driven over a live [ns2jb](https://gitlab.com/kurumuz/ns2jb) RPC connection.
Nothing in the save path is game-specific: it opens a title's save archive, moves
files in or out, commits, and verifies by hash.

The second half of the repository applies that same save access to one engine:
Artemis. There, a save file's execution pointer can be retargeted so the game
resumes *our* Lua instead of its own script — code execution from save data
alone. That part is engine-specific and lives in `payloads/` and
`tools/artemis-save.py`; everything else works on any title you own.

The exploit itself is **not** in this repository. We link to upstream rather than
vendor it, so this tree contains no exploit code, no keys, and no game content.

## What is proven, on hardware

Every claim below was executed on a retail Switch 2 with the demo and full game
installed, and the numbers are reproducible from the commands in
[docs/RESULTS.md](docs/RESULTS.md).

| Result | Evidence |
| --- | --- |
| Read another title's save through the promoted `pid=1` fsp-srv root | 70-file / 2.0 MB pull of `0100ee5021c9e000`, byte-verified |
| Write another title's save in one committed transaction | 275 files, 4,511,900 bytes, read back and hashed |
| Run arbitrary Lua inside a shipping Artemis game from save data alone | `ns2jb-report.txt` written by the game's own interpreter |
| Install a third-party save with no JKSV, no Switch 1, no Nintendo transfer | Seedsow Lua Editor v0.1.2 running from slot 1 |
| Full unsandboxed Lua 5.1 inside the game | `io`, `os`, `debug`, `package`, `loadstring`, `dofile` all present |

## Any title, not just Artemis

The `tools/` scripts take a program id and an account uid; they do not know or
care what engine the game uses.

| Job | Tool |
| --- | --- |
| Back up any title's save | `save-pull-root.cjs` (read-only, no commit) |
| Restore, update, mod, or install a save someone else built | `save-write-stage.cjs` (one open, one commit, per-file hash verify) |
| List what is in a save without pulling it | `save-pull-root.cjs --list-only` |
| Remove one file | `save-delete-root.cjs` |
| Find which account owns a save | `find-save-uid.cjs`, or pass the uid yourself |
| See what exists | `list-apps.cjs` |

Artemis is where we prove the harder half — running code from a save — but a
save backup/restore/mod workflow needs nothing Artemis-specific, and the same
code installed the 275-file Seedsow Lua Editor save byte-for-byte.

A title can own more than one archive: an Account save per user, a common
Account save (`uid 0`), and Device/Bcat/Cache archives. The pull opens the first
that exists by default; `--all` pulls every one into its own subdirectory, and
`--space/--type/--rank/--index/--static-id` target a specific attribute. See
[docs/SAVE-ARCHIVES.md](docs/SAVE-ARCHIVES.md) for the attribute matrix and why
the save's own directory layout (BOTW's slot folders, album, compendium) needs no
per-game handling.

## The two mechanisms

**1. Save access (`tools/`).** The exploit hands us a session whose fsp-srv root
runs as `pid=1`. That root passes the save-data access check that a normal
application session fails with `FS 6400`, so we can open any whitelisted title's
save, read it, write new files into it, commit, and verify by re-reading.

**2. Save launch (`payloads/`, `tools/artemis-save.py`).** An Artemis slot save
records where execution resumes:

```
caret = { flags, ?, script-path, command-index, ?, ?, command-record }
```

Retarget `script-path` at `save:/name.asb` and the game resumes there instead of
its own script. `.asb` files are a plain-text Lua container (`ASB\0\0`, a command
count, then `lua` / `calllua` / `wait` / `stop` records), so a four-command file
puts our own chunk in front of the engine. The header names from
`system/table/list_switch.tbl` give a second, zero-edit entry point:
`save_prefix="save"` with `save_suspend=9999` makes the game look for
`save9999.dat` at boot and resume it — that file is the launcher, and the game
does not delete it when the caret has been retargeted.

## Safety model

Writes are the only dangerous operation, and they are fenced:

- **Read-only by default.** `save-pull-root.cjs` uses fsp-srv command 53 and
  never commits.
- **Disposable titles only.** A hard-coded whitelist; anything else is refused
  before a handle is opened.
- **Backup required.** Every write needs a prior pull directory; the target is
  compared against it before it is touched.
- **Add-only unless explicit.** New files are added; existing files may only be
  replaced when the manifest marks them and the live bytes still hash to the
  backup copy.
- **One transaction.** All files are written under a single open, one commit,
  then re-opened read-only and every file is hashed back.
- **Save-root only.** Paths must be `/name`; `..`, nested paths and absolute
  paths are rejected.

**Several save operations per session are fine.** Seven ran back to back in one
boot (four archive pulls plus three absent probes) with the session still live, and
a pull + write + verify sequence before that. Restart the console only if an
operation actually fails. The one thing that reliably breaks the next session is
`--keep-open`, which leaves the previous one alive - it exists as a diagnostic, not
for normal use.

## Quick start

Three things are needed before anything else: a **patched** ns2jb checkout, an
exploit session held open, and this checkout. The exploit is not part of this
repository - get it from [ns2jb](https://gitlab.com/kurumuz/ns2jb) and keep it in
its own directory.

```sh
# 0. From this checkout: patch the engine before the first run.
#    Without this, list-apps fails with EEXIST (…-ncm-system-programs.bin) and
#    the account lookup fails with "ListAllUsers: transport 0xf601".
#    See docs/PATCHED-ENGINE.md.
sh patches/apply.sh /path/to/ns2jb

# 1. In the ns2jb checkout: start the exploit and leave it running.
#    <LOCAL RPC IP> is the local IP of THIS computer, not the console: the console
#    dials back to it, so it must be an address the Switch can reach.
cd /path/to/ns2jb
node run.cjs --rpc <LOCAL RPC IP>
#    -> Run folder: runs/switch2-XXXXXX
#    then, in a freshly opened SmileBASIC, with a.b.c.d = the four octets of <LOCAL RPC IP>:
#      RUN
#      REMOVE NSR,&H60000000,&H3FFFFFFF
#      V=START(39380,a,b,c,d,0,0,0,0)

# 2. Back here: drive everything else from the guided menu.
cd /path/to/ns2-savekit
node tools/kit.cjs
```

The patch step is not optional (skip it only if the checkout already has the
changes), and it must happen **before** `run.cjs` starts: the host copies
`engine/` into the run folder at startup, so a folder created earlier keeps the
unpatched code. Patch, then start a new session and use the new
`runs/switch2-XXXXXX`.

`kit.cjs` finds the newest held session (or takes one as an argument) and opens
straight onto the thing you pick from - the installed titles, with names, ids and
write permission in one view:

```
9 installed applications  (✔ = write-allowed)
---------------------------------------------
  [1] ✔ Nora to Oujo to Noraneko Heart 2 (trial)  (010012900d38a000)
  [2] ✔ Seedsow Lullaby (demo)                     (010042d022aea000)
  [3] ✔ Wagamama High Spec (trial)                 (01005eb012fe2000)
  [4]   Pokémon Sword + Pokémon Sword Expansion Pass (0100abf008968000)
  [5]   SmileBASIC 4 (demo)                        (0100b4b00f9f6000)
  [6]   SmileBASIC 4                               (0100c9100b06a000)
  [7] ✔ Seedsow Lullaby (full)                     (0100ee5021c9e000)
  [8]   Nintendo Switch Sports Resort              (04008e001f098000)
  [9]   Mario Kart™ World                          (0400c3f00006e000)

Number 1-9 (blank = quit):
```

Press **`i`** at that prompt for the read-only inventory instead - every archive,
every account, with size and state (`ok`, `sparse`, `empty`), which is the quickest
way to see what is worth pulling before touching anything:

```
  game                                          user  files      size  state  id
  ✔ Seedsow Lullaby (demo)                        1    289     4.4M  ok     010042d022aea000
  ✔ Seedsow Lullaby (full)                        1     75     2.0M  ok     0100ee5021c9e000
    Mario Kart™ World                             1      1     0.8M  sparse 0400c3f00006e000
  ✔ Nora to Oujo to Noraneko Heart 2 (trial)      1     10     0.1M  ok     010012900d38a000
    Pokémon Sword + Pokémon Sword Expansion Pass  2      0     0.0M  empty  0100abf008968000
```

`node tools/inventory.cjs <run-directory>` runs it standalone.

Pick a number and that save's options open; asking for the account uid only if it
is not already remembered:

```
Seedsow Lullaby (demo)  (010042d022aea000)
  (each entry opens the save once; several in a row usually work - restart if one fails)
  1) List files in this save (read-only)      [save op]
  2) Save: back this save up                   [save op]
  3) Replace: write files from a directory     [save op]
  4) Install payload files (Artemis launcher)  [save op]
  5) Install the Seedsow Lua Editor save       [save op]
  6) Delete a file (optional)                  [save op]
  7) Verify: compare the save with what we wrote [save op]
  8) Back to the title list
```

**`4` is not ready yet.** The payload files it writes are built and pass a local
smoke test against a mock engine, but they have **not been installed on hardware
yet**, so nothing claimed in this README depends on them. `5` is the install that
has been run end to end on a console; see [Next: untethered](#next-untethered).

Everything marked `[save op]` opens the save, so **each may be used once per
console boot** - the marker, and the line above the menu, are there so you pick
the one you need instead of discovering the limit when the second one crashes the
host.

That menu is walked through end to end in the
[worked example](#worked-example-install-the-seedsow-lua-editor-save); the rest of
this section is the reference for what each entry does.

The two install actions **back the save up themselves** if you have not backed it
up yet, so installing the editor save or the payload files is one choice rather
than "back up, then install": the backup is taken inside the same action, then the
files are built from it and written in one commit.

The editor install also **fetches its own release** when the directory is missing
or empty - `tools/fetch-editor-save.sh` pulls the official 0BSD zip from GitHub
into `~/.cache/ns2-savekit/seedsow-editor`, so there is nothing to download by
hand. Point it at an existing directory only if you want a specific copy.

Step 3 is the generic one: point it at any directory of files - a save backup from
another console, the editor's release, a mod - and it builds the manifest, marks
what already exists as a verified replace, and writes it in one commit.

Every action prints the command it runs, shows the file list and asks before
writing, and `7` pulls the save once and compares it byte-for-byte with the
staging directory to prove the write landed.

**Verify is itself a save operation**, so it cannot follow a write in the same
boot: the order is back up -> write -> restart the console -> verify as the first
operation of the next boot. The menu says so, and refuses to quietly attempt a
second operation.

Session folders are looked for in `$NS2_RUNS`, `./runs`, a sibling
`ns2jb-rpc/runs` or `ns2jb/runs`, and `~/ns2jb-rpc/runs` / `~/ns2jb/runs`.

### The two installs are different things

They share the mechanism - write files into a save so the game runs Lua - but the
artefacts and the purpose differ.

| | option 4: payload files | option 5: Seedsow Lua Editor save |
| --- | --- | --- |
| what | 4 files: `ns2jb.asb` (stub), `save9999.dat` (launcher), `ns2jb.lua` and `sscode004.lua` (body) | 275 files: `sed01-03.asb`, `ssedit1-3.lua`, `ssseed*.bin`, `ss*.asb`, slots 1-3 launchers |
| who made it | this repository | [DialingSpoon527's editor](https://github.com/DialingSpoon527/seedsow-lua-editor) (fetched, not bundled) |
| gets you | headless: our body runs at every boot, no UI, no console authoring | a console-side editor: type Lua with the game's keyboard, slots 4-120, Save + publish |
| footprint | replaces nothing but slot 4 | replaces slots 1-3 and adds its own files |
| status | **not yet installed on hardware** (mock-engine smoke test only) | installed and verified on hardware: 275 files, 4,511,900 bytes, every hash read back |

**Order matters if you want both.** Install the editor first (it writes slot 4's
hello example), then the payload (which takes slot 4 for its body). Do it the
other way round and the editor's install puts the example back, and the stub will
happily run "Hello from a persistent Lua slot!" instead of your payload. Having
both is the intended end state: the editor authors `sscode004.lua`, the stub runs
it at boot.

### First run: two things you set, nothing ships

Nothing about anyone else's console is in this repository:

- **`config/titles.json` is a template.** Its `write` list is empty, so on a fresh
  clone every title appears *without* a ✔ and every write is refused. Copy the ids
  you are willing to write to into `config/titles.local.json` (gitignored) and they
  start showing ✔:

  ```json
  { "write": [ { "id": "010042d022aea000", "name": "Seedsow Lullaby (demo)" } ] }
  ```

  Reads, backups and the editor install's *source* need none of this - only writing
  into a save does.

- **`config/uids.json` starts empty.** A save archive is keyed by title *and*
  account, so the first title you touch asks which user owns the save:

  ```
  saves found for 3 users
  Which save do you want?
    1) user 1   539fd277…3664
    2) user 2   6cd51710…3664
    3) user 3   e3f05df2…3664
    4) all of the above (one folder per user)
  ```

  The slots come from the console's account service, not from a list. With a
  single account there is no prompt at all - the kit prints `save found for user 1
  (539fd277…3664)` and carries on - and any answer is remembered per title, so it
  asks once per title at most. The `all of the above` entry applies to backups: it
  probes each account read-only and pulls only the ones that actually have a save.

### Console input over WiFi (no kernel extension)

The Mac cannot present a USB keyboard without an unsigned kernel extension, and on
some macOS builds no matching KDK exists, so input runs on an ESP32-S2 instead: the
Flipper WiFi Devboard flashed with `tools/esp32_hid/` is a USB keyboard for the
console and an HTTP endpoint for us at the same time.

```sh
node tools/hid-type.cjs http://<devboard-ip> --status
node tools/hid-type.cjs http://<devboard-ip> 'PRINT 1'
node tools/hid-type.cjs http://<devboard-ip> --stdin < bootstrap.txt
```

Flashing, when the board is in BOOT+RST download mode:

```sh
cd tools/esp32_hid
arduino-cli compile --fqbn esp32:esp32:esp32s2 --export-binaries esp32_hid.ino
arduino-cli upload  --fqbn esp32:esp32:esp32s2 -p /dev/cu.usbmodem* esp32_hid.ino
```

The board prints nothing to the Mac; find it by scanning for its endpoint:

```sh
# <SUBNET> is <LOCAL RPC IP> without its last octet (10.0.0.42 -> 10.0.0)
seq 1 254 | xargs -P 64 -I{} sh -c 'curl -s -m 1 http://<SUBNET>.{}/status \
  2>/dev/null | grep -q "\"ok\":true" && echo <SUBNET>.{}'
```

SmileBASIC inverts letter case on USB keyboards; the firmware applies that rule, so
text goes through `/type` rather than raw HID codes.

## Worked example: install the Seedsow Lua Editor save

The whole install is one guided session: `tools/kit.cjs` picks the title, finds
the account, takes the backup the write requires, fetches the editor release and
writes the save in one committed transaction. You answer a handful of prompts -
three numbers, one blank and one `y`. The scripts it shells out to are listed at
the end, for scripting.

### Before you start

- **A held session**, in its own terminal:
  `node run.cjs --rpc <LOCAL RPC IP>` printing `Run folder: runs/switch2-XXXXXX`.
  Leave it running and keep SmileBASIC open.
- **A patched engine checkout.** `sh patches/apply.sh /path/to/ns2jb`, pointed
  at the checkout `run.cjs` is started from. An unpatched engine still holds a
  session, but `list-apps` fails with `EEXIST …-ncm-system-programs.bin` and the
  account lookup fails with `ListAllUsers: transport 0xf601` - see
  [PATCHED-ENGINE.md](docs/PATCHED-ENGINE.md).
- **A save that already exists.** Launch Seedsow Lullaby Demo once, reach the
  title screen and close it fully (**Home → X → Close**). fsp-srv creates no save
  data - until the game has made an archive, every attempt returns `0x7d402` for
  every account and space.
- **`node` 20+, `python3`, `curl`, `unzip`.** `curl` and `unzip` are only used
  when the kit has to fetch the editor release for you (step 3).

### Step 1 - start the kit and pick the title

```sh
node tools/kit.cjs                 # no argument: newest held session
```

It opens with a four-line safety notice, then:

```
Which session?
  1) newest: switch2-XXXXXX
Number 1-1 (blank = back): 1
session: /…/ns2jb-rpc/runs/switch2-XXXXXX

9 installed applications  (✔ = write-allowed)
---------------------------------------------
  [1] ✔ Nora to Oujo to Noraneko Heart 2 (trial)  (010012900d38a000)
  [2] ✔ Seedsow Lullaby (demo)                     (010042d022aea000)
  …

Number 1-9  (i = save inventory, blank = quit): 2
```

`✔` means the title is in your write allowlist; without it every write is
refused. An `i` here shows the read-only inventory instead.

### Step 2 - choose the editor install

```
Seedsow Lullaby (demo)  (010042d022aea000)
  Artemis save detected
  (each entry opens the save once; several in a row usually work - restart if one fails)
  1) List files in this save (read-only)      [save op]
  2) Save: back this save up                   [save op]
  3) Replace: write files from a directory     [save op]
  4) Install payload files (Artemis launcher)  [save op]
  5) Install the Seedsow Lua Editor save       [save op]
  6) Delete a file (optional)                  [save op]
  7) Verify: compare the save with what we wrote [save op]
  8) Back to the title list

Number 1-8 (blank = back): 5
```

The two Artemis entries (`4`, `5`) only appear when the save holds Artemis files;
on any other title the menu is `1`-`3`, then delete, verify, back. `4` is not
ready yet - see [Next: untethered](#next-untethered). `5` is the install that has
been run on hardware.

### Step 3 - answer the prompts

The account is normally found for you, and the answer is remembered per title in
`config/uids.json`:

```
save found for user 1 (539fd277…3664)
```

With more than one account it asks which one. `all of the above` means one folder
per user (for a backup); any other action then picks the first account that
actually has a save. If the console's account list cannot be read at all, it falls
back to `account uid (32 hex chars):`.

The install then **backs the save up first**, fetches the editor release, and
shows the whole file list before writing anything:

```
No backup yet: pulling one now, then writing the editor save.
pulling into saves/Seedsow-Lullaby-demo/user-539fd277/2026-10-29_1201
$ node tools/save-pull-root.cjs /…/switch2-XXXXXX 010042d022aea000 \
      /…/saves/Seedsow-Lullaby-demo/user-539fd277/2026-10-29_1201 539fd277…3664
mounted space=User type=Account uid=539fd27752770010a6ec4984c56d3664
     5583  /system.dat
     2104  /saveg.dat
  …
done: 290 files, 4651736 bytes -> /…/saves/Seedsow-Lullaby-demo/user-539fd277/2026-10-29_1201

backup: /…/saves/Seedsow-Lullaby-demo/user-539fd277/2026-10-29_1201

Directory with the editor save (blank = fetch it for me) [~/.cache/ns2-savekit/seedsow-editor]:
no editor save at … - fetching the official release (0BSD):
$ tools/fetch-editor-save.sh /…/.cache/ns2-savekit/seedsow-editor
downloading https://github.com/DialingSpoon527/seedsow-lua-editor/releases/download/v0.1.2/Seedsow-Lua-Editor-Save.zip
unpacked the release into /…/.cache/ns2-savekit/seedsow-editor
staging/editor-manifest.json: 275 files, 9 replace, 266 add, 4.3 MiB

about to write 275 file(s) into 010042d022aea000
------------------------------------------------
  /sed01.asb                                     (replace, verified)
  /ssedit1.lua                                   (add)
  …
Proceed? This commits one transaction [y/N]: y

$ node tools/save-write-stage.cjs /…/switch2-XXXXXX 010042d022aea000 539fd277…3664 …
mounted read-write; writing /sed01.asb …
commit -> 0x0
…
committed

Done. Option 7 verifies it against the console.
```

Only the confirmation prompt needs `y`; a blank answer there writes nothing. A
blank answer at the *directory* prompt means "fetch it for me", not "quit".
Every backup is kept as `saves/<game>/user-<first 8 of uid>/<timestamp>`, so a
retry never overwrites the copy the write is checked against.

### Step 4 - use it

Boot the demo and choose **Load → slot 1**; that slot's title reads **LUA EDITOR
V3** and the editor appears. Tested exactly this way on hardware: 275 files,
4,511,900 bytes, every hash identical to the release, no JKSV, no Switch 1 and no
Nintendo save transfer.

### Step 5 - prove it on the next boot

`7` pulls the save again and compares every staged file byte-for-byte with what
was written. Verify is itself a save operation, so it cannot follow the install in
the same boot: restart the console, start a new session, run the kit, pick the
title and choose `7`. The order is always **back up → write → restart → verify**.

### If a step fails

| what you see | what it means | what to do |
| --- | --- | --- |
| `0x7d402` for every account | the game has not made a save yet | launch the demo and close it fully, then retry |
| `could not tell whether … has save data` / `exited without listing anything` | the read-only probe never listed an archive. An older `save-pull-root.cjs` treated every flag as set, so `--list-only` printed the account uids, exited 0 and stopped; the kit used to report that as `0x7d402` for every title (issue #2) | update the tools; the kit now names this instead of calling the save absent |
| `Directory exceeds the N-entry probe limit` | your copy predates the 2048-entry limit | raise it in `tools/save-pull-root.cjs` and `tools/save-write-stage.cjs` |
| `could not list installed applications` / `could not list accounts` | one of `inventory.cjs`'s two enumerations failed; the lines under it are the child's own error and a hint (older copies printed the catch-all `could not list applications or accounts`) | follow the hint; an account failure can be worked around with `node tools/inventory.cjs <run> <uid>` |
| `EEXIST …-ncm-system-programs.bin` | the engine checkout is unpatched | `sh patches/apply.sh /path/to/ns2jb`, then start a new run - an existing run folder keeps the old engine copy |
| `ListAllUsers: transport 0xf601` (after `InitializeApplicationInfo 0x0`) | the engine has no CMIF pointer descriptors, so the account query is malformed; not a console fault | apply the patches and start a new run |
| `SESSION LOST` / `transport 0xf601` during a pull or write | the console stopped answering | restart the console, reopen SmileBASIC, start a new session |
| `NO LIVE HOST` / `memory.sock` | the session folder is stale or gone | start `run.cjs` again and use the run folder it prints |
| the title is listed without `✔` | it is not in your write allowlist | add its id to `config/titles.local.json` |
| names are missing, ids only | the name cache has not been fetched yet (first run needs one titledb download), or titledb does not list the title - demos/trials have no app id there and some new releases are absent | run once with network access for the full list; for titles still unnamed, paste the stub the tools print into `config/titles.local.json` (the id works without a name) |

### What the kit runs

`kit.cjs` adds no save logic of its own: it shells out to the same scripts, with
the exact arguments printed before each one. Doing it by hand, or from a script:

```sh
node tools/find-save-uid.cjs runs/switch2-XXXXXX 010042d022aea000
node tools/save-pull-root.cjs runs/switch2-XXXXXX 010042d022aea000 saves/demo <uid>
./tools/fetch-editor-save.sh /tmp/seed
python3 tools/build-editor-manifest.py /tmp/seed saves/demo staging/manifest.json
node tools/save-write-stage.cjs runs/switch2-XXXXXX 010042d022aea000 <uid> \
     saves/demo staging/manifest.json
```

The hand-written path uses one flat `saves/demo`; the kit uses the timestamped
directory above, which is the one `7` compares against later.

## Next: untethered

See [docs/RESULTS.md](docs/RESULTS.md). The launcher already survives
reboots, so the only thing still tied to SmileBASIC is *getting bytes on and off
the console*. Splitting the payload into a stable boot stub plus an
editor-authored `ns2jb.lua` removes the last PC from the loop.

Status of that split, so nobody has to guess:

- `payloads/ns2jb-stub.lua` (loads `save:/ns2jb.lua`), `payloads/ns2jb.lua`
  (body), and `tools/build-untethered.sh` (builds all three files from a backup)
  are written and pass a local smoke test with a mock engine.
- They are **not yet installed on hardware**. What is proven on hardware is the
  single-file launcher (`ns2jb.asb`) running Lua at boot, and the editor install.
- Until the stub is installed, editing the payload still means rewriting
  `ns2jb.asb` from a host with a held session.

## Credits

- **[Seedsow Lua Editor](https://github.com/DialingSpoon527/seedsow-lua-editor)** by
  [DialingSpoon527](https://github.com/DialingSpoon527) — BSD Zero Clause (0BSD).
  This project would not exist without it: its save format notes and
  `tools/asb.py` / `tools/indexed_save.py` are the basis for
  `tools/artemis-save.py`, and its released save is what we install to prove the
  write path end to end. The save itself is **downloaded from their release**,
  never bundled here — see `tools/fetch-editor-save.sh`. If you want to run Lua
  on the console with a proper editor UI, use their project.
- **[ns2jb](https://gitlab.com/kurumuz/ns2jb)** (kurumuz) — the exploit that gives
  the held session every tool here talks to. Not vendored; fetched from upstream.
- **[titledb](https://github.com/blawar/titledb)** (blawar) — MIT. Title names.
  Fetched at run time into the gitignored `config/titledb-cache.json` (one
  ~26 MB download, then reused offline); not bundled in this repository. Names
  only — no game data.
- **Artemis engine** — no code or assets included; no affiliation.

## Layout

```
tools/     save pull/write/list/enumerate, ASB encoder, caret patcher, FTP mirror
payloads/  Lua that runs inside the game: bootstrap probe, capability probe, env map + pluto fuzz
config/    write allowlist template (local config files are gitignored)
docs/      TECHNICAL.md (mechanism + IPC layout), RESULTS.md (hardware evidence
           and the untethered roadmap), SAVE-ARCHIVES.md (which archive the open
           call selects), PATCHED-ENGINE.md (the required engine patches)
tests/     offline round-trip, manifest, title-name, save-attribute and
           inventory-reporting tests (do not prove console behaviour)
```

## Licence and third parties

Our code is MIT (see [LICENSE](LICENSE)). Third-party components and links are
listed in [NOTICE](NOTICE): ns2jb (upstream exploit, linked), Seedsow Lua Editor
(0BSD, its save is fetched, not bundled), titledb (MIT, its names are fetched at
run time) and the Artemis engine itself (no affiliation).
