# Shader API and shared memory

All values are little-endian. `state.glsl` declares binding 0, an 8 MiB storage
buffer. The original 1024-byte ABI is unchanged; the root README documents its
fields. Application data starts at byte 1024 and retains its existing 7 MiB
limit. **Bytes `0x7f0000..0x7fffff` are SDK-owned**. Do not use them for app data.
The extension does not change the manifest's `abi: 1` value.

## Frame and input functions

| Function | Meaning |
| --- | --- |
| `uint hbButtons()` | Primary controller's current low 32 button bits |
| `uint hbPressed()` | Rising edges relative to `c.state.y` |
| `bool hbConnected()` | Primary controller state's connected attribute |
| `void hbEndFrame()` | Save buttons for next frame; call after processing edges |
| `vec2 hbStick(bool right)` | Signed normalized stick, radial 0.15 dead zone, length capped at 1 |
| `uint hbTouchCount()` | Touch count clamped to 16 |
| `vec2 hbTouch(uint index)` | Raw touch x/y in 1280×720 space; invalid index returns (-1,-1) |
| `void hbExit()` | Ask the host to return to the launcher at the next worker boundary |
| `void hbSound(uint id)` | Increment the sound event sequence and select a manifest effect |

Button constants: `HB_A`, `HB_B`, `HB_X`, `HB_Y`, `HB_L`, `HB_R`, `HB_PLUS`,
`HB_MINUS`, `HB_LEFT`, `HB_UP`, `HB_RIGHT`, `HB_DOWN`. The raw header preserves
all bits and both sticks if an app needs buttons without a helper constant.
Touch attributes and IDs remain available in `c.touch`; check end attributes
when interpreting a contact as held. The root README gives the record layout.

The host enumerates handheld ID 32, players 0–7 and default ID 16. It selects
the first present supported style in that order and supports FullKey,
Handheld, JoyDual, JoyLeft and JoyRight layouts. Selection is rediscovered
at initialization and explicit worker boundaries (with a five-second discovery cache). This is one primary controller API,
not simultaneous multiplayer input. Other style families are inventoried but
not implemented. Native reads run before each frame's GPU submission. If no
supported device is discovered, the legacy handheld read supplies disconnected
state until discovery finds a device.

## Hardware telemetry

| Function | Meaning |
| --- | --- |
| `bool hbAvailable()` | SDK magic and extension version match |
| `bool hbHas(uint flags)` | All requested read-success flags are set |
| `uint hbMotionCount()` | 0–2 currently sampled motion sensors |
| `vec3 hbAcceleration(uint sensor)` | Raw native acceleration vector; zero if unavailable |
| `vec3 hbGyroscope(uint sensor)` | Raw native angular-velocity vector; zero if unavailable |
| `mat3 hbDirection(uint sensor)` | Native nine floats grouped as three GLSL columns; identity if unavailable |
| `bool hbKey(uint usage)` | One of 256 keyboard usage bits; out of range is false |
| `vec2 hbMouse()` | Signed native absolute mouse x/y |
| `uint hbMouseButtons()` | Native button bitfield |
| `uint hbWord(uint offset)` | Raw telemetry word at a byte offset relative to the extension |
| `float hbFloat(uint offset)` | Interpret a raw word as IEEE float |

Flags: `HB_PAD=1`, `HB_MOTION=2`, `HB_KEYBOARD=4`, `HB_MOUSE=8`,
`HB_NETWORK=16`, `HB_JOY_MOUSE=32`. They describe successful reads at the latest host poll, not
proof of attached external hardware. Keyboard/mouse APIs can return valid empty
states. Motion records, keyboard and mouse bytes update per frame; flags,
controller selection and network metadata update at explicit worker boundaries. Check sample
numbers for freshness, especially during disconnection. A flag can lag the
last physical event until the next host poll.

Motion acceleration was approximately unit magnitude at rest; the native
interval was 5,000,000 ns. Angular-rate scale, axis conventions during movement
and matrix orientation have not been calibrated here. Treat the returned floats
as native units; do not assume radians/second or promise a world-space pose.
There is no extra smoothing, integration or quaternion conversion in this SDK.

## Extension layout

Offsets below are relative to absolute byte `0x7f0000` in binding 0. Unlisted
bytes are reserved and must not be used by apps.

| Byte offset | Type / bytes | Contents |
| --- | --- | --- |
| 0 | u32 | Magic `0x48425344` |
| 4 | u32 | Extension version 1 |
| 8 | u32 | Host poll sequence, wrapping |
| 12 | u32 | Read-success flags |
| 16 | u32 | Reserved error word |
| 20, 24 | u32 each | Primary pad ID and style bits |
| 28 | u32 | Number of valid motion records |
| 64 | 64 bytes | Primary controller snapshot from host poll |
| 128 | 2 × 96 bytes | Motion records; updated by native frame reads |
| 320 | 48 bytes | Keyboard record |
| 384 | 40 bytes | Mouse record |
| 448 | u32 | Network status Result |
| 452 | 16 bytes | Native network status output, uninterpreted |
| 468 | 4 bytes | Console IPv4 octets in network order |
| 480 | u32 | IR query Result |
| 484 | u32 | IR state: 0 available, 1 unsupported, 2 unconnected |
| 2048 | 1056 bytes | App-to-host request |
| 4096 | 1056 bytes | Host-to-app response |
| 16384 | 16384 bytes | Native Jcms optical ring snapshot |

A motion record contains `u64 deltaNanoseconds` at 0, `u64 samplingNumber` at
8, three acceleration floats at 16, three angular-velocity floats at 28,
three angle floats at 40, nine direction floats at 52 and attributes at 88.
The final word is padding. The host decoder preserves u64 values as decimal
strings rather than losing precision in JavaScript numbers.

Keyboard: u64 sampling number at 0, u64 modifiers at 8, 32-byte key bitmap at
16. Mouse: u64 sampling number at 0; signed x/y at 8/12, signed dx/dy at 16/20,
signed wheel x/y at 24/28, u32 buttons at 32 and attributes at 36. Consult native
records for modifier/attribute interpretation; these helpers do not translate
keys into text, layouts or IME events.

## Service helpers

`hbRequest(op,a,b,d)` posts a typed request only if the SDK is available and
there is no outstanding request. It returns whether it was posted.
Convenience helpers are `hbVibrate(side,milliseconds,amplitudePermille)`,
`hbScanNfc()`, and `hbSendUdp(endpointIndex,bytes)`.

`hbBusy()` compares request and response sequences. `hbResult()` is the latest
response status, `hbResponseBytes()` is the bounded response length, and
`hbResponseByte(index)` reads one byte (zero outside the response). These do not
clear the response. Maintain your own application state if multiple operations
need different response handlers.

For UDP, fill bytes with `hbRequestByte(index,value)` while not busy, then call
`hbSendUdp`. For example, send ASCII `ping` to manifest endpoint zero:

```glsl
if (hbAvailable() && !hbBusy() && (hbPressed() & HB_A) != 0u) {
    hbRequestByte(0u,112u); hbRequestByte(1u,105u);
    hbRequestByte(2u,110u); hbRequestByte(3u,103u);
    hbSendUdp(0u,4u);
}
```

Only the single invocation in the normal `local_size_x=1` app compute shader
should write the mailbox. If an advanced app uses multiple invocations, elect
one writer and provide its own shader synchronization. Fragment shaders must
define `HB_READONLY` so write helpers are not compiled into read-only access.

## Joy-Con 2 optical input

`hbJoyMouseDelta(player, side, previous)` returns summed signed optical deltas
and updates an `inout uint previous` sample sequence. Player is 0–7; side is
0/1, matching native Jcms handles. Keep a separate previous sequence per side.
The launcher stores these in its app-owned `c.rows[0..15]` and scales deltas by
1.5 into display pixels. Apps choose their own sensitivity and cursor bounds.

```glsl
vec2 movement = hbJoyMouseDelta(0u, 1u, c.rows[1]);
c.flow.xy = clamp(c.flow.xy + movement, vec2(0), vec2(1920,1080));
```

`hbJoyMouseAttributes(player,side)` exposes raw native attributes. Values 0, 1
and 3 were observed during detached-controller movement/lift testing; the exact
meaning of each bit is not promoted to a named SDK flag yet. The launcher uses
the observed tracking bit (mask 2) to show/hide its cursor and gate L/R clicks. Buttons remain in
the controller state. The launcher uses ZR (bit 9) for a pointer click.

Jcms is separate from generic `hbMouse()`. Its owned 16 KiB transfer buffer
contains 16 rings in player/side order, each 712 bytes: a 32-byte header and 17
40-byte slots. Header offsets 16/24 are tail/count; at most 16 entries are live.
A slot contains u64 guard, u64 interval, u64 sequence, s32 dx/dy and u32
attributes/padding. Observed stable guards equal twice the sequence. Helpers
reject inconsistent entries and avoid applying a sequence twice.

The native worker snapshots the ring before every GPU submission. Only recent
samples fit in the ring (roughly 80 ms at the observed 5 ms interval), so a long
explicit service pause may discard movement. Sequence comparisons use the low
32 bits with signed wrapping differences; do not reuse an old previous value
across a fresh console session. A disconnected/missing device returns no delta.
