# VacooTube 1.4.1

- Give the render engines clear names: Classic and Advanced.
- Update the console overlay, status labels and rendering guide consistently.
- Preserve existing engine selections, default resolution and streaming behavior.

# VacooTube 1.4.0

First public VacooTube module release for NS2 and IZ2S Platform.

- Independent installation under `modules/VacooTube/`; the required BlitBun streaming implementation is bundled.
- Complete fork application source, controller/touch integration and a silent PC audio path.
- Classic and Advanced render engines, selectable from the hidden double-Minus console menu.
- Live render resolutions from 1080p to 240p, defaulting to 720p; source-video quality separately defaults to 480p.
- Linux x64 offline archive with Electron and prepared production dependencies; a smaller source archive is also available.
- Real local application screenshots and direct links to this repository and its releases.

Requires IZ2S Platform 0.16.0-rc.3 or newer and a working console session. Linux ARM64 is a declared source-install target with incomplete physical validation. Windows and macOS console streaming are unsupported. Local application startup, input/capture, packaging and installation checks do not establish physical-console performance guarantees.

The application is a fork of VacuumTube. Original MIT notices and component licenses are retained; independently authored IZMYSH integration uses GPL-2.0-or-later. See COPYRIGHT, LICENSE-SCOPE.md and THIRD_PARTY.json.
