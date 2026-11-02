# Nora Lua entry diagnostic

The supplied `010012900d38a000` export belongs to **Nora to Oujo to Noraneko Heart 2 (trial)**. It is an Artemis `BOWS` v1002 save with an outer `system/save.asb` frame, one nested `system/script.asb` frame, and a pending `calllua clickEnd` command.

The first proof retargeted the nested frame. Loading it returned to the save menu and left input unresponsive. The second proof retargeted the outer frame and removed the nested frame from the active stack; loading it crashed the game. Both saves were verified on the console, but neither proved that its Lua function ran. Do not retry either proof.

The v3 diagnostic starts from the verified, original pre-probe export. It retargets the outer frame, empties the active nested stack, and changes the outer frame's state field from 1 to 0. The [Seedsow editor builder](https://github.com/DialingSpoon527/seedsow-lua-editor/blob/main/editor/build.py) requires that state field to be 0 for its launcher. This is a reason to test the change, not evidence that Nora accepts the same state. Its ASB contains one Lua function that requests a simple dialog titled `cpypwn`. It does not use custom graphics, event handlers, or file writes.

This is **an unverified console experiment**, not a working Nora Lua editor. A game crash is still possible. Restore the original export if the test fails.

## Build and verify

Use the verified pre-probe SaveKit export, not a save from either failed proof:

```sh
python3 integrations/luna-editor/build.py \
  --backup '/path/to/the/original/010012900d38a000-save-folder' \
  --thumbnail '/path/to/256x144-rgb/save0001.png' \
  --output '/path/outside/the/repository/Nora-Lua-Diagnostic-v3'
node '/path/outside/the/repository/Nora-Lua-Diagnostic-v3/write-proof.cjs' --check
```

The thumbnail is optional. The builder verifies every original file against its SaveKit manifest and rejects the two failed slot states. It refuses to overwrite an existing output directory. The package contains:

- `original/`: the verified original save and manifest for rollback
- `stage/`: the patched slot, ASB, optional thumbnail, and a staged-write manifest
- `write-files/`: exactly the files to select in SaveKit's **Write save files** action
- `verification.json`: source and output hashes plus the before/after frame state
- `write-proof.cjs`: a local verifier and guarded SaveKit writer

Keep the package private because `original/` contains your save data. Before testing, close Nora and take a fresh SaveKit export. The package's guarded writer accepts only a fresh backup whose slot and thumbnail hashes match its original input.

## Interpreting the test

If a `cpypwn` dialog appears after loading the modified slot, Nora reached the test Lua function. That would establish only the entry path; editor APIs and save metadata still need separate checks. If the game returns to the save menu, hangs, or crashes, stop and export the save read-only before another attempt.

The old v2 export contains both failed scripts and remains useful as diagnostic evidence. The original pre-probe export is the rollback source. SaveKit's restore merges files and may leave unreferenced proof ASBs, but its original slot will no longer point at them.

Nora's ROMFS `system/save.asb` and `system/script.asb` have not been obtained locally. Inspecting them read-only would help explain the call-stack behavior before porting the full Seedsow editor.
