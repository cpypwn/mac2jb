from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
root=Path(__file__).resolve().parent
font='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
atlas=Image.new('L',(1024,2048));draw=ImageDraw.Draw(atlas);header=[];y=2
for name,label,size in [('HELLO','Hello, world!',96),('MESSAGE','Your first homebrew app is running.',32),('RETURN','B or Minus to return to HBLauncher',26)]:
 face=ImageFont.truetype(font,size);box=draw.textbbox((0,0),label,font=face);w,h=box[2]-box[0],box[3]-box[1]
 draw.text((2-box[0],y-box[1]),label,font=face,fill=255)
 header.append(f'const ivec4 TEXT_{name} = ivec4(2, {y}, {w}, {h});');y+=h+8
(root/'assets/text.bin').write_bytes(atlas.tobytes());(root/'shaders/text.glsl').write_text('\n'.join(header)+'\n')
# Simple terminal icon, matching the existing programmatically drawn icon system.
im=Image.new('RGBA',(256,256),(14,37,58,255));d=ImageDraw.Draw(im)
d.rounded_rectangle((26,42,230,214),radius=22,fill=(24,65,85),outline=(64,215,224),width=5)
d.line((54,94,80,116,54,138),fill=(111,246,221),width=10)
d.line((97,142,139,142),fill=(111,246,221),width=9)
d.text((163,144),'Hi',font=ImageFont.truetype(font,34),fill=(232,246,255))
im.save(root/'assets/icon.png')
