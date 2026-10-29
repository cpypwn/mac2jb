import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent
font_path = os.environ.get('MAC2JB_HBLAUNCHER_FONT')

def font(size):
    if font_path and Path(font_path).is_file():
        return ImageFont.truetype(font_path, size)
    return ImageFont.load_default(size=size)

atlas = Image.new('L', (1024, 1024))
draw = ImageDraw.Draw(atlas)
labels = [
    ('TITLE', 'OunceCake', 70),
    ('SUBTITLE', 'Read-only game files over FTP', 30),
    ('DISCOVER', 'Reading installed games...', 31),
    ('CHOOSE', 'Choose a game', 31),
    ('PREPARING', 'Preparing game files...', 31),
    ('CLOSING', 'Closing FTP connection...', 31),
    ('READY', 'FTP ready', 31),
    ('ERROR', 'OunceCake could not start', 31),
    ('RETURN', 'Hold B or Minus to return to MintBrew', 25),
    ('SELECT', 'A  Select game', 25),
    ('BACK', 'Press B to return to game list', 25),
]
header = []
y = 4
for name, label, size in labels:
    face = font(size)
    box = draw.textbbox((0, 0), label, font=face)
    width, height = box[2] - box[0], box[3] - box[1]
    if width > 1016 or y + height > 500:
        raise SystemExit('label atlas overflow')
    draw.text((4 - box[0], y - box[1]), label, font=face, fill=255)
    header.append(f'const ivec4 TEXT_{name} = ivec4(4, {y}, {width}, {height});')
    y += height + 8

cell_width, cell_height, glyph_y = 20, 32, 512
ascii_font = font(24)
for code in range(32, 128):
    x = (code - 32) % 16 * cell_width
    row = (code - 32) // 16
    box = draw.textbbox((0, 0), chr(code), font=ascii_font)
    draw.text((x - box[0], glyph_y + row * cell_height + 3),
              chr(code), font=ascii_font, fill=255)
header += [f'const uint ASCII_ATLAS_Y = {glyph_y}u;',
           f'const uint ASCII_CELL_WIDTH = {cell_width}u;',
           f'const uint ASCII_CELL_HEIGHT = {cell_height}u;']
(root / 'data.bin').write_bytes(atlas.tobytes())
(root / 'shaders/text.glsl').write_text('\n'.join(header) + '\n')

icon = Image.new('RGBA', (256, 256), (8, 32, 28, 255))
brush = ImageDraw.Draw(icon)
brush.rounded_rectangle((20, 20, 236, 236), radius=48,
                        fill=(19, 65, 53, 255), outline=(148, 245, 195, 255), width=7)
brush.ellipse((72, 62, 184, 174), outline=(148, 245, 195, 255), width=12)
brush.rounded_rectangle((117, 121, 199, 203), radius=13,
                        fill=(86, 193, 145, 255), outline=(219, 255, 232, 255), width=4)
brush.line((148, 150, 176, 150), fill=(10, 46, 34, 255), width=8)
brush.line((162, 136, 162, 164), fill=(10, 46, 34, 255), width=8)
icon.save(root / 'icon.png')
