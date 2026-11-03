# Engine patches these tools require

The tools talk to a run folder produced by ns2jb, but they call engine helpers
and behaviours that are **not** in upstream ns2jb. A plain upstream checkout can
still pull a save when you pass the program id and uid by hand; the guided tools
(`kit.cjs`, `inventory.cjs`), `list-apps.cjs` and every write need the patch set
in [../patches](../patches).

**Apply the patches before starting `run.cjs`.** The host copies `engine/` into
each `runs/switch2-XXXXXX` folder when it starts, so patching afterwards does not
fix an existing run folder. Patch, then start a new session and use the new
folder.

| Engine module | Patch | What breaks without it |
| --- | --- | --- |
| `engine/shared/ipc.cjs` | CMIF pointer/static descriptors (`0001`) | `ListAllUsers` fails with `transport 0xf601`, so `save-pull-root.cjs --list-uids`, `accounts.cjs`, the account lookup in `kit.cjs` and `inventory.cjs` cannot enumerate accounts. Creating a file in a save also fails with `0x2ee002` |
| `engine/switch2/ro/ncm.cjs` | storage/metaType selection, one capture file per query (`rest-engine-switch2-ro-ncm`) | the `storage: 4, metaType: 0x80` that `list-apps.cjs` sends is ignored, so it lists BuiltInSystem system programs instead of installed applications; a second run in the same folder fails with `EEXIST …-ncm-system-programs.bin` |
| `engine/switch2/app/mounted-save.cjs` | `inspectMountedFilesystem()` export (`0002`) | `find-save-uid.cjs` cannot scan for the uid; `kit.cjs` falls back to asking for it |
| `engine/switch2/memory/probe-reserved-gap.cjs` | extra pin retries / window sizing | acquisition is less reliable on our unit |
| `engine/switch2/retained/find-metadata.cjs` | 24 move attempts | acquisition is less reliable |
| `run.cjs` | `NS2_PAIR_TIMEOUT_MS` | a long pairing wait can expire mid-setup |
| `engine/lib/bridge.cjs` | `status` reports the socket error text | `status` says `ready: false` without the reason |
| `engine/switch2/app/session.cjs` | `initialize` reports the reason it refused | the error says only "not ready", without the transport reason |

## Symptoms

- **`EEXIST: file already exists, open '…/switch2/ro/switch2-XXXXXX-ncm-system-programs.bin'`**
  — the NCM patch is missing. Upstream writes one fixed filename per session with
  `flag: 'wx'`, so the first `list-apps` in a run folder succeeds (against the
  wrong database) and every later one fails. Apply the patches and start a new
  run; deleting the file only gets you the wrong listing again.
- **`InitializeApplicationInfo 0x0` then `ListAllUsers: transport 0xf601`**, or
  `account enumeration failed: ListAllUsers: transport 0xf601` — the
  pointer-descriptor patch is missing. The `{pointers: {receive: […]}}` output
  buffer is silently dropped, so the query reaches the console with no output
  buffer and the transport aborts. This is **not** a dead console even though
  `0xf601` is the code `SESSION LOST` uses: `rpc.cjs <run> status` can still say
  `ready: true`. `inventory.cjs` prints this line under "could not list accounts"
  and follows it with the missing-patch hint; the same detail is what
  `list-apps.cjs` and `save-pull-root.cjs … --list-uids` print when run by hand.
- **`mounted.inspectMountedFilesystem is not a function`** — the uid scan helper
  is missing. `find-save-uid.cjs` does not stop there: it falls back to the
  account service (`save-pull-root.cjs --list-uids`), which lists every user
  without touching a save or `mounts.json`. If that also returns nothing, pass
  the 32-hex uid by hand.
- **`OpenFile for write failed: 0x2ee002`** or **`CreateFile failed: 0x2ee002`** —
  the pointer-descriptor patch is missing, so new files cannot be created. Adding
  a file to a save needs it; reading a save with an explicit uid does not.

## Getting a patched checkout

```sh
# from this checkout
git clone https://gitlab.com/kurumuz/ns2jb ns2jb
sh patches/apply.sh ns2jb
```

`apply.sh` applies every `.diff` in [../patches](../patches) and syntax-checks
the touched files. The patches were written against the `kurumuz.fixrpc` merge
(`eb2bdec`); `0001` and `0002` were verified to apply to a fresh clone
(`81d5bb1`). If upstream has moved, `git apply -3` may leave a hunk to resolve by
hand - the changes are small and self-contained. Nothing here vendors or
redistributes exploit code.

After patching, start `run.cjs` fresh and use the run folder it prints. Check the
result before touching a save:

```sh
node tools/list-apps.cjs <run>   # "N installed applications (BuiltInUser)"
node tools/accounts.cjs  <run>   # ListAllUsers 0x0, then the uids
```

The hardware evidence in [RESULTS.md](RESULTS.md) was produced on a checkout with
the full set applied.
