# Artemis HTTP transport

Talk to the installed [alula Artemis Launcher](../NOTICE) over the console's own
HTTP server, **without an ns2jb RPC session**.

The launcher is unchanged: the transport uses only its four upstream endpoints
(`GET /status`, `POST /eval`, `PUT /save?path=`, `DELETE /delete?path=`). It does
not write `core.lua`, `inject.iet`, `inject.lua`, `http.lua`, `save9999.dat`,
`saveg.dat` or `system.dat`, and it makes no native memory calls.

## Starting the server

1. Boot the supported game whose save has the launcher.
2. On the launcher menu press **Y** (`HTTP server`). The screen shows
   `HTTP server listening on http://CONSOLE_IP:8080`.
3. Keep the console on a trusted, isolated LAN. The server is **unauthenticated**
   and `POST /eval` is arbitrary Lua; never forward port 8080 to the internet.

## CLI

```sh
node tools/artemis-http.cjs discover --subnet 192.168.1
node tools/artemis-http.cjs health   --host 192.168.1.50
node tools/artemis-http.cjs eval     --host 192.168.1.50 --code 'print("hello world")'
node tools/artemis-http.cjs eval     --host 192.168.1.50 --file script.lua

node tools/artemis-http.cjs stat     --host 192.168.1.50 --path save:/core.lua
node tools/artemis-http.cjs get      --host 192.168.1.50 --path save:/file.bin --out file.bin \
  --sha256 <64-hex>
node tools/artemis-http.cjs put      --host 192.168.1.50 --path save:/note.txt --in note.txt
node tools/artemis-http.cjs rm       --host 192.168.1.50 --path save:/note.txt

node tools/artemis-http.cjs backup   --host 192.168.1.50 --out backup/
node tools/artemis-http.cjs probe    --host 192.168.1.50
```

Kit transport selection:

```sh
node tools/kit.cjs                 # ns2jb RPC, unchanged
node tools/kit.cjs --http <ip>     # Artemis HTTP menu: health, eval, stat, get, put, rm, backup
```

The HTTP menu exposes only what this transport can do. It cannot open another
title's save: `/eval` runs inside this game, so `save:/` is this save only.

Exit codes: `0` ok, `2` usage, `3` connection, `4` timeout, `5` Lua error,
`6` HTTP error, `7` integrity/size, `8` protocol, `9` protected/refused.

## Remote Lua

`POST /eval` returns `status: ok` or `status: error`. **A Lua error is a failed
operation even though HTTP is 200**; the transport throws `ELUA` and the CLI
exits 5. Standard output is captured from the `output:` block.

`health` prints the Lua version (`Lua 5.1`), the platform from
`_G.n2h.platform` (`Ounce` on Switch 2) and the type of the engine global.

## Downloads

There is no download endpoint, so files are read in bounded `/eval` calls and
returned as hex:

- offset + length per chunk (default 4096 bytes);
- the returned byte count and hex length are checked;
- chunk SHA-256s and the final SHA-256 are verified locally;
- a `.part` file and `<out>.part.json` state let an interrupted transfer resume
  after re-verifying every recorded chunk;
- the verified file is promoted with a local `rename()`; a hash or size mismatch
  never promotes and keeps the partial for inspection/resume.

The same mechanism backs `backup`, which records every downloaded entry with its
size and SHA-256.

## Uploads

- Direct `PUT /save` up to the server request body cap (0x7000 bytes; the client
  uses 0x6c00 to leave headroom).
- Larger files: first chunk via `/save` (which truncates), then `/eval` appends
  (`io.open(..., "ab")`). Each append request stays under the body cap.
- **Chunked uploads are not atomic.** Hardware proved `os.rename` on `save:/`
  returns `Operation not permitted`, so the temporary-name + rename path is
  refused (`EATOMIC`) rather than pretending. A chunked upload writes the target
  directly; an interrupted one is reported as `EINCOMPLETE` with the partial
  byte count, never as success.
- **The reported hash is the remote hash.** After the size check the transport
  reads the file back through `/eval` and compares its SHA-256 with the source
  (`EHASH` on mismatch). `--no-verify` skips the read-back and the result is
  marked `verified:false`; the returned `localSha256` is then only the PC-side
  buffer hash.
- A failed PUT or append is not retried: the retry policy applies to read-only
  requests (status/stat/read) only, so a non-idempotent write is attempted once.
- Overwriting an existing file requires an explicit `--force` (the kit asks).
  Client and server both refuse the protected launcher files.
- Uploads are size-checked with `stat`, then read back by `download` when the
  caller wants a byte comparison.

### Rename probe

`probe` tests whether `os.rename` works, without touching anything else:

- two scratch names with 128-bit random suffixes
  (`.ns2http-probe-<32 hex>-a`/`-b`);
- if either already exists, it refuses (`collision`) and leaves it untouched;
- it writes random recognizable content and reads it back to establish
  ownership before considering a file disposable;
- cleanup deletes only files whose content still matches what it wrote; a file
  that was changed, or whose deletion fails, is left behind and reported;
- a timeout after the upload may still have succeeded, so cleanup runs in a
  `finally` block with the same ownership check;
- the API has no exclusive-create flag (`O_EXCL`), so this is not race-free; the
  pre-check plus 128-bit names make an accidental collision implausible, and a
  detected collision is never deleted.

## Path validation

Every operation (stat, read, download, upload, delete, backup, the probe and the
internal raw helpers) uses one validator:

- accepts a flat name, optionally prefixed with `save:/`;
- rejects empty names, `.`, `..`, anything containing `..`, `/` or `\`,
  embedded NUL/control characters, and characters outside `[A-Za-z0-9_.-]`;
- rejects a leading `/` (absolute path), so `/core.lua` must be passed as
  `core.lua` or `save:/core.lua`;
- read-only operations may inspect protected files; upload/delete refuse them.

Invalid paths are rejected locally, before any HTTP request is sent.

## Backups: explicit files, not a complete archive

The upstream server has **no directory listing**. Probed on hardware:

- `io.open("save:/", "rb")` returns a handle but `read` returns nil;
- the engine's metatable `__index` is a function, not an enumerable table.

So `backup` records only the files it is given (default: the launcher core, the
server scripts, the font, the boot trigger, `saveg.dat`, `system.dat`). Its
manifest says:

```json
{"scope": "explicit-files", "complete": false}
```

That backup is useful as read-only evidence (it verified the installed payload
for `migrate-legacy`), but it **must not authorize a destructive full restore**.
No restore command is exposed by this transport.

## Hardware validation (2026-11-01, Switch 2 / 23.0.1 / Seedsow demo 1.0.0)

Server started with button Y; no ns2jb session. Console address is `$CONSOLE` in
the transcript.

| test | result |
| --- | --- |
| `GET /status` | 200, `nora2hax/seedsow` |
| Lua Hello World | `hello world` |
| Lua version / platform | `Lua 5.1` / `Ounce` |
| upload/download text | 41 B, SHA-256 identical |
| binary with NUL / 0xFF / 0x80 | 4 KiB, 16 KiB, **64 KiB** — all byte-identical |
| upload hash | read back from the console and compared before reporting success |
| 64 KiB path | chunked `/eval` append upload, 4 KiB-read download |
| missing file | `stat` absent; `get` exits 9 `ENOENT` |
| protected `core.lua` / `save9999.dat` | upload and delete refused (`EPROTECTED`) |
| traversal `save:/../escape` | refused (`EPATH`) |
| delete + read-back | all five disposable files removed, `stat` absent |
| `os.rename` probe | false, `Operation not permitted` |
| relaunch game + Y | `/status` 200, health OK, marker and 64 KiB file intact |
| explicit-file backup | 9 files, 114,443 B; `complete:false` |
| legacy migration from that backup | original baseline created, attestation written, original backup unchanged |

Hashes of the transferred files:

```
text        41 B     de4f9d6de5c0f18f988f31bc267ab415ae8700277f411150ae92b4d4661ccccc
bin-4096  4096 B     e87d333e5f9dc3d12c4e6445700267dcebf57d156ebece144915a0a3742c44cb
bin-16384 16384 B    cb158df680b8ead69b547ca78deef580b70947827a4ea23210e09987866a4d16
bin-65536 65536 B    5cccb2465cf3b2a34201823de07586a765b009cba96601d684228250c9b3eebd
marker       35 B     62c9a3fc97e4c70408f572bf8b28c63f5cf1e8b9d593311be2309cfe76fd5087
```

Installed launcher files read over HTTP match the staged payload:
`core.lua 54d25862…`, `inject.iet bf79a739…`, trigger `ca472410…`.

## Security and capabilities

- Unauthenticated HTTP on TCP 8080; trusted LAN only.
- `/eval` is arbitrary Lua inside the game process; it can read every file in
  `save:/` (including protected files) and write non-protected files via `io`.
  The transport itself refuses protected uploads/deletes, and never writes via
  `/eval` except appending to files the caller explicitly chose for a chunked
  upload. `--force` is required to overwrite.
- No other title's save is reachable, no system memory is touched, and there is
  no privilege escalation.
- The server's own protected-file rules still refuse `/save` and `/delete` on
  `core.lua`, `inject.iet`, `inject.lua`, `http.lua`, `proggy.ttf`,
  `save9999.dat`, `saveg.dat`, `system.dat`.

## Optional future extension (not deployed)

A reliable transfer API would need a modified server: `GET /files` (listing),
`GET /download?path=&offset=&length=` (binary), a chunked upload with
temporary-file + rename + SHA-256, and a token/allow-list for access control.
That changes the installed upstream launcher and its protected files, so it is
**not** part of this PR. Any such build would need its own verified rollback.

## Tests

`node tests/test_artemis_http.cjs` — 35 offline tests against a local HTTP server
implementing the real endpoints and body cap. They cover status/health, eval
errors, the body cap, stat, binary chunked download, resume after a failed
chunk, hash/size refusal, 4/16/64 KiB uploads, overwrite authorization,
protected refusals, delete verification, explicit-file backup, retry, timeout,
connection failure, atomic refusal, remote-hash verification, corrupted uploads
(`EHASH`), interrupted chunked uploads (`EINCOMPLETE`, partial size), the
no-retry rule for writes, randomized rename-probe success/unsupported/collision/
timeout/interrupt/corrupt-destination/cleanup-failure/consecutive/concurrent
cases, and the shared filename validator.
