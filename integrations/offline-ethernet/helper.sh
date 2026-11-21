#!/bin/bash
set -euo pipefail
umask 022
export PATH='/usr/bin:/bin:/usr/sbin:/sbin'

BASE="$(cd "$(dirname "$0")" && pwd -P)"
STATE_DIR='/Library/Application Support/mac2jb/offline-ethernet'
PARENT_DIR='/Library/Application Support/mac2jb'
STATE="$STATE_DIR/network-original.txt"
STATUS="$STATE_DIR/status.txt"
LOCK="$STATE_DIR/.run.lock"
LOG="$STATE_DIR/ethernet.log"
PC_IP='192.168.2.2'
SWITCH_IP='192.168.2.1'
MODE="${1:-}"
IFACE=''
SERVER_PID=''
OWN_LOCK=0
CAN_STATUS=0
PHASE=''

write_status() {
  (( CAN_STATUS )) || return 0
  local tmp="$STATUS.tmp.$$"
  printf '%s\n%s\n%s\n' "$1" "$2" "${MAC2JB_OFFLINE_LAUNCH_TOKEN:-}" > "$tmp"
  /bin/chmod 644 "$tmp"
  /bin/mv -f "$tmp" "$STATUS"
  PHASE="$1"
}

err() {
  printf 'ERROR: %s\n' "$*" >&2
  write_status failed "$*" || true
  exit 1
}

check_platform() {
  [[ "$(/usr/bin/uname -s)" == Darwin ]] || err 'This service requires macOS'
  [[ "$(/usr/bin/id -u)" == 0 ]] || err 'Administrator privileges are required'
}

check_responder() {
  [[ -x /usr/bin/perl ]] || err 'System Perl is unavailable'
  /usr/bin/perl -c "$BASE/Responder.pl" >/dev/null || err 'Responder syntax check failed'
}

prepare_state_dir() {
  [[ "${1:-}" == "$STATE_DIR" ]] || err 'Unexpected state directory'
  if [[ ! -e "$PARENT_DIR" ]]; then
    /bin/mkdir -m 755 "$PARENT_DIR" || err 'Could not create the mac2jb state directory'
  fi
  [[ -d "$PARENT_DIR" && ! -L "$PARENT_DIR" ]] || err 'Unsafe mac2jb state directory'
  [[ "$(/usr/bin/stat -f '%u' "$PARENT_DIR")" == 0 ]] || err 'The mac2jb state directory must be owned by root'
  if [[ ! -e "$STATE_DIR" ]]; then
    /bin/mkdir -m 755 "$STATE_DIR" || err 'Could not create the offline Ethernet state directory'
  fi
  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || err 'Unsafe offline Ethernet state directory'
  [[ "$(/usr/bin/stat -f '%u' "$STATE_DIR")" == 0 ]] || err 'The offline Ethernet state directory must be owned by root'
  /bin/chmod 755 "$STATE_DIR"
  CAN_STATUS=1
}

on_exit() {
  if [[ "$MODE" == start && "$OWN_LOCK" == 1 ]]; then
    if [[ -n "$SERVER_PID" ]]; then
      /bin/kill "$SERVER_PID" 2>/dev/null || true
      wait "$SERVER_PID" 2>/dev/null || true
    fi
    /bin/rm -f "$LOCK/pid"
    /bin/rmdir "$LOCK" 2>/dev/null || true
    if [[ "$PHASE" != failed ]]; then
      write_status stopped 'Responder stopped; restore the temporary Mac address' || true
    fi
  fi
}
trap on_exit EXIT
trap 'exit 0' INT TERM

acquire_lock() {
  if [[ -d "$LOCK" ]]; then
    local other=''
    if [[ -r "$LOCK/pid" ]]; then other="$(/bin/cat "$LOCK/pid")"; fi
    if owns_pid "$other"; then
      printf 'ERROR: Offline Ethernet is already running\n' >&2
      exit 1
    fi
    /bin/rm -f "$LOCK/pid"
    /bin/rmdir "$LOCK" 2>/dev/null || err 'Could not remove stale service lock'
  fi
  /bin/mkdir -m 755 "$LOCK" || err 'Could not acquire service lock'
  OWN_LOCK=1
  printf '%s\n' "$$" > "$LOCK/pid"
  /bin/chmod 644 "$LOCK/pid"
}

owns_pid() {
  local candidate="${1:-}" command=''
  [[ "$candidate" =~ ^[0-9]+$ ]] || return 1
  /bin/kill -0 "$candidate" 2>/dev/null || return 1
  command="$(/bin/ps -p "$candidate" -o command= 2>/dev/null)" || return 1
  [[ "$command" == *"$BASE/helper.sh start "* ]]
}

mac_of_interface() {
  /sbin/ifconfig "$IFACE" | /usr/bin/awk '/^[[:space:]]*ether / {print $2; exit}'
}

validate_interface() {
  [[ "$IFACE" =~ ^en[0-9]+$ ]] || err "Invalid Ethernet adapter: $IFACE"
  /sbin/ifconfig "$IFACE" >/dev/null 2>&1 || err "Ethernet adapter $IFACE is not present"
  /sbin/ifconfig "$IFACE" | /usr/bin/grep -q 'ether ' || err "$IFACE is not an Ethernet adapter"
  local bridge
  for bridge in $(/sbin/ifconfig -l | /usr/bin/tr ' ' '\n' | /usr/bin/grep '^bridge[0-9]' || true); do
    if /sbin/ifconfig "$bridge" | /usr/bin/grep -Eq "member: $IFACE([[:space:]]|$)"; then
      err "$IFACE is part of a network bridge"
    fi
  done
}

check_forwarding() {
  local v4 v6
  v4="$(/usr/sbin/sysctl -n net.inet.ip.forwarding 2>/dev/null)" || err 'Cannot inspect IPv4 forwarding'
  v6="$(/usr/sbin/sysctl -n net.inet6.ip6.forwarding 2>/dev/null)" || err 'Cannot inspect IPv6 forwarding'
  [[ "$v4" == 0 && "$v6" == 0 ]] || err 'IP forwarding is enabled; turn off Internet Sharing or the VPN'
}

check_default_route() {
  local default_if
  default_if="$(/sbin/route -n get default 2>/dev/null | /usr/bin/awk '/^[[:space:]]*interface: /{print $2;exit}')" || true
  [[ "$default_if" != "$IFACE" ]] || err "$IFACE is the current Internet connection; choose the Ethernet connection that runs directly to the Switch"
}

check_subnet_conflicts() {
  local conflict
  conflict="$(/sbin/ifconfig -a | /usr/bin/awk -v selected="$IFACE" '
    /^[A-Za-z0-9_.-]+: flags=/ {i=$1;sub(/:$/, "", i)}
    /^[[:space:]]+inet 192[.]168[.]2[.]/ && i!=selected {print i " " $2;exit}
  ')"
  [[ -z "$conflict" ]] || err "192.168.2.0/24 conflicts with $conflict"
  if /sbin/ifconfig "$IFACE" | /usr/bin/grep -Eq '^[[:space:]]*inet 192[.]168[.]2[.]1([[:space:]]|$)'; then
    err "$IFACE already uses the Switch address 192.168.2.1"
  fi
}

has_alias() {
  /sbin/ifconfig "$IFACE" | /usr/bin/grep -Eq '^[[:space:]]*inet 192[.]168[.]2[.]2([[:space:]]|$)'
}

verify_saved_adapter() {
  [[ -f "$STATE" ]] || return 0
  local saved_if saved_mac current_mac
  saved_if="$(/usr/bin/head -n 1 "$STATE")"
  saved_mac="$(/usr/bin/sed -n '2s/^MAC=//p' "$STATE")"
  current_mac="$(mac_of_interface)"
  [[ "$saved_if" == "$IFACE" && -n "$saved_mac" && "$saved_mac" == "$current_mac" ]] ||
    err 'The recorded adapter does not match; reconnect the original adapter'
}

wait_for_link() {
  local i
  for ((i=0; i<20; i++)); do
    if /sbin/ifconfig "$IFACE" | /usr/bin/grep -q 'status: active'; then return 0; fi
    /bin/sleep 1
  done
  err "No active link on $IFACE; check the direct cable and Switch"
}

start() {
  IFACE="${2:-}"
  check_platform
  prepare_state_dir "${3:-}"
  acquire_lock
  check_responder
  validate_interface
  write_status starting "Checking $IFACE and the direct Ethernet link"
  verify_saved_adapter
  check_forwarding
  check_default_route
  check_subnet_conflicts
  wait_for_link
  if [[ ! -f "$STATE" ]]; then
    has_alias && err '192.168.2.2 already exists without a mac2jb record; refusing to remove another service address'
    printf '%s\nMAC=%s\nOriginal interface config: %s\n' "$IFACE" "$(mac_of_interface)" "$(/bin/date)" > "$STATE"
    /sbin/ifconfig "$IFACE" >> "$STATE"
    /bin/chmod 644 "$STATE"
  fi
  if ! has_alias; then
    /sbin/ifconfig "$IFACE" inet "$PC_IP" netmask 255.255.255.0 alias ||
      err 'Could not add the temporary 192.168.2.2 address'
  fi
  has_alias || err 'The temporary Mac address disappeared'
  check_forwarding
  if [[ -f "$LOG" ]]; then /bin/rm -f "$LOG"; fi
  /usr/bin/touch "$LOG"
  /bin/chmod 644 "$LOG"
  /usr/bin/perl "$BASE/Responder.pl" --serve --log "$LOG" &
  SERVER_PID=$!
  /bin/sleep 1
  /bin/kill -0 "$SERVER_PID" 2>/dev/null || err 'DNS or HTTP port 53/80 is unavailable; stop DNSwitch or another listener'
  /usr/bin/perl "$BASE/Responder.pl" --probe || err 'The offline connection responder failed its local check'
  write_status ready "Ready on $IFACE; set the Switch wired address to $SWITCH_IP"
  while true; do
    /bin/sleep 2
    check_forwarding
    has_alias || err 'The temporary Mac address disappeared'
    /bin/kill -0 "$SERVER_PID" 2>/dev/null || err 'The DNS or HTTP responder stopped unexpectedly'
  done
}

stop() {
  check_platform
  prepare_state_dir "${2:-}"
  local other=''
  if [[ -r "$LOCK/pid" ]]; then other="$(/bin/cat "$LOCK/pid")"; fi
  if owns_pid "$other"; then
    /bin/kill -TERM "$other" || err 'Could not stop the responder'
    local i
    for ((i=0; i<10; i++)); do
      /bin/kill -0 "$other" 2>/dev/null || break
      /bin/sleep 1
    done
    /bin/kill -0 "$other" 2>/dev/null && err 'Responder did not stop'
  fi
  if [[ -d "$LOCK" ]]; then
    /bin/rm -f "$LOCK/pid"
    /bin/rmdir "$LOCK" 2>/dev/null || true
  fi
  write_status stopped 'Responder stopped; restore the temporary Mac address'
}

restore() {
  stop "${1:-}" "${2:-}"
  [[ -f "$STATE" ]] || { write_status restored 'No temporary Mac address was recorded'; return 0; }
  IFACE="$(/usr/bin/head -n 1 "$STATE")"
  validate_interface
  verify_saved_adapter
  if has_alias; then
    /sbin/ifconfig "$IFACE" inet "$PC_IP" -alias || err 'Could not remove the temporary Mac address'
  fi
  /bin/mv "$STATE" "$STATE_DIR/network-restored-$(/bin/date '+%Y%m%d-%H%M%S').txt"
  write_status restored 'Temporary Mac address removed; original settings were preserved'
}

prepare() {
  check_platform
  prepare_state_dir "${2:-}"
}

case "$MODE" in
  prepare) prepare "$@" ;;
  start) start "$@" ;;
  stop) stop "$@" ;;
  restore) restore "$@" ;;
  *) printf 'Usage: helper.sh start <enN> <state-dir> | stop|restore <state-dir>\n' >&2; exit 2 ;;
esac
