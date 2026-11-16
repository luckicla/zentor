"""The MixUp logo: the fanzine tile of the first MixUp icon (acid paper with
a black edge and a pink shadow), now with the «Up»: an arrow pointing up whose
shaft is the peak of a sound wave (equalizer bars), cut by a glitch slice.

    python3 tools/mkicon_mixup.py web/mixup.png android/app/src/main/res

Writes a 512 px tile on transparent, like web/icono.png (the old logo, which
stays as the «Legacy» icon).
"""
import sys
from PIL import Image, ImageDraw

S = 2048                       # drawn at 4x, saved at 512
INK = (10, 10, 13)
ACID = (200, 255, 0)
PINK = (255, 46, 136)


def P(pts, ox, oy, k):
    return [(ox + x * k, oy + y * k) for x, y in pts]


def main(out):
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # the paper tile, a bit crooked, and its pink shadow behind
    tile = [(330, 230), (1150, 260), (1790, 330), (1700, 1790), (290, 1660), (250, 900)]
    shadow = [(x + 150, y + 150) for x, y in tile]
    d.polygon(shadow, fill=PINK + (255,))
    d.polygon(tile, fill=INK + (255,))
    inner = [(400, 300), (1150, 330), (1715, 395), (1630, 1715), (360, 1590), (322, 900)]
    d.polygon(inner, fill=ACID + (255,))

    # «Up»
    art = Image.new('L', (S, S), 0)
    ad = ImageDraw.Draw(art)
    # a sound wave (five bars, the loudest in the middle) whose peak is the
    # arrow going up
    cx, base, w, gap = 1030, 1600, 165, 60
    tops = [1230, 980, 720, 980, 1230]
    for i, y0 in enumerate(tops):
        x0 = cx - 2.5 * w - 2 * gap + i * (w + gap)
        ad.rectangle((x0, y0, x0 + w, base), fill=255)
    ad.polygon([(cx, 330), (cx + 330, 760), (cx - 330, 760)], fill=255)
    art = art.rotate(4, resample=Image.BICUBIC, center=(cx, 1000))
    # a glitch slice across the arrowhead, as the old Z had
    y0, y1, dx = 560, 630, 50
    band = art.crop((0, y0, S, y1))
    art.paste(0, (0, y0, S, y1))
    art.paste(band, (dx, y0))
    # the pink peeking out of the slice
    peek = Image.new('L', (S, S), 0)
    peek.paste(band, (dx - 34, y0))
    pk = Image.new('RGBA', (S, S), PINK + (255,))
    pk.putalpha(peek)
    img.alpha_composite(pk)
    letter = Image.new('RGBA', (S, S), INK + (255,))
    letter.putalpha(art)
    img.alpha_composite(letter)

    img.resize((512, 512), Image.LANCZOS).save(out, optimize=True)




def status_icon(res):
    """The small white notification icon (drawable-*/ic_stat_mixup.png): the
    same arrow and bars, alone."""
    m = Image.new('L', (S, S), 0)
    d = ImageDraw.Draw(m)
    cx, base, w, gap = 1024, 1820, 230, 80
    tops = [1340, 1060, 760, 1060, 1340]
    for i, y0 in enumerate(tops):
        x0 = cx - 2.5 * w - 2 * gap + i * (w + gap)
        d.rectangle((x0, y0, x0 + w, base), fill=255)
    d.polygon([(cx, 220), (cx + 470, 800), (cx - 470, 800)], fill=255)
    for name, px in (('mdpi', 24), ('hdpi', 36), ('xhdpi', 48), ('xxhdpi', 72), ('xxxhdpi', 96)):
        out = Image.new('RGBA', (S, S), (255, 255, 255, 0))
        out.putalpha(m)
        out.resize((px, px), Image.LANCZOS).save(f'{res}/drawable-{name}/ic_stat_mixup.png', optimize=True)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'web/mixup.png')
    if len(sys.argv) > 2:  # and the notification icon into this res/ folder
        status_icon(sys.argv[2])
