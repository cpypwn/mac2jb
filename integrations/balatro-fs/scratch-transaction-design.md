# Balatro save scratch qualification

Target: physical base Balatro `1.0.1f-FULL`, captured SDK SHA-256
`47cbfaea43e00261b05dc2327299637890727b476eeac7f42aaba397b108d5f9`.
The offsets below come from that image's MOD0 symbols and ARM64 code. They have
not been called on the console for a save write.

| Call | SDK offset | ARM64 arguments and result |
| --- | ---: | --- |
| `nn::fs::GetEntryType` | `0xa3b90` | `x0=out type`, `x1=NUL path`; `w0=Result` |
| `nn::fs::CreateFile` | `0xa2ea0` | `x0=NUL path`, `x1=int64 size`; `w0=Result`. This wrapper sets create flags to zero. |
| `nn::fs::OpenFile` | `0xa4040` | `x0=8-byte out handle`, `x1=NUL path`, `w2=mode`; `w0=Result` |
| `nn::fs::SetFileSize` | `0xa27c0` | `x0=handle`, `x1=int64 size`; `w0=Result` |
| `nn::fs::WriteFile` | `0xa25a0` | `x0=handle`, `x1=int64 offset`, `x2=data`, `x3=size`, `x4=4-byte option`; `w0=Result` |
| `nn::fs::FlushFile` | `0xa26d0` | `x0=handle`; `w0=Result` |
| `nn::fs::CloseFile` | `0xa2210` | `x0=handle`; return behavior needs qualification |
| `nn::fs::CommitSaveData` | `0xa4700` | `x0=NUL mount name` (`save`); `w0=Result` |
| `nn::fs::ReadFile` | `0xa2390` | `x0=handle`, `x1=int64 offset`, `x2=out data`, `x3=size`; `w0=Result` |
| `nn::fs::GetFileSize` | `0xa28c0` | `x0=out int64`, `x1=handle`; `w0=Result` |
| `nn::fs::DeleteFile` | `0xa2eb0` | `x0=NUL path`; `w0=Result` |

The bundled native FTP implementation uses open mode 1 for read and 2 for
write, a four-byte zero `WriteOption`, and flush → close → commit for saves.
Balatro's `WriteFile` body reads all five argument registers and loads the
option as a 32-bit word. The zero option relies on a separate flush. The
`CommitSaveData` wrapper selects a static commit option and branches into the
shared commit implementation. These observations qualify the static calling
shape; they do not establish that the Balatro native call adapter can execute
it safely in a live frame.

## Next live check

On a fresh `1.0.1f-FULL` boot, verify the SDK mapping, captured code heads and
full helper bodies, `save` mount, FS proxy identity, and free space again. Use
`GetEntryType` on a unique, nonexistent flat path to measure the exact
not-found `Result` without changing the save. Do not interpret every nonzero
result as absence. Confirm the REPL's native call adapter supports five integer
or pointer arguments and that the owned 4 KiB allocation and `fsp-srv` handle
checks have returned successfully. Stop on any mismatch.

Only after those checks, a single bounded transaction can use a fresh path
such as `save:/bal-fs-<16-hex-digit nonce>.bin`. Refuse if it already exists.
Create exactly 4 KiB; commit; open in write mode; write 4 KiB from owned
memory with a zero option; flush; close; commit. Open in read mode; require
exact size and byte-for-byte readback; close. Delete; commit; require the
measured not-found result and compare free space with the starting value.
Check every native result and buffer guard before advancing. Retain the path
and failed phase in diagnostics. A failed commit or uncertain call result must
stop the sequence without a blind retry; cleanup is a separate, explicitly
guarded action after verifying that the RPC session remains sound.

The prior read-only query reported 16 MiB total and 16,121,856 bytes free on
`save:/`. That is a snapshot from one boot, not proof that this transaction
will commit. Journal overhead, save quota, frame-thread stalls, and cleanup
failure remain possible. A successful 4 KiB transaction would qualify the
save write path only; it would not establish the memory pinning, timing window,
or 8 MiB canary geometry needed for FS escalation.
