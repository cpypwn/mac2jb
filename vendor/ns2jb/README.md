# Switch 2 FS demo

Notes:

- Always use ethernet on the device you run the exploit and your Switch 2, or
the fs exploit won't work as it's very timing sensitive.
- Keep the game on internal storage of the console, not SD.
- FS exploit is still very unstable. At best you might get a 20% success rate.
- This version supports MacOS, Linux, and Windows



## What this fork improves

This fork adds support for smileBASIC 4.4.6 DEMO version in addition to the base version.

## One-time setup

In SmileBASIC’s **Make a Program**, enter `bootstrap.bas` into slot 0 and save it
as `NS2` (if using the full version). On the **SmileBASIC Demo**, saving to a file is
not required: keep `bootstrap.bas` entered in slot 0 directly. A USB keyboard helps.
The ZIP is a computer package, not a SmileBASIC import file; there is no published
download key.
To save and retrieve your code when using the demo version, use these inputs in direct mode:

saving: 
```sh 
PRGEDIT 0:C$="":FOR I=0 TO PRGSIZE(0)-1:C$=C$+PRGGET$() :NEXT:SAVEV "TXT:NS2",C$
```
loading:
```sh 
PRGEDIT 0:LOADV "TXT:NS2" OUT C$:PRGSET C$
```
## Run

1. Restart the console, open SmileBASIC, and enter Direct mode.
2. On the computer, open a terminal in the extracted folder and run:

   ```sh
   node run.cjs
   ```
   If asked, select the computer address reachable by the console. You can also
   supply it directly: `node run.cjs 192.168.1.10`. The connection uses port 39380.
3. In SmileBASIC, load the saved program and enter these commands separately:

   ```basic
   LOAD "TXT:NS2"
   RUN
   REMOVE NSR,&H60000000,&H3FFFFFFF
   ```

   Confirm the load. The **Out of memory** message from `REMOVE` is expected.
   Then enter the **`V=START(...)`** line printed by the computer.

   **NOTE:** the timing is very strict, make sure you are running the computer side and the switch side almost immediately after one another.
   
   If SmileBASIC says **Wrong number of arguments**, your saved `NS2` may be
   the older nine-argument bootstrap. Use the second `V=START(...)` line the
   computer prints: it has the same port and four IP numbers, followed by
   `,0,0,0,0`. Do **not** repeat `RUN` or `REMOVE`; enter just that replacement
   `START` command while the computer is still waiting. The `bootstrap.bas`
   supplied with this repo uses the normal five-argument form, so alternatively
   you can rewrite the bootstrap.

Keep SmileBASIC open and the computer awake until **FS execution verified**.
Restart the console when finished; that also restores the original RO process.
This demo does not install custom firmware or persistence.
