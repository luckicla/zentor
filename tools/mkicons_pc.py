"""Windows icons (.ico) for every app icon of the picker, from the same art
as the Android ones: rounded square, the middle of the art.

    python3 tools/mkicons_pc.py web/icons
"""
import os
import shutil
import sys
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(__file__))
from mkicons_android import ICONS, S


def main(out):
    for name, fn in ICONS:
        if name == 'legacy':  # the original .ico, as it was
            shutil.copyfile(os.path.join(os.path.dirname(__file__), '..', 'web', 'icono.ico'), f'{out}/legacy.ico')
            continue
        full = fn()
        if full.size != (S, S):
            full = full.resize((S, S), Image.LANCZOS)
        art = full.crop((S // 6, S // 6, S * 5 // 6, S * 5 // 6)).resize((1024, 1024), Image.LANCZOS)
        mask = Image.new('L', (1024, 1024), 0)
        ImageDraw.Draw(mask).rounded_rectangle((8, 8, 1015, 1015), radius=230, fill=255)
        art.putalpha(mask)
        art.resize((256, 256), Image.LANCZOS).save(f'{out}/{name}.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


if __name__ == '__main__':
    main(sys.argv[1])
