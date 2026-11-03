#!/usr/bin/env bash
# Hold RPC and FS until Ctrl-C.
set -uo pipefail
cd "$(dirname "$0")/.."
source scripts/toolchain.sh

checkout="."
host=""
dry=0
runnerMode="wsl"
pico="${NS2_PICO:-http://pico-smilebasic.local}"
picoHost=""
extra=()
while (($#)); do
  case "$1" in
    --pico) pico="${2:-}"; shift 2 ;;
    --pico-host) picoHost="${2:-}"; shift 2 ;;
    --windows-runner) runnerMode="windows"; shift ;;
    --dump-firmware) extra+=(--dump-firmware); shift ;;
    --dry) dry=1; shift ;;
    -h|--help) echo "Usage: scripts/ns2-hold.sh <computer-IP> [--windows-runner] [--pico URL|IP] [--pico-host IP] [--dump-firmware] [--dry]"; exit 0 ;;
    *) if [[ -z "$host" ]]; then host="$1"; else echo "Unbekanntes Argument: $1" >&2; exit 1; fi; shift ;;
  esac
done
if [[ -z "$host" ]]; then
  echo "Aufruf: scripts/ns2-hold.sh <computer-IP> [--pico URL|IP] [--dump-firmware]" >&2
  exit 1
fi
[[ "$pico" == http* ]] || pico="http://$pico"
pico="${pico%/}"
[[ -n "$picoHost" ]] || picoHost="$host"
[[ -f "$checkout/run.cjs" ]] || { echo "Kein Checkout unter $checkout." >&2; exit 1; }

# Stop a prior held runner explicitly before starting another one.

http() {
  "$NODE" -e '
    const [method, url, ms] = process.argv.slice(1);
    fetch(url, {method, signal: AbortSignal.timeout(Number(ms))})
      .then(async r => { const body = await r.text(); if (!r.ok) { console.error(r.status + " " + body); process.exit(1); } })
      .catch(e => { console.error(String(e.message || e)); process.exit(1); });
  ' "$1" "$2" "$3" 2>/dev/null
}

if [[ "$runnerMode" == windows ]]; then
  windowsNode=$(command -v node.exe) || {
    echo "Windows-Node (node.exe) fehlt im WSL-PATH." >&2
    exit 1
  }
  windowsScript=$(wslpath -w "$PWD/run.cjs") || exit 1
  runner=("$windowsNode" "$windowsScript" --rpc --pico)
else
  runner=("$NODE" "$checkout/run.cjs" --rpc --pico)
fi
for argument in "${extra[@]+"${extra[@]}"}" "$host"; do runner+=("$argument"); done

echo "Ziel: $host   Pico: $pico"
if ((dry)); then
  printf 'DRY:'
  printf ' %q' "${runner[@]}"
  printf '\n'
  exit 0
fi
echo "SmileBASIC frisch öffnen, dann läuft alles von selbst. Abbruch: Ctrl-C."
echo ""
before=$(ls -1dt "$checkout"/runs/switch2-*/ 2>/dev/null | head -n 1)
# Pass arguments directly; cmd.exe reparses quotes.
"${runner[@]}" &
pid=$!
sleep 2
if ! kill -0 "$pid" 2>/dev/null; then
  wait "$pid"
  status=$?
  echo "Runner vor dem Pico-Start beendet (Exit $status)." >&2
  ((status != 0)) || status=1
  exit "$status"
fi
http POST "$pico/launch?host=$picoHost&delay=6" 4000 ||
  http POST "$pico/launch?host=$picoHost&delay=6" 4000 ||
  echo "Pico nicht erreichbar - Launch im Pico-Web-UI starten."

dir=""
deadline=$((SECONDS + 1800))
while ((SECONDS < deadline)); do
  dir=$(ls -1dt "$checkout"/runs/switch2-*/ 2>/dev/null | head -n 1)
  if [[ -n "$dir" && "$dir" != "$before" && -f "$dir/result.json" ]] &&
     grep -q '"verified": true' "$dir/result.json" 2>/dev/null; then
    echo ""
    echo "RPC hängt und bleibt offen, solange dieser Prozess läuft."
    echo "  node rpc.cjs ${dir%/} status"
    echo "  node rpc.cjs ${dir%/} '{\"command\":\"query\",\"address\":4294967296}'"
    echo ""
    echo "Ctrl-C beendet den Lauf und räumt den FS-Endpunkt ab."
    break
  fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 2
done
wait "$pid"
status=$?
echo ""
[[ $status -eq 0 ]] && echo "Lauf beendet." || echo "Lauf ohne Erfolg beendet (Exit $status)."
exit $status
