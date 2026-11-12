# Third-party components and credits

## Moonlight-CivSwitch

- Project: https://github.com/XITRIX/Moonlight-CivSwitch
- Revision: `64cdae7f4a3f19202c7f8eaa0e5ac12ce3330d72`
- Credits: **XITRIX** (Moonlight-CivSwitch), **Gezine** (CivSwitch and the port's foundations), and upstream contributors. Their code remains attributed to its original authors, not THZoria.
- Required files: `native-io.js`, `native-texture.js`, `native-media.js`, and `tests/test-media-queues.cjs`.

The four source files are included **without modifications** under `vendor/moonlight/`, preserving their upstream paths. `tools/dependencies.py` pins their revision and SHA-256 hashes, which are checked by `tools/check_native_sources.py`. No download, full checkout, or submodule is needed to build the project. `tools/build_media_adapter.py` locally generates `vendor/moonlight-native-media-vod.js` with three VOD timing hooks. This generated derivative is ignored by Git, but its complete source and generator are included.

The [upstream notices](https://github.com/XITRIX/Moonlight-CivSwitch/blob/master/app/civapp-notices.js) are preserved in full in [`vendor/moonlight/app/civapp-notices.js`](vendor/moonlight/app/civapp-notices.js), from the same pinned revision. Their SHA-256 hash is also verified. They include licenses for Forge, Moonlight-Switch, Emscripten, ENet, mbedTLS, and moonlight-common-c. These complete components are not bundled with this client.

**Licensing scope:** these notices describe the licenses of the components they name. They do not explicitly declare a project-wide license for the four reused JavaScript files. Including those files in this private repository at THZoria's request does not relicense them or establish that Forge's license or a GPL automatically applies to all adapters. Preserve credits and notices, and confirm the scope of permission with XITRIX/Gezine before public redistribution. The compiled package remains a local build output and is not published.

## Jellyfin

The logo belongs to the Jellyfin contributors and is licensed under **CC BY-SA 4.0**. Its adapted PNG version, generator, and attribution are documented in [BRANDING.md](BRANDING.md). This client is independent and is not endorsed by Jellyfin.

## CivHomebrew

`tools/package_payload.py` comes from the standalone CivHomebrew packaging tool in THZoria's development project. It is kept standalone and unchanged to preserve the `.civapp` v1 format. Copies of the HTTP and DNS parsers are retained in `tests/runtime/` exclusively for host tests and are not bundled with the application. The keyboard, storage, SDK bridge, and runtime services used on the console are provided by CivHomebrew.

## Test fixtures

The two Matroska files in `tests/fixtures/` are synthetic FFmpeg test patterns. They contain no movie content, account data, or game files. They are used only for PC tests and are not included in the application.

The original client code is credited to **THZoria / SaoriYuki**. No additional project-wide license is applied here to third-party components.
