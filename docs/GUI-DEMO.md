# mac2jb 0.3.1 GUI

v0.3.1 is the active release. A completed Mac-side transfer does not prove that the console accepted the input or that ns2jb succeeded; the host independently verifies execution, restoration, and cleanup.

## Run the app

Extract the app ZIP and open **mac2jb.app**. It is one application to launch, with one native GUI executable containing the sender tools, Node.js runtime, host source, bootstrap, and notices. You do not need to install Node.js, Xcode, or command-line tools to run the prepared app. It extracts its embedded payload into a private session folder; “single executable” does not mean that it creates no local files.

The app is ad hoc signed, not Developer ID signed or notarized. If a downloaded copy is blocked by Gatekeeper, try opening it, then use **System Settings → Privacy & Security → Open Anyway**, if macOS offers it. See [Apple’s guidance for opening an app from an unidentified developer](https://support.apple.com/en-us/102445). Do not change kernel-security settings to address a Gatekeeper app warning.

To build your own copy from this source checkout, run:

```sh
bash scripts/build-gui.sh
open build/mac2jb.app
```

`make gui` is the optional shortcut for the build. Building requires Apple Silicon, Xcode Command Line Tools, and the official standalone **Node.js v24.22.1** runtime. The build uses `/usr/local/bin/node` by default; set `NODE_BINARY` to another v24.22.1 executable if needed. Running the resulting application does not require these tools. The existing CLI workflow remains `make` followed by `bash mac2jb.command`. The existing CLI remains available alongside the GUI.

## What the GUI handles

Select the Mac’s IPv4 address on the same network as the Switch. The GUI keeps the host and its current pairing values together, selects a USB controller automatically, and sends the post-bootstrap commands. **Install & load driver…** installs the bundled unsigned driver through an administrator prompt, preserves an existing driver in a backup, and requests loading. Complete Recovery settings first, then any approval/restart prompts. The extra Enter for SmileBASIC’s `LOAD` confirmation is included. The expected **Out of memory** response after `REMOVE` is part of the upstream procedure.

- **Full setup:** Open **SmileBASIC → Make a Program** with an empty editor before starting the bootstrap transfer. Allow approximately 7–10 minutes at the default typing speed. The GUI shows elapsed time and an estimate while it types, and records the final duration in the private session log. Wait until the entire bootstrap has finished typing; then enter **Direct mode**, type `SAVE "NS2"`, save it in **slot 0**, and continue to host & commands.
- **Saved bootstrap:** With **NS2 already saved in slot 0**, **restart the console → open SmileBASIC → enter Direct mode**. mac2jb automatically sends `LOAD "TXT:NS2"` first. The GUI skips the long bootstrap transfer, starts a new host session, and sends the post-bootstrap commands using fresh pairing values.

The sidebar tracks the selected flow and current attempt. **Saved bootstrap** keeps **Type bootstrap** checked. After a failure or cancellation, **Prepare** becomes active again and the interrupted step shows an **X**. Returning to Prepare does not repeat typing automatically.

Automatic USB selection tries the tested controllers 0, 1, and 3. Choose another controller manually if your Mac uses a different mapping. A retry is allowed only before typing begins. After a partial bootstrap, inspect and clear the editor before trying again. If post-bootstrap commands have started, or an exploit attempt fails or is cancelled, **restart the console before another attempt**. Do not send `REMOVE` twice in the same application process.

The timing controls let you tune key pacing, each controller’s enumeration timeout, and the waits between commands. Defaults are **50 ms per key**, **4 seconds per controller**, **1 second before confirming LOAD**, and **3 seconds after LOAD, RUN, and REMOVE**. The key-delay range is 1–2,000 ms, the enumeration range is 1–120 seconds, and each command wait accepts 0–120,000 ms. These changes apply to the GUI sender; the existing CLI keeps its original options and timing. The progress display counts bootstrap lines, command steps, and waiting time; it does not infer console execution from a timer.

The GUI cannot inspect the Switch screen, verify a saved program, operate macOS Recovery, grant kernel-extension approval, or guarantee exploit success. Keep the console focused and the USB cable connected. Only the host’s verified result establishes **FS execution verified**, including restoration and cleanup; **keyboard transfer completed** means only that the HID sender finished.

## Before a first run

1. Have an Apple Silicon Mac, a data-capable USB-C cable, and the compatible console software. The project’s tested combination is **Switch 2 system software 23.0.1 and SmileBASIC 4.4.9**, with more than **20 MiB free** in the SmileBASIC save.
2. In macOS Recovery, enable third-party kernel extensions and disable SIP with `csrutil disable`. Restart into macOS. The GUI never changes these settings.
3. Click **Install & load driver…**, approve the administrator prompt, complete macOS approval if requested, and restart. The tested unsigned driver is bundled; Xcode is not required. The previous CLI also supports `bash mac2jb.command --install-driver`. See [driver setup and source-build fallback](../README.md#install-the-bundled-usb-driver-recommended).
4. Put the Mac and Switch on the same reachable local network, select that network’s Mac IPv4 address, and allow the host through macOS networking/firewall prompts if requested. The host uses TCP port **39380**. Use a data-capable cable and check the USB power direction: on the tested hardware, enumeration failed when the Mac was charging the Switch. If the Switch shows that it is charging from the Mac, disconnect and reconnect the cable before retrying. A charging indicator does not prove that the keyboard data connection is working.
5. Preserve compatible console software before testing. Follow the [README’s 90DNS guidance](../README.md#highly-recommended-protect-the-required-software-versions), including its regional IPv4 addresses. Its Step 3 wording remains: “Set both primary and secondary IPv6 DNS to `::`, as described in the linked guide. Save the settings and reconnect to the Wi-Fi network.”

Once a compatible driver is installed, approved, and loaded, the prepared application removes the need to build senders, install Node.js, open Terminal windows, copy pairing commands, or choose a controller by trial and error at the command line. The console-side preparation and verification checkpoints remain necessary.

## Session data and distribution

Each GUI launch uses a private session folder under the user’s Application Support directory. Its redacted `gui-session.log` and the upstream host’s own run files are retained for diagnosis, including after a failure. A failure dialog shows the exact diagnostic log path and an **Open logs** button. If preparation fails before the normal session folder is ready, the app attempts to save a private diagnostic log in the macOS temporary directory instead; the dialog reports if no log could be saved.

Pairing files and upstream run data remain sensitive even though the GUI redacts pairing commands from its displayed diagnostics. Do not publish unredacted run folders or screenshots; session data is excluded from Git and release packaging. Stop the session before removing its data. Cancellation stops the processes belonging to that GUI session; it cannot undo keystrokes already delivered or replace a console restart.

The application includes the runtime notices; the accompanying source preserves mac2jb’s MIT license, upstream MIT/APSL notices and modified source, and pinned ns2jb source/provenance. The root license does not relicense those components. Existing source-distribution and third-party-rights boundaries still apply. No compiled kernel extension or prior session logs are included.
