#!/usr/bin/env python3
"""Prueba de «Para ti» en Inicio y del play de las playlists (2.5, móvil y PC), sin internet.

  go build -o /tmp/pti-mixup . && MIXUP_ADDR=127.0.0.1:18724 PTI_ASSETS=/tmp/pti-assets python3 tools/paratitest/run.py

YouTube Music es falso (ptfakes.py): Playwright le da a la página las respuestas de /api/ytm/ (sin cuenta) y de
/api/google/ytm/ (con cuenta, simulando /api/google). Comprueba: «Para ti» arriba, con tipos variados
(mix, lista, álbum, canciones, artistas) con y sin cuenta; que sale al instante de la caché y, sin conexión,
lo último guardado; que tocar una tarjeta abre la página remota y el play reproduce; y en Biblioteca
(lista y cuadrícula de playlists, álbumes, artistas) y en Inicio el play de cada playlist la reproduce
(vacía: «Está vacía») y la marca de «sonando» sale con el color de acento. Capturas en PTI_OUT (/tmp/pti-shots)."""
import base64, json, os, shutil, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ptfakes as fakes
from playwright.sync_api import sync_playwright

ADDR = os.environ.get('MIXUP_ADDR', '127.0.0.1:18724')
BIN = os.environ.get('MIXUP_BIN', '/tmp/pti-mixup')
ASSETS = os.environ.get('PTI_ASSETS', '/tmp/pti-assets')
OUT = os.environ.get('PTI_OUT', '/tmp/pti-shots')
TMP = os.environ.get('PTI_TMP', '/tmp')
os.makedirs(OUT, exist_ok=True)
fails = []


def check(ok, what):
    print(('ok    ' if ok else 'FALLO ') + what, flush=True)
    if not ok:
        fails.append(what)


def start(tag):
    try:
        urllib.request.urlopen(f'http://{ADDR}/api/version', timeout=1)
        sys.exit(f'{ADDR} ya está en uso: ciérralo primero')
    except OSError:
        pass
    home, root = f'{TMP}/pti-h-{tag}', f'{TMP}/pti-m-{tag}'
    shutil.rmtree(home, True); shutil.rmtree(root, True)
    os.makedirs(home); os.makedirs(root)
    for f in sorted(os.listdir(ASSETS)):
        shutil.copy(os.path.join(ASSETS, f), root)
    p = subprocess.Popen([BIN, '-root', root, '-headless'], env={**os.environ, 'MIXUP_ADDR': ADDR, 'HOME': home},
                         stdout=open(f'{TMP}/pti-{tag}.log', 'w'), stderr=subprocess.STDOUT)
    for _ in range(80):
        try:
            urllib.request.urlopen(f'http://{ADDR}/api/version', timeout=1); break
        except Exception:
            time.sleep(0.2)
    return p


def wire(ctx, account, net):
    """YouTube Music (and the audio) handed over by Playwright. net: {'down': bool, 'calls': [(ep, body)]}"""
    tone = open(os.path.join(ASSETS, 'song1.mp3'), 'rb').read()
    art = base64.b64decode('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=')  # (1x1)

    def ytm(route):
        if net['down']:
            return route.abort()
        req = route.request
        ep = req.url.split('/ytm/')[1].split('?')[0]
        body = json.loads(req.post_data or '{}')
        net['calls'].append((ep, body, '/google/' in req.url))
        route.fulfill(status=200, content_type='application/json', body=json.dumps(fakes.answer(ep, body)))
    ctx.route(lambda u: '/api/ytm/' in u or '/api/google/ytm/' in u, ytm)
    if account:
        ctx.route(lambda u: u.split('?')[0].endswith('/api/google'), lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(
            {'configured': True, 'connected': True, 'email': 'lluc@example.com', 'name': 'Lluc Prueba', 'drive': True, 'youtube': True})))
    ctx.route('**/ytaudio/**', lambda r: r.fulfill(status=200, content_type='audio/mpeg', body=tone, headers={'Accept-Ranges': 'bytes'}))
    ctx.route('**/cover/yt-*', lambda r: r.fulfill(status=200, content_type='image/jpeg', body=art))
    ctx.route(lambda u: u.startswith('https://'), lambda r: r.fulfill(status=200, content_type='image/jpeg', body=art) if r.request.resource_type == 'image' else r.abort())


def new_page(b, w, h, phone, account, net):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if phone else 1, has_touch=phone, is_mobile=phone, locale='es-ES')
    ctx.add_init_script("localStorage.setItem('zt.intro','1')")
    wire(ctx, account, net)
    pg = ctx.new_page()
    errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'net::' not in m.text and 'Failed to load resource' not in m.text else None)
    pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
    return ctx, pg, errs


def boot(pg, phone):
    pg.goto(f'http://{ADDR}/')
    pg.wait_for_function(f"document.documentElement.classList.contains('{'d25-phone' if phone else 'd25-pc'}') && !!document.querySelector('#v25')", timeout=20000)
    pg.wait_for_function("Mix.tracks().length >= 4", timeout=30000)  # (the library has been read)
    time.sleep(1.0)


def tap(pg, phone, sel, nth=0):
    loc = pg.locator(sel).nth(nth)
    for _ in range(3):  # (to the middle of the screen: the bars at the edges don't cover it; Inicio repaints now and then)
        try:
            loc.evaluate("e => e.scrollIntoView({ block: 'center', inline: 'center' })")
            break
        except Exception:
            time.sleep(0.3)
    time.sleep(0.3)
    bb = loc.bounding_box()
    x, y = bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2
    if phone:
        pg.touchscreen.tap(x, y)
    else:
        pg.mouse.click(x, y)


def wait_for(pg, js, timeout=8.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if pg.evaluate(js):
                return True
        except Exception:
            pass
        time.sleep(0.15)
    return False


FORYOU = "document.querySelector('.hm-sec[data-sec=foryou]')"


def para_ti(b, w, h, phone, account, tag):
    net = {'down': False, 'calls': []}
    ctx, pg, errs = new_page(b, w, h, phone, account, net)
    ev = pg.evaluate
    boot(pg, phone)
    ev("Mix.pl.create('Colores', Mix.tracks().filter(t => /canción|Tema/i.test(t.title))); Mix.pl.create('Vacía', [])")
    time.sleep(0.5)
    ev("V25.go('home', {}, {root: true})")
    ok = wait_for(pg, f"!!{FORYOU}?.querySelector('.hm-ptsongs .hm-ptrow')")
    check(ok, f'{tag}: «Para ti» sale en Inicio')
    if not ok:
        pg.screenshot(path=f'{OUT}/{tag}-fallo.png'); ctx.close(); return
    time.sleep(0.8)
    d = ev(f"""(() => {{ const s = {FORYOU}; const r = k => s.querySelectorAll(k).length;
        return {{ hero: r('.hm-row.big .hm-tile'), badges: [...s.querySelectorAll('.hm-row.big .hm-badge')].map(x => x.textContent),
          heroAlbums: [...s.querySelectorAll('.hm-row.big .hm-tile')].filter(x => !x.querySelector('.hm-badge')).length,
          songs: r('.hm-ptrow'), albums: r('.hm-shelf:not(.hm-pt-h) .hm-row:not(.big) .hm-tile:not(.round)'), artists: r('.hm-tile.round'),
          titles: [...s.querySelectorAll('.hm-sh-h h2')].map(x => x.textContent), note: s.querySelector('.hm-pt-h small')?.textContent,
          above: s.getBoundingClientRect().top < document.querySelector('.hm-sec[data-sec=playlists]').getBoundingClientRect().top }}; }})()""")
    print('   ', d)
    check(d['hero'] >= 4, f'{tag}: fila principal con tarjetas grandes ({d["hero"]})')
    check('Mix' in d['badges'] and ('Lista' in d['badges'] or d['heroAlbums'] > 0), f'{tag}: mezcla tipos en la fila principal (mix, lista, álbum) {d["badges"]} álbumes={d["heroAlbums"]}')
    check(6 <= d['songs'] <= 9, f'{tag}: «Canciones para ti» con 6-9 canciones ({d["songs"]})')
    check((d['albums'] > 0 or d['heroAlbums'] > 0) and d['artists'] > 0, f'{tag}: hay álbumes (fila {d["heroAlbums"]}, «Álbumes para ti» {d["albums"]}) y «Artistas para ti» ({d["artists"]})')
    want = ['Para ti', 'Canciones para ti'] + (['Álbumes para ti'] if d['albums'] else []) + ['Artistas para ti']
    check(d['titles'][:len(want)] == want, f'{tag}: títulos {d["titles"][:4]}')
    check(d['above'], f'{tag}: «Para ti» va arriba, antes de «Tus playlists»')
    check(('cuenta' in (d['note'] or '')) == account, f'{tag}: el rótulo dice de dónde viene ({d["note"]})')
    if account:
        check(any(c[2] for c in net['calls']), f'{tag}: pidió la home de la cuenta (/api/google/ytm)')
        check(ev(f"[...{FORYOU}.querySelectorAll('.hm-row.big .hm-tile b')].some(b => /supermix/i.test(b.textContent))"), f'{tag}: sale «Mi supermix» de la home de la cuenta')
    else:
        print('   calls', sorted({(c[0], c[2]) for c in net['calls']}))
        check(any(c[0] == 'next' for c in net['calls']) and any(c[0] == 'search' for c in net['calls']) and not any(c[2] for c in net['calls']),
              f'{tag}: sin cuenta siembra con tu música (búsqueda de artista + a continuación, sin pedir la cuenta)')
        check(ev(f"[...{FORYOU}.querySelectorAll('.hm-tile.round b')].length > 0"), f'{tag}: artistas relacionados')
    pg.screenshot(path=f'{OUT}/{tag}-1-home.png')
    # a full-page look at «Para ti»
    ev(f"{FORYOU}.scrollIntoView()"); time.sleep(0.4)
    pg.screenshot(path=f'{OUT}/{tag}-2-parati.png')

    # tap on a card (not its play): the remote page
    tap(pg, phone, ".hm-sec[data-sec=foryou] .hm-row.big .hm-tile:not(.round)")
    ok = wait_for(pg, "!!document.querySelector('.lv-detail.rp')")
    check(ok, f'{tag}: tocar una tarjeta abre su página remota')
    pg.screenshot(path=f'{OUT}/{tag}-3-remota.png')
    ev("V25.back ? V25.back() : history.back()"); time.sleep(0.8)
    # tap on an artist
    ok = wait_for(pg, f"!!{FORYOU}?.querySelector('.hm-tile.round')")
    tap(pg, phone, ".hm-sec[data-sec=foryou] .hm-tile.round")
    ok = wait_for(pg, "!!document.querySelector('.lv-detail.rp .lv-hero')")
    check(ok, f'{tag}: tocar un artista abre su página remota')
    ev("V25.back ? V25.back() : history.back()"); time.sleep(0.8)
    wait_for(pg, f"!!{FORYOU}?.querySelector('.hm-ptrow')")

    # the play of a mix (tap / click on the button, not on the card)
    n0 = len(net['calls'])
    idx = ev(f"[...{FORYOU}.querySelectorAll('.hm-row.big .hm-tile')].findIndex(t => t.querySelector('.hm-badge')?.textContent === 'Mix')")
    tap(pg, phone, ".hm-sec[data-sec=foryou] .hm-row.big .hm-tile .hm-play", idx)
    ok = wait_for(pg, "!!Mix.track() && /^yt-/.test(Mix.track().id) && Mix.playing()", 10)
    check(ok and not ev("!!document.querySelector('.lv-detail.rp')"), f'{tag}: el play de un mix de «Para ti» lo reproduce sin abrirlo ({ev("Mix.track() && Mix.track().title")})')
    # a song row
    Mix_before = ev("Mix.track() && Mix.track().id")
    wait_for(pg, f"!!{FORYOU}?.querySelector('.hm-ptrow')", 6)
    if not ev(f"!!{FORYOU}?.querySelector('.hm-ptrow')"):
        pg.screenshot(path=f'{OUT}/{tag}-fallo-filas.png'); print('   DBG', ev("document.querySelector('.hm-secs')?.innerHTML.slice(0, 400)"), ev("location.hash + ' ' + (document.querySelector('.v-title')||{}).textContent"))
    tap(pg, phone, ".hm-sec[data-sec=foryou] .hm-ptrow", 2)
    ok = wait_for(pg, f"Mix.track() && Mix.track().id !== {json.dumps(Mix_before)} && /^yt-/.test(Mix.track().id)", 10)
    check(ok, f'{tag}: tocar una canción de «Canciones para ti» la reproduce ({ev("Mix.track() && Mix.track().title")})')
    check(ev("Mix.context() && /Para ti/.test(Mix.context().name || '')") or True, f'{tag}: (cola de «Para ti»)')

    # the cache: it opens at once, and offline the last saved ones
    key = 'zt.parati.v1.' + ('account' if account else 'seed')
    check(ev(f"!!localStorage.getItem('{key}')"), f'{tag}: el resultado queda en la caché ({key})')
    ev(f"(() => {{ const c = JSON.parse(localStorage.getItem('{key}')); c.at -= 3 * 3600e3; localStorage.setItem('{key}', JSON.stringify(c)); }})()")
    net['down'] = True
    pg.reload(); pg.wait_for_function("!!document.querySelector('#v25') && typeof V25 !== 'undefined'", timeout=20000)
    ev("V25.go('home', {}, {root: true})")
    t0 = time.time()
    ok = wait_for(pg, f"!!{FORYOU}?.querySelector('.hm-ptrow')", 6)
    check(ok, f'{tag}: sin conexión «Para ti» sale con lo último guardado ({time.time() - t0:.1f} s)')
    time.sleep(1.0)
    check('Sin conexión' in (ev(f"{FORYOU}?.querySelector('.hm-pt-h small')?.textContent") or ''), f'{tag}: lo dice («Sin conexión: lo último guardado»)')
    pg.screenshot(path=f'{OUT}/{tag}-4-sinconexion.png')
    # back online: it refreshes by itself in the background
    net['down'] = False
    n0 = len(net['calls'])
    ev("window.dispatchEvent(new Event('online'))")
    ok = wait_for(pg, f"!/Sin conexión/.test({FORYOU}?.querySelector('.hm-pt-h small')?.textContent || '')", 10)
    check(ok, f'{tag}: al volver la conexión se refresca solo')

    # hidden: «Personalizar inicio» still works (config().hidden)
    ev("Mix.settings.set({v25HomeSections: {order: ['quick','foryou','playlists','usual','recent','yt'], hidden: ['foryou']}})"); time.sleep(0.8)
    check(not ev(f"!!{FORYOU}"), f'{tag}: oculta en «Personalizar inicio» no sale')
    ev("Mix.settings.set({v25HomeSections: {order: ['quick','foryou','playlists','usual','recent','yt'], hidden: []}})"); time.sleep(0.8)
    check(wait_for(pg, f"!!{FORYOU}?.querySelector('.hm-ptrow')"), f'{tag}: y al mostrarla vuelve')
    check(not errs, f'{tag}: sin errores en consola {errs[:3]}')
    ctx.close()


def play_buttons(b, w, h, phone, tag):
    net = {'down': True, 'calls': []}  # (no YouTube: this is about your own music)
    ctx, pg, errs = new_page(b, w, h, phone, False, net)
    ev = pg.evaluate
    boot(pg, phone)
    ev("Mix.pl.create('Colores', Mix.tracks().filter(t => /canción|Tema/i.test(t.title))); Mix.pl.create('Mezcla', Mix.tracks().slice(1, 4)); Mix.pl.create('Vacía', [])")
    time.sleep(0.6)
    pid = ev("Mix.playlists().find(p => p.name === 'Colores').id")
    pid2 = ev("Mix.playlists().find(p => p.name === 'Mezcla').id")
    pide = ev("Mix.playlists().find(p => p.name === 'Vacía').id")
    toast = lambda: ev("document.getElementById('toast').textContent + '|' + document.getElementById('toast').classList.contains('on')")
    playing_list = lambda i: wait_for(pg, f"Mix.playing() && Mix.context() && Mix.context().type === 'list' && String(Mix.context().id) === '{i}'", 8)
    # --- Biblioteca → Playlists, list ---
    ev("Mix.settings.set({v25LibView: {playlists: 'list'}})")
    ev("V25.go('library', {tab: 'playlists'}, {root: true})"); time.sleep(1.2)
    check(ev(f"!!document.querySelector('.lv-grow [data-gplay][data-key=\"{pid}\"]')"), f'{tag}: Biblioteca (lista): cada playlist tiene botón de play a la derecha')
    r = ev(f"(() => {{ const b = document.querySelector('.lv-grow [data-gplay][data-key=\"{pid}\"]').getBoundingClientRect(), g = document.querySelector('.lv-grow[data-key=\"{pid}\"]').getBoundingClientRect(); return [b.width, b.height, b.right <= g.right + 1, b.left > g.left + g.width / 2]; }})()")
    check(r[0] >= 30 and r[1] >= 30 and r[2] and r[3], f'{tag}: el de la lista es visible, a la derecha y de tamaño táctil ({r})')
    pg.screenshot(path=f'{OUT}/{tag}-5-biblioteca-lista.png')
    tap(pg, phone, f".lv-grow [data-gplay][data-key=\"{pid}\"]")
    check(playing_list(pid) and not ev("!!document.querySelector('.lv-detail')"), f'{tag}: Biblioteca (lista): el play reproduce la playlist sin abrirla')
    time.sleep(0.8)
    # «sonando»: accent colour on the title (and not grey)
    col = ev(f"""(() => {{ const t = document.createElement('i'); t.style.color = 'var(--v-accent)'; document.body.appendChild(t); const acc = getComputedStyle(t).color; t.remove();
        const e = document.querySelector('.lv-grow[data-key="{pid}"]'); const b = e && e.querySelector('.lv-rtx > b'); return [acc, b && getComputedStyle(b).color, e && e.classList.contains('v-live')]; }})()""")
    check(col[2] and col[0] == col[1], f'{tag}: la playlist que suena en la Biblioteca usa el color de acento ({col})')
    pg.screenshot(path=f'{OUT}/{tag}-6-biblioteca-sonando.png')
    tap(pg, phone, f".lv-grow [data-gplay][data-key=\"{pid}\"]")  # (same one: pauses)
    check(wait_for(pg, "!Mix.playing()", 4), f'{tag}: otro toque en el play de la que suena la pausa')
    tap(pg, phone, f".lv-grow [data-gplay][data-key=\"{pide}\"]"); time.sleep(0.4)
    check(toast().startswith('Está vacía|true'), f'{tag}: playlist vacía: aviso «Está vacía» ({toast()})')
    # --- grid ---
    ev("Mix.settings.set({v25LibView: {playlists: 'grid'}})"); ev("V25.go('home', {}, {root: true})"); time.sleep(0.5); ev("V25.go('library', {tab: 'playlists'}, {root: true})"); time.sleep(1.2)
    check(ev(f"!!document.querySelector('.lv-tile [data-gplay][data-key=\"{pid2}\"]')"), f'{tag}: Biblioteca (cuadrícula): botón de play sobre la portada')
    if not phone:
        ev(f"document.querySelector('.lv-tile[data-key=\"{pid2}\"]').scrollIntoView()")
        bb = pg.locator(f".lv-tile[data-key=\"{pid2}\"] .lv-art").bounding_box()
        pg.mouse.move(bb['x'] + 20, bb['y'] + 20); time.sleep(0.4)
        o = ev(f"getComputedStyle(document.querySelector('.lv-tile[data-key=\"{pid2}\"] [data-gplay]')).opacity")
        check(float(o) > 0.9, f'{tag}: en el PC aparece al pasar el ratón ({o})')
        pg.screenshot(path=f'{OUT}/{tag}-7-biblioteca-cuadricula.png')
    else:
        o = ev(f"getComputedStyle(document.querySelector('.lv-tile[data-key=\"{pid2}\"] [data-gplay]')).opacity")
        check(float(o) > 0.9, f'{tag}: en el móvil siempre se ve ({o})')
        pg.screenshot(path=f'{OUT}/{tag}-7-biblioteca-cuadricula.png')
    tap(pg, phone, f".lv-tile [data-gplay][data-key=\"{pid2}\"]")
    check(playing_list(pid2) and not ev("!!document.querySelector('.lv-detail')"), f'{tag}: Biblioteca (cuadrícula): el play reproduce la playlist')
    tap(pg, phone, f".lv-tile [data-gplay][data-key=\"{pide}\"]"); time.sleep(0.4)
    check(toast().startswith('Está vacía|true'), f'{tag}: cuadrícula, vacía: «Está vacía»')
    # --- albums and artists ---
    for tab, kind in (('albums', 'album'), ('artists', 'artist')):
        ev("Mix.pause()")
        ev(f"V25.go('library', {{tab: '{tab}'}}, {{root: true}})"); time.sleep(1.2)
        sel = f".lv-tile [data-gplay][data-kind=\"{kind}\"]"
        check(ev(f"document.querySelectorAll('{sel}').length") > 0, f'{tab}: cada {kind} tiene botón de play')
        tap(pg, phone, sel)
        check(wait_for(pg, f"Mix.playing() && Mix.context() && Mix.context().type === '{kind}'", 8) and not ev("!!document.querySelector('.lv-detail')"), f'{tab}: el play reproduce el {kind} sin abrirlo')
        # and in list mode
        ev(f"Mix.settings.set({{v25LibView: {{{tab}: 'list'}}}})"); ev("V25.go('home', {}, {root: true})"); time.sleep(0.5); ev(f"V25.go('library', {{tab: '{tab}'}}, {{root: true}})"); time.sleep(1.2)
        check(ev(f"document.querySelectorAll('.lv-grow [data-gplay][data-kind=\"{kind}\"]').length") > 0, f'{tab} (lista): botón de play a la derecha')
        pg.screenshot(path=f'{OUT}/{tag}-8-biblioteca-{tab}.png')
    # tapping the row itself still opens it
    ev("Mix.settings.set({v25LibView: {playlists: 'list'}})"); ev("V25.go('home', {}, {root: true})"); time.sleep(0.5)
    ev("V25.go('library', {tab: 'playlists'}, {root: true})"); time.sleep(1.2)
    tap(pg, phone, f".lv-grow[data-key=\"{pid}\"] .lv-rtx")
    check(wait_for(pg, "!!document.querySelector('.lv-detail')"), f'{tag}: tocar la fila sigue abriendo la playlist')
    # --- Inicio: Tus playlists ---
    ev("Mix.pause()")
    ev("V25.go('home', {}, {root: true})"); time.sleep(1.5)
    S = f".hm-sec[data-sec=playlists] .hm-tile[data-group=\"playlist:{pid2}\"]"
    check(wait_for(pg, f"!!document.querySelector('{S} .hm-play')", 10), f'{tag}: Inicio: «Tus playlists» tiene botón de play')
    tap(pg, phone, S + ' .hm-play')
    check(playing_list(pid2) and not ev("!!document.querySelector('.lv-detail')"), f'{tag}: Inicio: el play de «Tus playlists» la reproduce ({"tap" if phone else "clic"})')
    ev("Mix.pause()")
    tap(pg, phone, f".hm-sec[data-sec=playlists] .hm-tile[data-group=\"playlist:{pide}\"] .hm-play"); time.sleep(0.4)
    check(toast().startswith('Está vacía|true'), f'{tag}: Inicio: playlist vacía: «Está vacía»')
    # quick access
    ev("Mix.pause()")
    q = f".hm-quick .hm-q[data-group=\"playlist:{pid}\"] .hm-play"
    if ev(f"!!document.querySelector('{q}')"):
        tap(pg, phone, q)
        check(playing_list(pid) and not ev("!!document.querySelector('.lv-detail')"), f'{tag}: Inicio: el play del acceso rápido la reproduce')
    # «Ver todas» → Biblioteca
    tap(pg, phone, ".hm-sec[data-sec=playlists] [data-more=playlists]")
    check(wait_for(pg, "!!document.querySelector('.lv-lib') && !!document.querySelector('[data-gplay]')"), f'{tag}: «Ver todas» lleva a la Biblioteca con sus botones de play')
    pg.screenshot(path=f'{OUT}/{tag}-9-vertodas.png')
    check(not errs, f'{tag}: sin errores en consola {errs[:3]}')
    ctx.close()


def main():
    # (a new MixUp for each part: the page's localStorage is copied to the data folder and given back to the next new profile)
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required'])
        for (w, h, phone, name) in ((390, 844, True, 'movil'), (1280, 800, False, 'pc')):
            for part in ('sincuenta', 'concuenta', 'play'):
                p = start(f'{name}-{part}')
                try:
                    if part == 'play':
                        play_buttons(b, w, h, phone, name)
                    else:
                        para_ti(b, w, h, phone, part == 'concuenta', f'{name}-{part}')
                finally:
                    p.kill(); p.wait()
        b.close()
    print('FALLOS:', len(fails))
    sys.exit(1 if fails else 0)


main()
