# BlitBun operations and troubleshooting

## First useful test

Connect IZ2S/IZlauncher, load the module, open BlitBun on Switch and select one moving application window from its PC controls. Begin at HD and keep other settings fixed. Check video, supported source audio, menu return and only then a resolution/route transition. A host-only benchmark is not a physical-console FPS measurement.

## The selector appears twice

Native window capture uses the module's selector. Browser capture uses the browser/OS permission selector. These are different paths. Two identical native lists on one request indicate a bug; record which button you pressed and the matching session log. Do not solve it by opening a second streaming session.

## Gray or black video

Inspect the selected source and actual output size first. Then inspect dock/handheld state and actual Ethernet/Wi-Fi route separately. A black transition gate waits for a suitable route and a complete new frame. Sound alone does not prove a video frame arrived. If the main native connection ended, restarting only the video listener cannot restore the console process.

## Performance

Keep source window size, movement, output size and capture mode consistent across measurements. Capture age, encoder/compression time, upload plus console acknowledgement and GPU decode are different costs. A gigabit cable does not establish application throughput. Try compression/render settings independently, keeping a known-good profile for comparison. Off can saturate a slower route; On can spend more time compressing.

## No sound or crackles

Check Share sound, application audio activity, `pactl`/`parec` availability and the console output selection. Check whether the source game mutes itself in the background. Avoid switching the entire system audio route as a substitute for verifying the owned application stream. Report relevant audio queue/drop counters and whether the PC source itself crackles.

## Controller and menu

Pair the physical controller with Switch. Install/select the Controllers module if the PC game needs a virtual controller; BlitBun alone can do video sharing without it. Nintendo/Xbox host profile and physical source are separate. Save progress before restarting a game for profile changes. Double Minus opens the shared overlay; Plus remains a game button.

## Update, backup and return

Use `install.sh --replace` only for an intentional update after stopping the affected session. The installer moves the previous module into the platform's `data/module-backups/blitbun/<timestamp>/` and preserves its preferences/runtime. To restore, stop the session and replace the current dedicated module folder with the saved one. Do not restore active `.versions/` memory or reuse a failed console process.

The installer never changes bootstrap saves. It does not silently restart the console, delete personal profiles or publish to GitHub. [Back to README](../README.md).
