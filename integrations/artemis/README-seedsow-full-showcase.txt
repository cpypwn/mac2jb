Seedsow Lullaby full-game cpypwn showcase builder

This kit is not an installable save. The full game needs its own original v1003
save, and no full-game backup was available when this kit was prepared. Do not
restore a demo save to the full game.

After making a complete mac2jb SaveKit backup of Seedsow Lullaby full game
(title 0100ee5021c9e000), extract this kit and run:

  node scripts/build-seedsow-full-showcase.cjs "/path/to/full-game-backup" "/path/to/seedsowhax-full-cpypwn.zip"

The builder checks the SaveKit manifest and every backed-up file. It preserves
the original game's save data, patches the full-game autosave and slot 1, and
adds the Artemis v2 launcher with a rotating wireframe cpypwn showcase and the
HTTP server on port 8080. The output is a flat save ZIP for a compatible save
restore tool. The original backup is never changed.

The new visual effect and full-game installation still need a console test.
