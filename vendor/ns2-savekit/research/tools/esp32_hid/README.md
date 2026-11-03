# ESP32-S2 HID keyboard and controller for the console

The Flipper's WiFi Devboard is an ESP32-S2 with native USB and WiFi, so it can be a
USB keyboard for the console and an HTTP endpoint for the Mac at the same time. No
kernel extension, no SIP change, no KDK - macOS is not involved at all.

## flash

```sh
arduino-cli core install esp32:esp32
arduino-cli compile --fqbn esp32:esp32:esp32s2 esp32_hid.ino
arduino-cli upload  --fqbn esp32:esp32:esp32s2 -p /dev/cu.usbmodem* esp32_hid.ino
```

Set `SSID`/`PASS` in the sketch first. The serial monitor prints the IP.

## wire

1. Flash with the devboard's own USB-C.
2. Move that cable to the **Switch dock** - the console now sees a USB keyboard.
3. Power the devboard from the Flipper header (or its own USB, if you have a second port).

## use

```sh
node tools/hid-type.cjs http://<devboard-ip> 'PRINT 1'
node tools/hid-type.cjs http://<devboard-ip> --stdin < bootstrap.txt
curl -s 'http://<devboard-ip>/status'
```

SmileBASIC inverts letter case on USB keyboards; the sketch applies that rule
(lowercase sends shift), which is why text goes through `/type` rather than raw
HID codes.

## controller persona (in progress)

The same device can also present a controller, which is what the home menu needs.
Stock console firmware only drives USB controllers it ships a driver for, so the
sketch carries the report descriptor of the **HORI Pokken Tournament Pro Pad**
(`0F0D:0092`), which the console treats as a Pro Controller. The pad's report is
a plain 8-byte gamepad report, copied byte-for-byte in layout:

```
byte 0   buttons 1-8     byte 2  hat, low nibble (0 up .. 7 up-left, 0xF centred)
byte 1   buttons 9-13    byte 3-6 X, Y, Z, Rz (0x80 centre)
```

```sh
# pad + keyboard in one HID interface (the core merges the descriptors)
cp build_opt.h.pad build_opt.h
arduino-cli compile --fqbn esp32:esp32:esp32s2 --export-binaries esp32_hid.ino

# pad only
arduino-cli compile ... --build-property "compiler.cpp.extra_flags=-DPAD_ONLY"

# keyboard only, Espressif VID - the proven typing device; this is the default
rm build_opt.h
arduino-cli compile ... --build-property "compiler.cpp.extra_flags=-DKEY_ONLY"
```

`build_opt.h` must contain **flags only** (`-DUSB_VID=...`): a comment line is
split into bare words and the compile fails with `cannot specify '-o' with '-c'`.

Endpoints: `/type`, `/key`, `/status`, `/usb` (link + driver diagnostics),
`/parse` (does `esp_hid_parse_report_map` accept our descriptors), `/pad`
(`a b x y l r zl zr minus plus home capture up down left right`, `mask=<hex>`,
`raw=1`, `ms=`).

### what is and is not proven

- Keyboard: proven on hardware, `/usb` shows `mounted:true, hidReady:true`.
- VID/PID `057E:0337` on the keyboard-only build: also `mounted/hidReady` true,
  so the console does not reject that identity by itself.
- Keyboard + GameCube-adapter descriptor merged: the console configured the
  device but never polled the HID interface (`hidReady:false`).
- Pokken persona: the descriptor parses (`/parse`) but has **never been tested
  against an awake console** - see `docs/RESULTS.md`, 2026-10-28.
