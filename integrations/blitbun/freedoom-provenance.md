# Freedoom game data

The `assets/` directory contains the unmodified `freedoom1.wad`, `COPYING.txt`, `CREDITS.txt`, and `CREDITS-MUSIC.txt` from the official Freedoom 0.13.0 release archive. Freedoom: Phase 1 supplies the levels, artwork, sound effects, and music for a free Doom-compatible game. It is game data, not a game engine or a copy of commercial Doom.

- Release: https://github.com/freedoom/freedoom/releases/tag/v0.13.0
- Archive: https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip
- Archive SHA-256: `3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59`
- Phase 1 IWAD SHA-256: `7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d`
- Independent upstream hash listing: https://freedoom.github.io/download.json
- License: BSD 3-Clause, reproduced verbatim in `assets/COPYING.txt`

The credits files and copyright/license notice must accompany any packaged copy of the WAD. `freedoom-assets.cjs` checks exact filenames, lengths, SHA-256 values, and the IWAD header before packaging. The source archive includes this directory and these notices.
