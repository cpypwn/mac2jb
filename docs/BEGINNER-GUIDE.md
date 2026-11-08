# mac2jb: first-time setup, one screen at a time

This guide follows the **SmileBASIC / ns2jb** route. Use the separate
[CivSwitch instructions](../README.md#jailbreak-with-civswitch) if you are using
Civilization VII. Do not mix the two routes.

Each step says **Switch** or **Mac** so you know which device to use. Finish the
checkpoint before continuing. You do not need to build mac2jb from source.

## 1. Know the buttons and words first

On a Nintendo controller, the four letter buttons are arranged like this:

```text
        X
    Y       A
        B
```

**Press X** means the top letter button on the Switch controller. It does not
mean click the close button on a Mac window. **Press A** means the right-hand
letter button; use it to select a highlighted menu item. Use the directional
buttons or stick to move the highlight. When a confirmation dialog appears,
read its choices, highlight the choice you intend, and press **A**. Do not assume
the default selection is the correct one.

| Word in the app | Meaning | How to recognize it |
|---|---|---|
| **Direct Mode** | SmileBASIC's command screen. Commands run when you press Enter. The name is **Direct**, not “Director.” | A command prompt, rather than a page of numbered program lines. |
| **Edit Mode / editor** | The screen where the program's source text is entered. | Program text and line numbers. The setup program belongs here. |
| **PRG0 / slot 0** | SmileBASIC's first program workspace. It is held in memory; being in this slot does **not** mean it has been saved. | The program slot indicator identifies slot 0. |
| **Bootstrap / setup program** | The small SmileBASIC program mac2jb types for the selected host. | Multiple lines of BASIC text appear in the editor. |
| **Save** | Write the program to SmileBASIC's storage so it can be loaded again. | A completed save operation, not merely text visible in the editor. |
| **Host** | The selected ns2jb implementation. It determines which matching setup program and filename to use. | The host selected in mac2jb's developer options. |
| **RPC / held session** | The active network connection mac2jb uses to communicate with the running program. | mac2jb reports connection verification **4/4**. |

In SmileBASIC's programming workspace, **X switches between Direct and Edit
Mode**. Press it once, then check the screen. Repeatedly pressing X can put you
back where you started. Do not press it while mac2jb is typing.

**Press Minus (−)** to open SmileBASIC’s software keyboard. If you do not have
a physical keyboard, use the controller to highlight each key and press **A**
to enter it. Choose the keyboard’s Enter/return key to submit a command.
Do not use the Plus run/stop button as a substitute for Enter.

For keyboard commands below, **Enter** means the Enter/return key on the
SmileBASIC keyboard or connected USB keyboard. It does not mean press A on the
controller. mac2jb sends Enter itself during its automatic steps.

## 2. Check that you have the required setup

- Apple Silicon Mac with macOS 14 or newer.
- USB-C **data** cable; a charging-only cable cannot type into the Switch.
- Switch 2 with a version supported by this project's current
  [requirements](../README.md#what-you-need).
- SmileBASIC full version **4.4.9**, or supported demo **4.4.6**.
- SmileBASIC on internal storage, with more than 20 MiB free in its save.
- **Ethernet for the Switch.** The Mac may use Wi-Fi or Ethernet, but it must be
  on the same local network.
- The Switch's USB keyboard layout set to **US English**. The layout must match
  what mac2jb types; changing macOS's keyboard layout alone does not do this.

On the **Switch HOME Menu**, open **System Settings** (gear icon). Use the
**System** section to check the system version and find **USB Keyboard**; select
**English (US)** for the USB keyboard layout. If your system's labels differ,
confirm the equivalent US English setting before continuing.

Use the project's [update-blocking link](https://gitlab.com/a/90dns) before
experimenting. Do not accept a system or game update just to make a version
number match this guide; check compatibility first.

**Checkpoint:** you know whether you have the full game or demo, the Switch has
Ethernet, and both devices are on the same local network.

## 3. Install mac2jb and prepare the Mac driver

1. **Mac:** open the [Releases page](https://github.com/cpypwn/mac2jb/releases).
   Download the macOS arm64 application ZIP for the release you intend to use.
   Download the application, rather than GitHub's “Source code” ZIP.
2. **Mac:** in Finder, open **Downloads**, double-click the ZIP to extract it,
   then open **mac2jb.app**. Keep the extracted app; do not try to run it from
   inside an archive preview.
3. **Mac:** follow [USB driver setup](../README.md#set-up-the-usb-driver),
   including the macOS Recovery steps if this Mac is not already configured.
   Those steps explain the security changes required by the unsigned driver.
4. **Mac:** click **Install & Load Driver…** when instructed. Approve the
   administrator prompt, allow the driver in **System Settings → Privacy &
   Security** if prompted, and restart when required.
5. **Mac:** reopen mac2jb after the restart. Refresh the driver status. Do not
   reinstall it repeatedly to check its status: each install requires a restart.
6. **Switch + Mac:** connect the USB-C data cable. Check the power direction as
   described in [USB power direction](../README.md#3-check-usb-power-direction).
   If it is wrong, unplug the cable from the Switch, wait about one second and
   reconnect it. A loaded driver alone does not prove the cable is ready.

**Checkpoint:** mac2jb reports the driver loaded, with no installation restart
pending, and the USB connection is ready.

## 4. Open the right SmileBASIC screen on the Switch

1. **Switch:** from HOME, highlight **SmileBASIC** and press **A**. Choose your
   user if asked, then wait for its main menu.
2. **Switch:** highlight **Make a Program** and press **A**.
3. **Switch:** identify the screen using the definitions above. If you see the
   editor with program line numbers, you are in Edit Mode. If you see the command
   screen, you are in Direct Mode.
4. **Switch:** for the first-time typing step you need an **empty editor in
   slot 0**. If the command screen is open, press **X once** to enter Edit Mode.
   Check the slot indicator before allowing mac2jb to type.

### If slot 0 contains your own program

Do not type over it. Save your work first using SmileBASIC's normal save tools.
If you are unsure whether it is saved, stop here and preserve it first.

After saving your work, you can prepare slot 0 explicitly:

1. **Switch:** press **X** if needed to enter **Direct Mode**.
2. **Switch keyboard:** enter `NEW 0` and press **Enter**. This **erases the
   unsaved program in slot 0**. Do not issue it if that slot contains work you
   still need to save. Read and confirm any on-screen prompt.
3. **Switch keyboard:** enter `LIST 0:1` and press **Enter**. This selects the
   slot-0 editor at line 1.
4. **Switch:** check that slot 0 is empty and leave the editor open.

`NEW` without a slot number clears all program slots; it is not needed here.
The [official Direct Mode command reference](https://sup4.smilebasic.com/en/doku.php?id=reference%3AExclusive_Commands_for_Direct_Mode)
explains `NEW` and `LIST`.

**Checkpoint:** the Switch shows the empty **Edit Mode** workspace for **slot 0**.

## 5. Let the Mac type the setup program

1. **Mac:** leave the selected host unchanged unless you deliberately need a
   different one. A setup program saved for another host may not match.
2. **Mac:** click **Jailbreak with ns2jb**.
3. **Mac:** click **Open first-time setup** near the top of the popup.
4. **Mac:** select the demo option **only** if you are using the SmileBASIC demo
   and the chosen host supports it. Leave it off for the full version.
5. **Switch:** confirm the empty slot-0 editor is still visible. Close any game
   dialog or HOME overlay before starting.
6. **Mac:** tick **The empty editor is open and the USB cable is connected**.
7. **Mac:** click **Type the setup program**.
8. **Switch:** watch the editor. Program lines should appear automatically.
   Leave the controller alone and keep SmileBASIC open until mac2jb says typing
   has finished. Do not press X, HOME, or Enter during this transfer.

If nothing appears or the text is corrupted, stop the transfer and recheck the
screen, USB data cable, driver status and US English keyboard layout. Do not
save a partial or visibly corrupted program as if setup succeeded.

**Checkpoint:** mac2jb has finished typing and the complete setup program is
visible in slot 0. It still needs to be saved.

## 6. Save the setup program — this is a separate step

1. **Switch:** press **X once** to return from the editor to **Direct Mode**.
2. **Switch:** check the command prompt. It must be empty, with no half-entered
   command or confirmation dialog waiting. Do not erase the program in Edit
   Mode to make the command prompt empty; these are different screens.
3. **Mac:** tick **Direct mode is open with an empty command prompt**.
4. **Mac:** click **Type save command**. mac2jb chooses the command for your
   edition and selected host and sends Enter once. Do not also type it yourself.
5. **Switch:** if a save confirmation appears, read the filename and choices.
   Highlight the affirmative save/OK choice and press **A**. If an overwrite
   prompt appears, only approve it if you intend to replace that setup file.
6. **Switch:** wait until saving has finished and you are back at the command
   screen. A filename typed into the prompt alone does not mean the save worked.
7. **Mac:** tick the confirmation that the displayed setup filename is saved
   and Direct Mode is open. Click the **… saved — back to start** button.

The default filename is `NS2`; some host selections use another name, such as
`NS2I`. Follow the filename displayed by mac2jb, rather than renaming it to match
an example. The full and demo save commands differ; the automatic button handles
that difference. [Manual commands](../README.md#full-version) are available if
needed.

**Skip typing** means the complete matching program is already in slot 0 but
still needs saving. **Use saved bootstrap** means it is already saved under the
correct host filename. Neither button repairs an incomplete program.

**Checkpoint:** saving completed on the Switch and mac2jb returned to setup.

## 7. Start a session using the saved program

1. **Switch:** perform a full restart: hold the console's physical **POWER**
   button until the power menu appears, then choose **Power Options → Restart**.
   A short POWER press only puts the console to sleep.
2. **Switch:** reopen SmileBASIC with the same user, select **Make a Program**
   with **A**, and enter **Direct Mode**. Press **X once** if you are in the
   editor. Leave the command prompt empty.
3. **Switch + Mac:** reconnect USB if needed. Keep the Switch on Ethernet and
   the Mac on the same local network.
4. **Mac:** select the Mac's local address for that network. If several addresses
   appear, use the one belonging to the connection shared with the Switch.
5. **Mac:** click **Jailbreak with ns2jb**. Check the selected host and full/demo
   option match the setup file you saved.
6. **Mac:** confirm the Switch is ready and connected, then click
   **Start jailbreak**.
7. **Switch:** do not press buttons while mac2jb enters the load/run commands.
   It handles the load confirmation automatically. Keep SmileBASIC focused.
8. **Mac:** wait for **4/4 verification** before choosing a homebrew action.
   USB typing completing is not the same as a verified connection.

**Checkpoint:** mac2jb shows **Switch connection verified · 4/4** for a host that
retains RPC. Keep mac2jb and SmileBASIC open while using that session.

## 8. What to do when a checkpoint fails

| What you see | What to check next |
|---|---|
| Text appears in the command screen instead of program lines | Stop typing. You needed Edit Mode for first-time setup. Press X once and identify the editor before retrying. |
| SAVE text appears as another program line | You were in Edit Mode. Return to Direct Mode before using Type save command. Inspect the program for the accidentally inserted line before saving. |
| A button in mac2jb is greyed out | Check the prerequisite confirmation on that page and driver status. Do not tick a readiness box until the Switch actually matches it. |
| File not found when loading | Recheck the selected host, displayed filename, same Switch user and successful save. A program in slot 0 alone is not a saved file. |
| Verification stops at 2/4 with the Mac on Wi-Fi | Retry with the Mac on Ethernet, as recommended in the main README. |
| Verification stops at 3/4 | The README recommends another host; save that host's matching bootstrap before retrying. |
| Connection closes after changing the Switch to Wi-Fi | Keep the Switch on its original Ethernet connection. This build does not reconnect a retained session after a network change. |
| You are unsure which screen or step you reached | Stop and compare the last completed checkpoint. Keep the console/session logs and report your game edition, host and exact failed step. |

After RPC verification, USB may be disconnected if the Switch keeps its separate
Ethernet link and the Mac stays on the same network. Do not close SmileBASIC or
switch its network while the session is in use. Launch one homebrew at a time.

## Official references

- [SmileBASIC 4 electronic manual](https://sup4.smilebasic.com/en/lib/exe/fetch.php?media=smilebasic4electronicmanual.pdf): Switch controls and programming screens.
- [SmileBASIC 4 Direct Mode commands](https://sup4.smilebasic.com/en/doku.php?id=reference%3AExclusive_Commands_for_Direct_Mode): slot-specific `NEW` and `LIST` behavior.
- [mac2jb README](../README.md): current requirements, driver setup, host variants, CivSwitch and post-session tools.

These instructions were checked against the repository's UI strings and command
handling. A complete on-console walkthrough of this document has not been performed.
