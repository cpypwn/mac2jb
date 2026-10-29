#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
source scripts/toolchain.sh

case "${1:-}" in
  -h|--help)
    cat <<'TXT'
Usage: ./start.sh [computer-IP]

  ./start.sh                detect this computer's LAN address and start
  ./start.sh --list         list detected Wi-Fi/Ethernet addresses and exit
  ./start.sh 192.0.2.10     use a specific address (example only)

With no address, the host uses the only LAN address it finds. If the computer
has more than one, it lists them with interface names and asks which one the
Switch 2 can reach. Use the address on the console's network; do not use
127.0.0.1, a VPN-only address, or the console's own address.
TXT
    exit 0;;
  --list)
    exec "$NODE" smilebasic/connection.cjs --list;;
esac

"$NODE" scripts/doctor.cjs
exec "$NODE" homebrew-launcher/start-launcher.cjs "$@"
