import json, os, struct, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

apps=json.loads(Path(sys.argv[1]).read_text())
assert len(apps)<=32
slots=bytearray(32*131072)
font=os.environ.get('MAC2JB_HBLAUNCHER_FONT') or str(Path(__file__).resolve().parents[3] / 'homebrew/fonts/DejaVuSans.ttf')
for i,app in enumerate(apps):
    title=Image.new('L',(512,48)); description=Image.new('L',(2048,32)); sizes=[]
    for image,text,size in [(title,app['name'],34),(description,app['description'],18)]:
        draw=ImageDraw.Draw(image)
        face=ImageFont.truetype(font,size)
        if image is title:
            while draw.textbbox((0,0),text,font=face)[2]>508:
                text=text[:-2]+'…'
        else:
            while draw.textbbox((0,0),text,font=face)[2]>2044 and size>10:
                size-=1
                face=ImageFont.truetype(font,size)
        box=draw.textbbox((0,0),text,font=face)
        assert box[2]-box[0]<=image.width-4
        draw.text((-box[0],-box[1]),text,fill=255,font=face)
        sizes.extend([box[2]-box[0],box[3]-box[1]])
    base=i*131072
    slots[base:base+24576]=title.tobytes()
    slots[base+24576:base+90112]=description.tobytes()
    icon=Image.open(app['icon']); assert icon.width<=4096 and icon.height<=4096
    icon=ImageOps.contain(icon.convert('RGBA'),(96,96),Image.Resampling.LANCZOS)
    tile=Image.new('RGBA',(96,96));tile.alpha_composite(icon,((96-icon.width)//2,(96-icon.height)//2))
    slots[base+90112:base+126976]=tile.tobytes()
    struct.pack_into('<4I',slots,base+126976,*sizes)
Path(sys.argv[2]).write_bytes(slots)
