#!/usr/bin/env python3
"""Prueba de «Letra» y «Sobre el artista» en las pantallas principales del 2.5 (web/v25/nowinfo.js), sin internet.

  go build -o /tmp/mixup-f2 . && python3 tools/nowinfotest/run.py

Instalación nueva (2.5) en 127.0.0.1:47908 con canciones WAV hechas aquí (una con .lrc al lado) y /api/artist
simulado por Playwright. Móvil 390x844 (reproductor grande: tarjetas al bajar, Inicio: «Sonando ahora») y PC 1280x820
(Inicio, «Sonando» grande con letra + artista, panel derecho). Con el plugin «artistinfo» apagado no sale tarjeta ni se
pide nada a /api/artist. Capturas en /tmp/nowinfotest-out."""
import json, math, os, shutil, struct, subprocess, sys, time, urllib.request, wave
from playwright.sync_api import sync_playwright

ADDR = os.environ.get('MIXUP_ADDR', '127.0.0.1:47908')
BIN = os.environ.get('MIXUP_BIN', '/tmp/mixup-f2')
OUT = '/tmp/nowinfotest-out'
ROOT, HOME = '/tmp/m-f2', '/tmp/h-f2'
os.makedirs(OUT, exist_ok=True)
fails = []
PIC = 'data:image/svg+xml;utf8,' + "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='250'><rect width='400' height='250' fill='%23c0392b'/><circle cx='200' cy='110' r='70' fill='%23f5b041'/></svg>"
INFO = {'name': 'Luna Norte', 'picture': PIC, 'fans': 123456, 'albums': 7, 'bio': 'Luna Norte es un grupo imaginario de música electrónica formado en 2010. ' * 6, 'bioUrl': 'https://es.wikipedia.org/wiki/Luna_Norte', 'bioLang': 'es', 'fetched': 1}


def check(ok, what):
    print(('ok    ' if ok else 'FALLO ') + what, flush=True)
    if not ok:
        fails.append(what)


def music():
    shutil.rmtree(HOME, True); shutil.rmtree(ROOT, True); os.makedirs(HOME); os.makedirs(ROOT)
    songs = [('Luna Norte', 'Mareas', 'Faro azul', 220), ('Luna Norte', 'Mareas', 'Corriente', 262), ('Luna Norte', 'Mareas', 'Bajamar', 330),
             ('Los Vatios', 'Voltaje', 'Chispa', 294)]
    for ar, al, ti, f in songs:
        w = wave.open(os.path.join(ROOT, f'{ar} - {ti}.wav'), 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(11025)
        w.writeframes(b''.join(struct.pack('<h', int(9000 * math.sin(2 * math.pi * f * i / 11025))) for i in range(11025 * 60)))
        w.close()
    open(os.path.join(ROOT, 'Luna Norte - Faro azul.lrc'), 'w').write('\n'.join(f'[00:{i * 2:02d}.00]Línea {i + 1} de la letra' for i in range(25)))


def start():
    env = {**os.environ, 'MIXUP_ADDR': ADDR, 'HOME': HOME}
    p = subprocess.Popen([BIN, '-root', ROOT, '-headless'], env=env, stdout=open('/tmp/nowinfotest.log', 'w'), stderr=subprocess.STDOUT)
    for _ in range(60):
        try:
            urllib.request.urlopen(f'http://{ADDR}/api/version', timeout=1); break
        except Exception:
            time.sleep(0.2)
    return p


def page(b, w, h, touch):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if touch else 1, has_touch=touch, is_mobile=touch)
    ctx.add_init_script("localStorage.setItem('zt.intro','1')")
    pg = ctx.new_page()
    errs, calls = [], []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'net::' not in m.text and 'Failed to load resource' not in m.text else None)
    pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
    def art(route):
        calls.append(route.request.url)
        route.fulfill(status=200, content_type='application/json', body=json.dumps(INFO))
    pg.route('**/api/artist?*', art)
    return ctx, pg, errs, calls


def swipe(cdp, x0, y0, x1, y1, steps=10, dur=0.2):
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x0, 'y': y0}]})
    for i in range(1, steps + 1):
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x0 + (x1 - x0) * i / steps, 'y': y0 + (y1 - y0) * i / steps}]})
        time.sleep(dur / steps)
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})


def boot(pg, cls):
    pg.goto(f'http://{ADDR}/')
    pg.wait_for_function(f"document.documentElement.classList.contains('{cls}') && typeof Mix !== 'undefined' && Mix.tracks().length >= 4", timeout=20000)
    pg.evaluate("Mix.plugins.enable('artistinfo')")  # (a new install has it installed but off)
    time.sleep(1)


def play_luna(pg, at=5):
    pg.evaluate("(() => { const t = Mix.tracks().find(t => /Faro azul/.test(t.title)); Mix.playContext([t, ...Mix.tracks().filter(x => x !== t)], 0, 'Prueba'); })()")
    pg.wait_for_function("Mix.track() && /Faro azul/.test(Mix.track().title)")
    pg.evaluate(f"Mix.seek({at})")
    pg.wait_for_function("(() => { const d = Mix.lyrics.data(); return d && d.lines && d.at >= 0; })()", timeout=10000)


def phone(b):
    ctx, pg, errs, calls = page(b, 390, 844, True)
    boot(pg, 'd25-phone')
    cdp = ctx.new_cdp_session(pg)
    play_luna(pg)
    # --- Inicio: the «Sonando ahora» card is gone (owner: it got in the way; PC and phone)
    pg.evaluate("V25.go('home', {}, { root: true })")
    time.sleep(1.2)
    check(not pg.locator('.hm-nowc').count() or not pg.locator('.hm-nowc').first.is_visible(), 'móvil: Inicio ya no tiene la tarjeta «Sonando ahora»')
    pg.screenshot(path=f'{OUT}/phone-1-home.png')
    pg.evaluate("V25.fullPlayer.open()")
    time.sleep(0.8)
    check(pg.evaluate("V25.fullPlayer.isOpen()"), 'móvil: el reproductor grande se abre')
    # --- reproductor grande
    pg.screenshot(path=f'{OUT}/phone-2-full-top.png')
    check(pg.locator('.p25-more').is_visible(), 'móvil: hay tarjetas debajo del reproductor')
    check(pg.locator('.p25-lyrcard').is_visible(), 'móvil: tarjeta «Letra»')
    pg.wait_for_function("!document.querySelector('.p25-artcard').hidden", timeout=8000)
    check(pg.locator('.p25-artcard .n25-name').inner_text() == 'Luna Norte', 'móvil: tarjeta «Sobre el artista» con el nombre')
    # scroll with the finger from the cover
    cv = pg.locator('.p25-fp-cover').bounding_box()
    swipe(cdp, cv['x'] + cv['width'] / 2, cv['y'] + cv['height'] - 20, cv['x'] + cv['width'] / 2, cv['y'] - 60, steps=14, dur=0.3)
    time.sleep(0.9)
    st = pg.evaluate("document.querySelector('.p25-scroll').scrollTop")
    check(st > 150, f'móvil: deslizar hacia arriba desde la portada baja a las tarjetas (scrollTop {st:.0f})')
    check(pg.evaluate("V25.fullPlayer.isOpen()"), 'móvil: sigue abierto')
    pg.screenshot(path=f'{OUT}/phone-3-full-cards.png')
    on = pg.evaluate("document.querySelector('.p25-lyrin p.on')?.textContent")
    check(bool(on), f'móvil: línea activa resaltada («{on}»)')
    # tap a line = seek
    pg.evaluate("Mix.seek(1)"); time.sleep(0.8)
    pg.locator('.p25-lyrin p[data-li="10"]').click(force=True)
    time.sleep(0.8)
    pos = pg.evaluate("Mix.position()")
    check(19 <= pos <= 24, f'móvil: tocar una línea hace seek (posición {pos:.1f}, esperada ~20)')
    # auto-scroll of the window
    w0 = pg.evaluate("document.querySelector('.p25-lyrwin').scrollTop")
    pg.evaluate("Mix.seek(40)"); time.sleep(1.5)
    w1 = pg.evaluate("document.querySelector('.p25-lyrwin').scrollTop")
    check(w1 > w0, f'móvil: la letra se desplaza sola ({w0:.0f} → {w1:.0f})')
    # scroll further to the artist card
    pg.evaluate("document.querySelector('.p25-scroll').scrollTo(0, 9999)"); time.sleep(0.6)
    pg.screenshot(path=f'{OUT}/phone-4-full-artist.png')
    check(pg.locator('.p25-artcard .n25-trow').count() >= 3, 'móvil: canciones del artista en la biblioteca')
    pg.locator('.p25-artcard [data-n25="more"]').click(); time.sleep(0.3)
    check(pg.evaluate("document.querySelector('.p25-artcard .n25-ac').classList.contains('open')"), 'móvil: «Ver más» expande la bio')
    pg.screenshot(path=f'{OUT}/phone-5-full-artist-open.png')
    # play a top song
    pg.locator('.p25-artcard .n25-trow').nth(1).click(); time.sleep(0.6)
    check(pg.evaluate("Mix.track().artist") == 'Luna Norte' and pg.evaluate("Mix.context().type") in ('ids', 'list', 'artist') and abs(pg.evaluate('Mix.position()')) < 3, 'móvil: tocar una canción del artista la reproduce')
    # lyrics header -> full screen lyrics
    pg.evaluate("document.querySelector('.p25-scroll').scrollTo(0, 0)")
    play_luna(pg, 6)
    pg.evaluate("document.querySelector('.p25-scroll').scrollTo(0, 9999)"); time.sleep(0.4)
    pg.locator('.p25-lyrcard .p25-card-h').click(); time.sleep(0.8)
    check(pg.evaluate("Mix.lyrics.isOpen()"), 'móvil: la cabecera de «Letra» abre la letra a pantalla completa')
    pg.screenshot(path=f'{OUT}/phone-6-lyrics-full.png')
    pg.evaluate("Mix.lyrics.close()")
    # go to artist
    pg.evaluate("document.querySelector('.p25-scroll').scrollTo(0, 9999)"); time.sleep(0.3)
    pg.locator('.p25-artcard [data-n25="go"]').click(); time.sleep(1)
    cur = pg.evaluate("V25.current && V25.current()")
    check(not pg.evaluate("V25.fullPlayer.isOpen()") and 'artist' in json.dumps(cur), f'móvil: «Ir al artista» abre su ficha ({json.dumps(cur)[:80]})')
    pg.screenshot(path=f'{OUT}/phone-7-artist.png')
    # swiping down at the top still collapses
    pg.evaluate("V25.fullPlayer.open()"); time.sleep(0.8)
    swipe(cdp, 200, 300, 200, 700, steps=12, dur=0.25); time.sleep(0.8)
    check(not pg.evaluate("V25.fullPlayer.isOpen()"), 'móvil: deslizar hacia abajo (arriba del todo) sigue bajando el reproductor')
    # song with no lyrics: the lyrics card hides
    pg.evaluate("Mix.playContext(Mix.tracks().filter(t => /Vatios/.test(t.artist)), 0, 'x')"); pg.evaluate("V25.fullPlayer.open()"); time.sleep(1.5)
    check(pg.locator('.p25-lyrcard').is_hidden(), 'móvil: sin letra no hay tarjeta «Letra»')
    check(pg.locator('.p25-artcard').is_visible(), 'móvil: otro artista también tiene su tarjeta')
    pg.screenshot(path=f'{OUT}/phone-8-nolyrics.png')
    # --- plugin off: no card, no network
    n0 = len(calls)
    pg.evaluate("V25.fullPlayer.close(); Mix.plugins.disable('artistinfo')"); time.sleep(0.5)
    pg.evaluate("Mix.playContext(Mix.tracks().filter(t => /Mareas|Luna/.test(t.artist + t.album)).slice(1), 0, 'y'); V25.fullPlayer.open()"); time.sleep(1.5)
    check(pg.locator('.p25-artcard').is_hidden(), 'móvil: con el plugin apagado no hay tarjeta del artista')
    pg.evaluate("V25.fullPlayer.close(); V25.go('home', {}, { root: true })"); time.sleep(1)
    check(len(calls) == n0, f'móvil: sin red hacia /api/artist con el plugin apagado ({len(calls) - n0} llamadas)')
    pg.screenshot(path=f'{OUT}/phone-9-home-pluginoff.png')
    check(not errs, f'móvil: sin errores en consola {errs[:3]}')
    ctx.close()


def pc(b):
    ctx, pg, errs, calls = page(b, 1280, 820, False)
    boot(pg, 'd25-pc')
    play_luna(pg)
    pg.evaluate("V25.go('home', {}, { root: true })"); time.sleep(1.2)
    check(not pg.locator('.hm-nowc').count() or not pg.locator('.hm-nowc').first.is_visible(), 'PC: Inicio ya no tiene «Sonando ahora»')
    pg.screenshot(path=f'{OUT}/pc-1-home.png')
    # right panel
    pg.evaluate("PC25.right.show('now')"); time.sleep(1.2)
    pg.wait_for_function("(() => { const c = document.querySelector('.pc-artistcard'); return c && !c.hidden && /Luna Norte/.test(c.textContent); })()", timeout=8000)
    check(True, 'PC: el panel derecho «Sonando» muestra el artista')
    pg.screenshot(path=f'{OUT}/pc-2-right.png')
    # big view
    # (2.5 PC fixes: the lyrics under the cover in «Sonando»)
    pg.wait_for_function("(() => { const c = document.querySelector('.pc-rlyr'); return c && !c.hidden && /Línea/.test(c.textContent); })()", timeout=8000)
    check(True, 'PC: «Sonando» lleva la letra bajo la portada')
    pg.evaluate("V25.fullPlayer.open()"); time.sleep(1.2)
    check(pg.evaluate("V25.fullPlayer.isOpen()"), 'PC: se abre «Sonando» grande')
    pg.wait_for_function("!document.querySelector('.pc-fabout').hidden && document.querySelector('.pc-fabout .n25-name')", timeout=8000)
    time.sleep(1)
    check(pg.locator('.pc-fabout').is_visible(), 'PC: «Sonando» grande tiene la tarjeta del artista')
    check(pg.locator('.pc-flyr p').count() >= 20, 'PC: …y la letra a su lado')
    b1, b2 = pg.locator('.pc-fright').bounding_box(), pg.locator('.pc-fabout').bounding_box()
    check(b2['x'] >= b1['x'] + b1['width'] - 2, 'PC: letra y artista en columnas distintas')
    pg.screenshot(path=f'{OUT}/pc-3-big.png')
    pg.locator('.pc-fabout [data-n25="more"]').click(); time.sleep(0.3)
    pg.screenshot(path=f'{OUT}/pc-4-big-more.png')
    pg.locator('.pc-fabout [data-n25="go"]').click(); time.sleep(1)
    check(not pg.evaluate("V25.fullPlayer.isOpen()"), 'PC: «Ir al artista» cierra «Sonando» y abre la ficha')
    pg.screenshot(path=f'{OUT}/pc-5-artist.png')
    n0 = len(calls)
    pg.evaluate("Mix.plugins.disable('artistinfo')"); time.sleep(0.4)
    pg.evaluate("V25.go('home', {}, { root: true })"); pg.evaluate("V25.fullPlayer.open()"); time.sleep(1)
    check(pg.locator('.pc-fabout').is_hidden(), 'PC: con el plugin apagado «Sonando» no lleva artista')
    check(pg.locator('.pc-flyr p').count() >= 20, 'PC: la letra sigue')
    pg.screenshot(path=f'{OUT}/pc-6-big-pluginoff.png')
    check(len(calls) == n0, 'PC: sin red con el plugin apagado')
    check(not errs, f'PC: sin errores en consola {errs[:3]}')
    ctx.close()


if __name__ == '__main__':
    music()
    srv = start()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
            phone(b)
            pc(b)
            b.close()
    finally:
        srv.terminate()
    print('\nFALLOS:' if fails else '\nTodo bien', *fails, sep='\n')
    sys.exit(1 if fails else 0)
