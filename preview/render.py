import math
import zipfile
from io import BytesIO
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(__file__).resolve().parent
W, H = 800, 450
SCALE = min(W, H)
COLORS = [
    (0.14, 0.98, 0.77), (0.18, 0.70, 1.00),
    (0.70, 0.46, 1.00), (1.00, 0.43, 0.61),
    (1.00, 0.76, 0.33), (0.35, 0.89, 0.48),
]
CUBE = (
    [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),
     (-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)],
    [(1,2,3,4),(5,6,7,8),(1,5,8,4),(2,6,7,3),(1,2,6,5),(4,3,7,8)],
)
PRISM = (
    [(-1,0.8,-1),(1,0.8,-1),(0,-1,-1),(-1,0.8,1),(1,0.8,1),(0,-1,1)],
    [(1,2,3),(4,5,6),(1,4,5,2),(2,5,6,3),(3,6,4,1)],
)
OBJECTS = [
    (CUBE,0.19,0.28,0.125,1,0.0),
    (PRISM,0.80,0.28,0.112,3,1.4),
    (PRISM,0.20,0.75,0.103,5,2.6),
    (CUBE,0.80,0.75,0.123,2,3.8),
    (CUBE,0.50,0.16,0.058,4,5.1),
]
with zipfile.ZipFile(ROOT / 'integrations/balatro-rce/balatro-switch-rce-1.1.0.zip') as archive:
    font_bytes = archive.read('.lovegame/bl/assets/mono.ttf')
FONT = ImageFont.truetype(BytesIO(font_bytes), max(38, int(H * 0.105)))
WORD = 'cpypwn'
BBOX = FONT.getbbox(WORD)
TEXT_W = BBOX[2] - BBOX[0]
TEXT_H = BBOX[3] - BBOX[1]

def rgb(color, alpha=1):
    return tuple(round(max(0, min(1, channel * alpha)) * 255) for channel in color)

def blend(base, overlay, alpha):
    return tuple(round(base[i] * (1-alpha) + overlay[i] * alpha) for i in range(3))

def rotate(v, t, phase):
    ax, ay, az = t*0.53+phase, t*0.39+phase, t*0.23
    sx,cx,sy,cy,sz,cz = math.sin(ax),math.cos(ax),math.sin(ay),math.cos(ay),math.sin(az),math.cos(az)
    x,y,z = v
    x,z = x*cy+z*sy,z*cy-x*sy
    y,z = y*cx-z*sx,y*sx+z*cx
    x,y = x*cz-y*sz,x*sz+y*cz
    return x,y,z

def draw_object(draw, model, ox, oy, size, offset, t, phase):
    vertices = [rotate(v,t,phase) for v in model[0]]
    faces = []
    for i, face in enumerate(model[1], 1):
        coords, depth = [], 0
        for index in face:
            x,y,z = vertices[index-1]
            perspective = 3.3 / (4.3+z)
            coords.append((round(ox+x*size*perspective), round(oy+y*size*perspective)))
            depth += z
        a,b,c = (vertices[face[j]-1] for j in range(3))
        ux,uy,uz = (b[k]-a[k] for k in range(3))
        vx,vy,vz = (c[k]-a[k] for k in range(3))
        nx,ny,nz = uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx
        length = math.sqrt(nx*nx+ny*ny+nz*nz)
        light = abs((nx*0.38-ny*0.60-nz*0.70)/length) if length else 0
        faces.append((depth/len(face),i,coords,0.42+0.50*light))
    faces.sort(reverse=True)
    for _, i, coords, shade in faces:
        base = COLORS[(i+offset-2)%len(COLORS)]
        center = coords[len(coords)//2]
        glint = 0.84+0.16*math.sin(center[0]*0.025+center[1]*0.015+t*1.4)
        fill = rgb(base,shade*glint*0.96)
        draw.polygon(coords,fill=fill)
        draw.line(coords+[coords[0]],fill=blend(fill,(214,255,245),0.27),width=1)

def add_text(im, mask, x, y, color, alpha):
    source = Image.new('RGB', mask.size)
    source.paste(tuple(round(255*c*alpha) for c in color), (0, 0, *mask.size), mask)
    box = (x, y, x + mask.width, y + mask.height)
    im.paste(ImageChops.add(im.crop(box), source), box)

def draw_title(im, t):
    pulse = 1 + 0.06 * math.sin(t * 2.2)
    glow = 0.78 + 0.22 * math.sin(t * 2.2)
    mask = Image.new('L', (TEXT_W, TEXT_H))
    ImageDraw.Draw(mask).text((-BBOX[0], -BBOX[1]), WORD, font=FONT, fill=255)
    mask = mask.resize((round(mask.width * pulse), round(mask.height * pulse)), Image.Resampling.BICUBIC)
    x, y = round(W / 2 - mask.width / 2), round(H / 2 - mask.height / 2)
    for radius, alpha in ((22, 0.018), (14, 0.030), (8, 0.048), (3, 0.075)):
        for step in range(16):
            angle = step * math.pi / 8
            dx = round(math.cos(angle) * radius)
            dy = round(math.sin(angle) * radius)
            add_text(im, mask, x + dx, y + dy, (0.14, 1.00, 0.73), alpha * glow)
    add_text(im, mask, x, y, (0.31, 1.00, 0.80), 0.24 * glow)
    im.paste((242, 255, 250), (x, y, x + mask.width, y + mask.height), mask)

def render(t):
    im = Image.new('RGB',(W,H),(0,0,0))
    draw = ImageDraw.Draw(im)
    cx,cy = W/2,H/2
    max_r = SCALE*0.44
    text_r = TEXT_W*0.56
    min_r = min(max_r*0.62,text_r)
    width = max(1.5,SCALE*0.003)
    for i in range(1,6):
        progress = (t/5.5+(i-1)/5)%1
        fade = max(0,1-progress/0.84)
        if fade <= 0: continue
        radius = min_r+(max_r-min_r)*progress
        color = COLORS[i%len(COLORS)]
        bounds = (cx-radius,cy-radius,cx+radius,cy+radius)
        glow = rgb(color,fade*0.08)
        line = rgb(color,fade*0.55)
        draw.ellipse(bounds,outline=glow,width=round(width*3.5))
        draw.ellipse(bounds,outline=line,width=max(1,round(width)))
    for model,px,py,size,offset,phase in OBJECTS:
        bob = math.sin(t*0.8+phase)*H*0.018
        draw_object(draw,model,W*px,H*py+bob,SCALE*size,offset,t,phase)
    draw_title(im, t)
    return im

times = [i/12 for i in range(66)]
frames = [render(t) for t in times]
frames[20].save(OUT/'balatro-showcase-preview.png')
palette = [frame.quantize(colors=96,method=Image.Quantize.FASTOCTREE) for frame in frames]
palette[0].save(OUT/'balatro-showcase-preview.gif',save_all=True,append_images=palette[1:],
                duration=83,loop=0,optimize=True,disposal=2)
print(OUT/'balatro-showcase-preview.gif')
print(OUT/'balatro-showcase-preview.png')
