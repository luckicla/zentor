#!/usr/bin/env python3
"""Prueba de navegación del diseño 2.5 (móvil 390 px y PC 1280 px), sin internet.

  go build -o /tmp/mixup-nav . && python3 tools/v25navtest/run.py

Reproduce el fallo «me he metido en una playlist y al volver la música ha dejado
de escucharse y se ha quedado colgado»: con una canción sonando, entra 30 veces
en playlists (también Me gusta y por la vieja ruta de la Biblioteca), álbumes,
artistas, Biblioteca y Plugins, baja por cada una y vuelve con los tres «atrás»
(la flecha de la vista, ztBack = el botón atrás de Android / Esc, V25.back).
Falla si la música se para o no avanza, si hay tareas largas grandes, o si
quedan escuchas o nodos sueltos después de volver (antes cada playlist dejaba
su lista virtual escuchando el scroll de .v-main y los eventos del motor).

Variables: MIXUP_BIN (/tmp/mixup-nav), MIXUP_ADDR (127.0.0.1:47903),
V25NAV_TMP (/tmp/v25navtest: canciones, carpetas y capturas)."""
import json, math, os, shutil, struct, subprocess, sys, time, urllib.request, wave
from playwright.sync_api import sync_playwright

ADDR = os.environ.get('MIXUP_ADDR', '127.0.0.1:47903')
BIN = os.environ.get('MIXUP_BIN', '/tmp/mixup-nav')
TMP = os.environ.get('V25NAV_TMP', '/tmp/v25navtest')
MUSIC = os.path.join(TMP, 'music')
OUT = os.path.join(TMP, 'out')
NAVS = 30
LONG_MAX = 250      # ms: the longest task allowed while navigating
os.makedirs(OUT, exist_ok=True)
fails = []


def check(ok, what):
    print(('ok    ' if ok else 'FALLO ') + what, flush=True)
    if not ok:
        fails.append(what)


def music():
    """A few long songs (2 min, to keep playing) and 300 short ones (a library of some size)."""
    if os.path.isdir(MUSIC):
        return
    def wav(path, secs, f, rate=8000):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        w = wave.open(path, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(b''.join(struct.pack('<h', int(7000 * math.sin(2 * math.pi * f * i / rate))) for i in range(rate * secs)) if f else b'\0\0' * rate * secs)
        w.close()
    for i, (ar, al, ti, f) in enumerate([('Luna Norte', 'Mareas', 'Faro azul', 220), ('Luna Norte', 'Mareas', 'Corriente', 262), ('Los Vatios', 'Voltaje', 'Chispa', 294)]):
        wav(os.path.join(MUSIC, al, f'{ar} - {ti}.wav'), 150, f)
    for a in range(12):
        for i in range(25):
            wav(os.path.join(MUSIC, f'Disco {a}', f'Grupo {a % 5} - Tema {a}-{i}.wav'), 1, 0)


def start(tag):
    try:
        urllib.request.urlopen(f'http://{ADDR}/api/version', timeout=1)
        sys.exit(f'{ADDR} ya está en uso: ciérralo o usa otro MIXUP_ADDR')
    except OSError:
        pass
    home, root = os.path.join(TMP, f'h-{tag}'), os.path.join(TMP, f'm-{tag}')
    shutil.rmtree(home, True); shutil.rmtree(root, True)
    os.makedirs(home); shutil.copytree(MUSIC, root)
    p = subprocess.Popen([BIN, '-root', root, '-headless'], env={**os.environ, 'MIXUP_ADDR': ADDR, 'HOME': home},
                         stdout=open(os.path.join(TMP, f'{tag}.log'), 'w'), stderr=subprocess.STDOUT)
    for _ in range(100):
        try:
            urllib.request.urlopen(f'http://{ADDR}/api/version', timeout=1); break
        except Exception:
            time.sleep(0.2)
    return p


INIT = """localStorage.setItem('zt.intro', '1');
window.__lt = [];
try { new PerformanceObserver(l => l.getEntries().forEach(e => __lt.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: true }); } catch (e) {}"""


def run(b, w, h):
    tag = 'móvil' if w < 900 else 'PC'
    phone = w < 900
    ctx = b.new_context(viewport={'width': w, 'height': h}, has_touch=phone, is_mobile=phone)
    ctx.add_init_script(INIT)
    pg = ctx.new_page()
    errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'http://{ADDR}/')
    pg.wait_for_function("typeof Mix !== 'undefined' && Mix.tracks().length >= 300", timeout=60000)
    pg.wait_for_timeout(1500)
    ev = pg.evaluate
    if not ev("document.documentElement.classList.contains('d25')"):
        ev("Mix.setDesign('v25')"); pg.wait_for_timeout(1200)
    check(ev("document.documentElement.classList.contains('" + ('d25-phone' if phone else 'd25-pc') + "')"), f'{tag}: diseño 2.5')
    cdp = ctx.new_cdp_session(pg)
    cdp.send('Performance.enable')

    def metrics():
        cdp.send('HeapProfiler.collectGarbage')
        m = {x['name']: x['value'] for x in cdp.send('Performance.getMetrics')['metrics']}
        return int(m['JSEventListeners']), int(m['Nodes'])

    ev("Mix.pl.create('Noche', Mix.tracks().filter(t => /Tema/.test(t.title)).slice(0, 250))")
    ev("Mix.tracks().filter(t => /Tema/.test(t.title)).slice(0, 6).forEach(t => Mix.like(t, true))")
    pg.wait_for_timeout(1500)
    pl = ev("Mix.playlists().find(p => p.name === 'Noche').id")
    album = ev('Mix.albums()[0].key')  # (no tags: «Sin álbum», every song)
    artist = ev("Mix.artists().find(a => a.name === 'Grupo 2').key")
    ev("Mix.playAll(Mix.tracks().find(t => t.title === 'Faro azul').id)")
    pg.wait_for_function('Mix.playing() && Mix.position() > 0.5', timeout=15000)
    # (one round first: what a view keeps for itself — caches, images — isn't a leak)
    for g in (f"V25.go('playlist', {{ id: '{pl}' }})", f"V25.go('album', {{ key: '{album}' }})", "V25.go('library', {}, { root: true })"):
        ev(g); pg.wait_for_timeout(300); ev('ztBack()'); pg.wait_for_timeout(300)
    lis0, nodes0 = metrics()
    ev('__lt.length = 0')
    pos0, t0 = ev('ZT.deck().currentTime'), time.time()
    trips = [
        (f"V25.go('playlist', {{ id: '{pl}' }})", 'arrow'),
        ("V25.go('playlist', { id: 'liked' })", 'android'),
        (f"V25.go('library', {{ playlist: '{pl}' }})", 'v25'),
        (f"V25.go('album', {{ key: '{album}' }})", 'arrow'),
        (f"V25.go('artist', {{ key: '{artist}' }})", 'android'),
        ("V25.go('library', {}, { root: true })", 'v25'),
        ("V25.go('store', {}, { root: true })", 'android'),
    ]
    stopped = []
    for i in range(NAVS):
        go, how = trips[i % len(trips)]
        ev(go); pg.wait_for_timeout(250)
        # down the page and up again (the scroll of .v-main is shared by every view)
        ev("(() => { const m = document.querySelector('#v25 .v-main'); m.scrollTop = 2500; m.dispatchEvent(new Event('scroll')); })()"); pg.wait_for_timeout(120)
        if how == 'arrow' and ev("!!document.querySelector('#v25 .lv-headback') && !!document.querySelector('#v25 .lv-headback').offsetParent"):
            pg.click('#v25 .lv-headback')
        elif how == 'v25':
            ev('V25.back()')
        else:
            ev('ztBack()')  # Android's back button, Esc
        pg.wait_for_timeout(250)
        if not ev('Mix.playing()'):
            stopped.append(i)
    pg.wait_for_timeout(600)
    elapsed, moved = time.time() - t0, ev('ZT.deck().currentTime') - pos0
    lt = ev('__lt.slice()')
    check(not stopped, f'{tag}: la música no se para al navegar ({NAVS} idas y vueltas; parada en {stopped[:5]})')
    check(moved > elapsed * 0.8, f'{tag}: la música avanza ({moved:.1f} s de audio en {elapsed:.1f} s)')
    check(ev("Mix.track().title") == 'Faro azul', f'{tag}: sigue la misma canción')
    check(ev("V25.current().id") == 'home', f'{tag}: de vuelta en Inicio ({ev("V25.current().id")})')
    check(not lt or max(lt) < LONG_MAX, f'{tag}: sin tareas largas grandes (máx. {max(lt) if lt else 0} ms, {len(lt)} de más de 50 ms)')
    lis1, nodes1 = metrics()
    check(lis1 <= lis0 + 25, f'{tag}: no quedan escuchas sueltas ({lis0} → {lis1})')
    check(nodes1 <= nodes0 * 1.1 + 500, f'{tag}: no quedan nodos sueltos ({nodes0} → {nodes1})')
    # scrolling Inicio after all that is as light as before
    ev('__lt.length = 0')
    s0 = time.time()
    ev("new Promise(r => { const m = document.querySelector('#v25 .v-main'); let k = 0; const f = () => { m.scrollTop = k % 2 ? 600 : 0; if (++k < 40) requestAnimationFrame(f); else r(); }; f(); })")
    lt = ev('__lt.slice()')
    check(not lt or max(lt) < LONG_MAX, f'{tag}: bajar por Inicio después va fluido ({time.time() - s0:.2f} s, máx. {max(lt) if lt else 0} ms)')
    pg.screenshot(path=os.path.join(OUT, f'{w}-final.png'))
    check(ev('Mix.playing()'), f'{tag}: al final sigue sonando')
    check(not errs, f'{tag}: sin errores en consola ' + '; '.join(errs[:3]))
    ctx.close()


music()
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required'])
    for w, h in ((390, 844), (1280, 820)):
        p = start(f'nav{w}')
        try:
            run(b, w, h)
        finally:
            p.terminate(); p.wait()
    b.close()
print('\n' + ('TODO BIEN' if not fails else f'{len(fails)} FALLOS'))
sys.exit(1 if fails else 0)
