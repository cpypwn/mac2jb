# seedsow-semi-untethered — Standalone On-Console `fsp-srv` + `kaiHEN` for *Seedsow Lullaby* (Switch 2)

[![Download v1.0.0 (.zip)](https://img.shields.io/badge/Download_Release-v1.0.0_(.zip)-2ea44f?style=for-the-badge&logo=gitlab)](https://gitlab.com/rushinz/seedsow-semi-untethered/-/releases/v1.0.0/downloads/seedsow-semi-untethered-v1.0.0.zip)
[![Releases Page](https://img.shields.io/badge/GitLab-Releases_Page-fc6d26?style=for-the-badge&logo=gitlab)](https://gitlab.com/rushinz/seedsow-semi-untethered/-/releases)

A **100% standalone, semi-untethered on-console Lua 5.1 port** of the `fsp-srv` + `kaiHEN` exploit chain for *Seedsow Lullaby* (**Trial/Demo `010075901ad6b000`** and **Retail Full Game `010075801ad6a000`**) on Nintendo Switch 2 (Ounce).

Once uploaded to `save:/` a single time, the entire chain runs **directly inside the Artemis Engine Lua 5.1 VM on the console** — **no PC, no Wi-Fi, and no TCP RPC server required**.

> [!WARNING]
> **Disclaimer — Use at Your Own Risk:**
> This software is experimental and is **not 100% safe or risk-free**. It is provided "as is" without warranty of any kind. The author and contributors are **not responsible** for any save data corruption, data loss, or console issues that may occur from using it — always keep a backup of your save data. As further stability or exploit improvements are made upstream, I will do my best to port them to this standalone on-console release.

---

## Features & Hardware Performance

- **True Semi-Untethered Operation:** All 14 Lua 5.1 modules live in `save:/` (`< 32,000` source bytes and `< 28,672` wire bytes per file). After the one-time save upload, just launch *Seedsow Lullaby* and press **`A`**.
- **Zero TCP Round-Trips:** Replaces hundreds of PC-over-Wi-Fi TCP RPC calls with on-console 13-worker `pthread` + `longjmp` ROP frame execution and RAM frame snapshots (`backup_frames` / `restore_frames`), completing in **~46–61 seconds** on Attempt 1.
- **Hybrid Heap Grooming (`CivSwitchFS` + `seedsow-fs-kaihen`):** Combines post-alias 6-neighbor sequential handle closing (`prepare_release_neighbors` + `release_neighbors_and_find_pointers`) with 30-to-60-block `0x4000` cache pinning (`pinHandle` + `auxiliaryStorageHandle`) for a **high success rate** on Switch 2 hardware.
- **On-Console Multi-Attempt Retry:** Automatically retires non-winning candidate cache headers with `16× 0x42` waves, deletes scratch `/hole` paths, and retries cleanly in-process without restarting the game.
- **Hardware Fail-Safe Recovery Mode:** Never modifies stock protected save files (`save:/core.lua`, `save:/inject.iet`, `save:/inject.lua`, `save:/http.lua`). Holding **`-` (Minus)** before pressing **`Y`** always boots the stock recovery HTTP server on port `8080`.
- **Automatic Hardware Telemetry (`sdmc:/kaihen/seedsow_run.log`):** Every successful run automatically appends a timestamped benchmark block (`[Run #N]`, `[TIMING]`, `[STAGE A+B]`, `[STAGE C]`, and full `T+...s` log trace) to `/kaihen/seedsow_run.log` on the microSD card.

---

## 1. One-Time Setup & Installation

### Step A — MicroSD Card Layout
Download the latest `kaiHEN` release zip from [`ouncebrew/kaihen/releases`](https://github.com/ouncebrew/kaihen/releases) and extract it to your microSD card (either into `/kaihen/bin/` or directly at the SD root / `/kaihen/` — on first run, `s2_kaihen.lua` automatically locates and organizes extracted `kaiHEN` release files into the structure below):

```text
sdmc:/
├── hbmenu.nro
├── kaihen/
│   └── bin/
│       ├── bootstrap.bin
│       ├── ro/
│       │   └── main
│       ├── hen/
│       │   └── main
│       └── game/
│           └── main
└── switch/
    └── ounceshell/
        └── ounceshell.nro
```

### Step B — One-Time Save Upload to `save:/`
1. Have *Seedsow Lullaby* (Demo or Retail) installed with the `ns2jb` / Artemis save injected.
2. Launch *Seedsow Lullaby* on your Switch 2 and press **`Y`** at the launcher menu to start the HTTP server (`port 8080`).
3. On your PC/Mac (with Node.js installed), run:
   ```sh
   node tools/upload-semi-untethered.cjs --host <SWITCH_2_IP>
   ```
   *(Example: `node tools/upload-semi-untethered.cjs --host 192.168.1.205`)*
4. The uploader verifies all 14 `.lua` modules against the `32,000`-byte source cap and `28,672`-byte `http.lua` wire cap, uploads them to `save:/`, and invokes `nn::fs::CommitSaveData("save")` (`commit_rc=0x0`) so they persist across reboots.

---

## 2. Everyday Usage (100% Offline / No PC)

### A. Standard `switch-artemis-launcher` (`seedsowhax` / `mac2jb`) Saves
1. Launch *Seedsow Lullaby* (boots directly into the black `A / B / Y` launcher menu).
2. Press **`A`** at the launcher menu to run the semi-untethered exploit (`exploita2.lua`).
3. Wait **~46–61 seconds** (on Attempt 1) until the screen prints:
   ```text
   KH: === READY! Close Seedsow Lullaby and hold R while launching a game ===
   ```
4. Close *Seedsow Lullaby*, then hold **`R`** while launching your donor game to open **`hbmenu`**.

### B. `Seedsow Lua Editor` Saves (Launcher in a Save Slot, e.g. Slot 6 or Slot 7)

> [!IMPORTANT]
> **REQUIRED EVERY TIME ON `Seedsow Lua Editor` SAVES:**
> Do **NOT** press **`A`** on your first game launch after turning on or restarting your Switch 2 — it will freeze. You **MUST** load your launcher slot once, **close the game**, and **reopen it** every time before pressing **`A`**.

1. Launch *Seedsow Lullaby*, open **Load**, and select your launcher slot (e.g., **Slot 6** or **Slot 7**) until the black `A / B / Y` launcher screen appears.
2. **Do NOT press `A` yet** — press **`HOME` -> `X` (Close Software)** to close the game completely.
3. Launch *Seedsow Lullaby* again, open **Load**, select your launcher slot (e.g., **Slot 6** or **Slot 7**), and now press **`A`**.
4. Wait **~46–61 seconds** until the screen prints:
   ```text
   KH: === READY! Close Seedsow Lullaby and hold R while launching a game ===
   ```
5. Close *Seedsow Lullaby*, then hold **`R`** while launching your donor game to open **`hbmenu`**.

---

## 3. Hardware Fail-Safe Recovery Mode

The stock bootstrap files (`save:/core.lua`, `save:/inject.iet`, `save:/inject.lua`, `save:/http.lua`) are **never modified**.
- If you ever need to re-upload files or recover from a bad script edit:
  1. Launch *Seedsow Lullaby*.
  2. Hold **`-` (Minus)** and press **`Y`** at the launcher menu.
  3. This forces `is_recovery = true`, bypasses `inject2.lua` / `core2.lua` / `exploita2.lua`, and starts the stock HTTP server on port `8080`.

---

## 4. Diagnostic Log (`sdmc:/kaihen/seedsow_run.log`)

Every run that reaches `READY!` automatically appends its stage timing breakdown and console log lines to **`sdmc:/kaihen/seedsow_run.log`** on the microSD card.

- **Option 1 — Pull over Wi-Fi via `OunceShell` FTP (no SD removal):**
  1. Open `hbmenu` -> launch **`OunceShell`** -> enable FTP (`port 1337`).
  2. From your PC/Mac terminal, run:
     ```sh
     curl -s ftp://<SWITCH_2_IP>:1337/kaihen/seedsow_run.log -o seedsow_run.log
     ```
- **Option 2 — Direct MicroSD Card Copy:**
  1. Copy `/kaihen/seedsow_run.log` directly from your microSD card.

---

## 5. Repository Layout & Verification Tools

```text
.
├── lua/
│   ├── core2.lua         # Stage-0 ROP loader & n2h primitive setup
│   ├── exploita2.lua     # Semi-untethered launcher entry point (A button)
│   ├── inject2.lua       # Launcher UI & recovery key check
│   ├── s2_rt.lua         # Native memory alloc/free & pthread worker runtime
│   ├── s2_prim.lua       # 64-bit arithmetic, HIPC/CMIF framing & ROP builder
│   ├── s2_fs.lua         # Signed cache planner, lower-window & wave retuner
│   ├── s2_fshlp.lua      # Worker ROP program generators (wave, alias, leak)
│   ├── s2_wave.lua       # 13-worker wave race execution & RAM frame cache
│   ├── s2_race.lua       # Canary race setup, control wave loop & alias install
│   ├── s2_scan.lua       # Pointer scanner, metadata anchor discovery & qualification
│   ├── s2_promote.lua    # Hybrid post-alias neighbor grooming & cache promotion
│   ├── s2_kaihen.lua     # Stage C: PM/Loader/FS handle harvesting & BootstrapArgs
│   ├── s2_kh_ro.lua      # Stage C: Direct domain-table Loader lookup & ro_takeover
│   └── s2_main.lua       # Multi-attempt orchestrator & sdmc:/kaihen/seedsow_run.log writer
├── tools/
│   ├── upload-semi-untethered.cjs  # Local cap checker (--check) & HTTP save:/ uploader
│   └── verify-lua-buffers.cjs      # 36-check byte-for-byte parity test suite (Lua 5.1 vs JS)
└── LICENSE               # GNU General Public License v2.0
```

### Running Local Verification Checks
```sh
# 1. Verify all 14 Lua files are under the 32,000-byte source cap and 28,672-byte wire cap:
node tools/upload-semi-untethered.cjs --check

# 2. Run the 36-check byte-for-byte parity suite (requires Lua 5.1):
node tools/verify-lua-buffers.cjs
```

---

## 6. Credits, Upstream Projects & License

This project builds directly upon the research, exploit chains, and tooling created by the Nintendo Switch 2 homebrew community:

- **`ns2jb`** — **pepsipu**, **kurumuz** (core `fsp-srv` vulnerability, race primitive, signed cache arithmetic, and `ns2jb` engine; **GPL v2.0**)
- **`kaiHEN` & `libounce`** — **kurumuz** / `ouncebrew` (`ro_takeover`, `bootstrap.bin`, `hen`/`game` payloads, and Switch 2 `OUN0` homebrew toolchain)
- **`CivSwitch`** — **Gezine** (save game / userland entry point research)
- **`CivSwitchFS`** — **Slapah**, **ItsNerisma** (post-alias neighbor opening, sequential handle close + `2 MiB` diffing, and domain-table Loader scan architecture)
- **`CivSwitchFS-kaiHEN`** — **s8n** (**aveao**), **Netfreak25** (`CivSwitchFS` + `kaiHEN` integration; **MIT**)
- **`switch-artemis-launcher`** — **alula** (Artemis Engine Lua 5.1 ROP bootstrap and `http.lua` server)
- **`seedsow-fs-kaihen`** — **Malev0**, **manupear**, **McGlowSticks**, **TheCrazy8** (*Seedsow Lullaby* adaptation, `mac2jb` Launcher, and `fsp-srv` tuning)

**Development Note (LLM Disclosure):** Portions of the Node.js-to-Lua 5.1 translation, the 36-check byte-for-byte parity verification suite (`tools/verify-lua-buffers.cjs`), and documentation were developed with LLM assistance, with all IPC/ROP buffers verified against the upstream reference builders and tested on physical Switch 2 hardware.

Licensed under **GPL v2.0** (see [`LICENSE`](LICENSE), compatible with upstream `ns2jb` and `seedsow-fs-kaihen`).

<details>
<summary><strong>CivSwitchFS MIT License Notice (ItsNerisma)</strong></summary>

```text
MIT License

Copyright (c) 2026 ItsNerisma

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
</details>
