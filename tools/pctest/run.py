#!/usr/bin/env python3
"""Prueba de MixUp para escritorio en un Windows de verdad (GitHub Actions).

  run.py play <puerto-cdp>               pulsa una canción y mira que suena
  run.py update <puerto-cdp> <versión>   pulsa «Actualizar» y espera a que
                                         la nueva (<versión>) esté sirviendo

La app se abre con --remote-debugging-port=<puerto-cdp>; esto se conecta a
su ventana como un navegador más (Playwright). Capturas y registro en out/."""
import os, sys, time, urllib.request
from playwright.sync_api import sync_playwright

OUT = os.environ.get('OUT', 'out')
os.makedirs(OUT, exist_ok=True)
logf = open(os.path.join(OUT, 'prueba.log'), 'a', encoding='utf-8')


def say(*a):
    m = time.strftime('%H:%M:%S ') + ' '.join(str(x) for x in a)
    print(m, flush=True)
    logf.write(m + '\n')
    logf.flush()


def get(url, t=3):
    try:
        return urllib.request.urlopen(url, timeout=t).read().decode('utf-8', 'replace')
    except Exception:
        return ''


def until(fn, secs, step=1.0):
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


def connect(pw, port):
    if not until(lambda: get(f'http://127.0.0.1:{port}/json/version'), 120):
        say('FALLO: la ventana de MixUp no se deja ver (cdp)')
        sys.exit(1)
    b = pw.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')

    def pg():
        for c in b.contexts:
            for p in c.pages:
                if p.url.startswith('http://127.0.0.1:47811'):
                    return p
    p = until(pg, 300, 1)
    if not p:
        urls = [p.url for c in b.contexts for p in c.pages]
        say('FALLO: la ventana no llegó a cargar MixUp:', urls)
        for c in b.contexts:
            for q in c.pages:
                q.screenshot(path=os.path.join(OUT, 'sin-cargar.png'))
        sys.exit(1)
    p.on('console', lambda m: say('[consola]', m.type, m.text[:300]) if m.type in ('error', 'warning') else None)
    p.on('pageerror', lambda e: say('[error de la página]', e))
    return b, p


def audios(p):
    return p.evaluate("""() => [...document.querySelectorAll('audio')].map(a => ({
        src: (a.getAttribute('src') || '').slice(-24), paused: a.paused, t: +(a.currentTime || 0).toFixed(2),
        rs: a.readyState, err: a.error ? a.error.code : 0 }))""")


def play(port):
    with sync_playwright() as pw:
        b, p = connect(pw, port)
        time.sleep(4)
        p.screenshot(path=os.path.join(OUT, 'abierta.png'))
        n = p.evaluate("() => document.querySelectorAll('audio').length")
        say('audios en la página:', n)
        # the row of a song that isn't the one already loaded (a click on the
        # loaded one, or on the player's title, isn't «play this»)
        rows = p.locator('.it[data-id] >> visible=true')
        if not until(lambda: rows.count() >= 2, 60):
            say('FALLO: no salen las canciones de prueba en la biblioteca')
            p.screenshot(path=os.path.join(OUT, 'sin-canciones.png'))
            sys.exit(1)
        cur = p.evaluate('() => (ZT.cur() || {}).id || ""')
        say('canciones:', p.evaluate('() => ZT.tracks().map(t => t.title + (t.cover ? " (con portada)" : ""))'), '· cargada:', cur)
        song = p.locator('.it[data-id]:not([data-id="%s"]) >> visible=true' % cur).first
        song.dispatch_event('click')
        ok = False
        for i in range(12):
            time.sleep(1)
            a = audios(p)
            say('audio:', a)
            if any((not x['paused']) and x['t'] > 2.5 for x in a):
                ok = True
                break
        p.screenshot(path=os.path.join(OUT, 'sonando.png'))
        if not ok:
            say('FALLO: la canción no suena')
            sys.exit(1)
        say('OK: suena')


def update(port, want):
    with sync_playwright() as pw:
        b, p = connect(pw, port)
        time.sleep(3)
        before = get('http://127.0.0.1:47811/api/version')
        say('versión ahora:', before, '· publicada:', want)
        say('info:', p.evaluate('() => window.MixUpShell ? MixUpShell.info() : null'))
        say('pulso Actualizar:', p.evaluate('() => MixUpShell.install()'))
        t0 = time.time()
        last = None
        while time.time() - t0 < 600:
            try:
                s = p.evaluate('() => MixUpShell.state()')
            except Exception as e:
                say('la ventana se cerró (se está actualizando)')
                break
            if s != last:
                say('estado:', s)
                last = s
                if s and s.get('state') == 'error':
                    p.screenshot(path=os.path.join(OUT, 'error.png'))
                    say('FALLO: error al actualizar')
                    sys.exit(1)
            time.sleep(1)
    v = until(lambda: (lambda x: x if x == want else None)(get('http://127.0.0.1:47811/api/version')), 420, 2)
    if not v:
        say('FALLO: no se abrió la versión nueva; contesta:', repr(get('http://127.0.0.1:47811/api/version')))
        sys.exit(1)
    say('OK: actualizada y abierta, sirve', v)


if __name__ == '__main__':
    if sys.argv[1] == 'play':
        play(int(sys.argv[2]))
    elif sys.argv[1] == 'update':
        update(int(sys.argv[2]), sys.argv[3])
