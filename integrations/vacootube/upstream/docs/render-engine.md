# VacooTube rendering engines

VacooTube includes two complete BlitBun-based video renderers. Each has its own encoding, compression and transfer implementation inside the module. Neither requires the separate BlitBun module to be installed.

## Choose an engine

Double-tap **Minus → Render engine**, then select **Classic** or **Advanced**.

- **Classic**, the default, uses a WASM BC1 encoder, one frame prepared ahead, changed-block compression and persistent TCP transport.
- **Advanced** adds optional native BC1 encoding, a WASM fallback, compression workers and a prefetch/transfer pipeline.

Both share the same player, audio, touch controls, console-menu design and render-resolution preference. Performance depends on the host and network; compare them with the same content and resolution.

## Render pipeline

| Stage | Responsibility |
| --- | --- |
| Capture | Hidden Electron window, fresh paint requests, resize acknowledgement and bounded frame parsing |
| Resolution | Six block-aligned profiles from 1080p to 240p, defaulting to 720p |
| Encoding and compression | Module-owned BC1 encoders, changed-block packets and dictionary compression |
| Transport | Persistent connection, bounded acknowledgement waits and receiver recovery |
| Console display | Compatible receiver programs, shared BC1 shader fragments and the VacooTube menu |
| Input and audio | Touch coordinates follow the selected surface; application audio uses the private silent-sink path |

The dependency audit lists the exact local files and hashes in [render-dependencies.json](render-dependencies.json). Original source hashes and compatibility adaptations remain recorded in the [Classic provenance record](../server/streaming/run13/ORIGIN.json) and [Advanced provenance record](../server/streaming/run16/ORIGIN.json).

The platform supplies its public session RPC, audio/input services and shell composition. No runtime path points into a previous installation or another installed module.

## Live switching

Engine and resolution preferences are saved in the module's private `data/render-settings.json`. Existing saved selections remain compatible. Changing resolution preserves the engine; changing engine preserves the resolution.

Changes use a serialized queue: hide video, pause capture, stop encoding, drain receiver preparation, close and join the old transport, save the selection, then create the replacement transport and encoder. The player, touch sampler and audio remain open. Video returns only after a fresh frame is acknowledged. An incomplete shutdown prevents two writers from running at once.

A resolution change starts a new source epoch, discards responses at the old size and waits for Electron's resize acknowledgement before capturing a fresh frame. Stopped modules do not continue writing video.
