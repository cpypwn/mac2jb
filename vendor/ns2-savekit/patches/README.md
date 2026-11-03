# Engine patches the toolkit needs

These patches add the engine support this toolkit needs. They were written
against the `kurumuz.fixrpc` merge of [ns2jb](https://gitlab.com/kurumuz/ns2jb)
(`eb2bdec`). They contain no exploit logic of their own: one adds a HIPC
descriptor form, one exports a helper that already existed, and the rest are the
local robustness changes the toolkit was developed against.

| patch | adds | without it |
| --- | --- | --- |
| `0001-shared-ipc-pointer-descriptors.diff` | CMIF/HIPC static "pointer" descriptors in `engine/shared/ipc.cjs`, so a buffer can be passed by address | `ListAllUsers` fails with `transport 0xf601`, so `--list-uids`, `accounts.cjs` and `inventory.cjs` cannot enumerate accounts; creating a file in a save fails with `0x2ee002` |
| `0002-mounted-save-inspect-export.diff` | exports `inspectMountedFilesystem` from `engine/switch2/app/mounted-save.cjs` | `find-save-uid.cjs` cannot scan for the account uid; `kit.cjs` prompts for it |
| `rest-engine-switch2-ro-ncm.cjs.diff` | storage/metaType selection and one capture file per query | `list-apps.cjs` reports BuiltInSystem programs instead of installed applications, and a second run in the same folder fails with `EEXIST …-ncm-system-programs.bin` |
| `rest-engine-lib-bridge.cjs.diff` | `status` includes the socket error text | `status` says `ready: false` without a reason |
| `rest-engine-switch2-app-session.cjs.diff` | `initialize` reports the reason it refused | the error says only "not ready", without the transport reason |
| `rest-engine-switch2-memory-probe-reserved-gap.cjs.diff` | extra pin retries and window sizing | acquisition is less reliable on our unit |
| `rest-engine-switch2-retained-find-metadata.cjs.diff` | more move attempts before giving up (honours `NS2_METADATA_ATTEMPTS`) | acquisition is less reliable |
| `rest-run.cjs.diff` | `NS2_PAIR_TIMEOUT_MS` | a long pairing wait can expire mid-setup |

## Apply

**Apply before starting `run.cjs`.** The host copies `engine/` into every
`runs/switch2-XXXXXX` folder at startup, so an existing run folder keeps the old
code; after patching, start a new session and use the new folder.

```sh
git clone https://gitlab.com/kurumuz/ns2jb ns2jb
sh /path/to/ns2-savekit/patches/apply.sh ns2jb
```

`apply.sh` applies every `.diff` in this directory and `node --check`s the files
it touches. To apply one by hand:

```sh
git -C ns2jb apply -3 /path/to/ns2-savekit/patches/0001-shared-ipc-pointer-descriptors.diff
```

`-3` asks git to merge the hunks; if upstream has moved far enough that a hunk
does not apply, resolve it by hand - the changes are small and self-contained.

A plain upstream checkout is enough only for a one-off read where you pass the
program id and uid explicitly: `save-pull-root.cjs <run> <title> <dir> <uid>`.
The guided tools, `list-apps.cjs`, `inventory.cjs` and every write need the
patches.

## Verified

`0001` and `0002` applied cleanly to a fresh clone of upstream (`81d5bb1`) with
`git apply -3`, and the two patched files are then **byte-identical** to the ones
this toolkit was developed and tested against. So the hardware evidence in
[docs/RESULTS.md](../docs/RESULTS.md) - four committed writes, all read back and
hashed, plus the 275-file editor install - applies to a patched checkout exactly.
