#!/usr/bin/env python3
"""Biblioteca falsa para probar las vistas de la Biblioteca del 2.5.

  make_library.py <carpeta> [n=1500]

Crea <n> MP3 diminutos (1 s, el mismo audio) con etiquetas ID3 distintas
(título, artista, álbum, género, año) y portada en parte de los álbumes,
más unas pocas canciones de 8 s con tono para oírlas de verdad."""
import os, random, struct, subprocess, sys, tempfile

out = sys.argv[1]
n = int(sys.argv[2]) if len(sys.argv) > 2 else 1500
os.makedirs(out, exist_ok=True)
tmp = tempfile.mkdtemp()
random.seed(7)


def ff(*a):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *a], check=True)


short = os.path.join(tmp, 's.mp3')
ff('-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', '1', '-b:a', '32k', '-id3v2_version', '0', '-write_xing', '0', short)
long_ = os.path.join(tmp, 'l.mp3')
ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=22050', '-t', '8', '-b:a', '32k', '-id3v2_version', '0', '-write_xing', '0', long_)
SH, LG = open(short, 'rb').read(), open(long_, 'rb').read()

COLORS = ['#e63946', '#f4a261', '#2a9d8f', '#264653', '#8338ec', '#ff006e', '#3a86ff', '#fb5607', '#06d6a0', '#118ab2', '#ffd166', '#073b4c']
covers = []
for i, c in enumerate(COLORS):
    p = os.path.join(tmp, f'c{i}.jpg')
    ff('-f', 'lavfi', '-i', f'color=c={c}:s=300x300', '-vf', f"drawbox=x={20 + i * 10}:y={40 + i * 7}:w=140:h=140:color=white@0.35:t=fill", '-frames:v', '1', p)
    covers.append(open(p, 'rb').read())


def frame(fid, data):
    return fid.encode() + struct.pack('>I', len(data)) + b'\0\0' + data


def text(fid, s):
    return frame(fid, b'\x01' + s.encode('utf-16'))


def tag(title, artist, album, genre, year, cover=None, track=0):
    body = text('TIT2', title) + text('TPE1', artist) + text('TALB', album) + text('TCON', genre) + text('TYER', str(year))
    if track:
        body += text('TRCK', str(track))
    if cover:
        body += frame('APIC', b'\0' + b'image/jpeg\0' + b'\x03' + b'\0' + cover)
    size = len(body)
    ss = bytes([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f])
    return b'ID3\x03\x00\x00' + ss + body


W1 = ['Luna', 'Fuego', 'Noche', 'Mar', 'Cielo', 'Ciudad', 'Sombra', 'Luz', 'Viento', 'Río', 'Sol', 'Nube', 'Eco', 'Neón', 'Selva', 'Hielo']
W2 = ['Rota', 'Eterna', 'Azul', 'Dorada', 'Lenta', 'Salvaje', 'Perdida', 'Brillante', 'Lejana', 'Dulce', 'Roja', 'Infinita']
GEN = ['Pop', 'Rock', 'Reggaeton', 'Electrónica', 'Indie', 'Hip-Hop', 'Jazz', 'Flamenco', 'Lo-Fi', 'R&B', 'Metal', 'Clásica']
artists = [f'{random.choice(W1)} {random.choice(["Band", "Club", "Kids", "Sound", "Trío", "y Los " + random.choice(W1)])}' for _ in range(80)]
artists = list(dict.fromkeys(artists))
albums = []
for a in artists:
    for k in range(random.randint(1, 5)):
        albums.append((a, f'{random.choice(W1)} {random.choice(W2)}{" " + str(k + 1) if k else ""}', random.choice(GEN), random.randint(1975, 2025), random.random() < .7 and random.choice(covers)))

made = 0
while made < n:
    a, al, g, y, cov = random.choice(albums)
    for tr in range(1, random.randint(4, 14)):
        if made >= n:
            break
        ti = f'{random.choice(W1)} {random.choice(W2).lower()}' + (f' ({random.choice(["Remix", "Live", "Acústico"])})' if random.random() < .1 else '')
        d = os.path.join(out, 'falsas', a[:20])
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f'{made:04d} {ti}.mp3'), 'wb') as f:
            f.write(tag(ti, a, al, g, y, cov, tr) + SH)
        made += 1

real = os.path.join(out, 'de verdad')
os.makedirs(real, exist_ok=True)
for i, (ti, ar) in enumerate([('Tono uno', 'Probador'), ('Tono dos', 'Probador'), ('Tono tres', 'Otra Banda')]):
    with open(os.path.join(real, f'{ti}.mp3'), 'wb') as f:
        f.write(tag(ti, ar, 'Pruebas reales', 'Pop', 2024, covers[i], i + 1) + LG)
print('hecho:', made, 'canciones falsas +3 de verdad en', out)
