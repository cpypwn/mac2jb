# MKW skeletal animation (`FSKA`) — what is known and what is left

Status 2026-10-29. Skeletons are done (`FSKL`, exported for every model). This
document is the research result for the animation curves: the verified structures,
the one reference that documents them, the open questions with the measurements
that contradict a naive reading, and the experiment plan that would finish it.

## Reference

* [smm2recomp `docs/formats/bfres.md`](https://github.com/smm2recomp/smm2recomp/blob/8c0b2d417cd8fc86294bf1d0fc08795ebd3569e3/docs/formats/bfres.md)
  — BFRES 0.9 (Switch 1), but its `FSKA`, bone-animation and curve sections match
  what MKW (g3d2 10.2) actually contains, down to the 0x50 / 0x38 / 0x30 record
  sizes. This is the document to work from.
* [Syroot.NintenTools.Bfres `AnimCurve`](http://docs.syroot.com/nintentools/api/Syroot.NintenTools.Bfres.AnimCurve.html)
  — same field set for Switch BFRES, useful for naming.
* [EPD wiki Bfres](https://epd.zeldamods.org/wiki/Bfres) — v10.0/10.2 models,
  vertex, shape and material; it does **not** cover FSKA.

## Verified in MKW (g3d2 10.2)

`DriverA_Mario_MBike.anim.bfres` (40 clips) is the reference file. All checks below
were run against it.

### FSKA header — 0x50 bytes each

| offset | field | verified value |
| --- | --- | --- |
| +0x04 | size | 4352 |
| +0x08 | name (NW string) | `MBikeBackL`, `MBikeDamageThunder`, … |
| +0x20 | bind indices (u16 per bone anim, 0xFFFF = bind by name) | 0x1008, a run of `0xFFFF` |
| +0x28 | bone-animation array | 0x1078 |
| +0x40 | **frame count** | 30 (every curve ends at frame 30.0) |
| +0x44 | curve count | 105 |
| +0x48 | baked size | |
| +0x4C | **bone-animation count** | 55 |

Note the correction against the reference: it lists +0x40 as the frame count and
+0x4C as the bone-animation count, which is what the data shows — an earlier index
tool of ours had them swapped (55 frames / 30 bone anims); it now reads 30 frames /
55 bone anims, consistent with every curve's end frame.

The 55 bone animations exceed the model's 33 bones because clips target shared-rig
bone names (`ScarfDesert`, `Scarf_Pilot`, `Waist`, …), so binding must be by name
(`bind indices` 0xFFFF) and unmatched bones simply stay at rest.

### Bone animation — 0x38 bytes each

| offset | field | verified |
| --- | --- | --- |
| +0x00 | bone name | `Root`, `Skl_Root`, `Arm_1_L`, … |
| +0x08 | curves array | 0x1cd0 (Skl_Root) |
| +0x10 | base values | 0x1ca8 |
| +0x28 | flags | 0x03000e38 (Skl_Root) |
| +0x2E | curve count (u8) | 3 (Skl_Root), 6 (Arm_1_L) |

### Curve — 0x30 bytes each

| offset | field | verified |
| --- | --- | --- |
| +0x00 | frames array | 0x1d60 |
| +0x08 | keys array | 0x1d68 |
| +0x10 | flags (u16) | 0x400A / 0x4006 |
| +0x12 | key count (u16) | 3, 5, 8 |
| +0x14 | target (u32) | 0x10/0x14/0x18 translation xyz, 0x20/0x24/0x28 rotation xyz |
| +0x18 | start frame (f32) | 0.0 |
| +0x1C | end frame (f32) | 30.0 |
| +0x20 | ? | 0 on every curve sampled |
| +0x24 | ? | 0.001187 (rotation curves), 0 (translation curves) |
| +0x28 | delta (end − start value) | 0.240 (Skl_Root rot x), 0.145 (Arm_1_L trans x) |
| +0x2C | ? | 0 |

Flags decode as the reference describes: `0x400A` = frame type 2 (u8 frames), key
type 2 (s8 keys), curve type 0 (cubic), and `0x4006` = key type 1 (s16 keys). Frame
bytes for a curve are exactly `[0, 19, 30]` / `[0, 4, 8, 8, 12, 18, 27, 30]`, so the
frame-type decoding is confirmed.

## Additional evidence (2026-10-29, second pass)

Syroot's `AnimCurve` documentation settles the semantics: **value = key × Scale +
Offset**, and **Delta is the range** (lowest to highest key value), not end − start.
With that:

* Reading the key arrays under two packings and solving `Scale = Delta / key-range`
  for all 105 curves of `MBikeBackL` gives **no consistent scale**: the s8×4
  (cubic) reading spreads from −0.018 to +0.013 (median 1.9e-4), and the f32 linear
  reading is off by orders of magnitude (implied scale in the hundreds). So neither
  packing is right, or the key array is not what `+0x08` points at.
* The field at `+0x20`, which the layout calls **Scale**, reads 0.0 on every one of
  the 105 curves. A scale of 0 would collapse every value to the offset, so either
  g3d2 stores 0 to mean "1" (still cannot explain ±127 s8 keys becoming radians) or
  the curve layout has one more field than the reference and everything from +0x20
  on is shifted.
* `FSKA+0x48` (called "baked size") is **15,960 bytes** for `MBikeBackL` — a large
  payload for 105 curves of a few keys each. Baked curves (curve types 2/5/7 in the
  reference) store per-frame values in a separate table; if these clips are baked,
  the key arrays are indices into that table and the values must be read from it.

## Open questions (what blocks sampling)

1. **Where the scale lives.** The reference puts `scale` at +0x20, `offset` at
   +0x24 and `delta` at +0x28. Measured: +0x20 is 0 everywhere, +0x24 is non-zero
   only on rotation curves, +0x28 matches the expected delta. Either g3d2 inserts a
   field (so scale sits at +0x24 and offset at +0x28), or scale is stored as 0 to
   mean "1" and +0x24 is something else entirely.
   *Corroboration for the shifted reading:* Skl_Root's rotation-x keys span
   `176` (s8, −68…113) and `0.24048 / 176 ≈ 0.00137`, close to the 0.001187 at
   +0x24; the translation curve's s16 keys span `38360` and `0.145198 / 38360 ≈
   3.8e−6`, but its +0x24 is 0, which does not fit. So the scale question is **not
   settled**.
2. **How cubic keys map to values, and their width.** Cubic keys are 4
   coefficients per key, but the byte span does not settle the width. Arm_1_L's
   translation-x curve has 8 keys and its key array runs from 0x1f68 to the next
   curve's frames at 0x1f90 — **40 bytes, i.e. 5 bytes per key**. Cubic s16 would
   be 64, cubic s8 32, linear s16 32. So either keys carry per-key padding or an
   extra trailing key, or the coefficient count/width differs from the reference.
   Reading the stream as s16 gives `[-11679, 13216, -10112, …]`, far larger than a
   0.15-unit translation at scale 1.
3. **Wrap modes and bool curves** (bits 8–9 / 12–13 pre/post wrap, curve types
   4–7) are untested; looping clips (`MBikeBackL` is a loop) will need them.

## Experiment plan

Cheap and decisive, in order:

1. **Rest-pose check.** Sample every curve of one clip at frame 0 and, after
   applying the curve scale, compare against the bone's rest transform from the
   same file's `FSKL` (scale/rotation/translation are all exported already). The
   scale is correct exactly when frame-0 values match the rest pose across many
   curves — that is a strong least-squares fit for the scale/offset pair.
2. **Delta check.** `delta` should equal `(max − min) × scale` over the curve's
   keys. Solving that per curve gives the scale independently; the two must agree.
3. **Cross-check with a second clip** (`MBikeDamage`, 62 curves) and with a
   different rig (`DriverA_BabyPeachExplore_LBike`, 132 curves, 117 frames) so a
   coincidental match on one file cannot pass.
4. Only then implement sampling and glTF animation export: bones are already in
   `<model>.skeleton.json`, so the exporter needs the per-curve key evaluation
   (`v(t) = c0 + c1·t + c2·t² + c3·t³` per segment) plus the wrap rules for loops.

## What is already in the repository

| tool | does |
| --- | --- |
| `tools/bfres10.py` | `skeleton(b)` → bone name/parent/scale/rotation/translation |
| `tools/mkw_export.py` | writes `<model>.skeleton.json` for every model |
| `tools/bfres10_anim.py` | indexes every `FSKA`: name, frames, bone anims, curves |

4,803 models have skeletons (385 rigged with more than 10 bones, max 77). 1,024
`.anim.bfres` files are indexed but not sampled.

## Conclusion after the second pass

The curve headers, targets, key counts, frame arrays, bone names and clip metadata
are all decoded and stable. What is not decoded is how a key becomes a value, and
every measurement points the same way: **the keys are not the values**.

* Implied scales from `Delta / key-range` are 3.0e-6 for a translation curve and
  3.1e-3 for a rotation curve — two orders of magnitude apart, so there is no
  shared fixed-point convention.
* The `Scale` field reads 0.0 on all 105 curves of the sampled clip.
* `FSKA+0x48`, which the reference calls the baked size, is 15,960 bytes for a clip
  whose variable data spans about 13.5 KB.

Taken together, the most consistent reading is that these clips are **baked**: the
key arrays are indices into a per-frame value table, and `Delta` is the range of
that table's values. Sampling therefore needs two things this repository does not
have yet:

1. the location and layout of the baked value table (the clip's data region is the
   place to look, and the clip's `+0x48` size should bound it), and
2. confirmation of how `bone animation +0x10 (base values)` relates to it — those
   base floats were the only per-bone transforms found in the clip so far.

The reliable way to get both is a reference that already samples g3d2 animations
(Switch Toolbox and NintenTools are Switch 1 only, and I could not find a Switch 2
fork), or a capture from the running game (the same approach that resolved the
texture swizzle via Eden-NS2). Guessing further from byte patterns risks producing
plausible-but-wrong poses, which is worse than an honest gap.

Everything else about animations is in place and tested: clip index
(`bfres10_anim.py`), bone hierarchy (`skeleton()` in `bfres10.py`), bind-by-name
tables, targets, frame ranges and wrap flags.

## Third pass: the authoritative spec, and where it still diverges

[Wexos's Wiki BFRES/Switch](https://wiki.wexosmk.xyz/index.php?title=BFRES_(File_Format)/Switch)
documents the **version ≥ 9.0.0** layout, which is what MKW uses, and it is more
detailed than either earlier source. The relevant parts:

**Animation curve flag** (`xxAA xxBB xCCC DDEE`, u16 at +0x10): AA = post wrap,
BB = pre wrap (0 clamp, 1 repeat, 2 mirror, 3 relative repeat), CCC = curve type
(0 cubic float, 1 linear float, 2 baked float, 4 step int, 5 baked int, 6 step bool,
7 baked bool), DD = frame format (0 float, 1 int16, 2 sbyte), EE = key format
(0 float, 1 **16-bit fixed point: 1 sign + 10 exponent + 5 fraction**, 2 byte).
Curve fields: +0x20 = scale (multiply), +0x24 = add (applied after multiplying,
"not used by all curves"), +0x28 = delta, +0x2C = padding.

**FSKA** (≥9): +0x04 flag — rotation mode (quaternion/Euler), scale mode, loop,
**baked**; +0x20 bind index array; +0x28 bone animations; +0x40 frames; +0x44
curves; +0x48 baked size; +0x4C bone animations; +0x4E user datas.

**Bone animation** (0x38): +0x00 name, +0x08 curve array, +0x10 base values,
+0x28 flag (transformation types, a **10-bit channel mask**: 0x001 scale X … 0x200
translate Z, and bits for whether the base value carries T/R/S), +0x2C begin
rotate (3), +0x2D begin translate (6), +0x2E curve count, +0x2F begin base
translate (7), **+0x30 begin curve — the index of this bone's first curve**.

### What that fixed, and what it broke

The `begin curve` index was the missing link: a bone's curves are
`bone.curves + (begin + i) * 0x30`, not `bone.curves + i * 0x30`. With it,
`Skl_Root` resolves to exactly three rotation curves (targets 0x20/0x24/0x28,
deltas 0.2405 / 0.2319 / −0.0035) and `Arm_1_L`'s first three to translation
x/y/z (0x10/0x14/0x18, deltas 0.1452 / 0.1914 / −0.0465). That is a clean,
sensible mapping where the old one was noise.

It does not yet hold end to end: `Arm_1_L` declares 6 curves but only its first 3
parse, and `Arm_2_L` (begin 9, count 1) lands on garbage at
`0x2000 + 9*0x30`. So either `begin` is relative to a single animation-wide curve
array rather than to each bone's `+0x08` pointer, or the curve array is packed
(with the 0x2C padding dropped) and the stride is not 0x30 in every case.

Also worth noting: **FSKA +0x04 reads 0x1100 for `MBikeBackL`, i.e. the baked flag
is set**, while every parsed curve's type bits read 0 (cubic float). The two
descriptions disagree, and `+0x48` (baked size, 15,960 B) says a large baked payload
exists somewhere. Resolving `begin curve` against the animation-wide array, and
then reading the curve type from the flags rather than assuming, is the next step.

The spec itself is no longer the gap: the flag layout, field semantics and curve
interpolation formulas (step, linear, hermite) are all documented on that page,
including the fixed-point key format.

### Fourth pass: base values vs frame 0

Each bone animation points at base values (+0x10). For `Arm_1_L` they read
`[1.0, 1.0, 1.0, 1.9414, -0.2644, -1.117, 1.0, 0.1456, 0.1914, 0.1261]` — a clean
`scale(3) · rotation(3) · ? · translation(3)` layout with a plausible rest pose.
Comparing them against frame-0 values derived as `key0 × (delta / key_range) + add`:

| channel | base | derived frame 0 | delta |
| --- | --- | --- | --- |
| rot x | 1.9414 | 1.2211 | 1.233 |
| rot y | −0.2644 | −0.0166 | |
| rot z | −1.117 | −0.6547 | |
| trans x | 0.1456 | 0.0623 | 0.1452 |
| trans y | 0.1914 | −0.0786 | 0.1914 |
| trans z | 0.1261 | −0.0261 | |

Two observations: the base translation `x` equals the curve's `delta` exactly
(0.1456 vs 0.1452), and the rotation base is consistently *larger* than the derived
frame-0 value. Neither the "base is frame 0" nor the "base is the delta" reading
holds across channels, and the bind pose is not the comparison (a clip starts in an
idle pose, which is why the earlier rest-pose test could not settle it either).

So the file *format* is documented and the structures are parsed, but the mapping
from these quantised keys to real values still has one unknown — most likely the
`scale` field's meaning when it reads 0 ("not used by all curves" in the spec) —
and settling it needs a reference that samples the same curves, or a capture from
the running game. That is the state of the work; nothing further can be concluded
from the byte patterns alone without risking invented poses.

### Fifth pass: the baked bit was misread, and the base anchor

The FSKA flag's *baked* bit is bit 0, and `0x1100` has it **clear** — so these
clips are **keyed, not baked**, and `FSKA+0x48` is not a per-frame table. That
removes the earlier "baked table" hypothesis.

The base values (+0x10) are 10 floats per bone, and with rotation mode quaternion
the layout is `scale(3) · rotation(4) · translation(3)`. Using the translation
triple as the frame-0 anchor (`scale = (base − add) / key0`) and then checking
`delta ≈ key_range × scale`:

* all channels: **9 of 93 consistent**
* translation channels only: **4 of 33 consistent**

A pattern did show up in the failures: for several translation channels the curve's
`delta` equals the base value itself (`Clavicle_L` x: 0.041 vs 0.041, y: 0.191 vs
0.191; `Arm_1_L` x: 0.145 vs 0.146). That is not what "delta = range" predicts, so
either the delta field has a different meaning in 10.2, or the base I am reading is
not the frame-0 pose.

## On capturing from the running game

A capture would settle this immediately, but the two kinds are very different:

* **Pixels** — I can launch MKW (the pad/OCR cycle does it) and grab HDMI frames.
  That gives images, not transforms: no frame tells us a bone's matrix.
* **Memory** — the values we need (evaluated bone transforms at a known frame). The
  ns2jb session gives a promoted `fsp-srv` root, i.e. **file-system** access as
  SmileBASIC. It does not give read access to another process's memory, and no
  service we have exposes MKW's heap. So there is no capture path to the numbers.

That leaves a reference implementation (the wiki's own Tools section says "(none)"
for BFRES) or a memory primitive we do not have. A frame would only be useful later,
as a visual check on a renderer once skinning and animation exist.

## Attempting the in-game evaluator (2026-10-29, sixth pass)

Idea: the game itself evaluates these curves, so disassembling its g3d2 code would
settle the mapping. Reconnaissance on `updates/917504/exefs/main` (33.7 MB NSO,
45 MB of text, stripped — only 83 defined symbols):

| anchor | result |
| --- | --- |
| `nn::g3d` strings | two log tags only (`nn::g3d`, `nn::g3d(update)`) |
| `nn::g3d2` symbols in `main` | none |
| `nn::g3d2` symbols in `sdk`/`subsdk*` | none (one unrelated `nnText_g3dviewer`) |
| literal `FSKA` bytes anywhere in the image | **none** |
| `movz #0x5346` / `#0x4D46` / `#0x5246` (magic halves) in text | none (hits are misaligned rodata) |
| animation-related rodata strings | game-level parameters (`IsNeedWaitAnim`, `mPipeAnimFrameRatio`, …), not g3d2 internals |

So the loader never compares the magic constants as immediates or literals — it
almost certainly indexes sections by the header counts and offsets, which is why the
file format is so layout-sensitive. Without a magic compare, a symbol, a log string
or RTTI to anchor on, locating the curve evaluator inside 45 MB of stripped text is
a full reverse-engineering project rather than a lookup.

One data hint worth keeping for that effort: for several translation channels the
curve's `delta` equals the bone's base translation (`Arm_1_L` x: 0.1452 vs 0.1456;
`Clavicle_L` y: 0.1914 vs 0.191), while rotation `delta` is consistently smaller
than the base rotation (1.233 vs 1.9414). That asymmetry is the most specific clue
found so far about how `delta` is meant to be used.
