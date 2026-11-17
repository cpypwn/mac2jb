# Gravity Circuit FS target qualification

This map covers Gravity Circuit v1.2.1 and the captured SDK image in
`/Users/jaimin/Documents/Codex/mac2jb-gravcirc-profiles`. The target is accepted
by the offline host and materializes captured SDK code signatures. Transport,
CRC-32, SHA-256, timing, the integrated application worker, a 512 KiB owned
save write, and one abort-control pinning window have live qualification
evidence. The positive canary marker and 4/4 pipeline have not passed.

## Pinned evidence

| Requirement | Evidence | Limit |
| --- | --- | --- |
| Current application | Title `01008d9019128000` | The live process identity must still match. |
| SDK image | 6,148,096 bytes, SHA-256 `9016be5c93da27fa4bf54c816fc8ffe48e2661e309bc8584da507e951723ef52` | A new session must verify the live code bytes. |
| Transport | `memcpy` +`0x589198`, `memmove` +`0x5894e0`, `svcQueryMemory` +`0x1589e0` | Captured instruction signatures; runtime verification remains required. |
| CRC-32 | `nnutilZlib_crc32` +`0x6ff50`, SDK result `0xfaede953` | `qualify-crc.cjs` observed the standard `123456789` vector and matching SDK CRC over the held bridge. |
| Timing | SDK tick +`0x128660`, frequency +`0x128690` returned 19.2 MHz, sleep +`0x128520`; native counter 31.25 MHz | `qualify-timing.cjs` observed 100 ms and two 1 s intervals; target uses a 10% tolerance for scheduling overhead. |
| Filesystem mounts | Mount table +`0xcff8f8`; `rom` and `save` were observed; proxy getter +`0xb6120` | Captured data and code signatures do not establish live object identity on a later boot. |
| Session manager | 2,048-byte state, value 3 at +92; proxy global +`0xcff930` | Read-only fresh-boot validation is needed before opening an owned domain. |
| RomFS vtables | Implementation +`0xc97f90`, storage wrapper +`0xc98b20`, service +`0xc998a8` | Verify the live mounted object and vtable entries. |
| Worker gadgets | `sdk-worker-layout.v1.2.1.json`, `sdk-raw-svc.v1.2.1.json`, and `gravcirc-app/thread-code.json` pin the frame and SVC wrappers | An isolated owned worker and the integrated application-only worker passed with cleanup. The positive FS canary is a separate gate. |
| Light events | `sdk-event-code.v1.2.1.json` pins `LightEventType` code and eight function signatures | Wait/signal behavior worked in the isolated worker qualifier; other event sequences remain unqualified. |
| SHA-256 | `sdk-sha256.v1.2.1.json` and `gravcirc-app/hash-code.json` pin SDK +`0x4cb0` | Live owned-buffer checks matched empty and `123456789` digests, preserved input and output guards, and left the bridge ready. |
| Affinity and session calls | Captured code is pinned in `gravcirc-app/thread-scheduling-reference.json` and `sdk-functions.gravcirc.json` | Same-core raw-SVC affinity and the integrated application-only worker passed. |
| Save write | `switch2-Q8jJxz` wrote and read back 512 KiB, deleted its scratch file, and verified cleanup | This verifies the bounded save operation, not the FS overwrite. |
| Pinning window | `switch2-Q8jJxz` measured a 13,616-byte persistent allocation, exact counter restoration, pending-request overlap, and an unchanged canary in an abort-control wave | No positive marker hit has been verified. |

`target.gravcirc.json` now records the measured 13,616-byte pin and a zero-byte
jitter tolerance. Its canary gate passes against the verified
`switch2-Q8jJxz/switch2/geometry-current.json` proof. Zero is the permitted
tolerance for this guarded test, not a measured maximum across boots.
`fieldCopies`, retained capture geometry, SM offset, and RO donor remain unset;
the full FS path remains gated.

## November 13 live diagnostics

- `switch2-SyoNsA` reached the FS acquisition stage and completed one
  qualified positive wave. It returned `0x2eec02`, left the owned canary as a
  file, and cleaned up. This is a qualified marker miss, not a canary hit or
  completed FS acquisition.
- `switch2-Ah3b4O` sent a direct two-X `GetEntryType` request. Its one-X
  directory control returned `0/type 0`; the two-X terminator packet returned
  transport `0xCE01` without a CMIF result. The run reported complete native
  cleanup. The transport rejection gives no path parser result.
- `switch2-Ps9xIz` compared the basename at byte `0x7ff` with a basename
  starting at the `0x800` seam. Both qualified first-X marker controls
  returned `0/type 1`, and their absent controls returned `0x202`. Qualified
  seam marker waves returned `0x202` and `0/type 0` (directory); none selected
  the file or changed the FS canary. The run completed with clean resources.
- `switch2-UgIXPi` used the same owned early-NUL file path with one X
  descriptor: size `0x800` returned transport `0`, CMIF `0/type 1`; size
  `0x801` returned transport `0xCE01` with no CMIF. It completed with clean
  resources. The direct-length diagnostic's `0x1000` and larger single-X
  requests are therefore unsupported by this observed packet shape.

The four tail path inputs in the wave are separate opcode-1002 IPC requests;
they are not HIPC fragments of the trigger's `GetEntryType` request. Current
evidence does not show a file lookup across the first-X seam, and no owned
canary overwrite has verified. The first-descriptor file lookup is an ordinary
owned path control, not an FS escalation result. Do not promote these
diagnostics into the full-FS gate.

## Remaining gates

1. On a fresh session, verify the title, SDK mapping, transport, mounts,
   application worker, and owned resource cleanup again. Never replay a native
   operation after an uncertain timeout.
2. Remove any prior `NS2_GAP` scratch from the save mount, re-list it, and
   measure free save space before the guarded canary. An earlier timed-out run
   retained `/NS2_GAP_1794538222838`; the later geometry run reported
   2,703,360 free bytes, 557,056 fewer than the prior 3,260,416. The next
   canary run must verify removal and at least 1,638,400 free bytes rather than
   assume the missing space has been recovered.
3. Run the canary-only path with the verified `switch2-Q8jJxz` geometry proof.
   The abort-control wave established a pending-request overlap and exact
   counter restoration, while leaving the marker unchanged. It did not show a
   positive marker. Require repeated positive marker hits, extent controls,
   and owned resource cleanup before treating the FS canary as verified.
4. Keep the full FS path gated until the accepted cache-copy repetition count,
   retained capture size and offset, live SM service guard, and RO donor are
   measured for Gravity Circuit. Do not copy reference-target constants into
   this target.
