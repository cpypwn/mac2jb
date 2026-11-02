# CivSwitch

XSS toolchain for the Switch 1 edition of Civilization 7.  
Only the **1.0.0** version of the game in physical cartridge is supported.  

Tested at Switch 1 fw 22.5.0, Switch 2 fw 20.4.0 and 23.0.1 using pi pico 2 (RP2350)  
pi pico 1 (RP2040) is untested.  

Two components:

- **PicoSwitch** — clean, compilable Pico firmware (RP2040 + RP2350) that types a chat-XSS payload into the Switch (USB HID macro).

  Default payload = the Remote JS Loader bootstrap (exploit core + TCP loader).

  Ships with `compress.js` (chat transport: terser -> deflateRaw -> base-25 chunked `img/onerror` lines with censor armor).
- **installer-creator** — given any JavaScript payload, produces the boot-persistent installer (`XSTRIG.Civ7Save` trigger written to savedata) to send through the Remote JS Loader.

## Layout

`core.js` at the root is the shared payload both components build from, and `send_js.py` at the root sends any payload to a running loader.

## Workflow

1. **Build + flash** the loader UF2 (see PicoSwitch/README.md).

   On the Switch, change system language to English(US).  
   Then launch game and navigate main menu -> MULTIPLAYER -> WIRELESS -> CREATE GAME -> HOST LOBBY -> CHAT then plug the Pico in (in docked mode, focus the chat box first to receive Pico input).  

   The Pico types the chat XSS (~87 lines, ~15 min); the Remote JS Loader comes up on the console (TCP :9026) for that session.  
2. **Install the persistent boot trigger** from the PC: `python installer-creator/install.py <console-ip>` — uploads the save template, splices the compressed payload into it on-console, wipes `save:/saves/Single/`, and writes the trigger.
3. From then on, every boot: main menu -> Load Game -> the payload runs from savedata (and if the payload is the loader, :9026 is up at boot — and survives console sleep/wake).  
4. You can revert system language after installer finished.  

## Sending payloads (`send_js.py`)

```
python send_js.py <console-ip> [port] file.js
```

Sends a JS file as-is to the Remote JS Loader (default port 9026), then prints the log output the console streams back (read until close or timeout).  

## Build (Pico firmware)

On Ubuntu 24.04:

```
sudo apt install -y git build-essential cmake ninja-build gcc-arm-none-eabi libnewlib-arm-none-eabi libstdc++-arm-none-eabi-newlib python3 nodejs npm
git clone --branch 2.3.1 --depth 1 --recurse-submodules --shallow-submodules https://github.com/raspberrypi/pico-sdk.git ~/pico-sdk
export PICO_SDK_PATH=$HOME/pico-sdk
cd PicoSwitch
npm install                    # terser for compress.js
node compress.js               # reads ../core.js -> payload.txt
cmake --preset pico2 && cmake --build --preset pico2    # RP2350 -> build-pico2/src/civ7-pico2.uf2
cmake --preset pico1 && cmake --build --preset pico1    # RP2040 -> build-pico1/src/civ7-pico1.uf2
```

## Credits

- The JS exploit core in `core.js` referenced [inject.js](https://github.com/NetflixNHack/Netflix-N-Hack/blob/main/inject.js) from [Netflix-N-Hack](https://github.com/NetflixNHack/Netflix-N-Hack) and its fork by [ufm42](https://github.com/ufm42/Netflix-N-Hack/blob/main/inject.js) 
- The PicoSwitch firmware is based on [Pico-Switch-Controller](https://github.com/Element2424/Pico-Switch-Controller) by [Element2424](https://github.com/Element2424)

