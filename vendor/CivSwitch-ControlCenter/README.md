# CivSwitch Control Center v1.0.0

CivSwitch Control Center is a controller-driven utility interface for the
Civilization VII Remote JS Loader on Nintendo Switch and Nintendo Switch 2. It
provides read-only save export, save and installed-content inspection,
controller telemetry, and staged JavaScript payload transport.

Created by Matthew KuKanich, with platform-analysis assistance from
`@rastapasta`.

This is an independent research utility. It is not affiliated with or endorsed
by Nintendo, Firaxis Games, or 2K.

## What is included

```text
CivSwitch-Control-Center-v1.0.0/
├── README.md
├── LICENSE
├── VERSION
├── SHA256SUMS
├── control_center.js
├── send_js.py
└── tools/
    ├── __init__.py
    ├── save_dump_receiver.py
    └── send_staged_payload.py
```

- `control_center.js`: on-console Control Center payload.
- `send_js.py`: launches the Control Center and receives verified save exports.
- `tools/save_dump_receiver.py`: validates and writes save-export streams.
- `tools/send_staged_payload.py`: sends payloads through Payload Mode.
- `SHA256SUMS`: release-file checksums.

This package does **not** install the CivSwitch exploit or Remote JS Loader. A
working loader on TCP port `9026` is required before using the Control Center.

## Requirements

- A Nintendo Switch or Nintendo Switch 2 running a compatible Civilization VII
  CivSwitch Remote JS Loader.
- The console and host computer on the same local network.
- The console's local IP address.
- Python 3.10 or newer on the host.
- No third-party Python packages are required.

Nintendo-server access is not required by the Control Center. Network filtering
and DNS policy remain the user's responsibility.

## Quick start

Open a terminal in this release directory and run:

```sh
python3 send_js.py <SWITCH_IP> control_center.js
```

Example:

```sh
python3 send_js.py 192.168.1.50 control_center.js
```

Keep this terminal running while using the Control Center. The connection owns
the native controller-input subscription and receives save-export data.

The initial output should contain `CONTROL_CENTER_READY`. The Control Center
will appear over Civilization VII.

## Controls

- D-pad: navigate.
- A: open a tool, select an action, or confirm payload start.
- B: return to the tool list or close the Control Center.
- Left: return from a tool to the tool list.
- Touch/mouse: supported for tool and row selection.

Analog movement remains visible in Input Monitor telemetry but is not used as a
Control Center navigation method.

The Control Center closes automatically after 30 minutes when it is not in an
active transfer workflow.

## Tools

### Home

Displays useful status summaries and direct actions for the primary tools.

### Save Extractor

Exports the active save at:

```text
save:/saves/Single/XSTRIG.Civ7Save
```

The console displays a terminal-style progress screen with bytes, chunks, and
transfer progress. When transfer finishes, the regular Control Center is
restored automatically.

The console filesystem is accessed with directory lookup and read-only
`OpenFile`, `ReadFile`, and `CloseFile` operations. The extractor does not
create, overwrite, flush, commit, rename, or delete console files.

On the host, `send_js.py` verifies:

- Declared file size
- Chunk size and ordering
- Duplicate or out-of-range chunks
- Completion frame and chunk count
- `CIV7` file magic
- SHA-256

Verified backups are written to:

```text
backups/<timestamp>/XSTRIG.Civ7Save
backups/<timestamp>/metadata.json
```

Do not close the game, Control Center terminal, or network connection during an
active export.

### Save Browser

Displays a read-only inventory of `save:/saves`, including entry type and file
size. Selecting an item does not modify it.

### Installed Content

Displays installed Civilization VII content metadata, including enabled state
and official/user classification. This is an inventory view only.

### Input Monitor

Displays the active controller context and live semantic input actions without
changing controller bindings.

### Payload Mode

Payload Mode temporarily releases the normal loader execution while leaving a
transfer interface visible on the console. It receives a JavaScript payload in
acknowledged chunks and displays:

- Payload filename
- Byte size
- Host-computed SHA-256
- Current and total chunks
- Received bytes and progress
- Transfer-complete state

First open **Payload Mode** on the console. Then, from this release directory,
run:

```sh
python3 tools/send_staged_payload.py <SWITCH_IP> path/to/payload.js
```

After transfer:

- Press A to start the payload.
- Press B to return to the Control Center without starting it.

To launch immediately after the final chunk:

```sh
python3 tools/send_staged_payload.py <SWITCH_IP> path/to/payload.js --autostart
```

Only stage payloads you trust. Starting a staged payload executes arbitrary
JavaScript in the active CivSwitch loader context. Payload Mode does not sandbox
or restrict that code.

If B is used to return to the Control Center, keep the staged-payload terminal
open. That connection owns the resumed controller-input subscription until the
Control Center closes or enters Payload Mode again.

### About

Shows the project summary, read-only boundary, feature list, and credits.

## Custom loader port

The default TCP port is `9026`.

For the Control Center launcher, place a custom numeric port between the IP and
payload path:

```sh
python3 send_js.py <SWITCH_IP> <PORT> control_center.js
```

For Payload Mode:

```sh
python3 tools/send_staged_payload.py <SWITCH_IP> payload.js --port <PORT>
```

## Verifying the release

On macOS:

```sh
shasum -a 256 -c SHA256SUMS
```

On Linux with GNU coreutils:

```sh
sha256sum -c SHA256SUMS
```

## Troubleshooting

### Connection refused or timeout

- Confirm Civilization VII and the Remote JS Loader are running.
- Confirm the console IP address.
- Confirm the console and host are on the same LAN.
- Check host firewall and router isolation settings.
- Confirm TCP port `9026`, or supply the configured custom port.

### Controller input stops responding

- Keep the terminal that launched the current Control Center session open.
- Close and relaunch the Control Center if the loader connection was terminated.
- Do not send an ordinary payload through `send_js.py` while the Control Center
  is open; use Payload Mode instead.

### Payload sender reports that Payload Mode is unavailable

Open Payload Mode on the console before running `send_staged_payload.py`. The
normal Control Center intentionally serializes the loader until Payload Mode
releases it.

### Save target not found

The current extractor targets `save:/saves/Single/XSTRIG.Civ7Save`. Confirm the
active CivSwitch installation uses that path and that the save exists.

### Interrupted save export

An incomplete transfer is rejected and is not written as a verified backup.
Restart the Control Center and retry the export.

## Safety and scope

- Use this software only on hardware and software you own or are authorized to
  test.
- Keep independent save backups before experimenting with other payloads.
- Save Extractor and Save Browser are read-only on the console filesystem.
- Payload Mode is intentionally unrestricted after the user confirms start.
- Static inspection and host-side validation do not guarantee that arbitrary
  third-party payloads are safe.

## Credits

- Control Center design and integration: Matthew KuKanich
- Platform-analysis assistance: `@rastapasta`
- CivSwitch project and exploit toolchain: Gezine and CivSwitch contributors
- Additional upstream acknowledgements are documented in the parent CivSwitch
  project.

## License

Distributed under the MIT License included in `LICENSE`.

