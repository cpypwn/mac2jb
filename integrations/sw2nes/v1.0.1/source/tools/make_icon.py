#!/usr/bin/env python3
"""Generate app/icon.png (256x256) using only the standard library."""
import struct, zlib
from pathlib import Path

W = H = 256
px = [[(16, 18, 26)] * W for _ in range(H)]

OY = 0  # vertical offset applied to the artwork (set below to centre it)

def rect(x0, y0, x1, y1, c, r=0):
    y0 += OY; y1 += OY
    for y in range(max(0, y0), min(H, y1)):
        for x in range(max(0, x0), min(W, x1)):
            if r:
                cx = min(max(x, x0 + r), x1 - 1 - r); cy = min(max(y, y0 + r), y1 - 1 - r)
                if (x - cx) ** 2 + (y - cy) ** 2 > r * r: continue
            px[y][x] = c

def circle(cx, cy, r, c):
    rect(cx - r, cy - r, cx + r + 1, cy + r + 1, c, r)

# Square background (the console shows the icon as a square tile)
rect(0, 0, 256, 256, (26, 29, 40))
# Artwork spans y 28 (title) to 206 (accent band): 178 px, centred in 256.
OY = (256 - (206 - 28)) // 2 - 28
rect(18, 196, 238, 206, (228, 70, 59))
# Controller body
rect(20, 74, 236, 178, (196, 198, 204), 14)
rect(30, 84, 226, 168, (40, 42, 48), 8)
rect(98, 92, 158, 160, (150, 152, 160), 4)
for y in (100, 112, 124, 136, 148):
    rect(104, y, 152, y + 5, (40, 42, 48), 2)
# D-pad
rect(44, 114, 92, 130, (12, 12, 14), 3)
rect(60, 98, 76, 146, (12, 12, 14), 3)
# Select / Start
rect(104, 150, 122, 156, (12, 12, 14), 3)
rect(134, 150, 152, 156, (12, 12, 14), 3)
# B / A buttons
rect(168, 112, 222, 144, (150, 152, 160), 8)
circle(182, 128, 11, (214, 40, 40))
circle(208, 128, 11, (214, 40, 40))
# "NES" pixel letters on the accent band area above
font = {"N": ["10001", "11001", "10101", "10011", "10001"], "E": ["11111", "10000", "11110", "10000", "11111"],
        "S": ["01111", "10000", "01110", "00001", "11110"], "C": ["01111", "10000", "10000", "10000", "01111"],
        "I": ["111", "010", "010", "010", "111"], "V": ["10001", "10001", "10001", "01010", "00100"],
        "W": ["10001", "10001", "10101", "11011", "10001"], "2": ["01110", "10001", "00110", "01000", "11111"]}
def text(s, x, y, scale, c):
    for ch in s:
        g = font[ch]
        for gy, rowbits in enumerate(g):
            for gx, bit in enumerate(rowbits):
                if bit == "1": rect(x + gx * scale, y + gy * scale, x + (gx + 1) * scale, y + (gy + 1) * scale, c)
        x += (len(g[0]) + 1) * scale
text("SW2", 34, 28, 5, (154, 163, 181))
text("NES", 134, 28, 5, (238, 241, 247))

raw = b"".join(b"\x00" + bytes(v for p in row for v in p) for row in px)
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
out = Path(__file__).resolve().parents[1] / "app/icon.png"
out.write_bytes(png)
print(out, len(png), "bytes")
