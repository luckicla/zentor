"""Six app-icon concepts for ZenTor, drawn flat on the dark background.

    python3 tools/icon_concepts.py out_dir

Writes concept-N.png (1024px, full adaptive canvas) for each and a
comparison sheet (sheet.png) with each one masked as a circle at three sizes.
"""
import math
import sys
from PIL import Image, ImageDraw, ImageFont

S = 2048                      # drawn at 2x, saved at 1024
INK = (10, 10, 13)
LAV = (185, 166, 255)
RED = (255, 143, 143)
CREAM = (240, 234, 220)
FONT = '/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf'
C = S // 2


def canvas():
    return Image.new('RGBA', (S, S), INK + (255,))


def glyph(ch, height):
    """Mask of one Poppins Bold glyph, cropped, scaled to `height`."""
    font = ImageFont.truetype(FONT, 1200)
    m = Image.new('L', (2400, 2400), 0)
    ImageDraw.Draw(m).text((400, 200), ch, font=font, fill=255)
    m = m.crop(m.getbbox())
    k = height / m.height
    return m.resize((round(m.width * k), round(m.height * k)), Image.LANCZOS)


def paste_center(dst, mask, color, cx=C, cy=C):
    layer = Image.new('RGBA', mask.size, color + (255,))
    layer.putalpha(mask)
    dst.alpha_composite(layer, (round(cx - mask.width / 2), round(cy - mask.height / 2)))


def slice_shift(img, y, h, dx, edge_left, edge_right, edge=40):
    """Glitch: move a horizontal band of the artwork sideways, with flat
    coloured edges peeking out where it moved. `img` is art on a
    transparent background."""
    band = img.crop((0, y, S, y + h))
    img.paste((0, 0, 0, 0), (0, y, S, y + h))
    art = band.getchannel('A')
    for off, col in ((dx - edge, edge_left), (dx + edge, edge_right)):
        lay = Image.new('RGBA', band.size, col + (255,))
        lay.putalpha(art)
        img.alpha_composite(lay, (max(off, 0), y), (max(-off, 0), 0))
    img.alpha_composite(band, (max(dx, 0), y), (max(-dx, 0), 0))


def blank():
    return Image.new('RGBA', (S, S), (0, 0, 0, 0))


# 1 · Ransom tile: a Z cut out of paper, like the letters of the CD cover
def concept_ransom():
    img = canvas()
    tile = [(-300, -320), (40, -345), (310, -305), (290, 10), (320, 330), (-20, 305), (-310, 320), (-295, -10)]
    def poly(dx, dy, ang):
        a = math.radians(ang)
        return [(C + dx + x * math.cos(a) - y * math.sin(a), C + dy + x * math.sin(a) + y * math.cos(a)) for x, y in tile]
    d = ImageDraw.Draw(img)
    d.polygon(poly(46, 46, -7), fill=RED)
    d.polygon(poly(0, 0, -7), fill=LAV)
    z = glyph('Z', 400).rotate(7, resample=Image.BICUBIC, expand=True)
    paste_center(img, z, INK)
    # a strip of tape across the top-left corner
    tape = Image.new('RGBA', (300, 70), CREAM + (215,))
    tape = tape.rotate(35, resample=Image.BICUBIC, expand=True)
    img.alpha_composite(tape, (C - 400, C - 430))
    return img


# 2 · Glitch disc: a record / CD, sliced and shifted
def concept_disc():
    img = blank()
    d = ImageDraw.Draw(img)
    R = 330
    d.ellipse((C - R, C - R, C + R, C + R), fill=LAV)
    for r in (280, 238):
        d.ellipse((C - r, C - r, C + r, C + r), outline=INK, width=10)
    d.ellipse((C - 130, C - 130, C + 130, C + 130), fill=RED)
    d.ellipse((C - 26, C - 26, C + 26, C + 26), fill=INK)
    slice_shift(img, C - 150, 110, 70, RED, CREAM)
    out = canvas(); out.alpha_composite(img)
    return out


# 3 · Waveform: the progress bar of the player, as an icon
def concept_wave():
    img = canvas()
    d = ImageDraw.Draw(img)
    heights = [0.30, 0.55, 0.85, 0.60, 1.00, 0.70, 0.45, 0.80, 0.50, 0.30]
    n, bw, gap = len(heights), 52, 26
    total = n * bw + (n - 1) * gap
    x = C - total / 2
    played = 6
    for i, h in enumerate(heights):
        hh = 560 * h
        col = RED if i < played else LAV
        d.rounded_rectangle((x, C - hh / 2, x + bw, C + hh / 2), radius=bw / 2, fill=col)
        x += bw + gap
    px = C - total / 2 + played * (bw + gap) - gap / 2
    d.rounded_rectangle((px - 7, C - 330, px + 7, C + 330), radius=7, fill=CREAM)
    return img


# 4 · Overlap monogram: Z and R sharing a stroke, the overlap in a deeper tone
def concept_overlap():
    img = canvas()
    z, r = glyph('Z', 520), glyph('R', 520)
    w = z.width + r.width - 110
    zx, rx = C - w / 2 + z.width / 2, C + w / 2 - r.width / 2
    mz = Image.new('L', (S, S), 0)
    mr = Image.new('L', (S, S), 0)
    mz.paste(z, (round(zx - z.width / 2), round(C - z.height / 2)))
    mr.paste(r, (round(rx - r.width / 2), round(C - r.height / 2)))
    from PIL import ImageChops
    both = ImageChops.multiply(mz, mr)
    for m, col in ((mz, LAV), (mr, RED), (both, (128, 84, 170))):
        lay = Image.new('RGBA', (S, S), col + (255,))
        lay.putalpha(m)
        img.alpha_composite(lay)
    return img


# 5 · Glitched play button
def concept_play():
    img = blank()
    d = ImageDraw.Draw(img)
    # rounded triangle: draw a fat polygon then soften with a stroked outline
    pts = [(C - 250, C - 330), (C - 250, C + 330), (C + 310, C)]
    d.polygon(pts, fill=LAV)
    d.line(pts + [pts[0]], fill=LAV, width=70, joint='curve')
    for x, y in pts:
        d.ellipse((x - 35, y - 35, x + 35, y + 35), fill=LAV)
    slice_shift(img, C + 60, 110, 60, RED, CREAM)
    out = canvas(); out.alpha_composite(img)
    return out


# 6 · Viewfinder: the corner brackets around the cover, framing a Z
def concept_frame():
    img = canvas()
    d = ImageDraw.Draw(img)
    a, L, t = 330, 150, 46
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = C + sx * a, C + sy * a
            d.rectangle(sorted([x, x - sx * L])[:1] + [min(y, y - sy * t)] + sorted([x, x - sx * L])[1:] + [max(y, y - sy * t)], fill=RED)
            d.rectangle([min(x, x - sx * t), min(y, y - sy * L), max(x, x - sx * t), max(y, y - sy * L)], fill=RED)
    paste_center(img, glyph('Z', 380), LAV)
    return img


CONCEPTS = [
    ('Recorte', concept_ransom),
    ('Disco glitch', concept_disc),
    ('Onda', concept_wave),
    ('Monograma', concept_overlap),
    ('Play glitch', concept_play),
    ('Visor', concept_frame),
]


def main(out):
    font = ImageFont.truetype(FONT, 34)
    cols, cell = 3, 560
    sheet = Image.new('RGBA', (cols * cell, 2 * (cell + 120)), (232, 232, 232, 255))
    circle = Image.new('L', (1024, 1024), 0)
    ImageDraw.Draw(circle).ellipse((0, 0, 1023, 1023), fill=255)
    for i, (name, fn) in enumerate(CONCEPTS):
        art = fn().resize((1024, 1024), Image.LANCZOS)
        art.save(f'{out}/concept-{i + 1}.png')
        view = art.crop((171, 171, 853, 853)).resize((1024, 1024), Image.LANCZOS)
        c = Image.new('RGBA', (1024, 1024), (232, 232, 232, 255))
        c.paste(view, (0, 0), circle)
        x, y = (i % cols) * cell, (i // cols) * (cell + 120)
        sheet.paste(c.resize((440, 440), Image.LANCZOS), (x + 20, y + 20))
        sheet.paste(c.resize((112, 112), Image.LANCZOS), (x + 20, y + 476))
        sheet.paste(c.resize((56, 56), Image.LANCZOS), (x + 150, y + 476))
        ImageDraw.Draw(sheet).text((x + 230, y + 500), f'{i + 1} · {name}', fill=(30, 30, 30), font=font)
    sheet.save(f'{out}/sheet.png')


if __name__ == '__main__':
    main(sys.argv[1])
