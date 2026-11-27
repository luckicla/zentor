#!/usr/bin/env python3
"""Prueba del móvil 2.5 (web/v25/phone/): barra, mini reproductor, reproductor grande, cola, gestos.

  go build -o /tmp/mixup-phone . && python3 tools/phonetest/run.py

Instalación nueva con unas canciones generadas (ffmpeg) en /tmp/phone-assets;
gestos con CDP Input.dispatchTouchEvent; capturas en /tmp/phonetest-out."""
import os, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from common import *
from playwright.sync_api import sync_playwright

OUT = '/tmp/phonetest-out'
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
    check(not errs, f'{tag}: sin errores en consola {errs[:3]}')
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
                p2.kill()
            b.close()
    finally:
        p.kill()
    print('FALLOS:', len(fails))
    sys.exit(1 if fails else 0)


main()
