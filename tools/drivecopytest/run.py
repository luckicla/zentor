#!/usr/bin/env python3
"""«Copia de tu biblioteca» (web/plugins/gdrive-copy.js, drivecopy.go) end to end,
with no internet: two MixUps and the fake Google of tools/googletest (Drive included).

    go build -o /tmp/dcopy-mixup . && python3 tools/drivecopytest/run.py

- device A (a PC): three songs of its own (one with a cover chosen by hand with
  «Buscar portada… → Elegir imagen…»), one YouTube song, one Spotify one and one
  SoundCloud one, in a playlist and in Me gusta
- A syncs: state.json carries `lib` (schema 2) with the origin of every song, the
  cover goes up as a small copy (cvpack-*.json), no music file goes to Drive
- device B (an empty phone, page with Android's user agent; its bridge says the
  network is mobile data): after syncing it has everything, in the same order, in
  the playlist and in Me gusta; the YouTube / Spotify / SoundCloud ones as they are;
  A's own songs as YouTube songs «pendiente de descargar» (found by YouTube.best,
  faked here) with their title and artist and, the one that had it, the cover chosen
  on A (/cover/yt-<v> serves it)
- with mobile data nothing comes down and the question comes once; «Con WiFi,
  automáticamente» → still nothing; WiFi → they come down by themselves (the audio
  is served by the test as if it were YouTube's) and become songs of B's own with
  the same title, artist, cover and place in the playlist and in Me gusta
- A doesn't get B's pending songs as YouTube duplicates
- the plugin's page, 2.5 and Legacy (screenshots); no console errors

Ports (env): DCOPY_PORTS="A,B,fakeGoogle,lanA,lanB" (default 18683,18684,18685,18686,18687).
Screenshots in DCOPY_OUT (/tmp/dcopy-out)."""
import json, os, shutil, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
FAKE_PY = os.path.join(HERE, '..', 'googletest', 'fake_google.py')
BIN = os.environ.get('MIXUP_BIN', '/tmp/dcopy-mixup')
OUT = os.environ.get('DCOPY_OUT', '/tmp/dcopy-out')
TMP = os.environ.get('DCOPY_TMP', '/tmp/dcopy-tmp')
P_A, P_B, FAKE, L_A, L_B = [int(x) for x in os.environ.get('DCOPY_PORTS', '18683,18684,18685,18686,18687').split(',')]
for d in (OUT, TMP):
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d, exist_ok=True)
procs, fails = [], []

STUB = """
window.__metered = true;
window.MixUpAndroid = new Proxy({}, { get: (_, k) => k === 'deviceName' ? () => 'Móvil nuevo' : k === 'systemVolume' ? () => 1 : k === 'isMetered' ? () => !!window.__metered : () => '' });
"""
ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36 MixUpAndroid'

# A's songs of its own, and the YouTube video «found» for each on B
LOCAL = [('Luna Norte', 'Faro azul', 330, 'faroazul001'), ('Luna Norte', 'Corriente', 392, 'corriente02'), ('Los Vatios', 'Chispa', 494, 'chispa00003')]
YT = {'v': 'ytvideo0001', 'title': 'Canción de YouTube', 'artist': 'Canal Uno', 'dur': 200}
SP = {'v': 'spvideo0001', 'title': 'Canción de Spotify', 'artist': 'Grupo Verde', 'dur': 180, 'src': 'spotify', 'sp': '4uLU6hMCjMI75M1A2tKUQC'}
SC = {'id': '987654321', 'title': 'Canción de SoundCloud', 'artist': 'Nube Naranja', 'dur': 150, 'url': 'https://soundcloud.com/nube/cancion'}


def check(ok, what):
    print(('ok    ' if ok else 'FALLO ') + what, flush=True)
    if not ok:
        fails.append(what)


def get(url):
    try:
        return urllib.request.urlopen(url, timeout=3).read().decode()
    except Exception:
        return ''


def until(fn, secs=20, step=0.3):
    t0 = time.time()
    while time.time() - t0 < secs:
        try:
            v = fn()
        except Exception:
            v = None
        if v:
            return v
        time.sleep(step)
    return None


def ff(*a):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *a], check=True)


def media():
    music = os.path.join(TMP, 'music-a')
    os.makedirs(music)
    for ar, ti, f, _ in LOCAL:
        ff('-f', 'lavfi', '-i', f'sine=f={f}:d=40', '-ac', '1', '-b:a', '32k', '-metadata', f'title={ti}', '-metadata', f'artist={ar}',
           '-metadata', 'album=Mareas', os.path.join(music, f'{ar} - {ti}.mp3'))
    # one YouTube won't find: it stays in the copy, waiting
    ff('-f', 'lavfi', '-i', 'sine=f=600:d=40', '-ac', '1', '-b:a', '32k', '-metadata', 'title=Rara avis', '-metadata', 'artist=Nadie Más',
       os.path.join(music, 'Nadie Más - Rara avis.mp3'))
    # «YouTube's» audio for each song (m4a; tagged, as the phone would read its file name)
    for ar, ti, f, v in LOCAL:
        ff('-f', 'lavfi', '-i', f'sine=f={f + 7}:d=30', '-ac', '1', '-c:a', 'aac', '-b:a', '32k', '-metadata', f'title={ti}', '-metadata', f'artist={ar}',
           os.path.join(TMP, f'{v}.m4a'))
    # the cover chosen by hand on A: plain magenta
    ff('-f', 'lavfi', '-i', 'color=c=0xE020C0:s=400x400', '-frames:v', '1', os.path.join(TMP, 'cover.png'))
    return music


def start(tag, port, lanport, music=None):
    home, root = os.path.join(TMP, 'h-' + tag), os.path.join(TMP, 'm-' + tag)
    os.makedirs(home)
    if music:
        shutil.copytree(music, root)
    else:
        os.makedirs(root)
    os.makedirs(os.path.join(root, '.zentor'))
    open(os.path.join(root, '.zentor', 'google-client.json'), 'w').write('{"client_id":"cid","client_secret":"csec"}')
    env = dict(os.environ, MIXUP_ADDR=f'127.0.0.1:{port}', HOME=home, MIXUP_GOOGLE_BASE=f'http://127.0.0.1:{FAKE}',
               ZENTOR_LAN_IP='127.0.0.1', MIXUP_LAN_PORT=str(lanport))
    env.pop('MIXUP_GOOGLE_CLIENT_SECRET', None)
    p = subprocess.Popen([BIN, '-root', root, '-headless'], env=env, stdout=open(os.path.join(TMP, tag + '.log'), 'w'), stderr=subprocess.STDOUT)
    procs.append(p)
    until(lambda: get(f'http://127.0.0.1:{port}/api/version'))
    return f'http://127.0.0.1:{port}/'


errors = {}


def page(br, name, url, phone=False, n=0):
    opts = dict(viewport={'width': 390, 'height': 844} if phone else {'width': 1280, 'height': 820}, locale='es-ES')
    if phone:
        opts.update(user_agent=ANDROID_UA, has_touch=True, is_mobile=True, device_scale_factor=2)
    ctx = br.new_context(**opts)
    ctx.add_init_script("try { localStorage.setItem('zt.intro', '1') } catch {}")
    if phone:
        ctx.add_init_script(STUB)
    pg = ctx.new_page()
    errors[name] = []
    noise = ('net::', 'Failed to load resource', 'ERR_', 'ytimg', 'youtube', 'soundcloud')
    pg.on('console', lambda m: m.type == 'error' and not any(x in m.text for x in noise) and errors[name].append(m.text))
    pg.on('pageerror', lambda e: errors[name].append('pageerror: ' + str(e)))
    # «YouTube»: the audio of each video, served by the test (YouTube.download asks /ytaudio/<v>)
    def yt_audio(route):
        v = route.request.url.split('/ytaudio/')[1].split('?')[0]
        f = os.path.join(TMP, v + '.m4a')
        if os.path.exists(f):
            time.sleep(1.2)  # (a little time on the way, like the internet)
            route.fulfill(status=200, body=open(f, 'rb').read(), headers={'Content-Type': 'audio/mp4'})
        else:
            route.fulfill(status=404, body='no')
    pg.route('**/ytaudio/**', yt_audio)
    pg.goto(url)
    pg.wait_for_function(f'window.ZT && ZT.allTracks().length >= {n} && typeof GoogleAcct !== "undefined" && GoogleAcct.known() && typeof Journal !== "undefined" && Journal.ready()', timeout=30000)
    pg.wait_for_timeout(1500)
    return pg


def sign_in(pg, name):
    pg.evaluate('GoogleAcct.connect()')
    ok = pg.wait_for_function('GoogleAcct.driveReady()', timeout=30000)
    check(bool(ok), f'{name}: conectado a la cuenta de Google (falsa)')


def sync(pg):
    pg.wait_for_function('!DriveSync.busy()', timeout=30000)
    pg.evaluate('DriveSync.run(true)')
    pg.wait_for_timeout(500)
    pg.wait_for_function('!DriveSync.busy()', timeout=30000)


def drive_files():
    return json.loads(get(f'http://127.0.0.1:{FAKE}/_state') or '{}').get('files', [])


def drive_json(pg, name):
    return pg.evaluate(f"fetch('/api/google/drive/{name}', {{cache: 'no-store'}}).then(r => r.ok ? r.json() : null)")


# the playlist «Mezcla» and Me gusta as fingerprints, in their order
LISTS = """(() => { const all = ZT.allTracks(), f = id => { const t = all.find(x => x.id === id); return t ? Sync.fp(t) : 'MISSING:' + id; };
  const P = Playlists.raw(), m = P.lists.find(l => l.name === 'Mezcla');
  return { mix: m ? m.tracks.map(f) : null, liked: P.liked.map(f), ids: m ? m.tracks : [] }; })()"""
# the colour in the middle of a picture
COLOR = """async u => { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) return null; const b = await createImageBitmap(await r.blob());
  const c = document.createElement('canvas'); c.width = c.height = 8; const x = c.getContext('2d'); x.drawImage(b, 0, 0, 8, 8); return [...x.getImageData(4, 4, 1, 1).data].slice(0, 3); }"""


def magenta(rgb):
    return bool(rgb) and rgb[0] > 180 and rgb[1] < 90 and rgb[2] > 150


try:
    music = media()
    procs.append(subprocess.Popen([sys.executable, FAKE_PY, str(FAKE)], stdout=open(os.path.join(TMP, 'fake.log'), 'w'), stderr=subprocess.STDOUT))
    until(lambda: get(f'http://127.0.0.1:{FAKE}/_state'))
    A = start('a', P_A, L_A, music)
    B = start('b', P_B, L_B)
    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-proxy-server', '--autoplay-policy=no-user-gesture-required'])
        a = page(br, 'A', A, n=4)

        # ---- A: its music from everywhere ----
        a.evaluate(f"""(async () => {{
            YouTube.save([{json.dumps(YT)}, {json.dumps(SP)}]);
            SoundCloud.put([{json.dumps(SC)}]);
            await ZT.reload();
        }})()""")
        a.wait_for_function('ZT.allTracks().filter(t => !t.tmp).length >= 7', timeout=10000)
        # the cover chosen by hand for «Corriente» (Buscar portada… → Elegir imagen…)
        cid = a.evaluate("ZT.allTracks().find(t => t.title === 'Corriente').id")
        a.evaluate(f"ZT.pickCover({json.dumps(cid)})")
        a.wait_for_selector('#cvFile', state='attached', timeout=5000)
        a.set_input_files('#cvFile', os.path.join(TMP, 'cover.png'))
        check(bool(until(lambda: a.evaluate("Object.values(DriveCopy.state().picks).some(p => p.o)"), 10)), 'A: la portada elegida a mano queda apuntada')
        a.evaluate("document.querySelector('.cvbox [data-cv=close]')?.click()")
        a.evaluate("""(() => {
            const by = t => ZT.allTracks().find(x => x.title === t);
            const order = ['Chispa', 'Canción de YouTube', 'Canción de SoundCloud', 'Corriente', 'Canción de Spotify', 'Faro azul'].map(by);
            Mix.pl.create('Mezcla', order);
            for (const t of ['Canción de Spotify', 'Corriente', 'Canción de YouTube', 'Canción de SoundCloud']) Mix.like(by(t).id, true);
        })()""")
        a.wait_for_timeout(600)
        lists_a = a.evaluate(LISTS)
        check(lists_a['mix'] and len(lists_a['mix']) == 6 and len(lists_a['liked']) == 4, f'A: playlist «Mezcla» (6) y Me gusta (4)')

        sign_in(a, 'A')
        sync(a)
        a.wait_for_timeout(1500)
        # (the covers go up after the sync; the next sync writes their names in the copy)
        until(lambda: a.evaluate("Object.keys(DriveCopy.state().thumbs).length >= 1"), 15)
        sync(a)
        st = drive_json(a, 'state.json') or {}
        lib = (st.get('lib') or {}).get('items') or []
        check(st.get('schema') == 2 and st.get('v') == 1, f"A: state.json con schema 2 (v sigue siendo 1): {st.get('schema')}")
        by_o = {}
        for e in lib:
            by_o[e['o']] = by_o.get(e['o'], 0) + 1
        check(by_o == {'local': 4, 'yt': 1, 'sp': 1, 'sc': 1}, f'A: la copia dice de dónde es cada canción {by_o}')
        sp = [e for e in lib if e['o'] == 'sp']
        check(bool(sp) and sp[0].get('v') == SP['v'] and sp[0].get('sp') == SP['sp'], 'A: la de Spotify lleva su id y su equivalente de YouTube')
        sc = [e for e in lib if e['o'] == 'sc']
        check(bool(sc) and sc[0].get('id') == SC['id'] and sc[0].get('u') == SC['url'], 'A: la de SoundCloud lleva su id y su enlace')
        cor = [e for e in lib if e['o'] == 'local' and e['t'] == 'Corriente']
        check(bool(cor) and cor[0].get('ch') and cor[0].get('f') == 'corriente|lunanorte', f"A: «Corriente» con su huella y su portada ({cor[0] if cor else None})")
        files = drive_files()
        names = [f['name'] for f in files]
        packs = [n for n in names if n.startswith('cvpack-')]
        check(bool(packs), f'A: las portadas van en paquetes pequeños {packs}')
        check(not any(n.lower().endswith(('.mp3', '.m4a', '.webm', '.flac', '.ogg', '.wav', '.opus')) for n in names), f'A: ningún archivo de música en Drive ({names})')
        ch = cor[0]['ch'] if cor else ''
        pk = drive_json(a, f'cvpack-{ch[:1]}.json') or {}
        check(ch in pk and pk[ch].startswith('data:image/jpeg') and len(pk[ch]) < 40000, 'A: la portada elegida, como copia pequeña (JPEG)')

        # ---- B: an empty phone on mobile data ----
        b = page(br, 'B', B, phone=True, n=0)
        # «YouTube» for B: the search finds the same song (by title and artist), as YouTube.best would
        fake = {ti: v for ar, ti, f, v in LOCAL}
        b.evaluate(f"""(() => {{ const m = {json.dumps(fake)}; window.__asked = [];
            YouTube.best = async (t, a, d) => {{ window.__asked.push([t, a, d]); return m[t] ? {{ v: m[t], dur: d || 40 }} : null; }}; }})()""")
        sign_in(b, 'B')
        sync(b)
        ok = b.wait_for_function("Object.keys(DriveCopy.state().pend).length >= 3 && !DriveCopy.state().resolving", timeout=30000)
        check(bool(ok), f"B: las 3 canciones de A se buscan en YouTube y quedan «pendientes de descargar» ({b.evaluate('Object.keys(DriveCopy.state().pend)')})")
        asked = b.evaluate('window.__asked')
        check(len(asked) == 4 and all(x[2] > 0 for x in asked), f'B: búsqueda por título, artista y duración ({asked})')
        b.wait_for_timeout(1500)
        sync(b)
        lists_b = b.evaluate(LISTS)
        check(lists_b['mix'] == lists_a['mix'], f"B: «Mezcla» igual y en el mismo orden\n   A {lists_a['mix']}\n   B {lists_b['mix']}")
        check(lists_b['liked'] == lists_a['liked'], f"B: Me gusta igual y en el mismo orden\n   A {lists_a['liked']}\n   B {lists_b['liked']}")
        kinds = b.evaluate("""(() => { const all = ZT.allTracks(); return Playlists.raw().lists.find(l => l.name === 'Mezcla').tracks.map(id => { const t = all.find(x => x.id === id) || {};
            return [t.title, t.yt ? 'yt' : t.sc ? 'sc' : 'local', !!t.pend, t.src || '']; }); })()""")
        check(all(k[1] in ('yt', 'sc') for k in kinds), f'B: todas suenan por internet ({kinds})')
        check(sum(1 for k in kinds if k[2]) == 3 and [k for k in kinds if k[0] == 'Canción de Spotify'][0][3] == 'spotify', 'B: las tuyas, «pendientes»; la de Spotify, de Spotify')
        cor_b = b.evaluate("ZT.allTracks().find(t => t.title === 'Corriente' && t.yt)")
        check(bool(cor_b) and cor_b['artist'] == 'Luna Norte', 'B: «Corriente» con su título y artista originales')
        rgb = b.evaluate(COLOR, f"/cover/{cor_b['id']}") if cor_b else None
        check(magenta(rgb), f'B: «Corriente» enseña la portada que se eligió en A, no la de YouTube ({rgb})')
        # B's pending songs don't travel as YouTube songs
        st2 = drive_json(b, 'state.json') or {}
        yv = [i['v'] for i in (st2.get('youtube') or {}).get('items', [])]
        check(not any(v in yv for _, _, _, v in LOCAL), f'B: las pendientes no se suben como canciones de YouTube ({yv})')
        lib2 = (st2.get('lib') or {}).get('items') or []
        check(sum(1 for e in lib2 if e['o'] == 'local') == 4, 'B: en la copia siguen siendo «tuyas» (también la que YouTube no tiene)')

        # mobile data: nothing comes down; the question, once
        b.evaluate('DriveCopy.tick()')
        b.wait_for_timeout(800)
        busy = b.evaluate("Object.keys(DriveCopy.state().pend).some(id => YouTube.dlBusy(id))")
        check(not busy, 'B con datos: no empieza a descargar')
        q = until(lambda: b.evaluate("(document.querySelector('.dc-ask') || document.querySelector('.dcbox'))?.innerText || ''"), 8)
        check(bool(q) and 'Hay 3 canciones que tenías descargadas' in q and 'MB' in q, f'B con datos: pregunta ({q!r})')
        b.screenshot(path=f'{OUT}/1-movil-pregunta.png')
        b.evaluate('DriveCopy.tick(), DriveCopy.tick()')
        n_ask = b.evaluate("document.querySelectorAll('.dc-ask, .dcbox').length")
        check(n_ask == 1, f'B: la pregunta sale una sola vez ({n_ask})')
        b.click('[data-dca=wifi]')
        b.wait_for_timeout(800)
        check(b.evaluate("DriveCopy.state().opt.dl") == 'wifi', 'B: «Con WiFi, automáticamente» queda recordado')
        check(not b.evaluate("Object.keys(DriveCopy.state().pend).some(id => YouTube.dlBusy(id))"), 'B: sigue sin descargar con datos')
        b.evaluate("Mix.openPluginPage('gdrive')")
        b.wait_for_timeout(1200)
        sec = b.evaluate("document.querySelector('.dc-sec')?.innerText || ''")
        check('copia de tu biblioteca' in sec.lower() and 'Esperando a la WiFi' in sec, f'B: la página del plugin lo cuenta ({sec[:200]!r})')
        b.evaluate("document.querySelector('.dc-sec')?.scrollIntoView()")
        b.wait_for_timeout(400)
        b.screenshot(path=f'{OUT}/2-movil-plugin-esperando.png')

        # WiFi: they come down by themselves (the indicator on the home screen, the progress on the page)
        b.evaluate("Mix.closeSettings && Mix.closeSettings()")
        b.wait_for_timeout(600)
        b.evaluate('window.__metered = false; DriveCopy.tick()')
        started = until(lambda: b.evaluate("Object.keys(DriveCopy.state().pend).some(id => YouTube.dlBusy(id))"), 10, 0.05)
        check(bool(started), 'B con WiFi: empiezan a descargarse solas')
        badge = until(lambda: b.evaluate("(() => { const e = document.getElementById('dcBadge'); return e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0 ? e.textContent : '' })()"), 6, 0.05)
        check(bool(badge) and '/3' in badge, f'B: indicador discreto mientras descarga ({badge!r})')
        b.screenshot(path=f'{OUT}/3b-movil-indicador.png')
        b.evaluate("Mix.openPluginPage('gdrive')")
        b.wait_for_timeout(900)
        b.evaluate("document.querySelector('.dc-sec')?.scrollIntoView()")
        b.screenshot(path=f'{OUT}/3-movil-descargando.png')
        done = until(lambda: b.evaluate("Object.keys(DriveCopy.state().pend).length === 0"), 90, 0.5)
        check(bool(done), f"B: todas descargadas ({b.evaluate('Object.keys(DriveCopy.state().pend)')})")
        b.wait_for_timeout(2500)
        lists_b2 = b.evaluate(LISTS)
        check(lists_b2['mix'] == lists_a['mix'], f"B: tras descargar, «Mezcla» sigue igual\n   A {lists_a['mix']}\n   B {lists_b2['mix']}")
        check(lists_b2['liked'] == lists_a['liked'], 'B: tras descargar, Me gusta sigue igual')
        kinds2 = b.evaluate("""(() => { const all = ZT.allTracks(); return Playlists.raw().lists.find(l => l.name === 'Mezcla').tracks.map(id => { const t = all.find(x => x.id === id) || {};
            return [t.title, t.artist, t.yt ? 'yt' : t.sc ? 'sc' : 'local', !!t.cover]; }); })()""")
        locs = [k for k in kinds2 if k[2] == 'local']
        check(sorted(k[0] for k in locs) == ['Chispa', 'Corriente', 'Faro azul'], f'B: las tres son ahora canciones del móvil ({kinds2})')
        cor2 = b.evaluate("ZT.allTracks().find(t => t.title === 'Corriente' && !t.yt && !t.sc)")
        rgb2 = b.evaluate(COLOR, f"/cover/{cor2['id']}") if cor2 and cor2.get('cover') else None
        check(magenta(rgb2), f'B: «Corriente» descargada con la portada elegida en A ({rgb2})')
        check(not b.evaluate("YouTube.rawDoc().items.some(i => i.pend)"), 'B: ya no quedan canciones de YouTube «pendientes»')
        b.screenshot(path=f'{OUT}/4-movil-descargadas.png')
        sync(b)
        lib3 = ((drive_json(b, 'state.json') or {}).get('lib') or {}).get('items') or []
        check(any(e.get('t') == 'Rara avis' for e in lib3), 'B: la que no encontró en YouTube no se pierde de la copia')
        check(not b.evaluate("ZT.allTracks().some(t => t.title === 'Rara avis')"), 'B: (y no se inventa otra canción para ella)')

        # A again: no duplicates from B
        sync(a)
        a.wait_for_timeout(800)
        dup = a.evaluate("ZT.allTracks().filter(t => !t.tmp && t.yt && ['Faro azul', 'Corriente', 'Chispa'].includes(t.title)).length")
        check(dup == 0, f'A: no le llegan duplicados de YouTube ({dup})')
        check(a.evaluate(LISTS)['mix'] == lists_a['mix'], 'A: «Mezcla» sigue igual')

        # the page: 2.5 PC and Legacy
        a.evaluate("Mix.openPluginPage('gdrive')")
        a.wait_for_timeout(1500)
        a.evaluate("document.querySelector('.dc-sec')?.scrollIntoView()")
        a.wait_for_timeout(400)
        a.screenshot(path=f'{OUT}/5-pc-25-plugin.png')
        txt = a.evaluate("document.querySelector('.dc-sec')?.innerText || ''")
        check('copia de tu biblioteca' in txt.lower() and 'de soundcloud' in txt.lower(), 'PC 2.5: sección «Copia de tu biblioteca»')
        a.evaluate("Mix.setDesign('legacy')")
        a.wait_for_timeout(1500)
        a.evaluate("PluginsUI.open('gdrive')")
        a.wait_for_timeout(1500)
        a.evaluate("document.querySelector('.dc-sec')?.scrollIntoView()")
        a.wait_for_timeout(400)
        a.screenshot(path=f'{OUT}/6-pc-legacy-plugin.png')
        check(a.evaluate("!!document.querySelector('.dc-sec .seg button.sel')"), 'Legacy: la sección con el ajuste «Descargar las que tenías descargadas»')
        a.evaluate("document.documentElement.lang = 'en'")
        for name in ('A', 'B'):
            check(not errors[name], f'{name}: sin errores en la consola {errors[name][:5]}')
        br.close()
finally:
    for p in procs:
        p.terminate()
    for p in procs:
        try:
            p.wait(5)
        except Exception:
            p.kill()

print('\n' + ('TODO BIEN' if not fails else f'{len(fails)} FALLOS:\n- ' + '\n- '.join(fails)))
sys.exit(1 if fails else 0)
