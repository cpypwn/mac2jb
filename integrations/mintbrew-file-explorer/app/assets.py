import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent
font = os.environ.get('MAC2JB_HBLAUNCHER_FONT') or str(root.parents[2] / 'homebrew/fonts/DejaVuSans.ttf')
mono = os.environ.get('MAC2JB_HBLAUNCHER_MONO_FONT') or font
atlas = Image.new('L', (1024, 2048))
draw = ImageDraw.Draw(atlas)
header = []
y = 2
labels = [
    ('TITLE', 'MintFTP', 58),
    ('SUB', 'Switch files and games', 24),
    ('FTP', 'FTP', 96),
    ('CONNECTION', 'CONNECT TO', 19),
    ('LOGIN', 'Anonymous FTP, passive mode', 24),
    ('OFF', 'Stopped', 26),
    ('ON', 'Ready to connect', 26),
    ('CONNECTED', 'Connected', 26),
    ('TRANSFER', 'Transferring', 26),
    ('ERROR', 'Could not start server', 26),
    ('WAIT', 'Starting', 26),
    ('START', 'A  Start', 24),
    ('STOP', 'A  Stop', 24),
    ('GAMES', 'X  Browse games', 24),
    ('EXIT', 'B  Back', 24),
    ('SCOPE', 'SmileBASIC /save and /tmp: read/write  |  /rom: read only', 18),
    ('GAME_NOTE', 'Game files open through OunceCake when held FS is ready', 18),
]
for name, label, size in labels:
    face = ImageFont.truetype(font, size)
    box = draw.textbbox((0, 0), label, font=face)
    width, height = box[2] - box[0], box[3] - box[1]
    if width + 4 > 1024 or y + height + 2 > 2048:
        raise ValueError('MintFTP text atlas is full')
    draw.text((2 - box[0], y - box[1]), label, font=face, fill=255)
    header.append(f'const ivec4 TEXT_{name}=ivec4(2,{y},{width},{height});')
    y += height + 9
face = ImageFont.truetype(mono, 48)
digit_y = y + 8
for index, char in enumerate('0123456789.:'):
    draw.text((index * 40, digit_y), char, font=face, fill=255)
if digit_y + 64 >= 2048:
    raise ValueError('MintFTP digits exceed atlas')
header.append(f'const int DIGIT_Y={digit_y};')
(root / 'assets/text.bin').write_bytes(atlas.tobytes())
(root / 'shaders/text.glsl').write_text('\n'.join(header) + '\n')

icon = Image.new('RGBA', (256, 256), (7, 35, 29, 255))
pen = ImageDraw.Draw(icon)
pen.rounded_rectangle((30, 55, 226, 210), radius=23, fill=(20, 71, 54), outline=(148, 247, 195), width=6)
pen.rounded_rectangle((43, 42, 128, 85), radius=12, fill=(20, 71, 54), outline=(148, 247, 195), width=6)
pen.line((68, 122, 188, 122), fill=(148, 247, 195), width=9)
pen.polygon([(168, 106), (193, 122), (168, 138)], fill=(148, 247, 195))
pen.line((188, 165, 68, 165), fill=(148, 247, 195), width=9)
pen.polygon([(88, 149), (63, 165), (88, 181)], fill=(148, 247, 195))
icon.save(root / 'assets/icon.png')
