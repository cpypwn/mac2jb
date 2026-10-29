import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root=Path(__file__).resolve().parent
font=os.environ.get('MAC2JB_HBLAUNCHER_FONT') or str(root.parents[3] / 'homebrew/fonts/DejaVuSans.ttf')
atlas=Image.new('L',(1024,2048))
draw=ImageDraw.Draw(atlas)
labels=[
    ('TITLE','MINTNES',56),
    ('SUBTITLE','mapper 0 nrom  |  audio experimental',22),
    ('HELP','D-pad move   A/B game buttons   Plus start   short Minus ROMs   hold Minus MintBrew',19),
    ('MENU','Choose a ROM',32),
    ('MENU_HELP','D-pad choose   A play   X refresh   B or Minus return to MintBrew',20),
    ('EMPTY','No compatible ROMs found',24),
    ('HALTED','unsupported NES instruction',24),
]
y=2
header=[]
for name,value,size in labels:
    face=ImageFont.truetype(font,size)
    bounds=draw.textbbox((0,0),value,font=face)
    width,height=bounds[2]-bounds[0],bounds[3]-bounds[1]
    assert width+4<=1024 and y+height+2<=2048
    draw.text((2-bounds[0],y-bounds[1]),value,fill=255,font=face)
    header.append(f'const ivec4 TEXT_{name}=ivec4(2,{y},{width},{height});')
    y+=height+8
glyph_font=ImageFont.truetype(font,16)
for code in range(32,127):
    index=code-32
    x=(index%48)*16
    gy=256+(index//48)*24
    bounds=draw.textbbox((0,0),chr(code),font=glyph_font)
    draw.text((x-bounds[0],gy-bounds[1]),chr(code),fill=255,font=glyph_font)
(root/'assets/text.bin').write_bytes(atlas.tobytes())
(root/'shaders/text.glsl').write_text('\n'.join(header)+'\n')
icon=Image.new('RGBA',(128,128),(7,35,29,255))
paint=ImageDraw.Draw(icon)
paint.rounded_rectangle((9,9,118,118),radius=18,fill=(18,62,49),outline=(148,245,196),width=4)
paint.rounded_rectangle((24,42,103,87),radius=8,fill=(10,32,29),outline=(148,245,196),width=3)
paint.rectangle((37,56,57,62),fill=(148,245,196))
paint.rectangle((44,49,50,69),fill=(148,245,196))
paint.ellipse((72,55,82,65),fill=(148,245,196))
paint.ellipse((88,48,98,58),fill=(148,245,196))
icon.save(root/'assets/icon.png')
