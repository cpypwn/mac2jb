import argparse
import hashlib
import json
import math
import sys
from functools import lru_cache
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps

parser = argparse.ArgumentParser()
parser.add_argument('--font', default='')
parser.add_argument('--width', type=int, default=640)
parser.add_argument('--height', type=int, default=360)
parser.add_argument('--overlay', action='store_true')
parser.add_argument('--worker', action='store_true')
args = parser.parse_args()
if (args.width, args.height) not in ((1920, 1080), (1280, 720), (960, 540), (640, 360), (320, 180)):
    raise ValueError('Unsupported menu dimensions')
model = {}
W, H = 640, 360
INK = (242, 241, 249, 255)
MUTED = (157, 158, 178, 255)
PURPLE = (155, 112, 255, 255)
SCALE = args.width / W
image = Image.new('RGBA', (args.width, args.height), (0, 0, 0, 0) if args.overlay else (17, 18, 27, 255))

class ScaledDraw:
    """Keep layout in logical points while rasterizing text and vectors at output resolution."""
    def __init__(self, target):
        self.target = ImageDraw.Draw(target)
    def coords(self, values):
        return [self.coords(value) if isinstance(value, (tuple, list)) else value * SCALE for value in values]
    def shape(self, name, xy, **kwargs):
        for key in ('width', 'radius'):
            if key in kwargs:
                kwargs[key] = max(1, round(kwargs[key] * SCALE))
        return getattr(self.target, name)(self.coords(xy), **kwargs)
    def rectangle(self, xy, **kwargs): return self.shape('rectangle', xy, **kwargs)
    def rounded_rectangle(self, xy, **kwargs): return self.shape('rounded_rectangle', xy, **kwargs)
    def ellipse(self, xy, **kwargs): return self.shape('ellipse', xy, **kwargs)
    def line(self, xy, **kwargs): return self.shape('line', xy, **kwargs)
    def polygon(self, xy, **kwargs): return self.shape('polygon', xy, **kwargs)
    def text(self, xy, value, **kwargs): return self.target.text(self.coords(xy), value, **kwargs)
    def textlength(self, value, **kwargs): return self.target.textlength(value, **kwargs) / SCALE

draw = ScaledDraw(image)

@lru_cache(maxsize=24)
def font(size):
    size = max(1, round(size * SCALE))
    return ImageFont.truetype(args.font, size) if args.font else ImageFont.load_default(size=size)

def fitted(value, size, width=None):
    value = str(value or '').replace('\n', ' ')[:600]
    if width is not None:
        face = font(size)
        while value and draw.textlength(value, font=face) > width:
            value = value[:-2] + '…' if len(value) > 2 else ''
    return value

def text(x, y, value, size=12, fill=INK, width=None):
    value = fitted(value, size, width)
    draw.text((x, y), value, font=font(size), fill=fill)

def catalog_title(card, rect, focused=False, selected=False, elapsed_ms=0):
    x, y, right, bottom = rect
    size, inset = 10, 5
    value = fitted(card.get('title') or card.get('label'), size)
    face = font(size)
    available = right - x - inset * 2
    measured = draw.textlength(value, font=face)
    color = INK if selected else MUTED
    if measured <= available:
        text(x + (right - x - measured) / 2, y, value, size, color)
        return
    if not focused:
        label = fitted(value, size, available)
        text(x + (right - x - draw.textlength(label, font=face)) / 2, y, label, size, color)
        return
    distance = measured - available
    travel = distance / 28
    phase = (max(0, elapsed_ms) / 1000) % (travel * 2 + 1.6)
    if phase < .8:
        offset = 0
    elif phase < .8 + travel:
        offset = (phase - .8) * 28
    elif phase < 1.6 + travel:
        offset = distance
    else:
        offset = distance - (phase - 1.6 - travel) * 28
    layer = Image.new('RGBA', (round(available * SCALE), round((bottom - y) * SCALE)), (0, 0, 0, 0))
    ImageDraw.Draw(layer).text((-offset * SCALE, 0), value, font=face, fill=color)
    image.alpha_composite(layer, (round((x + inset) * SCALE), round(y * SCALE)))

def wrap(x, y, value, width, size=11, lines=2, fill=MUTED):
    words = str(value or '').replace('\n', ' ').split()
    current, output = '', []
    for word in words:
        candidate = (current + ' ' + word).strip()
        if current and draw.textlength(candidate, font=font(size)) > width:
            output.append(current)
            current = word
        else:
            current = candidate
    if current:
        output.append(current)
    for i, line in enumerate(output[:lines]):
        if i == lines - 1 and len(output) > lines:
            line += '…'
        text(x, y + i * (size + 4), line, size, fill, width)

def box(rect, color, radius=9, outline=None, line=1):
    draw.rounded_rectangle(rect, radius=radius, fill=color, outline=outline, width=line)

def pill(x, y, label, active=False, max_width=165):
    width = min(max_width, math.ceil(draw.textlength(str(label), font=font(10))) + 20)
    box((x, y, x + width, y + 22), (61, 45, 92, 255) if active else (29, 30, 43, 255), 11,
        (121, 85, 184, 255) if active else None)
    text(x + 10, y + 4, label, 10, INK if active else MUTED, width - 20)
    return width

def art(reference):
    path = model.get('_artwork', {}).get(reference)
    if not path:
        return None
    try:
        with Image.open(path) as source:
            if source.width * source.height > 16000000:
                return None
            return ImageOps.exif_transpose(source).convert('RGBA')
    except (OSError, ValueError, Image.DecompressionBombError):
        return None

def paste_cover(source, rect, radius=7):
    if source is None:
        return False
    x, y, right, bottom = map(int, rect)
    tile = ImageOps.fit(source, (round((right - x) * SCALE), round((bottom - y) * SCALE)), method=Image.Resampling.LANCZOS)
    mask = Image.new('L', tile.size)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, tile.width, tile.height), radius=round(radius * SCALE), fill=255)
    image.paste(tile, (round(x * SCALE), round(y * SCALE)), mask)
    return True

def poster(card, rect, selected=False):
    x, y, right, bottom = rect
    if selected:
        box((x - 4, y - 4, right + 4, bottom + 4), (89, 57, 147, 255), 10,
            (180, 144, 255, 255), 2)
    if not paste_cover(art(card.get('poster')), rect):
        seed = hashlib.sha256(str(card.get('title') or card.get('label') or 'Stremio').encode()).digest()
        base = (33 + seed[0] // 5, 28 + seed[1] // 6, 53 + seed[2] // 4)
        box(rect, base + (255,), 7)
        for i in range(5):
            cx = x + seed[i + 3] % max(1, right - x)
            cy = y + seed[i + 8] % max(1, bottom - y)
            r = 12 + seed[i + 13] % 25
            layer = Image.new('RGBA', image.size)
            ScaledDraw(layer).ellipse((cx - r, cy - r, cx + r, cy + r), fill=(172, 128, 255, 20))
            mask = Image.new('L', image.size)
            ScaledDraw(mask).rounded_rectangle(rect, radius=7, fill=255)
            image.alpha_composite(Image.composite(layer, Image.new('RGBA', image.size), mask))
        title = str(card.get('title') or card.get('label') or 'Stremio')
        initials = ''.join(word[:1] for word in title.split()[:2]).upper() or 'S'
        face = font(23)
        text(x + (right - x - draw.textlength(initials, font=face)) / 2,
             y + (bottom - y - 23) / 2, initials, 23, INK)
    progress = card.get('progress') or {}
    ratio = max(0, min(1, float(progress.get('ratio') or 0)))
    if ratio:
        box((x + 5, bottom - 8, right - 5, bottom - 5), (54, 48, 68, 255), 1)
        box((x + 5, bottom - 8, x + 5 + int((right - x - 10) * ratio), bottom - 5), PURPLE, 1)

def nav_rect(target):
    x, y = target['x'] / 2, target['y'] / 2
    return (x, y, x + target['width'] / 2, y + target['height'] / 2)

def nav_button(target, label=None, size=9):
    x, y, right, bottom = nav_rect(target)
    disabled = target.get('disabled')
    focused, active = target.get('focused'), target.get('active')
    color = (64, 44, 98, 255) if focused else (43, 33, 64, 255) if active else (28, 28, 41, 255)
    ink = (87, 86, 106, 255) if disabled else INK if focused or active else MUTED
    box((x, y, right, bottom), color, 6, PURPLE if focused else (48, 43, 62, 255), 2 if focused else 1)
    label = str(label if label is not None else target.get('label') or '')
    measured = draw.textlength(label, font=font(size))
    text(x + max(2, (right - x - measured) / 2), y + max(1, (bottom - y - size - 2) / 2),
         label, size, ink, right - x - 4)

def sidebar():
    draw.rectangle((0, 0, 44, 359), fill=(12, 13, 20, 255))
    draw.line((44, 0, 44, 359), fill=(35, 34, 49, 255))
    draw.ellipse((11, 14, 33, 36), fill=PURPLE)
    draw.polygon(((20, 20), (20, 30), (28, 25)), fill=(255, 255, 255, 255))
    for item in (model.get('navigation') or {}).get('sidebar', []):
        focused, active = item.get('focused'), item.get('active')
        if focused or active:
            box(nav_rect(item), (48, 35, 75, 255) if focused else (29, 25, 42, 255), 7,
                PURPLE if focused else None, 2)
        icon = item['icon']
        x, y = icon['x'] / 2, icon['y'] / 2
        color = INK if focused or active else MUTED
        if item['id'] == 'home':
            draw.line(((x + 1, y + 7), (x + 8, y + 1), (x + 15, y + 7)), fill=color, width=2)
            draw.rectangle((x + 3, y + 7, x + 13, y + 15), outline=color, width=2)
        elif item['id'] == 'library':
            for dx in (0, 8):
                for dy in (0, 8):
                    box((x + 1 + dx, y + 1 + dy, x + 6 + dx, y + 6 + dy), color, 1)
        else:
            for dy in (0, 6, 12):
                draw.line((x + 1, y + 2 + dy, x + 15, y + 2 + dy), fill=color, width=2)
        caption = item['caption']
        label = str(item['label'])
        width = caption['width'] / 2
        text(caption['x'] / 2 + max(0, (width - draw.textlength(label, font=font(8))) / 2),
             caption['y'] / 2, label, 8, color, width)

def header():
    text(62, 11, 'Stremio', 17, INK)
    crumbs = model.get('breadcrumb') or [model.get('subtitle') or 'Discover']
    commands = (model.get('navigation') or {}).get('commands', [])
    end = min((item['x'] / 2 for item in commands), default=624)
    text(166, 17, '  /  '.join(str(v) for v in crumbs[-3:]), 10, MUTED, max(0, end - 176))
    for command in commands:
        nav_button(command, size=8)
    draw.line((62, 39, 624, 39), fill=(39, 38, 55, 255))

def hero_panel(hero, top=72, height=85):
    rect = (62, top, 625, top + height)
    box(rect, (28, 25, 44, 255), 10)
    backdrop = art(hero.get('background')) or art(hero.get('poster'))
    if backdrop:
        crop = ImageOps.fit(backdrop, (round(310 * SCALE), round(height * SCALE)), method=Image.Resampling.LANCZOS)
        image.paste(crop, (round(315 * SCALE), round(top * SCALE)))
        shade = Image.new('RGBA', (round(563 * SCALE), round(height * SCALE)))
        px = shade.load()
        for xx in range(shade.width):
            logical_x = xx / SCALE
            alpha = 255 if logical_x < 245 else int(245 - (logical_x - 245) * .55)
            for yy in range(shade.height):
                px[xx, yy] = (23, 22, 35, max(80, alpha))
        image.alpha_composite(shade, (round(62 * SCALE), round(top * SCALE)))
        draw.rounded_rectangle(rect, radius=10, outline=(50, 42, 69, 255))
    text(76, top + 8, hero.get('title') or model.get('title') or 'Discover something new', 23, INK, 493)
    parts = [hero.get('releaseInfo'), hero.get('type'), hero.get('runtime')]
    genres = hero.get('genres') or []
    if genres:
        parts.append(' · '.join(genres[:2]))
    text(77, top + 39, '  ·  '.join(str(v) for v in parts if v), 10, (185, 175, 207, 255), 510)
    notice = model.get('message')
    wrap(77, top + 56, notice or hero.get('description') or 'Browse your catalogs and choose something to watch.',
         500, 10, 1, (249, 211, 182, 255) if notice else MUTED)
    rating = hero.get('rating')
    if rating:
        box((577, top + 9, 615, top + 27), (37, 51, 43, 255), 5)
        text(584, top + 11, rating, 10, (163, 221, 183, 255), 27)

def page_buttons():
    for item in (model.get('navigation') or {}).get('paging', []):
        nav_button(item, '‹' if item['id'] == 'previous' else '›', 15)

def catalog_view():
    navigation = model.get('navigation') or {}
    for item in navigation.get('tabs', []):
        nav_button(item, size=9)
    for item in navigation.get('tabPaging', []):
        nav_button(item, '‹' if item['id'] == 'previousTabs' else '›', 15)
    cards = model.get('cards') or []
    by_index = {card.get('index'): card for card in cards}
    hero = model.get('hero') or {}
    hero_panel(hero)
    section = (model.get('catalog') or {}).get('name') or model.get('title') or 'Discover'
    text(64, 164, section, 13, INK, 410)
    count = model.get('count', len(cards))
    if cards:
        text(490, 167, str(int(model.get('selectedIndex', int(model.get('offset') or 0) + int(model.get('selected') or 0))) + 1) + ' / ' + str(count), 9, MUTED, 62)
        for target in navigation.get('cards', []):
            card = by_index.get(target['index'])
            if card is None:
                continue
            focused, selected = target.get('focused'), target.get('selected')
            poster(card, nav_rect(target['poster']), focused)
            catalog_title(card, nav_rect(target['title']), focused, selected, model.get('titleMarqueeMs', 0))
    else:
        box((64, 190, 624, 322), (25, 25, 38, 255), 10)
        text(85, 216, 'Nothing here yet', 19, INK)
        wrap(86, 249, model.get('message') or 'Choose a catalog above or open the sidebar.', 490, 11, 2)
    page_buttons()

def list_view():
    view = model.get('view', 'sources')
    navigation = model.get('navigation') or {}
    rows = model.get('rows') or []
    by_index = {row.get('index', int(model.get('offset') or 0) + index): row for index, row in enumerate(rows)}
    hero = model.get('hero') or {}
    if view == 'details':
        poster(hero, (64, 59, 194, 253))
        text(214, 57, hero.get('title') or model.get('title'), 23, INK, 409)
        meta = [hero.get('releaseInfo'), hero.get('type'), hero.get('runtime')]
        text(216, 90, '  ·  '.join(str(v) for v in meta if v), 10, PURPLE, 400)
        genres = hero.get('genres') or []
        if genres:
            text(216, 109, ' · '.join(genres[:3]), 10, MUTED, 400)
        wrap(216, 130, hero.get('description') or model.get('description'), 402, 11, 4)
        for target in navigation.get('actions', []):
            row = by_index.get(target['index'])
            if row is None:
                continue
            x, y, right, bottom = nav_rect(target)
            active = target.get('focused')
            box((x, y, right, bottom), (102, 68, 165, 255) if active else (31, 31, 46, 255), 6,
                PURPLE if active else None)
            text(x + 12, y + 4, row.get('label'), 11, INK if active else MUTED, right - x - 24)
        return
    text(64, 49, model.get('title') or ('Episodes' if view == 'episodes' else 'Choose a source'), 21, INK, 557)
    text(65, 79, model.get('subtitle'), 10, MUTED, 480)
    for target in navigation.get('rows', []):
        row = by_index.get(target['index'])
        if row is None:
            continue
        x, y, right, bottom = nav_rect(target)
        active, disabled = target.get('focused'), target.get('disabled')
        box((x, y, right, bottom), (70, 47, 111, 255) if active else (26, 27, 40, 255), 6,
            PURPLE if active else None)
        text(x + 12, y + 4, row.get('label'), 11, (116, 115, 132, 255) if disabled else INK if active else (193, 192, 209, 255), 415)
        text(right - 119, y + 6, row.get('detail'), 9, (189, 169, 218, 255), 106)
    if not rows:
        text(79, 147, 'No results yet', 18, INK)
        wrap(80, 180, model.get('message') or 'Try refreshing or choose another catalog.', 510, 11, 3)
    page_buttons()

def playback_view():
    playback = model.get('playback') or {}
    hero = model.get('hero') or {}
    backdrop = art(hero.get('background')) or art(hero.get('poster'))
    if backdrop:
        paste_cover(backdrop.filter(ImageFilter.GaussianBlur(9)), (45, 40, 640, 337), 0)
        image.alpha_composite(Image.new('RGBA', (round(595 * SCALE), round(297 * SCALE)), (9, 9, 17, 155)), (round(45 * SCALE), round(40 * SCALE)))
    text(76, 77, 'PAUSED' if playback.get('paused') else 'NOW PLAYING', 10, PURPLE)
    wrap(76, 100, model.get('title') or 'Stremio', 518, 26, 2, INK)
    text(77, 182, model.get('subtitle'), 12, MUTED, 510)
    position = float(playback.get('position') or 0)
    duration = float(playback.get('duration') or 0)
    ratio = max(0, min(1, position / duration)) if duration else 0
    box((77, 229, 611, 233), (74, 66, 93, 255), 2)
    if ratio:
        box((77, 229, 77 + int(534 * ratio), 233), PURPLE, 2)
    def clock(value):
        return str(int(max(0, value)) // 60) + ':' + str(int(max(0, value)) % 60).zfill(2)
    text(77, 242, clock(position), 11, INK)
    text(561, 242, clock(duration), 11, MUTED, 50)
    text(77, 284, 'X / +  Controls    L / R  Episode    ZL / ZR  Seek', 11, MUTED, 530)

def subtitle_overlay(state):
    source_lines = model.get('subtitleLines') or []
    if not source_lines:
        return
    picker = state.get('visible') and state.get('mode', 'controls') != 'controls'
    size, line_height = (14, 17) if picker else (17, 22)
    lines = []
    for source_line in source_lines[:3]:
        current = ''
        for word in str(source_line)[:200].split():
            candidate = (current + ' ' + word).strip()
            if current and draw.textlength(candidate, font=font(size)) > 548:
                lines.append(current)
                current = word
            else:
                current = candidate
        if current:
            lines.append(current)
    lines = lines[:3]
    if not lines:
        return
    bottom = 356 if picker else 195 if state.get('visible') else 329
    top = bottom - len(lines) * line_height - (2 if picker else 6)
    box((40, top - 3, 600, bottom + 3), (0, 0, 0, 188), 7)
    for index, line in enumerate(lines):
        x = max(46, (640 - draw.textlength(line, font=font(size))) / 2)
        text(x, top + index * line_height, line, size, (255, 255, 255, 255), 548)

def media_options(state):
    box((130, 63, 510, 300), (18, 16, 29, 242), 13, (91, 72, 124, 255))
    text(146, 71, 'Audio language' if state.get('mode') == 'audio' else 'Subtitles', 20, INK, 348)
    rows = state.get('optionRows') or []
    for row in rows:
        x, y, right, bottom = nav_rect(row)
        focused, disabled = row.get('focused'), row.get('disabled')
        box((x, y, right, bottom), (77, 49, 123, 255) if focused else (32, 29, 45, 255), 6,
            PURPLE if focused else None)
        color = (105, 100, 119, 255) if disabled else INK
        draw.ellipse((x + 8, y + 7, x + 17, y + 16), outline=color, width=1)
        if row.get('selected'):
            draw.ellipse((x + 11, y + 10, x + 14, y + 13), fill=PURPLE)
        text(x + 25, y + 4, row.get('label'), 11, color, right - x - 33)
    if not rows:
        wrap(148, 115, 'No audio tracks were found in this source.', 342, 13, 3, MUTED)
    for target in state.get('optionPaging') or []:
        nav_button(target, size=11)
    text(147, 284, state.get('message') or '↑ / ↓  Choose     A  Select     B  Back', 10, MUTED, 346)

def playback_overlay():
    state = model.get('playbackOverlay') or {}
    if not state.get('visible'):
        subtitle_overlay(state)
        return
    # Transparent artwork is composited over the actual video frame on the Mac.
    for y in range(100):
        draw.line((0, y, 640, y), fill=(5, 5, 12, max(0, 185 - y * 2)), width=1)
    for y in range(175, 360):
        draw.line((0, y, 640, y), fill=(5, 5, 12, min(215, (y - 175) * 2)), width=1)
    text(40, 27, 'STREMIO', 10, PURPLE)
    picker = state.get('mode', 'controls') != 'controls'
    text(40, 42 if picker else 45, state.get('title') or model.get('title'), 16 if picker else 22, INK, 510)
    close = state.get('close') or {}
    cx, cy = close.get('x', 1134) / 2, close.get('y', 58) / 2
    box((cx, cy, cx + 32, cy + 32), (23, 23, 35, 205), 16)
    draw.line((cx + 11, cy + 11, cx + 21, cy + 21), fill=INK, width=2)
    draw.line((cx + 21, cy + 11, cx + 11, cy + 21), fill=INK, width=2)
    if state.get('mode', 'controls') != 'controls':
        media_options(state)
        subtitle_overlay(state)
        return
    subtitle_overlay(state)
    box((40, 208, 600, 320), (20, 18, 31, 225), 14, (76, 64, 101, 255))
    seekbar = state.get('seekbar') or {}
    x, y = seekbar.get('x', 110) / 2, seekbar.get('y', 456) / 2
    width = seekbar.get('width', 1060) / 2
    ratio = max(0, min(1, float(state.get('ratio') or 0)))
    box((x, y + 7, x + width, y + 10), (77, 72, 91, 255), 2)
    if ratio:
        box((x, y + 7, x + width * ratio, y + 10), PURPLE, 2)
    draw.ellipse((x + width * ratio - 4, y + 4, x + width * ratio + 4, y + 12), fill=INK)
    text(x, y + 17, state.get('timeLabel'), 11, INK, 250)
    for control in state.get('controls', []):
        x, y = control['x'] / 2, control['y'] / 2
        width, height = control['width'] / 2, control['height'] / 2
        disabled, focused = control.get('disabled'), control.get('focused')
        color = (58, 44, 86, 245) if focused and not disabled else (32, 30, 44, 230)
        ink = (106, 102, 123, 255) if disabled else INK
        box((x, y, x + width, y + height), color, 9, PURPLE if focused else None, 2)
        icon_x, icon_y = x + width / 2, y + 11
        control_id = control.get('id')
        if control_id == 'playPause':
            if state.get('paused'):
                draw.polygon(((icon_x - 3, icon_y - 5), (icon_x - 3, icon_y + 5), (icon_x + 5, icon_y)), fill=ink)
            else:
                draw.rectangle((icon_x - 5, icon_y - 5, icon_x - 2, icon_y + 5), fill=ink)
                draw.rectangle((icon_x + 2, icon_y - 5, icon_x + 5, icon_y + 5), fill=ink)
        elif control_id == 'stop':
            box((icon_x - 5, icon_y - 5, icon_x + 5, icon_y + 5), ink, 1)
        elif control_id == 'audio':
            draw.polygon(((icon_x - 7, icon_y - 2), (icon_x - 3, icon_y - 2), (icon_x + 1, icon_y - 6),
                          (icon_x + 1, icon_y + 6), (icon_x - 3, icon_y + 2), (icon_x - 7, icon_y + 2)), fill=ink)
            draw.line(((icon_x + 4, icon_y - 4), (icon_x + 7, icon_y), (icon_x + 4, icon_y + 4)), fill=ink, width=1)
        elif control_id == 'subtitles':
            box((icon_x - 9, icon_y - 6, icon_x + 9, icon_y + 6), None, 2, ink, 1)
            text(icon_x - 6, icon_y - 5, 'CC', 8, ink, 15)
        else:
            direction = -1 if control_id == 'prevEpisode' else 1
            for offset in (-2, 3):
                draw.polygon(((icon_x + offset - direction * 4, icon_y - 5),
                    (icon_x + offset - direction * 4, icon_y + 5),
                    (icon_x + offset + direction * 3, icon_y)), fill=ink)
        label = str(control.get('label') or '')
        text(x + (width - draw.textlength(label, font=font(9))) / 2, y + 23, label, 9, ink, width - 8)
    message = state.get('message')
    text(55, 326, message or 'L / R  Episode    Hold ZL / ZR or left stick  Seek    Drag timeline    B  Hide', 10, INK if message else MUTED, 535)

def render_frame(raw):
    global model, image, draw
    if len(raw) > 65536:
        raise ValueError('Menu model too large')
    model = json.loads(raw)
    image = Image.new('RGBA', (args.width, args.height), (0, 0, 0, 0) if args.overlay else (17, 18, 27, 255))
    draw = ScaledDraw(image)
    view = model.get('view') or ('catalog' if model.get('cards') else 'sources')
    if args.overlay:
        playback_overlay()
    else:
        sidebar()
        header()
        if view == 'catalog':
            catalog_view()
        elif view == 'playing':
            playback_view()
        else:
            list_view()
        message = str(model.get('message') or '')
        if message and view != 'catalog':
            box((63, 312, 624, 335), (66, 44, 39, 255), 6)
            text(73, 317, message, 10, (249, 211, 182, 255), 540)
        draw.rectangle((45, 339, 639, 359), fill=(14, 15, 23, 255))
        text(64, 344, model.get('footer') or '↑ ↓ Browse    A Open    B Back    Y Catalog', 9, MUTED, 557)
    return image.convert('RGBA').tobytes()

if args.worker:
    while True:
        raw = sys.stdin.buffer.readline(65538)
        if not raw:
            break
        if not raw.endswith(b'\n'):
            raise ValueError('Incomplete menu request')
        sys.stdout.buffer.write(render_frame(raw[:-1]))
        sys.stdout.buffer.flush()
else:
    sys.stdout.buffer.write(render_frame(sys.stdin.buffer.read(65537)))
