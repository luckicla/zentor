"""Genera el icono de ZenTor: una «Z» recortada sobre papel verde ácido con sombra rosa."""
import sys
from PIL import Image, ImageDraw, ImageFont

S = 1024
TILE = [(150, 160), (540, 120), (890, 150), (870, 520), (900, 890), (470, 870), (120, 900), (160, 500)]


def layer(fill, outline=None, glyph=None):
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(im).polygon(TILE, fill=fill, outline=outline, width=22 if outline else 0)
    if glyph:
        g = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        d = ImageDraw.Draw(g)
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 800)
        box = d.textbbox((0, 0), "Z", font=font)
        w, h = box[2] - box[0], box[3] - box[1]
        d.text(((S - w) / 2 - box[0], (S - h) / 2 - box[1] + 10), "Z", font=font, fill=glyph)
        band = g.crop((0, 470, S, 540))
        g.paste((0, 0, 0, 0), (0, 470, S, 540))
        g.alpha_composite(band, (34, 470))
        im.alpha_composite(g)
    return im.rotate(-6, resample=Image.BICUBIC, center=(S / 2, S / 2))


img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
img.alpha_composite(layer((255, 46, 136, 255)), (44, 44))
img.alpha_composite(layer((200, 255, 0, 255), (10, 10, 13, 255), (10, 10, 13, 255)), (-12, -12))

out = sys.argv[1]
img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
img.resize((512, 512), Image.LANCZOS).save(out.replace(".ico", ".png"))
