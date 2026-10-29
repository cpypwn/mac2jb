# Pico 2 W keyboard bridge (legacy, unused)

> **This fork does not use the Pico.** The host no longer starts this bridge or
> listens on port 39381. Follow [README.md](../../README.md) and enter
> the bootstrap launch commands manually. These files are retained for reference
> and attribution only.

This board types the SmileBASIC bootstrap and the fresh connection command. It
does not render the launcher or relay its native RPC traffic; the console and
Pico each connect directly to the computer.

For the current no-Pico sequence, follow [Getting Started](../../docs/GETTING_STARTED.md).

| Mode | Jumper at power-on | Console/computer screen | Behavior |
| --- | --- | --- | --- |
| Maintenance | GP0 → GND | Computer | `boot.py` exposes CIRCUITPY/serial and disables keyboard HID |
| Bootstrap entry | GP1 → GND, GP0 open | Empty SmileBASIC EDIT0 | Waits 15 seconds, types `program.bas`; save as NS2 |
| Normal launch | Both open | Fresh SmileBASIC Direct mode | Gets a validated host command, types LOAD/RUN/REMOVE and connection command |

Disconnect before changing jumpers. `boot.py` reads GP0 early; `code.py` reads
GP1. Normal mode hides the storage drive and serial interface and presents a
boot-compatible USB keyboard. CircuitPython autoreload is disabled while typing.
The HID library is vendored with its original MIT notice.

The installer creates `settings.toml` with `CIRCUITPY_WIFI_SSID`,
`CIRCUITPY_WIFI_PASSWORD`, `NS2_HOST` and `NS2_PICO_KEY`. It copies the same pairing
key to the local host's ignored `secret` file. Reinstall/re-pair both sides if
that file is lost. Environment overrides `NS2_WIFI_SSID` and
`NS2_WIFI_PASSWORD` are supported by the installer; interactive prompts avoid
putting credentials into shell history.

Normal mode connects to host TCP 39381. The board validates the received command
shape, IPv4 destination, bridge port and numeric fields before typing. It sends
status messages for connection, typing and completion. The host supplies a fresh
session command; never paste a previous session's command as a shortcut.

`START_DELAY`, `KEY_HOLD`, `KEY_GAP` and `LINE_DELAY` in `code.py` control typing
speed. Defaults favor reliable entry. The LED indicates typing and status/error
activity; diagnose network failures using host messages rather than inferring a
specific fault from an undocumented blink pattern.
