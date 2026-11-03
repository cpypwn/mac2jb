# ns2jb stage-2 reliability: 2026-11-02 investigation

**Status: not resolved.** No promoted filesystem-root session was obtained, so
the Artemis rollback remains blocked. This note records the evidence, the one
defect that was proven and patched locally, and the next experiments.

## What was compared

The analyzer `tools/diagnose-ns2jb-acquisition.cjs` reads run folders offline:

```sh
node tools/diagnose-ns2jb-acquisition.cjs --root ~/ns2jb-rpc/runs
node tools/diagnose-ns2jb-acquisition.cjs --root ~/ns2-savekit/.rpc/runs --json
```

Historical runs in `~/ns2jb-rpc/runs` (229 runs) contain **52 successes** and
177 failures. The successful runs on 2026-11-01 13:17 and 20:56 used engine
`b989e4adafa2`, exactly the hash of the engine used by every failure later that
day. The host checkout (`run.cjs`, `engine/`, `bootstrap.bas`) is byte-identical
between the successful and failing hosts. So this is not a code regression in
the host copy.

Observed failure classes (historical + current runs):

| class | examples |
| --- | --- |
| `no-link-candidate` | bounded native leak contains no encodable link |
| `bucket-period` | planned bucket period did not qualify |
| `heap-drift` | general-heap allocation changed while the cache was retained |
| `canary` | overwrite missed the qualified canary |
| `cache-alias` | clean alias did not qualify |
| `native-batch` | native batch did not terminate |
| `extent-requalify` | extent-present waves never satisfied `allPending` |

Successful runs always had at least one native-link candidate (min 1; the
sample had 2–6). Failures can have 0–5. Pin cost was 13616 on every current run
(internal save); the 14992 value seen in older failures corresponds to the
historical SD-card save and is **not** present now.

## Environment checks

- microSD Express card: **not inserted** (System Settings > Data Management,
  read-only screenshot).
- SmileBASIC save: internal storage, free space 66,945,024 bytes and storage
  size 144,827,272 bytes, constant across all current attempts.
- Host network: the Mac's only active interface is **Wi-Fi (en0)**. No Ethernet
  adapter is connected. Upstream's README says Ethernet on both sides is
  required and rates the exploit around 20% success; this setup is therefore
  outside the supported timing configuration.
- The bootstrap is the same `bootstrap.bas` and the same nine-argument
  `V=START`; no `--keep-open` and one session per verified cold boot.

## Proven defect: the local `allPending` test is too strict

The local engine predates upstream's merged fix `81d5bb1` ("fix"), which
introduced `wave-overlap.cjs`. The local wave used:

```js
allPending: [...held, ...through].every(r =>
  r.startUs < trigger.startUs && trigger.endUs < r.endUs)
```

That requires **held** requests (canary, fillers, guards) to remain open past the
trigger's *end*. They only need to be held at trigger **entry**; only the
`commit`/`tail*` requests must span the trigger. Upstream qualifies:

```js
startedBeforeTrigger && throughTriggerEnd && heldLongEnough
```

Replaying the 30 recorded `extent-present` waves from the 00:44 run through both
predicates:

```
old allPending qualified:  0 / 30
upstream qualifyOverlap:  27 / 30
```

The other 3 genuinely had held requests finish before the trigger started. This
was a deterministic rejection, not jitter.

An isolated host copy under `/tmp/ns2jb-stage2` applied the upstream helper and
predicate. In the next hardware attempt the extent requalification passed and
`qualifiedReadSize` was set (1572864), then the run failed later at
`Overwrite missed the qualified canary` with zero link candidates. So the
overlap fix removed one deterministic blocker but did not complete acquisition.

## Current controlled attempts (2026-11-02)

| run | host | outcome |
| --- | --- | --- |
| `switch2-Oi0su5` | stock | extent requalification exhausted; `allPending:false` |
| `switch2-6wv9x7` | stock | same; 31/31 extent rows failed the old test |
| `switch2-uj4l9u` | overlap fix | extent passed; `Overwrite missed the qualified canary` |

No save write was attempted. The console was recovered to HOME after each.

## What the evidence supports next

1. **Wired Ethernet on host and console.** This is upstream's stated
   requirement and the one environmental difference from the documented setup.
2. **Upstream `wifi-console-grooming`** (`a176707`, `157cc14`): batches the 59
   manager reservations into one console-side native worker and adds canary
   delay selection. It is explicitly experimental and untested on hardware, so
   test it in a separate host copy and only adopt it if a controlled trial
   passes.
3. **Canary timing sweep** (`NS2_CANARY_DELAY_NS` on that branch): the current
   failure is now at the canary, so varying its delay is the next parameter,
   not the allocator geometry.
4. **Retry candidate selection for bucket-period failures**: one run had five
   encodable candidates but failed on the first; testing other candidates before
   aborting is a bounded, evidence-supported change. Do not accept an
   unqualified candidate.

## Safety

No exploit patch is included in PR #8. The overlap experiment lives only in a
temporary host copy; the working console installation and save were not
modified. Offline tests for the analyzer are in `tests/test_diagnose_ns2jb.cjs`.
