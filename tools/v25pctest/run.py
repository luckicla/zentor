#!/usr/bin/env python3
"""Prueba del diseño 2.5 en el PC (web/v25/pc/), sin internet.

  go build -o /tmp/mixup-pc . && python3 tools/v25pctest/run.py

Arranca MixUp en 127.0.0.1:47902 (instalación nueva = 2.5, y alguien que
actualiza = Legacy que luego prueba el 2.5) con unas canciones WAV hechas
aquí, y comprueba: búsqueda al instante, Enter → vista «search», atrás /
adelante, Esc solo cierra (nunca va atrás), Ctrl+K, Ctrl+←/→, arrastrar a una
playlist, cola (reordenar), letra, «Sonando» grande, botones de Legacy en la
barra (Ajustes, DJ), menú plegado en ventanas estrechas. Capturas en
/tmp/v25pctest-out (1280x820, 1920x1080, 1024x700)."""
import json, math, os, shutil, struct, subprocess, sys, time, urllib.request, wave
from playwright.sync_api import sync_playwright

ADDR = '127.0.0.1:47902'
BIN = os.environ.get('MIXUP_BIN', '/tmp/mixup-pc')
OUT = '/tmp/v25pctest-out'
MUSIC = '/tmp/v25pctest-music'
os.makedirs(OUT, exist_ok=True)
fails = []


def check(ok, what):
    print(('ok    ' if ok else 'FALLO ') + what, flush=True)
    if not ok:
        fails.append(what)


def music():
    if os.path.isdir(MUSIC):
        return
    songs = [('Luna Norte', 'Mareas', 'Faro azul', 220), ('Luna Norte', 'Mareas', 'Corriente', 262), ('Luna Norte', 'Mareas', 'Bajamar', 330),
             ('Los Vatios', 'Voltaje', 'Chispa', 294), ('Los Vatios', 'Voltaje', 'Cortocircuito', 196), ('Aire Fino', '', 'Despegue', 349)]
    for ar, al, ti, f in songs:
        d = os.path.join(MUSIC, al or 'sueltas'); os.makedirs(d, exist_ok=True)
        w = wave.open(os.path.join(d, f'{ar} - {ti}.wav'), 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(11025)
        w.writeframes(b''.join(struct.pack('<h', int(9000 * math.sin(2 * math.pi * f * i / 11025))) for i in range(11025 * 40)))
        w.close()
    open(os.path.join(MUSIC, 'Mareas', 'Luna Norte - Faro azul.lrc'), 'w').write('\n'.join(f'[00:{i * 3:02d}.00]Línea {i + 1} de la letra' for i in range(13)))


def start(tag, settings=None):
    try:
        urllib.request.urlopen(f'http://{ADDR}/api/version', timeout=1)
        sys.exit(f'{ADDR} ya está en uso (¿un MixUp de una prueba anterior?): ciérralo primero')
    except OSError:
        pass
    home, root = f'/tmp/h-{tag}-pc', f'/tmp/m-{tag}-pc'
    shutil.rmtree(home, True); shutil.rmtree(root, True)
    os.makedirs(home); shutil.copytree(MUSIC, root)
    if settings is not None:
        os.makedirs(os.path.join(root, '.zentor'))
        json.dump(settings, open(os.path.join(root, '.zentor', 'settings.json'), 'w'))
    p = subprocess.Popen([BIN, '-root', root, '-headless'], env={**os.environ, 'MIXUP_ADDR': ADDR, 'HOME': home},
                         stdout=open(f'/tmp/v25pctest-{tag}.log', 'w'), stderr=subprocess.STDOUT)
    for _ in range(80):
        try:
            urllib.request.urlopen(f'http://{ADDR}/api/version', timeout=1); break
        except Exception:
            time.sleep(0.2)
    return p


def page(b, w, h, errs):
    pg = b.new_context(viewport={'width': w, 'height': h}).new_page()  # (its own storage)
    pg.on('console', lambda m: m.type == 'error' and 'Failed to load resource' not in m.text and errs.append(m.text))
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.add_init_script("localStorage.setItem('zt.intro','1')")
    pg.goto(f'http://{ADDR}/'); pg.wait_for_timeout(1800)
    return pg


def fresh(b):
    errs = []
    pg = page(b, 1280, 820, errs)
    ev = pg.evaluate
    if not ev("document.documentElement.classList.contains('d25-pc')"):
        # (another MixUp on this machine / network may have synced its settings: then it isn't «new»)
        print('      (no arrancó en 2.5: ajustes de otro MixUp cercano; se pone a mano)')
        ev("Mix.setDesign('v25')"); pg.wait_for_timeout(1200)
    check(ev("document.documentElement.classList.contains('d25-pc')"), '2.5 en el PC')
    ev("Mix.pl.create('Noche')")
    pg.keyboard.press('Space'); pg.wait_for_timeout(1500)
    check(ev('Mix.playing()'), 'Espacio: suena')
    t0 = ev('Mix.track().id'); pg.keyboard.press('Control+ArrowRight'); pg.wait_for_timeout(500)
    check(ev('Mix.track().id') != t0, 'Ctrl+→: siguiente')
    pg.keyboard.press('Control+ArrowLeft'); pg.wait_for_timeout(500)
    pg.screenshot(path=f'{OUT}/1280-inicio.png')
    pg.click('.pc-search input'); pg.keyboard.type('luna'); pg.wait_for_timeout(500)
    check(ev("!document.querySelector('.pc-drop').hidden && document.querySelectorAll('.pc-drop [data-k=song]').length === 3"), 'búsqueda al instante: 3 canciones')
    pg.screenshot(path=f'{OUT}/1280-busqueda.png')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
    check(ev("document.querySelector('.pc-drop').hidden"), 'Esc cierra los resultados')
    pg.keyboard.press('Enter'); pg.wait_for_timeout(500)
    check(ev("V25.current().id") == 'search', 'Enter abre la vista de búsqueda')
    pg.click('.pc-libtabs [data-tab="songs"]'); pg.wait_for_timeout(400)
    pg.keyboard.press('Escape'); pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
    check(ev("V25.current().params.tab") == 'songs', 'Esc no vuelve atrás por las vistas')
    pg.click('.pc-hist [data-act="back"]'); pg.wait_for_timeout(300)
    check(ev("V25.current().id") == 'home', 'atrás (las secciones del menú empiezan de cero: a Inicio)')
    pg.click('.pc-hist [data-act="fwd"]'); pg.wait_for_timeout(300)
    check(ev("V25.current().params.tab") == 'songs', 'adelante')
    pg.click('.pc-pl[data-pl]:not([data-pl="liked"])'); pg.wait_for_timeout(300)
    pg.click('.pc-hist [data-act="back"]'); pg.wait_for_timeout(300)
    check(ev("V25.current().params.tab") == 'songs', 'atrás desde una playlist')
    pg.keyboard.press('Control+k')
    check(ev("!!document.activeElement.closest('.pc-search')"), 'Ctrl+K: a la búsqueda')
    pg.keyboard.press('Escape'); pg.keyboard.press('Escape'); pg.wait_for_timeout(500)
    pg.locator('.v-main [data-track]').first.drag_to(pg.locator('.pc-pl[data-pl]:not([data-pl="liked"])').first); pg.wait_for_timeout(400)
    check(ev("Mix.playlists().find(p => p.name === 'Noche').count") == 1, 'arrastrar una canción a una playlist')
    ev("Mix.enqueue(Mix.tracks().slice(2, 5))"); pg.keyboard.press('q'); pg.wait_for_timeout(400)
    before = ev("Mix.queue().queued.map(t => t.id)")
    pg.locator('.pc-qlist [data-q-i]').nth(2).drag_to(pg.locator('.pc-qlist [data-q-i]').nth(0), target_position={'x': 20, 'y': 5}); pg.wait_for_timeout(300)
    check(ev("Mix.queue().queued.map(t => t.id)") == [before[2], before[0], before[1]], 'cola: reordenar arrastrando')
    pg.screenshot(path=f'{OUT}/1280-cola.png')
    pg.keyboard.press('y'); pg.wait_for_timeout(1200)
    pg.screenshot(path=f'{OUT}/1280-letra.png')
    pg.keyboard.press('f'); pg.wait_for_timeout(900)
    check(ev('V25.fullPlayer.isOpen()'), 'F: «Sonando» grande')
    pg.screenshot(path=f'{OUT}/1280-sonando.png')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(400)
    check(not ev('V25.fullPlayer.isOpen()') and ev("V25.current().params.tab") == 'songs', 'Esc cierra «Sonando» y se queda en la vista')
    check(not errs, 'sin errores en consola (nueva): ' + '; '.join(errs[:3]))
    pg.close()
    for w, h in ((1920, 1080), (1024, 700)):
        errs = []
        pg = page(b, w, h, errs)
        if not pg.evaluate("document.documentElement.classList.contains('d25')"):
            pg.evaluate("Mix.setDesign('v25')"); pg.wait_for_timeout(1200)
        pg.keyboard.press('Space'); pg.wait_for_timeout(1200)
        if w < 1100:
            check(pg.evaluate("document.getElementById('v25').classList.contains('pc-side-mini')"), f'{w}px: menú solo con iconos')
        pg.screenshot(path=f'{OUT}/{w}-inicio.png')
        check(not errs, f'sin errores en consola ({w}px)')
        pg.close()


def updater(b):
    errs = []
    pg = page(b, 1280, 820, errs)
    ev = pg.evaluate
    check(not ev("document.documentElement.classList.contains('d25')"), 'quien actualiza: Legacy')
    pg.screenshot(path=f'{OUT}/legacy.png')
    ev("Mix.setDesign('v25')"); pg.wait_for_timeout(1200)
    pg.keyboard.press('Space'); pg.wait_for_timeout(1200)
    ids = ev("[...document.querySelectorAll('.pc-legacy-btns [data-legacy]')].filter(b => !b.hidden).map(b => b.dataset.legacy)")
    check('btnSettings' not in ids and 'btnQueue' in ids, 'barra: los botones de Legacy, en su orden y sin Ajustes (un solo botón de ajustes, arriba a la izquierda): ' + ','.join(ids))
    check(ev("document.querySelectorAll('#v25 .v-setbtn').length") == 1 and ev("!document.querySelector('#v25 .v-setbtn svg path[d^=\"M19.4\"]')"), 'un solo botón de ajustes, con el icono de las dos barritas')
    pg.click('#v25 .v-setbtn'); pg.wait_for_timeout(500)
    check(ev('Mix.settingsOpen()'), 'el botón de ajustes de arriba abre Ajustes')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(400)
    check(not ev('Mix.settingsOpen()'), 'Esc cierra Ajustes')
    pg.screenshot(path=f'{OUT}/legacy-a-25.png')
    ev("Mix.setDesign('legacy')"); pg.wait_for_timeout(1000)
    check(not ev("!!document.getElementById('v25')"), 'de vuelta a Legacy: no queda nada del 2.5')
    check(not errs, 'sin errores en consola (quien actualiza): ' + '; '.join(errs[:3]))
    pg.close()


music()
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required'])
    for tag, st, fn in (('new', None, fresh), ('upd', {'theme': 'synth', 'dj': True}, updater)):
        p = start(tag, st)
        try:
            fn(b)
        finally:
            p.terminate(); p.wait()
    b.close()
print('\n' + ('TODO BIEN' if not fails else f'{len(fails)} FALLOS'))
sys.exit(1 if fails else 0)
