# ns2jb by IZMYSH

## Everyday use

Use the panel for the full install/save/restart/launch workflow. The commands below are developer entry points, not a requirement to start another server by hand. The current saved program name is NS2I. Slot 0 is the default and can overwrite unsaved source; selecting another installation slot does not change the engine's source or launch ABI.

[Main README](../../README.md) · [Plain-English FAQ](../../FAQ.md)

This folder owns the standard bootstrap, standalone server and platform adapter. The server uses Node.js standard libraries only.

```text
bootstrap.bas       # unchanged console source
engine.json         # settings, source checksum and START ABI
manifest.json       # panel compatibility
adapter.cjs         # panel launch plan
transport.cjs       # qualified session interface
server/
  host.cjs          # standalone server without menu/apps
  install.cjs       # LIST/SAVE/LOAD recipe and source verification
  lib/              # TCP, native RPC, qualification and session bridge
protocol/           # historical receipt transport; not enabled by ordinary bootstrap
```

```sh
node server/host.cjs --help
node server/install.cjs --slot 1
node server/host.cjs 192.168.1.10
```

`install.cjs` prints a recipe; it does not send keyboard commands. Choose an empty slot 0–3: for example `LIST 2:1`, exact source entry, then `SAVE "TXT:NS2I",2`. After saving and a full console restart, load NS2I, RUN, perform REMOVE once and use the server's fresh nine-argument START. Do not reuse an old command. Changing slots does not change the source.

The server does not start input, a shell, rendering, streaming or games. Original starts only the server; the platform attaches IZlauncher through its public contract. The hardware input adapter enters commands separately.

Bootstrap: 229 lines; SHA-256 `2261f65fb9ec0ed708ce0f0b6da5057168f706e541d956f658a3c2655e9e8c36`. Automatic native-session recovery is unsupported. Standalone logs use this folder's `data/sessions/`; the panel supplies its own storage. Provenance and licensing remain in the platform's THIRD_PARTY.json and LICENSE.

The canonical RPC client is `server/lib/rpc.cjs`. Session setup copies it into the session's `shared/` directory, next to generated connection metadata. Old `core/native` paths are compatibility imports only. Historical receipt protocol code is retained here for diagnostics and never installs or selects another bootstrap.
