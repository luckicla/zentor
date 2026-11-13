# Builds a small demo library for the README screenshots: invented songs and
# artists, with covers drawn here (no real album art). Every file is a
# silent mp3 with its tags, so ZenTor reads it like any other song.
import io, os, random, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter

out = sys.argv[1] if len(sys.argv) > 1 else "demo"
music = os.path.join(out, "Música")
os.makedirs(music, exist_ok=True)

PALETTES = [
    ["#ff5fa2", "#ffd23f", "#1b1b2f", "#3df5ff"],
    ["#ff3c38", "#ffe8d6", "#141414", "#ff8c42"],
    ["#7b2ff7", "#f107a3", "#0d0221", "#00f0ff"],
    ["#0fa3b1", "#f7a072", "#14213d", "#eddea4"],
    ["#c1ff72", "#ff4f79", "#101010", "#ffffff"],
    ["#ffb703", "#fb8500", "#023047", "#8ecae6"],
]

def cover(seed, pal):
    r = random.Random(seed)
    W = 900
    im = Image.new("RGB", (W, W), pal[2])
    d = ImageDraw.Draw(im)
    # big soft blobs
    for _ in range(5):
        x, y, s = r.randint(-200, W), r.randint(-200, W), r.randint(250, 650)
        d.ellipse([x, y, x + s, y + s], fill=r.choice(pal[:2] + pal[3:]))
    im = im.filter(ImageFilter.GaussianBlur(70))
    d = ImageDraw.Draw(im)
    # hard shapes on top: stripes, circles, a torn band
    kind = seed % 3
    if kind == 0:
        for i in range(-W, W * 2, 60):
            d.line([(i, 0), (i - W, W)], fill=pal[r.randint(0, 3)], width=14)
        d.ellipse([W * .22, W * .22, W * .78, W * .78], fill=pal[2])
        d.ellipse([W * .36, W * .36, W * .64, W * .64], fill=pal[0])
    elif kind == 1:
        for _ in range(9):
            x, y, s = r.randint(0, W), r.randint(0, W), r.randint(40, 220)
            d.rectangle([x, y, x + s, y + s // 3], fill=pal[r.randint(0, 3)])
        d.polygon([(0, W * .62), (W, W * .48), (W, W * .64), (0, W * .78)], fill=pal[0])
    else:
        for i in range(14):
            rr = W * .48 - i * 30
            if rr <= 0: break
            d.ellipse([W / 2 - rr, W / 2 - rr, W / 2 + rr, W / 2 + rr], outline=pal[i % 4], width=12)
    # halftone dots for the zine look
    for y in range(0, W, 26):
        for x in range(0, W, 26):
            if r.random() < .25:
                d.ellipse([x, y, x + 6, y + 6], fill=pal[1])
    b = io.BytesIO(); im.save(b, "JPEG", quality=88); return b.getvalue()

ALBUMS = [
    ("Neón de madrugada", "Luna Varela", ["Ciudad de cristal", "Neón de madrugada", "Último metro", "Llamadas perdidas", "Azotea"]),
    ("Señales", "Los Fugaces", ["Señales", "Kilómetro cero", "Polaroid", "Fuego lento"]),
    ("Paper Hearts", "Nova Rae", ["Paper Hearts", "Static", "Gold Rush", "Satellite Love"]),
    ("Mareas", "Iker Sol", ["Mareas", "Sal en la piel", "Verano 03", "Faro"]),
    ("Overdrive", "Kira Volt", ["Overdrive", "Glitch Kiss", "Red Line", "Afterglow", "Zero Hour"]),
    ("Casa vacía", "Marta Ocaso", ["Casa vacía", "Domingo", "Ventanas"]),
]
GENRE = ["Pop", "Indie", "Pop", "Indie", "Electronic", "Folk"]

n = 0
for ai, (album, artist, songs) in enumerate(ALBUMS):
    art = os.path.join(out, f"cover{ai}.jpg")
    open(art, "wb").write(cover(ai * 7 + 3, PALETTES[ai % len(PALETTES)]))
    for ti, title in enumerate(songs):
        n += 1
        secs = 150 + (n * 37) % 110
        f = os.path.join(music, f"{artist} - {title}.mp3")
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y",
            "-f", "lavfi", "-t", str(secs), "-i", "anoisesrc=d=%d:c=pink:a=0.25" % secs,
            "-i", art, "-map", "0:a", "-map", "1:v", "-af", "volume=0.35+0.3*sin(t/2.3)*sin(t/7.1):eval=frame",
            "-c:a", "libmp3lame", "-b:a", "128k", "-ac", "1", "-c:v", "mjpeg", "-disposition:v", "attached_pic",
            "-id3v2_version", "3",
            "-metadata", f"title={title}", "-metadata", f"artist={artist}", "-metadata", f"album={album}",
            "-metadata", f"track={ti + 1}", "-metadata", f"genre={GENRE[ai]}", "-metadata", "date=2026",
            f], check=True)
print(n, "songs in", music)
