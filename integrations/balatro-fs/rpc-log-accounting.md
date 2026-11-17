# balatro rpc log accounting

The Balatro 1.0.1f save writes its RPC activity to savedata. In the bundled
image, `bl/app.lua` gives `events('RPC')` to `bl/rpc.lua`. Connect, request,
reply and disconnect events call `log.log`; `bl/log.lua` then calls
`love.filesystem.append('bl_log.txt', ...)`. The original read-only FS probe
also logged its banner explicitly. Its native FS calls did not write a save,
but the RPC request could still grow `bl_log.txt`.

`rpc-log-snapshot.cjs` removes the probe's explicit banner logging. It reads
free space, the absent-path result, `bl_log.txt` size, `bl_phase.txt` size and
the installed `bl/log.lua` source in one request. The source hash must match
the bundled logger. Ordinary RPC events still write to the log, so the
snapshot is not globally read-only.

The marker preflight compares snapshots around one bounded native-order
control. It rejects a changed logger, absent path, phase-file size, arena,
image or native cleanup. It reports exact log growth. A change in free space
remains a hard stop, even if the log grew: logical file size alone does not
prove how many savedata allocation units were consumed or exclude another
writer. A measured allocation unit and a complete other-file accounting
would be needed before such drift could be attributed to the log.

Temporarily replacing the logger in memory would suppress console events and
could leave the running game with altered logging after an interrupted probe.
This diagnostic does not replace the logger or modify the installed save.
It does not place a canary marker or verify FS stage 2/4.
