#!/usr/bin/env python3
"""Generate Froggy Road's runtime assets.

Everything here is intentionally made from rectangles and square waves so the
result keeps a chunky 8-bit look.  The launcher treats the outputs as opaque
bytes; only the shaders know the layout.
"""
from __future__ import annotations

import math
import random
import struct
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
ATLAS_W, ATLAS_H = 1024, 2048
FONT_SCALE = 6

# 5x7 pixel font.  A '#' is an opaque pixel.  The extra blank column and row
# built into the drawing routine keep glyphs from touching each other.
GLYPHS: dict[str, tuple[str, ...]] = {
    " ": (".....", ".....", ".....", ".....", ".....", ".....", "....."),
    "A": (".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"),
    "B": ("####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."),
    "C": (".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."),
    "D": ("####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."),
    "E": ("#####", "#....", "#....", "####.", "#....", "#....", "#####"),
    "F": ("#####", "#....", "#....", "####.", "#....", "#....", "#...."),
    "G": (".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."),
    "H": ("#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"),
    "I": ("#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"),
    "J": ("..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."),
    "K": ("#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"),
    "L": ("#....", "#....", "#....", "#....", "#....", "#....", "#####"),
    "M": ("#...#", "##.##", "#.#.#", "#...#", "#...#", "#...#", "#...#"),
    "N": ("#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"),
    "O": (".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."),
    "P": ("####.", "#...#", "#...#", "####.", "#....", "#....", "#...."),
    "Q": (".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"),
    "R": ("####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"),
    "S": (".####", "#....", "#....", ".###.", "....#", "....#", "####."),
    "T": ("#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."),
    "U": ("#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."),
    "V": ("#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."),
    "W": ("#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"),
    "X": ("#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"),
    "Y": ("#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."),
    "Z": ("#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"),
    "0": (".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."),
    "1": ("..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."),
    "2": (".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"),
    "3": ("####.", "....#", "....#", ".###.", "....#", "....#", "####."),
    "4": ("...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."),
    "5": ("#####", "#....", "####.", "....#", "....#", "#...#", ".###."),
    "6": (".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."),
    "7": ("#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."),
    "8": (".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."),
    "9": (".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."),
    "!": ("..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."),
    "?": (".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."),
    ".": (".....", ".....", ".....", ".....", ".....", ".....", "..#.."),
    "-": (".....", ".....", ".....", "#####", ".....", ".....", "....."),
    "/": ("....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."),
    ":": (".....", "..#..", ".....", ".....", ".....", "..#..", "....."),
    "+": (".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."),
    ",": (".....", ".....", ".....", ".....", "..#..", "..#..", ".#..."),
}

# name, text, pixel scale
LABELS: tuple[tuple[str, str, int], ...] = (
    ("TITLE", "FROGGY ROAD", 8),
    ("SCORE", "SCORE", 4),
    ("BEST", "BEST", 4),
    ("TIME", "TIME", 4),
    ("LIVES", "LIVES", 4),
    ("PADS", "PADS", 4),
    ("MOVE", "MOVE", 4),
    ("DPAD", "D-PAD OR STICK", 3),
    ("EXIT", "B  EXIT", 4),
    ("FILL", "FILL ALL 5 PADS", 3),
    ("WIN", "TO WIN!", 3),
    ("YOU_WIN", "YOU WIN!", 10),
    ("GAME_OVER", "GAME OVER", 10),
    ("PLAY_AGAIN", "A  PLAY AGAIN", 5),
    ("EXIT_BIG", "B  EXIT", 5),
    ("OUCH", "OUCH!", 6),
    ("START", "START", 2),
    ("OVER_SCORE", "SCORE", 4),
)


def draw_glyphs(draw: ImageDraw.ImageDraw, x: int, y: int, text: str, scale: int, fill=255) -> int:
    """Draw text and return its width in pixels."""
    cursor = x
    for char in text:
        glyph = GLYPHS.get(char, GLYPHS[" "])
        for row, bits in enumerate(glyph):
            for col, bit in enumerate(bits):
                if bit == "#":
                    draw.rectangle(
                        (cursor + col * scale, y + row * scale,
                         cursor + (col + 1) * scale - 1, y + (row + 1) * scale - 1),
                        fill=fill,
                    )
        cursor += 6 * scale
    return cursor - x - scale


def text_rect(x: int, y: int, text: str, scale: int) -> tuple[int, int, int, int]:
    return (x, y, len(text) * 6 * scale - scale, 7 * scale)


def make_atlas() -> None:
    atlas = Image.new("L", (ATLAS_W, ATLAS_H), 0)
    draw = ImageDraw.Draw(atlas)
    lines = ["#ifndef FROGGY_TEXT_GLSL", "#define FROGGY_TEXT_GLSL"]

    y = 8
    for name, text, scale in LABELS:
        w = draw_glyphs(draw, 8, y, text, scale)
        h = 7 * scale
        lines.append(f"const ivec4 TEXT_{name} = ivec4(8, {y}, {w}, {h});")
        y += h + 14

    # Monospaced digits for the HUD.  Each rect is a full 6*scale cell so a
    # number can be drawn without measuring each glyph.
    digit_y = y + 8
    digit_w = 6 * FONT_SCALE
    digit_h = 7 * FONT_SCALE
    for value in range(10):
        x = 8 + value * (digit_w + 6)
        draw_glyphs(draw, x, digit_y, str(value), FONT_SCALE)
        lines.append(
            f"const ivec4 TEXT_D{value} = ivec4({x}, {digit_y}, {digit_w}, {digit_h});"
        )
    lines.append("#endif")
    (ROOT / "assets" / "font.bin").write_bytes(atlas.tobytes())
    (ROOT / "shaders" / "text.glsl").write_text("\n".join(lines) + "\n", encoding="ascii")
    print(f"font.bin: {ATLAS_W}x{ATLAS_H} ({ATLAS_W * ATLAS_H} bytes), {len(LABELS)} labels, 10 digits")


def make_state() -> None:
    state = bytearray(1024)
    # game: mode, lives, timer frames, pad mask
    struct.pack_into("<IIII", state, 784, 0, 3, 2700, 0)
    # piece: frog column, frog row, dying/banner timer, last stick direction
    struct.pack_into("<iiii", state, 800, 6, 0, 0, -1)
    # fade-in opacity
    struct.pack_into("<f", state, 960, 1.0)
    # stats: score, tick, spare, best
    struct.pack_into("<IIII", state, 992, 0, 0, 0, 0)
    (ROOT / "assets" / "state.bin").write_bytes(state)
    print("state.bin: 1024 bytes")


def make_icon() -> None:
    im = Image.new("RGBA", (256, 256), (10, 16, 34, 255))
    d = ImageDraw.Draw(im)

    # Pixel checkerboard sky.
    for yy in range(0, 256, 16):
        for xx in range(0, 256, 16):
            if (xx // 16 + yy // 16) % 2 == 0:
                d.rectangle((xx, yy, xx + 15, yy + 15), fill=(13, 22, 46, 255))

    # Road band.
    d.rectangle((0, 164, 255, 218), fill=(35, 35, 45, 255))
    d.rectangle((0, 164, 255, 168), fill=(220, 208, 150, 255))
    d.rectangle((0, 214, 255, 218), fill=(220, 208, 150, 255))
    for x in range(8, 256, 56):
        d.rectangle((x, 186, x + 28, 193), fill=(238, 224, 120, 255))

    # Chunky frog.
    d.rectangle((78, 128, 178, 144), fill=(20, 70, 24, 255))
    d.rectangle((70, 82, 112, 136), fill=(20, 70, 24, 255))
    d.rectangle((144, 82, 186, 136), fill=(20, 70, 24, 255))
    d.rectangle((78, 76, 178, 152), fill=(48, 184, 56, 255))
    d.rectangle((86, 92, 170, 146), fill=(78, 218, 72, 255))
    d.rectangle((78, 62, 112, 98), fill=(48, 184, 56, 255))
    d.rectangle((144, 62, 178, 98), fill=(48, 184, 56, 255))
    d.rectangle((84, 68, 106, 90), fill=(245, 250, 232, 255))
    d.rectangle((150, 68, 172, 90), fill=(245, 250, 232, 255))
    d.rectangle((92, 74, 102, 84), fill=(6, 10, 18, 255))
    d.rectangle((158, 74, 168, 84), fill=(6, 10, 18, 255))
    d.rectangle((94, 112, 162, 118), fill=(20, 70, 24, 255))
    d.rectangle((100, 126, 156, 146), fill=(190, 242, 96, 255))
    d.rectangle((72, 142, 92, 160), fill=(20, 70, 24, 255))
    d.rectangle((164, 142, 184, 160), fill=(20, 70, 24, 255))

    # Tiny logo.
    draw_glyphs(d, 54, 226, "FROGGY", 4, fill=238)
    im.save(ROOT / "assets" / "icon.png")
    print("icon.png: 256x256")


RATE = 48000


def envelope(i: int, n: int, attack: float = 0.01, release: float = 0.3) -> float:
    t = i / max(1, n - 1)
    a = min(1.0, t / max(attack, 0.001))
    r = min(1.0, (1.0 - t) / max(release, 0.001))
    return max(0.0, min(a, r))


def square_sweep(f0: float, f1: float, duration: float, volume: float = 0.22) -> list[float]:
    n = int(RATE * duration)
    out: list[float] = []
    phase = 0.0
    for i in range(n):
        t = i / max(1, n - 1)
        freq = f0 + (f1 - f0) * t
        phase = (phase + freq / RATE) % 1.0
        out.append((1.0 if phase < 0.5 else -1.0) * volume * envelope(i, n))
    return out


def notes(seq: list[tuple[float, float]], volume: float = 0.22) -> list[float]:
    out: list[float] = []
    for freq, duration in seq:
        out.extend(square_sweep(freq, freq, duration, volume))
        gap = int(RATE * 0.008)
        out.extend([0.0] * gap)
    return out


def make_sounds() -> None:
    effects = {
        "hop": square_sweep(520, 780, 0.065, 0.20),
        "squash": square_sweep(190, 55, 0.22, 0.24),
        "goal": notes([(523, 0.09), (659, 0.09), (784, 0.09), (1047, 0.12)]),
        "win": notes([(523, 0.085), (659, 0.085), (784, 0.085),
                      (1047, 0.085), (1319, 0.085), (1568, 0.105)], 0.20),
        "gameover": notes([(392, 0.10), (330, 0.10), (262, 0.10),
                           (196, 0.10), (147, 0.10), (110, 0.12)], 0.22),
        "bump": square_sweep(140, 90, 0.075, 0.18),
    }
    for name, samples in effects.items():
        # 0.682 s is the launcher's per-effect limit (131072 bytes stereo s16).
        samples = samples[:32768]
        data = bytearray()
        for sample in samples:
            clipped = max(-1.0, min(1.0, sample))
            value = struct.pack("<h", int(round(clipped * 32767.0)))
            data += value + value
        path = ROOT / "sounds" / f"{name}.pcm"
        path.write_bytes(data)
        print(f"{path.name}: {len(samples)} frames, {len(data)} bytes")

    # The two long effects must stay below the package's hard limit.
    for name in ("win", "gameover"):
        size = (ROOT / "sounds" / f"{name}.pcm").stat().st_size
        if size > 131072:
            raise SystemExit(f"{name}.pcm is too large: {size}")


if __name__ == "__main__":
    (ROOT / "assets").mkdir(exist_ok=True)
    (ROOT / "shaders").mkdir(exist_ok=True)
    (ROOT / "sounds").mkdir(exist_ok=True)
    make_atlas()
    make_state()
    make_icon()
    make_sounds()
