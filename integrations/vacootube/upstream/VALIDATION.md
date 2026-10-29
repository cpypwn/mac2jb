# Local preparation checks

Prepared as a separate VacooTube repository with module ID `vacootube`. This record covers local software checks, not a new physical-console qualification.

- Source syntax and declared module/console assets checked against IZ2S API 1.
- Installed into an isolated clean IZ2S release copy; module/package checks passed.
- Accidental replacement without --replace refused. Intentional update retained private preferences and pinned snapshots; the previous module was backed up.
- Generated IZM inventory checked for exclusion of runtime binaries, npm dependency trees and private profiles.
- Branded console and application icons exported with real alpha. Existing codec, receiver ABI and controller gesture IDs are retained.
- Local offscreen fixture produced a fresh frame with hidden/offscreen flags, trusted touch events and nonzero application audio through a temporary silent sink.
- Application config, microphone-permission and managed-update tests passed.
- No YouTube sign-in, account-history operation or console keyboard commands were performed by these checks.

A new Switch session is required to validate the new loaded module version and icon in the real launcher. Linux ARM64 and Windows/macOS streaming are not implied by the local Linux x64 checks.

## Named, independent module release — 1.3.1

- Physical module directory and API identity migrated with the real installer; private data/runtime preserved and previous installation backed up.
- The module installs on its own, in either installation order with the other media module, with no dependency on that other module.
- Shared console-shell contributions compile independently and together.
- Targeted platform/module and exclusive-stream ownership checks passed (30 cases).
- The private isolated Linux fixture masked the other media module: VacooTube’s own Electron/media bridge produced a hidden frame, trusted touch events and nonzero audio. The normal online fork application entry point was not exercised by this local fixture.
- A new physical Switch/gameplay/FPS validation was not performed as part of this packaging change.

## Earlier compatible frame pacing — 1.3.2

The BC1 JavaScript codec and WASM binary were compared byte-for-byte with the earlier source snapshot and match. The original scheduler, ACK-based capture pacing and WASM encoder worker were ported with module-local paths and a current-route readiness barrier. Six original bounded-queue/slow-ACK/profile-change/failure/close/recovery tests pass. The current decoder/wire ABI remains unchanged. Online video smoothness and physical-console FPS need the same-source comparison after reloading the module; a scheduler port is not proof of the reported stutter’s cause.

## Complete Classic render engine — 1.4.0

- Copied the Classic scheduler, WASM BC1 encoder, delta compression worker, transport, receiver programs and their own ABI/client/frame-builder dependencies. Original hashes are recorded. The current audio, capture integration and menu design are retained.
- The active render dependency graph is entirely module-local apart from Node.js builtins and the injected platform session interface; see docs/render-dependencies.json. Removed the remaining direct Controllers-module import from native touch input.
- All 24 original renderer/codec/compression/native-model tests passed, plus five current capture/recovery tests and three new resolution/touch/parser tests.
- Console shaders compiled with VacooTube alone, with BlitBun and with the GTA module, without conflicting shared shader fragments.
- An isolated Electron/WASM fixture, with BlitBun hidden and networking disabled, rendered and encoded 720p, 1080p, 240p, 480p, 360p and 540p, then returned to 720p without an application restart. Trusted touch and nonzero audio remained available.
- The local media fixture bypasses normal online playback and does not qualify physical-console FPS, the new menu gesture on hardware or long dock transitions. A new console session is needed to load the new module/shell contribution.

### Second renderer and overlay selection

- Bundled the complete Advanced render dependency closure beside the Classic implementation. Original hashes and the source commit are recorded in `server/streaming/run16/ORIGIN.json`; no BlitBun module files were modified.
- Six focused lifecycle/settings/resolution/input tests passed. The lifecycle test verifies that failed receiver shutdown prevents a new transport from starting and that preparation and pending upload tasks are joined.
- The updated compute/fragment overlay shaders compiled successfully.
- An isolated, offline Electron fixture switched Classic → Advanced → Classic using the real application-host replacement path and actual BC1 encoders. It produced 720p frames with both engines, resized Advanced to 480p and preserved 480p on the return to Classic. The player, trusted-touch path and nonzero source audio stayed available; the audio sink was not closed during switching. A mock acknowledged transport replaced the physical Switch receiver, so this does not certify an actual console thread join or hardware FPS.
- The combined dependency audit covers 49 module-local files plus the declared public IZ2S core APIs; no installed module dependency is introduced.
