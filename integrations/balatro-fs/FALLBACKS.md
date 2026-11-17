# Balatro target candidates — offline derivation and live checks

These offsets are leads for a Balatro-specific target, not a verified 3/4 configuration. The latest included run does not establish an FS-side marker hit or memory access.

Offline SDK: `/Users/jaimin/Documents/Codex/mac2jb-balatro-profiles/sdk-1.0.1f-code.bin`
(+ `sdk-first-16k.bin` = MOD0 header, `sdk-1.0.1f-dynsym.bin` + `-dynstr.bin` = symbols).
Data segment (GOT/relocations) is **not** available offline; those values are marked as runtime.

## 1. MOD0 header (from `sdk-first-16k.bin`, header at file offset 0x08)

| field | value | meaning |
|---|---|---|
| `dynamic_offset` | `0x00d386f0` | dynamic section (DT_RELA etc.), inside the data segment |
| `bss_start` | `0x00d4eff8` | start of BSS |
| `bss_end` | `0x00e049f8` | end of BSS |

Derived layout (SDK-relative offsets):
- code: `[0x000000, 0x5e0000)` (6160384 bytes)
- data (GOT/relocations/vtables): `[0x5e0000, 0xd4eff8)` = `0x76eff8` bytes
- BSS: `[0xd4eff8, 0xe049f8)` = `0xb5a00` bytes

## 2. `smServiceOffset` candidate = `0x00d5b55c` (offline code derivation; live unverified)

`nn::sm::GetServiceHandle` (`0x146ed0`) reads the live SM service session handle:

```
146f50  adrp x8, 0xd5b000
146f54  ldr  w0, [x8, #0x55c]   ; w0 = *(sdk + 0xd5b55c)  -> u32 session handle
146f58  bl   0x15f208           ; svc #0x21 (SendSyncRequest w/ user buffer)
```

`nn::sm::InitializeForManager` (`0x147350`) confirms the same page: it stores the opened
`sm:` handle at `0xd5b568` (and spins a lock at `0xd5b570`), i.e. the SM state block lives
around `0xd5b55c`..`0xd5b570`. The client-side session handle the pipeline needs is the
**u32 at `0xd5b55c`** (read by `GetServiceHandle`).

Fallbacks if `0xd5b55c` is wrong on live:
1. Use `0xd5b568` (the `InitializeForManager` write site) instead.
2. Scan the BSS page `sdk+0xd5b000` for a u32 in `[0x8000, 0x2000000)` that `svcSend` accepts.
3. Derive from `nn::sm::FinalizeForManager` (`0x147420`) / `Finalize` (`0x146ec0`) — they
   tail-call `0x5c4af0`, whose disassembly pins the same holder.
4. Live-verify by reading `sdk+0xd5b55c` as u32 and trying `svcSend` on it.

## 3. `retainedCaptureOffset` / `retainedCaptureBytes` (runtime — candidate only)

Semantics (from `ro/layout.cjs` + `retained/find-metadata.cjs`):
`retainedCaptureOffset = sdk - retainedCapture.address`, `retainedCaptureBytes = capture.length`.
These are a property of the live memory map (where the retained heap capture sits relative to
the SDK page), **not** of the offline code image.

Candidates / how to pin:
- `retainedCaptureBytes` candidate = data-segment size `0x76eff8` (the GOT/relocations region
  the cache-alias has to cover). LOW confidence — CIV7's `0x4d8000` is not the same shape.
- `retainedCaptureOffset` = read from the live `acquire.cjs` report:
  `retainedMemory.captures` entry `c` where `c.address + retainedCaptureOffset === sdk`
  and `c.length === retainedCaptureBytes`. No offline derivation; measure on boot.

Fallbacks:
1. Sweep `retainedCaptureBytes` over `{0x4d8000, 0x76eff8, 0x800000, 0x1000000}` and pick the
   capture length `acquire.cjs` actually reports.
2. Derive `retainedCaptureOffset` from the first `adrp`/`add` data reference in the code
   (the SDK's data page offset) as an upper bound.
3. If no capture matches, re-run `find-metadata.cjs` and read `-layout.json`'s
   `sdkDiscovery.nominal` to recover `sdk - retainedCapture.address`.

## 4. `aliasOffset` / cache-mount layout (candidate constants)

`probe-reserved-gap.cjs` uses these defaults, which have not been measured for Balatro:
- `markerOffset = 0x2340` (SmileBASIC-era path-overflow landing target)
- `aliasOffset = 0x1400000` (20 MiB content-storage offset; verify that the chosen storage has that extent)

Fallbacks:
1. Keep `0x1400000`; sweep `aliasOffset` upward in `0x100000` steps if the aliased read
   returns the ordinary content (no divergence).
2. Keep `markerOffset = 0x2340`; if the Balatro `/..\` overflow lands elsewhere (the save is
   "lenient" per STATUS.md), re-measure the landing offset and set `NS2_MARKER_OFFSET`.
3. Use `fs-side-readback-gate.cjs` (`ordinary` vs `candidate` zero/alias readbacks) to pick a
   working `aliasOffset` without a full probe sweep.

## 5. `fieldCopies` candidate = 1

CIV7 and gravcirc both use `1`; `target.cjs` requires `target.fieldCopies === geometry.fieldCopies`.
Fallback: try `2` if one field copy is aliased away on live.

## Proposed `target.balatro.json` (to fill after live measurement)

```json
{
  "name": "balatro",
  "fieldCopies": 1,
  "retainedCaptureBytes": "<measure from acquire.cjs; candidate 0x76eff8>",
  "retainedCaptureOffset": "<measure from acquire.cjs; sdk - capture.address>",
  "smServiceOffset": 14005596
}
```
(`0xd5b55c` = 14005596 decimal.)
