Thank you Codex for dutifully packaging the exploits for distribution. No, I have not read the distributed package.

# Switch 2 FS demo

Runs two small native functions inside FS, checks their results, and restores the
original instructions. Switch 2 only; no npm install or compiler needed.

You need **SmileBASIC 4.4.9**, **system software 23.0.1**, **Node.js 22+** on
macOS or Linux, and over **20 MiB free** in the SmileBASIC save. The computer and
console must be on the same reachable network.

## One-time setup

In SmileBASIC’s **Make a Program**, enter `bootstrap.bas` into slot 0 and save it
as `NS2`. A USB keyboard helps. The ZIP is a computer package, not a SmileBASIC
import file; there is no published download key.

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

Keep SmileBASIC open and the computer awake until **FS execution verified**.
Restart the console when finished; that also restores the original RO process.
This demo does not install custom firmware or persistence.

If a run fails, keep the `runs` folder and restart the console before trying
again. Enter `REMOVE` only once per application process. Logs and temporary
memory captures stay in `runs`; they are not part of the distributable.

Physically tested on October 21, 2026: both FS instruction challenges,
restoration, and cleanup passed. Acquisition is timing-sensitive: the test
passed on the third fresh boot. The first two attempts stopped at validation
checks and cleaned up.

## Code

`run.cjs` is the host entrypoint. `engine/switch2/pipeline.cjs` contains the fixed
launch sequence; `engine/switch2/process/fs-execute.cjs` contains the FS demo.
The native helper and its source are in `engine/switch2/ro/payload/`.
Developers can reproduce it with Zig 0.15.2:
`node engine/build-payload.cjs --check --zig /path/to/zig`.
