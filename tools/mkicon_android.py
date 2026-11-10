"""ZR launcher icon for the Android app: flat, Poppins Bold, one glitch slice.

Writes the adaptive icon layers (background, foreground, monochrome) and the
legacy square icon for every density into the given res/ folder.

    python3 tools/mkicon_android.py android/app/src/main/res preview.png
"""
import sys
from PIL import Image, ImageDraw, ImageFont

S = 1024                      # the 108dp adaptive canvas
INK = (10, 10, 13)
PAPER = (240, 234, 220)
# pastel pair: R in pastel red, Z in a colour that goes with it
R_COL = (255, 143, 143)
Z_COL = (185, 166, 255)
FONT = '/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf'


def letters_masks(width=560):
    """White masks of Z and of R (same layout), scaled so ZR is `width` wide and
    centered inside the 66dp safe zone."""
    font = ImageFont.truetype(FONT, 400)
    layers = []
    x = 200
    for ch in 'ZR':
        m = Image.new('L', (S * 2, S * 2), 0)
        ImageDraw.Draw(m).text((x, 300), ch, font=font, fill=255)
        layers.append(m)
        x += font.getlength(ch)
    both = Image.new('L', (S * 2, S * 2), 0)
    for m in layers:
        both.paste(255, mask=m)
    box = both.getbbox()
    k = width / (box[2] - box[0])
    out = []
    for m in layers:
        m = m.crop(box)
        m = m.resize((round(m.width * k), round(m.height * k)), Image.LANCZOS)
        o = Image.new('L', (S, S), 0)
        o.paste(m, ((S - m.width) // 2, (S - m.height) // 2))
        out.append(o)
    return out


def shifted(mask, dx):
    out = Image.new('L', (S, S), 0)
    out.paste(mask, (dx, 0))
    return out


def solid(mask, color):
    layer = Image.new('RGBA', (S, S), color + (255,))
    layer.putalpha(mask)
    return layer


def glitch(mz, mr, z_col=Z_COL, r_col=R_COL, dx=34, edge=14, at=0.40, thick=0.15):
    """Cut a horizontal slice out of the letters and push it sideways; the
    slice's edges show the other letter's colour. Returns (colour layer, mask)."""
    m = Image.new('L', (S, S), 0)
    m.paste(255, mask=mz)
    m.paste(255, mask=mr)
    x0, y0, x1, y1 = m.getbbox()
    ys = int(y0 + (y1 - y0) * at)
    sh = int((y1 - y0) * thick)
    box = (0, ys, S, ys + sh)

    body = m.copy()
    body.paste(0, box)
    moved = shifted(m, dx).crop(box)

    def letters(z, r, cz, cr, off=0):
        layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        layer.alpha_composite(solid(shifted(z, off), cz))
        layer.alpha_composite(solid(shifted(r, off), cr))
        return layer

    cut = lambda mm: (lambda c: (c.paste(0, box), c)[1])(mm.copy())
    fg = letters(cut(mz), cut(mr), z_col, r_col)
    # flat edges peeking out either side of the moved slice, in the swapped colours
    fg.alpha_composite(letters(mz, mr, r_col, r_col, dx - edge).crop(box), (0, ys))
    fg.alpha_composite(letters(mz, mr, z_col, z_col, dx + edge).crop(box), (0, ys))
    fg.alpha_composite(letters(mz, mr, z_col, r_col, dx).crop(box), (0, ys))

    plain = body.copy()
    plain.paste(moved, (0, ys))
    return fg, plain


def main(res, preview):
    fg, plain = glitch(*letters_masks())
    bg = Image.new('RGBA', (S, S), INK + (255,))

    full = bg.copy()
    full.alpha_composite(fg)
    full.save(preview)

    # monochrome layer for Android 13 themed icons: shape only
    mono = Image.new('RGBA', (S, S), (255, 255, 255, 0))
    mono.putalpha(plain)

    for name, k in {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}.items():
        n = round(108 * k)
        for layer, file in ((fg, 'ic_launcher_foreground'), (bg, 'ic_launcher_background'), (mono, 'ic_launcher_monochrome')):
            layer.resize((n, n), Image.LANCZOS).save(f'{res}/mipmap-{name}/{file}.png')
        # legacy icon (Android 7): the 72dp middle of the art in a rounded square, 48dp
        L = round(48 * k)
        art = full.crop((int(S / 6), int(S / 6), int(S * 5 / 6), int(S * 5 / 6))).resize((L, L), Image.LANCZOS)
        mask = Image.new('L', (L * 4, L * 4), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, L * 4 - 1, L * 4 - 1), radius=L * 4 * 0.22, fill=255)
        art.putalpha(mask.resize((L, L), Image.LANCZOS))
        art.save(f'{res}/mipmap-{name}/ic_launcher.png')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
