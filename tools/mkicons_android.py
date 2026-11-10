"""Every launcher icon the Android app can switch between (Ajustes > Icono).

    python3 tools/mkicons_android.py android/app/src/main/res web/icons

For each icon NAME writes, per density, mipmap-*/ic_zt_NAME_foreground.png,
ic_zt_NAME_monochrome.png and the legacy ic_zt_NAME.png, plus
mipmap-anydpi-v26/ic_zt_NAME.xml; and a small round preview web/icons/NAME.png
for the picker in the settings.
"""
import os
import sys
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(__file__))
import icon_concepts as ic
import mkicon_android as zr

S = 1024
INK = ic.INK
DENS = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}


def current_zr():
    fg, _ = zr.glitch(*zr.letters_masks())
    full = Image.new('RGBA', (S, S), INK + (255,))
    full.alpha_composite(fg)
    return full


ICONS = [  # name, art (1024 px, on ink), order = order in the picker
    ('wave', lambda: ic.concept_wave()),
    ('zr', current_zr),
    ('ransom', lambda: ic.concept_ransom()),
    ('disc', lambda: ic.concept_disc()),
    ('mono', lambda: ic.concept_overlap()),
    ('play', lambda: ic.concept_play()),
    ('frame', lambda: ic.concept_frame()),
]

XML = '''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_zt_{n}_foreground" />
    <monochrome android:drawable="@mipmap/ic_zt_{n}_monochrome" />
</adaptive-icon>
'''


def not_ink(full):
    """Mask of everything that isn't background."""
    from PIL import ImageChops
    r, g, b, _ = full.split()
    # distance from INK per channel, max over channels
    bg = Image.new('RGB', full.size, INK)
    dist = ImageChops.difference(Image.merge('RGB', (r, g, b)), bg)
    a, bb, c = dist.split()
    m = ImageChops.lighter(ImageChops.lighter(a, bb), c)
    return m.point(lambda v: 255 if v > 24 else v * 10)


def main(res, web):
    os.makedirs(web, exist_ok=True)
    circle = Image.new('L', (S, S), 0)
    ImageDraw.Draw(circle).ellipse((0, 0, S - 1, S - 1), fill=255)
    for name, fn in ICONS:
        full = fn()
        if full.size != (S, S):
            full = full.resize((S, S), Image.LANCZOS)
        mono = Image.new('RGBA', (S, S), (255, 255, 255, 0))
        mono.putalpha(not_ink(full))
        for d, k in DENS.items():
            n = round(108 * k)
            full.resize((n, n), Image.LANCZOS).save(f'{res}/mipmap-{d}/ic_zt_{name}_foreground.png')
            mono.resize((n, n), Image.LANCZOS).save(f'{res}/mipmap-{d}/ic_zt_{name}_monochrome.png')
            L = round(48 * k)
            art = full.crop((S // 6, S // 6, S * 5 // 6, S * 5 // 6)).resize((L, L), Image.LANCZOS)
            mask = Image.new('L', (L * 4, L * 4), 0)
            ImageDraw.Draw(mask).rounded_rectangle((0, 0, L * 4 - 1, L * 4 - 1), radius=L * 4 * 0.22, fill=255)
            art.putalpha(mask.resize((L, L), Image.LANCZOS))
            art.save(f'{res}/mipmap-{d}/ic_zt_{name}.png')
        with open(f'{res}/mipmap-anydpi-v26/ic_zt_{name}.xml', 'w') as f:
            f.write(XML.format(n=name))
        # preview for the picker: what a round launcher shows (middle 72dp)
        view = full.crop((171, 171, 853, 853)).resize((S, S), Image.LANCZOS)
        view.putalpha(circle)
        view.resize((128, 128), Image.LANCZOS).save(f'{web}/{name}.png', optimize=True)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
