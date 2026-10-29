# First launch with GPUBrewLauncher

Maintainer: **NiftyNova**. Original HBLauncher by **RavensClawX**.

This guide is for **Nintendo Switch 2 system 23.0.1**, **SmileBASIC 4.4.9**, and
a **Linux computer**. Match those exact versions; “latest version” is not a
compatibility check. This project does not supply SmileBASIC or console firmware.
You need an installed, working copy of the supported SmileBASIC version.

This fork assumes `bootstrap.bas` is already saved on the console as **NS2** in
SmileBASIC slot 0. It does not inject or type the bootstrap. You enter the short
launch sequence on the console yourself.

You do not need to compile the launcher to try the release. Its GPU shaders and
Hello World assets are included. The computer must stay running while you use it.

## 1. Gather the hardware

- Switch 2 with the supported software and more than 20 MiB free in SmileBASIC's save.
- A saved SmileBASIC program named **NS2** in slot 0, containing
  [`smilebasic/bootstrap.bas`](../smilebasic/bootstrap.bas).
- A Linux computer on the same reachable network as the console.

## 2. Extract the project and install host tools

Extract the source release into a normal writable folder. Open a terminal in
that folder; `start.sh`, `README.md`, `smilebasic/`, `sdk/` and `apps/` should be
visible. All commands below run from that folder.

Install Node.js 22 or newer using [Node's official instructions](https://nodejs.org/en/download).
On Ubuntu/Debian, install the remaining runtime tools:

```sh
sudo apt-get update
sudo apt-get install python3 python3-pil fonts-dejavu-core spirv-tools
node scripts/doctor.cjs
```

Every line should say `OK`. The checker does not install software or change the
console; `./start.sh` runs it automatically. Building apps adds `glslang-tools`,
which you can check with `node scripts/doctor.cjs --build`. Desktop GPU testing
also needs a C compiler, `libvulkan-dev` and a Vulkan driver. The release runs on
the console GPU, so a gaming GPU in the computer is not required.

The host detects the computer's LAN IPv4 address automatically. To list the
candidates without starting a session:

```sh
./start.sh --list
```

If the computer has more than one (for example Wi-Fi and Ethernet), `./start.sh`
shows each address with its interface name and asks which one shares the
console's network. You can pass that address directly to skip the prompt:

```sh
./start.sh 192.0.2.10
```

Use the address of the interface shared with the console. If unsure, check
whether the console is connected over Wi-Fi or Ethernet in its network settings.
Do not use `127.0.0.1`, a VPN-only address, or the console's own address.
`hostname -I` and `ip -4 addr` show the machine's addresses.

## 3. Confirm the saved bootstrap

The console must already have the bootstrap in slot 0 saved as **NS2**. If it is
missing or damaged, enter [`smilebasic/bootstrap.bas`](../smilebasic/bootstrap.bas)
manually in SmileBASIC's program editor and save it as **NS2**. Preserve
punctuation, line breaks and character case. Set the console's USB keyboard
language to **English (US)** if you use a keyboard.

The `V=START(...)` command uses the computer's LAN address and the fixed
trailing values `0,0,0,0`. Only run the host on a trusted local network, because
the command has no per-launch secret.

## 4. Start the host and connect

1. Close and reopen SmileBASIC so it is a fresh application process, then open
   **Direct mode**. Do not resume a previously failed native session.
2. On the computer, start the host:

   ```sh
   ./start.sh
   ```

   If it lists more than one LAN address, choose the one on the console's
   network. To skip the prompt, pass the address shown by `./start.sh --list`:

   ```sh
   ./start.sh 192.0.2.10
   ```

   The preflight checker validates dependencies. The host then prints
   `Graphics listener ready` and the `V=START(...)` command. Session files are
   temporary and are deleted when the program exits. To keep a session for
   debugging, run `HB_KEEP_SESSION=1 ./start.sh` and make the same address
   choice; the retained debug session is created under `runs/` and its path is
   printed.
3. Leave Direct mode focused. Enter these lines separately:

   ```basic
   LOAD "TXT:NS2"
   RUN
   REMOVE NSR,&H60000000,&H3FFFFFFF
   V=START(...)
   ```

   Confirm the load when prompted. `RUN` prepares the bootstrap. The expected
   `Out of memory` response to `REMOVE` is part of the sequence. Enter the
   `V=START(...)` line printed by the current host run; its address decimals
   are the computer address you chose, and its trailing values are always
   `0,0,0,0`.
4. Wait for the host to finish checks, upload graphics/audio and show
   GPUBrewLauncher. A successful startup reports a continuous native frame loop.
   The display stays black during graphics preparation, then GPUBrewLauncher
   fades in over 15 frames (about a quarter of a second at 60 Hz).

**Never repeat `REMOVE` in the same SmileBASIC process.** After a failed attempt,
close/restart SmileBASIC before retrying. Reuse the saved NS2 program, not an old
session's connection command or addresses.

The host accepts inbound TCP **39380** from the console. Allow it on your local
network if a firewall blocks it. Guest-network/client isolation can block the
connection even when both devices have Wi-Fi. Do not forward the port to the
public internet. The internal authenticated RPC connection is on loopback only.

## 5. Use the launcher

- D-pad **Up/Down** or the left stick selects an app; **A** opens it.
- Touch an app row to launch it. Touch Refresh to rescan `apps/`.
- Move the **right stick** to control the pointer in handheld mode; **ZR**
  clicks a hovered row or Refresh.
- Put either detached Joy-Con 2 into optical mouse position to move the same
  pointer. **L** clicks while the left Joy-Con tracks; **R** clicks while the
  right tracks. Each mouse works with the other Joy-Con still attached.
  These clicks work on app rows and Refresh. **ZR** is also a click.
- The pointer hides when neither optical sensor reports active tracking, unless
  it was activated with the right stick.
- The sun/moon switch beside **Back** turns dark mode on and off. Tap a side,
  drag the knob, or press **A** or **ZR** while the pointer is over it. The
  setting lasts for the current launcher session.
- While the pointer is visible, **A** acts on whatever is under it: an app row
  launches, the switch toggles, and blank space does nothing. With the pointer
  hidden, **A** opens the highlighted row.
- Hello World returns to the launcher with **B** or **Minus**.
- D-pad Left/Right do not enable any debug catalog or preview mode.
- The menu shows three apps per page. Moving past the third visible row with
  D-pad Up/Down or the left stick switches pages; wrapping past the last app
  returns to the first page. Touch and pointer clicks act on the visible page.
- The catalog accepts at most 32 apps.

Normal cursor movement stays on-console and does not wait for host polling.
App switches and explicit SDK service requests stop at a controlled boundary.
The launcher has no System/diagnostics menu.

## 6. Stop, update or repair

Press Ctrl+C in the host terminal. The worker exits at a cycle boundary and
owned hardware services are closed. Restart SmileBASIC to release retained
native allocations before a new session.

After a failed native session, restart the console before retrying. Do not edit
the saved bootstrap to target a different SmileBASIC version; keep the supported
versions matched.

| Symptom | Check |
| --- | --- |
| Console never connects | Address printed by `./start.sh` (or `./start.sh --list`), TCP 39380, Direct-mode focus, saved NS2 program, supported versions, network isolation |
| `V=START` rejected | Check the computer address, TCP port 39380, and the trailing `0,0,0,0` values |
| `LOAD` fails | Save `bootstrap.bas` as NS2 in slot 0; preserve the source exactly |
| Missing module/font/tool message | Run `node scripts/doctor.cjs` and fix each `NEED` line |
| App not listed | Check `app.json`, return to menu, then Refresh; retain the session with `HB_KEEP_SESSION=1` and inspect `catalog.rejected` in its report |
| Pointer is hidden | Move the right stick, or detach a Joy-Con, place its optical side on a suitable surface, and move it; generic mouse support is separate |
| Native session or version check fails | Restart SmileBASIC; verify exact supported versions; do not bypass qualification |

See [the technical reference](../REFERENCE.md) for package installation and
advanced details, [README](../README.md) for the short setup and run guide,
[the SDK guide](../sdk/README.md) to build your own apps, and
[CREDITS](../CREDITS) for project attribution.
