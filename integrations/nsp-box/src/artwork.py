"""Artwork decoding, square crop geometry, and Switch library icon encoding."""
from dataclasses import dataclass
from pathlib import Path
import io, math
from PIL import Image, ImageOps

ICON_SIZE=256
IMAGE_EXTENSIONS=('.png','.jpg','.jpeg','.jpe','.jfif','.webp','.bmp','.dib','.gif','.tif','.tiff',
                  '.ico','.icns','.avif','.tga','.ppm','.pgm','.pbm','.pnm','.jp2','.j2k','.jpf','.jpx')
ARTWORK_FILETYPES=[('All supported artwork',' '.join('*'+s for s in IMAGE_EXTENSIONS)),
    ('WEBP','*.webp'),('PNG','*.png'),('JPEG','*.jpg *.jpeg *.jpe *.jfif'),('AVIF','*.avif'),
    ('Windows / Mac icons','*.ico *.icns'),('GIF / TIFF / BMP','*.gif *.tif *.tiff *.bmp *.dib'),('All files','*.*')]

@dataclass(frozen=True)
class ArtworkSelection:
    path: Path
    box: tuple[float,float,float,float] | None = None
    fit: bool = False

def load_artwork(path):
    with Image.open(path) as source:
        if source.width*source.height>50_000_000:
            raise ValueError('Artwork is too large (maximum 50 megapixels).')
        source.seek(0)
        return ImageOps.exif_transpose(source).convert('RGBA')

class CropModel:
    def __init__(self,width,height,box=None):
        self.width=width;self.height=height;self.zoom=1.;self.cx=width/2;self.cy=height/2
        if box:
            left,top,right,bottom=box
            self.cx=(left+right)*width/2;self.cy=(top+bottom)*height/2
            self.zoom=min(width,height)/max(1e-9,(right-left)*width)
        self.clamp()
    @property
    def side(self):return min(self.width,self.height)/self.zoom
    def clamp(self):
        self.zoom=max(1,min(8,min(self.width,self.height),self.zoom));half=self.side/2
        self.cx=max(half,min(self.width-half,self.cx));self.cy=max(half,min(self.height-half,self.cy))
    def pan(self,dx,dy):self.cx+=dx;self.cy+=dy;self.clamp()
    def set_zoom(self,value):self.zoom=float(value);self.clamp()
    def box(self):
        half=self.side/2
        return ((self.cx-half)/self.width,(self.cy-half)/self.height,
                (self.cx+half)/self.width,(self.cy+half)/self.height)

def artwork_bytes(value):
    if not value:return None
    selection=value if isinstance(value,ArtworkSelection) else ArtworkSelection(Path(value))
    image=load_artwork(selection.path)
    return encode_artwork(image,selection)

def encode_artwork(image,selection):
    image=image.copy()
    if selection.fit:
        image.thumbnail((ICON_SIZE,ICON_SIZE),Image.Resampling.LANCZOS)
        canvas=Image.new('RGBA',(ICON_SIZE,ICON_SIZE),(255,255,255,255))
        canvas.alpha_composite(image,((ICON_SIZE-image.width)//2,(ICON_SIZE-image.height)//2))
    else:
        box=selection.box or CropModel(image.width,image.height).box()
        if len(box)!=4 or not all(math.isfinite(n) and -1e-6<=n<=1.000001 for n in box):
            raise ValueError('Crop coordinates must be between 0 and 1.')
        l,t,r,b=box
        width=(r-l)*image.width;height=(b-t)*image.height
        if width<.999 or height<.999 or abs(width-height)>1.1:raise ValueError('Choose a square crop at least one source pixel wide, inside the image.')
        image=image.crop((l*image.width,t*image.height,r*image.width,b*image.height))
        image=ImageOps.fit(image,(ICON_SIZE,ICON_SIZE),method=Image.Resampling.LANCZOS)
        canvas=Image.new('RGBA',(ICON_SIZE,ICON_SIZE),(255,255,255,255));canvas.alpha_composite(image)
    out=io.BytesIO();canvas.convert('RGB').save(out,format='JPEG',quality=92)
    return out.getvalue()
