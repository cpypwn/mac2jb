# Host APIs and service protocol

The Node modules use the existing session `shared/rpc.cjs`. They are host-side
adapters calling qualified console functions; networking below uses the
console's sockets, not Node's sockets. Node sockets are only used by the echo
test's PC server. Require Node 22+ and a ready, version-qualified bridge.

## Lifecycle

`runtime.create({rpc,mapped,directory})` creates a serialized SDK context for an
8 MiB launcher storage buffer. `await runtime.atBoundary(app)` polls hardware,
checks the current manifest, and handles at most one request. Pass `null` for
the launcher or the catalog's loaded app object for an app. Changing the app
fingerprint resets both mailboxes. `await runtime.close()` stops motion sensors
started by the context. The launcher calls these only after its native worker
has joined; it refreshes ownership after a package transition.

`hardware.create(rpc)` returns:

- `poll()`: a 1024-byte telemetry snapshot, including primary pad, motion,
  keyboard, mouse, network address and IR status.
- `controllers`: the latest discovered IDs/styles. Only the selected controller
  has state and motion sampled by this API.
- Button helpers combine connected handheld and player-one controller styles, so
  one detached Joy-Con can click while the other remains attached. These extra
  states occupy snapshot bytes 640–959 (five 64-byte slots) under flag 64;
  each frame samples them on the console without host polling pauses. Stick and
  motion helpers still use the selected primary controller.
- `frameCalls(mapped)`: qualified `{function,args}` descriptors for primary pad,
  motion, keyboard and mouse reads, plus a Jcms transfer-buffer snapshot. The launcher includes these before graphics
  submission in each native frame. Call only in a qualified worker and do not
  concurrently call `poll()`, `pulse()` or `close()`.
- `pulse({side=0,amplitude=.15,milliseconds=120})`: bounded pulse, amplitude
  0–1, side 0/1/2 (both), duration 1–500 ms. Returns native result, readback result and
  a 16-byte native vibration readback. Always sends zero amplitude in `finally`.
  It honors the system vibration-permitted flag and does not change permission.
- `pattern({side,steps})`: 1–32 steps with independent low/high amplitudes and
  frequencies, each 1–500 ms and at most 2000 ms total. Native sends repeat every
  5 ms; the host changes envelope steps. Frequencies are bounded to 40–1250 Hz.
- `close()`: stop owned motion acquisition and finalize the owned Jcms session. Close before discarding a context.

Create only one hardware owner per console session. Native memory is retained
until SmileBASIC exits because this bridge does not yet have a qualified free
path. The runtime creates NFC and networking adapters lazily and reuses them.
The six-argument worker likewise owns session-lifetime allocation. Starting new
contexts repeatedly is a debugging operation, not an app's frame loop.

## Manifest declaration

An app may omit `sdk` and still use input, drawing, motion and telemetry. To
request services, add:

```json
"sdk": {
  "version": 1,
  "capabilities": ["vibration", "nfc", "udp"],
  "endpoints": [{"address": "192.0.2.10", "port": 9000}]
}
```

Supported capabilities are exactly `vibration`, `nfc` and `udp`. Endpoint
addresses must be IPv4 literals with ports 1–65535; at most eight endpoints are
allowed. DNS names are not accepted. `validateManifest()` is called by the
catalog before a package is admitted. The host rejects undeclared requests.
This is an API contract, **not a security sandbox** for untrusted GPU code.

## Wire format

Request at extension offset 2048:

| Relative offset | u32 field |
| --- | --- |
| 0 | Nonzero sequence, incremented for each request |
| 4 | Operation: 1 vibration, 2 NFC, 3 UDP, 4 haptic envelope |
| 8 | Argument A |
| 12 | Argument B |
| 16 | Argument C |
| 20–31 | Reserved |
| 32–1055 | Payload, at most 1024 bytes |

Response at extension offset 4096:

| Relative offset | u32 field |
| --- | --- |
| 0 | Acknowledged request sequence |
| 4 | Status |
| 8 | Payload byte length, 0–1024 |
| 12–31 | Reserved |
| 32–1055 | Response payload |

Status 0 is success, 1 unsupported or undeclared operation, 2 invalid UDP
endpoint/length, 3 native/adapter error, 4 timeout. On caught errors the payload
is a bounded UTF-8 error message. Native Result values are preserved in those
messages where available. Invalid vibration parameters currently return adapter
error 3. A request is consumed once even on failure; use a new sequence to retry.

The native graphics worker repeats continuously. The host monitors request
sequences without stopping it. A pending operation causes a clean stop at the
next 60-frame boundary; the host joins before reading/writing the mailbox or
changing device state, then restarts rendering. No simultaneous host/GPU
mailbox writes are assumed. Ordinary input does not require a host round trip.

## Vibration (operation 1)

Arguments A/B/C are side, milliseconds and amplitude in thousandths. Frequencies
are fixed at 160 Hz and 320 Hz. The response contains four float32 values:
low amplitude, low frequency, high amplitude, high frequency. A successful send
with zero readback is possible and was observed. Native errors and unavailable
handles are reported. Physical motor response has been confirmed for the tested
Joy-Con 2 configuration.

## Haptic envelopes (operation 4)

Capability: `vibration`. Argument A is side 0/1/2 (both), B is step count 1–32.
Each payload step occupies 20 bytes: u32 milliseconds, then float32 low amplitude,
low frequency, high amplitude, high frequency. Amplitudes are 0–1, frequencies
40–1250 Hz, each step 1–500 ms and the complete envelope at most 2000 ms.

```glsl
if (hbAvailable() && !hbBusy() && (hbPressed() & HB_X) != 0u) {
    hbHapticStep(0u, 200u, vec4(.4, 80, .2, 160));
    hbHapticStep(1u, 300u, vec4(.6, 160, .4, 320));
    hbPlayHaptics(2u, 2u);
}
```

The entire envelope is compiled into a finite native job. It sends values every
5 ms using the console timer, sends final zero-amplitude values, and exits without
needing the host to advance or stop it. The host joins the job and repeats the
zero-amplitude stop during cleanup. This avoids using Wi-Fi
round trips as the vibration clock. The returned 16 bytes are readback captured
inside the stream; a later read may already show zero. Readback is not guaranteed
to equal the requested amplitude: native frequency/amplitude processing applies.
The API implements amplitude/frequency HD vibration, not arbitrary PCM samples
or an undocumented HD Rumble 2 packet format.

## NFC (operation 2)

The launcher/app request performs a 500 ms read-only scan per enumerated reader.
It opens its own NFC lifecycle only if the library was previously uninitialized;
if another client owns NFC it fails without finalizing that client. It lists at
most nine devices, starts detection, polls tag information, stops detection in
`finally`, and finalizes its own library. With several devices, total time can
be up to nine times the per-device window plus RPC overhead. Rendering pauses
while this host operation runs.

Successful response payload:

| Offset | Meaning |
| --- | --- |
| 0 | Reader count (u32) |
| 4 | 1 if a tag was read, otherwise 0 (u32) |
| 8 | First reader's last tag Result, or `0xffffffff` if absent |
| 12 | First reader's start-detection Result, or `0xffffffff` if absent |
| 16 | Optional 88-byte native tag-info structure |

Native tag info has a 10-byte UID at 0, UID length at 10, protocol u32 at 32 and
tag type u32 at 36; the remainder is reserved. The structure was checked against
the native interface layout, but no real tag has yet been read through this SDK.
Do not infer a tag type from a failed read. UIDs are identifiers, not secrets or
authentication tokens. The API never writes tags or mounts/modifies amiibo data.

Direct Node use:

```js
const nfc = await require('./sdk/host/nfc.cjs').create(rpc);
const readers = await nfc.scan({milliseconds: 500});
// Each row has start/tagResult/stop and, only after success, tag: Buffer.
```

Direct scan windows are 50–3000 ms per reader. A native result-returning function
can fail even after service discovery succeeds. Some native public wrappers
abort instead of returning failures; the supported device and initialization
path is qualified for this version, not universally safe on arbitrary firmware.

## UDP (operation 3)

Argument A selects a declared endpoint, B is payload length 1–1024; C is unused.
The response payload is the first received datagram, at most 1024 bytes. The
runtime uses a 1000 ms receive deadline. No peer authentication, retransmission,
ordering, fragmentation/reassembly, encryption or DNS is added. The socket is
unconnected, so a received datagram is not authenticated as coming from the
selected destination. Use a nonce and validate responses at the application
protocol layer; do not transmit credentials in plain UDP.

Direct Node API:

```js
const network = await require('./sdk/host/network.cjs').create(rpc, directory);
const response = await network.exchange(
  {address: '192.0.2.10', port: 9000},
  Buffer.from('ping'),
  {timeout: 1000}
);
```

The adapter opens a console IPv4 UDP socket, uses the qualified six-argument
`sendto`, polls `recv` with `MSG_DONTWAIT=0x80`, then closes the socket in
`finally`. Direct timeouts are 1–5000 ms. One exchange can be in flight per
adapter. Error 35/11 is treated as would-block; other errors stop the exchange.
The timeout bounds receive polling, not the bridge's own transport timeout.
Datagrams larger than 1024 bytes are truncated by the native receive buffer.

Use `probe-network.cjs` to run a random-nonce echo server on the PC and verify
both directions. Native TCP, DNS and TLS symbols exist but have no SDK adapters
or completed handshake tests in this release. This API does not silently proxy
traffic through the PC.

## Other services

`await require('./sdk/host/services.cjs').inspect(rpc)` opens and closes a fixed
list of read-only discovery handles and lists audio-input names if `audin:u`
opens. It does not start recording. See the capability matrix for the precise
findings and the difference between service access and implemented operations.

Graphics, sound effects and background audio continue to use the launcher's
existing renderer and dedicated audio owners. Use `hbSound` with manifest
`audio.effects`, described in the root README. Do not directly mutate their
native queues from an SDK service callback.
