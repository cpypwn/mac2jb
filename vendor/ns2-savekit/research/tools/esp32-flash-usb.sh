#!/bin/sh
# Flash the devboard over USB, for when OTA is not available.
#
#   1. unplug the devboard's USB-C from the Switch dock
#   2. plug it into the Mac
#   3. ./tools/esp32-flash-usb.sh [key|pad]
#
# "key" (default) is the proven keyboard-only device, Espressif VID - this is the
# firmware to leave the board on. "pad" is the controller persona, which has not
# been accepted by the console yet and is what starves the web server if it is
# built without the fixed send timeout.
set -eu
cd "$(dirname "$0")/esp32_hid"

mode="${1:-key}"
case "$mode" in
  key)
    rm -f build_opt.h
    extra=-DKEY_ONLY
    ;;
  pad)
    cp build_opt.h.pad build_opt.h
    extra=-DPAD_ONLY
    ;;
  *)
    echo "usage: $0 [key|pad]" >&2
    exit 2
    ;;
esac

port=$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)
if [ -z "$port" ]; then
  echo "no /dev/cu.usbmodem* device - is the devboard plugged into the Mac?" >&2
  exit 1
fi

echo "flashing $mode to $port"
arduino-cli compile --fqbn esp32:esp32:esp32s2 --export-binaries \
  --build-property "compiler.cpp.extra_flags=$extra" esp32_hid.ino
arduino-cli upload --fqbn esp32:esp32:esp32s2 -p "$port" esp32_hid.ino
echo "done - move the cable back to the Switch dock and check http://192.168.50.215/status"
