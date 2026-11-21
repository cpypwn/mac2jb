> [!NOTE]
> I did not had the time to review this yet... it's still sloppy

# How the Core Sets fsp-srv Identity PIDs to 1

This document follows the code from its first `fsp-srv` session through the
PID updates. It starts after the core is running in the game with the loader's
memory, function-call, thread, and IPC helpers. The initial CivSwitch exploit
is outside its scope. Complex terms link to definitions in the
[glossary](#glossary).

[*`fsp-srv`*](#fsp-srv) is Horizon OS's filesystem service. The game calls it
over [*IPC*](#ipc). [*IStorage*](#istorage) is the interface used for
content-data reads and writes. A [*cache alias*](#cache-alias) makes cached
bytes for one storage offset appear at another. [*PID*](#pid) means process ID.

```text
Concurrent filesystem race
        ↓
Verified IStorage cache alias
        ↓
Locate fsp-srv cache and identity objects
        ↓
Retained IStorage-backed read/write endpoint
        ↓
Set the root, NCA, and save identity PIDs to 1
```

The kernel supplies the real game PID in the `SetCurrentProcess` IPC special
header. The core changes the identity fields that `fsp-srv` already stores; it
does not alter the game's PID or forge that header.

## 1. Stage and trigger the race

[`src/core.js`](src/core.js) runs the stages in order. The core allows up to
ten safe-to-retry attempts by default. A retry requires quiescent workers,
verified `/hole` absence after commit, and retirement of any installed cache
alias. If the retirement wave is not qualified, a readback must show the
candidate's original bytes at the aliased offset before retrying. A failure to
close an ordinary handle is reported but does not by itself block the retry.
Attempt buffers are freed after workers and cleanup IPC have ended, even when
ordinary handles remain open. Each timing adjustment adds one attempt to the
budget, up to 30 total, so every changed schedule gets a chance to run. The
30th attempt is reserved for validation and does not retune again. Retuning
requires fewer than half of the positive waves to qualify and at least two
waves failing the same timing gate alone; overlap retuning also requires one
recurring role to stand out. It moves one parameter per campaign and preserves
at least 50 microseconds between adjacent programmed start offsets. At the
retry cap, a cumulative qualified-window rate of at least 50% prompts a game
restart before another run.

[`src/core/steps/setup.mjs`](src/core/steps/setup.mjs) opens an `fsp-srv`
session, clones the mounted save filesystem, creates a temporary `save:/hole`
tree, and opens content-storage handles. The tree contains a
[*canary*](#canary) file and a file used to write [*dirty data*](#dirty-data)
to the save. The canary's entry type is checked before and after the race.

[`src/core/steps/campaign.mjs`](src/core/steps/campaign.mjs) and
[`src/core/wave/orchestration.js`](src/core/wave/orchestration.js) coordinate
each wave. The core writes 8 MiB of [*dirty data*](#dirty-data), opens 59
[*reservation objects*](#reservation-object), and starts 13 [*workers*](#worker).
Their requests overlap to shape object lifetimes in the `fsp-srv` heap:

| Worker | Request |
|---|---|
| W0 | Save `Commit` |
| W1 | 64 KiB `IStorage::Read` |
| W2–W5 | Four fragment requests (`cmd 1002`) |
| W6 | `GetEntryType` for the canary |
| W7–W8 | `RenameFile` requests |
| W9 | Pin/counter checks, then release the reservation group |
| W10–W11 | Guard `RenameFile` requests after the release |
| W12 | Long-path `GetEntryType` trigger |

The trigger waits for W11's guard to start and for W1's read to finish. The
read must remain active for at least 300 microseconds after the guard starts.
`Commit` and the fragment requests span the entire trigger call; the canary,
renames, and guards must still be active when it starts. Abort and
negative-control waves qualify the timing. A qualified positive wave
temporarily changes the canary from file to directory; the post-wave check
must find it restored as a file.

[`src/core/steps/alias.mjs`](src/core/steps/alias.mjs) runs the same race to
copy controlled bytes into a candidate [*cache entry*](#cache-entry). The
18-byte prefix sets its [*cache label*](#cache-label) to offset `0x1400000`,
followed by eight `A` bytes, a [*dirty flag*](#dirty-flag), and a [*NUL byte*](#nul-byte).
Since the copy stops at NUL, the core splits it into seven shorter writes using
[`src/core/helpers/wave.mjs`](src/core/helpers/wave.mjs).

Before the race, reads at offsets `0` and `0x1400000` return different data.
After the cache label changes, reading `0x1400000` must return the bytes saved
from offset `0`. That readback confirms the alias. The same mechanism can then
install cache headers that expose selected `fsp-srv` memory ranges.

## 2. Find the cache and identity objects

[`src/core/steps/discovery.mjs`](src/core/steps/discovery.mjs) opens and primes
nearby storage objects. Through the alias, it reads a 2 MiB block, closes one
object, and reads again. It repeats this across the objects; changed cache
blocks reveal candidate pointers to their [*backing memory*](#backing-memory).
Candidates must pass address, alignment, cache-layout, and readback checks.

The core scans bounded memory ranges for `fsp-srv`'s
[*domain-object table*](#domain-object-table), which maps [*domain IDs*](#domain-id)
to in-memory objects. It takes the root ID from a fresh domain session, verifies
the table entry and object layout, then follows the root's links to its [*NCA*](#nca)
(game-content) and save backends. Cloning the root three times must change only
its [*reference count*](#reference-count), by exactly three. After closing the clones,
the full object must match its original snapshot. Ambiguous object or
cache-array matches are rejected.

The validated objects contain the three PID fields:

| Object | PID field offset |
|---|---:|
| Root filesystem object | `+0x30` |
| NCA backend object | `+0x20` |
| Save backend object | `+0x28` |

## 3. Build a retained read/write endpoint

[`src/core/promotion.mjs`](src/core/promotion.mjs) turns the verified cache
array into a retained [*memory endpoint*](#memory-endpoint) with two
buckets:

```text
IStorage offset 0                  IStorage offset 0x4000
┌──────────────────────┐           ┌─────────────────────────┐
│ Control bucket       │ points to │ Data bucket             │
│ cache descriptors    │──────────▶│ selected fsp-srv address│
└──────────────────────┘           └─────────────────────────┘
        ▲                                         │
        └──────── set and read back pointer ─────┘
```

The core points a data descriptor at a chosen `fsp-srv` address, then uses
`IStorage::Read` or `IStorage::Write` at offset `0x4000` to transfer data in
chunks of at most 16 KiB. It checks descriptor pointers and write readbacks,
and first proves the channel with scratch bytes that it restores. Before
keeping the endpoint, it sets the cache owner's [*cache loop*](#cache-loop)
count to zero, verifies that state, and repeats the scratch check.

## 4. Set and verify the PIDs

The core uses the retained endpoint to update the three validated identity
objects in `fsp-srv`.

For each object, the core first rereads and compares the full object with its
saved snapshot. It prepares the expected object with only the PID field set to
`1`, writes that 64-bit field, then rereads the whole object. The write passes
only if every other byte is unchanged. Finally, it rereads all three objects
and confirms each PID is `1` before proceeding.

At that point, the root, NCA, and save identity checks in `fsp-srv` see PID
`1`. The core then opens [*User content storage*](#user-content-storage) (command
110) and lists `/` as a post-promotion check. If it passes, the domain session stays open as
`globalThis.fspSrv`; the listing confirms access but does not produce the PID
changes.


## Glossary

| Term | Definition |
|---|---|
| <a id="fsp-srv"></a>**fsp-srv** | Horizon OS's filesystem service. Civilization VII sends it filesystem requests. |
| <a id="ipc"></a>**IPC** | Inter-process communication: the messages the game sends to a system service such as fsp-srv. |
| <a id="istorage"></a>**IStorage** | An interface for reading and writing storage data. |
| <a id="pid"></a>**PID** | Process ID: the number fsp-srv uses to identify the requesting process for permission checks. |
| <a id="cache-alias"></a>**Cache alias** | A state where a cache entry for one storage offset makes its cached bytes available at another offset. |
| <a id="cache-entry"></a>**Cache entry** | A record used by the storage cache to track cached data and its metadata. |
| <a id="cache-label"></a>**Cache label** | The storage offset recorded in a cache entry. |
| <a id="dirty-data"></a>**Dirty data** | Save data the payload modifies before each wave so the save Commit request has work to do during the race. |
| <a id="dirty-flag"></a>**Dirty flag** | A cache-entry bit that marks data as modified. |
| <a id="nul-byte"></a>**NUL byte** | A zero byte used to end a string or byte sequence. |
| <a id="canary"></a>**Canary** | A temporary file whose entry type is checked before and after the race to detect the expected filesystem effect. |
| <a id="reservation-object"></a>**Reservation object** | An object opened through the reservation interface. A group of these objects helps shape allocation lifetimes during a wave. |
| <a id="worker"></a>**Worker** | A thread that sends one of the overlapping IPC requests in a wave. |
| <a id="backing-memory"></a>**Backing memory** | The memory region that stores a cache entry's data. |
| <a id="domain-object-table"></a>**Domain-object table** | A table in fsp-srv that maps domain IDs to in-memory service objects. |
| <a id="domain-id"></a>**Domain ID** | The identifier used by a domain session to select one of its service objects. |
| <a id="nca"></a>**NCA** | Nintendo Content Archive: the game's content backend referenced by the root filesystem object. |
| <a id="reference-count"></a>**Reference count** | A count of the active references to an object. Cloning an object increases it; closing a clone decreases it. |
| <a id="memory-endpoint"></a>**Memory endpoint** | The retained two-bucket IStorage arrangement that reads and writes selected fsp-srv memory addresses. |
| <a id="cache-loop"></a>**Cache loop** | The cache owner's background update cycle. The payload disables it before retaining the memory endpoint. |
| <a id="user-content-storage"></a>**User content storage** | The User-type content filesystem opened after PID promotion; the payload verifies it by listing its root directory. |
