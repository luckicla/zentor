"""The MixUp logos. The main one is the mark (mixup_mark); the other two are
the fanzine tile of the first ZenTor icon with the «Up» drawn another way.
They're all app icons you can pick (Ajustes → Icono de la app):

  mixup      the mark: two play buttons pointing up, side by side, an M with
             the hole where they meet and, in it, a little arrow of sound bars
             going up (the default)
  mixblend   the same, a step apart, their overlap in light (a crossfade)
  mixstack   the two, one over the other («skip up»)
  mixstep    one over the other, the overlap cut out (a step up)
  mixeq      an arrow growing out of equalizer bars
  mixm       a heavy M with a pink arrow sticker in the corner

    python3 tools/mkicon_mixup.py web android/app/src/main/res

Writes web/<name>.png (512 px tiles on transparent, like web/icono.png, the
old logo that stays as «Legacy») and the white notification icon.
"""
import sys
from PIL import Image, ImageDraw

S = 2048                       # drawn at 4x, saved at 512
INK = (10, 10, 13)
ACID = (200, 255, 0)
PINK = (255, 46, 136)


def P(pts, ox, oy, k):
    return [(ox + x * k, oy + y * k) for x, y in pts]


def tile():
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # the paper tile, a bit crooked, and its pink shadow behind
    t = [(330, 230), (1150, 260), (1790, 330), (1700, 1790), (290, 1660), (250, 900)]
    d.polygon([(x + 150, y + 150) for x, y in t], fill=PINK + (255,))
    d.polygon(t, fill=INK + (255,))
    d.polygon([(400, 300), (1150, 330), (1715, 395), (1630, 1715), (360, 1590), (322, 900)], fill=ACID + (255,))
    return img


def glitch(img, art, y0, y1, dx=48):
    """A slice of the drawing pushed sideways (as the old Z had), pink peeking out."""
    band = art.crop((0, y0, S, y1))
    art.paste(0, (0, y0, S, y1))
    art.paste(band, (dx, y0))
    peek = Image.new('L', (S, S), 0)
    peek.paste(band, (dx - 30, y0))
    pk = Image.new('RGBA', (S, S), PINK + (255,))
    pk.putalpha(peek)
    img.alpha_composite(pk)


def ink(img, art):
    layer = Image.new('RGBA', (S, S), INK + (255,))
    layer.putalpha(art)
    img.alpha_composite(layer)


def arrow(ad, cx, top, base, head_w, head_h, shaft_w):
    ad.polygon([(cx, top), (cx + head_w, top + head_h), (cx + shaft_w, top + head_h), (cx + shaft_w, base),
                (cx - shaft_w, base), (cx - shaft_w, top + head_h), (cx - head_w, top + head_h)], fill=255)


def headphones():
    img = tile()
    art = Image.new('L', (S, S), 0)
    ad = ImageDraw.Draw(art)
    cx, cy, R, w = 1030, 1080, 470, 120
    ad.arc((cx - R, cy - R, cx + R, cy + R), 180, 360, fill=255, width=w)    # the band
    for x in (cx - R - 30, cx + R - 150):                                     # the ear cups
        ad.rounded_rectangle((x, cy - 40, x + 180, cy + 420), radius=70, fill=255)
    for x in (cx - R + 60, cx + R - 60):                                      # band to cup
        ad.rectangle((x - w // 2, cy - 60, x + w // 2, cy + 40), fill=255)
    arrow(ad, cx, 700, 1500, 200, 260, 75)
    art = art.rotate(4, resample=Image.BICUBIC, center=(cx, 1080))
    glitch(img, art, 840, 900, 46)
    ink(img, art)
    return img


def eq():
    img = tile()
    art = Image.new('L', (S, S), 0)
    ad = ImageDraw.Draw(art)
    cx, base, w, gap = 1030, 1600, 165, 60
    for i, y0 in enumerate([1230, 980, 720, 980, 1230]):
        x0 = cx - 2.5 * w - 2 * gap + i * (w + gap)
        ad.rectangle((x0, y0, x0 + w, base), fill=255)
    ad.polygon([(cx, 330), (cx + 330, 760), (cx - 330, 760)], fill=255)
    art = art.rotate(4, resample=Image.BICUBIC, center=(cx, 1000))
    glitch(img, art, 560, 630, 50)
    ink(img, art)
    return img


def letter_m():
    img = tile()
    art = Image.new('L', (S, S), 0)
    ad = ImageDraw.Draw(art)
    M = [(0, 100), (0, 0), (25, 0), (50, 36), (75, 0), (100, 0), (100, 100), (75, 100), (75, 44), (50, 78), (25, 44), (25, 100)]
    ad.polygon(P(M, 520, 560, 10.4), fill=255)
    art = art.rotate(3, resample=Image.BICUBIC, center=(1040, 1080))
    glitch(img, art, 1060, 1180, 70)
    ink(img, art)
    # the «Up»: a pink arrow sticker in the top corner, black edged
    a = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(a)
    shape = [(0, 40), (40, 0), (80, 40), (56, 40), (56, 100), (24, 100), (24, 40)]
    ox, oy, k = 1450, 120, 4.6
    for ex, ey in ((-34, 0), (34, 0), (0, -34), (0, 34), (-24, -24), (24, 24), (-24, 24), (24, -24)):
        d.polygon(P(shape, ox + ex, oy + ey, k), fill=INK + (255,))
    d.polygon(P(shape, ox, oy, k), fill=PINK + (255,))
    img.alpha_composite(a.rotate(-12, resample=Image.BICUBIC, center=(ox + 40 * k, oy + 50 * k)))
    return img


def disc():
    img = tile()
    d = ImageDraw.Draw(img)
    cx, cy, R = 1030, 1040, 600
    d.ellipse((cx - R, cy - R, cx + R, cy + R), fill=INK + (255,))
    for r in (520, 450, 380):                                  # the grooves
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(60, 60, 70, 255), width=10)
    d.arc((cx - 560, cy - 560, cx + 560, cy + 560), 200, 250, fill=ACID + (255,), width=26)   # a shine
    d.ellipse((cx - 250, cy - 250, cx + 250, cy + 250), fill=PINK + (255,))                  # the label
    art = Image.new('L', (S, S), 0)
    arrow(ImageDraw.Draw(art), cx, cy - 190, cy + 190, 150, 170, 55)
    ink(img, art)
    return img


def cross():
    img = tile()
    art = Image.new('L', (S, S), 0)
    ad = ImageDraw.Draw(art)
    cx, meet, w = 1030, 1080, 130
    ad.line([(620, 1620), (cx, meet)], fill=255, width=w)      # two songs…
    ad.line([(1440, 1620), (cx, meet)], fill=255, width=w)
    ad.ellipse((cx - w // 2, meet - w // 2, cx + w // 2, meet + w // 2), fill=255)
    arrow(ad, cx, 380, meet, 300, 380, w // 2)                 # …that go on up as one
    art = art.rotate(4, resample=Image.BICUBIC, center=(cx, 1000))
    glitch(img, art, 600, 670, 50)
    ink(img, art)
    return img


def _rtri(pts, r):
    from PIL import ImageFilter
    m = Image.new('L', (S, S), 0)
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m.filter(ImageFilter.GaussianBlur(r)).point(lambda v: 255 if v > 128 else 0).filter(ImageFilter.GaussianBlur(2))


def mark_masks():
    """The MixUp mark: two play buttons pointing up (the «Up»), one a step
    higher than the other, overlapping like two songs in a crossfade (the
    «Mix»). Together they're an M. Masks of the two, centred on the canvas."""
    w, h, dx, dy = 900, 830, 380, 90
    left = (S - (w + dx)) / 2 + w / 2
    top = (S - (h + dy)) / 2
    a = _rtri([(left, top + dy), (left + w / 2, top + dy + h), (left - w / 2, top + dy + h)], 64)
    b = _rtri([(left + dx, top), (left + dx + w / 2, top + h), (left + dx - w / 2, top + h)], 64)
    return a, b


def _icon(a, b, ca=ACID, cb=PINK, ov=(236, 230, 214)):
    """Two shapes on ink in a rounded square, their overlap in its own colour."""
    from PIL import ImageChops
    # (a bit bigger than drawn: the mark fills about 60 % of the square, like
    # the best app icons; smaller, it looked lost at home-screen sizes)
    def grow(m, k=1.22):
        n = round(S / k); o = (S - n) // 2
        return m.crop((o, o, o + n, o + n)).resize((S, S), Image.LANCZOS)
    a, b = grow(a), grow(b)
    img = Image.new('RGBA', (S, S), INK + (255,))
    for m, c in ((a, ca), (b, cb)):
        l = Image.new('RGBA', (S, S), c + (255,)); l.putalpha(m); img.alpha_composite(l)
    o = ImageChops.multiply(a, b)
    l = Image.new('RGBA', (S, S), ov + (255,)); l.putalpha(o); img.alpha_composite(l)
    sq = Image.new('L', (S, S), 0)
    ImageDraw.Draw(sq).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.225), fill=255)
    out = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    out.paste(img, (0, 0), sq)
    return out


def mixup_mark():
    """The app icon: the mark on ink, in a rounded square (the one in the
    window, the installer, the web)."""
    return _icon(*mark_masks())


def _tri(cx, top, w, h, r=64):
    return _rtri([(cx, top), (cx + w / 2, top + h), (cx - w / 2, top + h)], r)


def mixup_stack():
    """The same two play buttons, one over the other: «skip up»."""
    return _icon(_tri(1024, 844, 1080, 780), _tri(1024, 424, 1080, 780))


def up_bars(d, cx, cy, k, fill):
    """The little «Up» in the hole of the M: three sound bars, the middle one
    the tallest and ending in an arrowhead. About 300·k px tall, centred."""
    bw, gap = 48 * k, 26 * k
    base = cy + 150 * k
    for dx, top in ((-(bw + gap), cy + 30 * k), ((bw + gap), cy + 30 * k)):
        d.rounded_rectangle((cx + dx - bw / 2, top, cx + dx + bw / 2, base), radius=bw / 2.6, fill=fill)
    d.rounded_rectangle((cx - bw / 2, cy - 40 * k, cx + bw / 2, base), radius=bw / 2.6, fill=fill)
    d.polygon([(cx, cy - 150 * k), (cx + 92 * k, cy - 34 * k), (cx - 92 * k, cy - 34 * k)], fill=fill)


def mixup_open():
    """Side by side at the same height, the overlap cut out: an open M, and in
    its hole a little arrow going up out of sound bars."""
    img = _icon(_tri(880, 560, 960, 930, 72), _tri(1168, 560, 960, 930, 72), ov=INK)
    up_bars(ImageDraw.Draw(img), 1024, 1318, 0.95, (236, 230, 214, 255))
    return img


def mixup_step():
    """One over the other, the overlap cut out: a step going up."""
    return _icon(_tri(1024, 380, 1120, 840, 72), _tri(1024, 820, 1120, 840, 72), ca=PINK, cb=ACID, ov=INK)


# (the headphones and the rest were drafts: the M of two play buttons is MixUp's;
# the equalizer arrow and the M with the sticker stay as icons you can pick)
VARIANTS = {'mixup': mixup_open, 'mixblend': mixup_mark, 'mixstack': mixup_stack, 'mixstep': mixup_step, 'mixeq': eq, 'mixm': letter_m}


def status_icon(res):
    """The small white notification icon (drawable-*/ic_stat_mixup.png): the
    mark (the M of two play buttons, with its hole), in white."""
    from PIL import ImageChops
    a, b = _tri(880, 560, 960, 930, 72), _tri(1168, 560, 960, 930, 72)
    m = ImageChops.subtract(ImageChops.lighter(a, b), ImageChops.multiply(a, b))
    up_bars(ImageDraw.Draw(m), 1024, 1270, 0.78, 255)
    box = m.getbbox()
    m = m.crop(box)
    k = 1700 / max(m.size)
    m = m.resize((round(m.width * k), round(m.height * k)), Image.LANCZOS)
    full = Image.new('L', (S, S), 0)
    full.paste(m, ((S - m.width) // 2, (S - m.height) // 2))
    for name, px in (('mdpi', 24), ('hdpi', 36), ('xhdpi', 48), ('xxhdpi', 72), ('xxxhdpi', 96)):
        out = Image.new('RGBA', (S, S), (255, 255, 255, 0))
        out.putalpha(full)
        out.resize((px, px), Image.LANCZOS).save(f'{res}/drawable-{name}/ic_stat_mixup.png', optimize=True)


if __name__ == '__main__':
    web = sys.argv[1] if len(sys.argv) > 1 else 'web'
    for name, fn in VARIANTS.items():
        fn().resize((512, 512), Image.LANCZOS).save(f'{web}/{name}.png', optimize=True)
    if len(sys.argv) > 2:  # and the notification icon into this res/ folder
        status_icon(sys.argv[2])
