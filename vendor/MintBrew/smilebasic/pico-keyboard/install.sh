#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
drive="${1:-}"
host="${2:-}"
if [[ -z "$drive" || ! -d "$drive" || -z "$host" ]]; then
  echo "Usage: $0 /path/to/CIRCUITPY computer-IP" >&2
  exit 1
fi
python3 - "$host" <<'PYIP'
import ipaddress,sys
try: ipaddress.IPv4Address(sys.argv[1])
except ValueError: raise SystemExit('Use the computer LAN IPv4 address, for example 192.0.2.10.')
PYIP
wifi_name="${NS2_WIFI_SSID:-}"
wifi_password="${NS2_WIFI_PASSWORD:-}"
if [[ -z "$wifi_name" ]]; then read -r -p 'Wi-Fi network name: ' wifi_name; fi
if [[ -z "$wifi_password" ]]; then
  read -r -s -p 'Wi-Fi password: ' wifi_password
  echo
fi
if [[ -z "$wifi_name" || -z "$wifi_password" ]]; then
  echo 'Wi-Fi name and password are required.' >&2
  exit 1
fi
key_file="$repo_dir/pico-keyboard/secret"
if [[ ! -f "$key_file" ]]; then
  umask 077
  head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$key_file"
fi
key="$(<"$key_file")"
if [[ ! -d "$drive/lib/adafruit_hid" ]]; then
  mkdir -p "$drive/lib"
  cp -r "$repo_dir/pico-keyboard/lib/adafruit_hid" "$drive/lib/"
fi
python3 - "$drive/settings.toml" "$wifi_name" "$wifi_password" "$host" "$key" <<'PY'
import json,sys
file,ssid,password,host,key=sys.argv[1:]
with open(file,'w') as out:
    for name,value in [('CIRCUITPY_WIFI_SSID',ssid),('CIRCUITPY_WIFI_PASSWORD',password),
                       ('NS2_HOST',host),('NS2_PICO_KEY',key)]:
        out.write(name+' = '+json.dumps(value)+'\n')
PY
cp "$repo_dir/bootstrap.bas" "$drive/program.bas"
for name in boot.py code.py; do
  cp "$repo_dir/pico-keyboard/$name" "$drive/$name"
done
sync
echo "Pico files installed. Unplug the board."
echo "Legacy note: this fork does not start the Pico host bridge or listen on port 39381."
echo "Use README.md and enter the bootstrap launch commands manually."
