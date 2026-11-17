# Balatro canary geometry gate

This plan targets the pinned physical Balatro `1.0.1f-FULL` image. It is an
offline evaluator, not a live probe. It neither sends RPC nor performs an FS
wave. No Balatro marker hit or FS stage 2/4 has been verified.

The two 0→1→2→1→0 storage staircases reported the same 14,096-byte change in
`fsp-srv` command 1009 diagnostic index 5, with no-storage controls and full
restoration. That value is a candidate diagnostic drop. Command 1009 reports a
peak free-size statistic; the value is not an independent measurement of an
allocation's size. Do not use it as an exact pin stride or copy a marker offset
from Civilization VII, SmileBASIC or Gravity Circuit.

The evidence sequence is:

1. Recheck the pinned SDK image, retained arena, worker, staircase, and owned
   cloned save handle on the same boot. The owned clone must read the exact
   16-byte marker and the equal-length absent path, then close its handle and
   delete its marker. A direct or cloned file read is only a path control.
2. Measure Balatro's native counter frequency and a target-specific pin
   placement and receive order. The current SDK tick worker result does not
   establish the native counter or an FS worker schedule. Record request roles
   and start/end ticks from the Balatro run itself. The shared Civ/Gravity role
   names and timing margins are not target evidence.
3. Run at most two independent abort controls. Each requires stable pairs of
   command-1009 samples before and after a matched no-storage action; the
   diagnostic must return to its original value. The held and through request
   lifetimes must overlap the trigger on one verified clock. Abort before any
   positive marker attempt, make no new save writes, retain the exact marker
   file, verify the absent path, close owned handles and preserve the borrowed
   session. Stop immediately on any failed control; do not automatically
   repeat a failed native call.
4. Only after both abort controls pass may a separate positive wave be
   evaluated. It needs its own distinct overlap evidence and matched
   no-storage controls, plus the exact nonce-bound marker bytes read from the
   FS acquisition path and the absent-path result `0x202`. Reading the marker
   from the save or cloned handle does not count. Even a verified marker hit
   does not by itself establish 2/4 or enable later stages.

`canary-geometry-plan.cjs` enforces these gates on supplied evidence. Its
test fixtures show the result shape; they are not hardware observations. The
next safe live gate is a bounded timing and placement measurement that uses
the verified Balatro worker and owned handles without treating 14,096 as an
exact size. A positive marker attempt remains disabled until that measurement
and both abort controls pass.

`node integrations/balatro-fs/fs-native-order-live.cjs <switch-ipv4> <mac-ipv4> <retained-arena-nonce>`
is the next-session serial control. It first qualifies the pinned SDK tick
against a measured 250 ms host-time envelope. It then brackets one owned
storage open and close with native ticks, sampling stable command-1009 pairs
before, while held, and after. Matched no-storage request sequences are
sampled at the baseline, while held, and after restoration. Any clock,
diagnostic, receive-order, or cleanup mismatch stops the run. It uses no save
writes and sends no marker wave.

That control measures serial request and receive order and a candidate
diagnostic change. It does not reveal the pin's address, exact allocation
size, or concurrent request overlap. Those still require a Balatro-specific
worker and independent evidence before the abort-control gate can open.
