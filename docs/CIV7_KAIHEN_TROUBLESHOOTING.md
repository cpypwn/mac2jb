# Civilization VII / kaiHEN troubleshooting on macOS

Field report from a November 19, 2026 troubleshooting session. This documents partial hardware success and a remaining prerequisite, not a verified full kaiHEN boot.

## Environment and scope

- mac2jb 0.9.0, release build 548, on an Apple Silicon Mac.
- Civilization VII using the CivSwitch Remote JS Loader and saved Load Game trigger.
- mac2jb's direct offline Ethernet setup between the Mac and Switch.
- kaiHEN archive 20261117.1 was already cached locally.
- No microSD card was inserted during the final hardware attempt; this was confirmed afterward.
- The upstream chain requires Switch 2 firmware 23.0.1 and physical Civilization VII 1.0.0. Console firmware/game versions were not independently captured in this report.

Device addresses, usernames, session IDs, raw memory addresses and local filesystem paths are intentionally omitted.

## Entry point and saved trigger

The 87-line chat transfer completed and the loader listened on TCP port 9026. The saved trigger was then installed with the official [Gezine/CivSwitch PC installer](https://github.com/Gezine/CivSwitch/tree/main/installer-creator):

```sh
python3 installer-creator/install.py <switch-ip> 9026
```

Before installation, a read-only backup/inventory check reported zero files in the single-player save directory. This matters because the upstream installer replaces files in that directory; an existing player's saves must be backed up first.

The installer reported an exact offline compression round trip, uploaded four template chunks, then returned:

```text
INSTALL DONE - reboot, Load Game
Executed successfully
```

After installing the trigger, subsequent tests used Civilization VII → Load Game. Repeating the 87-line transfer or reinstalling the trigger was unnecessary.

## Original mac2jb route: repeated acquisition failure

The original Civilization VII main kaiHEN button called `KaiHENModel.start`. Its Mac-driven bridge connected successfully and passed application mapping, mount inspection and qualification.

Three recorded launches then failed at 2/4, acquiring filesystem memory:

| Launch | Recorded outcome |
| --- | --- |
| First | Failed after approximately 173 seconds; acquisition requalification failed, followed by `read EHOSTUNREACH`. |
| Second | Failed after approximately 144 seconds with `Console response timed out`. |
| Third, after a reported full restart | Failed after approximately 257 seconds after retries: `Acquisition did not become ready`, `The bounded native leak contains no qualified, encodable link candidate`, then `read EHOSTUNREACH`. |

Diagnostics reported uncertain cleanup and required a full console restart before another launch. The progress display could remain at 2/4 after a failure was already present in the session log; one was later explicitly stopped.

The loader/bridge handshake succeeded over offline Ethernet. These observations do not establish that offline Ethernet caused the acquisition failures. A final unreachable error alone cannot distinguish a network interruption from a console/application becoming unresponsive.

## Local test with the newer on-console chain

The local app was rebuilt to route the primary Civ7 button through the existing `CivSwitchKaiHENModel.startRunOnce` integration rather than the Mac-driven acquisition route.

The on-console integration was updated from its pinned revision to [s8n/CivSwitchFS-kaiHEN](https://github.com/s8n/CivSwitchFS-kaiHEN) commit `c7fcc0cec6e3071773b1b81500dbaf57472e17bc`. The generated readable combined chain was 495,920 bytes, under the loader's 500,000-byte limit. Matching kaiHEN 20261117.1 SD files were packaged for the existing SD preparation controls.

This was a local development build, not an official mac2jb release. The saved CivSwitch boot trigger was preserved; the test sent a one-session chain.

Validation before the hardware test:

- Upstream source/payload check passed.
- Seven mac2jb launcher tests passed, covering asset verification, SD staging/backups, save-backup gating and explicit HEN success confirmation.
- Packaged runtime required-file checks passed.
- Fresh embedded-runtime extraction and updated asset verification passed.
- The rebuilt app's embedded-runtime/dry-run self-test and code-signature verification passed. These checks did not send USB input or prove console success.

Local build notes: the default macOS 27.2 SDK failed because `SwiftUIMacros.StateMacro` was unavailable in the installed command-line toolchain. Building with the installed macOS 26.5 SDK succeeded. Reusing an extracted runtime also required excluding session state such as `selected-host.json` and session logs; otherwise fresh host selection failed. These are local build observations, not proposed general release-build changes.

## Hardware result: filesystem success, then SD open failure

mac2jb captured the opening payload credits, then reported:

```text
The kaiHEN chain ended without confirming HEN is running
```

However, a subsequent console photo showed that execution continued after the Mac-side output stopped:

```text
You just Civ Sevened your machine, congrats
CHAIN: promotion retained a session — starting kaiHEN
KH: === kaiHEN start for CivSwitchFS (ported by ave) ===
PAYLOAD ERROR: KH: OpenSdCardFileSystem: result 0xCED37E02
```

The operator then confirmed that no microSD card was installed.

This establishes filesystem promotion success for this attempt and a later failure while opening the SD filesystem. It does not establish that kaiHEN started. The missing card explains the unmet SD prerequisite, but this report does not assign an undocumented exact meaning to the numeric result or claim the code uniquely identifies an absent card.

No card-format diagnosis is supported: there was no card to inspect. Formatting a card or deleting the Civ7 save was not needed to identify this failure.

## Follow-up for maintainers and testers

- Make the inserted, prepared microSD requirement prominent before starting the chain. Distinguish an absent/unopenable card from missing files on an accessible card.
- Distinguish filesystem acquisition success from full kaiHEN success. Require the explicit `KH: === HEN IS RUNNING ===` marker for the latter.
- If the log connection ends without a success marker, report that confirmation was lost and ask the tester to inspect the console. Do not imply the console necessarily stopped at the last captured Mac-side line.
- Expose the acquisition engine revision separately from the mac2jb release version; a current app version does not by itself identify which upstream route is running.
- Consider the newer on-console route for a separately reviewed implementation change. One successful promotion does not prove improved reliability or justify attributing all earlier failures to the old revision.

The next hardware test requires a prepared microSD card, a fresh console boot and the existing Load Game trigger. Full kaiHEN startup and hbmenu launch remain unverified.
