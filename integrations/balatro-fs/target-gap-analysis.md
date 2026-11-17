# Balatro FS target gap

This profile is for the physical base game running `1.0.1f-FULL`. The captured
SDK is 6,160,384 bytes with SHA-256
`47cbfaea43e00261b05dc2327299637890727b476eeac7f42aaba397b108d5f9`.
All 41 code heads in `sdk-profile.v1.0.1f.json` match that image. The image's
offline CRC-32 is `0xac8a9d29`. These are build-specific facts; a fresh boot
must verify the live mapping before using any offset.

| Canary prerequisite | Balatro evidence | Remaining gap |
| --- | --- | --- |
| Native transport and SDK identity | `memcpy`, `memmove`, `svcQueryMemory` heads and MOD0 symbols are pinned. The native bridge queried the live mapping and computed `0xac8a9d29` over the complete live SDK code on the tested Balatro 1.0.1f session | Repeat the identity check on each boot; an earlier absolute SDK base cannot be reused |
| Native call adapter | The 39381 native bridge passed a read-only `svcQueryMemory` call. Its listener was closed afterward | The bridge has not been used for the FS canary |
| Mount and proxy | The live `rom`/`save` mount nodes, proxy and `fsp-srv` service open/close passed read-only or owned-handle qualification | The alias and cache behavior needed by the marker path are unmeasured |
| Owned session helpers | A 2 MiB guarded FFI arena is retained under a nonce; allocator and service helpers passed bounded qualification | The canary's pinning allocation cost and heap jitter remain unmeasured |
| Worker | One-call and two-call native worker frames passed live read-only timing calls. The two-call frame returned a system tick and 19.2 MHz tick frequency; its handle was joined and closed | Event lifecycle, integrated FS worker, native-counter frequency and timed receive order still need proof |
| Save storage | Read-only queries returned 16,777,216 total. The current session passed an owned 8 MiB create, eight 1 MiB writes and readbacks, delete, and missing-path verification | The transaction is storage capacity evidence only; it does not establish the canary's allocation or timing geometry |
| Canary geometry | The retained arena and SDK tick preflight passed. One owned storage cycle reported a 14,096-byte index-5 diagnostic drop and zero restoration, with handles cleaned | Repeatability, actual allocation size, heap jitter, marker offset, receive order and a positive marker remain unverified; 2/4 is not verified |

The SDK exposes `nnutilZlib_crc32` at +`0x70b00`,
`nn::crypto::GenerateSha256Hash` at +`0x45a0`, and LightEvent init/finalize,
wait/try-wait/signal functions at +`0x12ae80` through +`0x12b180`.
The native CRC helper was exercised with the standard test vector and the
complete live SDK code. The 19.2 MHz SDK tick frequency was measured in the
foreground process and through one-call and two-call native workers. The
separate native counter frequency required by the Gravity canary logic is
still unmeasured.

The current owned scratch transaction used
`save:/bal-fs-85b48bb9274c547a.bin`. Free space was 16,334,848 bytes before
and 16,318,464 bytes after verified removal. The 16 KiB accounting difference
is below the probe's 1 MiB cleanup tolerance and is not proof of a reusable
canary allocation.

The 14,096-byte single-cycle result comes from command 1009's get-and-clear
`ExpHeapFreeSizePeak` counter. It is a candidate diagnostic drop, not a direct
measurement of the storage object's allocation. The bounded repeat probe runs
at most two cycles and reports the drop only if both cycles stabilize, restore
and match. It does not place a canary marker.

The shared FS engine cannot be enabled for Balatro by registering a target
name alone. Its canary gate and geometry proof are Gravity-specific; the
non-Gravity fallback assumes an 8 MiB write and a 4 MiB reserve, while its
marker offset and cache plan come from other games. A Balatro run needs
target-specific measured bounds, a proven multi-call worker and a guarded
positive marker. Full FS escalation remains disabled until that marker is
verified independently on this target.

The next marker placement test needs separate Balatro-specific proof of an
owned save marker, the original and cloned path controls, an absent-path
control, a native worker overlap, a measured path position and complete
cleanup. Gravity Circuit's 0x233f/0x243f marker offsets and 36 MiB app arena
have not been qualified in Balatro. No marker wave may use the repeated
command-1009 drop as its exact allocation size.
