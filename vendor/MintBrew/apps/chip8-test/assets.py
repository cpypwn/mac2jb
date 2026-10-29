import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root=Path(__file__).resolve().parent
font=os.environ.get('MAC2JB_HBLAUNCHER_FONT') or str(root.parents[3] / 'homebrew/fonts/DejaVuSans.ttf')
atlas=Image.new('L',(1024,2048))
draw=ImageDraw.Draw(atlas)
labels=[
    ('TITLE','CHIP-8 TEST',64),
    ('SUBTITLE','original moving-sprite test rom',26),
    ('HELP','D-pad move   A center   B or Minus return',24),
    ('CLOCK','CPU timer active',22),
    ('FALLBACK','GPU frame timer',22),
    ('HALTED','emulator halted',24),
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
(root/'assets/text.bin').write_bytes(atlas.tobytes())
(root/'shaders/text.glsl').write_text('\n'.join(header)+'\n')
icon=Image.new('RGBA',(128,128),(7,35,29,255))
paint=ImageDraw.Draw(icon)
paint.rounded_rectangle((10,10,117,117),radius=20,fill=(18,62,49),outline=(148,245,196),width=4)
blocks=[(0,1),(1,0),(1,1),(2,1),(3,0),(3,1),(3,2),(1,3),(2,3)]
for x,y in blocks:
    paint.rounded_rectangle((35+x*14,34+y*14,46+x*14,45+y*14),radius=2,fill=(148,245,196))
icon.save(root/'assets/icon.png')
