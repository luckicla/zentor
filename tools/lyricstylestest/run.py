#!/usr/bin/env python3
"""Prueba de «Estilo de la letra» (web/plugins/lyricstyles.js + .css), sin internet.

  go build -o /tmp/mixup-v25b-lystyle . && python3 tools/lyricstylestest/run.py

Canción WAV hecha aquí con un .lrc al lado (líneas cada ~2,5 s). Para cada estilo hace capturas en:
  · 2.5 móvil 390x844: la tarjeta «Letra» del reproductor grande y la letra a pantalla completa;
  · 2.5 PC 1280x820: la pestaña «Letra» de la columna derecha y «Sonando» grande;
  · Legacy PC 1280x820 y Legacy móvil 390x844: el panel de la letra.
Y comprueba: «Clásico» no pone ninguna clase (el aspecto de siempre), la página del plugin tiene las
tarjetas, el botón de la letra y mantener pulsado abren el selector, se guarda en liveLyrics.style,
con el plugin apagado no queda nada, sin errores en consola. Capturas en /tmp/v25b-lystyle-out
(y una hoja de contactos por pantalla: sheet-*.png)."""
import json, math, os, shutil, struct, subprocess, sys, time, urllib.request, wave
from playwright.sync_api import sync_playwright

ADDR = os.environ.get('MIXUP_ADDR', '127.0.0.1:18457')
BIN = os.environ.get('MIXUP_BIN', '/tmp/mixup-v25b-lystyle')
OUT = '/tmp/v25b-lystyle-out'
fails = []
STYLES = ['classic', 'karaoke', 'apple', 'spotify', 'neon', 'typewriter', 'bubble', 'minimal', 'retro', 'cinema', 'wave', 'gradient', 'big']
LYR = ['Cuando la ciudad se apaga', 'y las luces bailan solas', 'te busco entre la gente', 'con el ritmo en la piel',
       'no me sueltes esta noche', 'que el ritmo nos lleva', 'hasta que salga el sol', 'y el mar se vuelva azul',
       'canta conmigo otra vez', 'cada palabra es un faro', 'en la orilla de tu voz', 'nos quedamos sin miedo']


def check(ok, what):
    print(('ok    ' if ok else 'FALLO ') + what, flush=True)
    if not ok:
        fails.append(what)


def music(root, home, legacy):
    shutil.rmtree(home, True); shutil.rmtree(root, True); os.makedirs(home); os.makedirs(root)
    for ar, ti, f in [('Luna Norte', 'Faro azul', 220), ('Los Vatios', 'Chispa', 294)]:
        w = wave.open(os.path.join(root, f'{ar} - {ti}.wav'), 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
        w.writeframes(b''.join(struct.pack('<h', int(6000 * math.sin(2 * math.pi * f * i / 8000))) for i in range(8000 * 90)))
        w.close()
    lines = [f'[{int(i * 2.5 // 60):02d}:{i * 2.5 % 60:05.2f}]{LYR[i % len(LYR)]}' for i in range(34)]
    open(os.path.join(root, 'Luna Norte - Faro azul.lrc'), 'w').write('\n'.join(lines))
    if legacy:
        os.makedirs(os.path.join(root, '.zentor'))
        open(os.path.join(root, '.zentor', 'settings.json'), 'w').write(json.dumps({'theme': 'synth'}))


def start(root, home):
    env = {**os.environ, 'MIXUP_ADDR': ADDR, 'HOME': home}
    p = subprocess.Popen([BIN, '-root', root, '-headless'], env=env, stdout=open('/tmp/v25b-lystyle.log', 'a'), stderr=subprocess.STDOUT)
    for _ in range(80):
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


def boot(pg, cond):
    pg.goto(f'http://{ADDR}/')
    pg.wait_for_function(cond + " && typeof LyricStyles !== 'undefined' && window.Lyrics", timeout=20000)
    time.sleep(0.8)


def play(pg, at=9.0):
    pg.evaluate("""(() => { const t = Mix.tracks().find(t => /Faro azul/.test(t.title)); Mix.playContext([t, ...Mix.tracks().filter(x => x !== t)], 0, 'Prueba'); })()""")
    pg.wait_for_function("Mix.track() && /Faro azul/.test(Mix.track().title)")
    pg.evaluate(f"Mix.seek({at})")
    pg.wait_for_function("(() => { const d = Mix.lyrics.data(); return d && d.lines && d.at >= 0; })()", timeout=10000)


def each_style(pg, tag, shoot, at=None):
    shots = []
    for s in STYLES:
        pg.evaluate(f"LyricStyles.set('{s}')")
        if at is not None:
            pg.evaluate(f"Mix.seek({at})")
        time.sleep(1.3)
        cls = pg.evaluate("document.documentElement.className")
        if s == 'classic':
            check(' lys-' not in ' ' + cls and 'lya-' not in cls, f'{tag}: «Clásico» no pone ninguna clase')
        else:
            check(f'lys-{s}' in cls.split(), f'{tag}: estilo {s} puesto')
        path = f'{OUT}/{tag}-{STYLES.index(s):02d}-{s}.png'
        shoot(path)
        shots.append((s, path))
    pg.evaluate("LyricStyles.set('classic')")
    return shots


def contact(shots, name, cols=5, w=300):
    try:
        from PIL import Image, ImageDraw
    except Exception:
        return
    ims = [(s, Image.open(p).convert('RGB')) for s, p in shots]
    sc = [(s, im.resize((w, int(im.height * w / im.width)))) for s, im in ims]
    h = max(im.height for _, im in sc) + 18
    rows = (len(sc) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * w, rows * h), (30, 30, 30))
    d = ImageDraw.Draw(sheet)
    for i, (s, im) in enumerate(sc):
        x, y = (i % cols) * w, (i // cols) * h
        sheet.paste(im, (x, y + 18)); d.text((x + 4, y + 3), s, fill=(255, 255, 0))
    sheet.save(f'{OUT}/sheet-{name}.png')


def dyn_checks(pg, tag, sel):
    # typewriter / wave split the line sung now; karaoke sets its timing
    pg.evaluate("LyricStyles.set('typewriter')"); time.sleep(1.2)
    n = pg.evaluate(f"document.querySelectorAll('{sel} p.on .lyc').length")
    check(n > 5, f'{tag}: «Máquina de escribir» parte la línea en letras ({n})')
    pg.evaluate("LyricStyles.set('karaoke')"); time.sleep(1.2)
    lyd = pg.evaluate(f"document.querySelector('{sel} p.on')?.style.getPropertyValue('--lyd')")
    check(bool(lyd), f'{tag}: «Karaoke» marca cuánto dura la línea ({lyd})')
    left = pg.evaluate(f"document.querySelectorAll('{sel} p .lyc').length")
    check(left == 0, f'{tag}: al cambiar de estilo las letras vuelven a ser texto ({left})')
    pg.evaluate("LyricStyles.set('classic')"); time.sleep(0.5)


def phone25(b):
    root, home = '/tmp/m-v25b-lystyle', '/tmp/h-v25b-lystyle'
    music(root, home, False)
    srv = start(root, home)
    try:
        ctx, pg, errs = page(b, 390, 844, True)
        boot(pg, "document.documentElement.classList.contains('d25-phone') && typeof Mix !== 'undefined' && Mix.tracks().length >= 2")
        play(pg)
        pg.evaluate("V25.fullPlayer.open()"); time.sleep(1)
        pg.evaluate("document.querySelector('.p25-scroll').scrollTo(0, document.querySelector('.p25-lyrcard').offsetTop - 60)"); time.sleep(0.8)
        check(pg.locator('.p25-lyrcard').is_visible(), 'móvil 2.5: tarjeta «Letra» visible')
        card = pg.locator('.p25-lyrcard')
        shots = each_style(pg, 'phone25-card', lambda p: card.screenshot(path=p))
        contact(shots, 'phone25-card', cols=5, w=260)
        dyn_checks(pg, 'móvil 2.5 tarjeta', '.p25-lyrin')
        # long-press on the card -> quick picker (a 2.5 sheet)
        card.dispatch_event('contextmenu')
        time.sleep(0.7)
        check(pg.locator('.v-sheet .lysg').is_visible(), 'móvil 2.5: mantener pulsado la tarjeta abre el selector')
        pg.screenshot(path=f'{OUT}/phone25-quick.png')
        pg.locator('.v-sheet .lysc[data-lys="neon"]').click(); time.sleep(0.6)
        check(pg.evaluate("Settings.get().liveLyrics.style") == 'neon', 'móvil 2.5: tocar una tarjeta guarda liveLyrics.style')
        check(pg.evaluate("document.querySelector('.v-sheet .lysc.sel')?.dataset.lys") == 'neon', 'móvil 2.5: la tarjeta elegida queda marcada')
        pg.screenshot(path=f'{OUT}/phone25-quick-neon.png')
        pg.evaluate("V25.back()"); time.sleep(0.5)
        pg.evaluate("LyricStyles.set('classic')")
        # full-screen lyrics
        pg.evaluate("Mix.lyrics.open()"); time.sleep(0.8)
        shots = each_style(pg, 'phone25-full', lambda p: pg.screenshot(path=p))
        contact(shots, 'phone25-full', cols=7, w=200)
        pg.locator('#lyr .lys-quick').click(); time.sleep(0.6)
        check(pg.locator('#sheet .lysg').is_visible(), 'móvil 2.5: el botón de la letra a pantalla completa abre el selector')
        pg.screenshot(path=f'{OUT}/phone25-full-quick.png')
        pg.evaluate("ztBack()"); time.sleep(0.4)
        check(pg.evaluate("Mix.lyrics.isOpen()"), 'móvil 2.5: atrás cierra primero el selector (la letra sigue abierta)')
        pg.evaluate("Mix.lyrics.close()")
        # plugin page
        pg.evaluate("V25.fullPlayer.close(); Mix.openPluginPage('livelyrics')"); time.sleep(1)
        n = pg.locator('.llpage .lysc').count()
        check(n == len(STYLES), f'móvil 2.5: la página del plugin tiene {n} estilos')
        pg.locator('.llpage .lysg').scroll_into_view_if_needed(); time.sleep(0.3)
        pg.screenshot(path=f'{OUT}/phone25-page.png')
        pg.locator('.llpage [data-lya="center"]').click(); time.sleep(0.3)
        check(pg.evaluate("Settings.get().liveLyrics.align") == 'center' and pg.evaluate("document.documentElement.classList.contains('lya-center')"), 'móvil 2.5: «Alineación» se guarda y se aplica')
        check(pg.evaluate("Settings.get().liveLyrics.pref") in (None, 'synced'), 'móvil 2.5: la alineación no toca «Qué buscar»')
        pg.locator('.llpage [data-lya="auto"]').click(); time.sleep(0.2)
        pg.evaluate("Mix.closeSettings()")
        # plugin off: no classes left
        pg.evaluate("LyricStyles.set('wave'); Mix.plugins.disable('livelyrics')"); time.sleep(0.5)
        cls = pg.evaluate("document.documentElement.className")
        check('lys-' not in cls, 'móvil 2.5: con el plugin apagado no queda ningún estilo')
        pg.evaluate("Mix.plugins.enable('livelyrics')"); time.sleep(0.5)
        check('lys-wave' in pg.evaluate("document.documentElement.className"), 'móvil 2.5: al encenderlo vuelve el estilo guardado')
        pg.evaluate("LyricStyles.set('classic')")
        check(not errs, f'móvil 2.5: sin errores en consola {errs[:3]}')
        ctx.close()
        # PC 2.5 (same install)
        ctx, pg, errs = page(b, 1280, 820, False)
        boot(pg, "document.documentElement.classList.contains('d25-pc') && typeof Mix !== 'undefined' && Mix.tracks().length >= 2")
        play(pg)
        pg.evaluate("PC25.right.show('lyrics')"); time.sleep(1.2)
        check(pg.locator('.pc-lyr').count() == 1, 'PC 2.5: pestaña «Letra» de la columna derecha')
        rp = pg.locator('.pc-lyr').locator('xpath=ancestor::*[contains(@class,"v-slot") or contains(@class,"pc-right")][1]')
        box = rp if rp.count() else pg.locator('.pc-lyr')
        shots = each_style(pg, 'pc25-right', lambda p: box.screenshot(path=p))
        contact(shots, 'pc25-right', cols=7, w=180)
        dyn_checks(pg, 'PC 2.5 columna', '.pc-lyr')
        pg.locator('.pc-lyr').dispatch_event('contextmenu'); time.sleep(0.6)
        check(pg.locator('.v-sheet .lysg').is_visible(), 'PC 2.5: clic derecho en la letra abre el selector')
        pg.screenshot(path=f'{OUT}/pc25-quick.png')
        pg.keyboard.press('Escape'); time.sleep(0.4)
        pg.evaluate("V25.fullPlayer.open()"); time.sleep(1.2)
        check(pg.locator('.pc-flyr').count() == 1, 'PC 2.5: «Sonando» grande con la letra')
        shots = each_style(pg, 'pc25-big', lambda p: pg.screenshot(path=p))
        contact(shots, 'pc25-big', cols=5, w=300)
        dyn_checks(pg, 'PC 2.5 grande', '.pc-flyr')
        check(not errs, f'PC 2.5: sin errores en consola {errs[:3]}')
        ctx.close()
    finally:
        srv.terminate(); srv.wait()


def legacy(b):
    for tag, w, h, touch in [('legacy-pc', 1280, 820, False), ('legacy-phone', 390, 844, True)]:
        root, home = '/tmp/m-v25b-lystyle-l', '/tmp/h-v25b-lystyle-l'
        music(root, home, True)
        srv = start(root, home)
        try:
            ctx, pg, errs = page(b, w, h, touch)
            boot(pg, "!document.documentElement.classList.contains('d25') && typeof Mix !== 'undefined' && Mix.tracks().length >= 2")
            play(pg)
            pg.evaluate("Mix.closeSettings(); document.querySelector('.news-wrap, .news') && document.querySelector('.news-wrap .x, .news [data-x]')?.click()"); time.sleep(0.5)
            pg.evaluate("Lyrics.open()"); time.sleep(1)
            shots = each_style(pg, tag, lambda p: pg.screenshot(path=p))
            contact(shots, tag, cols=5 if w > 800 else 7, w=300 if w > 800 else 200)
            dyn_checks(pg, tag, '#lyrBody')
            pg.locator('#lyr .lys-quick').click(); time.sleep(0.6)
            check(pg.locator('#sheet .lysg').is_visible(), f'{tag}: el botón del panel de la letra abre el selector')
            pg.screenshot(path=f'{OUT}/{tag}-quick.png')
            pg.evaluate("ztBack()"); time.sleep(0.4)
            pg.locator('#lyrBody').dispatch_event('contextmenu'); time.sleep(0.6)
            check(pg.locator('#sheet .lysg').is_visible(), f'{tag}: clic derecho / mantener pulsado en la letra abre el selector')
            pg.evaluate("ztBack()"); time.sleep(0.4)
            # the karaoke line under the cover, with a style
            pg.evaluate("Lyrics.close(); Settings.set({ liveLyrics: { ...Settings.get().liveLyrics, karaoke: true } }); LyricStyles.set('neon')"); time.sleep(2)
            pg.screenshot(path=f'{OUT}/{tag}-karaokeline-neon.png')
            pg.evaluate("Settings.set({ liveLyrics: { ...Settings.get().liveLyrics, karaoke: false } }); LyricStyles.set('classic')")
            pg.evaluate("Mix.openPluginPage('livelyrics')"); time.sleep(1)
            check(pg.locator('.llpage .lysc').count() == len(STYLES), f'{tag}: la página del plugin tiene los estilos')
            pg.locator('.llpage .lysg').scroll_into_view_if_needed(); time.sleep(0.3)
            pg.screenshot(path=f'{OUT}/{tag}-page.png')
            check(not errs, f'{tag}: sin errores en consola {errs[:3]}')
            ctx.close()
        finally:
            srv.terminate(); srv.wait()


if __name__ == '__main__':
    shutil.rmtree(OUT, True); os.makedirs(OUT)
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        phone25(b)
        legacy(b)
        b.close()
    print('\nFALLOS:' if fails else '\nTodo bien', *fails, sep='\n')
    sys.exit(1 if fails else 0)
