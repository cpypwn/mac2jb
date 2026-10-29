# FTP background service

Available in HBLauncher **v0.2.0**. GPU apps can start and stop a console FTP
listener without running networking on the render thread. The host remains
required: it drives qualified socket and filesystem calls in SmileBASIC while
the console's native graphics loop continues independently.

## Declare and control the service

```json
"sdk": {
  "version": 1,
  "capabilities": [],
  "services": ["ftp"],
  "ftpPort": 5000
}
```

`ftpPort` defaults to 5000 and must be an integer from 1024 through 65535.
`services` is a list of built-in SDK services, not executable host scripts.
Older launchers cannot provide this service; test `hbFtpAvailable()` before
sending commands and tell users to update their host.

```glsl
if (hbFtpAvailable() && !hbFtpBusy() && (hbPressed() & HB_A) != 0u) {
    uint state = hbFtpState();
    hbFtpCommand(state == 1u || state == 2u ? 2u : 1u);
}
```

Command 1 starts listening; command 2 closes the listener, data connections and
open files. Stopping, returning to HBLauncher, or switching apps closes the FTP
session. Writes are flushed and committed before a successful transfer reply.
A disconnected or interrupted upload can leave a partial file; uploads replace
files directly, rather than providing atomic replacement. Back up important
save files before editing them. Restarting the entire console during a write
can prevent cleanup/commit.

## Files and protocol

| FTP directory | Console mount | Access |
| --- | --- | --- |
| `/save` | SmileBASIC `save:/` | Read, write, create, rename, delete |
| `/tmp` | SmileBASIC `tmp:/` | Read, write, create, rename, delete |
| `/rom` | SmileBASIC `rom:/` (romfs) | Browse and download |

These are title-owned mounts, not the console's complete storage. SD-card
filesystem access returned permission denied on the supported build. No SD
mount, unrelated game saves, or host-PC files are exported.

The server uses **plain FTP**, anonymous login (`anonymous` or `ftp`), IPv4,
and passive data connections. It has one client/transfer at a time. In FileZilla,
select plain FTP, anonymous login, passive mode, and a maximum of **one**
simultaneous connection. Encryption, password protection, and internet-facing
hosting are not provided; use a trusted local network. Passive data peers must
match the control connection's address. Active-mode `PORT`/`EPRT` is rejected.

Supported commands: USER, PASS, QUIT, FEAT, SYST, OPTS UTF8 ON, NOOP, ABOR,
PWD/XPWD, CWD/CDUP, TYPE, MODE S, STRU F, PASV, EPSV, LIST, NLST, MLSD, RETR,
STOR, APPE, REST (downloads), SIZE, DELE, RMD, MKD, RNFR, RNTO. Binary data is
preserved even when TYPE A is requested. Upload resume, timestamps, recursive
delete, and cross-mount rename are not implemented. Directory listings are
bounded to 4096 entries; transfers use 32 KiB chunks. Passive/data inactivity
times out after 30 seconds, and idle control connections after 120 seconds.
Active transfer progress refreshes the idle timer.

## GPU status ABI

Offsets below are relative to the SDK extension base `0x7f0000`. These ranges
are reserved SDK storage and do not overlap the Jcms ring at 16384.

| Offset | Type | Meaning |
| --- | --- | --- |
| 8192 | u32 | Ready magic `0x46545031` |
| 8196 | u32 | 0 stopped, 1 listening, 2 transferring, 3 start/command error |
| 8200 | 4 bytes | IPv4 address, octets in network order |
| 8204 | u32 | Listening/configured port |
| 8208 | u32 | Client count |
| 8216 | u64 | Sent bytes |
| 8224 | u64 | Received bytes |
| 8232 | u32 | Completed data operations (including directory listings) |
| 8236 | u32 | Acknowledged command sequence |
| 8240 | 128 bytes | Last error, UTF-8/NUL padded |
| 8368 | 80 bytes | Activity text, UTF-8/NUL padded |
| 8448 | u32 | App-written command sequence; zero means no command |
| 8452 | u32 | App-written action: 1 start, 2 stop |

Write the action before advancing the sequence; use `hbFtpCommand()` to do
this. Telemetry updates about every 150 ms. Helpers expose state, address, port,
clients, files, and the low 32 bits of sent/received counters. Read the full u64
fields yourself when tracking transfers above 4 GiB.

The service verifies the installed package's fingerprint and declared service
when ownership changes. Native sockets and file handles belong to that service
instance. Read calls fit the four-argument bridge; writes use the verified
six-register worker because WriteFile needs five arguments. All mutations are
restricted to `/save` and `/tmp`, followed by native save commits.

## Validation

On SmileBASIC 4.4.9 / Switch 2 23.0.1, TCP nonce echo, directory reads, and isolated
write/readback/rename/delete/commit checks passed. Python's standard `ftplib`
then exercised actual FTP uploads, downloads, overwrite, append, resumed
retrieval, MLSD, rename and deletion on both writable mounts. ROM writes were
rejected. FileZilla connected and browsed the console. The native renderer
continued at approximately 60 FPS during transfers.

To reproduce against a running app (disconnect FileZilla first):

```sh
python3 sdk/tools/check-ftp.py CONSOLE_IP --port 5000 --write
node --test sdk/tests/ftp.test.cjs
```

The live check creates uniquely named directories in `/save` and `/tmp`, verifies
file contents, and removes its own files. It does not write into existing user
files. Private status and diagnostic reports remain under the ignored session
folder, including `ftp-service.json` and the native worker journal.
