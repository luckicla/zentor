"""Demo library for the README screenshots: invented artists and songs, with
covers drawn here (nothing taken from real records).

    python3 make_demo.py OUT_DIR

Needs Pillow and ffmpeg. The audio is noise shaped like a song (louder and
quieter parts), so ZenTor's waveform looks like a real one.
"""
import math
import os
import random
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ALBUMS = [
    ("Neón Ruido", "Ciudad de Cartón", 2024, [(255, 70, 160), (40, 10, 70)], "rays",
     ["Ciudad de cartón", "Bajo el puente", "Luces que no duermen", "Taxi a las 4"]),
    ("Las Cintas Rotas", "Rebobinar", 2023, [(30, 200, 255), (10, 20, 60)], "stripes",
     ["Rebobinar", "Cassette azul", "Cara B"]),
    ("Miau Sintético", "Gatos en Órbita", 2025, [(255, 170, 40), (90, 20, 40)], "circles",
     ["Gatos en órbita", "Ronroneo digital", "Siete vidas", "Tejado"]),
    ("Palomitas Kaos", "Fotocopia", 2022, [(120, 255, 140), (20, 40, 30)], "halftone",
     ["Fotocopia", "Grapas y pegamento", "Fanzine"]),
    ("Luz de Garaje", "Domingo Eléctrico", 2024, [(250, 230, 90), (60, 30, 90)], "grid",
     ["Domingo eléctrico", "Amplificador", "Ensayo general"]),
    ("Marea Baja", "Sal en la Piel", 2021, [(90, 160, 255), (250, 120, 150)], "waves",
     ["Sal en la piel", "Faro", "Verano lento"]),
]


def font(size):
    for p in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"]:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def cover(path, title, artist, colors, style, seed):
    rnd = random.Random(seed)
    W = 800
    c1, c2 = colors
    img = Image.new("RGB", (W, W))
    px = img.load()
    for y in range(W):
        for x in range(0, W):
            t = (x * 0.35 + y * 0.65) / W
            px[x, y] = lerp(c2, c1, min(1, t))
    d = ImageDraw.Draw(img, "RGBA")
    if style == "rays":
        cx, cy = W * 0.5, W * 0.62
        for i in range(28):
            a = i / 28 * math.tau
            d.polygon([(cx, cy), (cx + math.cos(a) * W, cy + math.sin(a) * W), (cx + math.cos(a + 0.09) * W, cy + math.sin(a + 0.09) * W)], fill=(255, 255, 255, 40))
        d.ellipse([cx - 150, cy - 150, cx + 150, cy + 150], fill=(255, 240, 120, 230))
        for i in range(9):
            x = rnd.randint(0, W - 90)
            h = rnd.randint(180, 420)
            d.rectangle([x, W - h, x + rnd.randint(50, 110), W], fill=(15, 5, 30, 235))
    elif style == "stripes":
        for i in range(-W, W * 2, 70):
            d.polygon([(i, 0), (i + 35, 0), (i + 35 - W, W), (i - W, W)], fill=(255, 255, 255, 45))
        d.rounded_rectangle([170, 250, 630, 560], 30, fill=(240, 240, 250, 235))
        d.rounded_rectangle([210, 300, 590, 430], 16, fill=(30, 40, 80, 255))
        for cx in (300, 500):
            d.ellipse([cx - 45, 320, cx + 45, 410], fill=(240, 240, 250, 255))
            d.ellipse([cx - 15, 350, cx + 15, 380], fill=(30, 40, 80, 255))
    elif style == "circles":
        for i in range(14):
            r = rnd.randint(30, 160)
            x, y = rnd.randint(0, W), rnd.randint(0, W)
            d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, rnd.randint(25, 90)))
        d.ellipse([250, 200, 550, 500], fill=(30, 10, 30, 240))
        d.polygon([(280, 260), (320, 140), (380, 230)], fill=(30, 10, 30, 240))
        d.polygon([(520, 260), (480, 140), (420, 230)], fill=(30, 10, 30, 240))
        for ex in (350, 450):
            d.ellipse([ex - 22, 320, ex + 22, 370], fill=(255, 220, 60, 255))
    elif style == "halftone":
        for y in range(0, W, 26):
            for x in range(0, W, 26):
                r = 11 * (0.3 + 0.7 * abs(math.sin(x / 140 + y / 210)))
                d.ellipse([x - r, y - r, x + r, y + r], fill=(10, 20, 10, 170))
        d.rectangle([90, 520, 710, 640], fill=(255, 60, 140, 235))
    elif style == "grid":
        for i in range(0, W, 50):
            d.line([(i, 0), (i, W)], fill=(255, 255, 255, 50), width=2)
            d.line([(0, i), (W, i)], fill=(255, 255, 255, 50), width=2)
        d.rectangle([220, 230, 580, 570], fill=(25, 15, 40, 240))
        for i in range(5):
            d.rectangle([260, 270 + i * 58, 540, 300 + i * 58], fill=(250, 230, 90, 200 - i * 30))
    elif style == "waves":
        for k in range(9):
            pts = [(x, W * 0.45 + k * 50 + math.sin(x / 70 + k) * 26) for x in range(0, W + 10, 10)]
            d.line(pts, fill=(255, 255, 255, 150 - k * 12), width=9)
        d.ellipse([520, 90, 680, 250], fill=(255, 240, 200, 230))
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    d = ImageDraw.Draw(img, "RGBA")
    # the album's name like a cut-out label, fanzine style
    f = font(54)
    tw = d.textlength(title.upper(), font=f)
    x0, y0 = 40, 40
    d.rectangle([x0 - 12, y0 - 10, x0 + tw + 14, y0 + 66], fill=(255, 255, 255, 235))
    d.text((x0, y0), title.upper(), font=f, fill=(15, 10, 20))
    f2 = font(32)
    aw = d.textlength(artist, font=f2)
    d.rectangle([x0 - 12, y0 + 76, x0 + aw + 14, y0 + 124], fill=(15, 10, 20, 230))
    d.text((x0, y0 + 80), artist, font=f2, fill=(255, 255, 255))
    img.save(path, quality=90)


def song(path, cover_path, title, artist, album, year, n, seed):
    rnd = random.Random(seed)
    dur = rnd.randint(150, 235)
    # a song shape: intro, verses, choruses, a break, outro
    a, b, c = rnd.uniform(5, 9), rnd.uniform(14, 22), rnd.uniform(0.3, 0.6)
    vol = (f"(0.25+0.55*min(1,t/12)*min(1,({dur}-t)/10))"
           f"*(0.65+0.35*sin(2*PI*t/{b}))*(0.75+0.25*sin(2*PI*t/{a}))"
           f"*(1-{c}*between(mod(t,{b * 3:.1f}),{b * 2:.1f},{b * 2.3:.1f}))")
    subprocess.run([
        "ffmpeg", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"anoisesrc=color=pink:duration={dur}:sample_rate=22050:seed={seed}",
        "-i", cover_path,
        "-filter:a", f"volume='{vol}':eval=frame,lowpass=f=4000",
        "-map", "0:a", "-map", "1:v",
        "-c:a", "libmp3lame", "-b:a", "32k", "-ac", "1",
        "-c:v", "mjpeg", "-disposition:v", "attached_pic",
        "-id3v2_version", "3",
        "-metadata", f"title={title}", "-metadata", f"artist={artist}",
        "-metadata", f"album={album}", "-metadata", f"date={year}", "-metadata", f"track={n}",
        "-metadata:s:v", "comment=Cover (front)",
        path,
    ], check=True)


def main(out):
    music = os.path.join(out, "Música")
    covers = os.path.join(out, "_covers")
    os.makedirs(covers, exist_ok=True)
    seed = 7
    for artist, album, year, colors, style, songs in ALBUMS:
        seed += 1
        cp = os.path.join(covers, f"{seed}.jpg")
        cover(cp, album, artist, colors, style, seed)
        d = os.path.join(music, artist, album)
        os.makedirs(d, exist_ok=True)
        for i, t in enumerate(songs, 1):
            song(os.path.join(d, f"{i:02d} - {t}.mp3"), cp, t, artist, album, year, i, seed * 100 + i)
    print("demo library in", out)


if __name__ == "__main__":
    main(sys.argv[1])
