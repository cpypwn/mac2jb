# Handoff: make the console adopt an ESP32 Pro Controller

You are picking up a live hardware session. The goal is narrow and testable: an
ESP32-S2 (Flipper WiFi Devboard) presenting a Nintendo Switch Pro Controller over
USB must be **adopted by the console**, so that A / D-pad / + on `/pro` navigate
the home menu. Everything below was measured on this hardware today.

> **Status 2026-10-28 12:09: done.** The console adopts the pad, it navigates the
> home menu, and it launched retail SmileBASIC 4 to `ver 4.4.9` / `OK`. See
> [What fixed it](#what-fixed-it) and [Operating it](#operating-it); the
> original blocker analysis is kept below for the record.

## Hardware and addresses

| piece | address / path | notes |
| --- | --- | --- |
| console | 192.168.50.91 | docked, must be in TV output; capture card sees its HDMI |
| Mac (this machine) | 192.168.50.235 | runs everything |
| ESP32-S2 devboard | 192.168.50.215 | HTTP 80 for control, OTA on **3232**; battery-powered via the Flipper, so it stays up even when the console sleeps |
| Fingerbot | http://127.0.0.1:8080 | `/press` `/on` `/off` `/status` `/tap` `/hold?seconds=N` (accepts 1–300 now) |
| capture | `ffmpeg -f avfoundation -pixel_format uyvy422 -framerate 30 -video_size 1920x1080 -i "0:none"` | a **8609-byte** PNG means no signal (console asleep/off); a real frame is ~630 KB. From Claude Code's shell this gets **zero frames** (see below): use `open -g -a Terminal tools/capture-daemon.command` and read `/tmp/ns2cap/latest.png` |

## Where the code is

```
~/ns2-savekit/tools/esp32_pro/     # THE WORK ITEM: Pro Controller persona
    esp32_pro.ino                  # descriptor + protocol + /pro /usb /reboot
    build_opt.h                    # -DUSB_VID=0x057E  -DUSB_PID=0x2009   (flags only!)
~/ns2-savekit/tools/esp32_hid/     # keyboard persona (proven; build with -DKEY_ONLY)
~/ns2-savekit/tools/esp32_gc/      # GameCube adapter experiment (dead end, see below)
```

Build and flash (the devboard is on the dock, so use OTA):

```sh
cd ~/ns2-savekit/tools/esp32_pro
arduino-cli compile --fqbn esp32:esp32:esp32s2 --export-binaries \
  --build-property "compiler.c.elf.extra_flags=-Wl,--wrap=tud_hid_set_report_cb -Wl,--wrap=tud_hid_get_report_cb" \
  esp32_pro.ino
python3.12 "$(find ~/Library/Arduino15/packages/esp32 -name espota.py | head -1)" \
  -i 192.168.50.215 -p 3232 -f build/esp32.esp32.esp32s2/esp32_pro.ino.bin --auth=
curl -s http://192.168.50.215/usb
```

Keyboard fallback (this is what is on the board right now; it types into SmileBASIC):

```sh
cd ~/ns2-savekit/tools/esp32_hid
rm -f build_opt.h    # Espressif VID, the proven typing device
arduino-cli compile --fqbn esp32:esp32:esp32s2 --export-binaries \
  --build-property "compiler.cpp.extra_flags=-DKEY_ONLY" esp32_hid.ino
# flash the .bin the same way
```

`build_opt.h` must contain **only** `-D` lines. A comment line in it is split into
bare words and the compile dies with `cannot specify '-o' with '-c' ... with
multiple files`. This cost an hour once.

The `--wrap` flags are **required** for the Pro build: without them the core drops
every host OUT report and the console never gets past enumeration.

## What is implemented

`esp32_pro.ino` is a port of espp's `switch_pro` (which follows dekuNukem/nxbt):

- **Identity**: `057E:2009`, "Nintendo Co., Ltd." / "Pro Controller" / serial
  "000000000001", `bcdDevice 0x0210`, `bcdUSB 0x0200`. The device, configuration
  and string descriptors are supplied by the sketch (the core's callbacks are
  weak): class 0, bus powered + remote wakeup, 500 mA, one HID interface with no
  string, EP 0x81 IN then EP 0x01 OUT, 64 B, `bInterval` 8.
- **Report descriptor**: the real pad's 203 bytes. espp's `hid-rp` emits the same
  items with 2-byte usage min/max (209 bytes); the sketch uses the 1-byte form.
- **Reports**: the console drives the init (`80:05 80:01 80:02 01:03 80:04 01:48
  01:02 01:08 01:10... 01:01 x3 01:03 01:04 01:10... 01:40 01:30`). `0x80` init
  commands get `0x81` replies; `0x01` subcommands get `0x21` (`0x01` Bluetooth
  pairing steps 1-3, `0x02` device info, `0x03` report mode, `0x10` SPI read of
  the factory/user calibration blobs, `0x30` player lights, `0x40` IMU, `0x48`
  vibration, NFC/IR stubs). `0x30` input streams at 125 Hz. Replies are queued in
  the TinyUSB callback and sent from `loop()`, ahead of input reports.
- **Input bits** (payload offset 2/3/4):
  [2] Y `0x01`, X `0x02`, B `0x04`, A `0x08`, R `0x40`, ZR `0x80`;
  [3] MINUS `0x01`, PLUS `0x02`, R3 `0x04`, L3 `0x08`, HOME `0x10`, CAPTURE `0x20`;
  [4] DOWN `0x01`, UP `0x02`, RIGHT `0x04`, LEFT `0x08`, L `0x40`, ZL `0x80`.
- **Endpoints**: `/pro?a=1&down=1&ms=150` (also `mask=`, `raw=1`), `/usb`
  (`mounted`, `hidReady`, `handshake`, `rawSet` = host writes seen, `log` = last
  24 host commands as `id:cmd` excluding rumble, `rumble` count, `pairStep`,
  `qDropped`, `reportsSent`, ...; `?announce=1` sends an unsolicited `0x81`),
  `/reboot`, `/status` (`fw:"pro-2"`).

## What fixed it

In the order they mattered:

1. **The Arduino core silently dropped every host write.** `tud_hid_set_report_cb`
   in `USBHID.cpp` only dispatches report ids it registered from the descriptor,
   and the console's `0x80` / `0x01` writes never reached the sketch. The sketch
   now takes them first via `-Wl,--wrap=tud_hid_set_report_cb`. This is why
   `outReports` was always 0 in the table below; the console *was* talking.
2. **Enumeration now matches a real pad** (see Identity). Before, the core sent
   class 0xEF/IAD, self-powered, `bInterval` 1, OUT before IN, and a "TinyUSB HID"
   interface string; after the change `hidReady` went true and the host polled IN.
3. **Pro Controller Wired Communication** was turned on in System Settings ›
   Controllers. Changed together with (1), so it is unknown whether it was needed.
4. **Replies sent from the callback were lost** (the console re-asked `01:02` six
   times a second). Queueing them for `loop()` fixed it.
5. **Pairing subcommand `0x01`** needed real replies (steps 1-3, ACK `0x81`); after
   that the console set player lights (`01:30`), i.e. adopted the pad.
6. **Input byte layout was wrong** (D-pad in byte 3). Fixed per the table above.

## Operating it

- After a flash or reboot the console re-runs the init within ~5 s (watch `log`
  on `/usb` for `1:30`). Already-paired pads skip pairing steps.
- **In a game the pad must be Player 1.** As Player 2 it drives the home menu,
  but SmileBASIC ignores it completely, HOME included. Fix: open Controllers ›
  Change Grip/Order (from the home menu), `curl '…/pro?l=1&r=1&ms=500'`, then
  `/pro?a=1`. The Joy-Con drops out; the USB pad shows alone with LED 1.
- Use the retail **SmileBASIC 4** tile, not the "SmileBASIC 4 Demo Version" tile.
  On launch it shows a language/tag dialog and a tag-retrieval error; A twice,
  then "Make a Program" (A) reaches `OK`.
- **Seeing the screen:** Claude Code's shell runs as `com.anthropic.claude-code`,
  which has no camera permission and cannot prompt for one, so avfoundation opens
  the card and delivers no frames (ffmpeg hangs). `tools/capture-daemon.command`
  runs ffmpeg under Terminal (which has the grant) and keeps
  `/tmp/ns2cap/latest.png` fresh at 2 fps; stop it with
  `pkill -f ns2cap/latest.png`.

## The exact blocker (historical, before the fixes)

| probe | keyboard (control) | Pro persona |
| --- | --- | --- |
| enumerates | `mounted:true` | `mounted:true` |
| host fetches report descriptor | – | **`descRequests:1`** |
| interface configured | **`hidReady:true`** | `hidReady:false` |
| host init traffic | – | `outReports:0` |
| shown in home menu | – | no (only the built-in Joy-Con) |

So the console's USB host is healthy, it reads our 209-byte descriptor, then
declines the device — no `0x80` handshake ever arrives. This is *not* a
descriptor-parse failure on the device side (the core would return NULL and the
count would stay 0). It is the host declining the configuration after the read.

`hidReady:true` was observed exactly once (the very first Pro flash at 10:39) and
never again; treat that as unexplained, not as a baseline.

## Ranked next steps (historical; superseded by What fixed it)

1. **Get a real dump and diff it.** Plug a real Pro Controller into a PC:
   `lsusb -v -d 057e:2009` (Linux) or `usbhid-dump -e descriptor` for the report
   descriptor. Compare, in this order:
   - report descriptor: ours is 209 bytes; the widely-quoted real figure is 203.
     If the real is 203, our espp-derived bytes are wrong and that alone explains
     the drop.
   - configuration descriptor: `bMaxPower`, `bInterval`, endpoint order
     (IN 0x81 / OUT 0x01), `iInterface` (a real pad has **no** interface string;
     the Arduino core writes "TinyUSB HID").
2. **Try the espp example as a known-good control** (needs ESP-IDF and an
   ESP32-S3/S2): if that exact implementation is adopted by this console, the
   difference to diff is in our Arduino port; if it is not, the console's driver
   wants something neither implementation provides.
3. **Vary one config-descriptor field at a time.** The core builds the HID
   descriptor in `tud_hid_load_descriptor` (`libraries/USB/src/USBHID.cpp`), using
   `TUD_HID_INOUT_DESCRIPTOR(itf, str_index, protocol, desc_len, ep_out, ep_in,
   CFG_TUD_ENDPOINT_SIZE, 1)`. To change `iInterface` or the interval you must
   patch that core file (or vendor a copy) — the sketch cannot.
4. If the device is finally adopted, the handshake should show `outReports` climbing
   and `handshake:true`, then `/pro?a=1` should move the cursor.

## Constraints you must respect

- **The console sleeps after ~55 s** with nothing attached, but **stays awake
  while our USB device is attached** — so keep a device plugged in and you keep a
  work window. Keyboard traffic does *not* reset the timer.
- **Never leave the board unflashable.** OTA only; the board's USB is normally in
  the dock. A failed OTA leaves the old app running; a bad sketch that never
  reaches WiFi is a physical reflash (`tools/esp32-flash-usb.sh`).
- **Fingerbot**: the arm travel `dp102` must be **95** — at 85 the arm misses the
  button and every press is silently a no-op. `dp103` (sustain) is clamped by the
  device to ~8–10 s, so a real force-off is `/hold?seconds=16` then a 1 s press to
  boot. `pulse()` leaves `dp1=true`; `/off` retracts. The BLE connection is
  exclusive: stop the HTTP server before using a raw client, or the scanner finds
  nothing.
- **Do not confuse "board offline" with a crash.** It is dock-powered *or*
  battery-powered depending on the cable; check `/status` before concluding
  anything, and remember the console sleeping cuts dock USB.

## Separate workstream (do not chase it here)

Getting an RPC session (`node ~/ns2jb-rpc/run.cjs --rpc 192.168.50.235`, then
`LOAD "TXT:NS2"` / `RUN` / `REMOVE NSR,&H60000000,&H3FFFFFFF` /
`V=START(...9 args)`) currently fails at **stage 2/4** with three different errors
(see `docs/RESULTS.md`, 2026-10-28). That is a separate problem from USB input;
fixing the controller will not fix it, and vice versa.

## Definition of done (all three met 2026-10-28)

1. `curl -s http://192.168.50.215/usb` shows `hidReady:true`, `descRequests:1`,
   `outReports` climbing, `handshake:true`.
2. `curl -s 'http://192.168.50.215/pro?left=1&ms=200'` moves the home-menu cursor
   (verify on a capture, comparing a 1200×1000 crop of the left side so the clock
   tick cannot fool you).
3. A followed by the correct number of D-pad presses launches SMILEBASIC 4 and
   the console shows `SMILEBASIC for Nintendo Switch ver 4.4.9` / `OK`.

When it works: OTA the **keyboard** build back on (typing into SmileBASIC is
proven), then run the RPC bootstrap. Do not leave the console wedged at
`RPC RUNNING`.
