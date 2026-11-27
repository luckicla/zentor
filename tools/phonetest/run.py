#!/usr/bin/env python3
"""Prueba del móvil 2.5 (web/v25/phone/): barra, mini reproductor, reproductor grande, cola, gestos.

  go build -o /tmp/mixup-phone . && python3 tools/phonetest/run.py

Instalación nueva con unas canciones generadas (ffmpeg) en /tmp/phone-assets;
gestos con CDP Input.dispatchTouchEvent; capturas en /tmp/phonetest-out."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from common import *
from switches import switches as switch_check
from playwright.sync_api import sync_playwright

OUT = os.environ.get('PHONETEST_OUT') or os.environ.get('PHONE_OUT', '/tmp/phonetest-out')
os.makedirs(OUT, exist_ok=True)
fails = []


def check(ok, what):
    print(('ok    ' if ok else 'FALLO ') + what, flush=True)
    if not ok:
        fails.append(what)


def swipe(cdp, x0, y0, x1, y1, steps=10, dur=0.18):
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x0, 'y': y0}]})
    for i in range(1, steps + 1):
        x = x0 + (x1 - x0) * i / steps; y = y0 + (y1 - y0) * i / steps
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': y}]})
        time.sleep(dur / steps)
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})


def tap(cdp, x, y):
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})


def center(pg, sel):
    b = pg.locator(sel).first.bounding_box()
    return b['x'] + b['width'] / 2, b['y'] + b['height'] / 2


def run(b, w, h, tag):
    ctx, pg, errs = page(b, w, h)
    pg.goto(f'http://{ADDR}/')
    pg.wait_for_function("document.documentElement.classList.contains('d25-phone') && !!document.querySelector('.p25-bar-btn')", timeout=15000)
    time.sleep(1.5)
    cdp = ctx.new_cdp_session(pg)
    pg.screenshot(path=f'{OUT}/{tag}-1-home-empty.png')
    check(pg.locator('.v-mini').is_hidden() == (not pg.evaluate('!!Mix.track()')), f'{tag}: mini reproductor solo con canción')
    items = pg.evaluate("[...document.querySelectorAll('.p25-bar-btn')].map(b => b.dataset.id).join(',')")
    check(items == 'home,search,library,store,add', f'{tag}: barra por defecto ({items})')
    labels = pg.evaluate("[...document.querySelectorAll('.p25-bar-lb')].map(b => b.textContent).join(',')")
    check('Plugins' in labels.split(',') and 'Tienda' not in labels and 'Store' not in labels, f'{tag}: la «Tienda» se llama Plugins ({labels})')
    pg.evaluate("Mix.playAll(); Mix.pause()")
    pg.wait_for_function("!!Mix.track()")
    pg.evaluate("Mix.play()")
    time.sleep(1.5)
    check(pg.locator('.v-mini').is_visible(), f'{tag}: mini reproductor visible')
    pg.screenshot(path=f'{OUT}/{tag}-2-mini.png')
    t0 = pg.evaluate("Mix.track().id")
    x, y = center(pg, '.p25-mini-track')
    swipe(cdp, x + 60, y, x - 140, y)
    time.sleep(0.6)
    t1 = pg.evaluate("Mix.track().id")
    check(t1 != t0, f'{tag}: deslizar el mini a la izquierda cambia de canción')
    swipe(cdp, x, y, x, y - 300, steps=12, dur=0.25)
    time.sleep(0.6)
    check(pg.evaluate("V25.fullPlayer.isOpen()"), f'{tag}: deslizar el mini hacia arriba abre el reproductor')
    time.sleep(0.6)
    pg.screenshot(path=f'{OUT}/{tag}-3-full.png')
    # the cover: swipe left = next
    cx, cy = center(pg, '.p25-fp-cover')
    t2 = pg.evaluate("Mix.track().id")
    swipe(cdp, cx + 80, cy, cx - 120, cy)
    time.sleep(0.8)
    check(pg.evaluate("Mix.track().id") != t2, f'{tag}: deslizar la portada cambia de canción')
    # next pill
    nxt = pg.evaluate("Mix.nextTrack()?.id")
    pg.locator('.p25-fp-next').click()
    time.sleep(0.6)
    check(pg.evaluate("Mix.track().id") == nxt, f'{tag}: tocar «Siguiente» salta a esa canción')
    # swipe from the left: the queue
    swipe(cdp, 40, h * 0.62, 300, h * 0.62)
    time.sleep(0.5)
    check(pg.evaluate("Queue25.isOpen()"), f'{tag}: deslizar desde la izquierda abre la cola')
    pg.evaluate("Mix.enqueue(Mix.tracks().slice(0,3))")
    time.sleep(0.5)
    pg.screenshot(path=f'{OUT}/{tag}-4-queue.png')
    # reorder: drag the first grip down two rows (pointer events)
    q0 = pg.evaluate("Mix.queue().queued.map(t=>t.id).join(',')")
    gx, gy = center(pg, '.p25-q-queued .p25-q-grip')
    rh = pg.evaluate("document.querySelector('.p25-q-queued .p25-q-row').offsetHeight")
    pg.mouse.move(gx, gy); pg.mouse.down(); pg.mouse.move(gx, gy + rh * 1.2, steps=6); pg.mouse.move(gx, gy + rh * 2.1, steps=6); pg.mouse.up()
    time.sleep(0.4)
    q1 = pg.evaluate("Mix.queue().queued.map(t=>t.id).join(',')")
    check(q0.split(',')[0] == q1.split(',')[2] and q0 != q1, f'{tag}: arrastrar reordena la cola')
    # back: the queue first, then the player
    pg.evaluate("window.ztBack()"); time.sleep(0.4)
    check(not pg.evaluate("Queue25.isOpen()") and pg.evaluate("V25.fullPlayer.isOpen()"), f'{tag}: atrás cierra primero la cola')
    # swipe down: collapse
    swipe(cdp, w / 2, h * 0.72, w / 2, h * 0.72 + 330, steps=12, dur=0.25)
    time.sleep(0.6)
    check(not pg.evaluate("V25.fullPlayer.isOpen()"), f'{tag}: deslizar hacia abajo baja el reproductor')
    # tap opens, chevron closes, back closes
    tap(cdp, *center(pg, '.p25-mini-tx'))
    time.sleep(0.5)
    check(pg.evaluate("V25.fullPlayer.isOpen()"), f'{tag}: tocar el mini abre el reproductor')
    pg.evaluate("window.ztBack()"); time.sleep(0.5)
    check(not pg.evaluate("V25.fullPlayer.isOpen()"), f'{tag}: atrás baja el reproductor')
    # Ajustes → Aspecto: «Diseño» first, with «Barra y reproductor» under it; the styles keep their colours
    pg.evaluate("Mix.openSettings('look')"); time.sleep(0.6)
    check(pg.evaluate("document.querySelector('.stab[data-tab=\"look\"]').firstElementChild?.id") == 'setDesign'
          and pg.evaluate("[...document.querySelectorAll('#setDesign [data-design]')].map(b => b.dataset.design).join(',')") in ('legacy,v25', 'legacy,v25,compact'),
          f'{tag}: Diseño, lo primero de Aspecto')
    check(pg.evaluate("!!document.querySelector('#setDesign .set-design-p25') && !document.querySelector('#setDesign .set-design-p25').hidden"), f'{tag}: «Barra y reproductor» debajo de Diseño')
    check(pg.evaluate("getComputedStyle(document.querySelector('.preset .pv-cover')).backgroundImage.includes('gradient')"), f'{tag}: Estilos con sus colores')
    pg.screenshot(path=f'{OUT}/{tag}-4b-aspecto.png')
    pg.evaluate("Mix.closeSettings()"); time.sleep(0.5)
    # the settings sheet
    pg.evaluate("P25Prefs.open('bar')"); time.sleep(0.5)
    pg.screenshot(path=f'{OUT}/{tag}-5-prefs.png')
    pg.locator('.p25-set [data-item="queue"]').click(); time.sleep(0.2)
    pg.locator('.p25-set [data-seg="barStyle"][data-v="dock"]').click(); time.sleep(0.2)
    pg.locator('.p25-set [data-seg="miniCover"][data-v="right"]').click(); time.sleep(0.2)
    pg.evaluate("window.ztBack()"); time.sleep(0.4)
    items = pg.evaluate("[...document.querySelectorAll('.p25-bar-btn')].map(b => b.dataset.id).join(',')")
    check(items == 'home,search,library,store,add,queue', f'{tag}: añadir «Cola» a la barra ({items})')
    pg.screenshot(path=f'{OUT}/{tag}-6-docked.png')
    # coverFull + bar progress + volume + lyrics card
    pg.evaluate("Mix.settings.set({coverFull:true, v25FullVol:true, v25Seek:'bar'})")
    pg.evaluate("V25.fullPlayer.open()"); time.sleep(0.8)
    pg.screenshot(path=f'{OUT}/{tag}-7-wide.png')
    pg.evaluate("V25.fullPlayer.close(); Mix.settings.set({coverFull:false, v25FullVol:false, v25Seek:'auto', v25BarStyle:undefined, v25MiniCover:undefined, v25BarItems:undefined, theme:'paper', radius:0, tilt:true})")
    pg.evaluate("V25.fullPlayer.open()"); time.sleep(0.8)
    pg.screenshot(path=f'{OUT}/{tag}-8-paper.png')
    pg.evaluate("V25.fullPlayer.close()"); time.sleep(0.5)
    pg.screenshot(path=f'{OUT}/{tag}-9-paper-home.png')
    extra(pg, cdp, tag, w, h)
    check(not errs, f'{tag}: sin errores en consola {errs[:3]}')
    ctx.close()


def extra(pg, cdp, tag, w, h):
    """2.5 phone: head behind the status bar, Ajustes from the left, the DJ from the right,
    the real «Siguiente», and what's remembered on reopening."""
    # Android's see-through status bar, as app.js sets it (html.edge + --sbh)
    pg.evaluate("document.documentElement.classList.add('edge'); document.documentElement.style.setProperty('--sbh','28px')")
    pg.evaluate("V25.go('home', {}, {root: true})"); time.sleep(0.6)
    hb = pg.evaluate("(() => { const h = document.querySelector('.v-head').getBoundingClientRect(), b = document.querySelector('.v-setbtn').getBoundingClientRect(); return [h.top, b.top]; })()")
    check(hb[0] <= 0.5 and hb[1] >= 28, f'{tag}: la cabecera llega al borde de arriba y sus botones quedan bajo la barra de estado {hb}')
    # («Sonando ahora» on Inicio: removed by the PC branch, checked in tools/nowinfotest)
    pg.evaluate("document.querySelector('.v-main').scrollTop = 400"); time.sleep(0.3)
    check(pg.evaluate("document.getElementById('v25').classList.contains('v-scrolled')"), f'{tag}: al bajar, la cabecera se vuelve de cristal')
    pg.screenshot(path=f'{OUT}/{tag}-10-head-edge.png')
    # Ajustes: from the left
    pg.evaluate("document.querySelector('.v-setbtn').click()"); time.sleep(0.08)
    x = pg.evaluate("document.getElementById('settings').getBoundingClientRect().left")
    check(x < 0, f'{tag}: Ajustes entra desde la izquierda (x={x:.0f})')
    time.sleep(0.5)
    sy = pg.evaluate("(() => { const r = document.querySelector('#settings .set-head').getBoundingClientRect(); return r.top + r.height / 2; })()")
    swipe(cdp, w * 0.8, sy, w * 0.15, sy)
    time.sleep(0.5)
    check(not pg.evaluate("document.getElementById('settings').classList.contains('open')"), f'{tag}: deslizar a la izquierda cierra Ajustes')
    # the DJ: a side panel from the right, closed with a swipe to the right
    pg.evaluate("Mix.plugins.enable('dj')"); time.sleep(0.4)
    pg.evaluate("V25.fullPlayer.open()"); time.sleep(0.6)
    pg.evaluate("Mix.dj.open()"); time.sleep(0.1)
    x = pg.evaluate("document.querySelector('.djp').getBoundingClientRect().left")
    check(pg.evaluate("document.querySelector('.djwrap').classList.contains('side25')") and x > 0, f'{tag}: el DJ entra desde la derecha (x={x:.0f})')
    time.sleep(0.5)
    pg.screenshot(path=f'{OUT}/{tag}-11-dj.png')
    swipe(cdp, w * 0.2, h * 0.75, w * 0.9, h * 0.75)
    time.sleep(0.5)
    check(not pg.evaluate("Mix.dj.isOpen()"), f'{tag}: deslizar a la derecha cierra el DJ')
    # «Siguiente»: never the song playing; hidden when nothing follows
    pg.evaluate("Mix.queueClear(); Mix.shuffle('off'); Mix.repeat('one'); Mix.playAll(Mix.tracks()[0].id)"); time.sleep(0.8)
    nx = pg.evaluate("[Mix.track().id, Mix.nextTrack()?.id, Mix.queue(3).ahead[0]?.id]")
    check(nx[1] and nx[1] != nx[0] and nx[1] == nx[2], f'{tag}: con «Repetir esta», «Siguiente» es la de después {nx}')
    pill = pg.evaluate("document.querySelector('.p25-fp-next .p25-mq').textContent")
    check(pg.evaluate("Mix.track().title") not in pill, f'{tag}: la píldora «Siguiente» no enseña la que suena ({pill[:40]})')
    pg.evaluate("Mix.repeat('off'); Mix.aheadPlay(Mix.queue(999).ahead.length - 1)"); time.sleep(0.8)
    check(pg.evaluate("!Mix.nextTrack() && document.querySelector('.p25-fp-next').hidden"), f'{tag}: sin siguiente, no sale la píldora')
    pg.evaluate("Mix.repeat('all')"); time.sleep(0.4)
    check(pg.evaluate("!!Mix.nextTrack() && Mix.nextTrack().id !== Mix.track().id && !document.querySelector('.p25-fp-next').hidden"), f'{tag}: con «Repetir todo» al final, vuelve a la primera')
    pg.evaluate("Mix.shuffle('smart')"); time.sleep(0.4)
    nx = pg.evaluate("[Mix.track().id, Mix.nextTrack()?.id]")
    pg.locator('.p25-fp-next').click(); time.sleep(0.8)
    check(nx[1] and nx[1] != nx[0] and pg.evaluate("Mix.track().id") == nx[1], f'{tag}: aleatorio inteligente: «Siguiente» es la que suena después')
    pg.evaluate("Mix.shuffle('off'); V25.fullPlayer.close()"); time.sleep(0.5)
    check(pg.locator('.p25-lyrcard .p25-lyrfoot [data-pm="lyrmore"]').count() == 1, f'{tag}: la tarjeta de la letra tiene «Ver más»')
    # reopening: the same song at the same spot, and the section you were in
    pg.evaluate("Mix.playAll(Mix.tracks()[2].id)"); time.sleep(0.8)
    pg.evaluate("Mix.seek(6); Mix.pause()"); time.sleep(0.6)
    pg.evaluate("V25.go('library', {}, {root: true})"); time.sleep(0.4)
    want = pg.evaluate("[Mix.track().id, Mix.position()]")
    pg.reload()
    pg.wait_for_function("document.documentElement.classList.contains('d25-phone') && !!document.querySelector('.p25-bar-btn') && !!Mix.track()", timeout=15000)
    time.sleep(1.2)
    got = pg.evaluate("[Mix.track().id, Mix.position(), V25.current().id]")
    check(got[0] == want[0] and abs(got[1] - want[1]) < 1.5, f'{tag}: al volver a abrir, la misma canción en su sitio {want} → {got[:2]}')
    check(pg.locator('.v-mini').is_visible(), f'{tag}: …lista en el mini reproductor')
    check(got[2] == 'library', f'{tag}: al volver a abrir, la sección donde estabas ({got[2]})')
    pg.evaluate("V25.go('home', {}, {root: true})"); time.sleep(0.3)


def covers(b, w=390, h=844):
    """Ajustes → Aspecto → Portada in 2.5 (web/v25/cover.css + cover.js): each option changes something measurable."""
    ctx, pg, errs = page(b, w, h)
    pg.goto(f'http://{ADDR}/')
    pg.wait_for_function("document.documentElement.classList.contains('d25-phone') && !!document.querySelector('.p25-bar-btn')", timeout=15000)
    time.sleep(1.2)
    cdp = ctx.new_cdp_session(pg)
    ev = pg.evaluate
    tid = ev("(Mix.tracks().find(t => t.cover) || {}).id")
    check(bool(tid), 'portada: hay una canción con portada')
    ev("Settings.set({coverFull:false, coverFrame:false, coverGlow:true, coverColors:'none', bg:'cover'})")
    ev(f"Mix.playTrack(Mix.byId('{tid}'))"); time.sleep(1.5)
    MINI = "document.querySelector('.p25-mini-art .v-art').getBoundingClientRect().width"
    WIDE = "(() => { const e = document.querySelector('.p25-fp-wide'); return { d: getComputedStyle(e).display, h: e.getBoundingClientRect().height, thumb: getComputedStyle(document.querySelector('.p25-fp-thumb')).display, wide: document.querySelector('.p25-fp').classList.contains('wide') }; })()"
    got = {}
    for m, st in (('box', {'coverFull': False}), ('wide', {'coverFull': True, 'coverFullSize': 'normal'}), ('big', {'coverFull': True, 'coverFullSize': 'big'})):
        ev(f"Settings.set({json.dumps(st)})"); time.sleep(0.5)
        got[m + 'mini'] = ev(MINI)
        pg.screenshot(path=f'{OUT}/cover-{m}-mini.png')
        ev("V25.fullPlayer.open()"); time.sleep(0.9)
        got[m] = ev(WIDE)
        pg.screenshot(path=f'{OUT}/cover-{m}-full.png')
        ev("V25.fullPlayer.close()"); time.sleep(0.5)
    bx, wd, bg_ = got['box'], got['wide'], got['big']
    check(bx['d'] == 'none' and not bx['wide'] and wd['d'] == 'block' and wd['wide'], f"«A lo ancho»: el reproductor grande pone la portada de borde a borde ({bx['d']} → {wd['d']})")
    check(bg_['h'] > wd['h'] + 40 and wd['thumb'] != 'none' and bg_['thumb'] == 'none', f"«Grande»: la portada baja por detrás del título, sin la pequeña ({wd['h']:.0f} → {bg_['h']:.0f}px)")
    check(got['boxmini'] < got['widemini'] < got['bigmini'], f"mini reproductor: la portada sigue «Cómo sale» ({got['boxmini']:.0f} → {got['widemini']:.0f} → {got['bigmini']:.0f}px)")
    # «Esquinas de la portada»
    BR = "getComputedStyle(document.querySelector('.p25-br.tl')).display"
    ev("Settings.set({coverFull:false, coverFrame:false}); V25.fullPlayer.open()"); time.sleep(0.8)
    f0 = ev(BR)
    ev("Settings.set({coverFrame:true})"); time.sleep(0.4)
    f1 = ev(BR)
    pg.screenshot(path=f'{OUT}/cover-frame-full.png')
    check(f0 == 'none' and f1 != 'none', f'«Esquinas de la portada»: los corchetes salen y se van ({f0} → {f1})')
    # «Brillo según la portada»
    ev("Settings.set({coverFrame:false, coverGlow:false})"); time.sleep(1.3)
    g0, pink = ev("getComputedStyle(document.documentElement).getPropertyValue('--glow').trim()"), ev("getComputedStyle(document.documentElement).getPropertyValue('--pink-rgb').trim()")
    ev("Settings.set({coverGlow:true})"); time.sleep(1.3)
    g1 = ev("getComputedStyle(document.documentElement).getPropertyValue('--glow').trim()")
    mini = ev("getComputedStyle(document.querySelector('.v-mini')).backgroundImage")
    check(g0.replace(' ', '') == pink.replace(' ', '') and g1 != g0 and g1.replace(',', ', ') in mini, f'«Brillo según la portada»: el color del brillo cambia ({g0} → {g1})')
    # the background with the cover (the big player has a live copy of it)
    ev("Settings.set({bg:'flat'})"); time.sleep(0.6)
    m0 = ev("document.querySelector('.p25-fp-mirror').className")
    ev("Settings.set({bg:'cover', coverBlur:10})"); time.sleep(0.9)
    m1 = ev("document.querySelector('.p25-fp-mirror').className")
    b1 = ev("getComputedStyle(document.querySelector('.p25-fp-mirror img')).filter")
    ev("Settings.set({coverBlur:60})"); time.sleep(0.6)
    b2 = ev("getComputedStyle(document.querySelector('.p25-fp-mirror img')).filter")
    check('flat' in m0 and 'coverbg' in m1 and b1 != b2, f'fondo con la portada en el reproductor grande: liso ↔ portada, desenfoque ({b1} → {b2})')
    ev("Settings.set({coverBlur:36})")
    # In Cover Actions on the cover: double tap, tap, hold (also with the cover «Grande»)
    ev("Plugins.setEnabled('coveractions', true); Settings.set({coverActs:{tap:'playpause', dbl:'like'}, coverFull:true, coverFullSize:'big'})"); time.sleep(0.8)
    cx, cy = center(pg, '.p25-fp-cover')
    ev("Mix.play()"); time.sleep(0.3)
    l0 = ev("Mix.state().liked"); tap(cdp, cx, cy); time.sleep(0.12); tap(cdp, cx, cy); time.sleep(0.6)
    check(ev("Mix.state().liked") != l0, 'In Cover Actions: doble toque en la portada (Me gusta)')
    tap(cdp, cx, cy); time.sleep(0.9)
    check(not ev("Mix.playing()"), 'In Cover Actions: un toque en la portada (Reproducir / pausar)')
    ev("Mix.play()"); time.sleep(0.3)
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': cx, 'y': cy}]}); time.sleep(0.8)
    sp = ev("ZT.speed()")
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); time.sleep(0.3)
    check(sp == 2 and ev("ZT.speed()") == 1, f'In Cover Actions: mantener pulsada la portada (x2) ({sp})')
    ev("Settings.set({coverActs:{}, coverFull:false}); Plugins.setEnabled('coveractions', false); V25.fullPlayer.close()"); time.sleep(0.5)
    # the live copy in Settings (the player is under the panel)
    ev("Mix.openSettings('look')"); time.sleep(0.8)
    pg.locator('#coverModes').scroll_into_view_if_needed()
    vis = ev("(() => { const p = document.querySelector('.cov25-pv'); return !!p && p.getBoundingClientRect().height > 100 && !!p.querySelector('.cov25-cover').style.backgroundImage; })()")
    pg.locator('#coverModes [data-m=big]').click(); time.sleep(0.4)
    wv = ev("getComputedStyle(document.querySelector('.cov25-wide')).display")
    pg.screenshot(path=f'{OUT}/cover-settings.png')
    pg.locator('#coverModes [data-m=box]').click(); time.sleep(0.4)
    bv = ev("getComputedStyle(document.querySelector('.cov25-wide')).display")
    check(vis and wv == 'block' and bv == 'none', 'Ajustes: la vista previa de la portada sale y sigue «Cómo sale» en directo')
    check(not errs, f'portada: sin errores en consola {errs[:3]}')
    ctx.close()

def edge(b, w=390, h=844):
    """2.5 phone: the head a little closer to the status bar (never under it), and a swipe in from the
    left edge opens Ajustes following the finger, without clashing with the queue (full player),
    carousels or Android's back gesture strip."""
    ctx, pg, errs = page(b, w, h)
    pg.goto(f'http://{ADDR}/')
    pg.wait_for_function("document.documentElement.classList.contains('d25-phone') && !!document.querySelector('.p25-bar-btn') && Mix.tracks().length > 0", timeout=15000)
    time.sleep(1.2)
    cdp = ctx.new_cdp_session(pg)
    # Android's see-through status bar, as app.js sets it (html.edge + --sbh)
    pg.evaluate("document.documentElement.classList.add('edge'); document.documentElement.style.setProperty('--sbh','28px')")
    pg.evaluate("V25.go('home', {}, {root: true})"); time.sleep(0.5)
    geo = "(() => { const h = document.querySelector('.v-head').getBoundingClientRect(), b = document.querySelector('.v-setbtn').getBoundingClientRect(); return [h.top, b.top, parseFloat(getComputedStyle(document.querySelector('.v-head')).paddingTop)]; })()"
    pg.evaluate("document.documentElement.style.setProperty('--p25-head-lift','0px')"); time.sleep(0.2)
    before = pg.evaluate(geo)
    pg.screenshot(path=f'{OUT}/edge-1-cabecera-antes.png', clip={'x': 0, 'y': 0, 'width': w, 'height': 120})
    pg.evaluate("document.documentElement.style.removeProperty('--p25-head-lift')"); time.sleep(0.2)
    after = pg.evaluate(geo)
    pg.screenshot(path=f'{OUT}/edge-2-cabecera-despues.png', clip={'x': 0, 'y': 0, 'width': w, 'height': 120})
    check(after[0] <= 0.5 and after[1] >= 28 and 3 <= before[1] - after[1] <= 6, f'cabecera un pelín más arriba, sin tocar la barra de estado (botón {before[1]:.0f} → {after[1]:.0f}, barra de estado 28)')
    pg.evaluate("document.documentElement.classList.remove('edge'); document.documentElement.style.setProperty('--sbh','0px')"); time.sleep(0.2)
    check(abs(pg.evaluate(geo)[2] - 12) < 0.5, 'sin barra de estado (navegador / sin «edge»), la cabecera no cambia')
    z = pg.evaluate("P25Edge.zone()")
    check(z[0] == 0 and z[1] > 10000, f'zona del gesto: {z} (toda la pantalla; en Android empieza tras la franja de 24 px del gesto atrás del sistema)')
    st = lambda: pg.evaluate("!!document.getElementById('settings')?.classList.contains('open')")
    y = h * 0.45
    # a short drag: the panel follows the finger, and goes back on release
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': 8, 'y': y}]})
    for x in (20, 40, 60, 80):
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': y}]}); time.sleep(0.03)
    time.sleep(0.12)
    left = pg.evaluate("document.getElementById('settings').getBoundingClientRect().left")
    wpanel = pg.evaluate("document.getElementById('settings').getBoundingClientRect().width")
    check(-wpanel < left < -wpanel + 120, f'Ajustes sigue al dedo mientras arrastras (izquierda {left:.0f}, ancho {wpanel:.0f})')
    pg.screenshot(path=f'{OUT}/edge-3-arrastrando.png')
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); time.sleep(0.5)
    check(not st(), 'soltando poco, Ajustes vuelve a su sitio')
    # a full swipe: opens
    swipe(cdp, 8, y, w * 0.8, y)
    time.sleep(0.5)
    check(st(), 'deslizar desde el borde izquierdo abre Ajustes')
    pg.screenshot(path=f'{OUT}/edge-4-ajustes-abiertos.png')
    sy = pg.evaluate("(() => { const r = document.querySelector('#settings .set-head').getBoundingClientRect(); return r.top + r.height / 2; })()")
    swipe(cdp, w * 0.8, sy, w * 0.15, sy); time.sleep(0.5)
    check(not st(), '…y deslizar a la izquierda lo cierra (el gesto de siempre)')
    # from the middle of the screen too (like Legacy)
    swipe(cdp, w * 0.4, y, w * 0.95, y); time.sleep(0.5)
    check(st(), 'desde el centro de la pantalla también abre Ajustes (como en Legacy)')
    sy2 = pg.evaluate("(() => { const r = document.querySelector('#settings .set-head').getBoundingClientRect(); return r.top + r.height / 2; })()")
    swipe(cdp, w * 0.8, sy2, w * 0.15, sy2); time.sleep(0.5)
    # a carousel already scrolled: the carousel keeps the finger
    has = pg.evaluate("(() => { const r = document.querySelector('#v25 .v-shelf-row'); if (!r || r.scrollWidth <= r.clientWidth) return null; r.scrollLeft = 120; const b = r.getBoundingClientRect(); return b.top + b.height / 2; })()")
    if has:
        swipe(cdp, 8, has, w * 0.8, has); time.sleep(0.4)
        check(not st(), 'sobre un carrusel ya desplazado manda el carrusel, no Ajustes')
    # a vertical drag that starts on a carousel still scrolls the page (nothing may block it)
    pg.evaluate("V25.go('home', {}, {root: true})"); time.sleep(0.6)
    row = pg.evaluate("(() => { const r = document.querySelector('#v25 .hm-row'); if (!r) return null; const b = r.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()")
    if row and pg.evaluate("(() => { const m = document.querySelector('#v25 .v-main'); return m.scrollHeight > m.clientHeight + 40; })()"):
        pg.evaluate("document.querySelector('#v25 .v-main').scrollTop = 0")
        swipe(cdp, row[0], row[1] + 0, row[0] + 4, max(80, row[1] - 300)); time.sleep(0.6)
        check(pg.evaluate("document.querySelector('#v25 .v-main').scrollTop") > 20, 'arrastrar en vertical sobre un carrusel desplaza la página')
    # the full player: from the left there it's the queue
    pg.evaluate("Mix.playAll(); Mix.pause(); V25.fullPlayer.open()"); time.sleep(0.8)
    swipe(cdp, 8, h * 0.5, w * 0.8, h * 0.5); time.sleep(0.6)
    check(not st() and pg.evaluate("!!window.Queue25 && Queue25.isOpen()"), 'en el reproductor grande, desde la izquierda abre la cola, no Ajustes')
    pg.evaluate("Queue25.close(); V25.fullPlayer.close()"); time.sleep(0.5)
    check(not errs, f'gesto de Ajustes: sin errores en consola {errs[:3]}')
    ctx.close()


def gestos(b, w=390, h=844, android=True):
    """2.5 phone: the DJ and the queue by swipe. Views: from the right edge to the left opens the DJ (if the
    plugin is on), to the right opens Ajustes. Full player: from the left the queue, from the right the DJ,
    also starting on the cover's own edge (it reaches all the way to the system's strip); the cover still changes song."""
    tag = 'gestos-android' if android else 'gestos'
    ctx, pg, errs = page(b, w, h)
    if android:  # (as MixUpAndroid: the system's 24 px strips are left alone)
        ctx.add_init_script("Object.defineProperty(navigator,'userAgent',{get:()=>'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile MixUpAndroid'})")
    pg.goto(f'http://{ADDR}/')
    pg.wait_for_function("document.documentElement.classList.contains('d25-phone') && !!document.querySelector('.p25-bar-btn') && Mix.tracks().length > 0", timeout=15000)
    time.sleep(1.2)
    cdp = ctx.new_cdp_session(pg)
    pg.evaluate("document.documentElement.classList.add('edge'); document.documentElement.style.setProperty('--sbh','28px')")
    check(pg.evaluate("P25.ANDROID") == android and pg.evaluate("Mix.dj.available()"), f'{tag}: plugin DJ encendido y {"modo Android" if android else "sin Android"}')
    dj = lambda: pg.evaluate("Mix.dj.isOpen()")
    qu = lambda: pg.evaluate("Queue25.isOpen()")
    st = lambda: pg.evaluate("!!document.getElementById('settings')?.classList.contains('open')")
    lo = 24 if android else 0
    R = w - lo - 14  # (a finger in the right band, beyond the system's strip)
    L = lo + 14
    reset = lambda: (pg.evaluate("Queue25.close(); Mix.dj.isOpen() && Mix.dj.close(); Mix.closeSettings && Mix.closeSettings()"), time.sleep(0.7))
    y = h * 0.45
    for view in ('home', 'library'):
        pg.evaluate(f"V25.go('{view}', {{}}, {{root: true}})"); time.sleep(0.7)
        swipe(cdp, R, y, R - 220, y); time.sleep(0.7)
        check(dj() and not st(), f'{tag}: en {view}, deslizar a la izquierda desde el borde derecho abre el DJ')
        reset()
        swipe(cdp, w * 0.5, y, w * 0.5 - 200, y); time.sleep(0.6)
        check(not dj() and not st(), f'{tag}: en {view}, deslizar a la izquierda desde el centro no abre nada')
        pg.evaluate("document.querySelectorAll('#v25 .hm-row, #v25 .v-shelf-row').forEach(r => { r.scrollLeft = 0; })"); time.sleep(0.5)
        swipe(cdp, w * 0.4, y, w * 0.95, y); time.sleep(0.6)
        check(st() and not dj(), f'{tag}: en {view}, deslizar a la derecha abre Ajustes')
        reset()
    # DJ off: the edge swipe does nothing (and nothing breaks)
    pg.evaluate("V25.go('home', {}, {root: true})"); time.sleep(0.5)
    has = pg.evaluate("(() => { const r = document.querySelector('#v25 .hm-row'); if (!r) return null; const b = r.getBoundingClientRect(); return b.top + b.height / 2; })()")
    if has:  # on top of a carousel: the edge still goes to the DJ
        swipe(cdp, R, has, R - 220, has); time.sleep(0.7)
        check(dj(), f'{tag}: sobre un carrusel, el borde derecho también abre el DJ')
        reset()
    # the full player
    pg.evaluate("Mix.playAll(); Mix.pause(); V25.fullPlayer.open()"); time.sleep(0.9)
    cov = pg.evaluate("(() => { const b = document.querySelector('.p25-fp-cover').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; })()")
    cy = cov[1] + cov[3] / 2
    t0 = pg.evaluate("Mix.track()?.id")
    swipe(cdp, L, cy, L + 260, cy); time.sleep(0.8)
    check(qu() and pg.evaluate("Mix.track()?.id") == t0, f'{tag}: reproductor grande, desde el borde izquierdo (sobre la portada) abre la cola sin cambiar de canción')
    reset()
    swipe(cdp, R, cy, R - 260, cy); time.sleep(0.8)
    check(dj() and not qu() and pg.evaluate("Mix.track()?.id") == t0, f'{tag}: reproductor grande, desde el borde derecho (sobre la portada) abre el DJ')
    reset()
    swipe(cdp, L, cy + cov[3] / 2 + 60, L + 260, cy + cov[3] / 2 + 60); time.sleep(0.8)
    check(qu(), f'{tag}: reproductor grande, desde la izquierda fuera de la portada abre la cola')
    reset()
    swipe(cdp, R, cy + cov[3] / 2 + 60, R - 260, cy + cov[3] / 2 + 60); time.sleep(0.8)
    check(dj(), f'{tag}: reproductor grande, desde la derecha fuera de la portada abre el DJ')
    reset()
    swipe(cdp, w * 0.5 + 60, cy, w * 0.5 - 120, cy); time.sleep(1.0)
    t1 = pg.evaluate("Mix.track()?.id")
    check(not qu() and not dj() and t1 != t0, f'{tag}: deslizar la portada por el centro sigue cambiando de canción ({t0} → {t1})')
    swipe(cdp, w * 0.5 - 60, cy, w * 0.5 + 120, cy); time.sleep(1.0)
    check(not qu() and not dj() and pg.evaluate("Mix.track()?.id") != t1, f'{tag}: …y hacia el otro lado también')
    pg.evaluate("V25.fullPlayer.close()"); time.sleep(0.5)
    check(not errs, f'{tag}: sin errores en consola {errs[:3]}')
    ctx.close()


def cov_assets():
    """Four songs with their own (different) covers, for the playlist mosaic (made with ffmpeg once)."""
    d = os.environ.get('PHONE_ASSETS_COV', '/tmp/phone-assets-cov')
    if os.path.isdir(d) and len(os.listdir(d)) >= 4:
        return d
    import subprocess
    os.makedirs(d, exist_ok=True)
    for col, n in (('ff3c8a', 'Rojo'), ('1ec8ff', 'Azul'), ('ffd400', 'Amarillo'), ('44dd66', 'Verde')):
        jpg = os.path.join(d, n + '.jpg.tmp')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'color=c=0x{col}:s=300x300', '-frames:v', '1', '-f', 'mjpeg', jpg], check=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=30', '-i', jpg, '-map', '0', '-map', '1', '-c:a', 'libmp3lame', '-b:a', '64k',
                        '-id3v2_version', '3', '-metadata', f'title=Canción {n}', '-metadata', f'artist=Banda {n}', '-metadata', f'album=Álbum {n}',
                        '-disposition:v', 'attached_pic', os.path.join(d, f'c{n}.mp3')], check=True)
        os.remove(jpg)
    return d


def phoneui(b, w=390, h=844):
    """v25d-phoneui: playlist pictures on Inicio, what's playing marked, menus on Inicio (long-press),
    progress bar styles, the player's own background, sheets that close dragging down, no overscroll."""
    ctx, pg, errs = page(b, w, h)
    pg.goto(f'http://{ADDR}/')
    pg.wait_for_function("document.documentElement.classList.contains('d25-phone') && !!document.querySelector('.p25-bar-btn')", timeout=15000)
    time.sleep(1.5)
    cdp = ctx.new_cdp_session(pg)
    ev = pg.evaluate
    ev("Mix.pl.create('Colores', Mix.tracks().filter(t => /Canción/.test(t.title))); Mix.pl.create('Sueltas', Mix.tracks().slice(0, 2))"); time.sleep(0.6)
    pid = ev("Mix.playlists().find(p => p.name === 'Colores').id")
    pid2 = ev("Mix.playlists().find(p => p.name === 'Sueltas').id")
    ev("V25.go('home', {}, {root: true})"); time.sleep(1.5)
    T = f"document.querySelector('.hm-sec[data-sec=playlists] .hm-tile[data-group=\"playlist:{pid}\"]')"
    mos = ev(f"(() => {{ const t = {T}; const im = t ? [...t.querySelectorAll('.hm-plmos img')] : []; return [im.length, im.filter(i => i.complete && i.naturalWidth > 0).length]; }})()")
    check(mos[0] == 4 and mos[1] == 4, f'Inicio: la playlist sale con el mosaico de sus portadas ({mos})')
    # its own picture (Ajustes: «Cambiar portada…»): on top of the mosaic
    ok = ev(f"""(async () => {{ const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#7f00ff'; x.fillRect(0, 0, 64, 64);
        const blob = await new Promise(r => c.toBlob(r, 'image/png')); return await Mix.pl.setCover('{pid}', blob); }})()""")
    time.sleep(1.2)
    own = ev(f"(() => {{ const t = {T}; const im = t && t.querySelector('.hm-plart > img:last-child'); return im ? [im.getAttribute('src'), im.complete && im.naturalWidth > 0] : null; }})()")
    check(ok and own and own[0].startswith('/plcover/') and own[1], f'Inicio: la foto propia de la playlist va encima ({own})')
    pg.screenshot(path=f'{OUT}/pui-1-home-fotos.png')
    # what's playing: the playlist, then an album (and the song tiles)
    ev(f"Mix.playPlaylist('{pid}')"); time.sleep(1.2)
    lv = ev(f"[!!{T}?.classList.contains('v-live'), !!{T}?.querySelector('b .v-eq'), document.documentElement.classList.contains('v-is-playing')]")
    check(all(lv), f'lo que suena: la playlist se marca en Inicio (acento + ecualizador) {lv}')
    pg.screenshot(path=f'{OUT}/pui-2-home-sonando.png')
    ak = ev("Mix.albums().find(a => a.name === 'Álbum Rojo').key")
    ev(f"Mix.playAlbum({json.dumps(ak)})"); time.sleep(1.0)
    mv = ev(f"[!!{T}?.classList.contains('v-live'), !!{T}?.querySelector('.v-eq'), [...document.querySelectorAll('[data-group=\"album:{ak}\"]')].some(e => e.classList.contains('v-live')), [...document.querySelectorAll('[data-track=\"' + Mix.track().id + '\"]')].some(e => e.classList.contains('v-live'))]")
    check(not mv[0] and not mv[1] and mv[2] and mv[3], f'lo que suena: al cambiar de contexto la marca pasa al álbum y a la canción {mv}')
    ev(f"Mix.playPlaylist('{pid}')"); time.sleep(0.8)
    ev("V25.go('library', {tab: 'playlists'}, {root: true})"); time.sleep(1.2)
    lib = ev(f"(() => {{ const e = document.querySelector('.v-main [data-group=\"playlist:{pid}\"]'); return e ? [e.classList.contains('v-live'), !!e.querySelector('.v-eq')] : null; }})()")
    check(lib and all(lib), f'lo que suena: también en la Biblioteca (playlists) {lib}')
    pg.screenshot(path=f'{OUT}/pui-3-biblioteca-sonando.png')
    ev("V25.go('home', {}, {root: true})"); time.sleep(1.2)
    # long-press on Inicio: a playlist, a song, an album
    def hold(sel):
        ev(f"document.querySelector({json.dumps(sel)}).scrollIntoView({{block: 'center', inline: 'center'}})"); time.sleep(0.3)
        x, y = center(pg, sel)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]}); time.sleep(0.75)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); time.sleep(0.5)
        r = ev("[document.querySelectorAll('.v-sheet-wrap').length, document.querySelector('.v-sheet .lv-mhead b')?.textContent || '']")
        return r
    r = hold(f'.hm-sec[data-sec=playlists] .hm-tile[data-group="playlist:{pid2}"]')
    check(r[0] == 1 and r[1] == 'Sueltas', f'Inicio: mantener pulsada una playlist abre su menú (y soltar no lo cierra) {r}')
    pg.screenshot(path=f'{OUT}/pui-4-menu-inicio.png')
    # the sheet closes dragging it down (following the finger); a short drag springs back
    bx = pg.locator('.v-sheet').bounding_box()
    sx, sy = bx['x'] + bx['width'] / 2, bx['y'] + 10
    swipe(cdp, sx, sy, sx, sy + 40, steps=6, dur=0.3)
    time.sleep(0.5)
    still = ev("document.querySelectorAll('.v-sheet-wrap').length")
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': sx, 'y': sy}]})
    for i in range(1, 5):
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': sx, 'y': sy + 30 * i}]}); time.sleep(0.03)
    mid = ev("getComputedStyle(document.querySelector('.v-sheet')).transform")
    for i in range(5, 11):
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': sx, 'y': sy + 30 * i}]}); time.sleep(0.03)
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); time.sleep(0.6)
    gone = ev("document.querySelectorAll('.v-sheet-wrap').length")
    check(still == 1 and mid != 'none' and gone == 0, f'hoja: arrastrar un poco vuelve; arrastrar hacia abajo la cierra siguiendo el dedo ({still}, {mid[:30]}, {gone})')
    r = hold('.hm-tile[data-track]')
    check(r[0] == 1 and r[1] != '', f'Inicio: mantener pulsada una canción abre su menú {r}')
    ev("window.ztBack()"); time.sleep(0.4)
    r = hold('.hm-tile[data-group^="album:"]')
    check(r[0] == 1 and r[1] != '', f'Inicio: mantener pulsado un álbum abre su menú {r}')
    ev("window.ztBack()"); time.sleep(0.4)
    # the progress bar: Ajustes → Progreso (Onda / Barra / Pixel) and the phone's own preference, live
    got = {}
    for st in ('wave', 'bar', 'pixel'):
        ev(f"Mix.settings.set({{wave: '{st}', v25Seek: 'auto'}})"); time.sleep(0.4)
        got[st] = ev("[document.querySelector('.p25-mini-prog').dataset.style, getComputedStyle(document.querySelector('.p25-mini-cv')).display]")
        pg.screenshot(path=f'{OUT}/pui-5-mini-{st}.png', clip={'x': 0, 'y': h - 200, 'width': w, 'height': 200})
        ev("V25.fullPlayer.open()"); time.sleep(0.8)
        got[st] += [ev("document.querySelector('.p25-fp-seek').dataset.kind"), ev("document.querySelector('.p25-fp-seek').firstElementChild.tagName")]
        pg.screenshot(path=f'{OUT}/pui-6-full-{st}.png')
        ev("V25.fullPlayer.close()"); time.sleep(0.5)
    check(got['wave'][0] == 'wave' and got['wave'][2] == 'wave' and got['wave'][3] == 'CANVAS' and got['wave'][1] == 'block', f'barra de progreso «Onda» en el mini y en el grande {got["wave"]}')
    check(got['bar'][0] == 'bar' and got['bar'][2] == 'bar' and got['bar'][3] == 'INPUT' and got['bar'][1] == 'none', f'barra de progreso «Barra» en el mini y en el grande {got["bar"]}')
    check(got['pixel'][0] == 'pixel' and got['pixel'][2] == 'pixel' and got['pixel'][3] == 'MIX-PROGRESS', f'barra de progreso «Pixel» en el mini y en el grande {got["pixel"]}')
    ev("Mix.settings.set({wave: 'pixel', v25Seek: 'wave'})"); time.sleep(0.4)
    pr = ev("[document.querySelector('.p25-mini-prog').dataset.style, (V25.fullPlayer.open(), 1)]"); time.sleep(0.6)
    pr = [pr[0], ev("document.querySelector('.p25-fp-seek').dataset.kind")]
    check(pr == ['wave', 'wave'], f'«Barra y reproductor → Barra de progreso» manda sobre Ajustes {pr}')
    ev("V25.fullPlayer.close(); Mix.settings.set({wave: 'wave', v25Seek: undefined})"); time.sleep(0.5)
    # the player's own background
    APP = "document.querySelector('body > .bg').className"
    MIR = "document.querySelector('.p25-fp-mirror').className"
    ev("Settings.set({bg: 'cover'})"); ev("V25.fullPlayer.open()"); time.sleep(0.8)
    a0 = [ev(APP), ev(MIR)]
    ev("Mix.settings.set({v25PlayerBg: 'flat'})"); time.sleep(0.6)
    a1 = [ev(APP), ev(MIR)]
    pg.screenshot(path=f'{OUT}/pui-7-fondo-liso.png')
    ev("Mix.settings.set({v25PlayerBg: 'cover', v25PlayerBlur: 4, v25PlayerDim: 0.1})"); time.sleep(0.6)
    a2 = [ev(MIR), ev("getComputedStyle(document.querySelector('.p25-fp-mirror img')).filter")]
    pg.screenshot(path=f'{OUT}/pui-8-fondo-portada.png')
    ev("Mix.settings.set({v25PlayerBg: undefined, v25PlayerBlur: undefined, v25PlayerDim: undefined})"); time.sleep(0.6)
    a3 = ev(MIR)
    check('coverbg' in a0[0] and 'coverbg' in a0[1], f'fondo del reproductor: por defecto, igual que la app {a0}')
    check('coverbg' in a1[0] and 'flat' in a1[1] and 'coverbg' not in a1[1], f'fondo del reproductor: liso, la app sigue con la portada {a1}')
    check('coverbg' in a2[0] and 'blur(4px)' in a2[1], f'fondo del reproductor: portada con su propio desenfoque {a2}')
    check('coverbg' in a3, f'fondo del reproductor: vuelve a ir con la app ({a3})')
    ev("V25.fullPlayer.close()"); time.sleep(0.4)
    ev("Mix.openSettings('bg')"); time.sleep(0.8)
    pg.locator('.pbg25').scroll_into_view_if_needed(); time.sleep(0.3)
    check(ev("!document.querySelector('.pbg25').hidden && document.querySelectorAll('.pbg25 [data-pbg=mode] button').length == 4"), 'Ajustes → Fondo: «Fondo del reproductor» con sus 4 opciones')
    pg.screenshot(path=f'{OUT}/pui-9-ajustes-fondo.png')
    ev("Mix.closeSettings()"); time.sleep(0.4)
    # no overscroll: nothing stretches when pulled past an end
    ob = ev("[getComputedStyle(document.documentElement).overscrollBehaviorY, getComputedStyle(document.body).overscrollBehaviorY, getComputedStyle(document.querySelector('#v25 .v-main')).overscrollBehaviorY]")
    check(ob == ['none', 'none', 'none'], f'sin estirar la interfaz al tirar más allá del final (overscroll) {ob}')
    check(not errs, f'phoneui: sin errores en consola {errs[:3]}')
    ctx.close()


def main():
    p = start('new')
    try:
        with sync_playwright() as pw:
            b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required'])
            run(b, 390, 844, 'a390')
            p.kill(); p.wait()
            p2 = start('new')
            try:
                run(b, 360, 740, 'b360')
            finally:
                p2.kill(); p2.wait()
            p3 = start('cov')
            try:
                covers(b)
            finally:
                p3.kill()
            p5 = start('pui', extra=cov_assets())
            try:
                phoneui(b)
            finally:
                p5.kill(); p5.wait()
            p4e = start('edge')
            try:
                edge(b)
            finally:
                p4e.kill(); p4e.wait()
            p4g = start('gestos', {'design': 'v25', 'dj': True})
            try:
                gestos(b, android=False)
                gestos(b, android=True)
            finally:
                p4g.kill(); p4g.wait()
            # every switch and slider: the same look and the same vibration
            p4 = start('sw', {'dj': True})
            try:
                ctx, pg, errs = page(b, 390, 844)
                pg.goto(f'http://{ADDR}/'); time.sleep(2.5)
                switch_check(pg, 'móvil', check, OUT, phone=True)
                check(not errs, f'interruptores: sin errores en consola {errs[:3]}')
                ctx.close()
            finally:
                p4.kill(); p4.wait()
            b.close()
    finally:
        p.kill()
    print('FALLOS:', len(fails))
    sys.exit(1 if fails else 0)


main()
