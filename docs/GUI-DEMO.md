# mac2jb 0.3.0 GUI demo

This is a local preview of the v0.3.0 interface. **v0.2.1 remains the active release.** The preview has not been verified end to end on a connected Switch 2; a completed Mac-side transfer does not prove that the console accepted the input or that ns2jb succeeded.

## Run the demo

Extract the demo ZIP and open **mac2jb.app**. It is one application to launch, with one native GUI executable containing the sender tools, Node.js runtime, host source, bootstrap, and notices. You do not need to install Node.js, Xcode, or command-line tools to run the prepared demo. It extracts its embedded payload into a private workspace for the current session; “single executable” does not mean that it creates no local files.

The demo is ad hoc signed, not Developer ID signed or notarized. If a downloaded copy is blocked by Gatekeeper, try opening it, then use **System Settings → Privacy & Security → Open Anyway**, if macOS offers it. See [Apple’s guidance for opening an app from an unidentified developer](https://support.apple.com/en-us/102445). Do not change kernel-security settings to address a Gatekeeper app warning.

To build your own copy from this source checkout, run:

```sh
bash scripts/build-gui.sh
open build/mac2jb.app
```

`make gui` is the optional shortcut for the build. Building requires Apple Silicon, Xcode Command Line Tools, and the official standalone **Node.js v24.22.1** runtime. The build uses `/usr/local/bin/node` by default; set `NODE_BINARY` to another v24.22.1 executable if needed. Running the resulting application does not require these tools. The existing CLI workflow remains `make` followed by `bash mac2jb.command`. This preview changes no release tags or the v0.2.1 CLI workflow.

## What the GUI handles

Select the Mac’s IPv4 address on the same network as the Switch. The GUI keeps the ns2jb host and its current pairing values together, selects a USB controller automatically, displays transfer progress, and sends the four post-bootstrap commands in order. It can also request that macOS load an already installed driver, using a macOS administrator prompt; installation, signing, policy approval, and any required reboot remain separate. The extra Enter for SmileBASIC’s `LOAD` confirmation is included. The expected **Out of memory** response after `REMOVE` is part of the upstream procedure.

- **Full setup:** Select the default **[WORKSPACE]** project, then open **Make a Program** with an empty editor before starting the bootstrap transfer. Allow approximately 7–10 minutes at the default typing speed. Wait until the entire bootstrap has finished typing; only then inspect the program, save it as **NS2** in **slot 0**, and enter **Direct mode in [WORKSPACE]**. Continue only after completing that checkpoint.
- **Saved bootstrap:** After a fresh console restart, open the project containing your saved NS2 and enter Direct mode. The GUI skips the long bootstrap transfer, starts a new host session, and sends the post-bootstrap commands using fresh pairing values.

Automatic USB selection tries the tested controllers 0, 1, and 3. Choose another controller manually if your Mac uses a different mapping. A retry is allowed only before typing begins. After a partial bootstrap, inspect and clear the editor before trying again. If post-bootstrap commands have started, or an exploit attempt fails or is cancelled, **restart the console before another attempt**. Do not send `REMOVE` twice in the same application process.

The timing controls let you tune key pacing, each controller’s enumeration timeout, and the waits between commands. Defaults are **50 ms per key**, **4 seconds per controller**, **1 second before confirming LOAD**, and **3 seconds after LOAD, RUN, and REMOVE**. The key-delay range is 1–2,000 ms, the enumeration range is 1–120 seconds, and each command wait accepts 0–120,000 ms. These changes apply to the GUI sender; the existing CLI keeps its original options and timing. The progress display counts bootstrap lines, command steps, and waiting time; it does not infer console execution from a timer.

The GUI cannot inspect the Switch screen, select its project, verify a saved program, operate macOS Recovery, grant kernel-extension approval, or guarantee exploit success. Keep the console focused and the USB cable connected. Only the host’s verified result establishes **FS execution verified**, including restoration and cleanup; **keyboard transfer completed** means only that the HID sender finished.

## Before a first run

1. Have an Apple Silicon Mac, a data-capable USB-C cable, and the compatible console software. The project’s tested combination is **Switch 2 system software 23.0.1 and SmileBASIC 4.4.9**, with more than **20 MiB free** in the SmileBASIC save.
2. Build and install a compatible **usbgadget.kext**, ensure its installed copy has the required ownership and signing, approve it through macOS, and complete any requested reboot. **Reduced Security and approval alone do not install or load the driver.** The driver must also be present and loaded before USB keyboard emulation can work. The demo does not ship a compiled kext.
3. On Apple Silicon, shut down and hold the power button to enter startup options, then open Recovery’s **Startup Security Utility**. Select **Reduced Security** and **Allow user management of kernel extensions from identified developers**, restart, and complete macOS approval and any further requested reboot. Follow [Apple’s security-policy instructions](https://support.apple.com/guide/mac-help/mchl768f7291/mac), its [custom kernel-extension installation guide](https://developer.apple.com/documentation/apple-silicon/installing-a-custom-kernel-extension), and the [repository’s driver setup instructions](../README.md#building-and-installing-the-usb-gadget-kext-apple-silicon). The GUI does not change this policy or disable SIP.
4. Put the Mac and Switch on the same reachable local network, select that network’s Mac IPv4 address, and allow the host through macOS networking/firewall prompts if requested. The host uses TCP port **39380**. Use a data-capable cable and check the USB power direction: on the tested hardware, enumeration failed when the Mac was charging the Switch. If the Switch shows that it is charging from the Mac, disconnect and reconnect the cable before retrying. A charging indicator does not prove that the keyboard data connection is working.
5. Preserve compatible console software before testing. Follow the [README’s 90DNS guidance](../README.md#highly-recommended-protect-the-required-software-versions), including its regional IPv4 addresses. Its Step 3 wording remains: “Set both primary and secondary IPv6 DNS to `::`, as described in the linked guide. Save the settings and reconnect to the Wi-Fi network.”

Once a compatible driver is installed, approved, and loaded, the prepared application removes the need to build senders, install Node.js, open Terminal windows, copy pairing commands, or choose a controller by trial and error at the command line. The console-side preparation and verification checkpoints remain necessary.

## Session data and distribution

Each GUI launch uses a private workspace under the user’s Application Support directory. Its redacted `gui-session.log` and the upstream host’s own run files are retained for diagnosis, including after a failure. A failure dialog shows the exact diagnostic log path and an **Open logs** button. If preparation fails before the normal session folder is ready, the app attempts to save a private diagnostic log in the macOS temporary directory instead; the dialog reports if no log could be saved.

Pairing files and upstream run data remain sensitive even though the GUI redacts pairing commands from its displayed diagnostics. Do not publish unredacted run folders or screenshots; session data is excluded from Git and release packaging. Stop the session before removing its data. Cancellation stops the processes belonging to that GUI session; it cannot undo keystrokes already delivered or replace a console restart.

The application includes the runtime notices; the accompanying source preserves mac2jb’s MIT license, upstream MIT/APSL notices and modified source, and pinned ns2jb source/provenance. The root license does not relicense those components. Existing source-distribution and third-party-rights boundaries still apply. No compiled kernel extension or prior session logs are included.
