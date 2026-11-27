#!/usr/bin/env python3
"""End-to-end test of the 2.5 search (phone and PC): suggestions while typing, results in real time
(debounced, older requests cancelled, no flicker), source and kind chips, the top result, playing a song
of each source (YouTube, Spotify → YouTube, SoundCloud with its audio through the Go server), saving a
SoundCloud song, and the pages of an album / artist / SoundCloud set / profile / Spotify album.

  go build -o /tmp/srch-mixup . && python3 tools/searchtest/run.py

No internet: SoundCloud, Spotify and YouTube's suggestions are a fake server (fakes.py) the Go server is
pointed at (MIXUP_SC_WEB/…); YouTube Music's answers and the YouTube audio are handed to the page by
Playwright. Screenshots in SRCH_OUT (/tmp/srch-out)."""
import json, os, shutil, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
import fakes
from playwright.sync_api import sync_playwright

ADDR = os.environ.get('MIXUP_ADDR', '127.0.0.1:18613')
FAKE_PORT = int(os.environ.get('SRCH_FAKE_PORT', '18615'))
BIN = os.environ.get('MIXUP_BIN', '/tmp/srch-mixup')
OUT = os.environ.get('SRCH_OUT', '/tmp/srch-out')
SONGS = os.environ.get('SRCH_SONGS', '/tmp/srch-phone-assets')
os.makedirs(OUT, exist_ok=True)
fails = []


def check(ok, what):
    print(('ok    ' if ok else 'FALLO ') + what, flush=True)
    if not ok:
        fails.append(what)


def start():
    home, root = '/tmp/srch-h', '/tmp/srch-m'
    shutil.rmtree(home, True); shutil.rmtree(root, True)
    os.makedirs(home); os.makedirs(root)
    if os.path.isdir(SONGS):
        for f in sorted(os.listdir(SONGS)):
            if f.endswith('.mp3'):
                shutil.copy(os.path.join(SONGS, f), root)
    fake = f'http://127.0.0.1:{FAKE_PORT}'
    env = {**os.environ, 'MIXUP_ADDR': ADDR, 'HOME': home, 'MIXUP_SC_WEB': fake, 'MIXUP_SC_API': fake, 'MIXUP_SP_WEB': fake,
           'MIXUP_SP_PARTNER': fake, 'MIXUP_SP_API': fake, 'MIXUP_YT_SUGGEST': fake}
    p = subprocess.Popen([BIN, '-root', root, '-headless'], env=env, stdout=open('/tmp/srch-mixup.log', 'w'), stderr=subprocess.STDOUT)
    for _ in range(60):
        try:
            urllib.request.urlopen(f'http://{ADDR}/api/version', timeout=1); break
        except Exception:
            time.sleep(0.2)
    return p


def wire(ctx, stats):
    """YouTube Music, its pictures and the YouTube audio, handed over by Playwright."""
    tone = open(os.path.join(fakes.ASSETS, 'tone.mp3'), 'rb').read()
    art = open(os.path.join(fakes.ASSETS, 'art.jpg'), 'rb').read()

    def ytm(route):
        req = route.request
        ep = req.url.split('/api/ytm/')[1].split('?')[0]
        body = json.loads(req.post_data or '{}')
        if ep == 'search':
            stats['ytm_search'].append((body.get('query'), body.get('params', '')))
            time.sleep(0.15)  # (a real round trip: lets newer keys cancel older requests)
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(fakes.ytm_search(body.get('query', ''), body.get('params', ''))))
        if ep == 'music/get_search_suggestions':
            stats['ytm_suggest'] += 1
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(fakes.ytm_suggest(body.get('input', ''))))
        if ep == 'browse':
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(fakes.ytm_browse(body.get('browseId', ''))))
        if ep == 'player':
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({'playabilityStatus': {'status': 'OK'}, 'videoDetails': {'lengthSeconds': '20'}}))
        return route.fulfill(status=200, content_type='application/json', body='{}')

    def ytaudio(route):
        stats['ytaudio'] += 1
        route.fulfill(status=200, content_type='audio/mpeg', body=tone, headers={'Accept-Ranges': 'bytes'})
    ctx.route('**/api/ytm/**', ytm)
    ctx.route('**/ytaudio/**', ytaudio)
    ctx.route('**/cover/yt-*', lambda r: r.fulfill(status=200, content_type='image/jpeg', body=art))
    ctx.route(lambda u: u.startswith('https://'), lambda r: r.fulfill(status=200, content_type='image/jpeg', body=art) if r.request.resource_type == 'image' else r.abort())
    ctx.on('requestfailed', lambda r: stats['aborted'].append(r.url) if '/api/' in r.url else None)


def new_page(b, w, h, mobile, stats):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, has_touch=mobile, is_mobile=mobile)
    ctx.add_init_script("localStorage.setItem('zt.intro','1')")
    wire(ctx, stats)
    pg = ctx.new_page()
    errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'net::' not in m.text and 'Failed to load resource' not in m.text else None)
    pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
    return ctx, pg, errs


def stats0():
    return {'ytm_search': [], 'ytm_suggest': 0, 'ytaudio': 0, 'aborted': []}


def wait(pg, js, what, timeout=8000):
    try:
        pg.wait_for_function(js, timeout=timeout); return True
    except Exception:
        check(False, what + ' (tiempo agotado)'); return False


def phone(b):
    st = stats0()
    ctx, pg, errs = new_page(b, 390, 844, True, st)
    pg.goto(f'http://{ADDR}/')
    pg.wait_for_function("document.documentElement.classList.contains('d25-phone') && !!document.querySelector('.p25-bar-btn') && Mix.tracks().length > 0", timeout=20000)
    pg.wait_for_timeout(1000)
    pg.evaluate("V25.go('search', { focus: true }, { root: true })"); pg.wait_for_timeout(400)
    inp = pg.locator('.lv-sfield input')
    inp.click()
    # a sampler: once results are there, the songs section must never go empty while typing (no flicker)
    pg.evaluate("""window.__flick = { seen: false, empties: 0 }; (function loop() {
        const n = document.querySelectorAll('[data-sec="songs"] .sr-row').length;
        if (n) __flick.seen = true; else if (__flick.seen && document.querySelector('.lv-sfield input')?.value.trim()) __flick.empties++;
        requestAnimationFrame(loop); })();""")
    pg.keyboard.type('ros', delay=70)
    ok = wait(pg, "document.querySelectorAll('.sr-sugrow').length >= 3", 'sugerencias al escribir')
    sug = pg.evaluate("[...document.querySelectorAll('.sr-sugrow span')].map(s => s.textContent)")
    check(ok and any('ros remix' in s for s in sug), f'móvil: autocompletado de YouTube Music ({sug[:4]})')
    wait(pg, "document.querySelectorAll('[data-sec=\"songs\"] .sr-row').length >= 3 && !!document.querySelector('.sr-top:not([hidden]) .lv-topres')", 'resultados en vivo')
    pg.screenshot(path=f'{OUT}/m1-escribiendo-sugerencias.png')
    # the letters typed quickly: one YouTube Music search for the last text, not one per key
    qs = [q for q, p in st['ytm_search']]
    check('ros' in qs and 'r' not in qs and len([q for q in qs if q in ('ro', 'ros')]) <= 2, f'móvil: con espera (~250 ms) no busca en cada letra ({qs})')
    pg.keyboard.press('Escape')  # closes the suggestions, keeps the text
    check(inp.input_value() == 'ros' and pg.locator('.sr-sug').is_hidden(), f'móvil: Esc cierra las sugerencias sin borrar ({inp.input_value()!r})')
    pg.evaluate("document.activeElement.blur()"); pg.wait_for_timeout(300)
    secs = pg.evaluate("[...document.querySelectorAll('.sr-sec:not([hidden])')].map(s => s.dataset.sec)")
    check(secs[:5] == ['songs', 'albums', 'artists', 'playlists', 'videos'], f'móvil: secciones por tipo, lo de internet primero ({secs})')
    top = pg.evaluate("document.querySelector('.sr-top b').textContent")
    check(top == 'ros Artist', f'móvil: mejor resultado arriba = el de YouTube Music ({top})')
    srcs = pg.evaluate("[...new Set([...document.querySelectorAll('[data-sec=\"songs\"] .sr-row')].map(r => r.className.match(/sr-(youtube|spotify|soundcloud)/)?.[1]))]")
    check(set(srcs) >= {'youtube', 'spotify', 'soundcloud'}, f'móvil: canciones de YouTube, Spotify y SoundCloud mezcladas ({srcs})')
    kinds = pg.evaluate("""({ albums: document.querySelectorAll('[data-sec="albums"] .sr-tile').length, artists: document.querySelectorAll('[data-sec="artists"] .sr-tile').length,
        playlists: document.querySelectorAll('[data-sec="playlists"] .sr-tile').length, videos: document.querySelectorAll('[data-sec="videos"] .sr-tile').length,
        scProfile: !!document.querySelector('[data-sec="artists"] .sr-tile .scb'), spAlbum: [...document.querySelectorAll('[data-sec="albums"] .sr-tile')].some(t => t.textContent.includes('green album')),
        info: [...document.querySelectorAll('[data-sec="albums"] .sr-tile small')].map(s => s.textContent).join(' | ') })""")
    check(kinds['albums'] >= 3 and kinds['artists'] >= 3 and kinds['playlists'] >= 2 and kinds['videos'] >= 3 and kinds['scProfile'] and kinds['spAlbum'], f'móvil: álbumes, artistas/perfiles, playlists y vídeos de todas las fuentes ({kinds})')
    check('2021' in kinds['info'] and ('Sencillo' in kinds['info'] or 'Single' in kinds['info']), f'móvil: los álbumes con año y tipo ({kinds["info"][:90]})')
    subs = pg.evaluate("[...document.querySelectorAll('[data-sec=\"artists\"] .sr-tile small')].map(s => s.textContent).join(' | ')")
    check('suscriptores' in subs and ('seguidores' in subs or 'followers' in subs), f'móvil: suscriptores y seguidores de los artistas ({subs[:90]})')
    pg.screenshot(path=f'{OUT}/m2-resultados-todo.png', full_page=False)
    # more letters: the results follow, without emptying in between
    inp.click(); pg.keyboard.type('a', delay=40)
    wait(pg, "[...document.querySelectorAll('[data-sec=\"songs\"] .sr-row b')].some(b => b.textContent.startsWith('rosa '))", 'resultados que se actualizan')
    pg.wait_for_timeout(400)
    fl = pg.evaluate("__flick")
    check(fl['seen'] and fl['empties'] == 0, f'móvil: sin parpadeos al seguir escribiendo ({fl})')
    pg.keyboard.press('Backspace'); pg.keyboard.type('a', delay=10); pg.keyboard.press('Backspace'); pg.keyboard.type('al', delay=10)
    wait(pg, "[...document.querySelectorAll('[data-sec=\"songs\"] .sr-row b')].some(b => b.textContent.startsWith('rosal '))", 'resultados de «rosal»')
    check(len(st['aborted']) >= 0, f'móvil: peticiones viejas canceladas: {len(st["aborted"])}')
    pg.evaluate("document.activeElement.blur()"); pg.wait_for_timeout(300)
    # a suggestion: fills the field and searches at once
    inp.click(); pg.wait_for_timeout(600)
    if pg.locator('.sr-sugrow').count():
        pg.locator('.sr-sugrow').first.click(); pg.wait_for_timeout(800)
        check(inp.input_value().startswith('rosal'), f'móvil: tocar una sugerencia busca eso ({inp.input_value()})')
    pg.evaluate("document.activeElement.blur()")
    pg.fill('.lv-sfield input', 'ros'); pg.dispatch_event('.lv-sfield input', 'input'); pg.wait_for_timeout(200)
    pg.evaluate("document.activeElement.blur()")
    wait(pg, "[...document.querySelectorAll('[data-sec=\"songs\"] .sr-row b')].some(b => b.textContent.startsWith('ros '))", 'vuelta a «ros»')
    pg.wait_for_timeout(500)
    # chips: SoundCloud
    pg.locator('.sr-chip[data-src="soundcloud"]').click(); pg.wait_for_timeout(600)
    sc = pg.evaluate("[...document.querySelectorAll('.sr-row, .sr-tile')].map(r => r.className.includes('sr-soundcloud') || !!r.querySelector('.scb'))")
    check(sc and all(sc), f'móvil: chip SoundCloud: solo SoundCloud ({len(sc)} resultados)')
    pg.screenshot(path=f'{OUT}/m3-chip-soundcloud.png')
    hits = fakes.HITS['sc_cdn']
    pg.locator('[data-sec="songs"] .sr-row').first.click()
    ok = wait(pg, "Mix.track() && String(Mix.track().id).startsWith('sc-') && Mix.playing() && Mix.position() > 0.3", 'suena la de SoundCloud', 12000)
    check(ok and fakes.HITS['sc_cdn'] > hits, f'móvil: una canción de SoundCloud suena (audio por /audio/sc-… desde el servidor) {pg.evaluate("Mix.track() && [Mix.track().id, Mix.track().src, Mix.position()]")}')
    cover = pg.evaluate("fetch('/cover/' + Mix.track().id).then(r => r.ok && r.headers.get('content-type'))")
    check(cover == 'image/jpeg', f'móvil: portada de SoundCloud por /cover/sc-… ({cover})')
    # save it: in your music for good, with the SoundCloud mark
    pg.locator('[data-sec="songs"] .sr-save').first.click(); pg.wait_for_timeout(800)
    savedsc = pg.evaluate("Mix.tracks().filter(t => t.src === 'soundcloud' && !t.tmp).map(t => t.id)")
    check(len(savedsc) >= 1, f'móvil: guardar una de SoundCloud ({savedsc})')
    disk = json.load(open('/tmp/srch-m/.zentor/soundcloud.json')) if os.path.exists('/tmp/srch-m/.zentor/soundcloud.json') else {}
    check(len(disk.get('items', [])) >= 1, f'móvil: queda en soundcloud.json ({len(disk.get("items", []))})')
    pg.evaluate("Mix.pl.create('Nube', [Mix.byId(%s)])" % json.dumps(savedsc[0] if savedsc else ''))
    pg.wait_for_timeout(400)
    check(pg.evaluate("Mix.playlists().some(p => p.name === 'Nube' && p.tracks.some(t => t.src === 'soundcloud'))"), 'móvil: una de SoundCloud en una playlist')
    # SoundCloud: a set and a profile
    pg.locator('[data-sec="albums"] .sr-tile').first.click()
    wait(pg, "V25.current().id === 'remote' && document.querySelectorAll('.rp-tracks .sr-row').length === 2", 'página de un set de SoundCloud')
    check(pg.evaluate("[...document.querySelectorAll('.rp-tracks .sr-row b')].map(b => b.textContent).join('|')").count('cloud mix') == 2, 'móvil: el set de SoundCloud con sus pistas (las que faltaban, pedidas por id)')
    pg.screenshot(path=f'{OUT}/m4-set-soundcloud.png')
    pg.evaluate("V25.back()"); pg.wait_for_timeout(500)
    pg.locator('[data-sec="artists"] .sr-tile').first.click()
    wait(pg, "V25.current().id === 'remote' && document.querySelectorAll('.rp-tracks .sr-row').length >= 1 && /seguidores|followers/.test(document.querySelector('.lv-h-meta').textContent)", 'perfil de SoundCloud')
    pg.evaluate("V25.back()"); pg.wait_for_timeout(500)
    # Spotify: a song plays as the same song from YouTube
    pg.locator('.sr-chip[data-src="spotify"]').click(); pg.wait_for_timeout(600)
    check(pg.locator('.sr-note').count() == 1, 'móvil: aviso de que Spotify suena desde YouTube')
    pg.screenshot(path=f'{OUT}/m5-chip-spotify.png')
    pg.locator('[data-sec="songs"] .sr-row').first.click()
    ok = wait(pg, "Mix.track() && Mix.track().yt === 'GREEN000001' && Mix.track().src === 'spotify' && Mix.playing()", 'Spotify → YouTube suena', 12000)
    check(ok, f'móvil: una de Spotify suena con su equivalente de YouTube {pg.evaluate("Mix.track() && [Mix.track().id, Mix.track().src]")}')
    pg.locator('[data-sec="albums"] .sr-tile').first.click()
    if not wait(pg, "V25.current().id === 'remote' && document.querySelector('.rp-note')", 'página de un álbum de Spotify', 6000):
        print('   ', pg.evaluate("[V25.current().id, JSON.stringify(V25.current().params).slice(0, 200), document.querySelector('.rp')?.innerText.slice(0, 200)]"))
    pg.evaluate("V25.back()"); pg.wait_for_timeout(400)
    # kinds: Álbumes (YouTube Music with its filter), then an album and an artist page
    pg.locator('.sr-chip[data-src="youtube"]').click(); pg.wait_for_timeout(300)
    pg.locator('.sr-chip[data-type="albums"]').click()
    wait(pg, "document.querySelectorAll('[data-sec=\"albums\"] .sr-grid .sr-tile').length >= 2", 'chip Álbumes')
    pg.wait_for_timeout(800)
    check(any(p == 'EgWKAQIYAWoMEA4QChADEAQQCRAF' for q, p in st['ytm_search']), f'móvil: el chip Álbumes busca con el filtro de álbumes de YouTube Music ({st["ytm_search"][-4:]})')
    pg.screenshot(path=f'{OUT}/m6-chip-albumes.png')
    pg.locator('[data-sec="albums"] .sr-tile').first.click()
    wait(pg, "V25.current().id === 'remote' && document.querySelectorAll('.rp-tracks .sr-row').length === 3", 'página de álbum de YouTube')
    pg.screenshot(path=f'{OUT}/m7-album-youtube.png')
    pg.locator('.rp-tracks .sr-row').nth(1).click()
    ok = wait(pg, "Mix.track() && Mix.track().yt === 'ALBT0000002' && Mix.playing()", 'pista del álbum suena', 10000)
    check(ok and st['ytaudio'] > 0, f'móvil: tocar una pista del álbum la reproduce (YouTube) ytaudio={st["ytaudio"]}')
    pg.evaluate("V25.back()"); pg.wait_for_timeout(400)
    pg.locator('.sr-chip[data-type="artists"]').click()
    wait(pg, "document.querySelectorAll('[data-sec=\"artists\"] .sr-tile').length >= 1", 'chip Artistas')
    pg.locator('[data-sec="artists"] .sr-tile').first.click()
    wait(pg, "V25.current().id === 'remote' && document.querySelectorAll('.rp-tracks .sr-row').length === 3 && document.querySelectorAll('.v-shelf .sr-tile').length === 2", 'página de artista de YouTube')
    pg.screenshot(path=f'{OUT}/m8-artista-youtube.png')
    pg.evaluate("V25.back()"); pg.wait_for_timeout(400)
    # your music: further down, after everything from the internet
    pg.fill('.lv-sfield input', 'Banda'); pg.dispatch_event('.lv-sfield input', 'input')
    pg.locator('.sr-chip[data-src="all"]').click(); pg.locator('.sr-chip[data-type="all"]').click()
    wait(pg, "document.querySelectorAll('[data-sec=\"songs\"] .sr-row').length >= 3 && !!document.querySelector('[data-sec=\"local\"]:not([hidden]) .lv-row')", 'tu música al final')
    secs = pg.evaluate("[...document.querySelectorAll('.sr-sec:not([hidden])')].map(s => s.dataset.sec)")
    top = pg.evaluate("document.querySelector('.sr-top .lv-topres')?.dataset.track ? 'local' : 'internet'")
    check(secs and secs[-1] == 'local' and secs[0] != 'local' and top == 'internet', f'móvil: tu música sale detrás de lo de internet ({secs}, mejor resultado: {top})')
    pg.screenshot(path=f'{OUT}/m9-tu-musica-al-final.png')
    # Tu música: your library alone
    pg.locator('.sr-chip[data-src="local"]').click(); pg.wait_for_timeout(400)
    check(pg.locator('[data-sec="local"]').count() == 1 and pg.locator('.sr-sec[data-sec="songs"]').count() == 0, 'móvil: chip «Tu música» solo enseña tu música')
    # after a reload: the saved SoundCloud song is in the library with its mark
    pg.reload()
    pg.wait_for_function("document.documentElement.classList.contains('d25-phone') && Mix.tracks().some(t => t.src === 'soundcloud')", timeout=15000)
    pg.evaluate("V25.go('library', { tab: 'songs' }, { root: true })"); pg.wait_for_timeout(800)
    pg.evaluate("V25.go('search', { q: 'cloud' }, { root: true })"); pg.wait_for_timeout(600)
    check(pg.locator('.lv-sc .scb').count() >= 1, 'móvil: la canción de SoundCloud guardada sale con su logo en tu música')
    check(not errs, f'móvil: sin errores en consola {errs[:3]}')
    ctx.close()


def pc(b):
    st = stats0()
    ctx, pg, errs = new_page(b, 1280, 820, False, st)
    pg.goto(f'http://{ADDR}/')
    pg.wait_for_function("document.documentElement.classList.contains('d25-pc') && !!document.querySelector('.pc-search input')", timeout=20000)
    pg.wait_for_timeout(1000)
    pg.evaluate("V25.go('home', {}, { root: true })"); pg.wait_for_timeout(300)
    pg.click('.pc-search input')
    pg.keyboard.type('ros', delay=60)
    ok = wait(pg, "[...document.querySelectorAll('.pc-dsug')].length >= 2", 'PC: sugerencias en el buscador de arriba')
    check(ok, f'PC: el buscador de arriba sugiere al escribir ({pg.evaluate("[V25.current().id, document.querySelector(\'.pc-drop\').hidden, document.querySelector(\'.pc-drop\').innerText.slice(0, 160)]")})')
    pg.screenshot(path=f'{OUT}/p1-pc-sugerencias.png')
    pg.keyboard.press('Enter'); pg.wait_for_timeout(400)
    wait(pg, "V25.current().id === 'search' && document.querySelectorAll('[data-sec=\"songs\"] .sr-row').length >= 3", 'PC: vista de resultados')
    view = pg.evaluate("window.__v = document.querySelector('.lv-search'); !!window.V25Search")
    pg.keyboard.type('a', delay=40)
    wait(pg, "[...document.querySelectorAll('[data-sec=\"songs\"] .sr-row b')].some(b => b.textContent.startsWith('rosa '))", 'PC: resultados al seguir escribiendo arriba')
    same = pg.evaluate("window.__v === document.querySelector('.lv-search')")
    check(view and same, 'PC: escribir arriba actualiza la vista sin volver a montarla (sin parpadeo)')
    pg.screenshot(path=f'{OUT}/p2-pc-resultados.png')
    check(not errs, f'PC: sin errores en consola {errs[:3]}')
    ctx.close()


def sc_cases(b):
    """SoundCloud as it really is now: tracks that only come as HLS (MP3 / AAC in fMP4 / MPEG-TS) must sound and seek;
    encrypted and 30 s-preview ones must be refused with a clear reason (not fail silently)."""
    st = stats0()
    ctx, pg, errs = new_page(b, 1280, 820, False, st)
    pg.goto(f'http://{ADDR}/')
    pg.wait_for_function("document.documentElement.classList.contains('d25-pc') && typeof SoundCloud !== 'undefined' && typeof Mix !== 'undefined'", timeout=20000)
    pg.wait_for_timeout(800)
    cases = [(1101, 'MP3 por HLS (segmentos pegados)'), (1102, 'AAC en MP4 fragmentado por HLS (init + .m4s)')]
    cases.append((1105, 'AAC en MPEG-TS por HLS (ffmpeg lo pasa a M4A)'))
    for i, name in cases:
        pg.evaluate(f"SoundCloud.play([{{ id: '{i}', title: 'caso {i}', artist: 'x', dur: 8 }}], '{i}')")
        ok = wait(pg, f"Mix.track() && Mix.track().id === 'sc-{i}' && Mix.playing() && Mix.position() > 0.5", f'PC: suena {name}', 15000)
        if ok:
            dur = pg.evaluate("Mix.duration()")
            pg.evaluate("Mix.seek(3)")
            ok2 = wait(pg, "Mix.position() > 3.1", f'PC: se puede saltar en {name}', 8000)
            check(ok2 and dur > 4, f'PC: {name}: suena, dura {dur:.1f} s y se salta a 3 s')
    for i, why in [(1103, 'cifrada'), (1104, '30 s')]:
        r = pg.evaluate(f"fetch('/audio/sc-{i}', {{ headers: {{ Range: 'bytes=0-1' }} }}).then(async r => [r.status, await r.text()])")
        check(r[0] == 404 and why in r[1], f'PC: la pista {i} se rechaza con motivo claro ({r})')
    ctx.close()


def main():
    srv = fakes.serve(FAKE_PORT)
    p = start()
    try:
        with sync_playwright() as pw:
            b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required'])
            phone(b)
            pc(b)
            sc_cases(b)
            b.close()
    finally:
        p.kill(); srv.shutdown()
    print('peticiones al falso:', fakes.HITS)
    print('FALLOS:', len(fails))
    sys.exit(1 if fails else 0)


main()
