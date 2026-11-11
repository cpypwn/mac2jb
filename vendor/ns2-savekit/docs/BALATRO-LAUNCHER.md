# Balatro Lua launcher

`tools/balatro-launcher.cjs` installs the pinned
[Luminger/balatro-switch-rce](https://github.com/Luminger/balatro-switch-rce)
release through SaveKit's save pipeline. It provides planning, staging,
installation, verification and receipt-based rollback for
[issue #13](https://github.com/dougchansan/ns2-savekit/issues/13).

The launcher takes over Balatro's startup: launching the game opens its status
console and Lua services. This installer **adds launcher files while preserving
the existing gameplay files**. A successful rollback removes those added files
so the game can load its own entry points again.

**The direct SaveKit installation and rollback route still needs a hardware
smoke test.** Upstream reports testing its own JKSV/save-transfer route on
hardware. That report does not validate this installer's save writes or rollback.

## Compatibility

| Item | Supported scope |
| --- | --- |
| Title | **Balatro, Switch 1 edition** |
| Program ID | `0100cd801ce5e000` |
| Save archive | User space `1`, Account save type `1`, the selected account UID |
| Game builds documented upstream | Cartridge stock `1.0.1f` and patched `1.0.1o` |
| Switch 2 | The **Switch 1 edition in backward compatibility mode** |
| Native Switch 2 edition | Unsupported; it has a different code image |

`--title` is optional and defaults to the ID above. Every other title ID is
refused. The game name alone does not establish compatibility.

The upstream [README](https://github.com/Luminger/balatro-switch-rce/blob/0be2c4c1e7932c21cb053d77126b50a69476f9c8/README.md)
reports physical Switch 1 cartridge tests on Switch 1 and Switch 2, at the stock
and patched versions. Its [image profiles](https://github.com/Luminger/balatro-switch-rce/blob/0be2c4c1e7932c21cb053d77126b50a69476f9c8/src/bl/offsets.lua)
are specific to those images. Successful file verification establishes what was
written; the upstream runtime checks the game's code image when it boots.

## Pinned release

| Item | Value |
| --- | --- |
| Upstream release | [`v1.1.0`](https://github.com/Luminger/balatro-switch-rce/releases/tag/v1.1.0) |
| Release tag commit | `0be2c4c1e7932c21cb053d77126b50a69476f9c8` |
| Runtime build ID | `de52bef7` |
| Archive | `balatro-switch-rce-1.1.0.zip` |
| Archive size | 58,223 bytes |
| Archive SHA-256 | `2c8055ec080f3c7bd7b5392f4484dbe8247efaa712563b662dfabab1b616b704` |
| Installed files | 20 files, 148,240 bytes |

[`config/balatro-launcher.json`](../config/balatro-launcher.json) records the
release identity and each installed file's size and SHA-256. The published ZIP
is the installation authority; its file hashes are recorded from the release
itself. The upstream runtime's build fingerprint is a separate identifier.

The installer downloads the pinned ZIP, or accepts it through `--archive` for
local use, and checks its identity before staging. It accepts exactly the
recorded payload. The ZIP's `.nx_save_meta.bin` is validated as archive metadata
and **excluded from the files written to the console**. That 86-byte entry is
JKSV metadata with a zero account UID; the SaveKit operation uses the selected
live archive and the explicit user UID instead.

The payload is downloaded at run time. No upstream launcher, font, game save,
keys or game assets are bundled in this repository.

## Prerequisites

- Node 20+ and Python 3. The download uses Node; a local `--archive` avoids it.
- For live commands, a patched `ns2jb` checkout, a live session and its run
  directory, as described in the [main README](../README.md#quick-start).
- The supported game must already have an Account save for the selected user.
  Launch it normally once if needed, then close it fully before opening its
  save through the toolkit. Host the session from a different title.
- A 32-hex-digit account UID for live commands. A local plan can infer it from
  the backup manifest or take `--uid` explicitly.
- Space for a full original backup, the installation receipt, the staged
  payload, verification pulls and a fresh backup before rollback.

Backups must be complete pulls with a valid manifest, matching title/account
identity, and file sizes/hashes that agree with the local bytes. Partial,
unidentified or modified backups cannot authorize these operations.

## Using the kit

Select the Switch 1 Balatro title in `node tools/kit.cjs`. The available actions
are labelled:

- **Install Balatro Lua launcher**
- **Verify Balatro Lua launcher**
- **Restore Balatro gameplay**

Read the labels rather than menu numbers. The actions appear only for the
supported title. Verification and rollback ask for the installation receipt
path printed by the installer.

## Plan and stage locally

First inspect a complete local backup:

```sh
node tools/balatro-launcher.cjs plan \
  --backup <complete-pull> --uid <32-hex-uid>
```

The plan checks the save identity and installation conflicts without contacting
the console. It does not authorize a write.

Staging checks and extracts the pinned payload into a **new** output directory:

```sh
node tools/balatro-launcher.cjs stage \
  --archive /path/to/balatro-switch-rce-1.1.0.zip \
  --out staging/balatro-review
```

Omitting `--archive` downloads the pinned release. An existing output directory
is refused. The staged files and manifest can be reviewed without opening a
console save.

An installation dry run is entirely offline and requires the supplied backup:

```sh
node tools/balatro-launcher.cjs install <run> \
  --uid <32-hex-uid> --backup <complete-pull> --dry-run
```

It does not contact the run's session or download the release.

## Install and verify

```sh
node tools/balatro-launcher.cjs install <run> \
  --uid <32-hex-uid> --backup <complete-pull> --confirm

node tools/balatro-launcher.cjs verify <run> \
  --uid <32-hex-uid> --receipt <printed-receipt.json>
```

For installation, `--backup` is optional: the live path always takes a fresh
backup. When an earlier backup is supplied, it is checked against that fresh
snapshot before writing. `--archive <ZIP>` can supply the local pinned release.
`--state-dir <directory>` selects a different local directory for saved operation
state.

The install sequence is:

1. Validate and stage the exact pinned payload.
2. Pull the complete current save, validate its title/user/contents, and check
   for conflicts and any difference from the supplied earlier backup.
3. Preserve the original snapshot and write the installation receipt before
   starting the save write.
4. Add the 20 files through the staged writer and commit the save.
5. Pull again and verify the installed files and the preserved baseline files.

This is a **fresh, add-only installation**. It refuses existing launcher paths
or namespaces, including a preexisting `/.lovegame/bl_probe.lua`. The upstream
launcher automatically executes that probe at startup; it must not be adopted
as part of a clean installation. Existing gameplay files remain in place.

Keep the printed receipt together with its operation state and original backup.
Those records establish which paths this installation owns and prove that the
paths were absent beforehand. A later install never replaces the original
baseline or silently adopts an existing launcher. To reinstall or update,
restore this installation first and then perform a fresh install.

If a command fails after writing begins, retain its backup and receipt and
inspect the reported failure before retrying. A file verification error is not
a claim that the write was undone.

## Restore gameplay

Rollback uses the installation receipt:

```sh
node tools/balatro-launcher.cjs restore <run> \
  --uid <32-hex-uid> --receipt <printed-receipt.json> --confirm-restore
```

It first pulls a fresh snapshot of the current save. It then removes **only the
receipt-owned launcher paths** in one transaction, with the deletion guarded by
the sizes and hashes captured in that snapshot. A launcher file changed through
FTP or RPC can be removed only after its current bytes have been backed up. The
original baseline establishes that these owned paths were created by the
installation.

Afterward the toolkit pulls and checks the result. Current gameplay profiles,
settings, runtime logs and unknown or FTP-created files are preserved. Directories
are left in place; rollback never recursively deletes `.lovegame`.

For an entirely offline preview, supply a complete **current** snapshot:

```sh
node tools/balatro-launcher.cjs restore <run> \
  --uid <32-hex-uid> --receipt <printed-receipt.json> \
  --backup <current-complete-pull> --dry-run
```

The dry run does not contact the console. The live rollback still takes its own
fresh snapshot before deleting anything.

## What is installed

All payload paths are under `/.lovegame/`:

```text
conf.lua
main.lua
bl/app.lua
bl/call.lua
bl/console.lua
bl/ffi_call.lua
bl/ftp.lua
bl/ftp_server.lua
bl/hooks.lua
bl/jffi.lua
bl/log.lua
bl/offsets.lua
bl/repl.lua
bl/resolve.lua
bl/rpc.lua
bl/socket.lua
bl/socket_types.lua
bl/stamp.lua
bl/assets/mono.ttf
bl/assets/OFL.txt
```

The upstream runtime normally creates `/.lovegame/bl_log.txt` and
`/.lovegame/bl_phase.txt`. They are not part of the installed payload and are
preserved by rollback. Additional files created during a live session are also
outside the receipt's removal scope unless they replace one of its owned paths.

## Hardware smoke test still required

After a verified installation, close the host session as usual and launch the
supported Balatro edition. The expected upstream status screen identifies build
`de52bef7`. Once networking is ready, use `rpc.py` from the pinned upstream
release source:

```sh
python3 rpc.py <console-ip> 'return 2+2'
```

The expected result is `4`. Record the game edition/version, console firmware,
status screen and file verification result. Also verify a close/relaunch and a
receipt-based rollback followed by normal game startup and preserved gameplay
state before calling the direct SaveKit route hardware validated.

| Upstream service | TCP port |
| --- | ---: |
| Lua RPC | 9026 |
| FTP control | 5000 |
| FTP passive data | 5001 |

The RPC and FTP services are **unauthenticated and unencrypted**. Run them on a
trusted LAN and keep these ports off the public internet. Upstream has no in-app
kill switch for a broken startup shadow; keep the external save/rollback path
and its original backup available.

## Credits and licenses

- [Luminger/balatro-switch-rce](https://github.com/Luminger/balatro-switch-rce):
  the upstream launcher, Lua services and native-call implementation, GPL-3.0.
- The bundled `mono.ttf` is a JetBrains Mono NL subset under SIL OFL-1.1.
  `bl/assets/OFL.txt` accompanies it in the staged and installed payload.
- [ns2jb](https://gitlab.com/kurumuz/ns2jb): the external session provider used
  by SaveKit's live save operations.

See [NOTICE](../NOTICE). Downloading and installing the upstream files does not
relicense them under this repository's MIT license.
