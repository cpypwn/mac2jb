"""Resolve DejaVu fonts on both Debian and Arch, without machine-local paths."""
from pathlib import Path
import os

def font(name='DejaVuSans.ttf'):
    explicit=os.environ.get('HB_FONT')
    folders=([Path(explicit).parent] if explicit else [])+[
        Path('/usr/share/fonts/truetype/dejavu'),Path('/usr/share/fonts/TTF')]
    for folder in folders:
        if (folder/name).is_file():return str(folder/name)
    if explicit and Path(explicit).is_file():return explicit
    if name!='DejaVuSans.ttf':return font()
    raise FileNotFoundError('Install DejaVu Sans (fonts-dejavu-core or ttf-dejavu)')
