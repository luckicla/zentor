#!/usr/bin/env python3
"""Prueba del plugin «Vídeo de la canción» y de la barra «Pixel», sin internet.

  go build -o /tmp/mixup-video . && python3 tools/videotest/run.py

Arranca MixUp (instalación nueva y alguien que actualiza) en 127.0.0.1:47981,
con una canción hecha con ffmpeg, y finge YouTube en el navegador: /ytvideo
(un vídeo de prueba con 4 s de intro, con rangos), /ytaudio (su sonido, para
alinear) y /api/ytm (la búsqueda y la «contraparte» del vídeo). Capturas en
/tmp/videotest-out."""
import json, os, re, shutil, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

ADDR = os.environ.get('MIXUP_ADDR', '127.0.0.1:47981')
BIN = os.environ.get('MIXUP_BIN', '/tmp/mixup-video')
TMP = os.environ.get('VIDEOTEST_TMP', '/tmp')  # (another folder when several tests run at once)
OUT = os.path.join(TMP, 'videotest-out')
ASSETS = os.path.join(TMP, 'videotest-assets')
os.makedirs(OUT, exist_ok=True)
fails = []


def check(ok, what):
    print(('ok    ' if ok else 'FALLO ') + what, flush=True)
    if not ok:
        fails.append(what)


def ff(*a):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *a], check=True)


def assets():
    os.makedirs(ASSETS, exist_ok=True)
    song = os.path.join(ASSETS, 'song.mp3')
    if not os.path.exists(song):
        ff('-f', 'lavfi', '-i', r"aevalsrc='0.4*sin(2*PI*330*t*(1+0.2*sin(2*PI*t/5.3)))*(0.5+0.5*sin(2*PI*t/11.3+1)) + 0.9*sin(2*PI*60*t)*exp(-10*mod(t,0.5))*(1+0.8*sin(2*PI*t/7))*(0.3+0.7*lt(mod(t\,13)\,8))':s=44100:d=30",
           '-ac', '2', '-b:a', '128k', '-metadata', 'title=Canción Prueba', '-metadata', 'artist=Banda Test', song)
        # the video's sound: 4 s of intro, then the song
        ff('-f', 'lavfi', '-i', 'anoisesrc=d=4:a=0.02:c=pink', '-i', song, '-filter_complex',
           '[0:a]aformat=sample_rates=44100:channel_layouts=stereo[n];[n][1:a]concat=n=2:v=0:a=1', '-c:a', 'libopus', '-b:a', '48k', os.path.join(ASSETS, 'vidaudio.webm'))
        # the video: a test card with a clock, 34 s
        ff('-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=34', '-c:v', 'libvpx-vp9', '-b:v', '300k', '-an', '-deadline', 'realtime', '-cpu-used', '8', os.path.join(ASSETS, 'vid.webm'))
    return {k: open(os.path.join(ASSETS, f), 'rb').read() for k, f in (('vid', 'vid.webm'), ('vidaudio', 'vidaudio.webm'))}


def start(tag, settings=None):
    home, root = f'{TMP}/h-video-{tag}', f'{TMP}/m-video-{tag}'
    shutil.rmtree(home, True); shutil.rmtree(root, True)
    os.makedirs(home); os.makedirs(root)
    shutil.copy(os.path.join(ASSETS, 'song.mp3'), root)
    if settings is not None:
        os.makedirs(os.path.join(root, '.zentor'))
        json.dump(settings, open(os.path.join(root, '.zentor', 'settings.json'), 'w'))
    env = {**os.environ, 'MIXUP_ADDR': ADDR, 'HOME': home}
    p = subprocess.Popen([BIN, '-root', root, '-headless'], env=env, stdout=open(f'{TMP}/videotest-{tag}.log', 'w'), stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            urllib.request.urlopen(f'http://{ADDR}/api/version', timeout=1); break
        except Exception:
            time.sleep(0.2)
    return p


SEARCH = {'contents': {'tabbedSearchResultsRenderer': {'tabs': [{'tabRenderer': {'content': {'sectionListRenderer': {'contents': [{'musicShelfRenderer': {'contents': [
    {'musicResponsiveListItemRenderer': {'playlistItemData': {'videoId': 'AAAAAAAAAAA'}, 'flexColumns': [
        {'musicResponsiveListItemFlexColumnRenderer': {'text': {'runs': [{'text': 'Canción Prueba'}]}}},
        {'musicResponsiveListItemFlexColumnRenderer': {'text': {'runs': [{'text': 'Canción'}, {'text': ' • '}, {'text': 'Banda Test'}, {'text': ' • '}, {'text': '0:30'}]}}}]}}]}}]}}}}]}}}


def nxt(v):
    mt = lambda t: {'watchEndpoint': {'watchEndpointMusicSupportedConfigs': {'watchEndpointMusicConfig': {'musicVideoType': t}}}}
    return {'contents': {'singleColumnMusicWatchNextResultsRenderer': {'tabbedRenderer': {'watchNextTabbedResultsRenderer': {'tabs': [{'tabRenderer': {'content': {'musicQueueRenderer': {'content': {'playlistPanelRenderer': {'contents': [
        {'playlistPanelVideoWrapperRenderer': {
            'primaryRenderer': {'playlistPanelVideoRenderer': {'videoId': v, 'lengthText': {'runs': [{'text': '0:30'}]}, 'navigationEndpoint': mt('MUSIC_VIDEO_TYPE_ATV')}},
            'counterpart': [{'counterpartRenderer': {'playlistPanelVideoRenderer': {'videoId': 'BBBBBBBBBBB', 'lengthText': {'runs': [{'text': '0:34'}]}, 'navigationEndpoint': mt('MUSIC_VIDEO_TYPE_OMV')}}}]}}]}}}}}}]}}}}}


def ranged(route, body, mime):
    rg = route.request.headers.get('range', '')
    m = re.match(r'bytes=(\d*)-(\d*)', rg)
    if not m:
        route.fulfill(status=200, body=body, headers={'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Length': str(len(body))})
        return
    a = int(m.group(1) or 0)
    b = int(m.group(2)) if m.group(2) else len(body) - 1
    b = min(b, len(body) - 1)
    route.fulfill(status=206, body=body[a:b + 1], headers={'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Range': f'bytes {a}-{b}/{len(body)}', 'Content-Length': str(b - a + 1)})


def page_for(browser, data, phone=False, offline_video=False, design=None):
    ctx = browser.new_context(viewport={'width': 390, 'height': 844} if phone else {'width': 1280, 'height': 820},
                              device_scale_factor=2 if phone else 1, has_touch=phone, is_mobile=phone)
    pg = ctx.new_page()
    pg.errors = []
    pg.videoReqs = []

    def con(m):
        if m.type == 'error' and not re.search(r'Failed to load resource|net::ERR|ERR_|502|404', m.text):
            pg.errors.append(m.text)
    pg.on('console', con)
    pg.on('pageerror', lambda e: pg.errors.append(str(e)))

    def ytvideo(route):
        pg.videoReqs.append(route.request.url)
        if offline_video:
            route.fulfill(status=502, body='Sin conexión'); return
        if 'info=1' in route.request.url:
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'id': 'BBBBBBBBBBB', 'w': 320, 'h': 180, 'dur': 34, 'mime': 'video/webm', 'via': 'directo'})); return
        ranged(route, data['vid'], 'video/webm')
    pg.route(re.compile(r'.*/ytvideo/.*'), ytvideo)
    pg.route(re.compile(r'.*/ytaudio/BBBBBBBBBBB.*'), lambda r: ranged(r, data['vidaudio'], 'audio/webm'))

    def ytm(route):
        u = route.request.url
        if offline_video:
            route.fulfill(status=502, body='Sin conexión'); return
        if u.endswith('/search'):
            route.fulfill(status=200, content_type='application/json', body=json.dumps(SEARCH))
        elif u.endswith('/next'):
            v = json.loads(route.request.post_data or '{}').get('videoId', '')
            route.fulfill(status=200, content_type='application/json', body=json.dumps(nxt(v)))
        else:
            route.fulfill(status=502, body='no')
    pg.route(re.compile(r'.*/api/ytm/.*'), ytm)
    pg.add_init_script("try { localStorage.setItem('zt.intro', '1') } catch {}")
    pg.goto(f'http://{ADDR}/')
    pg.wait_for_function('window.ZT && ZT.tracks().length > 0', timeout=20000)
    pg.wait_for_timeout(800)
    # (a new install starts in 2.5: the Legacy checks ask for Legacy)
    if design and pg.evaluate('Mix.design()') != design:
        pg.evaluate(f"Mix.setDesign('{design}')")
        pg.wait_for_timeout(1200)
    return ctx, pg


def play(pg):
    pg.evaluate("() => { const id = ZT.tracks()[0].id; ZT.playContext({ type: 'ids', ids: [id], name: 'prueba' }, id); }")
    pg.wait_for_function('ZT.isPlaying() && ZT.position() > 0.2', timeout=10000)


def drift(pg):
    return pg.evaluate("() => { const v = Video._video, a = ZT.deck(), s = Video.state(); return { d: v.currentTime - (a.currentTime + s.offset), v: v.currentTime, a: a.currentTime, off: s.offset, paused: v.paused, rate: v.playbackRate, state: s.state }; }")


def shot(pg, name, el=None):
    p = os.path.join(OUT, name + '.png')
    (pg.locator(el).first.screenshot(path=p) if el else pg.screenshot(path=p))


def v25(browser, data, phone):
    """The video in the 2.5 interface: by default (never chosen) in the cover for YouTube songs,
    and where «Dónde» says. Phone: the big player; PC: the «Sonando» column and the big view."""
    tag = '2.5 móvil' if phone else '2.5 PC'
    ctx, pg = page_for(browser, data, phone=phone)
    song = open(os.path.join(ASSETS, 'song.mp3'), 'rb').read()
    pg.route(re.compile(r'.*/ytaudio/AAAAAAAAAAA.*'), lambda r: ranged(r, song, 'audio/mpeg'))
    if not pg.evaluate("document.documentElement.classList.contains('d25')"):
        pg.evaluate("Mix.setDesign('v25')"); pg.wait_for_timeout(1200)
    check(pg.evaluate("document.documentElement.classList.contains('d25')"), f'{tag}: diseño 2.5')
    # a local song first (default: nothing, nothing asked to YouTube), then a YouTube one
    pg.evaluate("() => { const id = ZT.tracks()[0].id; ZT.playContext({ type: 'ids', ids: [id], name: 'prueba' }, id); }")
    pg.wait_for_function('Mix.playing() && Mix.position() > 0.2', timeout=10000)
    if phone:
        pg.evaluate('V25.fullPlayer.open()')
    pg.wait_for_timeout(1500)
    check(not pg.videoReqs and not pg.evaluate("!!document.querySelector('.mv-holder.mv-on')"), f'{tag}: canción propia sin elegir nada: sin vídeo ({len(pg.videoReqs)} peticiones)')
    pg.evaluate("Mix.yt.play([{ v: 'AAAAAAAAAAA', title: 'Canción Prueba', artist: 'Banda Test', dur: 30 }], 0, 'Prueba')")
    pg.wait_for_function("Mix.track() && Mix.track().yt === 'AAAAAAAAAAA' && Mix.playing() && Mix.position() > 0.2", timeout=15000)
    cover = '.p25-fp-cover-in' if phone else '.pc-rcover'
    try:
        pg.wait_for_function(f"!!document.querySelector('{cover} > .mv-holder.mv-on video') && !Video._video.paused", timeout=15000)
        check(True, f'{tag}: canción de YouTube sin elegir nada: el vídeo en la portada')
    except Exception:
        check(False, f"{tag}: canción de YouTube sin elegir nada: el vídeo en la portada ({pg.evaluate('Video.state().state')}, {len(pg.videoReqs)} peticiones)")
    check(not pg.evaluate("!!document.querySelector('#coverWrap .mv-holder')"), f'{tag}: nada en la portada oculta de Legacy')
    pg.wait_for_timeout(1200)
    d = drift(pg)
    check(abs(d['d']) < 0.35, f"{tag}: al compás (desfase {d['d']:.3f})")
    shot(pg, ('v25-movil' if phone else 'v25-pc') + '-portada')
    if phone:
        pg.evaluate('V25.fullPlayer.close()'); pg.wait_for_timeout(900)
        check(pg.evaluate('Video._video.paused'), f'{tag}: con el reproductor grande cerrado, el vídeo descansa')
        pg.evaluate('V25.fullPlayer.open()'); pg.wait_for_timeout(1500)
        check(pg.evaluate("!!document.querySelector('.p25-fp-cover-in > .mv-holder.mv-on video') && !Video._video.paused"), f'{tag}: al abrirlo otra vez, vuelve')
    # behind
    pg.evaluate("Settings.set({ video: { ...(Settings.get().video || {}), where: 'back' } })")
    back = '.p25-fp-bgvid' if phone else 'body > .bg'
    try:
        pg.wait_for_function(f"!!document.querySelector('{back} > .mv-holder.mv-bg.mv-on') && !document.querySelector('{cover} > .mv-holder')", timeout=15000)
        check(True, f'{tag}: «Detrás»: el vídeo de fondo')
    except Exception:
        check(False, f"{tag}: «Detrás»: el vídeo de fondo ({pg.evaluate('Video.state().state')})")
    shot(pg, ('v25-movil' if phone else 'v25-pc') + '-detras')
    if not phone:
        # the big «Sonando» view: cover and background
        pg.evaluate("Settings.set({ video: { ...Settings.get().video, where: 'both' } })")
        pg.evaluate('V25.fullPlayer.open()'); pg.wait_for_timeout(1800)
        check(pg.evaluate("!!document.querySelector('.pc-full .mv-holder.mv-cover.mv-on')"), f'{tag}: «Sonando» grande: el vídeo en su portada')
        shot(pg, 'v25-pc-sonando')
        pg.evaluate('V25.fullPlayer.close()'); pg.wait_for_timeout(500)
    # navigating doesn't stop the music nor the video
    pos = pg.evaluate('Mix.position()')
    for _ in range(4):
        pg.evaluate("V25.go('library', {}, { root: true })"); pg.wait_for_timeout(250)
        pg.evaluate("V25.go('playlist', { id: 'liked' })"); pg.wait_for_timeout(250)
        pg.evaluate('ztBack()'); pg.wait_for_timeout(250)
    check(pg.evaluate('Mix.playing()') and pg.evaluate('Mix.position()') > pos + 1, f'{tag}: navegando, la música sigue')
    pg.evaluate("Store.uninstall('video')"); pg.wait_for_timeout(800)
    check(not pg.evaluate("!!document.querySelector('.mv-holder.mv-on')"), f'{tag}: sin el plugin, sin vídeo')
    check(not pg.errors, f'{tag}: sin errores en consola {pg.errors[:3]}')
    ctx.close()


def main():
    data = assets()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required', '--no-proxy-server'])

        # ---------- someone who updates: nothing changes ----------
        srv = start('upd', {'theme': 'synth', 'dj': True})
        try:
            ctx, pg = page_for(browser, data)
            st = pg.evaluate("() => ({ inst: Plugins.installed('video'), on: Plugins.enabled('video'), where: Video._cfg().where, wave: Settings.get().wave, holders: document.querySelectorAll('.mv-holder').length })")
            check(st['inst'] and st['on'], f'quien actualiza: el plugin viene instalado y encendido ({st})')
            check(st['where'] == 'hold' and st['holders'] == 0 and st['wave'] == 'wave', 'quien actualiza: ni vídeo ni barra nueva')
            play(pg)
            pg.wait_for_timeout(1500)
            check(not pg.videoReqs, f'quien actualiza: nada pedido a /ytvideo ({len(pg.videoReqs)})')
            check(pg.evaluate("document.querySelectorAll('.mv-holder').length") == 0, 'quien actualiza: sin capa de vídeo')
            check(not pg.errors, f'quien actualiza: sin errores en consola {pg.errors[:3]}')
            ctx.close()
        finally:
            srv.terminate(); srv.wait()

        # ---------- a new install, PC (Legacy) ----------
        srv = start('new')
        try:
            ctx, pg = page_for(browser, data, design='legacy')
            st = pg.evaluate("() => ({ inst: Plugins.installed('video'), on: Plugins.enabled('video'), where: Video._cfg().where, wave: Settings.get().wave })")
            check(st['inst'] and st['on'] and st['where'] == 'hold', f'instalación nueva: instalado, encendido, «solo al mantener» ({st})')
            check(st['wave'] != 'pixel', 'instalación nueva: la barra sigue como estaba')
            play(pg)
            # in the cover
            pg.evaluate("Settings.set({ video: { ...(Settings.get().video || {}), where: 'cover' } })")
            try:
                pg.wait_for_function("!!document.querySelector('#coverWrap .cover .mv-holder.mv-on video')", timeout=15000)
                check(True, 'portada: el vídeo está en la portada')
            except Exception:
                check(False, f"portada: el vídeo está en la portada ({pg.evaluate('Video.state().state')})")
            # the automatic alignment (the video has a 4 s intro)
            try:
                pg.wait_for_function("Math.abs(Video.state().offset - 4) < 0.3", timeout=15000)
                check(True, f"alineado solo: desfase {pg.evaluate('Video.state().offset')} s (esperado 4)")
            except Exception:
                check(False, f"alineado solo: desfase {pg.evaluate('Video.state().offset')} s (esperado 4)")
            pg.wait_for_timeout(1500)
            ds = []
            for _ in range(5):
                ds.append(drift(pg)); pg.wait_for_timeout(300)
            check(all(abs(x['d']) < 0.3 for x in ds), f"sincronía al sonar: {[round(x['d'], 3) for x in ds]}")
            shot(pg, 'pc-portada')
            # seek
            pg.evaluate("ZT.control('seek:15')")
            pg.wait_for_timeout(900)
            d = drift(pg)
            check(abs(d['d']) < 0.3 and d['a'] > 14, f"tras saltar a 0:15: desfase {d['d']:.3f} (audio {d['a']:.2f}, vídeo {d['v']:.2f})")
            # speed
            pg.evaluate("ZT.speed(1.5)")
            pg.wait_for_timeout(1200)
            d = drift(pg)
            check(abs(d['rate'] - 1.5) < 0.2 and abs(d['d']) < 0.35, f"a 1,5×: velocidad del vídeo {d['rate']:.2f}, desfase {d['d']:.3f}")
            pg.evaluate("ZT.speed(1)")
            pg.wait_for_timeout(500)
            # pause
            pg.evaluate("ZT.pause()")
            pg.wait_for_timeout(500)
            d = drift(pg)
            check(d['paused'] and abs(d['d']) < 0.3, f"en pausa: vídeo parado ({d['paused']}), desfase {d['d']:.3f}")
            # the Pixel bar
            pg.evaluate("Settings.set({ wave: 'pixel' })")
            pg.wait_for_timeout(600)
            shot(pg, 'pc-pixel-pausa', '.wave')
            pg.evaluate("ZT.resume()")
            pg.wait_for_timeout(1200)
            shot(pg, 'pc-pixel-sonando', '.wave')
            wavy = pg.evaluate("""() => { const c = document.getElementById('wave'), x = c.getContext('2d'), d = x.getImageData(0, 0, c.width, c.height).data;
                const rows = new Set(); for (let y = 0; y < c.height; y++) for (let i = 0; i < c.width * 0.3; i++) if (d[(y * c.width + i) * 4 + 3] > 100) rows.add(y); return rows.size; }""")
            check(wavy > 6, f'Pixel sonando: la parte tocada ondula ({wavy} filas con trazo)')
            # (headless Chrome counts as a modest PC: «Optimización» draws it still; without it, it moves)
            pg.evaluate("Settings.set({ perf: 'off' })")
            pg.wait_for_timeout(300)
            moves = pg.evaluate("""async () => { const c = document.getElementById('wave'), g = () => c.toDataURL();
                const a = g(); await new Promise(r => setTimeout(r, 120)); const b = g(); return a !== b; }""")
            check(moves, 'Pixel sonando (sin Optimización): la onda se mueve')
            pg.evaluate("ZT.pause()")
            pg.wait_for_timeout(900)
            flat = pg.evaluate("""() => { const c = document.getElementById('wave'), x = c.getContext('2d'), d = x.getImageData(0, 0, c.width, c.height).data;
                const rows = new Set(); for (let y = 0; y < c.height; y++) for (let i = 0; i < c.width * 0.3; i++) if (d[(y * c.width + i) * 4 + 3] > 100) rows.add(y); return rows.size; }""")
            check(flat < wavy, f'Pixel en pausa: queda recta ({flat} filas < {wavy})')
            shot(pg, 'pc-pixel-pausa-recta', '.wave')
            pg.evaluate("ZT.resume()")
            # <mix-progress> for the 2.5 interface
            mp = pg.evaluate("""async () => { const el = document.createElement('mix-progress'); el.style.cssText = 'position:fixed;left:20px;top:20px;width:300px;height:30px;z-index:99999;--mp-played:#ff3cac;--mp-rest:rgba(255,255,255,.4)';
                el.setAttribute('value', '0.5'); el.setAttribute('playing', ''); el.id = 'mpTest'; document.body.append(el); await new Promise(r => setTimeout(r, 400));
                const c = el.querySelector('canvas'); return c.width > 0 && c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some(v => v > 0); }""")
            check(mp, '<mix-progress> dibuja')
            shot(pg, 'mix-progress', '#mpTest')
            pg.evaluate("document.getElementById('mpTest').remove()")
            # behind
            pg.evaluate("Settings.set({ video: { ...Settings.get().video, where: 'back' } })")
            pg.wait_for_timeout(1500)
            check(pg.evaluate("!!document.querySelector('body > .bg .mv-holder.mv-bg.mv-on video') && !document.querySelector('#coverWrap .mv-holder')"), 'detrás: el vídeo de fondo, la portada sin vídeo')
            d = drift(pg)
            check(abs(d['d']) < 0.35, f"detrás: desfase {d['d']:.3f}")
            shot(pg, 'pc-detras')
            # both: the video in the cover, a copy behind
            pg.evaluate("Settings.set({ video: { ...Settings.get().video, where: 'both' } })")
            pg.wait_for_timeout(1500)
            both = pg.evaluate("""() => { const c = document.querySelector('body > .bg .mv-holder canvas.mv-mirror');
                return { cover: !!document.querySelector('#coverWrap .mv-holder.mv-on video'), mirror: !!c, drawn: !!c && c.width > 0 && c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some(v => v > 0) }; }""")
            check(both['cover'] and both['mirror'] and both['drawn'], f'en los dos: vídeo en la portada y copia detrás ({both})')
            shot(pg, 'pc-los-dos')
            # the plugin's page
            pg.evaluate("Settings.set({ video: { ...Settings.get().video, where: 'hold' } })")
            pg.click('#btnSettings')
            pg.wait_for_timeout(400)
            pg.click('#setTabs [data-tab="plugins"]')
            pg.wait_for_timeout(300)
            pg.click('[data-open="video"]')
            pg.wait_for_timeout(500)
            check(pg.evaluate("!!document.querySelector('.plg-page .mv-sec .seg[data-mv=where] button.sel[data-v=hold]')"), 'página del plugin: «Dónde» con «Solo al mantener pulsado»')
            check(pg.evaluate("!!document.querySelector('.plg-page .adv-box [data-mv=q]') && !document.querySelector('.plg-page .adv-box [data-mv=where]')"), 'página del plugin: lo avanzado abajo')
            shot(pg, 'pc-pagina-plugin')
            pg.click('.plg-page .mv-usehold')
            pg.wait_for_timeout(500)
            shot(pg, 'pc-usar-mantener')
            if pg.locator('[data-ok]').count():  # (a new install: In Cover Actions isn't installed yet)
                pg.locator('[data-ok]').last.click()
                pg.wait_for_timeout(400)
            acts = pg.evaluate("Settings.get().coverActs || {}")
            check(acts.get('hold') == 'video' and acts.get('mhold') == 'video', f'«Usar»: mantener pulsada la portada = Ver el vídeo ({acts})')
            pg.keyboard.press('Escape')
            pg.evaluate("document.getElementById('settings').classList.contains('open') && document.getElementById('btnSettings').click()")
            pg.wait_for_timeout(500)
            # the row in Ajustes → Aspecto
            check(pg.evaluate("!!document.querySelector('#mvWhereRow .seg button.sel[data-v=hold]')"), 'Ajustes → Aspecto → Portada: fila «Vídeo de la canción»')
            # hold the cover (mouse)
            box = pg.locator('#coverWrap').bounding_box()
            pg.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
            pg.mouse.down()
            pg.wait_for_timeout(1600)
            held = pg.evaluate("!!document.querySelector('#coverWrap .mv-holder.mv-on video')")
            check(held, 'mantener pulsada la portada (ratón): sale el vídeo')
            shot(pg, 'pc-mantener')
            pg.mouse.up()
            pg.wait_for_timeout(500)
            check(pg.evaluate("!document.querySelector('#coverWrap .mv-holder')"), 'al soltar: se va el vídeo')
            # without the plugin: choosing «Ver el vídeo» offers to install it
            pg.evaluate("Store.uninstall('video'); Settings.set({ coverActs: { ...Settings.get().coverActs, mhold: 'speed2' } })")
            pg.wait_for_timeout(300)
            pg.click('#btnSettings')
            pg.wait_for_timeout(400)
            pg.evaluate("PluginsUI.open('coveractions')")
            pg.wait_for_timeout(400)
            pg.evaluate("""() => { const s = document.querySelector('.plg-page select[data-slot=mhold]'); s.value = 'video'; s.dispatchEvent(new Event('change', { bubbles: true })); }""")
            pg.wait_for_timeout(600)
            shot(pg, 'pc-ofrece-instalar')
            sheet_btn = pg.locator('[data-ok]').last
            check(sheet_btn.count() > 0, 'sin el plugin: «Ver el vídeo» ofrece instalarlo')
            if sheet_btn.count():
                sheet_btn.click()
                pg.wait_for_timeout(600)
            check(pg.evaluate("Plugins.enabled('video') && (Settings.get().coverActs || {}).mhold === 'video'"), 'tras «Instalar»: el plugin está y la acción queda puesta')
            check(not pg.errors, f'PC: sin errores en consola {pg.errors[:3]}')
            ctx.close()

            # ---------- phone, the wide cover ----------
            ctx, pg = page_for(browser, data, phone=True, design='legacy')
            pg.evaluate("Settings.set({ coverFull: true, wave: 'pixel', video: { where: 'cover', full: 'video' } })")
            play(pg)
            pg.wait_for_timeout(1500)
            if pg.evaluate("document.getElementById('list').classList.contains('open')"):
                check(pg.evaluate("Video._video.paused"), 'móvil: con la biblioteca encima, el vídeo descansa')
                pg.click('#btnClose')
            pg.wait_for_function("!!document.querySelector('#coverWrap .mv-holder.mv-on video') && !Video._video.paused", timeout=15000)
            pg.wait_for_timeout(1000)
            check(pg.evaluate("!!document.querySelector('#coverWrap .mv-holder.mv-on video')"), 'móvil, portada a lo ancho: vídeo')
            shot(pg, 'movil-ancho-video')
            pg.evaluate("Settings.set({ video: { ...Settings.get().video, full: 'cover' } })")
            pg.wait_for_timeout(700)
            check(pg.evaluate("!document.querySelector('.mv-holder')"), 'móvil, portada a lo ancho: «Solo la portada»')
            shot(pg, 'movil-ancho-portada')
            # touch hold with «Ver el vídeo»
            pg.evaluate("Settings.set({ coverFull: false, coverActs: { hold: 'video' }, video: { ...Settings.get().video, where: 'hold' } })")
            pg.wait_for_timeout(600)
            box = pg.locator('#coverWrap').bounding_box()
            cdp = ctx.new_cdp_session(pg)
            x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
            pg.wait_for_timeout(1700)
            check(pg.evaluate("!!document.querySelector('#coverWrap .mv-holder.mv-on video')"), 'móvil: mantener pulsada la portada muestra el vídeo')
            shot(pg, 'movil-mantener')
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
            pg.wait_for_timeout(500)
            check(pg.evaluate("!document.querySelector('#coverWrap .mv-holder')"), 'móvil: al soltar se va')
            pg.evaluate("Settings.set({ video: { ...Settings.get().video, where: 'back' } })")
            pg.wait_for_timeout(1500)
            shot(pg, 'movil-detras')
            check(not pg.errors, f'móvil: sin errores en consola {pg.errors[:3]}')
            ctx.close()

            # ---------- offline: simply nothing ----------
            ctx, pg = page_for(browser, data, offline_video=True, design='legacy')
            pg.evaluate("localStorage.removeItem('zt.video.map'); Settings.set({ video: { where: 'cover' } })")
            play(pg)
            pg.wait_for_timeout(2500)
            st = pg.evaluate("({ s: Video.state().state, on: !!document.querySelector('.mv-holder.mv-on') })")
            check(st['s'] in ('none', 'error') and not st['on'], f'sin conexión: se oculta ({st})')
            check(not pg.errors, f'sin conexión: sin errores en consola {pg.errors[:3]}')
            ctx.close()
        finally:
            srv.terminate(); srv.wait()

        # ---------- the 2.5 design (a new install), phone and PC ----------
        for phone in (True, False):
            srv = start('v25' + ('m' if phone else 'p'))
            try:
                v25(browser, data, phone)
            finally:
                srv.terminate(); srv.wait()
        browser.close()
    print('\n' + ('TODO BIEN' if not fails else f'{len(fails)} FALLOS:\n  ' + '\n  '.join(fails)))
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
