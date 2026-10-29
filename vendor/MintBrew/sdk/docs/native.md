# Native bridge and investigation

## Execution model

Apps execute GPU shaders. The host calls existing ARM64 routines in the
qualified SmileBASIC process through the wireless native bridge. Four-argument
calls use the normal RPC path; six-argument calls use the owned pthread worker
in `sdk/native/six.cjs`. The worker is assembled from verified existing dispatch
instructions and exits through the native pthread exit path. It is not a
facility for executing arbitrary compiled application CPU code.

The launcher repeats a 60-frame native cycle continuously. Each frame reads
controller, motion, keyboard, generic mouse, Joy-Con optical samples and touch,
then submits graphics. The native worker restores its qualified frame and
re-enters it without a host round trip. Results live outside the restored range.
The host can select a separate exit context, wait and join at a cycle boundary.
Only app/service transitions and controller connection changes pause rendering.
Haptic envelopes use a separate finite native job with timed sends and final
zero-amplitude commands, so they finish even if the host disconnects.

## Qualification

The bridge qualifies the supported SDK image when establishing a session.
Each exported function used by the hardware adapters additionally has a small
instruction signature checked through `verify-function` before allocation or
calls. Definitions in `native/hid-functions.json` and
`native/service-functions.json` contain symbol, module-relative offset, function
size and expected instruction bytes. Offsets are not portable across updates.
Some entries are short branch stubs; their safety relies on the full session
qualification as well as the per-function check.

`native/client.cjs` allocates an aligned owned region, zeros it, and bounds-checks
reads/writes including noninteger and negative arguments. It accepts only named
qualified functions and up to four native arguments. Native results remain
BigInt; `.result()` explicitly interprets the low 32 bits as unsigned Result.
Socket return values instead use signed conversion. These differences matter:
`0xffffffff` is an error return, not a giant valid descriptor.

The client does not infer a native calling convention from a name. Output
buffers, handle-by-reference arguments, array lengths and ownership were
inspected per wrapper. For example, `GetNpadStyleSet` takes an ID pointer, not
an ID value, and `GetSixAxisSensorStates` takes count-out, state-out, count and
handle pointer. The motion structure is 96 bytes, keyboard 48 and mouse 40.
The audio-input listing uses 256 bytes per device entry.

## Investigation workflow

1. Establish a fresh supported session with the normal launcher startup. Normal
   runs use a temporary directory that is deleted on exit; use
   `HB_KEEP_SESSION=1` to retain the session under `runs/` for inspection.
2. Run `node sdk/tools/audit.cjs runs/launcher-SESSION`. Examine imports,
   definitions, namespaces and module-relative offsets in its private JSON.
3. For a candidate, obtain a private local code capture through the existing
   read-only inspection machinery. Keep captures in a retained debug session;
   do not add a full SDK image to the repository.
4. Disassemble only the relevant range with Capstone:

   ```sh
   python3 -m venv .venv
   .venv/bin/python -m pip install capstone
   .venv/bin/python sdk/tools/disassemble.py runs/SESSION/sdk.bin 0xOFFSET --bytes 256
   ```

5. Follow output stores, argument loads, branch targets and failure paths.
   Distinguish a Result-returning detail wrapper from a public wrapper that
   aborts the process on failure. Verify prerequisite service and initialization
   state before considering a call. A service-open result is not sufficient to
   justify arbitrary method calls.
6. Add a small exact instruction qualification record only after establishing
   the signature. Use owned, bounded, aligned output memory. Never reuse the
   launcher's temporary scratch for a long-lived service object.
7. Probe a bounded read-only operation first, save raw Results and validate the
   output's size/range. Add cleanup before testing starts/stops or other stateful
   operations. Do not finalize a subsystem owned by SmileBASIC or another client.
8. Integrate a typed host API and shader operation only with tests, error
   semantics and capability documentation. Record untested hardware explicitly.

The audit tool walks every function symbol but does not prove semantics of
every function. The Capstone script enforces aligned ranges up to 4096 bytes and
does not connect to or execute code on the console. For larger investigations,
inspect multiple explicit ranges rather than blindly invoking exported code.

## Resource and failure rules

Only one native hardware owner should run at a time. Stop the worker before
independent probes touch motion handles or the SDK tail. Allocation lifetime is
the console session; app switches reuse the adapters. Native sockets are closed,
NFC detection is stopped/finalized when owned, service discovery handles are
closed, vibration sends a zero-amplitude stop, and motion is stopped on normal
runtime shutdown. An abruptly killed host cannot guarantee those cleanup calls;
restart SmileBASIC for a clean session after an interruption.

Keep native Result codes intact. Some public Nintendo SDK wrappers can abort
on a failed precondition rather than return an error. Testing on one version
and one peripheral does not establish behavior on another. The SDK fails
instruction qualification rather than trying guessed offsets on a new build.

## Adding a new shader operation

Reserve an opcode in `host/layout.cjs`, add a named manifest capability and
validation in `host/runtime.cjs`, and add its dispatch with strict argument and
payload bounds. Add a helper to `include/hb.glsl`, update the protocol reference,
and test undeclared access, invalid arguments, success, cleanup and duplicate
sequence handling. Rebuild generated shader headers and assets. Use the
launcher for an end-to-end example when the feature belongs in normal navigation.

## Direct Switch 2 HID access

`audit-loaded.cjs` inventories every readable executable mapping, including the
compatibility libraries, rather than only the old title SDK. Six loaded modules
were found in the tested session. `native/ipc.cjs` implements bounded non-domain
CMIF requests using a qualified send routine and owned service handles; it is
an investigation interface and is not exposed to GPU packages.

Direct HID Jcms initialization accepted a 16 KiB transfer buffer. Starting the
16 player/side handles produced signed optical movement; the launcher snapshots
that buffer on-console before each frame. This path does not require an exported
Jcms wrapper in SmileBASIC's SDK. The Switch 2 vibration-device query also
identified the tested devices. Nmouse pointer initialization remains exploratory;
apps use the verified raw Jcms path and implement their own cursor.

The Jcms decoder was checked against live captures, including its sample guard,
signed deltas and ring layout. Generic mouse and Jcms data remain distinct APIs.
For protocol cross-checks see [Switchbrew HID research](https://switchbrew.org/wiki/HID_services)
and [libnx CMIF implementation](https://github.com/switchbrew/libnx/blob/master/nx/include/switch/sf/cmif.h).
