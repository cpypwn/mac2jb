# Brick risks

Two consoles have been bricked by forks of this code, on the version that came before [70875fb](https://github.com/ItsNerisma/CivSwitchFS/commit/70875fbb45759dafef1085bbe18f1e954ab7f373). Both ran from a cartridge. None of that happened on this repository, but the core mechanism is the same here.

## The short version

CivSwitchFS exploits `fsp-srv`, **the one system service behind every filesystem** on the Switch. The exploit runs a race that puts the service's heap in a broken state, then uses that state to get elevated access.

**The risk is not just about rebooting mid-run.** Every wave of the race opens a short window where the `fsp-srv` heap is being torn apart and rebuilt. If another system service talks to `fsp-srv` during that window, it can get corrupted data back and write it to NAND. **You do nothing wrong for this to happen.** It is just background system activity landing at the wrong moment.

After the race, the exploit leaves a cache alias and a write endpoint in `fsp-srv`'s memory. If the service flushes one of those on a clean reboot, a game exit, or under memory pressure, corrupted data lands on NAND. The exploit cleans up after itself. Cleanup can fail.

Rebooting mid-run is the most likely trigger. But the race itself carries risk on every single wave.

## The risks

The exploit builds a cache alias in `fsp-srv`'s heap: a content-storage cache entry whose offset field is overwritten, so a read at one offset returns the bytes of another. That is the read primitive. 

Three moments put the console at risk.

### 1. During each wave (the risk you cannot remove)

Each wave frees 59 reservation objects while 11 IPC requests are still in flight. For a moment, path-normalization writes reuse that freed memory.

`fsp-srv` serves every filesystem client in one process. If another service sends a request in that window and reads from the transitional heap, it can walk away with bad data and persist it. We do not control that.

No user action triggers this. You cannot see it or prevent it. It is the price of the race.

A logic-bug exploit, one that never puts a shared service's heap in a transitional state, would remove this class of risk entirely. Nothing like that exists as of today.

---

### 2. While the cache alias is active

The copy waves install an alias prefix into a content-storage cache entry. Its offset field now points somewhere else in memory. If `fsp-srv` flushed that entry, it would write whatever the corrupted offset points to, not the original data...

In practice the entry stays clean from `fsp-srv`'s point of view. The race placed those bytes through the path normalizer, not through `IStorage::Write`, so the internal dirty flag was never set. **A clean entry is never flushed.** Evicted, yes. Written to storage, no. The risk here is low as long as the entry stays clean.

Cleanup starts with `IStorage::OperateRange` (operation 2, invalidate), which drops the clean entry without touching NAND. Even if cache invalidation is not confirmed, since no `IStorage::Write` went through this entry, it remains clean. When workers are stopped and no retained endpoint is active, the payload reports `STATE IS SAFE TO RESTART`. This means normal shutdown should not flush the entry. It does not verify that `fsp-srv` evicted it from memory.

---

### 3. While the retained endpoint is active

After discovery, the exploit installs a retained endpoint: cache descriptors that let it aim `IStorage::Write` calls into `fsp-srv`'s heap for the PID promotion.

Those writes go through the normal write path, so the cache manager marks the entry dirty. **From here on, invalidation is off-limits.** It could trigger a flush of corrupted data to NAND.

---

### What to do

- Let the run finish. A failed attempt is not dangerous by itself. The last log line tells you where you stand.
- Never reboot or close the game while the exploit is running.
- Any log line starting with **`STATE IS UNSAFE`** means: do not close the game or reboot normally. Hard reboot now, hold the power button for 15 seconds.
- **`STATE IS SAFE TO RESTART`** means no dirty retained cache endpoint remains. Relaunch the game normally.
- `You just Civ Sevened your machine, congrats` means it worked. The write endpoint stays active on purpose, for follow-up payloads. `/hole` is gone and the temporary handles are closed.
- `STATE IS UNKNOWN`, a crash, or anything else: assume the worst and hard reboot.

> [!IMPORTANT]
> Devs building on this, it's your job to properly clean the god handle afterwards!

---

### Why a hard reboot is the safe option here

Normally you should never hard-reboot a console. Here it is the right move, and the reason fits in one line: **the corrupted entry lives in RAM only, and the normal shutdown is what would write it to NAND.**

Where would it land? A cache entry belongs to one storage. The flush sends the bytes back to that storage, at the entry's offset. The corruption changes the offset, not the storage. So the flush stays inside the game's own content. The one corruption that can reach anywhere else is the race from section 1.

- Normal reboot or game exit: `fsp-srv` finalizes and writes its dirty cache entries back to their backing storage. On a cartridge without an update, the write fails: read-only media. With an update or on a digital copy, the content lives on NAND. Nobody knows how that writeback ends.
- Hard reboot (hold power 15 seconds): power is cut before any shutdown code runs. `fsp-srv` never finalizes, and the corrupted entry dies in RAM.

On a cartridge the advice is caution, not necessity: the write cannot land anyway. But the payload cannot tell which storage is behind the game. The advice has to hold for a digital copy too.

And the reboot itself damages nothing. Everything else in RAM is rebuildable machinery. Every wave had already committed its save writes. The corrupted entry has nothing queued to NAND. Its dirty flag lives in the content-storage cache, not in the save journal. Its only road to NAND is the shutdown flush, exactly the one you are preventing. The storage controller survives power cuts, so an interrupted write is lost, not half-written.

---

### What happens to `/hole` after a crash?

A crash can skip the normal end-of-attempt cleanup and leave the saved `/hole` tree behind. Its `commit_data` file is 7 MiB; about 8 MiB is the save dirty-cache limit. A hard reboot clears the unsafe cache entry from RAM, but it does not remove saved files.

After a crash or unknown state, hard-reboot before launching another attempt. If `/hole` remains, the first attempt finds it during setup and stops before running any waves. Its end-of-attempt cleanup deletes the tree through the reserved temporary save handle, commits the deletion, and verifies that `/hole` is gone. If cleanup and the other safety checks pass, the payload logs that it is safe to retry and starts the next attempt. Otherwise, it stops. A completed attempt with verified cleanup removes `/hole` itself; this path handles a crash that skipped cleanup.

### References

- [Kurumuz/ns2jb `probe-reserved-gap.cjs`](https://gitlab.com/kurumuz/ns2jb/-/blob/main/engine/switch2/memory/probe-reserved-gap.cjs#L1132): documents why you never flush or invalidate a redirected dirty entry, and why clearing its valid byte makes finalization skip the synthetic pointer
