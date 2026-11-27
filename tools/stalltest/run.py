#!/usr/bin/env python3
"""El servidor atascado (2.5.1: «se me ha parado la música, ha ido saltando
canciones y las imágenes dejaron de cargar hasta reiniciar»).

  go build -o /tmp/stall-mixup . && python3 tools/stalltest/run.py

1. Java (el servidor del móvil, ServerGuard.java sin Android): 30 streams que
   nadie lee, 30 peticiones a un internet colgado, todos los hilos ocupados y
   el hilo que acepta muerto; el audio y las portadas siguen respondiendo y la
   canción que sonaba no se corta.
2. Go (el del PC, de verdad): conexiones de audio paradas que se cierran solas;
   con «internet» colgado (un proxy que acepta y nunca contesta) la búsqueda de
   portada, el artista, la letra y la búsqueda de portadas contestan a tiempo
   y el audio y las portadas siguen al momento.
3. La web (Playwright, 2.5 móvil): con el servidor «atascado» (audio y ping sin
   respuesta) no salta: reintenta la misma con «MixUp no responde…» y vuelve
   a sonar cuando el servidor vuelve; las imágenes que fallaron se cargan solas
   al volver; una que de verdad no está se quita como antes; con archivos
   rotos salta dos y a la tercera se para con «Reintentar».
Variables: MIXUP_ADDR (127.0.0.1:18665), MIXUP_BIN (/tmp/stall-mixup),
STALL_TMP (/tmp/stall-run), STALL_JAVA_PORT (18666), STALL_PROXY_PORT (18669)."""
import json, math, os, shutil, socket, struct, subprocess, sys, threading, time, urllib.request, wave
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
ADDR = os.environ.get('MIXUP_ADDR', '127.0.0.1:18665')
BIN = os.environ.get('MIXUP_BIN', '/tmp/stall-mixup')
TMP = os.environ.get('STALL_TMP', '/tmp/stall-run')
JPORT = os.environ.get('STALL_JAVA_PORT', '18666')
PPORT = int(os.environ.get('STALL_PROXY_PORT', '18669'))
fails = []


def check(ok, what):
    print(('ok    ' if ok else 'FALLO ') + what, flush=True)
    if not ok:
        fails.append(what)


# ---- 1. Java ----
def java():
    out = os.path.join(TMP, 'java')
    shutil.rmtree(out, True); os.makedirs(out)
    J = os.path.join(REPO, 'android/app/src/main/java/com/zentor/player/ServerGuard.java')
    r = subprocess.run(['javac', '-d', out, J, os.path.join(HERE, 'StallTest.java')], capture_output=True, text=True)
    if r.returncode:
        check(False, 'java: compila ServerGuard + StallTest: ' + r.stderr[-800:]); return
    r = subprocess.run(['java', '-Dstdout.encoding=UTF-8', '-cp', out, 'com.zentor.player.StallTest', JPORT], capture_output=True, text=True, timeout=180)
    for line in r.stdout.splitlines():
        print(line, flush=True)
        if line.startswith('FALLO'):
            fails.append(line[6:])
    if r.returncode and not any(l.startswith('FALLO') for l in r.stdout.splitlines()):
        check(False, 'java: terminó con error ' + r.stderr[-500:])


# ---- 2. Go ----
def blackhole():
    """A «proxy» that accepts and never answers: the internet hanging."""
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', PPORT)); s.listen(200)
    held = []
    def run():
        while True:
            try:
                c, _ = s.accept(); held.append(c)
            except OSError:
                return
    threading.Thread(target=run, daemon=True).start()
    return s


def music(root):
    def wav(path, f):
        w = wave.open(path, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(11025)
        w.writeframes(b''.join(struct.pack('<h', int(9000 * math.sin(2 * math.pi * f * i / 11025))) for i in range(11025 * 30)))
        w.close()
    d = os.path.join(root, 'buenas'); os.makedirs(d)
    wav(os.path.join(d, 'Luna Norte - Faro azul.wav'), 220)
    wav(os.path.join(d, 'Luna Norte - Corriente.wav'), 262)
    wav(os.path.join(d, 'Cuarteto de Nos - La bestia pop (versión ñandú).wav'), 330)  # no cover, accents
    d = os.path.join(root, 'rotas'); os.makedirs(d)
    for i in range(3):
        open(os.path.join(d, f'Rota - Roto {i + 1}.mp3'), 'wb').write(os.urandom(200_000))
    # a big one, for the parked streams (bigger than what the sockets buffer)
    d = os.path.join(root, 'grande'); os.makedirs(d)
    open(os.path.join(d, 'Grande - Larga.mp3'), 'wb').write(os.urandom(48 << 20))


def http(path, method='GET', timeout=30, headers=None):
    t0 = time.time()
    try:
        req = urllib.request.Request(f'http://{ADDR}{path}', method=method, headers=headers or {}, data=b'' if method == 'POST' else None)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read(); return r.status, time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, time.time() - t0
    except Exception:
        return -1, time.time() - t0


def fast(tracks, what, n=6):
    worst, ok = 0, True
    a = tracks[0]['id']
    for _ in range(n):
        s1, t1 = http(f'/audio/{a}', headers={'Range': 'bytes=0-1'}, timeout=5)
        s2, t2 = http('/icons/mixup.png', timeout=5)
        ok &= s1 == 206 and s2 == 200
        worst = max(worst, t1, t2)
        time.sleep(0.25)
    check(ok and worst < 1.5, f'{what} (peor: {worst * 1000:.0f} ms)')


def go_server():
    home, root = os.path.join(TMP, 'home'), os.path.join(TMP, 'music')
    shutil.rmtree(home, True); shutil.rmtree(root, True)
    os.makedirs(home); music(root)
    env = {**os.environ, 'MIXUP_ADDR': ADDR, 'HOME': home, 'MIXUP_STALL_SECS': '3',
           'HTTPS_PROXY': f'http://127.0.0.1:{PPORT}', 'HTTP_PROXY': f'http://127.0.0.1:{PPORT}', 'https_proxy': f'http://127.0.0.1:{PPORT}', 'http_proxy': f'http://127.0.0.1:{PPORT}', 'NO_PROXY': '127.0.0.1,localhost', 'no_proxy': '127.0.0.1,localhost'}
    p = subprocess.Popen([BIN, '-root', root, '-headless'], env=env, stdout=open(os.path.join(TMP, 'mixup.log'), 'w'), stderr=subprocess.STDOUT)
    for _ in range(100):
        if http('/api/version', timeout=1)[0] == 200:
            break
        time.sleep(0.2)
    return p


def go_tests():
    tracks = json.loads(urllib.request.urlopen(f'http://{ADDR}/api/tracks').read())
    good = [t for t in tracks if 'Rot' not in t['title'] and 'Larga' not in t['title']]
    a = next(t['id'] for t in tracks if 'Larga' in t['title'])
    # parked streams: asked for and never read
    parked = []
    for _ in range(30):
        s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
        s.connect(tuple([ADDR.split(':')[0], int(ADDR.split(':')[1])]))
        s.sendall(f'GET /audio/{a} HTTP/1.1\r\nHost: {ADDR}\r\n\r\n'.encode()); parked.append(s)
    fast(good, 'go: con 30 streams de audio parados, audio y portadas siguen respondiendo')
    time.sleep(5)
    closed = 0
    for s in parked:
        s.settimeout(2)
        try:
            while True:
                b = s.recv(1 << 20)
                if not b:
                    closed += 1; break
        except (ConnectionResetError, BrokenPipeError):
            closed += 1
        except socket.timeout:
            pass
        s.close()
    check(closed >= 28, f'go: los streams parados se cierran solos ({closed} de 30)')
    # the internet hanging: everything that needs it answers in time
    nocover = next(t for t in good if 'Cuarteto' in t['artist'] or 'Cuarteto' in t['title'])
    q = urllib.parse.quote
    jobs = [('/api/covers?id=' + nocover['id'], 'POST', 17), ('/api/hqcover?id=' + nocover['id'], 'POST', 14),
            ('/api/artist?name=' + q('Cuarteto de Nos'), 'GET', 12), ('/api/coversearch?q=' + q('Cuarteto de Nos La bestia pop'), 'GET', 14),
            ('/api/lyrics/online?artist=' + q('Cuarteto de Nos') + '&title=' + q('La bestia pop') + '&dur=30', 'GET', 12)]
    with ThreadPoolExecutor(40) as ex:
        futs = [(path, lim, ex.submit(http, path, m, 40)) for path, m, lim in jobs for _ in range(6)]
        time.sleep(1)
        fast(good, 'go: con 30 peticiones a internet colgadas, audio y portadas siguen respondiendo', 10)
        late = [(p.split('?')[0], round(f.result()[1], 1)) for p, lim, f in futs if f.result()[1] > lim or f.result()[0] < 0]
    check(not late, f'go: portada, artista, letra y búsqueda contestan a tiempo con internet colgado {late[:4]}')
    return tracks


# ---- 3. the page ----
def web(tracks):
    from playwright.sync_api import sync_playwright
    good = [t['id'] for t in tracks if 'Rot' not in t['title'] and 'Larga' not in t['title']]
    bad = sorted([t for t in tracks if 'Rot' in t['title']], key=lambda t: t['title'])
    nocover = next(t['id'] for t in tracks if 'Cuarteto' in t['artist'] or 'Cuarteto' in t['title'])
    errs = []
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required'])
        pg = b.new_context(viewport={'width': 390, 'height': 844}).new_page()
        pg.on('console', lambda m: m.type == 'error' and 'Failed to load resource' not in m.text and 'net::' not in m.text and errs.append(m.text))
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.add_init_script("localStorage.setItem('zt.intro','1')")
        pg.goto(f'http://{ADDR}/'); pg.wait_for_timeout(2500)
        cur = lambda: pg.evaluate('ZT.cur() && ZT.cur().id')
        tm = lambda: pg.evaluate('ZT.position()')
        toast = lambda: pg.evaluate("(document.getElementById('toast')||{}).textContent||''")

        # a. the server stuck: audio and ping don't answer
        stuck = {'on': True}
        def hold(route):
            if stuck['on']:
                route.abort('connectionrefused')
            else:
                route.continue_()
        pg.route('**/audio/**', hold)
        pg.route('**/api/ping', hold)
        pg.route('**/icons/mixup.png?stall=1', hold)
        pg.evaluate("""() => {
          const a = document.createElement('img'); a.id = 'tImgStall'; a.src = '/icons/mixup.png?stall=1'; a.setAttribute('onerror', 'this.remove()'); document.body.appendChild(a);
          const b = document.createElement('img'); b.id = 'tImgGone'; b.src = '/cover/nohay-' + Date.now(); b.setAttribute('onerror', 'this.remove()'); document.body.appendChild(b);
        }""")
        pg.evaluate('ids => ZT.playContext({ type: "ids", ids, name: "prueba" }, ids[0])', good)
        seen_toast = False
        toasts = set()
        for _ in range(16):
            pg.wait_for_timeout(500)
            toasts.add(toast())
            seen_toast |= ('no responde' in toast() or "isn't answering" in toast())
        if not seen_toast: print('   (avisos vistos:', toasts, ')')
        check(cur() == good[0], f'web: con el servidor atascado no salta canciones (sigue en la 1.ª: {cur() == good[0]})')
        check(seen_toast, 'web: avisa «MixUp no responde: vuelvo a intentarlo…»')
        check(pg.evaluate("!!document.getElementById('tImgStall')"), 'web: la imagen que falla con el servidor atascado no se quita')
        stuck['on'] = False
        t0 = time.time(); playing = False
        while time.time() - t0 < 25:
            pg.wait_for_timeout(500)
            if cur() == good[0] and tm() > 0.8:
                playing = True; break
        check(playing, f'web: cuando el servidor vuelve, suena la misma canción ({time.time() - t0:.1f} s)')
        pg.wait_for_timeout(1500)
        check(pg.evaluate("(document.getElementById('tImgStall')||{}).naturalWidth > 0"), 'web: la imagen que había fallado se carga sola al volver')
        check(not pg.evaluate("!!document.getElementById('tImgGone')"), 'web: una imagen que de verdad no está se quita como antes (su onerror), con el servidor respondiendo')

        # b. broken files: two skipped, the third stops with «Reintentar»
        ids = [t['id'] for t in bad] + [good[1]]
        pg.evaluate('ids => ZT.playContext({ type: "ids", ids, name: "rotas" }, ids[0])', ids)
        t0 = time.time(); bar = False
        while time.time() - t0 < 20:
            pg.wait_for_timeout(500)
            bar = pg.evaluate("(() => { const b = document.querySelector('.mg-bar'); return !!b && !b.hidden; })()")
            if bar:
                break
        check(bar, f'web: con 3 archivos rotos seguidos se para y avisa con «Reintentar» ({time.time() - t0:.1f} s)')
        check(cur() == ids[2], 'web: no pasa de la tercera rota (no recorre la lista)')
        check(pg.evaluate('ZT.deck().paused'), 'web: la música queda en pausa')
        pg.screenshot(path=os.path.join(TMP, 'parada.png'))
        # «Reintentar» tries the same one again (still broken: skip count starts over)
        pg.click('.mg-bar .mg-retry'); pg.wait_for_timeout(4000)
        check(cur() in (ids[2], ids[3]), 'web: «Reintentar» vuelve a intentarlo desde ahí')
        b.close()
    check(not errs, 'web: sin errores en la consola ' + str(errs[:3]))


def main():
    shutil.rmtree(TMP, True); os.makedirs(TMP)
    java()
    bh = blackhole()
    p = go_server()
    try:
        tracks = go_tests()
        web(tracks)
    finally:
        p.terminate(); bh.close()
    print('\n' + ('TODO BIEN' if not fails else f'{len(fails)} FALLOS:\n  ' + '\n  '.join(fails)))
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    import urllib.parse
    main()
