"""ZR glitch launcher icon for the Android app.

Writes the adaptive icon layers (background, foreground, monochrome) and the
legacy square icon for every density into the given res/ folder.
"""
import random
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter

S = 1024                      # 108dp canvas
INK = (10, 10, 13)
PAPER = (240, 234, 220)
ACID = (200, 255, 0)
PINK = (255, 46, 136)


def letters_mask(scale=1.0):
    """White ZR on black, centered in the 66dp safe zone."""
    m = Image.new('L', (S, S), 0)
    d = ImageDraw.Draw(m)
    h = 420 * scale            # cap height
    t = 96 * scale             # stroke
    c = 30 * scale             # chamfer
    wz, wr, gap = 250 * scale, 262 * scale, 30 * scale
    x0 = (S - (wz + gap + wr)) / 2
    y0 = (S - h) / 2

    # Z
    z = [(0, 0), (wz - c, 0), (wz, c), (wz, t), (t * 1.15, h - t), (wz, h - t), (wz, h),
         (c, h), (0, h - c), (0, h - t), (wz - t * 1.15, t), (0, t)]
    d.polygon([(x0 + x, y0 + y) for x, y in z], fill=255)

    # R: stem + chamfered bowl with a counter + leg
    xr = x0 + wz + gap
    bh = h * 0.56
    bowl = [(0, 0), (wr - c * 1.6, 0), (wr, c * 1.6), (wr, bh - c * 1.6), (wr - c * 1.6, bh), (0, bh)]
    d.polygon([(xr + x, y0 + y) for x, y in bowl], fill=255)
    ct = t * 0.8
    counter = [(t, ct), (wr - ct - c * 0.5, ct), (wr - ct, ct + c * 0.5), (wr - ct, bh - ct - c * 0.5),
               (wr - ct - c * 0.5, bh - ct), (t, bh - ct)]
    d.polygon([(xr + x, y0 + y) for x, y in counter], fill=0)
    d.rectangle((xr, y0, xr + t, y0 + h), fill=255)
    leg = [(t * 0.9, bh - 2), (t * 0.9 + t * 1.1, bh - 2), (wr, h - t * 0.1), (wr, h), (wr - t * 1.1, h)]
    d.polygon([(xr + x, y0 + y) for x, y in leg], fill=255)
    return m


def shift(img, dx, dy=0):
    out = Image.new(img.mode, img.size, 0)
    out.paste(img, (dx, dy))
    return out


def tint(mask, color, alpha=255):
    layer = Image.new('RGBA', (S, S), color + (0,))
    layer.putalpha(mask.point(lambda v: v * alpha // 255))
    return layer


def slice_bands(img, bands):
    """Shift horizontal bands of an image sideways (the glitch tears)."""
    out = img.copy()
    for y, hgt, dx in bands:
        band = img.crop((0, y, S, y + hgt))
        out.paste(Image.new(img.mode, (S, hgt), 0), (0, y))
        out.paste(band, (dx, y))
    return out


def foreground(rng):
    m = letters_mask()
    # two clean tears: one wide band pushed right, one thin sliver pushed left
    bands = [(404, 40, 26), (566, 12, -20)]
    m_torn = slice_bands(m, bands)

    fg = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    # chromatic split: pink to the left, acid to the right
    fg.alpha_composite(tint(shift(m_torn, -12, -3), PINK, 230))
    fg.alpha_composite(tint(shift(m_torn, 12, 3), ACID, 230))
    fg.alpha_composite(tint(m_torn, PAPER))

    # inside the wide tear only the acid channel survives: a clean solid slice
    y, hgt = 404, 40
    fg.paste((0, 0, 0, 0), (0, y, S, y + hgt))
    fg.alpha_composite(tint(shift(m, 26), ACID).crop((0, y, S, y + hgt)), (0, y))
    fg.alpha_composite(tint(shift(m, -6), PINK, 255).crop((0, y + hgt - 6, S, y + hgt)), (0, y + hgt - 6))

    # very light scanlines on the letters
    lines = Image.new('L', (S, S), 0)
    ld = ImageDraw.Draw(lines)
    for yy in range(0, S, 7):
        ld.rectangle((0, yy, S, yy + 1), fill=40)
    lines = ImageChops.multiply(lines, fg.getchannel('A'))
    fg.alpha_composite(tint(lines, INK))

    # a few loose pixels next to the tears
    d = ImageDraw.Draw(fg)
    for x, yb, w, col in [(712, 398, 30, ACID), (744, 398, 10, ACID), (236, 452, 18, PINK),
                          (650, 580, 22, PINK), (290, 560, 12, PAPER)]:
        d.rectangle((x, yb, x + w, yb + 6), fill=col + (255,))
    return fg, m_torn


def background():
    bg = Image.new('RGBA', (S, S), INK + (255,))
    glow = Image.new('L', (S, S), 0)
    ImageDraw.Draw(glow).ellipse((180, 160, 860, 840), fill=110)
    glow = glow.filter(ImageFilter.GaussianBlur(170))
    bg.alpha_composite(tint(glow, (110, 18, 80)))
    # faint scanlines across the whole tile
    sl = Image.new('L', (S, S), 0)
    sd = ImageDraw.Draw(sl)
    for yy in range(0, S, 7):
        sd.rectangle((0, yy, S, yy + 1), fill=22)
    bg.alpha_composite(tint(sl, (0, 0, 0)))
    return bg


def main(res, preview):
    rng = random.Random(7)
    fg, mono_mask = foreground(rng)
    bg = background()

    full = bg.copy()
    full.alpha_composite(fg)
    full.save(preview)

    mono = Image.new('RGBA', (S, S), (255, 255, 255, 0))
    mono.putalpha(mono_mask)

    densities = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
    for name, k in densities.items():
        n = round(108 * k)
        for layer, file in ((fg, 'ic_launcher_foreground'), (bg, 'ic_launcher_background'), (mono, 'ic_launcher_monochrome')):
            layer.resize((n, n), Image.LANCZOS).save(f'{res}/mipmap-{name}/{file}.png')
        # legacy icon: the full art in a rounded square (48dp)
        L = round(48 * k)
        art = full.crop((int(S * 0.13), int(S * 0.13), int(S * 0.87), int(S * 0.87))).resize((L, L), Image.LANCZOS)
        mask = Image.new('L', (L * 4, L * 4), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, L * 4 - 1, L * 4 - 1), radius=L * 4 * 0.22, fill=255)
        art.putalpha(mask.resize((L, L), Image.LANCZOS))
        art.save(f'{res}/mipmap-{name}/ic_launcher.png')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
