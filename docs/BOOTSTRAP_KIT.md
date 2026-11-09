# Optional NS2DK bootstrap helpers

NS2DK adds small, namespaced `COMMON DEF` helpers to the **pinned kurumuz five-argument bootstrap**. It is an experimental opt-in variant, not a replacement for the verified `NS2` program. The generator preserves every original byte and appends helpers; it never changes the upstream bootstrap, its hash, or the host's source identity.

The extra definitions and wrapper call frames may affect SmileBASIC allocation. Source-level checks cannot establish hardware compatibility. Do not describe this variant as a reliability improvement until the complete flow has been tested on a fresh console session.

## Generate and inspect

From the repository root, using Node.js:

```sh
node --test tools/bootstrap-kit/test.cjs
node tools/bootstrap-kit/generate.cjs tools/bootstrap-kit/generated --address 192.168.50.1
```

Use the Mac address reachable over the direct Ethernet link. Omit `--address` to omit the no-argument connection preset. Existing output files are never overwritten. The generated directory contains:

- `NS2DK.bas`: unchanged original bootstrap plus the extension.
- `NS2DK-manifest.json`: original/extension/output SHA256 values, expected source checksum, profile and validation limitations.
- `NS2DK-scratch-test.bas`: helpers with a harmless `START` stub; no exploit initialization or native-memory calls.

Generated files are ignored by Git. The manifest deliberately reports `hardwareValidated: false`; hardware acceptance belongs in a separate evidence record, not a generator assertion.

## Commands added

| Command | Behavior |
| --- | --- |
| `DKINFO` | Displays variant version, host, ABI, port and separate save name. |
| `DKHELP` | Displays the one-time startup sequence and recovery reminder. |
| `DKSTATUS` | Displays the existing phase and socket descriptor; explicitly does not infer whether REMOVE ran. |
| `V=DKCHECK(P,A,B,C,D)` | Returns 1 only for integer port 1024–65535 and four integer octets 0–255. Does not change bootstrap state. |
| `V=DKSTART(P,A,B,C,D)` | Rejects invalid arguments and nonzero phase before calling the original `START`. Rejection does not call `FAIL`, reset state or reconnect. |
| `V=DKCONNECT()` | Optional generated preset that calls the same guarded connector. |

The original `START(PORT,A,B,C,D)` remains unchanged. The range guard does not establish network reachability or authenticate the Mac. A correct IP and phase zero do **not** prove that the one-time REMOVE step was performed.

## Validate before adopting

1. Keep the original saved `NS2` untouched. Put the helper-only scratch test in an empty editor slot, checksum its transfer, and run it. Expected final output: `DK TEST ERRORS 0 CALLS 1`. The one call is to a harmless stub, not the actual bootstrap.
2. Check the generated manifest and original-byte prefix. Transfer the full variant to an empty slot and compare both source-check numbers using the manifest's Direct-mode command before saving it separately as `NS2DK`.
3. Use a fresh console application session for the actual bootstrap test. Follow the pinned host's required initialization and one-time REMOVE sequence; substitute the guarded START/preset only at the final connection step. A failed run is not retryable by resetting PHASE.
4. Verify the exact held session, requested operation and cleanup. A displayed connection message is not proof of filesystem access.

The current app's automatic saved-bootstrap flow uses its profile's fixed save name (`NS2` for kurumuz). It does not automatically select `NS2DK`; do not use that flow assuming the variant was loaded. This package does not modify that behavior or bypass pinned-asset checks.

Saving or selecting a program from a SmileBASIC menu does not complete the host handshake. Register the saved program in Favorites through Projects → select project → press - (Display Files) → highlight the program → hold A → Add to Favorites → confirm. Favorites launches initialization; the required Direct-mode steps still follow. No automatic registration is performed by this generator. Do not remap KEY(1)/KEY(2) as a shortcut: the original bootstrap uses those strings during address discovery.

## State and limits

The original bootstrap initializes PHASE to 0; BOOT advances it to 1 then 2; networking uses 3/4; RPC uses 5 and stops at 6; FAIL changes it to -1. The helper has no reliable state showing whether REMOVE was already attempted because that step is external to the program. It never performs REMOVE, repeats initialization, resets PHASE, closes sockets, adds privileges or installs persistence. Live RPC occupies the synchronous program loop, so DKSTATUS is not an independent concurrent monitor.

Primary references: [pinned kurumuz instructions](https://gitlab.com/kurumuz/ns2jb/-/raw/81d5bb114c856109dadaf1077d927a9f297fe58d/README.md), [SmileBASIC COMMON/RUN reference](https://sup4.smilebasic.com/en/doku.php?id=reference:all_references). Tests validate generation and source invariants; only the separate scratch run validates helper execution on SmileBASIC.
