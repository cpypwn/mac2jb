# CivSwitchFS-kaiHEN

> [!IMPORTANT]
> Thanks to **Slapah** for the ns2jb filesystem port to CivSwitch and **Kurumuz** for the improved fork of ns2jb from **Pepsipu**, which laid the groundwork for this research. All kudos goes to them for the Civ FS port :heart: This is a fork of CivSwitchFS which is by **Nerisma**, who did the difficult work of getting FS acquisition work locally!

CivSwitchFS provides **access to FS privileges** through an elevated fsp-srv handle. It runs inside the **CivSwitch Remote JS Loader**. The FS access can be chained into a full **kaiHEN boot** (homebrew enabler), which is what this fork provides, see [Booting kaiHEN](#usage).

CivSwitchFS is **semi-untethered**, RPC was fully removed :tada:

Smol demo of CivSwitchFS: https://streamable.com/bhgobg

Smol demo of CivSwitchFS booting KaiHEN: https://youtu.be/2pGN9HiXaZg (skip from 0:40 to 4:00)

## Repo state

This is meant to be sharing early code. It's not cleaned properly. The branch is called slop for a reason.

There will be updates, and you'll need to update manually.

Beware that fs vuln can be risky to utilize and may corrupt things like your save file, or more. If you want minimal brick risk, then wait on.

## Tested configuration

- Nintendo Switch 2, firmware **23.0.1** (only exFAT fw tested, FAT32 should work too). Do not use on lower firmware!
- **Civilization VII 1.0.0**, physical cartridge
- CivSwitch Remote JS Loader already running (follow [CivSwitch instructions](https://github.com/Gezine/CivSwitch))
- kaiHEN 20261117.1 (later versions may not work)

## Requirements

- Node.js **20 or later** and npm
- A Switch 2 with the CivSwitch Remote JS Loader already running and reachable on the local network when installing persistence or sending a payload
- A microSD card, formatted fat32 or exfat (can be non-express, press home on micronag)
- A Switch 2 game, physical or digital, can be a demo. If you're not sure: The bottom right animation on startup should be a switch 2 one.

## Usage

Install dependencies once from this repository:

~~~sh
npm install
~~~

### Persist the whole kaiHEN chain (recommended)

0. Set up your save file with CivSwitch. You may need to go to Data Management
   to delete your save file and reinstall it occasionally. [This esp32 LDN
   approach](https://github.com/SeanHeuc/CivSwitch/tree/main/esp32-ldn-civ7)
   is highly recommended.
1. Download a version of kaiHEN for SD card use (e.g. from [here](https://github.com/s8n/CivSwitchFS-kaiHEN/releases/)),
   extract it on your SD card, and then insert your microSD card **before** you start.
2. Set up a network connection that won't get you Nintendo server access.
   Be very careful with this. If you don't know how to do this right,
   DO NOT USE THIS YET. It's not worth the risk of getting the blacklist
   update that'll lock you out of Civ 7 without a reboot. If you will set up
   90DNS, follow the [instructions on Gitlab](https://a.gitlab.io/90dns/)
   precisely, do not skip any steps.
3. Boot into CivSwitch console by going to Civ 7 -> Load Game.
   Wait for `Awaiting payload`.
4. From this repository's folder, run the launcher with your console's IP
   address:

   ```sh
   npm run persist:chain -- <console-ip>
   ```

5. Wait for about a minute while the save file is set up.
6. Close Civilization VII normally. All subsequent starts of Civ 7 will automatically acquire FS then run kaiHEN.
7. After finishing the CivSwitchFS-kaiHEN runs, hold R while opening a switch 2 game.
   The first time, HEN only records the game's signing policy and the game starts
   as usual. The next R-held launch opens hbmenu. If it doesn't work, restart your system and run Civ7 to try again.
8. HEN lasts until the console restarts. To use homebrew again after a restart, go into Civ7 and hit load again.

**Tip:** You can go to Civ 7 settings -> Console to disable opening movies.

#### For advanced users: Manually structuring SD card files

Currently the official kaiHEN distribution has a different file layout than it expects on zip.

The copy in this repo's releases is going to match the SD format, but if you want to make your own, e.g. to run a later version, structure it like so:

| kaiHEN release file | SD card path |
|---|---|
| `bootstrap.bin` | `/kaihen/bin/bootstrap.bin` |
| `ro/main` | `/kaihen/bin/ro/main` |
| `hen/main` | `/kaihen/bin/hen/main` |
| `game/main` | `/kaihen/bin/game/main` |
| `hbmenu.nro` | `/hbmenu.nro` |
| `programs/ounceshell.nro` | `/switch/ounceshell/ounceshell.nro` |

If a file is missing, the chain refuses right after the promotion with
`SD files missing: …` instead of wasting the boot.

Extracting the official kaiHEN zip straight onto the card root may also work, there's code to catch that case.

To run a different kaiHEN build than the pinned one, create an empty
file `/kaihen/civswitchfs-skipcheck` on the card: the chain then skips
the file-identity (size) checks and only requires the files to exist.

### Launch CivSwitchFS by itself (not for end users)

If you are not going for persistence, just start the CivSwitch Remote JS Loader
using your usual CivSwitch setup. Then send the payload 

~~~sh
npm run send -- <console-ip>
~~~

Wait for **`You just Civ Sevened your machine, congrats`** which obviously means success :tada: !
Then, the loader automatically shows `Awaiting payload at <ip>:9026` and you are free to send payloads.

### Booting faster next time (this will be automatised eventually)

After success, the payload prints the working `roleDelays` and `guardDelays`
values in nanoseconds. To use them as the starting schedule next time, replace
the arrays in [`src/core/config.mjs`](src/core/config.mjs#L44-L47):

~~~js
var roleDelays = [0, 300000, 350000, 450000, 550000, 650000, 1000000, 1200000, 1300000, 1700000];
var guardDelays = [150000, 300000];
~~~

The trigger's initial sleep is 1,600,000 ns. The Slapah/Kurumuz
reference schedule used theses instead (might help if it worked for you on those)

~~~js
var roleDelays = [0, 300000, 350000, 450000, 550000, 650000, 1700000, 2000000, 2150000, 2800000];
var guardDelays = [0, 150000];
~~~

If you use the persisted payload, you ofc need to rerun the installer so its saved image includes the new timings.

> [!NOTE]
> You can play with the delays and MORE in `src/core/config.mjs`, try some shit (but don't brick pls) !

## Booting kaiHEN manually

`tools/kaihen.mjs` chains the FS access into a full [kaiHEN](https://github.com/ouncebrew/kaihen)
boot. Once kaiHEN runs, holding R while opening a game starts hbmenu
instead of the game. kaiHEN normally starts from SmileBASIC (a Switch
game with a built-in BASIC interpreter); this chain starts it from
Civilization VII. Targets the **20261117.1** release on firmware 23.0.1;
the previous **20261116** chain was verified both docked (Ethernet) and
undocked (WiFi).

On top of the usual setup you need:

- the kaiHEN release unpacked on your computer
- an SD card in the console: the first run copies hbmenu, the game loader
  and the HEN programs to it, later runs can pass `--no-stage`

Run the exploit first, wait for the success line, then the launcher:

```sh
npm run send -- <console-ip>      # wait for "You just Civ Sevened"
node tools/kaihen.mjs <console-ip> --dir /path/to/kaiHEN-20261117.1
```

A successful run ends with:

```
KH: === HEN IS RUNNING ===
-- kaiHEN is running. Close Civilization VII normally; hold R while opening a Switch 2 game twice. --
```

Then close Civ 7 normally (don't power off), hold R while opening another
game twice. The first R-held launch only records the game's signing policy and
the game starts as usual; the second R-held launch opens hbmenu. kaiHEN
keeps running until the console restarts.

The launcher stages the SD card, then runs the chain: it re-arms the
endpoint (the fs write path), reads the domain layout, copies the game's
loader fs session, builds a donor (a stand-in code filesystem), performs
the launch (the game's code filesystem is exchanged for kaiHEN's), and
finally runs the bootstrap NRO, which talks to that loader session copy
to start the HEN. Everything it prints goes to stdout; tee it if you
want to keep it.

| Option | Effect |
|---|---|
| `--dir DIR` | kaiHEN release folder, in our SD-shaped layout (default `../kaiHEN-20261117.1` from the repo root) |
| `--status-only` | report SD state and exit |
| `--force` | restage files even when their size already matches |
| `--no-hbmenu`, `--no-programs` | skip staging those files |
| `--no-stage` | skip the SD probe and staging entirely (files must already be on the card) |
| `--probes`, `--dx` | also run the debug diagnostics (TS/SR/SB probes / DX experiments; default skip list is `dx,probes`) — their sends close the loader session copy the bootstrap needs |
| `--skip A,B` | explicit skip list, overrides the default `dx,probes` |

### When it fails

- The promotion (`npm run send`, the race that wins the elevated fs
  session) loses about 1 attempt in 3: `Canary did not flip` means the
  attempt didn't take. Restart the game and retry. If it loses three
  times in a row, power-cycle the console.
- The layout stage crashes the game without any error output about half
  the time: the log just stops after `DL5` or `FR0` (layout-stage
  markers). Restart the game and retry; nothing launched yet, so the
  boot is still usable.
- One chain launch per console boot. After a run that reached
  `launch complete`, power-cycle before trying again; the launcher
  refuses a second launch on the same boot.
- Nothing may touch the loader session copy between its creation and the
  bootstrap's first request on it. fs closes a session when a request
  errors before its handler, and everything sent to a closed session
  fails with kernel `0xF601` (SessionClosed). That is the whole reason
  the debug diagnostics are opt-in.

kaiHEN is by [kurumuz](https://github.com/kurumuz). The chain is a port
of the reference implementation built on
[civ7-fs](https://github.com/HerXayah/civ7-fs) and
[CivSwitch](https://github.com/Gezine/CivSwitch).

## Notes

- The auto timing calibration is not perfect yet, some freezes can happen
- Timing configuration, retries and shit will go to a persisted config file soon enough
- You can learn about how the exploit works [there](https://github.com/ItsNerisma/CivSwitchFS/blob/main/HOW_IT_WORKS.md)

## Project structure

```text
src/core.js          # payload entry point and flow
src/core/            # steps, memory access, and FS communication
src/core/config.mjs  # the whole exploit conf, tweak it if you want
src/kaihen/          # kaiHEN chain stages (endpoint, layout, loader copy, donor, launch, bootstrap)
examples/            # small payload usage examples
persist/             # persistence builder inputs, save codec, writer, and installer
tools/               # well, tools
tools/kaihen.mjs     # kaiHEN launcher: SD staging + the chain, see "Booting kaiHEN"
```

## License

CivSwitchFS is MIT, ns2jb and kaiHEN are GPL v2.0, and so the code ported from those in this repo are under GPL v2.0.

See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for detailed notices.

## Standing on the shoulders of giants

- [Nerisma's CivSwitchFS](https://github.com/ItsNerisma/CivSwitchFS), which makes all this possible on-device. Amazing stuff.
- [Gezine](https://github.com/Gezine/CivSwitch) for CivSwitch, the Civ7
  entrypoint.
- [civswitch-kit](https://gitee.com/mza1010/civswitch-kit), the original Civ7
  FS kit, based on slapah/Hokage's work, which is itself based on ns2jb.
- [civ7-fs](https://github.com/HerXayah/civ7-fs), the Civ7 FS port this
  repository builds on.
- [kurumuz](https://github.com/kurumuz) for kaiHEN and his ns2jb fork.
- [pepsipu](https://gitlab.com/pepsipu/ns2jb) for discovering nsj2b vuln, and the ns2jb codebase.
- epiccsolar, who got kaihen booting ~13 hours before me, this repo doesn't use her code, but I want to acknowledge her work.
- LLMs were involved in the development of this. Please don't use it if you don't trust it.

