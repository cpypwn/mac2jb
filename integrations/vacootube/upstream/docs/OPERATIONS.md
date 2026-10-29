# VacooTube installation and troubleshooting

## Installation order

Install IZ2S Platform, then VacooTube. Load VacooTube in the console catalog. Its ID is vacootube and its complete installation lives in modules/VacooTube/. The BlitBun engine is bundled; the separate blitbun module is not required. The File Exchange-only base release does not include VacooTube automatically.

## What “all files” means

The repository contains the complete fork/integration source, console files and installers. A ready architecture-labelled offline release additionally contains Electron and prepared production npm dependencies under runtime/. Git and IZM intentionally do not contain those bulky mutable dependencies. Neither form includes your account/profile. IZ2S and a working engine session are external requirements, not duplicated inside this project.

## Runtime preparation fails

Read the installer error. A source install needs npm, Python, internet access and official Electron checksums. Windows/macOS host streaming is not implemented here. Do not solve Linux sandbox errors by disabling Chromium's sandbox; use the host's supported Electron/user-namespace setup. Installation does not change system sandbox permissions or setuid helpers.

A matching prepared source snapshot is identified by its digest. Editing app source, assets or its lockfile requires preparing it again. A lock refuses concurrent dependency preparation. Failed preparation is kept out of the ready snapshot.

## The player opens, but not on the desktop

That is intentional in managed streaming mode. The owned app renders offscreen and ignores its own show/focus calls. Its image should appear on Switch after a fresh frame. Installing the module alone does not launch that player. Open its console tile in a live session.

## No sound on Switch

Confirm `pactl` and `parec` work, the app has an owned silent sink and the console's selected audio output is usable. The private sink is intentionally silent on the PC. Sound is not taken from the entire desktop or microphone. Do not replace the system default device to hide a module-specific routing error.

## Touch/navigation problems

Use the module's supported touch/controller path. Do not pair the physical controller with the PC just for this player. Touch dispatch and capture operate independently; report an exact gesture and the corresponding log if response is late. YouTube's own loading/network behavior can also affect the page.

## History and profiles

Private browser data is in the installed module's data/profile/. It is preserved across runs and updates. Clearing local data and deleting server-side account history are different actions. No maintenance tool here automatically sends an account-history deletion request. Close the owned player before any profile maintenance or backup.

## Returning from HOME / route changes

Capture can pause/resume while the main native console session remains valid. If the main session ended or native cleanup cannot safely join a worker, use the platform's fresh restart/launch instructions. An offline player runtime does not add a reconnecting bootstrap.

## Update/rollback

Stop the affected session and use install.sh --replace for a deliberate update. The previous module stays under platform data/module-backups/vacootube/<timestamp>/. --with-runtime deliberately supplies a matching architecture runtime; without it an existing runtime is preserved and may need re-preparation for new source. Restore a dedicated backup folder only after stopping the session; do not copy private account data into Git.

[Back to README](../README.md).
