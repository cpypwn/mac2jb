# IZ2S Platform SDK · API 1

## Who needs this guide?

Ordinary users should start with the main README and FAQ. This is the developer reference for module/engine/shell/hardware contracts. Source repositories include development helpers; the minimal runtime keeps only the required subset. A tool described here may therefore require the experimental source project. Packaged checks validate files and contracts; they are not proof of physical-console compatibility.

[Main README](../README.md) · [Plain-English FAQ](../FAQ.md)

Format/API versions are independent of release `0.16.0-rc.3`. JSON schemas live in `schemas/`. Descriptors declare format, apiVersion 1, folder ID, name, semver version and explicit platforms (`linux-x64`, `linux-arm64`; Windows/macOS are reserved). Component paths must be relative, without `..`, absolute paths or backslashes.

## IZM 1

IZM is a normal ZIP using stored/deflate. Encryption, ZIP64, split archives, links and special files are unsupported. Limits: 256 MiB archive, 512 MiB expanded, 128 MiB per file, 4096 files, 64 KiB module metadata. Large runtimes and games should be external dependencies.

Required files: module.json, checksums.json, README.md, LICENSE. Checksums use `{"algorithm":"sha256","files":{"module.json":"...","switch/app.json":"..."}}`. Every file except checksums.json must be listed exactly once. Duplicate or mismatched inventories are rejected. Hashes establish integrity, not publisher identity.

Declare required host resources, workers and helper scripts in `server.assets`, using paths relative to the module root. Packing rejects absent resources or implementation files. Launch and installation also verify extracted module bytes and module dependencies before sending device commands. The SDK checks literal runtime asset paths in packaged source without executing the module.

```json
{
  "format": "izlauncher.module",
  "formatVersion": 1,
  "apiVersion": 1,
  "id": "example",
  "name": "Example",
  "version": "1.0.0",
  "author": "Author",
  "platforms": ["linux-x64", "linux-arm64"],
  "requires": {"platformApi": 1, "shell": "izlauncher", "consoleAbi": 1},
  "switch": {"entry": "switch/app.json", "files": ["switch/app.json", "switch/icon.png"], "abi": 1},
  "server": {"runtime": "node", "entry": "server/entry.cjs"},
  "dependencies": [],
  "settingsSchema": [],
  "license": "MIT"
}
```

At least one of switch/server is required. Only the exact switch.files inventory is sent to the console. Console apps use the existing `hblauncher.gpu-app`, ABI 1. GLSL/SPIR-V runs GPU logic; IZM does not provide an NRO loader or arbitrary console CPU execution.

Standalone GPU apps have no builtin field and require no core change. Migrated shell apps can declare shellContribution with files, defines, scene and optional memoryBytes. Scenes 2–7 are the current shell ABI; use a standalone GPU app for an independent interface rather than adding numeric builtins.

## Server lifecycle and components

A server entry exports `async createModule(context)` returning init/start/stop/dispose. Context contains root, dataDirectory, optional session and services API. Persist private data in dataDirectory. Stop must be idempotent. External interpreters/programs must be declared dependencies; discovery does not run install scripts.

Host services run in child processes. A stop timeout terminates the owned process after five seconds. This is not an OS sandbox or a Node privilege boundary. Never report a console operation as completed without confirmation or blindly repeat an RPC with an uncertain result.

Minimal public SDK: `sdk/platform.cjs` (apiVersion, dataDirectory(root,id), openSession(session)). Native sessions serialize bridge RPC. Use session-owned buffers and qualified functions; see [native](docs/native.md) and [services](docs/services.md).

`provides` maps capabilities to server components. Supplied providers include stream-host, calculator-state and controller-profile. Duplicate active providers are rejected. Components resolve as `module:blitbun/stream`, not sibling source paths. Streaming owns its codec, transport, capture, audio and dynamic ports; the core owns shared system APIs.

A standalone console app may declare `hostRuntime: "module:<module-id>/<component>"`. Its module must list the component under server.implementations. The component exports create({rpc,mapped,directory,app}) and supplies afterBatch()/close(). It may also expose pending(state), returning a boolean or Promise<boolean>, to request a render boundary for its own mailbox even when no application switch was requested. pending must only inspect bounded request/state data; afterBatch performs shared-state writes once the graphics worker has joined. The runtime passes the current control snapshot to these hooks. It starts with that app and closes on exit. File Exchange uses this contract for live storage without application-name conditions in the core.

An installed built-in shell contribution may also declare `hostRuntime`. Its initializer runs only while that contribution is present in the console catalog; optional `reset()` restores its data after another app returns to the menu. A failed initializer rejects that catalog item without terminating the shell. Uninstalled modules do not initialize merely because their packages exist in the PC library.

## Local host runtimes and native helpers

A module can declare `server.localPackages` with `id`, `path`, `entry` and
`installer`, all module-relative paths. Optional `requiredFiles` maps each host
platform, such as `linux-x64`, to module-relative runtime filenames. The panel
checks those files without executing module code; they must resolve inside the
module folder. `runtime/installed.json` alone does not establish readiness.
Declare the complete required inventory for every supported runtime platform.

With `importSource: true`, installation requires an absolute local source
folder. The panel exposes the folder field and passes it as `--source` to the
installer; this is separate from a download installer. The installer owns source
validation, architecture checks and selective copying. It must not infer
permission to move saves or credentials. Downloaded/imported applications and
private build outputs belong under `modules/<id>/runtime/`, are excluded from
IZM/source releases, and remain alongside their owning module. The portable IZM
contains the adapter and installer, not automatically all external game assets.

Module dependencies declare `{"kind":"module","id":"blitbun","version":">=1.7.0"}`.
`version` is a minimum supported version; a bare `1.7.0` has the same minimum
meaning. The platform supports this numeric/prerelease comparison and optional
`>=` prefix, not arbitrary npm ranges, `^`, `~` or wildcards. Missing or older
dependencies reject activation before their code or console commands run.
Declare a minimum that actually includes every public component being used.

A local native helper has `build.json` format `izlauncher.native-build`, version
1, with `sources`, optional `dependencies`, compiler `args`, optional `pkgConfig`
and an output filename. `sources` are compilation units; `dependencies` are
headers or included fragments that affect the cache but must not be compiled a
second time. All paths are relative to the recipe directory. The current builder
targets Linux and uses `CC` or `cc`; individual recipes may additionally need
Node N-API headers, SDL2 or libdeflate development files and `pkg-config`.
Missing optional accelerators must retain their documented software fallback;
a mandatory helper must report the missing build requirement clearly.

The recipe, architecture, sources and declared include dependencies determine
the build digest. Callers receive the immutable path
`modules/<id>/runtime/bin/<digest>/<output>`. Use that returned path for loading
or process launch. The convenience alias `runtime/bin/<output>` can change when
another version builds and is not a safe runtime identity. Existing processes
retain their original binary; helpers are never uploaded as arbitrary console
CPU programs.

## Engine

engine.json declares entry, modes (original, optionally izlauncher), capabilities, requirements, consolePort, settingsSchema and defaultSettings. Shell-compatible engines additionally declare transport. Bootstrap metadata owns file, sha256, installSlot, saveName and arity. The source belongs to the engine; SHA is for the host source, not a console readback.

The adapter provides plan(settings,options) and createEngine(context) with prepare/start/stop. Plans describe command, args, cwd, env, bootstrap, runRoot and lifecycle. Prepare returns a plan without keyboard input. Start calls context.launch(plan); stop calls context.stop(). The panel retains process ownership and console-state acknowledgements.

Transport exports create({host,port,settings}): command (real START), bootstrap, protocol, resumable, listen(), native(connected), qualify(native). Adapters normalize differing upstream interfaces without replacing upstream source.

After creating fresh connect.txt, a launcher publishes `Run folder: <absolute directory>`; after qualification it publishes `Qualified native session ready for graphics inspection.`. The platform translates these engine events. Do not build START from hardcoded panel numbers.

Before launch, extension/bootstrap source is pinned under data/extensions/<fingerprint>/. Replacing the catalog folder does not mutate an active process; the next activation uses the new version.

## Shell

shell.json declares entry, consoleAbi and requirements. Original is an engine mode, never a shell descriptor.

Entry exports compatible(engine) and async create(context). The result has init/start/stop/dispose and a done Promise. Context contains root, qualified session (directory,connection) and launchStage. IZlauncher owns runShellRuntime; new shells implement their renderer through the native bridge. Shell failure closes its processes/session without repeating bootstrap.

## Hardware modules

Device: `hardware/devices/<id>/device.json` with format izlauncher.device, apiVersion 1, roles, capabilities, fields and transport. Ready configuration: `hardware/configurations/<id>/profile.json` with nodes, role assignments, links, optional ui, order and selectable. PC + ARM PC is first/default; two experimental presets are currently unselectable.

Exactly one server, input and console role must exist; server/input may share a node. Discovery parses metadata without executing adapters. A custom device transport.entry is relative to that device folder and is loaded on activation. Configuration entry exports createInputLink(options) and createChecks(options). Input provides inspect(), performPlan({id,steps,sourceFile?,sourceAfter?},onEvent), halt(id).

Steps: `{type:"line",text,delayMs}`, `{type:"key",key,delayMs}`, `{type:"sleep",ms}`. Source is a bounded ASCII file in the release. LIST selects the slot before typing. SAVE and launch remain separate actions. Uncertain input is not automatically retried. Cancellation releases keys and records the cancelled UUID. See [hardware guide](../hardware/README.md).

## Local discovery

ARM service: hardware/agents/arm-input/discovery.py. The deployable package, installer and checksum inventory are owned by hardware/agents/arm-input/; build it with node sdk/pack-agent.cjs. Run it directly with Python or install it through the trusted SSH input adapter, which also installs a systemd service. LAN UDP 39418 must be reachable. Discovery provides no HID access and does not replace SSH authentication.

Client JSON (up to 512 bytes), broadcast or 239.255.77.14:39418, TTL 1:

```json
{"protocol":"izlauncher.discovery","version":1,"kind":"discover","nonce":"<32 hex>"}
```

Response (up to 4096 bytes) to sender address/temporary port:

```json
{"protocol":"izlauncher.discovery","version":1,"kind":"input","nonce":"<same nonce>","id":"<32 hex>","name":"ARM PC","architecture":"aarch64","capabilities":["usb-keyboard"],"interfaces":[{"address":"192.168.1.20","mode":"lan"}]}
```

The client uses the UDP source address, checks protocol/version/nonce/local subnet/usb-keyboard and groups interfaces by ID. An ID is not an authenticated signature. SSH host-key trust is still required. Multiple devices require selection; the platform does not choose randomly. Manual addresses override discovery. The console initiates its connection using START; no discovery responder is assumed in fresh Direct.

## Tools and acceptance

- `node sdk/pack.cjs [module-folder [output.izm]]`: package one or all modules.
- `node sdk/check.cjs [release-root]`: validate installed catalog.
- `node sdk/validate.cjs descriptor.json|file.izm`: validate one extension.
- `node sdk/create-extension.cjs engine|shell|module id destination`: create a template.
- `node sdk/create-gpu-module.cjs id destination`: build a standalone GPU example.
- `node sdk/import-legacy.cjs input.izs output.izm --key original.key`: import with the original key, without distributing it.
- `node sdk/audit-layout.cjs`: audit ownership and static imports.
- `node sdk/release.cjs`: create a clean source archive and IZM packages.

Engine/shell templates are interface examples, not working new exploits. Tests cover discovery without execution, pinned versions, portable packages, worker cleanup, corrupt archives and exact installation commands. Physical checks require a separately confirmed fresh console session.

### Module-requested return

A host runtime's afterBatch(state) may return
`{ returnToMenu: true, error }` to request a launcher return after a fatal
module error. The core services this result at the paused render boundary,
awaits close(), and only then restores the menu. close() must stop and join all
native writers before resolving. If cleanup rejects, the core propagates the
failure and retains active resources; it must not restore menu memory over a
running worker. Modules must not write a competing menu into shared storage.

### Read-only streaming reports

`node sdk/tools/monitor-stream.cjs 900000` records saved session state without
console commands. To summarize a recording, run
`node sdk/tools/analyze-stream.cjs data/monitoring/<recording>.jsonl`.
The report groups source, resolution, physical mode and network independently,
excludes paused/black video and duplicate publications, and reports distributions
and counter-based average FPS where available. Polling samples cannot prove a
minimum FPS for every frame. Upload timings include console work; a fast link
does not eliminate host compression or the GPU acknowledgement deadline.

For a fresh diagnostic server run, set `IZ12_STREAM_PROFILE=1` before starting
the platform. This adds bounded native timing stamps to ACKs, with startup
counter calibration and no per-frame RPC. Leave it unset for ordinary runs.
The stream report exposes `transferAckMs` and nested `decodeTimings` separately
from host compression. Receive time includes time spent waiting for the host;
GPU wait includes native polling and excludes physical display scanout.

### Frame publication and wire preview

The streaming module exports `frameAvailability`. `create(readState)` returns
`waitFrame({afterSequence,sourceEpoch,signal})`, `notify()` and `close()`.
Only one consumer can wait; it receives the latest frame, with no queue. Abort
rejects with AbortError; epoch changes and close resolve null. Producers notify
publication, visibility/epoch changes and capture errors. Callers retain a
bounded visible-source stall watchdog and cancel waits before shutdown.

The optional native wire preview exposes commitPrepared(token,metrics),
isWireCommitted(token), hasWireCommitted() and wirePrefetchReady(). A committed
token is irreversible until consumed or its socket epoch is closed and the
native receiver joined/reset. Do not discard/re-encode it as a stale candidate.
The ordinary public upload API remains single-consumer; only the native wire
helper can own the current packet and one future packet. No third packet is
allowed. `IZ2S_WIRE_PREFETCH` is an experimental launch flag, not a declaration
that the hardware target FPS has been achieved.

### Streaming mailbox additions

The shared stream header remains at control-buffer byte `0x700c80`; the
ordinary input ACK remains 396 bytes. ACK byte 332 carries header word 24
(options flags), and byte 336 carries word 25 (menu state). Low 16 flag bits
remain host options. Streaming gesture classification uses bit 31 as an
authoritative marker, bit 30 for a pending Minus, bit 29 for a held classified
single Minus, and bits 16–23 as a wrapping single-press sequence. Sampled HID
masks must never be overwritten to implement menu gestures.

Offsets below are relative to the stream header and are shell/module-owned:

| Offset | Owner / meaning |
| --- | --- |
| 180, 184, 188 | Streaming input: first low tick, phase/origin, single sequence |
| 204 | Streaming input: first high tick |
| 208–239 | Experimental decoder: GPU-observed codec header |
| 240–247 | Shell: qualified 64-bit counter before each render |
| 248–251 | Shell: verified counter frequency, 31,250,000 Hz |
| 252–255 | Route gate: 0 ready, 1 waiting Ethernet, 2 waiting Wi-Fi, 3 unknown/stale |

A single Minus becomes game Back/Select after 250 ms; a second press within
that interval toggles the streaming overlay without forwarding either press.
The full counter handles wrap and long HOME pauses. The upgraded shell supplies
the clock using existing qualified native calls, with no per-frame host RPC.
Non-stream application menus retain their own single-Minus behavior.

## Production implementation ownership

SDK host/native CommonJS entries are compatibility forwards. Canonical runtime
implementations live in `core/console/host/` and `core/console/native/`; qualified
function tables/signatures and the call-frame builder live in `core/console/abi/`.
SDK schemas, public helpers, templates, compiler tools and fixtures stay here.
Application-specific tools belong to their modules, such as HL2's
`server/configure-profile.py` and `server/profile/` templates.

Optional `server.systemDependencies` is an array of descriptive records with
`command`, `purpose`, `optional` and host `platforms`. It does not run an installer
and does not replace native build recipes or module dependencies. Package checks
also require development source and published IZM contents to match, and ensure
`module:<id>/<component>` targets name declared module dependencies/providers.

## Module directories and independent streaming engines

A descriptor may set `installationDirectory` (for example `BlitBun`) independently of its stable API `id` (`blitbun`). Use `core/module-paths.cjs` or the SDK data-directory helper to locate installed files; do not construct a physical path from the API id. Paths in `server.implementations` remain logical `modules/<id>/server/...` references resolved by the adapter. The SDK advertises `moduleDirectories: true`. Module folders must contain their matching descriptor or one valid IZM; duplicates are rejected.

Independent modules may declare `server.activation.exclusiveGroup`, such as `video-stream`, together with distinct initial activation values. Session hooks suspend/join the previous owner before handing over the shared console resource. Subsequent controls reach only the active owner. BlitBun and VacooTube use this contract and declare no dependency on each other; VacooTube embeds its own copy of the BlitBun streaming engine.

## Compatible module shell formats

A console shell may declare `moduleShells`, a bounded list of existing shell/module-format IDs it implements. IZPSlauncher declares `izlauncher` for ABI-1 compatibility. Package discovery uses the selected shell descriptor; declaring a compatible format does not bypass host-platform or console-ABI validation. Existing module manifests can keep `requires.shell: "izlauncher"`.
