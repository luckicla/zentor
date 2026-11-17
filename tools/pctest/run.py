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
    # (from the splash page to MixUp's the window changes process: a
    # connection made right then may not see it; connect again every 20 s)
    b, p = None, None
    for _ in range(15):
        if b:
            try: b.close()
            except Exception: pass
        b = pw.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')

        def pg():
            for c in b.contexts:
                for q in c.pages:
                    if q.url.startswith('http://127.0.0.1:47811'):
                        return q
        p = until(pg, 20, 1)
        if p:
            break
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
        say('barra de arriba:', p.evaluate("() => navigator.windowControlsOverlay ? { visible: navigator.windowControlsOverlay.visible, zona: JSON.parse(JSON.stringify(navigator.windowControlsOverlay.getTitlebarAreaRect())) } : null"),
            '· nuestra barra:', p.evaluate("() => { const t = document.getElementById('tbar'); return t && !t.hidden ? document.documentElement.className.split(' ').filter(c => c.startsWith('tb')) : 'no' }"))
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


def clics(port):
    """Real mouse clicks on the real window (not maximized): the left column
    works, dragging on the app doesn't move the window, dragging the empty
    part up there does, and a double click up there doesn't maximize it."""
    import ctypes, pyautogui
    from ctypes import wintypes
    pyautogui.FAILSAFE = False
    u = ctypes.windll.user32
    fails = []
    with sync_playwright() as pw:
        b, p = connect(pw, port)
        time.sleep(2)
        # the window: the visible top-level one whose title ends in MixUp
        found = []
        @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        def cb(h, _):
            n = u.GetWindowTextLengthW(h)
            buf = ctypes.create_unicode_buffer(n + 1); u.GetWindowTextW(h, buf, n + 1)
            if u.IsWindowVisible(h) and 'MixUp' in buf.value: found.append((h, buf.value))
            return True
        u.EnumWindows(cb, 0)
        say('ventanas:', [t for _, t in found])
        if not found:
            say('FALLO: no encuentro la ventana'); sys.exit(1)
        h = found[0][0]
        u.ShowWindow(h, 9)  # restore: small, as when it misbehaved
        u.SetWindowPos(h, 0, 120, 90, 1100, 760, 0x0040)
        time.sleep(1.5)
        def rect():
            r = wintypes.RECT(); u.GetWindowRect(h, ctypes.byref(r)); return (r.left, r.top, r.right, r.bottom)
        def origin():
            pt = wintypes.POINT(0, 0); u.ClientToScreen(h, ctypes.byref(pt)); return pt.x, pt.y
        def center(sel):
            r = p.evaluate("s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2, devicePixelRatio] }", sel)
            if not r: return None
            ox, oy = origin()
            return int(ox + r[0] * r[2]), int(oy + r[1] * r[2])
        p.screenshot(path=os.path.join(OUT, 'pequena.png'))
        say('ventana:', rect(), '· desk:', p.evaluate("() => document.documentElement.classList.contains('desk')"))
        # 1) the left column: «Álbumes» and back to «Canciones»
        for nav in ('albums', 'songs'):
            c = center(f'.snav [data-nav="{nav}"]')
            if not c: fails.append('no está el botón ' + nav); continue
            r0 = rect(); pyautogui.click(*c); time.sleep(1.2)
            sel = p.evaluate("() => (document.querySelector('.snav .sel') || {}).dataset?.nav || null")
            say(f'clic en la columna izquierda ({nav}):', 'seleccionado =', sel, '· la ventana se movió' if rect() != r0 else '· la ventana quieta')
            if sel != nav: fails.append(f'el clic en «{nav}» de la columna izquierda no funcionó')
            if rect() != r0: fails.append(f'el clic en «{nav}» movió la ventana')
        # 2) dragging on the app (the library): the window stays where it is
        for sel, name in (('.list', 'la biblioteca'), ('.side', 'la columna izquierda'), ('.nowcol', 'la columna derecha')):
            c = center(sel)
            if not c: continue
            r0 = rect()
            pyautogui.moveTo(*c); pyautogui.mouseDown(); pyautogui.moveRel(140, 60, duration=0.4); pyautogui.mouseUp(); time.sleep(0.6)
            moved = rect() != r0
            say(f'arrastrar sobre {name}:', 'MOVIÓ la ventana' if moved else 'la ventana quieta')
            if moved: fails.append(f'arrastrar sobre {name} mueve la ventana'); u.SetWindowPos(h, 0, 120, 90, 1100, 760, 0x0040); time.sleep(0.8)
        # 3) dragging the empty part up there: it moves (that's what it's for)
        c = center('.tb-sp')
        if c:
            r0 = rect()
            pyautogui.moveTo(*c); pyautogui.mouseDown(); pyautogui.moveRel(80, 50, duration=0.4); pyautogui.mouseUp(); time.sleep(0.6)
            say('arrastrar el hueco de arriba:', 'se movió' if rect() != r0 else 'NO se movió', rect())
            if rect() == r0: fails.append('arrastrar el hueco de arriba no mueve la ventana')
        # 4) double click up there: not maximized
        c = center('.tb-sp')
        if c:
            pyautogui.doubleClick(*c); time.sleep(1)
            st = p.evaluate("() => MixUpShell.win('')")
            say('doble clic arriba:', st)
            if st and st.get('max'): fails.append('el doble clic arriba la maximiza'); p.evaluate("() => MixUpShell.win('max')"); time.sleep(0.6)
        # 5) our buttons: maximize and back
        c = center('#tbMax')
        if c:
            pyautogui.click(*c); time.sleep(1); m1 = p.evaluate("() => MixUpShell.win('')")
            c = center('#tbMax'); pyautogui.click(*c); time.sleep(1); m2 = p.evaluate("() => MixUpShell.win('')")
            say('botón maximizar:', m1, '→', m2)
            if not (m1 and m1.get('max')) or (m2 and m2.get('max')): fails.append('el botón de maximizar/restaurar no va')
        p.screenshot(path=os.path.join(OUT, 'tras-clics.png'))
    if fails:
        for f in fails: say('FALLO:', f)
        sys.exit(1)
    say('OK: clics, arrastre y doble clic como deben')


if __name__ == '__main__':
    if sys.argv[1] == 'play':
        play(int(sys.argv[2]))
    elif sys.argv[1] == 'clics':
        clics(int(sys.argv[2]))
    elif sys.argv[1] == 'update':
        update(int(sys.argv[2]), sys.argv[3])
