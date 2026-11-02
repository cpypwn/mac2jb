# MKW's BFRES 10.2 (nn::g3d2) — what the dump actually contains

Mario Kart World's models are not BFRES 3.5. `~/mkw-full` (base + update
`917504`, 45 GB) holds them as **zstd-compressed BFRES v10.2.1**, and the format
is documented by the EPD wiki ([Bfres](https://epd.zeldamods.org/wiki/Bfres),
covering 10.0.0 and 10.2.0). Everything below was verified against
`Model/CmnObj_AccelRing000.CmnObj_AccelRing000_A.bfres.zs`.

## The dump

`~/mkw-full/base/romfs`, 205,660 files / 22.2 GiB:

| bytes | files | what |
| --- | --- | --- |
| 17,886,187,611 | 140,650 | `.zs` — **zstd** (`28 b5 2f fd`), not Yaz0: BFRES models, BNTX textures, `.bphsh` shaders, SARC archives |
| 2,179,304,428 | 20,957 | `.bwav` audio |
| 1,451,368,077 | 49 | `.webm` movies |
| 632,453,853 | 24,113 | `.extm` |
| 536,429,293 | 6,448 | `.norm` |
| 414,592,841 | 6,448 | `.hgte`/`.hght` |
| 97,071,336 | 6,448 | `.mate` |

Models: `Model/*.bfres.zs` (5,827). Textures: `Tex/*.bntx.zs`. The `.extm` /
`.norm` / `.hgte` / `.mate` files are terrain and all begin with `TARB` — a
container this toolkit has no reader for yet.

Decompress with the system `zstd`: `zstd -d file.zs -o file.bfres`.

## Header (verified offsets)

`FRES    ` at 0x00, version `0x000a0201` at 0x08. Pointers are **64-bit offsets
from the start of the file** (little endian, high word usually 0).

| offset | field | sample value |
| --- | --- | --- |
| 0x20 | file name (NW string) | 0x7626 |
| 0x28 | `ResModel*` array | 0xF0 (`FMDL`) |
| 0x30 | model dictionary | 0x188 |
| 0xb0 | `nn::gfx::MemoryPoolInfo*` (GPU region) | 0x168 |
| 0xdc | model count (u16) | 1 |

## Model — `FMDL`

| offset | field | sample |
| --- | --- | --- |
| 0x00 | magic `FMDL` | |
| 0x08 | name | 0x760e |
| 0x18 | skeleton | 0x818 |
| 0x20 | `ResVertex*` array | 0x1b0 (`FVTX`) |
| 0x28 | `ResShape*` array | 0x418 (`FSHP`) |
| 0x30 | shape dictionary | 0x8d8 |
| 0x38 | `ResMaterial*` array | 0x260 (`FMAT`) |
| 0x40 | material dictionary | 0x910 |
| 0x48 | shader reflection | 0x3c0 |
| 0x50 | user data | 0x4d8 |
| 0x68 | vertex count (u16) | 2 |
| 0x6a | shape count (u16) | 2 |
| 0x6c | material count (u16) | 2 |

## Vertex — `FVTX`

| offset | field | sample |
| --- | --- | --- |
| 0x08 | attribute array | 0xfa8 |
| 0x30 | buffer info | 0x1060 |
| 0x38 | stride array | 0x1070 |
| 0x48 | vertex data base, relative to the GPU region | 0x5580 |
| 0x4c | attribute count (u8) | 7 |
| 0x4d | buffer count (u8) | 1 |
| 0x50 | vertex count (u32) | 4,086 |

Each attribute is 0x10 bytes: name pointer, `nn::gfx::AttributeFormat` (u32),
buffer offset (u16), buffer index (u8), dynamic flag (u8). The sample's seven
attributes sit at offsets 0x00, 0x0c, 0x10, 0x14, 0x18, 0x1c, 0x20 in a
**36-byte stride**, with formats 5, 2, 2, 3, 1, 5, 5 — note that the format
numbers are `nn::gfx::AttributeFormat`, not float3/float4 guesses, so the
decoder must map them explicitly.

## Shape and mesh — `FSHP` / `ResMesh`

| offset | field | sample |
| --- | --- | --- |
| 0x10 | `ResVertex*` | 0x1b0 |
| 0x18 | mesh array | 0x948 |
| 0x52 | material index (u16) | 0 |
| 0x56 | vertex index (u16) | 0 |
| 0x5a | skin weight count (u8) | 0 |
| 0x5b | mesh count (u8) | 4 |

`ResMesh` (0x38 bytes each): submesh array at 0x00, index buffer info at 0x18,
index offset at 0x20, topology at 0x24, index format at 0x28 (1 = u16 here),
index count at 0x2c (4,080), base vertex at 0x30, submesh count at 0x34.

## GPU region and extraction (solved)

The GPU region is the **tail of the file**, and its size is the u32 at **0x16c**
(0x168 holds a constant 0x24, which is what made an earlier read wrong):

    gpu = len(file) - u32(0x16c)          # 226,208 - 0x2d000 = 0xA3A0

For the accel ring that puts the vertex run at `0xA3A0 + 0x5580 = 0xF920`, with
exactly 4,086 × 36 = 147,096 bytes to EOF — zero slack, so the base is certain.
Indices are at `gpu + mesh[0x20]`, which is 0 for this file: 4,080 u16 values,
max 1,511, a valid buffer.

Two details that made this look wrong for a long time:

* **The position is not at record offset 0.** The first eight bytes are packed
  attributes; the ring's float3 positions start at offset **8**. Reading offset 0
  gives `x = y = 0` and a single varying axis, which looks like index data.
* **The offset varies per model.** The aerial sign (stride 32) has them at 0, not
  8, so the extractor picks the offset whose three axes all span real geometry
  rather than assuming one.

`tools/bfres10.py` implements this: header → FMDL → FVTX/FSHP/ResMesh, GPU region,
positions and indices, OBJ export plus a wireframe preview. Verified on two
models:

| model | vertices | stride | indices | bounds |
| --- | --- | --- | --- | --- |
| `CmnObj_AccelRing000` | 4,086 | 36 | 4,080 | x ±10.7, y ±11.2, z ±1.4 (a flat ring) |
| `CmnObj_AerialSign009` | 3,624 | 32 | 3,684 | x ±25.2, y 0..9.8, z −1.3..0.3 (a wide sign) |

Remaining for full glTF: normals/UVs (packed, need the `nn::gfx::AttributeFormat`
mapping), materials (`FMAT`), skeleton, and multiple meshes per shape. Textures
are a separate problem: they are `Ounce64` containers the toolkit cannot read.

## Multi-shape export and materials (2026-10-29)

`tools/bfres10.py` now walks the whole model, not just the first shape:

* shapes are 0x60-byte `FSHP` blocks from `FMDL+0x28`; each has its own `FVTX`
  and its own mesh array, so each shape gets its own position buffer;
* every mesh in a shape's array becomes an OBJ group (`s<i>_m<j>`); meshes whose
  indices fall outside that shape's vertex buffer are skipped rather than emitted
  as broken faces;
* the position offset is scored on inliers only (models are tens of units, so
  anything past 1e3 is a sentinel vertex or a misaligned read) and reused across
  shapes that share a stride — a small shape with a sentinel vertex would
  otherwise mis-detect and produce garbage bounds;
* texture references are read from the model's string table (pascal strings that
  match the `Tex/` names exactly) and written to a `.mtl` with
  `map_Kd`/`map_Ks`/`map_Ke`/`map_Bump`, which the `.obj` references via `mtllib`.

Ring (`CmnObj_AccelRing000`): 2 shapes, 4,503 vertices, 10,272 indices, 5 groups.
Sign (`CmnObj_AerialSign009`): 1 shape, 3,624 vertices, 8,100 indices, 3 groups.

## Full model export (2026-10-29)

`tools/mkw_export.py --all <Model-dir> <out-dir>` walks every `*.bfres.zs`, writes
`<model>/<model>.obj` + `.mtl`, and decodes referenced textures into a shared
`tex/` cache (symlinking an existing texture export avoids duplicating it).

    ~/mkw-models   4,803 models   4.1 GB   (4,803 .obj + 4,803 .mtl)
    ~/mkw-tex     53,618 PNGs    23.6 GB

Of the 5,827 files in `Model/`: **4,803 exported, 1,024 animation-only files
skipped (`.anim.bfres`, no FMDL), 0 failed.** Runtime ~100 s with 8 workers.

Robustness added along the way: vertex buffers that cannot hold a float3 (a
terrain file has stride 8) or are truncated now yield an empty shape rather than
raising, so those models still export their textures; per-shape position offsets
are validated and fall back to a shared offset only when implausible; the outlier
clamp scales to each model's median size.

### Coverage

    4,803 models exported      4,802 with geometry, 1 empty (TeraTerrain, stride 8)
    98,647,992 vertices        62,422,073 faces
    largest: Stage_DonkeyKong_FarModel 765,439 v / 291,198 f
             Stage_Central_FarModel    700,809 v / 287,673 f
             Stage_PeachBeach_FarModel 662,610 v / 282,078 f

Together with the texture export that is the complete renderable asset set:
~4.1 GB of OBJ+MTL and ~23.6 GB of PNG.

Still unsupported: animation-only files (`*.anim.bfres`, 1,024 of them — FSKA/FMTB
curve data) and the skeleton, so the exported meshes are unrigged.

## Skeletons and animations (2026-10-29)

**FMDL+0x18 -> FSKL.** Bone headers are 0x58 bytes from the array pointer at
`FSKL+0x10`; the count is the u16 at `FSKL+0x38`:

| offset | field |
| --- | --- |
| +0x00 | bone name (NW string) |
| +0x22 | parent index (s16, -1 for the root) |
| +0x30 | scale (3 floats) |
| +0x3C | rotation (3 floats, Euler radians) |
| +0x4C | translation (3 floats) |

`tools/bfres10.py` exposes `skeleton(b)`; `mkw_export.py` writes
`<model>.skeleton.json` for every model. All **4,803** exported models now have
one (4,803 skeletons; median rig is small, the largest are characters).

**FSKA (skeletal animation)** headers are 0x50 bytes: size +0x04, name +0x08,
bone-anim header array +0x20, curve/default-result data +0x48 (u32), bone-anim
count +0x40, curve count +0x44, frame count +0x4C. `tools/bfres10_anim.py` indexes
them — DriverA_Mario_MBike.anim has 40 clips (`MBikeBackL` 55 frames / 30 bone
anims / 105 curves, `MBikeDamageThunder` 90 bone anims, ...).

The animation payload begins with a table of `-1` entries, then per-bone default
transforms as floats (rest scale/rotation/translation), then the curve headers and
the frame/value pools at the offsets the headers point to. **The curve-header
layout is not decoded yet**, so clips are indexed but not sampled — that is the one
remaining piece before a rigged, animated glTF.
