# Platform support

| Host | Status for this candidate |
| --- | --- |
| Linux x64 | Implemented; local installation/software checks recorded in the validation notes |
| Linux ARM64 | Declared target; complete physical ARM64 console/media testing is still required |
| Windows | Unsupported in this release; no Windows installer or complete host capture/audio/input integration |
| macOS | Unsupported in this release |

The web panel and some JavaScript/Electron components may run on other operating
systems. That alone does not establish support for the complete Switch workflow.
Building a desktop Electron app is separate from implementing console streaming.
WSL, Wine and containers are not qualified Windows configurations.

Use Linux x64 for the first public testing candidate. Do not advertise Windows
or macOS compatibility. ARM input-agent setup and host ARM64 support are separate:
a working ARM USB keyboard board does not qualify ARM64 media playback.

This document describes the current implementation, not an upstream library's
potential platform list. See each package's README for dependencies and actual
validation limits. No new hardware qualification is implied by packaging.

## VacooTube specifics

The runtime installer explicitly accepts Linux x64/ARM64 only. The console
player uses a PulseAudio-compatible owned silent sink, `pactl` and `parec`.
The supplied offline runtime is **Linux x64 only**. The source archive can
prepare a Linux ARM64 runtime, but ARM64 playback has not been physically
qualified. Retained Windows/macOS Electron builder targets are upstream desktop
metadata, not supported Switch-streaming builds.
