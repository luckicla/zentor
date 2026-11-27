#!/usr/bin/env python3
"""Prueba del diseño 2.5 en el PC (web/v25/pc/), sin internet.

  go build -o /tmp/mixup-pc . && python3 tools/v25pctest/run.py

Arranca MixUp en 127.0.0.1:47902 (instalación nueva = 2.5, y alguien que
actualiza = Legacy que luego prueba el 2.5) con unas canciones WAV hechas
aquí, y comprueba: búsqueda al instante, Enter → vista «search», atrás /
adelante, Esc solo cierra (nunca va atrás), Ctrl+K, Ctrl+←/→, arrastrar a una
playlist, cola (reordenar), letra, «Sonando» grande, botones de Legacy en la
barra (Ajustes, DJ), menú plegado en ventanas estrechas, y lo de «2.5 PC fixes»
(barra de arriba de lado a lado, lateral limpio, Ajustes abajo a la derecha, letra
bajo la portada, DJ desde la derecha, barras de desplazamiento del tema). Capturas en
/tmp/v25pctest-out (1280x820, 1920x1080, 1024x700)."""
import json, math, os, shutil, struct, subprocess, sys, time, urllib.request, wave
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'phonetest'))
from switches import switches as switch_check  # (shared with tools/phonetest)
from buttons import buttons as buttons_check  # (idem)

ADDR = os.environ.get('MIXUP_ADDR', '127.0.0.1:47902')
BIN = os.environ.get('MIXUP_BIN', '/tmp/mixup-pc')
OUT = os.environ.get('V25PC_OUT', '/tmp/v25pctest-out')
MUSIC = os.environ.get('V25PC_MUSIC', '/tmp/v25pctest-music')
TMP = os.environ.get('V25PC_TMP', '/tmp')  # (the app's folders and logs: another one to run next to other tests)
os.makedirs(OUT, exist_ok=True)
fails = []


def check(ok, what):
    print(('ok    ' if ok else 'FALLO ') + what, flush=True)
    if not ok:
        fails.append(what)


def music():
    # a folder cover for «Mareas» (Ajustes → Aspecto → Portada needs a song with a cover)
    art = os.path.join(MUSIC, 'Mareas', 'cover.jpg')
    if os.path.isdir(MUSIC) and not os.path.exists(art):
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xff3c8a:s=600x600,format=rgb24', '-vf',
                        'drawbox=x=0:y=300:w=600:h=300:color=0x1ec8ff:t=fill,drawbox=x=150:y=150:w=300:h=300:color=0xffd400:t=fill',
                        '-frames:v', '1', art], check=False)
    if os.path.isdir(MUSIC):
        return
    songs = [('Luna Norte', 'Mareas', 'Faro azul', 220), ('Luna Norte', 'Mareas', 'Corriente', 262), ('Luna Norte', 'Mareas', 'Bajamar', 330),
             ('Los Vatios', 'Voltaje', 'Chispa', 294), ('Los Vatios', 'Voltaje', 'Cortocircuito', 196), ('Aire Fino', '', 'Despegue', 349)]
    for ar, al, ti, f in songs:
        d = os.path.join(MUSIC, al or 'sueltas'); os.makedirs(d, exist_ok=True)
        w = wave.open(os.path.join(d, f'{ar} - {ti}.wav'), 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(11025)
        w.writeframes(b''.join(struct.pack('<h', int(9000 * math.sin(2 * math.pi * f * i / 11025))) for i in range(11025 * 40)))
        w.close()
    music()  # (the cover)
    open(os.path.join(MUSIC, 'Mareas', 'Luna Norte - Faro azul.lrc'), 'w').write('\n'.join(f'[00:{i * 3:02d}.00]Línea {i + 1} de la letra' for i in range(13)))


def start(tag, settings=None):
    try:
        urllib.request.urlopen(f'http://{ADDR}/api/version', timeout=1)
        sys.exit(f'{ADDR} ya está en uso (¿un MixUp de una prueba anterior?): ciérralo primero')
    except OSError:
        pass
    home, root = f'{TMP}/h-{tag}-pc', f'{TMP}/m-{tag}-pc'
    shutil.rmtree(home, True); shutil.rmtree(root, True)
    os.makedirs(home); shutil.copytree(MUSIC, root)
    if settings is not None:
        os.makedirs(os.path.join(root, '.zentor'))
        json.dump(settings, open(os.path.join(root, '.zentor', 'settings.json'), 'w'))
    p = subprocess.Popen([BIN, '-root', root, '-headless'], env={**os.environ, 'MIXUP_ADDR': ADDR, 'HOME': home},
                         stdout=open(f'{TMP}/v25pctest-{tag}.log', 'w'), stderr=subprocess.STDOUT)
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


def covers(b):
    """Ajustes → Aspecto → Portada in 2.5 (web/v25/cover.css + cover.js): each option changes something measurable."""
    errs = []
    pg = page(b, 1280, 820, errs)
    ev = pg.evaluate
    if not ev("document.documentElement.classList.contains('d25-pc')"):
        ev("Mix.setDesign('v25')"); pg.wait_for_timeout(1200)
    ev("Settings.set({coverFull:false, coverFrame:false, coverGlow:true, coverColors:'none', bg:'cover'})")
    tid = ev("(Mix.tracks().find(t => t.cover) || {}).id")
    check(bool(tid), 'portada: hay una canción con portada')
    ev(f"Mix.playTrack(Mix.byId('{tid}'))"); pg.wait_for_timeout(1500)
    ev("PC25.right.show('now')"); pg.wait_for_timeout(600)
    R = "(() => { const e = document.querySelector('#v25 .pc-rcover'); if (!e) return null; const r = e.getBoundingClientRect(), c = getComputedStyle(e); return { w: r.width, h: r.height, rad: parseFloat(c.borderTopLeftRadius), mask: c.maskImage || c.webkitMaskImage, frame: getComputedStyle(e, '::before').content, shadow: c.boxShadow }; })()"
    F = "(() => { const e = document.querySelector('#v25 .pc-fcover'); const c = getComputedStyle(e); return { w: e.offsetWidth, rad: parseFloat(c.borderTopLeftRadius), mask: c.maskImage || c.webkitMaskImage, meta: document.querySelector('#v25 .pc-fmeta').offsetTop - (e.offsetTop + e.offsetHeight) }; })()"
    got = {}
    for m, st in (('box', {'coverFull': False}), ('wide', {'coverFull': True, 'coverFullSize': 'normal'}), ('big', {'coverFull': True, 'coverFullSize': 'big'})):
        ev(f"Settings.set({json.dumps(st)})"); pg.wait_for_timeout(500)
        got[m] = ev(R)
        pg.screenshot(path=f'{OUT}/cover-{m}.png')
    # the maximized view: the three, one after the other, with it open (the artist's
    # column may turn up a moment later and change the sizes: all with the same)
    ev("V25.fullPlayer.open()"); pg.wait_for_timeout(1500)
    for m, st in (('box', {'coverFull': False}), ('wide', {'coverFull': True, 'coverFullSize': 'normal'}), ('big', {'coverFull': True, 'coverFullSize': 'big'})):
        ev(f"Settings.set({json.dumps(st)})"); pg.wait_for_timeout(500)
        got[m + 'F'] = ev(F)
        pg.screenshot(path=f'{OUT}/cover-{m}-full.png')
    ev("V25.fullPlayer.close(); Settings.set({coverFull:false})"); pg.wait_for_timeout(500)
    bx, wd, bg_ = got['box'], got['wide'], got['big']
    check(bx and wd and bg_, 'portada: la columna derecha «Sonando» tiene portada')
    if bx and wd and bg_:
        check(wd['w'] > bx['w'] + 10 and wd['rad'] == 0 and bx['rad'] > 0, f"«A lo ancho»: la portada de la columna derecha va de borde a borde ({bx['w']:.0f}→{wd['w']:.0f}px, esquinas {bx['rad']}→{wd['rad']})")
        check(bg_['h'] > bg_['w'] + 10 and bg_['mask'] not in ('none', '', None), f"«Grande»: más alta y fundida ({bg_['w']:.0f}x{bg_['h']:.0f})")
    bF, wF, gF = got['boxF'], got['wideF'], got['bigF']
    check(wF['w'] > bF['w'] + 10 and wF['rad'] == 0 and wF['mask'] not in ('none', ''), f"vista maximizada: «A lo ancho» cambia la portada ({bF['w']:.0f}→{wF['w']:.0f}px)")
    check(gF['w'] > wF['w'] + 10 and gF['meta'] < wF['meta'] - 20, f"vista maximizada: «Grande», más grande y con el título encima ({wF['w']:.0f}→{gF['w']:.0f}px, título {wF['meta']:.0f}→{gF['meta']:.0f})")
    # «Esquinas de la portada»
    ev("Settings.set({coverFull:false, coverFrame:false})"); pg.wait_for_timeout(300)
    off = ev(R)['frame']
    ev("Settings.set({coverFrame:true})"); pg.wait_for_timeout(300)
    on = ev(R)['frame']
    pg.screenshot(path=f'{OUT}/cover-frame.png')
    check(off == 'none' and on != 'none', f'«Esquinas de la portada»: los corchetes salen y se van ({off} → {on})')
    # «Brillo según la portada»: --glow = the cover's colour, or the accent with it off
    ev("Settings.set({coverFrame:false, coverGlow:false})"); pg.wait_for_timeout(1300)
    g0, pink = ev("getComputedStyle(document.documentElement).getPropertyValue('--glow').trim()"), ev("getComputedStyle(document.documentElement).getPropertyValue('--pink-rgb').trim()")
    ev("Settings.set({coverGlow:true})"); pg.wait_for_timeout(1300)
    g1 = ev("getComputedStyle(document.documentElement).getPropertyValue('--glow').trim()")
    sh = ev("getComputedStyle(document.querySelector('#v25 .pc-rnow')).backgroundImage")
    check(g0.replace(' ', '') == pink.replace(' ', '') and g1 != g0 and g1.replace(',', ', ') in sh, f'«Brillo según la portada»: el resplandor de la portada cambia ({g0} → {g1})')
    # the background with the cover: bg, blur, dim, colours
    ev("Settings.set({bg:'flat'})"); pg.wait_for_timeout(600)
    flat = ev("document.querySelector('body > .bg').className")
    ev("Settings.set({bg:'cover', coverBlur:10, coverDim:0.1})"); pg.wait_for_timeout(900)
    cov = ev("document.querySelector('body > .bg').className")
    f1 = ev("getComputedStyle(document.getElementById('bgImg')).filter")
    ev("Settings.set({coverBlur:60, coverDim:0.7})"); pg.wait_for_timeout(600)
    f2 = ev("getComputedStyle(document.getElementById('bgImg')).filter")
    check('flat' in flat and 'coverbg' in cov and 'flat' not in cov, f'fondo con la portada: liso ↔ portada ({flat} → {cov})')
    check(f1 != f2, f'fondo: el desenfoque cambia ({f1} → {f2})')
    a0 = ev("getComputedStyle(document.documentElement).getPropertyValue('--acid').trim()")
    ev("Settings.set({coverColors:'all'})"); pg.wait_for_timeout(900)
    a1 = ev("getComputedStyle(document.documentElement).getPropertyValue('--acid').trim()")
    check(a0 != a1, f'«Colores de la portada»: los colores de la app cambian ({a0} → {a1})')
    ev("Settings.set({coverBlur:36, coverDim:0.3, coverColors:'none'})")
    # the live copy in Settings
    ev("Mix.openSettings('look')"); pg.wait_for_timeout(700)
    pg.locator('#coverModes').scroll_into_view_if_needed()
    vis = ev("(() => { const p = document.querySelector('.cov25-pv'); return !!p && p.getBoundingClientRect().height > 100 && !!p.querySelector('.cov25-cover').style.backgroundImage; })()")
    pg.locator('#coverModes [data-m=wide]').click(); pg.wait_for_timeout(400)
    wv = ev("getComputedStyle(document.querySelector('.cov25-wide')).display")
    pg.locator('.cov25-pv').screenshot(path=f'{OUT}/cover-preview-wide.png')
    pg.locator('#coverModes [data-m=box]').click(); pg.wait_for_timeout(400)
    bv = ev("getComputedStyle(document.querySelector('.cov25-wide')).display")
    check(vis and wv == 'block' and bv == 'none', 'Ajustes: la vista previa de la portada sale y sigue «Cómo sale» en directo')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(400)
    # In Cover Actions with the mouse (and the core ones with the plugin off)
    c = pg.locator('#v25 .pc-rcover')
    c.dblclick(); pg.wait_for_timeout(600)
    check(ev("V25.fullPlayer.isOpen()"), 'portada: doble clic abre la vista maximizada (sin el plugin)')
    pg.locator('#v25 .pc-fcover').dblclick(); pg.wait_for_timeout(600)
    check(not ev("V25.fullPlayer.isOpen()"), 'vista maximizada: doble clic en la portada la cierra')
    c.click(button='right'); pg.wait_for_timeout(500)
    check(ev("!!document.querySelector('.v-menu, .lv-popwrap')"), 'portada: clic derecho abre el menú de la canción')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(400)
    ev("Plugins.setEnabled('coveractions', true); Settings.set({coverActs:{mtap:'playpause', mdbl:'like'}})"); pg.wait_for_timeout(300)
    ev("Mix.play()"); pg.wait_for_timeout(300)
    c.click(); pg.wait_for_timeout(700)
    check(not ev("Mix.playing()"), 'In Cover Actions: un clic en la portada (Reproducir / pausar) pausa')
    l0 = ev("Mix.state().liked"); c.dblclick(); pg.wait_for_timeout(700)
    check(ev("Mix.state().liked") != l0 and not ev("V25.fullPlayer.isOpen()"), 'In Cover Actions: doble clic (Me gusta) en vez de la vista maximizada')
    ev("Mix.play(); Settings.set({coverActs:{mhold:'speed2'}})"); pg.wait_for_timeout(300)
    bb = c.bounding_box(); pg.mouse.move(bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2); pg.mouse.down(); pg.wait_for_timeout(800)
    sp = ev("ZT.speed()"); pg.mouse.up(); pg.wait_for_timeout(300)
    check(sp == 2 and ev("ZT.speed()") == 1, f'In Cover Actions: mantener pulsado (x2) ({sp} → {ev("ZT.speed()")})')
    ev("Settings.set({coverActs:{}}); Plugins.setEnabled('coveractions', false)")
    check(not errs, 'sin errores en consola (portada): ' + '; '.join(errs[:3]))
    pg.close()


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
    # (2.5 PC fixes: the side menu has no library tabs any more: Biblioteca, then its own chip)
    pg.click('.pc-nb[data-go="library"]'); pg.wait_for_timeout(400)
    pg.click('.lv-chip[data-sec="songs"]'); pg.wait_for_timeout(400)
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
    pc_fixes(pg)
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


def pc_fixes(pg):
    """2.5 PC fixes: top bar from side to side, clean side menu, Ajustes bottom right, lyrics
    under the cover, nothing «Sonando ahora» on Inicio, DJ from the right, themed scroll bars."""
    ev = pg.evaluate
    top = ev("(() => { const t = document.querySelector('#v25 .v-top').getBoundingClientRect(), s = document.querySelector('#v25 .v-side').getBoundingClientRect(); return [t.left, t.right, t.bottom, s.left, s.top, innerWidth]; })()")
    check(top[0] <= top[3] + 1 and top[1] >= top[5] - 12 and top[4] >= top[2], 'barra de arriba de lado a lado, el menú empieza debajo: ' + str([round(x) for x in top]))
    c = ev("(() => { const b = document.querySelector('#v25 .pc-sbox').getBoundingClientRect(), s = document.querySelector('#v25 .v-side').getBoundingClientRect(), m = document.querySelector('#v25 .v-main').getBoundingClientRect(); return [b.left + b.width / 2, (m.left + m.right) / 2]; })()")
    check(abs(c[0] - c[1]) < 6, f'buscador centrado sobre el centro: {c[0]:.0f} / {c[1]:.0f}')
    bg = ev("getComputedStyle(document.querySelector('#v25 .v-top')).backgroundColor")
    check(bg not in ('rgba(0, 0, 0, 0)', 'rgb(0, 0, 0)', 'rgba(0, 0, 0, 1)'), 'barra de arriba con el color del tema (no negra): ' + bg)
    check(ev("!document.querySelector('#v25 .pc-addpill') && !document.querySelector('#v25 [data-slot=topbar] [data-act=add]')"), 'sin «+ Añadir música» arriba a la derecha')
    check(ev("!!document.querySelector('#v25 .pc-side .pc-add') && document.querySelector('#v25 .pc-side .pc-add').offsetHeight <= 36"), '«Añadir música» pequeño en el lateral')
    check(ev("!document.querySelector('#v25 .pc-nb[data-go=search]') && !document.querySelector('#v25 .pc-libtabs')"), 'lateral sin «Buscar» y sin pestañas bajo «Biblioteca»')
    check(ev("!!document.querySelector('#v25 .pc-top .pc-logo') && !document.querySelector('#v25 .pc-side .pc-brand')"), 'el logo está en la barra de arriba')
    ev("V25.go('home', {}, { root: true })"); pg.wait_for_timeout(400)
    check(ev("[...document.querySelectorAll('#v25 .v-setbtn')].every(b => !b.offsetParent)"), 'sin botón de ajustes en la cabecera de las vistas')
    check(not pg.locator('.hm-nowc').count() or not pg.locator('.hm-nowc').first.is_visible(), 'Inicio sin «Sonando ahora»')
    pg.click('#v25 .pc-search input'); pg.keyboard.press('Enter'); pg.wait_for_timeout(400)
    check(ev("V25.current().id") == 'search', 'Enter con el buscador vacío abre la vista de búsqueda')
    pg.keyboard.press('Escape'); pg.keyboard.press('Escape')
    btns = ev("[...document.querySelectorAll('.pc-legacy-btns > button')].filter(b => !b.hidden && b.offsetParent).map(b => b.dataset.act || b.dataset.legacy)")
    check(len(btns) >= 2 and btns[-2:] == ['settings', 'full'], 'Ajustes abajo a la derecha, justo antes de pantalla grande: ' + ','.join(btns))
    pg.click('#v25 .pc-set'); pg.wait_for_timeout(500)
    check(ev('Mix.settingsOpen()'), 'el botón de ajustes de la barra abre Ajustes')
    sx = ev("document.getElementById('settings').getBoundingClientRect().right")
    check(sx >= ev('innerWidth') - 2, 'Ajustes se abre a la derecha')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(400)
    ev("PC25.right.show('now')"); pg.wait_for_timeout(1500)
    check(ev("!!document.querySelector('.pc-rlyr') && !document.querySelector('.pc-rlyr').hidden && /Línea/.test(document.querySelector('.pc-rlines').textContent)"), '«Sonando»: la letra debajo de la portada')
    pg.click('.pc-rlyr .pc-rmore'); pg.wait_for_timeout(400)
    check(ev("PC25.right.tab()") == 'lyrics' and ev("!!document.querySelector('.pc-lyr')"), '«Ver la letra» abre la pestaña Letra')
    ev("PC25.right.show('now')")
    check(ev("getComputedStyle(document.querySelector('#v25 .v-main')).scrollbarWidth") == 'auto' and ev("getComputedStyle(document.querySelector('#v25 .pc-rbody')).scrollbarWidth") == 'auto', 'barras de desplazamiento con el estilo de la app (centro y columna derecha)')
    dj_check(pg)


def dj_check(pg):
    ev = pg.evaluate
    if not ev("Mix.dj.available()"):
        return
    ev("Mix.dj.open()"); pg.wait_for_timeout(60)
    tr = ev("getComputedStyle(document.querySelector('.djwrap .djp')).transform")
    pg.wait_for_timeout(600)
    r = ev("(() => { const b = document.querySelector('.djwrap .djp').getBoundingClientRect(); return [b.right, innerWidth]; })()")
    check(tr.startswith('matrix(1, 0, 0, 1,') and float(tr.split(',')[4]) > 0 and r[0] >= r[1] - 12, 'el DJ entra desde la derecha: ' + tr)
    ev("Mix.dj.open && document.querySelector('.djwrap [data-dj=close]').click()"); pg.wait_for_timeout(400)


def switches(b):
    # every switch and slider (Legacy and 2.5, corners 0 and 26): the same look and the same vibration
    errs = []
    pg = page(b, 1280, 820, errs)
    pg.evaluate("document.querySelector('.news-wrap')?.remove()")
    switch_check(pg, 'PC', check, OUT)
    check(not errs, 'interruptores: sin errores en consola ' + '; '.join(errs[:3]))
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
    check('btnSettings' not in ids and 'btnQueue' in ids, 'barra: los botones de Legacy, en su orden (Ajustes va aparte, antes de pantalla grande): ' + ','.join(ids))
    # (2.5 PC fixes: on the PC the settings button is in the player bar, bottom right; the views' head has none)
    check(ev("[...document.querySelectorAll('#v25 .v-setbtn')].every(b => !b.offsetParent)") and ev("document.querySelectorAll('#v25 .pc-set').length") == 1 and ev("!document.querySelector('#v25 .pc-set svg path[d^=\"M19.4\"]')"), 'un solo botón de ajustes (abajo a la derecha), con el icono de las dos barritas')
    pg.click('#v25 .pc-set'); pg.wait_for_timeout(500)
    check(ev('Mix.settingsOpen()'), 'el botón de ajustes de la barra abre Ajustes')
    # «Diseño»: the first thing in Aspecto (not a block fixed on top of the panel)
    check(ev("document.querySelector('.stab[data-tab=\"look\"]').firstElementChild?.id") == 'setDesign'
          and ev("[...document.querySelectorAll('#setDesign [data-design]')].map(b => b.dataset.design).join(',')") == 'legacy,v25,compact'
          and ev("document.querySelector('#setDesign [data-design=\"v25\"]').classList.contains('sel')"),
          'Diseño: lo primero de Aspecto, con Legacy / 2.5 / Compacto y el 2.5 elegido')
    check(ev("!document.querySelector('#settings > .set-design')"), 'Diseño: ya no está fijo arriba del panel')
    check(ev("getComputedStyle(document.querySelector('.preset .pv-cover')).backgroundImage.includes('gradient')"), 'Estilos: las vistas previas tienen sus colores')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(400)
    check(not ev('Mix.settingsOpen()'), 'Esc cierra Ajustes')
    dj_check(pg)
    pg.screenshot(path=f'{OUT}/legacy-a-25.png')
    ev("Mix.setDesign('legacy')"); pg.wait_for_timeout(1000)
    check(not ev("!!document.getElementById('v25')"), 'de vuelta a Legacy: no queda nada del 2.5')
    check(not errs, 'sin errores en consola (quien actualiza): ' + '; '.join(errs[:3]))
    pg.close()

def phoneui(b):
    """v25d-phoneui on the PC: playlist pictures and what's playing on Inicio, right click on Inicio,
    the progress styles live, the player's own background in «Sonando»."""
    errs = []
    pg = page(b, 1280, 800, errs)
    ev = pg.evaluate
    pg.wait_for_function("document.documentElement.classList.contains('d25-pc') && Mix.tracks().length > 3", timeout=15000)
    ev("Mix.pl.create('Mezcla', Mix.tracks().slice(0, 5))"); pg.wait_for_timeout(500)
    pid = ev("Mix.playlists().find(p => p.name === 'Mezcla').id")
    ev("V25.go('home', {}, {root: true})"); pg.wait_for_timeout(1500)
    T = f'.hm-sec[data-sec=playlists] .hm-tile[data-group="playlist:{pid}"]'
    pic = ev(f"(() => {{ const im = [...document.querySelectorAll('{T} .hm-plart img')]; return im.some(i => i.complete && i.naturalWidth > 0); }})()")
    check(pic, 'PC Inicio: la playlist sale con su portada')
    ev(f"Mix.playPlaylist('{pid}')"); pg.wait_for_timeout(1200)
    lv = ev(f"[!!document.querySelector('{T}')?.classList.contains('v-live'), !!document.querySelector('{T} .v-eq'), !!document.querySelector('.pc-pl.live')]")
    check(all(lv), f'PC Inicio: la playlist que suena se marca (como el lateral) {lv}')
    pg.screenshot(path=f'{OUT}/pui-pc-1-inicio.png')
    res = []
    for sel in (T, '.hm-tile[data-track]', '.hm-tile[data-group^="album:"]', '.hm-tile[data-group^="artist:"]'):
        ev(f"document.querySelector({json.dumps(sel)}).scrollIntoView({{block: 'center', inline: 'center'}})"); pg.wait_for_timeout(250)
        pg.locator(sel).first.click(button='right'); pg.wait_for_timeout(400)
        res.append(ev("!!document.querySelector('.lv-popwrap .lv-pop .lv-mhead b')"))
        if sel == T: pg.screenshot(path=f'{OUT}/pui-pc-2-menu-inicio.png')
        pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    check(all(res), f'PC Inicio: clic derecho abre el menú de playlist, canción, álbum y artista {res}')
    got = []
    for st in ('wave', 'bar', 'pixel'):
        ev(f"Mix.settings.set({{wave: '{st}'}})"); pg.wait_for_timeout(500)
        got.append(ev("(() => { const c = document.querySelector('.pc-wavebox canvas'); return c ? c.toDataURL().length : 0; })()"))
        pg.screenshot(path=f'{OUT}/pui-pc-3-barra-{st}.png', clip={'x': 0, 'y': 700, 'width': 1280, 'height': 100})
    check(len(set(got)) == 3 and all(got), f'PC: la barra de progreso cambia con Onda / Barra / Pixel ({got})')
    ev("Mix.settings.set({wave: 'wave'})")
    ev("V25.fullPlayer.open()"); pg.wait_for_timeout(900)
    d0 = ev("getComputedStyle(document.querySelector('.pc-fbg-img')).display")
    ev("Mix.settings.set({v25PlayerBg: 'flat'})"); pg.wait_for_timeout(500)
    d1 = [ev("getComputedStyle(document.querySelector('.pc-fbg-img')).display"), ev("document.documentElement.classList.contains('pbg-flat')")]
    pg.screenshot(path=f'{OUT}/pui-pc-4-sonando-liso.png')
    ev("Mix.settings.set({v25PlayerBg: 'cover', v25PlayerBlur: 6})"); pg.wait_for_timeout(500)
    d2 = ev("getComputedStyle(document.querySelector('.pc-fbg-img')).filter")
    ev("Mix.settings.set({v25PlayerBg: undefined, v25PlayerBlur: undefined})"); pg.wait_for_timeout(500)
    d3 = ev("document.documentElement.classList.contains('pbg-own')")
    check(d0 != 'none' and d1 == ['none', True] and 'blur(6px)' in d2 and not d3, f'PC «Sonando»: fondo propio (liso, portada con su desenfoque) y vuelta a lo de siempre {d0} {d1} {d2} {d3}')
    ev("V25.fullPlayer.close()"); pg.wait_for_timeout(400)
    check(not errs, 'phoneui PC: sin errores en consola ' + '; '.join(errs[:3]))
    pg.close()



def buttons(b):
    """v25f-botones: play y botones de la 2.5 con el mismo estilo que Legacy según el preset de Aspecto (tools/phonetest/buttons.py)."""
    errs = []
    pg = page(b, 1280, 820, errs)
    pg.wait_for_function("document.documentElement.classList.contains('d25-pc') && Mix.tracks().length > 3", timeout=15000)
    buttons_check(pg, 'PC', check, OUT, phone=False)
    check(not errs, 'botones PC: sin errores en consola ' + '; '.join(errs[:3]))
    pg.close()


music()
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required'])
    for tag, st, fn in (('new', None, fresh), ('upd', {'theme': 'synth', 'dj': True}, updater), ('cov', None, covers), ('sw', {'dj': True}, switches), ('pui', None, phoneui), ('btn', None, buttons)):
        p = start(tag, st)
        try:
            fn(b)
        finally:
            p.terminate(); p.wait()
    b.close()
print('\n' + ('TODO BIEN' if not fails else f'{len(fails)} FALLOS'))
sys.exit(1 if fails else 0)
