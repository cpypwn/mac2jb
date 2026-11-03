# Asset pipeline: triage first, then decode

The end goal is Mario Kart World content in a form you can open: geometry,
skeleton, skin weights, materials and textures. The path to that is
dump -> triage -> decode -> glTF -> look at it. This page records where the
pipeline stands and what the formats actually are in dumped data.

MKW itself could not be dumped in this session (the console is asleep and cannot
be woken - see `docs/RESULTS.md`, 2026-10-28). The triage below therefore runs on
the Mario Kart 8 Deluxe dump already on this machine
(`~/MK8DX-full`, 18 GiB, base + update 1507328). It is the same container family
and it exercises exactly the parser the MKW work needs; the formats still have to
be re-triage on MKW's own romfs, because a Switch 2 title may ship a successor.

## What a dumped romfs contains

`python3 tools/asset-triage.py <romfs>` classifies by magic, not by extension, and
prints bytes/files/versions per container. On `MK8DX-full/base/romfs`:

| bytes | files | format | version word |
| --- | --- | --- | --- |
| 3,729,920,747 | 1,139 | Yaz0 (`.szs` archives) | - |
| 1,319,048,288 | 586 | BFRES | `0x00050003` (582), `0x00020000` (4) |
| 794,991,193 | 3 | `.mp4` (credits) | - |
| 616,201,568 | 169 | `.bfstm` audio streams | - |
| 312,177,076 | 737 | `.bars` (audio banks) | - |
| 151,611,200 | 648 | BNTX | `0x00040000` |
| 137,457,639 | 150 | SARC | - |
| 84,850,128 | 60 | `.ptcl` particle configs | - |
| 44,367,052 | 120 | `.byaml` | - |
| 11,464,744 | 97 | `.dat` (ghost data) | - |
| 4,819,576 | 132 | `.kcl` collision | - |

4,669 files, 6.9 GiB. The largest single group is compressed archives, so a dump
is not finished when the FTP mirror ends: `.szs` has to be unwrapped (Yaz0) before
its contents are visible, and those archives are where UI layout and some model
assets live.

## What the decoder has to implement

**BFRES** (`FRES`, 8-byte magic, version word at 0x08) is the container for
models, skeletons, materials and embedded textures. The blocks are tagged in
place (`FMDL`, `FMSK`, `FSKA`, `FMAT`, `FTEX`), which is what the triage relies
on and what a parser should use rather than trusting the offset table alone.
Per model, the work is:

- vertex buffers: interleaved attributes described by a per-attribute format
  table (position, normal, tangent, colour, up to 4 UV sets, bone indices/weights),
  each with its own stride and buffer index;
- index buffers and submeshes (a submesh binds a material and a shape);
- skeleton: bone hierarchy, world transforms, and the inverse bind matrices
  derived from them;
- skinning: 4-influence weights per vertex when the format carries them;
- materials: the render info / texture reference tables, which in MK8D-era files
  are a Nintendo-specific shader description - a glTF export can only carry an
  approximation (base colour texture + the scalar it actually uses), and that
  approximation should be labelled as such;
- embedded textures, plus external `BNTX` files referenced by name.

**BNTX** (`BNTX`, version word at 0x04) is a texture container: a dictionary of
textures, each with dimensions, mip count and a block-compressed format. Decoding
is where most of the format-specific work sits - BC1/BC3/BC4/BC5 are small
decoders, BC7 is substantially more work, and any ASTC/NUTEXB successor in a
Switch 2 title needs its own path.

**glTF 2.0** is the output: one node per bone, a skin whose joints are those
nodes, `POSITION`/`NORMAL`/`TEXCOORD_n`/`JOINTS_0`/`WEIGHTS_0` accessors, and
materials that reference decoded PNGs. That is the combination Blender imports
with skeleton and weights intact.

## Order of work

1. Triage the real dump (done here for MK8D, repeats for MKW).
2. Decode geometry + indices from one model, export glTF, confirm it opens.
3. Add skeleton + skin weights, confirm the rig is posed correctly.
4. Add materials and textures (BC1/BC3/BC4/BC5 first, BC7 next).
5. Only then look at redirects - and read `docs/MODLOADER.md` first, because
   that side is blocked at the signature/mod-loader layer, not at the decoder.
