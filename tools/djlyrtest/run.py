#!/usr/bin/env python3
"""Prueba del DJ activo (indicadores), del icono del DJ fijo sin «Siguiente», del scroll del reproductor grande del móvil
y de «Seguir la letra» (móvil, PC y letra a pantalla completa), sin internet.

  go build -o /tmp/mixup-djl . && python3 tools/djlyrtest/run.py

Variables: MIXUP_ADDR (127.0.0.1:18735), MIXUP_BIN, DJL_OUT (capturas), DJL_TMP (carpetas de música y HOME)."""
import math, os, shutil, struct, subprocess, sys, time, urllib.request, wave
from playwright.sync_api import sync_playwright

ADDR = os.environ.get('MIXUP_ADDR', '127.0.0.1:18735')
BIN = os.environ.get('MIXUP_BIN', '/tmp/mixup-djl')
OUT = os.environ.get('DJL_OUT', '/tmp/djl-out')
_T = os.environ.get('DJL_TMP', '/tmp')
ROOT, HOME = f'{_T}/djl-m', f'{_T}/djl-h'
os.makedirs(OUT, exist_ok=True)
fails = []


def check(ok, what):
    print(('ok    ' if ok else 'FALLO ') + what, flush=True)
    if not ok:
        fails.append(what)


def music():
    shutil.rmtree(HOME, True); shutil.rmtree(ROOT, True); os.makedirs(HOME); os.makedirs(ROOT)
    for ar, ti, f in [('Luna Norte', 'Faro azul', 220), ('Luna Norte', 'Corriente', 262), ('Los Vatios', 'Chispa', 294)]:
        w = wave.open(os.path.join(ROOT, f'{ar} - {ti}.wav'), 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(11025)
        w.writeframes(b''.join(struct.pack('<h', int(9000 * math.sin(2 * math.pi * f * i / 11025))) for i in range(11025 * 60)))
        w.close()
    open(os.path.join(ROOT, 'Luna Norte - Faro azul.lrc'), 'w').write('\n'.join(f'[00:{i * 2:02d}.00]Línea {i + 1} de la letra' for i in range(28)))


def start():
    env = {**os.environ, 'MIXUP_ADDR': ADDR, 'HOME': HOME}
    p = subprocess.Popen([BIN, '-root', ROOT, '-headless'], env=env, stdout=open(f'{_T}/djl.log', 'w'), stderr=subprocess.STDOUT)
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
    errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'net::' not in m.text and 'Failed to load resource' not in m.text else None)
    pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
    return ctx, pg, errs


def swipe(cdp, x0, y0, x1, y1, steps=12, dur=0.25):
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x0, 'y': y0}]})
    for i in range(1, steps + 1):
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x0 + (x1 - x0) * i / steps, 'y': y0 + (y1 - y0) * i / steps}]})
        time.sleep(dur / steps)
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})


def boot(pg, cls):
    pg.goto(f'http://{ADDR}/')
    pg.wait_for_function(f"document.documentElement.classList.contains('{cls}') && typeof Mix !== 'undefined' && Mix.tracks().length >= 3", timeout=20000)
    pg.evaluate("Mix.plugins.enable('dj'); Mix.dj.set(false)")
    time.sleep(0.8)


def play(pg, name='Faro azul', only=False, at=5):
    pg.evaluate("""([n, only]) => { const t = Mix.tracks().find(t => t.title.includes(n)); const rest = Mix.tracks().filter(x => x !== t);
      Mix.playContext(only ? [t] : [t, ...rest], 0, 'Prueba'); }""", [name, only])
    pg.wait_for_function(f"Mix.track() && Mix.track().title.includes('{name}')")
    pg.evaluate(f"Mix.seek({at})")
    time.sleep(0.6)


def box(pg, sel):
    return pg.evaluate("s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }", sel)


def phone(b):
    ctx, pg, errs = page(b, 390, 844, True)
    boot(pg, 'd25-phone')
    cdp = ctx.new_cdp_session(pg)
    # --- DJ apagado: nada resaltado
    play(pg)
    pg.evaluate("V25.fullPlayer.open()"); time.sleep(0.8)
    check(not pg.evaluate("document.querySelector('.p25-fp-dj').classList.contains('on')"), 'móvil: con el DJ apagado, el botón DJ no está resaltado')
    check(not pg.locator('.p25-fp-dj.on').count(), 'móvil: sin DJ no hay punto')
    pos_off = box(pg, '.p25-fp-dj')
    # --- DJ encendido
    pg.evaluate("Mix.dj.set(true)"); time.sleep(0.5)
    check(pg.evaluate("document.querySelector('.p25-fp-dj').classList.contains('on')"), 'móvil: con el DJ encendido, el botón DJ del reproductor grande queda resaltado (.on)')
    dot = pg.evaluate("getComputedStyle(document.querySelector('.p25-fp-dj'), '::after').content")
    check(dot not in ('none', 'normal', ''), f'móvil: punto animado junto al DJ ({dot})')
    pg.screenshot(path=f'{OUT}/phone-1-dj-on.png')
    pos_on = box(pg, '.p25-fp-dj')
    check(pos_off == pos_on, 'móvil: encender el DJ no mueve su botón')
    # --- sin siguiente: el icono del DJ no se mueve
    pos_next = box(pg, '.p25-fp-dj'); pill = pg.evaluate("!document.querySelector('.p25-fp-next').hidden")
    check(pill, 'móvil: con siguiente, se ve la píldora «Siguiente»')
    play(pg, only=True)
    pg.wait_for_function("document.querySelector('.p25-fp-next').hidden", timeout=5000)
    check(not pg.evaluate("document.querySelector('.p25-fp-next').offsetParent"), 'móvil: con 1 canción, la píldora «Siguiente» se oculta')
    pos_nonext = box(pg, '.p25-fp-dj')
    check(pos_next == pos_nonext, f'móvil: con 1 canción y DJ encendido el icono DJ sigue en su sitio ({pos_next} → {pos_nonext})')
    close = box(pg, '.p25-fp-close')
    check(close[0] < 40, 'móvil: la flecha de bajar sigue a la izquierda')
    pg.screenshot(path=f'{OUT}/phone-2-dj-sin-siguiente.png')
    # --- mini reproductor
    pg.evaluate("V25.fullPlayer.close()"); time.sleep(0.8)
    check(pg.locator('.p25-mini-dj').is_visible(), 'móvil: etiqueta «DJ» visible en el mini reproductor con el DJ encendido')
    pg.screenshot(path=f'{OUT}/phone-3-mini-dj.png')
    pg.evaluate("Mix.dj.set(false)"); time.sleep(0.4)
    check(not pg.locator('.p25-mini-dj').is_visible(), 'móvil: sin DJ no hay etiqueta en el mini reproductor')
    pg.evaluate("Mix.dj.set(true)")

    # --- scroll nativo del reproductor grande
    play(pg)
    pg.evaluate("V25.fullPlayer.open()"); time.sleep(0.9)
    pg.wait_for_function("!document.querySelector('.p25-lyrcard').hidden", timeout=8000)
    pg.screenshot(path=f'{OUT}/phone-4-full.png')
    ev = pg.evaluate("""() => { window.__prev = 0; document.addEventListener('touchmove', e => { if (e.defaultPrevented) window.__prev++; }, true); return 1; }""")
    swipe(cdp, 195, 700, 195, 250, steps=16, dur=0.35)   # desde los controles (no la portada)
    time.sleep(1.0)
    st = pg.evaluate("document.querySelector('.p25-scroll').scrollTop")
    check(st > 120, f'móvil: deslizar desde los controles baja a las tarjetas (scrollTop {st:.0f})')
    check(pg.evaluate("window.__prev") == 0, 'móvil: el desplazamiento es nativo (ningún touchmove cancelado)')
    pg.evaluate("document.querySelector('.p25-scroll').scrollTo(0, 0)"); time.sleep(0.5)

    # --- «Seguir la letra» en la tarjeta del móvil
    pg.evaluate("document.querySelector('.p25-scroll').scrollTo(0, 9999)"); time.sleep(0.7)
    pg.screenshot(path=f'{OUT}/phone-5-card.png')
    lb = box(pg, '.p25-lyrwin')
    pg.evaluate("Mix.seek(10)"); time.sleep(1.4)
    w0 = pg.evaluate("document.querySelector('.p25-lyrwin').scrollTop")
    check(w0 > 0, f'móvil: la letra se desplaza sola ({w0:.0f})')
    check(not pg.locator('.p25-lyrcard .lf-btn').count() or not pg.locator('.p25-lyrcard .lf-btn').is_visible(), 'móvil: sin tocar la letra no hay botón «Seguir la letra»')
    swipe(cdp, lb[0] + lb[2] / 2, lb[1] + lb[3] * 0.3, lb[0] + lb[2] / 2, lb[1] + lb[3] * 0.8, steps=10, dur=0.3)   # arrastrar hacia arriba la letra
    time.sleep(0.8)
    w1 = pg.evaluate("document.querySelector('.p25-lyrwin').scrollTop")
    check(w1 < w0, f'móvil: se puede desplazar la letra con el dedo ({w0:.0f} → {w1:.0f})')
    check(pg.locator('.p25-lyrcard .lf-btn').is_visible(), 'móvil: aparece el botón «Seguir la letra»')
    check(any(x in pg.locator('.p25-lyrcard .lf-btn').inner_text() for x in ('Seguir la letra', 'Follow the lyrics')), 'móvil: el botón dice «Seguir la letra»')
    pg.screenshot(path=f'{OUT}/phone-6-seguir.png')
    pg.evaluate("Mix.seek(30)"); time.sleep(1.6)
    w2 = pg.evaluate("document.querySelector('.p25-lyrwin').scrollTop")
    check(abs(w2 - w1) < 3, f'móvil: con el seguimiento parado la letra no se mueve sola ({w1:.0f} → {w2:.0f})')
    pg.locator('.p25-lyrcard .lf-btn').click(); time.sleep(1.2)
    w3 = pg.evaluate("document.querySelector('.p25-lyrwin').scrollTop")
    check(w3 > w2 + 20 and not pg.locator('.p25-lyrcard .lf-btn').is_visible(), f'móvil: «Seguir la letra» vuelve a centrar la línea y se oculta ({w2:.0f} → {w3:.0f})')
    # se reanuda sola tras ~8 s
    swipe(cdp, lb[0] + lb[2] / 2, lb[1] + lb[3] * 0.3, lb[0] + lb[2] / 2, lb[1] + lb[3] * 0.8, steps=10, dur=0.3)
    time.sleep(0.8)
    check(pg.locator('.p25-lyrcard .lf-btn').is_visible(), 'móvil: otra vez parado al desplazar')
    time.sleep(8.6)
    check(not pg.locator('.p25-lyrcard .lf-btn').is_visible(), 'móvil: a los ~8 s sin tocar se reanuda solo')
    # cambiar de canción
    swipe(cdp, lb[0] + lb[2] / 2, lb[1] + lb[3] * 0.3, lb[0] + lb[2] / 2, lb[1] + lb[3] * 0.8, steps=10, dur=0.3)
    time.sleep(0.6)
    pg.evaluate("Mix.next()"); time.sleep(1.0); play(pg, 'Faro azul', at=3); time.sleep(0.8)
    check(not pg.locator('.p25-lyrcard .lf-btn').is_visible(), 'móvil: al cambiar de canción se reanuda')

    # --- letra a pantalla completa (la del Legacy usada en el 2.5)
    pg.evaluate("V25.fullPlayer.close()"); time.sleep(0.6)
    pg.evaluate("Mix.lyrics.open()"); time.sleep(0.8)
    pg.evaluate("Mix.seek(22)"); time.sleep(1.6)
    check(pg.evaluate("Mix.lyrics.isOpen()"), 'móvil: se abre la letra a pantalla completa')
    pg.screenshot(path=f'{OUT}/phone-7-lyr-full.png')
    lb = box(pg, '#lyrBody')
    s0 = pg.evaluate("document.getElementById('lyrBody').scrollTop")
    swipe(cdp, lb[0] + 200, lb[1] + lb[3] * 0.3, lb[0] + 200, lb[1] + lb[3] * 0.8, steps=10, dur=0.3)
    time.sleep(0.8)
    s1 = pg.evaluate("document.getElementById('lyrBody').scrollTop")
    check(pg.locator('#lyr .lf-btn').is_visible(), 'móvil: letra completa: al desplazar aparece «Seguir la letra»')
    pg.evaluate("Mix.seek(40)"); time.sleep(1.6)
    s2 = pg.evaluate("document.getElementById('lyrBody').scrollTop")
    check(abs(s2 - s1) < 3, f'móvil: letra completa: sigue parada ({s1:.0f} → {s2:.0f})')
    pg.screenshot(path=f'{OUT}/phone-8-lyr-full-seguir.png')
    pg.locator('#lyr .lf-btn').click(); time.sleep(1.4)
    s3 = pg.evaluate("document.getElementById('lyrBody').scrollTop")
    check(s3 > s2 + 20 and not pg.locator('#lyr .lf-btn').is_visible(), f'móvil: letra completa: al tocarlo vuelve a la línea ({s2:.0f} → {s3:.0f})')
    check(not errs, 'móvil: sin errores en consola ' + '; '.join(errs[:3]))
    ctx.close()


def pc(b):
    ctx, pg, errs = page(b, 1280, 820, False)
    boot(pg, 'd25-pc')
    play(pg)
    sel = '.pc-legacy-btns [data-legacy="btnDj"]'
    check(not pg.evaluate("document.querySelector('%s').classList.contains('on')" % sel), 'PC: con el DJ apagado, el botón DJ no está resaltado')
    pg.evaluate("Mix.dj.set(true)"); time.sleep(0.6)
    check(pg.evaluate("document.querySelector('%s').classList.contains('on')" % sel), 'PC: con el DJ encendido, el botón DJ de la barra está resaltado')
    dot = pg.evaluate("getComputedStyle(document.querySelector('%s'), '::after').content" % sel)
    check(dot not in ('none', 'normal', ''), f'PC: punto animado en el botón DJ ({dot})')
    pg.screenshot(path=f'{OUT}/pc-1-dj.png')
    # panel derecho: letra
    pg.evaluate("PC25.right.show('lyrics')"); time.sleep(1.0)
    pg.evaluate("Mix.seek(24)"); time.sleep(1.6)
    body = box(pg, '.pc-rbody')
    r0 = pg.evaluate("document.querySelector('.pc-rbody').scrollTop")
    check(r0 > 0, f'PC: la letra del panel se desplaza sola ({r0:.0f})')
    check(not pg.locator('.pc-right .lf-btn').is_visible() if pg.locator('.pc-right .lf-btn').count() else True, 'PC: sin tocar no hay botón')
    pg.mouse.move(body[0] + body[2] / 2, body[1] + body[3] / 2); pg.mouse.wheel(0, -200); time.sleep(0.8)
    r1 = pg.evaluate("document.querySelector('.pc-rbody').scrollTop")
    check(r1 < r0 and pg.locator('.pc-right .lf-btn').is_visible(), f'PC: al mover la rueda se para el seguimiento y sale «Seguir la letra» ({r0:.0f} → {r1:.0f})')
    pg.screenshot(path=f'{OUT}/pc-2-seguir.png')
    pg.evaluate("Mix.seek(40)"); time.sleep(1.6)
    r2 = pg.evaluate("document.querySelector('.pc-rbody').scrollTop")
    check(abs(r2 - r1) < 3, f'PC: parada, la letra no se mueve sola ({r1:.0f} → {r2:.0f})')
    pg.locator('.pc-right .lf-btn').click(); time.sleep(1.4)
    r3 = pg.evaluate("document.querySelector('.pc-rbody').scrollTop")
    check(r3 > r2 + 20 and not pg.locator('.pc-right .lf-btn').is_visible(), f'PC: «Seguir la letra» vuelve a la línea ({r2:.0f} → {r3:.0f})')
    # «Sonando» grande
    pg.evaluate("V25.fullPlayer.open()"); time.sleep(1.0)
    pg.evaluate("Mix.seek(24)"); time.sleep(1.6)
    fb = box(pg, '.pc-fright')
    pg.mouse.move(fb[0] + fb[2] / 2, fb[1] + fb[3] / 2); pg.mouse.wheel(0, -250); time.sleep(0.8)
    check(pg.locator('.pc-fmain .lf-btn').is_visible(), 'PC: «Sonando» grande: al mover la rueda sale «Seguir la letra»')
    pg.screenshot(path=f'{OUT}/pc-3-full-seguir.png')
    f1 = pg.evaluate("document.querySelector('.pc-fright').scrollTop")
    pg.evaluate("Mix.seek(40)"); time.sleep(1.6)
    f2 = pg.evaluate("document.querySelector('.pc-fright').scrollTop")
    check(abs(f2 - f1) < 3, f'PC: «Sonando» grande parado ({f1:.0f} → {f2:.0f})')
    pg.locator('.pc-fmain .lf-btn').click(); time.sleep(1.4)
    f3 = pg.evaluate("document.querySelector('.pc-fright').scrollTop")
    check(f3 > f2 + 20 and not pg.locator('.pc-fmain .lf-btn').is_visible(), f'PC: «Sonando» grande vuelve a la línea ({f2:.0f} → {f3:.0f})')
    pg.evaluate("V25.fullPlayer.close()")
    check(not errs, 'PC: sin errores en consola ' + '; '.join(errs[:3]))
    ctx.close()


if __name__ == '__main__':
    music()
    srv = start()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
            for fn in (phone, pc):
                try:
                    fn(b)
                except Exception as e:
                    check(False, f'{fn.__name__}: excepción {type(e).__name__}: {str(e)[:300]}')
            b.close()
    finally:
        srv.terminate()
    print('\n' + ('TODO BIEN' if not fails else f'{len(fails)} FALLOS'))
    sys.exit(1 if fails else 0)
