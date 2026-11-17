# OunceCake-Civ7

(`ozdumptool` if you're ***lame*** and ***boring***) 

Tool to dump unencrypted romFS and exeFS for Switch 2 games, updates and DLC, modified to work with Civilization 7

Supports digital games, game cards, Switch 2 Editions, etc.
(For NSO titles, make sure the title has been opened recently before you attempt to mount it, otherwise the mount will fail.)

## Disclaimer

For the love of God, do NOT share any files you rip using this tool. It is to be used with ONLY your own games on your OWN system. This tool doesn't provide system keys or any method to decrypt files. The files are loaded normally by the system, then pulled over FTP.

## Usage

This tool has been tested with [civswitch-kit](https://gitee.com/mza1010/civswitch-kit/)

0. Take note of your Switch 2's local IP address. It can be found in the network settings.

1. Clone the repo: 
``` 
git clone https://github.com/BlafKing/OunceCake-Civ7.git
```

2. Use [civswitch-kit](https://gitee.com/mza1010/civswitch-kit/) to get an RPC connection with the system.

<details>
<summary>How to use civswitch-kit</summary>

1. Clone the repo:
```
git clone https://gitee.com/mza1010/civswitch-kit.git
```

2. Run `set-pc-ip.ps1 <Your local PC IP>`
   On Unix, you can manually set your ip in the `port/civ_bridge.js` file.

3. Open a terminal in the `port` directory and run `node engine/run.cjs --rpc <PC Local IP>`

4. Open a second terminal in the main directory and run `python3 save-tools/send_js.py <Switch Local IP> port/civ_bridge.js`

5. Wait until the first terminal window successfully runs the exploit, if it fails, restart the console and try again.

6. Take note of the `Run folder:` logged in the first terminal window when successful.
---

</details>

3. Run `node ouncecake.cjs <Path to run folder>`. The output from civswitch-kit will tell you where this path is. (`Run folder: /home/tom/civswitch-kit/port/engine/runs/switch2-ZUnUMZ`)

4. OunceCake will prompt you to pick a game. Pick one, then wait.

5. When OunceCake says `FTP server ready: ftp://<Switch 2 IP>:2121`, use an FTP client to connect to your Switch 2's local IP address with port 2121. A username and password is not required. (Make sure your FTP client has its transfer mode set to Binary/Image/TYPE I.)

## Tar Mode

OunceCake now has support for showing game data as .tar files instead of raw folders, allowing for faster downloading. Add `--tar` to the launch args.

## Licensing

OunceCake is licensed under the terms of the GPLv2 (because it borrows a tiny bit of code from [Atmosphere](https://github.com/Atmosphere-NX/Atmosphere))

You can find a copy of the license in the LICENSE file.
