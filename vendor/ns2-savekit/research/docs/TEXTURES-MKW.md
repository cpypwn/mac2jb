# MKW textures: `Ounce` containers

`Tex/*.bntx.zs` in `~/mkw-full` are BNTX files with one difference from the
documented format: the texture container at 0x20 has magic **`Ounc`** instead of
`NX  `. Everything else follows the BNTX layout
([epd-libraries/bntxlibrary](https://github.com/epd-libraries/bntxlibrary/blob/aa4ddded283a796bf0a804d83a02d684bd01a629/docs/Structure.md)),
so the metadata is fully readable:

| offset | field |
| --- | --- |
| 0x20 | container magic, count, info array, data, dictionary, pools |
| BRTI+0x10 | flags, storage dimension, tile mode, swizzle |
| BRTI+0x16 | mip count |
| BRTI+0x1C | texture format |
| BRTI+0x24/0x28/0x2C/0x30 | width, height, depth, layers |
| BRTI+0x50/0x54 | texture size, alignment |
| BRTI+0x60 | name (pascal string in the `_STR` table) |

`tools/bntx_ounce.py` prints this for one file or an inventory of a directory:

```
CmnTex_Stage_SFCMarioCircuit_MarioBody_Alb   813x813  mips 10 fmt 0x00003406 size  241664 (0.37 B/px)
Shadow_Game03_X031_Z123_Shadow               512x512  mips 10 fmt 0x00000a01 size  701440 (2.68 B/px)
BakeEmpty_Bake                              8192x8192 mips 14 fmt 0x00003406 size 22372352 (0.33 B/px)
```

## The payload is a native GPU image

The names end in `.Ounce64`, and `Ounce` is the **platform codename**, not a
codec: the game's `sdk` module carries symbols `nn::wsi::ounce::native::NativeWindow`,
`nn::gpu::sdk::GpuOunceUserImageDescriptor`, `GpuOunceImagePixelFormat`,
`GpuOunceImageBlockFormat`, `MakeRgbaBlockImagePreference`, and `main` contains the
build path `D:\home\Project\Drive\App\Rom\Ounce64\Product_CSPGO_Optimize\code2\...`.

So the data is in whatever block-compressed format the GPU natively takes, and the
`BRTI` format ids (`0x3406`, `0x1f0a`, `0x3401`, `0xa01`) are `nn::gfx` image
formats for that generation. Sizes are consistent with that reading: the 8192² and
813² albedos sit at ~0.27-0.3 B/px for the base level (≈2 bpp, i.e. an 8×8 block
format), while the 512² shadow is ~2.67 B/px including mips, i.e. plain 16-bit.

Two things are missing before pixels come out: the block layout behind those four
format ids, and the surface tiling (the `swizzle`/`tile mode` fields are 0 here, so
at least some of these are linear).

The concrete next step is to identify the format ids — the mangled
`GpuOunceImageBlockFormat`/`GpuOunceImagePixelFormat` names are in `sdk`, so the
enumerator values are recoverable, and the block size can be confirmed against the
declared texture size (blocks × block bytes × mip factor must equal `BRTI+0x50`).

## The format ids are ordinary `nn::gfx::ImageFormat` values (solved)

The EPD wiki's [Common nn::gfx](https://epd.zeldamods.org/wiki/Common_nn::gfx) page
gives the rule: `ImageFormat = (ChannelFormat << 8) | TypeFormat`, with
`ChannelFormat` ASTC_8x8 = 0x34, BC6H = 0x1f, R16 = 0x0a, and `TypeFormat`
Unorm = 0x1, SRGB = 0x6, UFloat = 0x0a. Every id we saw decodes exactly:

| BRTI format | channel | type | meaning |
| --- | --- | --- | --- |
| `0x3406` | 0x34 ASTC_8x8 | 0x06 SRGB | ASTC 8×8 sRGB — every albedo |
| `0x3401` | 0x34 ASTC_8x8 | 0x01 Unorm | ASTC 8×8 linear |
| `0x1f0a` | 0x1f BC6H | 0x0a UFloat | BC6H UF16 (HDR bake) |
| `0x0a01` | 0x0a R16 | 0x01 Unorm | plain 16-bit (shadow maps) |

So `Ounce` was never a proprietary codec: these are standard **ASTC 8×8** and
**BC6H** textures. `texture2ddecoder` decodes them (`decode_astc`), and the
declared sizes agree — mip0 of the 813×813 Mario albedo is 169 tiles of 8×8
blocks, i.e. a 13×13 block-tile grid over a padded 832×832 surface.

## What is still wrong: the surface tiling

The `BRTI+0x2A0` mip pointer array gives exact per-mip file offsets (mip0 0x400,
mip1 0x2A800, …), so the data region and mip boundaries are not in doubt. But
decoding mip0 in plain raster order gives horizontal bands, and none of the four
tile/block traversal orders (tile-x-first vs tile-y-first × block-x-first vs
block-y-first) produces an image — all four look like scrambled blocks with
visible 64-pixel seams.

`tile mode = 0` is `nn::gfx::TileMode::Optimal`, so the surface is stored in the
GPU's optimal (swizzled) layout, and that permutation is what is missing. Every
sampled texture in `Tex/` is mode 0 (120/120), so there is no linear example to
compare against.

Two ways to get the permutation:

1. Solve it empirically against a texture with known content (a flat or gradient
   bake), which gives a simple target to fit.
2. Recover it from the driver: `nn::gs::sdk::CalculateNativeImageLayout`
   (0x71003dfbe0 in `sdk`) computes the layout from a format descriptor, and the
   swizzle constants can be read out of it.

## The tiling: block-linear, but not the Switch 1 permutation

The layout is Tegra-style **block linear**: GOBs of 64 bytes × 8 rows, each GOB
holding 4 × 8 + 16-byte ASTC blocks (a 32 × 64 pixel tile). For the 813×813
albedo, mip0 is exactly 26 × 13 GOBs × 512 B = 173,056 B, which matches the byte
range between the mip pointers, so the GOB grid and the block height/depth
(`1 << 0`) are certain.

The GOB placement is right: deswizzling with the documented formula

    gob_off(x,y) = (x%64/32)*256 + (y%8/2)*64 + (x%32/16)*32 + (y%2)*16 + x%16

from [nxnative's nvn_deswizzle.c](https://github.com/seedds/nxnative/blob/7861e7c1a9913e020600b1cc7f65132427e9cc50/dm/gfx/tex/nvn_deswizzle.c)
produces an image whose large regions are correct (Mario's blue overalls, red
shirt, skin tones all in the right places) but with an 8-pixel mosaic on top: the
32 blocks inside each GOB are permuted differently from the Switch 1 order.

Variants tried, all scored by decoded-image smoothness and inspected:

| variant | result |
| --- | --- |
| plain raster, pitch 102 blocks | 12.9 — worse, so the data really is tiled |
| GOB, Tegra intra-GOB formula | large regions correct, 8-px mosaic |
| GOB, row-major intra-GOB | same mosaic |
| GOB, column-major intra-GOB | vertical streaks, worse |
| GOB, x/y swapped formula | worse |
| all 120 bit-permutations of the intra-GOB 5-bit index | all worse than the mosaic |
| hill-climb over all 32! intra-GOB assignments (colour-affinity objective) | overfit, no recognisable image |

So the remaining unknown is one permutation of 32 slots, or a different GOB
geometry for this GPU generation. The next thing to try is a bit-exact
implementation of the *Switch 2* unswizzle from a project that runs retail Switch 2
software (eden ships `block_linear_unswizzle_2d.comp`) rather than the Switch 1
formula, plus a known-content texture to fit against.

## SOLVED: textures decode (2026-10-29)

The missing piece was in [ShadyHero/Eden-NS2](https://github.com/ShadyHero/Eden-NS2)'s
`NS2.patch`, which adds a `native_tiling` uniform to
`block_linear_unswizzle_2d.comp`. Switch 2's GOB swizzle is the Switch 1 one with
one extra bit flip:

```glsl
uint offset = SwizzleTable(pos.y * 64 + pos.x);   // 8-word table, 16-byte slots
if (native_tiling) {
    uint difference = ((offset >> 5) ^ (offset >> 6)) & 1;
    offset ^= (difference << 5) | (difference << 6);
}
```

Without the flip the image is correct in large regions but has an 8-pixel mosaic;
with it, the texture is exact. `tools/bntx_decode.py` implements the whole chain:

```
CmnTex_Stage_SFCMarioCircuit_MarioBody_Alb  813x813 mips 10  ASTC_8x8/SRGB   -> 813x813 PNG
Shadow_Game03_X031_Z123_Shadow              512x512 mips 10  R16/Unorm       -> 512x512 PNG
CmnObj_AerialSignCentral001_Body03_Nrm     2048x2048 mips 12 ASTC_8x8/Unorm  -> 2048x2048 PNG
```

![Mario body albedo decoded from the MKW dump](docs/images/mkw-mario-albedo.png)

Pipeline per texture: parse the `Ounc` container and `BRTI` (name, dimensions,
mips, format, size), take the mip offset from the `BRTI+0x2A0` pointer array,
deswizzle GOBs with the native-tiling swizzle, then decode with
`texture2ddecoder` (ASTC 8x8, BC6H, BC1/3/4/5/7, R16). Mip 0 by default,
`--mip N` for the rest.

## Batch export (2026-10-29)

    python3 tools/bntx_batch.py ~/mkw-full/base/romfs/Tex ~/mkw-tex \
        --jobs 8 --manifest ~/mkw-tex-manifest.json

Walks every `*.bntx.zs`, decompresses with `zstd`, decodes mip 0 (or every mip
with `--mips`) and writes the PNG under the same relative path. Existing outputs
are skipped, so an interrupted run resumes; the JSON manifest records each
texture's name, dimensions, mips, format and any error. Throughput measured on
this machine: **~145 textures/s with 8 workers**, so the 140k-texture `Tex/` tree
is a ~16 minute job rather than an overnight one. A 3,000-texture first pass gave
2,898 ok / 102 failed, and the 102 were a single bug (BC1/BC4 already return RGBA,
an extra channel made PIL reject the array) — fixed.

## Full export (2026-10-29)

The whole texture tree is decoded:

    ~/mkw-tex     53,618 PNGs   23.6 GB   mean 439 KB
    ~/mkw-full/base/romfs/Tex   53,613 .bntx.zs   -> 53,618 outputs (5 dirs of extras)

100% of the tree (0 failures) at ~140 textures/s with 8 workers, roughly 17 minutes
end to end. Format mix seen: ASTC 8×8 sRGB/Unorm for albedo and normal maps, ASTC
5×5/6×6 for some driver and character normals, BC6H UF16 for the light bakes, R16
for shadow maps, R8 for occlusion/decals, R16G16 for motion-vector lookups, and a
handful of float RGBA probes.

Known gaps: cubemaps and array textures (`BRTI+0x30` layers > 1, e.g.
`World_Game03_Probe`) decode only their first layer; mips are exported on request
with `--mips` rather than always.

## Models with textures

`tools/mkw_export.py <model.bfres.zs> <out-dir>` ties it together: geometry, a
material, and every referenced texture.

    Driver_MarioRacing_Sub0: 7 shapes, 26 groups, 12700 vertices, 51015 indices,
                             27/27 textures decoded

Ring and character both export with sane bounds; positions are written once per
shape with one `g` block of faces per mesh.

Array and cubemap surfaces: `--layer N` decodes a single layer assuming contiguous
layers (`layer_stride = size / layers`). That holds for the 8-layer 128×128 RGBA16F
probe, where `size / 8` is exactly one face; layer 0 decodes correctly and layer 1
of that probe comes out black, so the stride is verified for layer 0 only.
