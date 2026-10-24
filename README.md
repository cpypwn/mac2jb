# mac2jb

Uses an Apple Silicon Mac as a USB HID keyboard to type the [ns2jb](https://gitlab.com/pepsipu/ns2jb) SmileBASIC bootstrap into a Nintendo Switch 2 and send its post-bootstrap commands.

This is experimental, hardware-specific research software. **It is not custom firmware, a persistent jailbreak, a general-purpose homebrew loader, or a guarantee that the ns2jb exploit will succeed.** A successful HID transfer means the keyboard reports were sent; it does not establish that the console executed every command or that FS acquisition succeeded.

mac2jb bundles or references upstream work from [libusbd](https://github.com/shinyquagsire23/libusbd), [macos_usb_gadget_poc](https://github.com/shinyquagsire23/macos_usb_gadget_poc), and ns2jb. Read the upstream projects' documentation and licenses before use.

## What it does and where support ends

mac2jb is responsible for the **Mac-side USB keyboard emulation, SmileBASIC bootstrap transfer, command transmission, and orchestration of the locally bundled ns2jb host**. It does not implement or modify ns2jb's exploit logic. The vendored ns2jb runtime and exploit implementation are unchanged from the pinned upstream revision. The only downstream ns2jb source adjustment is a sanitized expected-value fixture in `vendor/ns2jb/test.cjs` (with its updated `SHA256SUMS` entry); mac2jb's own host wrapper, launcher, and integration scripts are separate files.

**Support boundary:** I can investigate issues with mac2jb's installation, controller selection, USB enumeration, character transmission, launcher, and handoff to the host. **Once mac2jb has delivered its commands and ns2jb is executing its own stages, ns2jb-specific failures are outside the scope of mac2jb support.** Please consult the [upstream ns2jb project](https://gitlab.com/pepsipu/ns2jb) for details about its internals and acquisition or execution failures. I cannot provide individual troubleshooting for ns2jb itself.

Use at your own risk. mac2jb is provided without a guarantee of compatibility, exploit success, or protection against data loss, system instability, or service restrictions. This support statement does not override applicable licenses or legal rights.

## Source provenance, licensing, and session security

### v0.3.0 GUI

Download the native Mac GUI from [the v0.3.0 release](https://github.com/cpypwn/mac2jb/releases/tag/v0.3.0), or build it with `make gui` and open
`build/mac2jb.app`; see [the GUI guide](docs/GUI-DEMO.md) for setup,
automation limits, and logging. Its single executable embeds Node.js, the
senders, and the offline host, so users of the built app need no build tools
or separate Node.js installation. It does not include a compiled kernel extension.

The existing CLI is still available:
`make` builds the command-line tools, and `bash mac2jb.command` runs the same
terminal workflow. GUI work does not change the vendored exploit runtime.

GUI failures display the diagnostic log's exact path and an **Open logs**
button. Session files stay in private per-launch folders outside the checkout;
build folders and repository-local logs are also ignored by Git.

The repository root `LICENSE` applies to mac2jb's MIT-licensed code and does **not**
relicense third-party material. `vendor/libusbd/LICENSE` and
`vendor/macos_usb_gadget_poc/usbgadget/LICENSE` retain the upstream MIT notices.
Apple-derived headers retain their Apple Public Source License notices; the full
APSL 2.0 text is included in both `vendor/libusbd/LICENSE-APSL-2.0.txt` and
`vendor/macos_usb_gadget_poc/LICENSE-APSL-2.0.txt`. Dated changes to libusbd's
macOS backend and build are recorded inside their respective modified files.

`vendor/ns2jb` is pinned to an upstream revision; only its `test.cjs` assertion
fixture is adapted to avoid embedding a complete numeric `V=START(...)` value,
and its `SHA256SUMS` checksum reflects that adaptation. The runtime and exploit
logic are unchanged. Separate redistribution and third-party rights must be
reviewed before public releases. The vendored
`macos_usb_gadget_poc` material is intentionally **trimmed** to its documented
MIT-licensed `usbgadget/` kernel-extension source/Xcode project. It excludes the
unused `usb_device/` proof of concept and the precompiled `.kext` bundle.
`upstream.lock` identifies the origin and commit, not a guarantee that every
vendored project is an untouched full checkout.

**Session confidentiality:** ns2jb may print live `V=START(...)` pairing values.
mac2jb stores logs under `vendor/ns2jb/runs/`, excludes that directory from
Git and source ZIPs, and sets restrictive local directory/log permissions.
Do not post full Terminal output, screenshots, or logs without redacting live
pairing values. To discard old logs after the host has stopped, run
`bash scripts/clear-session-logs.sh` (it leaves the current pairing file alone).

**Source releases intentionally omit compiled kernel extensions.** To use the
USB-gadget functionality, build the kext from the included Xcode source, assess
its privileges and signing requirements, and follow Apple's security approval
procedures. `make` alone does not build or install the kext.

## Tested environment

The maintainer's successful end-to-end test used:

| Component | Verified setup |
| --- | --- |
| Mac | MacBook Pro M4 (`Mac16,1`), Apple silicon |
| macOS | 26.4.1 |
| Switch 2 system software | 23.0.1 |
| SmileBASIC | 4.4.9 |
| Connection | Data-capable USB-C cable |
| Switch operation | Docked and undocked |
| Switch USB-C ports | Top and bottom tested |
| macOS USB gadget driver | `gay.bowser.usbgadget` / `usbgadget.kext` (1.01 observed) |

The initial complete ns2jb hardware test succeeded on the **third fresh console boot**; the earlier attempts failed validation and cleaned up. Successful operation on other Macs, system versions, or SmileBASIC versions has not been verified.

### Tested Mac USB controller mapping

| Mac USB-C port (`Mac16,1`) | Controller |
| --- | --- |
| Lower-left | `usb-drd0` |
| Upper-left | `usb-drd1` |
| Right-side | `usb-drd3` |

These are **model-specific observations**, not universal Mac port mappings. Other Macs may use different controller indices.

**USB power direction matters.** On the tested hardware, enumeration failed when the Mac was supplying charging power to the Switch. If the Switch is charging from the Mac, unplug and reconnect the cable, then try again. A charging indicator, a loaded kext, or a successful build does not prove USB keyboard enumeration. Successful input appearing inside SmileBASIC is the meaningful confirmation.

## Highly recommended: protect the required software versions

**I strongly recommend configuring DNS-based blocking of Nintendo update services on the Switch 2 network connection before testing.** The purpose is to reduce the chance of an unwanted system update or SmileBASIC update that could make the tested exploit chain incompatible.

**Recommended service: [90DNS (ConsoleMods guide)](https://consolemods.org/wiki/Switch:Blocking_OFW_Updates#90DNS).** Configure it on the Switch 2 network you use for testing:

1. Open **System Settings → Internet → Internet Settings**, select your Wi-Fi network, and choose **Change Settings**. Set **DNS Settings** to **Manual**.
2. Set the **IPv4 DNS** addresses for your region:
   - **North or South America:** Primary `207.246.121.77`; Secondary `163.172.141.219`.
   - **Anywhere else:** Primary `163.172.141.219`; Secondary `207.246.121.77`.
3. **Set both primary and secondary IPv6 DNS to `::`**, as described in the linked guide. Save the settings and reconnect to the Wi-Fi network.

90DNS is a third-party DNS service intended to block Nintendo services, not only firmware updates; this may prevent eShop access, Nintendo Switch Online, and other Nintendo features. Check the [current guide](https://consolemods.org/wiki/Switch:Blocking_OFW_Updates) before use and verify the connection and filtering work on your network. **DNS filtering is not a guarantee against updates:** cached addresses, alternative networks, changed endpoints, or other paths can bypass it. The `::` IPv6 setting may also be unsuitable for IPv6-only networks. Do not rely on DNS blocking as the only protection against accidental updates.

This recommendation concerns **preserving the tested firmware/software versions**, not making the exploit safer or more reliable.

## Prerequisites and important security notes

- An Apple silicon Mac, Nintendo Switch 2, SmileBASIC 4, and a **data-capable** USB-C connection.
- Xcode Command Line Tools for building the mac2jb senders; **full Xcode is needed if you build the experimental kext from its Xcode project**.
- Node.js **22 or newer** for the ns2jb host.
- The pinned vendored sources and `assets/bootstrap.bas`, as included in the complete repository/release archive.
- A reachable local network connection between the Mac and Switch for the ns2jb host stage.
- A compatible and **already installed/approved** experimental `usbgadget.kext` for USB gadget mode.

**The source release does not supply a ready-to-install, signed kext.** Its driver source/Xcode project is under:

```text
vendor/macos_usb_gadget_poc/usbgadget/usbgadget.xcodeproj
```

macOS may require **Reduced Security** and explicit kernel-extension approval to load this legacy experimental driver. The maintainer's research machine also had SIP disabled temporarily, but **SIP being disabled on the tested Mac does not establish that disabling it is necessary on every Mac**. These choices significantly lower Mac security and should not be automated by the launcher. Review Apple's security documentation, use a dedicated research machine, and restore normal protections after testing.

`make` builds the **mac2jb command-line utilities**, not the kernel extension. It does not install or approve a kext for you.


### Building and installing the USB gadget kext (Apple silicon)

The bundled `usbgadget` Xcode project is **source**, not a preinstalled driver. Kexts run with kernel privileges: build and install them only on a Mac you control and are prepared to use for experimental testing.

1. Install **full Xcode**, open `vendor/macos_usb_gadget_poc/usbgadget/usbgadget.xcodeproj`, select the `usbgadget` kext target, and build for the Mac. Locate the resulting `usbgadget.kext` in Xcode's build products. Ensure the build architecture and signing configuration are suitable for your Mac. Build completion does **not** mean the kext is properly signed or approved.
2. On Apple silicon, follow Apple's instructions to enable third-party kernel extensions under **Reduced Security** in macOS Recovery, if required. Return to macOS. Do not disable SIP solely because a generic installation step fails.
3. Copy the **built** bundle to the standard third-party location and give the installed copy the ownership and permissions macOS expects. Replace the placeholder path below with the actual build product:

   ```sh
   # Set this to the actual Xcode-built product; do not use a guessed path.
   KEXT="/absolute/path/to/build/Products/Release/usbgadget.kext"
   test -d "$KEXT" || { echo "Kext bundle not found"; exit 1; }

   sudo ditto "$KEXT" /Library/Extensions/usbgadget.kext
   sudo chown -R root:wheel /Library/Extensions/usbgadget.kext
   sudo chmod -R go-w /Library/Extensions/usbgadget.kext
   ls -ld /Library/Extensions/usbgadget.kext
   ```

   The installed bundle should show **`root wheel`** ownership, not your user account. Never run these recursive ownership commands against the project directory or other unrelated files.
4. Request installation/validation of the **installed** copy:

   ```sh
   sudo kmutil load -p /Library/Extensions/usbgadget.kext
   ```

   Follow any macOS approval prompts under **System Settings → Privacy & Security**, and restart if requested. A valid signing identity and appropriate kernel-extension approval may still be required; `sudo` and `chown` do not bypass signing or system security checks.
5. After the required reboot, check:

   ```sh
   kmutil showloaded | grep -i usbgadget
   ```

   A loaded kext does not guarantee HID enumeration. Confirm with the mac2jb USB test or by successfully typing into SmileBASIC.

**Ventura troubleshooting — `KMErrorDomain Code=30: Invalid ownership (501:20) should be (0:0)`**

This specific message is an **ownership/permissions validation failure**: macOS found a kext owned by a normal user (`501:20`) where it expected `root:wheel` (`0:0`). It does **not**, by itself, establish that macOS Ventura is incompatible with the driver. Running `sudo kmutil load -p usbgadget.kext` does not change ownership of that original bundle. Install a root-owned copy as shown above and retry with the absolute path. If the subsequent error is about signatures, policy, architecture, or compatibility, treat that as a separate issue; compatibility with Ventura is **not hardware-verified by this project**.

See [Apple's custom kext installation guide](https://developer.apple.com/documentation/apple-silicon/installing-a-custom-kernel-extension) for approval/reboot details. Installing an experimental kernel driver can reduce system security or stability; avoid changing security settings merely to suppress an unexplained error.

## Build and check

From the mac2jb repository root:

```sh
bash scripts/check.sh
make clean && make
```

For driver diagnostics:

```sh
kmutil showloaded | grep -i usbgadget
```

A loaded driver is necessary for this workflow but does not mean USB enumeration is working. If mac2jb refuses to start or reports missing scripts, verify your installation is complete before changing system security settings.

## Terminal launcher

The terminal launcher provides the full bootstrap workflow and a shortcut for retrying an existing saved bootstrap. From the repository root:

```sh
bash mac2jb.command
```

Its startup menu offers:

```text
1) Full install (bootstrap + post-bootstrap)
2) Post-bootstrap only
3) Quit
```

Option 1 — Full install: Open **SmileBASIC → Make a Program** with an empty editor. Wait until the entire bootstrap has finished typing, then inspect the program, save it as `NS2` in **slot 0**, and enter **Direct mode** before pressing Enter. The launcher then starts the ns2jb host in a separate Terminal window and waits for the current session’s pairing command before transmitting post-bootstrap commands.

Bootstrap transfer time: The bundled bootstrap is approximately 7,804 characters over 224 lines. At the default `--delay-ms 50`, typing typically takes about 7–10 minutes, including USB overhead and indentation adjustments. This is an estimate, not a hard timeout. After enumeration succeeds, leave the Terminal window open and the cable connected until typing completes.

Option 2 — Post-bootstrap only: With `NS2` already saved in **slot 0**, **restart the console → open SmileBASIC → enter Direct mode**. The launcher skips the bootstrap transfer, starts a new ns2jb host session, and automatically sends `LOAD "TXT:NS2"` followed by the remaining post-bootstrap commands.

The launcher opens the ns2jb host in another Terminal window and waits for its current session’s `V=START(...)` pairing command before submitting the post-bootstrap commands. They are sent in this order:

```basic
LOAD "TXT:NS2"
RUN
REMOVE NSR,&H60000000,&H3FFFFFFF
V=START(...)
```

After the `LOAD` command, SmileBASIC asks the user to confirm loading `NS2`. The updated command sender transmits an additional Enter to accept the highlighted YES option before sending `RUN`. The `Out of memory` response to `REMOVE` is expected. The `V=START(...)` arguments are generated anew by the active ns2jb host; the example above is a placeholder.

### USB selection and timeouts

The launcher attempts the tested controllers (`usb-drd0`, `usb-drd1`, `usb-drd3`) and identifies each attempt in the terminal. The intended automatic enumeration timeout is **4 seconds per controller**; once HID transfer starts, the enumeration timeout must no longer terminate it. Users can retry automatic selection or choose an explicit controller from **0 through 15**, with a configurable timeout for manual attempts.

If enumeration fails, check that the cable supports data, verify that the Switch is not being charged by the Mac, and reconnect the cable. **Do not automatically retry a partially completed text transfer:** clear the input and assess the session first to avoid duplicate commands.

During post-bootstrap transmission, the launcher prints each command being sent, including the current host's full `V=START(...)` values for comparison with the console. **These pairing tokens are sensitive session data.** Do not publish screenshots or logs containing them; do not reuse tokens from a previous host launch.

**Important:** HID completion is not the same as confirmation of command execution. If the launcher reports that commands were sent, inspect the Switch and the separate ns2jb host window for the actual result. Do not treat an automatic transfer or a Terminal success message as proof of a successful exploit.

This launcher workflow requires the matching updated `mac2jb-commands` binary. Before testing, rebuild it using `make mac2jb-commands` and verify with `./mac2jb-commands --dry-run` that the four commands begin with `LOAD "TXT:NS2"`. A failed build can leave an older three-command executable in place; do not use that executable. These updates are not part of the original v0.1.0 source release.

## Manual workflow

You can still run the tools without the menu. This is useful for debugging or validating a new launcher.

1. Open **SmileBASIC → Make a Program** with an **empty** editor and transfer the bootstrap:

   ```sh
   ./mac2jb-send assets/bootstrap.bas --delay-ms 50
   ```

2. Wait until the entire bootstrap has finished typing, inspect and save it as `NS2` in **slot 0**, then enter **Direct mode**. On subsequent runs, skip the lengthy transfer and use the saved program.
3. Start the ns2jb host from the project root in a separate Terminal window:

   ```sh
   bash scripts/host.sh
   ```

4. Once it publishes the **current** `V=START(...)` command, use the existing command sender:

   ```sh
   ./mac2jb-commands --delay-ms 50
   ```

The manual command sender may ask for confirmations between steps. When using the updated automated sender, verify that the `LOAD` confirmation is handled before `RUN`. Sending HID keystrokes does not prove the upstream ns2jb stages completed.

You can select a known controller manually, for example:

```sh
MAC2JB_CONTROLLER=usb-drd3 ./mac2jb-send assets/bootstrap.bas --delay-ms 50
```

When using the underlying tools, **do not assume `MAC2JB_CONTROLLER=auto` is equivalent to leaving it unset**; driver and sender versions differ. The verified manual form is `usb-drdN`. The launcher should manage controller selection so ordinary users do not need to set this environment variable.


## SmileBASIC full game versus demo

The full game can save the bootstrap for later sessions. Historically, the demo was treated as unable to save it, so demo users were instructed to retransmit it each session.

### Unverified demo save/load workaround

Reddit user **u/kuksthedefiled** shared the following commands (quoted from a Discord discussion) as a possible way to persist a program in the demo:

**Save program:**

```basic
PRGEDIT 0
SAVEV "TXT:MYPROG", PRGGET$()
```

**Load program:**

```basic
PRGEDIT 0:LOADV "TXT:MYPROG" OUT C$:PRGSET C$
```

Replace `MYPROG` with your chosen name. For the ns2jb bootstrap, confirm that the correct code is present in slot 0 after loading, and run an integrity check if available.

**This is community-reported and has NOT been tested by the mac2jb maintainer on the demo.** It might work, fail, or behave differently across SmileBASIC versions. In particular, persistence across a full console restart remains unverified. Until you test and confirm that a saved demo program can be reliably restored, use **Full install** to resend the bootstrap as needed. Neither saving nor loading the bootstrap makes ns2jb persistent.

## Troubleshooting mac2jb

| Symptom | What to check |
| --- | --- |
| `scripts/host.sh: No such file or directory` | The local release extraction is incomplete. Restore the full `scripts/` directory from the repository; don't overwrite it with an empty one. |
| USB doesn't enumerate | Check USB data cable, Mac-to-Switch charging direction, selected controller, driver load state, and Switch input focus. Replug if the Mac charges the Switch. |
| `invalid MAC2JB_CONTROLLER 'auto'` | A version mismatch or launcher bug passed a literal `auto` to the driver. Use an explicit `usb-drdN` value or an updated launcher. |
| Unexpected characters (`A` becomes `Q`, etc.) | Check the **Switch's USB keyboard layout**, not just the Mac's input layout. mac2jb emits USB HID keycodes directly and assumes a US keyboard layout. |
| Pairing file already exists | The launcher should identify and stop only prior ns2jb hosts belonging to this installation before starting a new session, and clear stale pairing files without killing unrelated processes. Do not start a new attempt while an existing ns2jb session is performing work. |
| Pairing parameters not published | Check that `scripts/host.sh` and `scripts/host-wrapper.cjs` exist, Node.js works, and the host is not waiting for network-interface selection. |
| Partially typed code after a disconnect/timeout | Stop and inspect/clear the partial input before retrying; disconnect USB if a key appears stuck. |
| `candidate_pids[@]: unbound variable` | The launcher’s host-process scan encountered an empty array under `set -u`. Use the corrected launcher version; do not interpret this as an ns2jb or USB failure. |
| Display shows four command labels but Switch receives only three | Rebuild `mac2jb-commands` and check its `--dry-run` output. Do not rely on hardcoded launcher labels or an old executable left after a failed build. |
| Host reports an FS acquisition, placement, or native execution failure | This is **ns2jb-stage behavior**, not proof of a USB typing failure. See upstream ns2jb documentation; the mac2jb maintainer cannot troubleshoot ns2jb internals. |

Host pairing values, session captures, and memory logs may contain sensitive information. Avoid uploading them publicly without reviewing and removing sensitive fields.

## Credits

- **ns2jb** — original Switch 2 exploit and FS research: [upstream ns2jb](https://gitlab.com/pepsipu/ns2jb).
- **libusbd** and **macos_usb_gadget_poc** — USB device emulation and experimental macOS gadget-driver work by [shinyquagsire23](https://github.com/shinyquagsire23).
- **u/kuksthedefiled** — shared the community-reported SmileBASIC demo save/load workaround, attributed to a Discord discussion; not yet verified here.
- **ASCII art** — created using [Patorjk's Text to ASCII Art Generator](https://patorjk.com/software/taag/).

See the project's included licenses and upstream documentation for copyright, attribution, and reuse terms.
