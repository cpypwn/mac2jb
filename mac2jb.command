#!/bin/bash
set -euo pipefail
# Protect pairing values and logs created by this launcher.
umask 077
cd "$(dirname "$0")"

printf '\033[2J\033[H'
cat <<'ART'
                                                            
                                                            
                                            ██              
                               ░▓████▒      ██     ██       
                               ███████▒     ██     ██       
                               █▒░  ▓██            ██       
 ██▓█▒██▒   ▒████▓     ▓████▒        ██   ████     ██░███▒  
 ████████   ██████▓   ███████       ▒█▓   ████     ███████▒ 
 ██░██░██   █▒  ▒██  ▓██▒  ▒█       ██      ██     ███  ███ 
 ██ ██ ██    ▒█████  ██░          ░██▒      ██     ██░  ░██ 
 ██ ██ ██  ░███████  ██          ░██▒       ██     ██    ██ 
 ██ ██ ██  ██▓░  ██  ██░        ▒██▒        ██     ██░  ░██ 
 ██ ██ ██  ██▒  ███  ▓██▒  ░█  ▒██▒         ██     ███  ███ 
 ██ ██ ██  ████████   ███████  ████████     ██     ███████▒ 
 ██ ██ ██   ▓███░██    ▓████▒  ████████     ██     ██░███▒  
                                           ▒██              
                                         █████              
                                         ████░              
                                                            
ART
printf '\n  1) Full install (bootstrap + post-bootstrap)\n  2) Post-bootstrap only\n  3) Quit\n\n'
read -r -p '  Select: ' mode
case "$mode" in 1|2) ;; 3) exit 0;; *) echo 'Invalid selection.'; exit 2;; esac

for file in scripts/host.sh scripts/host-wrapper.cjs vendor/ns2jb/run.cjs; do
  [[ -f "$file" ]] || { echo "Missing required file: $file"; exit 1; }
done
[[ -x ./mac2jb-send && -x ./mac2jb-commands ]] || { echo 'Build first: make'; exit 1; }
[[ -f assets/bootstrap.bas ]] || { echo 'Missing assets/bootstrap.bas'; exit 1; }

# Prevent the launcher from advertising four steps if the binary still sends three.
# Dry-run never creates a USB device and never loads the real pairing tokens.
expected_commands=$'1: LOAD "TXT:NS2" [Enter]\n2: RUN [Enter]\n3: REMOVE NSR,&H60000000,&H3FFFFFFF [Enter]'
if ! dry_output=$(./mac2jb-commands --dry-run 2>&1) ||
   [[ "$dry_output" != *"$expected_commands"* ]] ||
   ! grep -Eq '^4: V=START\(' <<< "$dry_output"; then
  echo 'Your mac2jb-commands binary is outdated or does not support the four-command workflow.'
  echo 'Update commands.c and rebuild using: make mac2jb-commands'
  echo 'No USB input or ns2jb host was started.'
  exit 1
fi

# Never assume the user's existing MAC2JB_CONTROLLER setting is appropriate.
controller=auto
manual_timeout=4
auto_timeout=4
attempt_log="$(mktemp "${TMPDIR:-/tmp}/mac2jb-hid.XXXXXX")"
trap 'rm -f "$attempt_log"' EXIT

choose_controller() {
  local choice
  echo
  echo 'USB keyboard did not connect. You may retry automatic or select another controller.'
  echo 'Check the USB-C cable and the Switch connection.'
  echo 'The Mac must NOT be supplying charging power to the Switch.'
  echo 'If the Switch is charging from the Mac, unplug and replug the cable.'
  echo 'Make sure SmileBASIC is open on the correct input screen.'
  while :; do
    printf '\n  1) Retry automatic detection (usb-drd0, 1, 3)\n  2) Select USB controller manually (0-15)\n  3) Cancel\n\n'
    read -r -p '  Select: ' choice
    case "$choice" in
      1) controller=auto; return 0 ;;
      2)
        local number input_timeout
        read -r -p '  Controller number (0-15): ' number
        if [[ ! "$number" =~ ^([0-9]|1[0-5])$ ]]; then
          echo 'Enter a whole number from 0 through 15.'
          continue
        fi
        read -r -p '  Enumeration timeout in seconds [4] (1-120): ' input_timeout
        input_timeout="${input_timeout:-4}"
        if [[ ! "$input_timeout" =~ ^[0-9]+$ ]] || (( ${#input_timeout} > 3 )); then
          echo 'Enter a timeout from 1 to 120 seconds.'
          continue
        fi
        local numeric_timeout=$((10#$input_timeout))
        if (( numeric_timeout < 1 || numeric_timeout > 120 )); then
          echo 'Enter a timeout from 1 to 120 seconds.'
          continue
        fi
        controller="usb-drd${number}"
        manual_timeout=$numeric_timeout
        return 0 ;;
      3) return 1 ;;
      *) echo 'Invalid selection.' ;;
    esac
  done
}

# Retry only failures that occur BEFORE the first HID keystroke is transmitted.
# If a transfer began, retrying could duplicate a partial bootstrap or command.
run_hid() {
  local label="$1"
  shift
  local -a candidates=()
  local selected candidate
  while :; do
    if [[ "$controller" == auto ]]; then
      # Explicit per-controller attempts are required here. The CLI's
      # built-in auto-dispatch is intentionally bypassed for noninteractive
      # MAC2JB_AUTO_WORKER runs, so simply unsetting the variable is not enough.
      candidates=(usb-drd0 usb-drd1 usb-drd3)
    else
      candidates=("$controller")
    fi
    for candidate in "${candidates[@]}"; do
      : > "$attempt_log"
      echo "Trying $candidate ($label)..."
      # Never pass the literal string 'auto' to libusbd. Always send an
      # explicit valid controller for this individual attempt.
      # Start the sender and only apply the timeout while enumerating.
      # Once the sender reports enumeration, let the transfer finish normally.
      local timeout_seconds=$auto_timeout
      [[ "$controller" == auto ]] || timeout_seconds=$manual_timeout
      echo "Waiting up to ${timeout_seconds}s for $candidate to enumerate..."
      (
        export MAC2JB_CONTROLLER="$candidate"
        "$@"
      ) >"$attempt_log" 2>&1 &
      local sender_pid=$!
      local elapsed=0
      local timed_out=0
      local detected=0
      local shown_commands=0
      local command_count=0
      while kill -0 "$sender_pid" 2>/dev/null; do
        # The bootstrap sender prints 'Keyboard enumerated. Sending', but the
        # post-bootstrap sender prints 'Sending: RUN' once enumeration succeeds.
        # Either marker means the 4s enumeration timeout must stop immediately.
        if grep -Eq 'Keyboard enumerated\. Sending|^Sending: ' "$attempt_log"; then
          if (( detected == 0 )); then
            echo "$candidate: USB keyboard enumerated."
            if [[ "$label" == 'Sending bootstrap' ]]; then
              echo 'Transferring SmileBASIC bootstrap (approximately 7-10 minutes at 50 ms/key).'
              echo 'Keep this Terminal window open and the Switch plugged in until transfer completes.'
            fi
          fi
          detected=1
        fi

        # Display the exact commands reported by the native sender as it
        # begins each one, including the live pairing values for verification.
        # Treat the terminal output as sensitive until the session ends.
        if [[ "$label" == 'Sending post-bootstrap commands' ]]; then
          command_count=$(grep -c '^Sending: ' "$attempt_log" 2>/dev/null || true)
          while (( shown_commands < command_count )); do
            shown_commands=$((shown_commands+1))
            actual_command=$(grep '^Sending: ' "$attempt_log" | sed -n "${shown_commands}p" | sed 's/^Sending: //')
            if [[ "$actual_command" == 'REMOVE NSR,&H60000000,&H3FFFFFFF' ]]; then
              echo 'Note: SmileBASIC displaying "Out of memory" after REMOVE NSR is expected.'
              echo 'This is part of the normal ns2jb procedure, not a transfer failure.'
            fi
            echo "Sending ${shown_commands}/4: $actual_command"
          done
        fi
        if (( detected == 0 && elapsed >= timeout_seconds * 10 )); then
          timed_out=1
          kill -TERM "$sender_pid" 2>/dev/null || true
          break
        fi
        sleep 0.1
        if (( detected == 0 )); then elapsed=$((elapsed+1)); fi
      done
      # The process may exit between polls; report enumeration before any
      # buffered command progress even in this fast-completion case.
      if (( detected == 0 )) && grep -Eq 'Keyboard enumerated\. Sending|^Sending: ' "$attempt_log"; then
        echo "$candidate: USB keyboard enumerated."
        if [[ "$label" == 'Sending bootstrap' ]]; then
          echo 'Transferring SmileBASIC bootstrap (approximately 7-10 minutes at 50 ms/key).'
          echo 'Keep this Terminal window open and the Switch plugged in until transfer completes.'
        fi
        detected=1
      fi
      # Catch messages written between our final poll and process exit.
      if [[ "$label" == 'Sending post-bootstrap commands' ]]; then
        command_count=$(grep -c '^Sending: ' "$attempt_log" 2>/dev/null || true)
          while (( shown_commands < command_count )); do
            shown_commands=$((shown_commands+1))
            actual_command=$(grep '^Sending: ' "$attempt_log" | sed -n "${shown_commands}p" | sed 's/^Sending: //')
            if [[ "$actual_command" == 'REMOVE NSR,&H60000000,&H3FFFFFFF' ]]; then
              echo 'Note: SmileBASIC displaying "Out of memory" after REMOVE NSR is expected.'
              echo 'This is part of the normal ns2jb procedure, not a transfer failure.'
            fi
            echo "Sending ${shown_commands}/4: $actual_command"
          done
      fi
      local sender_status=0
      wait "$sender_pid" || sender_status=$?
      if (( sender_status == 0 )); then
        echo "$candidate: HID transfer completed."
        return 0
      fi
      # Any evidence that typing started means this is NOT safe to retry.
      # A second attempt could duplicate a partial BASIC program or command.
      if grep -Eq 'Keyboard enumerated\. Sending|Sent line [0-9]+|Sending: ' "$attempt_log"; then
        echo "$candidate: HID transfer failed after typing began. Stopping."
        cat "$attempt_log"
        return 1
      fi
      # Only retry failures that are clearly pre-transfer enumeration errors.
      if (( timed_out )); then
        echo "$candidate: enumeration timed out after ${timeout_seconds}s."
        continue
      fi
      if grep -Eiq 'USB host did not enumerate|USB enumeration error|selected controller|device did not enumerate|not enumerated|Waiting for USB host enumeration|USB host enumeration failed' "$attempt_log"; then
        echo "$candidate: no USB enumeration."
        continue
      fi
      echo "$candidate: failed before enumeration for another reason:"
      cat "$attempt_log"
      return 1
    done
    if [[ "$controller" == auto ]]; then
      echo 'Automatic detection finished: no controller enumerated.'
    else
      echo "Manual attempt on $controller failed: no USB enumeration."
    fi
    # Both automatic and manual failures return to the same choice menu.
    # Never automatically retry when HID typing may have started.
    choose_controller || return 1
  done
}

if [[ "$mode" == 1 ]]; then
  echo
  echo 'Open SmileBASIC, choose Make a Program, and open an EMPTY editor on the Switch.'
  read -r -p 'Press Enter when ready... ' _
  if ! run_hid 'Sending bootstrap' env MAC2JB_AUTO_WORKER=1 ./mac2jb-send assets/bootstrap.bas --delay-ms 50; then
    echo 'Bootstrap transfer failed; post-bootstrap steps were not started.'
    exit 1
  fi
  echo 'Bootstrap transferred. Inspect the program and save it as NS2 in slot 0.'
  echo 'Switch to SmileBASIC Direct mode before continuing.'
else
  echo
  echo 'Restart the console, then open SmileBASIC.'
  echo 'Make sure NS2 is already saved in slot 0.'
  echo 'Enter Direct mode. The launcher will type LOAD "TXT:NS2" first.'
fi

cat <<'NOTICE'

LOAD "TXT:NS2", RUN, REMOVE, then the live V=START command will be sent in order.
HID success does not prove command execution. Keep Direct mode focused.
NOTICE
read -r -p 'Confirm NS2 is saved in slot 0 and Direct mode is open; press Enter to start ns2jb... ' _

mkdir -p vendor/ns2jb/runs
chmod 700 vendor/ns2jb/runs
active='vendor/ns2jb/runs/mac2jb-active-connect.txt'
# Stop previous ns2jb run.cjs processes from THIS installation only.
# A PID may be reused, so checking the pairing file PID alone is insufficient.
# lsof must confirm the process working directory matches our bundled ns2jb.
# Other Node processes and ns2jb installations are never targeted.
ns2jb_dir="$PWD/vendor/ns2jb"
ns2jb_process_here() {
  local pid="$1" cmd cwd
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  (( ${#pid} <= 9 )) || return 1
  cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
  [[ "$cmd" == *node* && "$cmd" == *run.cjs* ]] || return 1
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)
  [[ "$cwd" == "$ns2jb_dir" ]]
}

stop_old_hosts() {
  local pid t
  local -a candidate_pids=()
  # pgrep is only candidate discovery; cwd + command are the safety check.
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && candidate_pids+=("$pid")
  done < <(pgrep -f '[n]ode .*run\.cjs' 2>/dev/null || true)
  if [[ -f "$active" && ! -L "$active" ]]; then
    pid=$(head -n 1 "$active" || true)
    [[ "$pid" =~ ^[0-9]+$ ]] && candidate_pids+=("$pid")
  fi
  # Bash with nounset may treat an empty array as unbound.
  for pid in "${candidate_pids[@]-}"; do
    [[ -n "$pid" ]] || continue
    if ns2jb_process_here "$pid"; then
      echo "Stopping previous ns2jb session (PID $pid)..."
      kill -TERM "$pid" 2>/dev/null || true
      for (( t=0; t<50; t++ )); do
        ns2jb_process_here "$pid" || break
        sleep 0.1
      done
      if ns2jb_process_here "$pid"; then
        echo "Host PID $pid did not exit; stop it manually before retrying."
        return 1
      fi
    fi
  done
  return 0
}
if [[ -e "$active" && ( -L "$active" || ! -f "$active" ) ]]; then
  echo 'Pairing path is not a regular file. Resolve manually.'
  exit 1
fi
stop_old_hosts || exit 1
if [[ -f "$active" ]]; then
  # Retain the file unless it references a definitely stopped process.
  old_pid=$(head -n 1 "$active" || true)
  if [[ "$old_pid" =~ ^[0-9]+$ ]] && ns2jb_process_here "$old_pid"; then
    echo 'An active ns2jb process still owns the pairing file; stopping.'
    exit 1
  fi
  echo 'Removing stale host pairing file.'
  rm -- "$active" || exit 1
fi
log="vendor/ns2jb/runs/mac2jb-gui-host-$$.log"
# Run the real ns2jb host in its own interactive Terminal window. This also
# lets the user respond if ns2jb prompts for a network interface/address.
# The host wrapper, not this launcher, writes the live pairing file.
printf -v root_q '%q' "$PWD"
printf -v log_q '%q' "$log"
host_command="umask 077; cd $root_q && bash scripts/host.sh 2>&1 | tee $log_q"
echo 'Opening ns2jb host in a separate Terminal window...'
if ! osascript - "$host_command" >/dev/null <<'APPLESCRIPT'
on run argv
  tell application "Terminal"
    activate
    do script (item 1 of argv)
  end tell
end run
APPLESCRIPT
then
  echo 'Unable to open the ns2jb Terminal window. Check macOS Automation permissions.'
  exit 1
fi

# Do not kill a host launched in another Terminal session when this launcher
# exits. It owns its own lifecycle; the user may inspect that window/log.
ready=0
for (( wait_step=0; wait_step<300; wait_step++ )); do
  if [[ -f "$active" ]]; then
    host_recorded_pid=$(head -n 1 "$active" || true)
    host_start_line=$(sed -n '2p' "$active" || true)
    if [[ "$host_recorded_pid" =~ ^[0-9]+$ ]] &&
       kill -0 "$host_recorded_pid" 2>/dev/null &&
       [[ "$host_start_line" =~ ^V=START\([0-9]+(,[0-9]+){8}\)$ ]]; then
      ready=1
      break
    fi
  fi
  sleep 0.2
done
if [[ "$ready" != 1 ]]; then
  echo "The new host has not published valid pairing parameters. Check its Terminal window and $log"
  read -r -p 'Press Enter to close this launcher... ' _ || true
  exit 1
fi
echo 'Host published current-session pairing parameters.'

if ! run_hid 'Sending post-bootstrap commands' env MAC2JB_AUTO_WORKER=1 ./mac2jb-commands --auto --delay-ms 50; then
  echo "HID transfer failed. Review the Switch and $log"
  read -r -p 'Press Enter to close this window... ' _ || true
  exit 1
fi

echo "Commands sent. Monitor the separate ns2jb Terminal window for FS verification."
echo "Host log: $log"
echo 'HID completion does not prove exploit success.'
read -r -p 'Press Enter to close this launcher... ' _ || true

# Close only the Terminal tab/window running this launcher, not the ns2jb host.
# Match by TTY instead of using Terminal's "front window", which may now be
# the separately opened ns2jb host window.
launcher_tty=$(tty 2>/dev/null || true)
if [[ "$launcher_tty" == /dev/* ]]; then
  osascript - "$launcher_tty" <<'APPLESCRIPT' || true
on run argv
  set targetTTY to item 1 of argv
  tell application "Terminal"
    repeat with terminalWindow in windows
      repeat with terminalTab in tabs of terminalWindow
        if (tty of terminalTab) is targetTTY then
          if (count of tabs of terminalWindow) is 1 then
            close terminalWindow
          else
            close terminalTab
          end if
          return
        end if
      end repeat
    end repeat
  end tell
end run
APPLESCRIPT
fi
exit 0
