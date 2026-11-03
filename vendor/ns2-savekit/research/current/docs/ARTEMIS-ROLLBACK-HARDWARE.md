# Artemis Launcher rollback — hardware validation status

**Status: BLOCKED — no destructive save operation was performed.**

The rollback lifecycle has not been validated on hardware. A promoted ns2jb
filesystem-root session could not be obtained in three controlled attempts on
2026-11-02, so the installer's restore path was never allowed to touch the
console save. The existing Artemis Launcher installation is intact.

| | |
| --- | --- |
| console | retail Nintendo Switch 2 |
| firmware | 23.0.1 |
| title | Seedsow Lullaby Demo `010042d022aea000` (ver. 1.0.0) |
| account | redacted; the demo's existing account |
| installer | PR #8 head `2998192` |
| HTTP transport | PR #9 head `d40992a` (read-only use only) |
| save writes performed | **none** |
| console left | HOME menu, game closed |

## Acquisition attempts

The documented nine-argument bootstrap was used
(`V=START(39380,192,168,50,235,0,0,0,0)`), one session per boot, no
`--keep-open`, after a verified force-off and cold boot each time. All three
stopped at ns2jb stage 2/4 (FS memory acquisition):

| attempt | result |
| --- | --- |
| 1 | `The bounded native leak contains no qualified, encodable link candidate` |
| 2 | `The planned bucket period did not qualify on this candidate` |
| 3 | `General-heap allocation changed while the cache was retained; stop overwrites and recover` |

Earlier in the same day, attempts also failed with `Native batch did not
terminate; resources retained`, `Clean alias did not qualify within its attempt
limit`, and `Overwrite missed the qualified canary`. All are timing-sensitive
allocator qualifications inside the exploit, not errors from this repository's
save tools. The console was power-cycled back to HOME after each attempt.

A separate `NS2_TMP_FALLBACK=1` attempt found the tmp mount above the fallback
threshold, so that mitigation did not apply.

On 2026-11-02 the failures were re-investigated rather than retried blindly.
The host code is identical to the 52 historical successful sessions, the SD
card is not inserted, and the current runs split into four different
qualification failures. One deterministic defect was proven: the local
`allPending` test rejects `extent-present` waves that upstream's merged
`qualifyOverlap` accepts (27/30 replayed rows). An isolated host with that fix
advanced past extent requalification but then missed the canary. The full
evidence and the next experiments are in
[NS2JB-STAGE2-RELIABILITY.md](NS2JB-STAGE2-RELIABILITY.md).

## Test matrix

| id | test | status | evidence |
| --- | --- | --- | --- |
| H0 | Obtain promoted PID 1 FS-root session | **BLOCKED** | three stage-2/4 failures above, plus three controlled 2026-11-02 attempts (extent requalification, then canary after an overlap-fix experiment); see [NS2JB-STAGE2-RELIABILITY.md](NS2JB-STAGE2-RELIABILITY.md) |
| H1 | Validate session identity / title / account | **BLOCKED** | requires H0 |
| H2 | Complete read-only save pull + SHA-256 manifest | **BLOCKED** | requires H0 |
| H3 | Independent second backup copy | **BLOCKED** | requires H2 |
| H4 | Install Artemis through `save-write-stage.cjs` | **BLOCKED** | requires H0/H2 |
| H5 | Verify seven files + receipt identity | **BLOCKED** | requires H4 |
| H6 | Boot Artemis, Hello World, HTTP `/status`, `/eval` | not run this round | previously validated on the existing installation (HTTP only) |
| H7 | Receipt-driven restore `--dry-run` preflight | **BLOCKED** | requires H0; offline preflight tests pass |
| H8 | Actual restore (destructive) | **BLOCKED / NOT AUTHORIZED** | preflight never ran on hardware |
| H9 | Full post-restore save comparison | **BLOCKED** | requires H8 |
| H10 | Boot the game after restore | **BLOCKED** | requires H8 |
| H11 | Reinstall and confirm HTTP server | **BLOCKED** | requires H8 |
| H12 | Migrated legacy rollback on a disposable save | **BLOCKED** | requires H0 and a disposable save |

The existing installation was **not** used as a disposable target: no
authorized rollback environment existed, and the task requires an explicit
approval boundary before restoring its boot trigger. Without a session, that
approval could not even be exercised safely.

## What *is* validated offline

These protect the code paths that the blocked hardware test would exercise, but
they are not hardware evidence:

- restore staging with the writer's `cwd` set, including a real child-process
  read (and the same read failing from an unrelated directory);
- modern, migrated-legacy and original-legacy restore planning;
- restore preflight refusal for changed/missing/unexpected files, wrong
  account/title, corrupt backup, bad attestation and modified trigger;
- restore resume after a partial deletion or a trigger write whose receipt
  update was interrupted;
- post-restore verification of the original trigger and absence of added files;
- delete result contract (`0x202` not-found, explicit commit, verified absence);
- the full fresh → reinstall no-op → update → interrupted update → restore
  lifecycle using synthetic records.

## What is still required on hardware

1. Obtain a promoted FS-root session (timing-sensitive; retry on another boot
   or day).
2. Use a **disposable secondary-account Seedsow save** if one can be created
   and authorized; otherwise obtain explicit operator authorization to restore
   the existing installation's boot trigger after a passing dry-run.
3. Run H2–H5 (backup → install → verify), H7 (dry-run), then H8–H10 only with
   that authorization.
4. Re-run H11 and, separately, H12 with an isolated legacy fixture and
   `ARTEMIS_STATE`.

No claim of hardware rollback validation is made in this PR.
