# Capability matrix

This matrix describes the qualified SmileBASIC 4.4.9 / Switch 2 23.0.1 build.
A symbol in its linked SDK is evidence of code, not permission, initialization,
usable hardware or a complete application feature. The audit enumerates both
SmileBASIC imports and SDK definitions; it does not call arbitrary discoveries.

## Implemented or directly inspected surfaces

| Surface | SDK exposure | Evidence and limits |
| --- | --- | --- |
| GPU graphics | GLSL vertex/fragment pipelines, storage buffers, full-screen rendering | Launcher and Hello World run on console; desktop render checks pass |
| GPU compute | Per-frame compute and optional multi-pass app sequences | Existing runtime and compute fixtures; see root package ABI |
| Buttons / sticks | Primary-pad helpers; five standard controller styles | Live handheld state; other styles have qualified functions but need physical controller testing |
| Touch | Up to 16 records, positions/IDs/attributes | Existing native frame read and launcher interaction tests |
| Accelerometer | Up to two native motion records | Live changing sample numbers, approximately unit gravity at rest |
| Gyroscope / orientation | Raw angular velocity, angle, direction matrix | Live records; at-rest angular velocity zero; movement scale/orientation not calibrated |
| Keyboard | 256-bit key bitmap and native modifiers | Native read succeeds; external key events not physically tested |
| Mouse | Position, relative deltas, wheel, buttons, attributes | Native read succeeds; external movement/clicks not physically tested |
| Joy-Con 2 optical mouse | Direct Jcms service, per-frame ring snapshot, signed delta helpers | Live movement on both axes and integrated cursor verified; separate from generic mouse |
| Controller colors / LED | HID probe records colors/LED function qualification | Live color reads; no application LED-setting API |
| Vibration | Independent low/high amplitude/frequency envelopes, native timing, stop | Physical response confirmed; in-stream readback shows nonzero amplitudes and requested frequencies; newer PCM/HD Rumble 2 encoding not implemented |
| Network status / IPv4 | Telemetry and host API | Live console IPv4 query succeeds |
| UDP | Console-side exchange and shader mailbox | 32-byte random-nonce echo matched on console and PC; reusable adapter retested |
| NFC | Enumerate readers, start/stop detection, read-only tag info | One handheld reader enumerated; detection accepted; no tag read |
| Amiibo / NFP | Discovery only | `nfp:user` opens; no mount, reads of amiibo data or writes implemented |
| IR camera | Handle/status query | Handheld handle returned status 1 (unsupported); no image capture verified |
| Audio output | Per-app PCM effect path | Existing console playback and audio owners; see root README |
| Audio input | Device-name enumeration | `audin:u` opens; `ListAudioIns` returned `BuiltInHeadset`; recording untested |
| TCP / FTP | Console listener, passive transfers, background service | TCP echo and FTP read/write round trips passed; one client; see [FTP](ftp.md) |
| DNS / TLS | Inventory only | TLS symbols and `ssl` service present; no DNS/handshake adapter or test |
| Local wireless / Bluetooth | Inventory only | `ldn`, `bluetooth`, `btm` exports; no session/pairing APIs exposed |
| HID accessory bus | Discovery only | `hidbus` open returned raw Result `0x1015`; do not infer Ring-Con/accessory support |
| Storage | Title-owned files through FTP; app assets on host | `save:/` and `tmp:/` read/write/commit verified; `rom:/` read-only; SD permission denied |
| Time / threads / memory | Internal qualified native worker support | Existing timer, pthread and owned-buffer machinery; not a public CPU app runtime |
| System applets, accounts, web, album | Inventory only | Linked functions/imports do not establish usable app APIs |
| JIT / runtime modules | Inventory only | Export presence does not establish executable allocation or native app loading |

Live checks established the native input calls, optical ring, integrated cursor,
NFC mailbox and UDP exchange. The continuous worker passed a live repeat/stop
test; the continuous graphics integration ran in a fresh session and the recurring
cursor stall was confirmed resolved on-console.
Physical peripheral limitations are listed above rather than inferred from
successful initialization.

## What the full inventory covers

`node sdk/tools/audit-loaded.cjs SESSION` inventories every loaded executable
mapping, including compatibility libraries. `node sdk/tools/audit.cjs SESSION` reads the main and SDK MOD0 dynamic symbol
tables, classifies every function symbol, and writes a private `sdk-audit.json`.
The namespace parser reads the C++ mangling's length prefix, so `irsensor` and
similarly named groups are not accidentally omitted by substring matching.
The report includes imported versus defined symbols and module-relative offsets
for follow-up inspection. It does not retain a complete module binary in Git.

[The namespace inventory](inventory.md) lists the definition/import counts for
all groups observed. Counts include internal helpers, overloads and wrappers;
they are **not counts of supported features**. Core user-facing surfaces include:

- HID: standard controllers, touch, keyboard, mouse, six-axis sensors, vibration,
  controller configuration and additional controller families.
- IR: image transfer, moment and clustering processors. SmileBASIC itself imports
  IR initialization/status and several processors, but the attached controller
  reports unsupported hardware.
- Audio: output, renderer, mixes, voices, effects and capture nodes. Renderer
  capture functions imported by SmileBASIC are not proof of microphone recording.
- Networking: sockets, network-interface requests, TLS, local wireless and
  Bluetooth. Existing SmileBASIC bridge traffic is separate from the tested UDP
  application socket.
- NFC/NFP: discovery/detection/tag and amiibo interfaces. Neither is imported by
  SmileBASIC's main module in this build, yet the native NFC read-only discovery
  path worked through the SDK.
- System libraries: images/codecs, crypto, fonts, clocks, threads, applets,
  accounts, settings, storage, display, software keyboard and browser services.
  Each still needs its own permission/lifecycle and output validation before
  becoming an app API.

## Reproduce and extend the evidence

Start with the scripts in `sdk/tools`, then follow [native investigation](native.md).
Promote a feature from inventory to supported only after verifying signatures,
argument ownership, failure behavior, lifecycle cleanup and meaningful outputs
on the supported console. Keep missing hardware and failed result codes visible.
Do not label an entire API supported because its initialization returned zero.

Primary interface references used to interpret layouts:

- [libnx HID types and APIs](https://github.com/switchbrew/libnx/blob/master/nx/include/switch/services/hid.h)
- [libnx NFC/NFP types](https://github.com/switchbrew/libnx/blob/master/nx/include/switch/services/nfc.h)
- [libnx IR states and processors](https://github.com/switchbrew/libnx/blob/master/nx/include/switch/services/irs.h)
- [libnx network interface types](https://github.com/switchbrew/libnx/blob/master/nx/include/switch/services/nifm.h)
- [Capstone Python API](https://www.capstone-engine.org/lang_python.html)

These are cross-checks, not a replacement for inspecting this title's native
ABI. libnx service IPC wrappers and SmileBASIC's linked C++ wrappers can have
different signatures even when they ultimately access the same service.
