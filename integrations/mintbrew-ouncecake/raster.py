import json
import os
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

WIDTH = 768
HEIGHT = 32
MAX_GAMES = 1000

def font(size):
    path = os.environ.get('MAC2JB_HBLAUNCHER_FONT')
    if path and Path(path).is_file():
        return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)

def shorten(draw, value, face):
    if draw.textlength(value, font=face) <= WIDTH - 8:
        return value
    lo, hi = 0, len(value)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if draw.textlength(value[:mid] + '…', font=face) <= WIDTH - 8:
            lo = mid
        else:
            hi = mid - 1
    return value[:lo] + '…'

def raster(input_path, output_path):
    games = json.loads(Path(input_path).read_text())
    if not isinstance(games, list) or not 0 < len(games) <= MAX_GAMES:
        raise ValueError('invalid OunceCake catalog size')
    face = font(25)
    with Path(output_path).open('wb') as output:
        for number, game in enumerate(games, 1):
            if not isinstance(game, dict) or not isinstance(game.get('name'), str):
                raise ValueError('invalid OunceCake game title')
            canvas = Image.new('L', (WIDTH, HEIGHT))
            draw = ImageDraw.Draw(canvas)
            label = shorten(draw, f'{number}. {game["name"]}', face)
            box = draw.textbbox((0, 0), label, font=face)
            draw.text((4 - box[0], (HEIGHT - (box[3] - box[1])) // 2 - box[1]),
                      label, font=face, fill=255)
            raw = canvas.tobytes()
            packed = bytearray(len(raw) // 2)
            for i in range(0, len(raw), 2):
                packed[i // 2] = (raw[i] & 0xf0) | (raw[i + 1] >> 4)
            output.write(packed)

if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: raster.py CATALOG_JSON OUTPUT_BIN')
    raster(sys.argv[1], sys.argv[2])
