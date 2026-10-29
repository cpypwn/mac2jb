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

## BlitBun specifics

The current host capture/audio/input implementations use X11/XWayland, FFmpeg,
PulseAudio-compatible audio tools and Linux virtual-input facilities. Browser
sharing does not replace every host backend. Windows streaming is unsupported.
