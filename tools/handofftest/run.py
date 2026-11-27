#!/usr/bin/env python3
"""«Seguir donde lo dejaste» and «Otros aparatos» (web/plugins/gdrive-now.js,
lanlink.go, handoff.go) end to end, with no internet: two MixUps (a «PC» and a
«phone»: the second one's page with Android's user agent and a stub of its
bridge) and the fake Google of tools/googletest (Drive included).

    go build -o /tmp/hand-mixup . && python3 tools/handofftest/run.py

- the PC publishes in Drive where it is (now-<id>.json) and its LAN address +
  pairing key (device-<id>.json → lan); the phone reads it and offers «Seguir
  donde lo dejaste en <PC>»: same song, same second, same playlist, same
  repeat; a song the phone hasn't → «Buscar en YouTube»
- the phone pairs by itself with the published address (no QR) and from
  «Otros aparatos» controls the PC (pause, next, volume, look for a song) and
  moves the music both ways («Pasar aquí», «Mandar a…»), also from the PC
- the 2.5 PC bar has no «Dispositivos» any more; Legacy opens the sheet from
  Ajustes → Plugins → Sincronización
- Desconectar takes the address and the key out of Drive and drops the key
- no errors in the console (network errors to the internet aside)

Ports (env): HAND_PORTS="pc,phone,pcLan,phoneLan,fakeGoogle" (default
18653,18654,18655,18656,18657). Screenshots in HAND_OUT (/tmp/hand-out)."""
import json, os, re, shutil, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
FAKE_PY = os.path.join(HERE, '..', 'googletest', 'fake_google.py')
BIN = os.environ.get('MIXUP_BIN', '/tmp/hand-mixup')
OUT = os.environ.get('HAND_OUT', '/tmp/hand-out')
MUSIC = os.environ.get('HAND_MUSIC', '/tmp/hand-music')
P_PC, P_PH, L_PC, L_PH, FAKE = [int(x) for x in os.environ.get('HAND_PORTS', '18653,18654,18655,18656,18657').split(',')]
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT, exist_ok=True)
procs, fails = [], []

STUB = """
window.MixUpAndroid = new Proxy({}, { get: (_, k) => k === 'deviceName' ? () => 'Pixel de Lluc' : k === 'systemVolume' ? () => 1 : () => '' });
"""
ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36 MixUpAndroid'


def check(ok, what):
    print(('ok    ' if ok else 'FALLO ') + what, flush=True)
    if not ok:
        fails.append(what)


def get(url):
    try:
        return urllib.request.urlopen(url, timeout=3).read().decode()
    except Exception:
        return ''


def until(fn, secs=20, step=0.3):
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


def music():
    if os.path.isdir(MUSIC) and len(os.listdir(MUSIC)) >= 6:
        return
    os.makedirs(MUSIC, exist_ok=True)
    songs = [('Luna Norte', 'Faro azul', 330), ('Luna Norte', 'Corriente', 392), ('Luna Norte', 'Bajamar', 440),
             ('Los Vatios', 'Chispa', 494), ('Los Vatios', 'Cortocircuito', 523)]
    for ar, ti, f in songs:
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'sine=f={f}:d=150', '-ac', '1', '-b:a', '32k',
                        '-metadata', f'title={ti}', '-metadata', f'artist={ar}', '-metadata', 'album=Mareas',
                        os.path.join(MUSIC, f'{ar} - {ti}.mp3')], check=True)


def start(tag, port, lanport, pc_only=None):
    home, root = f'/tmp/hand-h-{tag}', f'/tmp/hand-m-{tag}'
    shutil.rmtree(home, True); shutil.rmtree(root, True)
    os.makedirs(home); shutil.copytree(MUSIC, root)
    if pc_only:  # a song only this one has
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=600:d=150', '-ac', '1', '-b:a', '32k',
                        '-metadata', 'title=Solo en el PC', '-metadata', 'artist=Nadie Más', os.path.join(root, 'Nadie Más - Solo en el PC.mp3')], check=True)
    os.makedirs(os.path.join(root, '.zentor'))
    open(os.path.join(root, '.zentor', 'google-client.json'), 'w').write('{"client_id":"cid","client_secret":"csec"}')
    env = dict(os.environ, MIXUP_ADDR=f'127.0.0.1:{port}', HOME=home, MIXUP_GOOGLE_BASE=f'http://127.0.0.1:{FAKE}',
               ZENTOR_LAN_IP='127.0.0.1', MIXUP_LAN_PORT=str(lanport))
    env.pop('MIXUP_GOOGLE_CLIENT_SECRET', None)
    p = subprocess.Popen([BIN, '-root', root, '-headless'], env=env, stdout=open(f'/tmp/hand-{tag}.log', 'w'), stderr=subprocess.STDOUT)
    procs.append(p)
    until(lambda: get(f'http://127.0.0.1:{port}/api/version'))
    return f'http://127.0.0.1:{port}/'


errors = {}


def page(br, name, url, phone=False):
    opts = dict(viewport={'width': 390, 'height': 844} if phone else {'width': 1280, 'height': 820}, locale='es-ES')
    if phone:
        opts.update(user_agent=ANDROID_UA, has_touch=True, is_mobile=True, device_scale_factor=2)
    ctx = br.new_context(**opts)
    ctx.add_init_script("try { localStorage.setItem('zt.intro', '1') } catch {}")
    if phone:
        ctx.add_init_script(STUB)
    pg = ctx.new_page()
    errors[name] = []
    noise = ('net::', 'Failed to load resource', 'ERR_', 'ytimg', 'youtube')
    pg.on('console', lambda m: m.type == 'error' and not any(n in m.text for n in noise) and errors[name].append(m.text))
    pg.on('pageerror', lambda e: errors[name].append('pageerror: ' + str(e)))
    pg.goto(url)
    pg.wait_for_function('window.ZT && ZT.tracks().length >= 5 && typeof GoogleAcct !== "undefined" && GoogleAcct.known() && typeof Journal !== "undefined" && Journal.ready()', timeout=30000)
    pg.wait_for_timeout(1500)
    return pg


def sign_in(pg, name):
    pg.evaluate('GoogleAcct.connect()')
    ok = pg.wait_for_function('GoogleAcct.driveReady()', timeout=30000)
    check(bool(ok), f'{name}: conectado a la cuenta de Google (falsa)')


def sync(pg):
    pg.evaluate('DriveSync.run(true)')
    pg.wait_for_timeout(500)
    pg.wait_for_function('!DriveSync.busy()', timeout=30000)


def drive_json(pg, name):
    return pg.evaluate(f"fetch('/api/google/drive/{name}', {{cache: 'no-store'}}).then(r => r.ok ? r.json() : null)")


def track_title(pg):
    return pg.evaluate('ZT.cur() ? ZT.cur().title : null')


try:
    music()
    procs.append(subprocess.Popen([sys.executable, FAKE_PY, str(FAKE)]))
    until(lambda: get(f'http://127.0.0.1:{FAKE}/_state'))
    PC = start('pc', P_PC, L_PC, pc_only=True)
    PH = start('phone', P_PH, L_PH)
    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-proxy-server', '--autoplay-policy=no-user-gesture-required'])
        pc = page(br, 'pc', PC)
        ph = page(br, 'phone', PH, phone=True)
        check(pc.evaluate("!document.querySelector('[data-legacy=btnDevices]')"), 'PC 2.5: «Dispositivos» ya no está en la barra del reproductor')
        # (the phone's WiFi link waits: first «Seguir donde lo dejaste» through Drive alone)
        ph.evaluate("NowSync.setOpt('link', false)")
        sign_in(pc, 'PC')
        sign_in(ph, 'Móvil')
        pc_dev = pc.evaluate('Journal.dev()')
        ph_dev = ph.evaluate('Journal.dev()')
        check(pc_dev and ph_dev and pc_dev != ph_dev, f'cada aparato tiene su id ({pc_dev}, {ph_dev})')

        # a playlist on the PC, synced to the phone through Drive
        pc.evaluate("""(() => { const ts = Mix.tracks().filter(t => t.artist === 'Luna Norte' || t.artist === 'Los Vatios');
            const id = Mix.pl.create('Viaje', ts); return id; })()""")
        pc.wait_for_timeout(500)
        sync(pc); sync(ph)
        check(ph.evaluate("Mix.playlists().some(p => p.name === 'Viaje')"), 'la playlist «Viaje» llega al móvil por Drive')

        # 1. the PC plays «Corriente» in «Viaje», repeat one, at 1:13, and pauses
        pc.evaluate("""(() => { const p = Mix.playlists().find(p => p.name === 'Viaje'); const t = Mix.tracks().find(t => t.title === 'Corriente');
            Mix.playPlaylist(p.id, t.id); })()""")
        pc.wait_for_function("ZT.isPlaying() && ZT.cur().title === 'Corriente'", timeout=10000)
        pc.evaluate("Mix.repeat('one')")
        check(bool(until(lambda: pc.evaluate("Mix.seek(73), ZT.position() > 72"), 10, 1)), 'PC: en 1:13')
        # (the first write while playing goes at once; then at most one every 25 s)
        n1 = until(lambda: (lambda n: n if n and n['s'].get('title') == 'Corriente' else None)(drive_json(pc, f'now-{pc_dev}.json')), 12)
        if os.environ.get('HAND_DEBUG'): print('n1', json.dumps(n1)[:300])
        check(bool(n1) and n1.get('s', {}).get('title') == 'Corriente' and n1['s'].get('playing') is True, 'PC: escribe en Drive dónde está mientras suena')
        pc.evaluate('Mix.pause()')
        pc.wait_for_timeout(6000)
        n2 = drive_json(pc, f'now-{pc_dev}.json')
        s2 = (n2 or {}).get('s', {})
        check(s2.get('playing') is False and 72 <= s2.get('t', 0) <= 81, f'PC: al pausar lo guarda al momento (t={s2.get("t")})')
        check(s2.get('ctx', {}).get('type') == 'list' and s2.get('modes', {}).get('repeat') == 'one', 'PC: guarda el contexto (playlist) y el repetir')
        check((n2 or {}).get('name') and (n2 or {}).get('platform') == 'pc' and (n2 or {}).get('view', {}).get('id'), 'PC: guarda el aparato y la vista abierta')
        # nothing changes → no writes
        v_before = [f for f in json.loads(get(f'http://127.0.0.1:{FAKE}/_state'))['files'] if f['name'] == f'now-{pc_dev}.json'][0]['version']
        pc.wait_for_timeout(11000)
        v_after = [f for f in json.loads(get(f'http://127.0.0.1:{FAKE}/_state'))['files'] if f['name'] == f'now-{pc_dev}.json'][0]['version']
        check(v_before == v_after, 'PC: en pausa y sin cambios no vuelve a escribir')

        dev = until(lambda: (lambda d: d if d and d.get('lan', {}).get('key') else None)(drive_json(pc, f'device-{pc_dev}.json')), 15)
        lan = (dev or {}).get('lan', {})
        check(lan.get('ips') == ['127.0.0.1'] and lan.get('port') == L_PC and re.fullmatch(r'[0-9a-f]{64}', lan.get('key', '')),
              'PC: publica en su device-<id>.json la IP, el puerto y la clave de emparejamiento')

        # 2. the phone opens (comes back to the front): the card
        ph.evaluate('NowSync.look(true)')
        try:
            ph.wait_for_selector('#nowCard.on', timeout=10000)
        except Exception:
            print('DIAG2', ph.evaluate("(() => { try { NowSync.offer(); return window._why + ' ' + (document.querySelector('#nowCard')?.className) } catch (e) { return String(e.stack) } })()"), errors['phone'])
            print('DIAG', ph.evaluate("({ others: NowSync.others(), mine: ZT.nowState() && ZT.nowState().title, local: localStorage.getItem('zt.nowLocal'), no: localStorage.getItem('zt.nowNo') })"))
            raise
        txt = ph.inner_text('#nowCard')
        check('Seguir donde lo dejaste en' in txt and 'Corriente' in txt and '1:1' in txt, f'móvil: tarjeta «Seguir donde lo dejaste» ({txt!r})')
        ph.wait_for_timeout(400)
        ph.screenshot(path=f'{OUT}/1-movil-seguir.png')
        ph.click('#nowCard [data-nc=go]')
        ph.wait_for_function("ZT.cur() && ZT.cur().title === 'Corriente'", timeout=10000)
        ph.wait_for_timeout(1200)
        st = ph.evaluate("({ t: ZT.position(), ctx: Mix.context(), rep: ZT.modes().repeat, on: document.querySelector('#nowCard')?.classList.contains('on') })")
        check(abs(st['t'] - s2.get('t', 0)) < 3, f'móvil: sigue en el segundo correcto ({st["t"]:.1f} / {s2.get("t")})')
        check(st['ctx'].get('type') == 'list' and st['ctx'].get('name') == 'Viaje', f'móvil: con la misma playlist ({st["ctx"]})')
        check(st['rep'] == 'one', 'móvil: con el mismo repetir')
        check(not st['on'], 'móvil: la tarjeta se va')
        ph.screenshot(path=f'{OUT}/2-movil-siguiendo.png')

        # 3. the phone pairs by itself with the address the PC published
        check(ph.evaluate('Sync.pcInfo()') is None, 'móvil: sin la opción, no se empareja')
        ph.evaluate("NowSync.setOpt('link', true)")
        ph.evaluate('NowSync.devices(true)')
        info = until(lambda: ph.evaluate('Sync.pcInfo()'), 15)
        check(bool(info) and info.get('dev') == pc_dev and info.get('port') == L_PC, f'móvil: emparejado solo, sin QR ({info})')
        lanst = json.loads(get(f'http://127.0.0.1:{P_PC}/api/lan'))
        check(any(d['name'] == 'Pixel de Lluc' for d in lanst['devices']) and lanst.get('linked') is True, 'PC: el móvil sale entre los emparejados')

        # 4. «Otros aparatos» on the phone: the PC, online over WiFi; remote control
        ph.evaluate('Mix.pause()')
        pc.evaluate("(() => { const t = Mix.tracks().find(t => t.title === 'Bajamar'); Mix.playPlaylist(Mix.playlists().find(p => p.name === 'Viaje').id, t.id); })()")
        pc.wait_for_function("ZT.isPlaying() && ZT.cur().title === 'Bajamar'", timeout=10000)
        ph.evaluate('OtherDevices.open()')
        try:
            ph.wait_for_function("document.querySelector('#othersPanel .dot.on')", timeout=20000)
        except Exception:
            print('DIAG phone', ph.evaluate("({ hoOn: Sync.hoOn(), link: NowSync.linkOn(), paired: Sync.ho.paired(), online: Sync.ho.online(), other: !!Sync.ho.other(), html: document.querySelector('#othersPanel').innerText.slice(0, 400) })"))
            print('DIAG pc', pc.evaluate("({ hoOn: Sync.hoOn(), link: NowSync.linkOn(), paired: Sync.ho.paired(), online: Sync.ho.online(), other: !!Sync.ho.other() })"))
            raise
        ph.wait_for_function("document.querySelector('#othersPanel').innerText.includes('Bajamar')", timeout=10000)
        check('Conectado por WiFi' in ph.inner_text('#othersPanel'), 'móvil: «Otros aparatos» ve el PC conectado por WiFi y lo que suena')
        ph.screenshot(path=f'{OUT}/3-movil-otros-aparatos.png')
        ph.click('#othersPanel [data-od=toggle]')
        check(bool(until(lambda: not pc.evaluate('ZT.isPlaying()'), 8)), 'móvil → PC: pausa')
        ph.click('#othersPanel [data-od=toggle]')
        check(bool(until(lambda: pc.evaluate('ZT.isPlaying()'), 8)), 'móvil → PC: play')
        before = track_title(pc)
        ph.click('#othersPanel [data-od=next]')
        check(bool(until(lambda: track_title(pc) != before, 8)), f'móvil → PC: siguiente ({before} → {track_title(pc)})')
        ph.evaluate("(() => { const r = document.querySelector('#othersPanel [data-odvol]'); r.value = '0.3'; r.dispatchEvent(new Event('change', { bubbles: true })); })()")
        check(bool(until(lambda: abs(pc.evaluate('ZT.volume()') - 0.3) < 0.02, 8)), 'móvil → PC: volumen')
        ph.fill('#othersPanel .od-find input', 'chispa')
        ph.press('#othersPanel .od-find input', 'Enter')
        check(bool(until(lambda: track_title(pc) == 'Chispa' and pc.evaluate('ZT.isPlaying()'), 8)), 'móvil → PC: buscar y poner una canción')

        # 5. moving the music: PC → phone («Pasar aquí»), phone → PC («Mandar a…»)
        until(lambda: pc.evaluate('ZT.position() > 1'), 8)  # (loaded and going: then the seek holds)
        check(bool(until(lambda: pc.evaluate("Mix.seek(40), ZT.position() > 39"), 10, 1)), 'PC: en 0:40')
        ph.wait_for_timeout(1500)
        ph.wait_for_selector('#othersPanel [data-od=wifi-here]', timeout=8000)
        ph.click('#othersPanel [data-od=wifi-here]')
        ok = until(lambda: ph.evaluate("ZT.isPlaying() && ZT.cur().title === 'Chispa' && ZT.position() > 38") and not pc.evaluate('ZT.isPlaying()'), 10)
        check(bool(ok), 'PC → móvil: «Pasar aquí» (sigue en el móvil, el PC se pausa)')
        if not ok: print('DIAG', ph.evaluate("({ t: ZT.cur()?.title, p: ZT.position(), on: ZT.isPlaying() })"), pc.evaluate("({ t: ZT.cur()?.title, p: ZT.position(), on: ZT.isPlaying() })"))
        ph.evaluate("(() => { const t = Mix.tracks().find(t => t.title === 'Faro azul'); Mix.playTrack(t); })()")
        ph.wait_for_function("ZT.isPlaying() && ZT.cur().title === 'Faro azul'", timeout=8000)
        until(lambda: ph.evaluate('ZT.position() > 1'), 8)
        check(bool(until(lambda: ph.evaluate("Mix.seek(25), ZT.position() > 24"), 10, 1)), 'móvil: en 0:25')
        ph.wait_for_timeout(1500)
        ph.click('#othersPanel [data-od=send]')
        ok = until(lambda: pc.evaluate("ZT.isPlaying() && ZT.cur().title === 'Faro azul' && ZT.position() > 23") and not ph.evaluate('ZT.isPlaying()'), 10)
        check(bool(ok), 'móvil → PC: «Mandar a…» (suena en el PC, el móvil se pausa)')
        if not ok: print('DIAG', ph.evaluate("({ t: ZT.cur()?.title, p: ZT.position(), on: ZT.isPlaying() })"), pc.evaluate("({ t: ZT.cur()?.title, p: ZT.position(), on: ZT.isPlaying() })"))
        ph.evaluate('OtherDevices.close()')

        # from the PC: «Otros aparatos» (from the menu on the left) sees the phone and brings its music
        ph.evaluate("(() => { const t = Mix.tracks().find(t => t.title === 'Cortocircuito'); Mix.playTrack(t); })()")
        ph.wait_for_function("ZT.isPlaying() && ZT.cur().title === 'Cortocircuito'", timeout=8000)
        pc.evaluate('NowSync.devices(true)')
        check(bool(pc.wait_for_selector('.pc-side [data-others]:not([hidden])', timeout=10000)), 'PC 2.5: «Otros aparatos» en el menú de la izquierda')
        pc.click('.pc-side [data-others]')
        pc.wait_for_function("document.querySelector('#othersPanel.on') && document.querySelector('#othersPanel').innerText.includes('Cortocircuito')", timeout=15000)
        pc.wait_for_timeout(500)
        pc.screenshot(path=f'{OUT}/4-pc-otros-aparatos.png')
        pc.click('#othersPanel [data-od=wifi-here]')
        ok = until(lambda: pc.evaluate("ZT.isPlaying() && ZT.cur().title === 'Cortocircuito'") and not ph.evaluate('ZT.isPlaying()'), 10)
        check(bool(ok), 'móvil → PC: «Pasar aquí» desde el PC')
        pc.evaluate('OtherDevices.close()')

        # 6. a song the phone hasn't got: «Buscar en YouTube»
        pc.evaluate("(() => { const t = Mix.tracks().find(t => t.title === 'Solo en el PC'); Mix.playTrack(t); })()")
        pc.wait_for_function("ZT.isPlaying() && ZT.cur().title === 'Solo en el PC'", timeout=8000)
        pc.wait_for_timeout(1500)
        pc.evaluate('Mix.pause()')
        pc.wait_for_timeout(6000)
        ph.evaluate("localStorage.setItem('zt.nowLocal', '0')")
        ph.evaluate('NowSync.look(true)')
        ph.wait_for_function("document.querySelector('#nowCard.on') && document.querySelector('#nowCard').innerText.includes('Solo en el PC')", timeout=10000)
        txt = ph.inner_text('#nowCard')
        check('no está en este aparato' in txt and ph.is_visible('#nowCard [data-nc=yt]'), 'móvil: canción que no tiene → avisa y ofrece buscarla en YouTube')
        ph.screenshot(path=f'{OUT}/5-movil-no-esta.png')
        ph.click('#nowCard [data-nc=no]')
        check(not ph.evaluate("document.querySelector('#nowCard').classList.contains('on')"), 'móvil: «Ahora no» la quita')
        ph.evaluate('NowSync.look(true)')
        ph.wait_for_timeout(800)
        check(not ph.evaluate("document.querySelector('#nowCard').classList.contains('on')"), 'móvil: y no vuelve a salir para lo mismo')

        # 7. Legacy: the sheet from Ajustes → Plugins → Sincronización
        pc.evaluate("Mix.setDesign('legacy')")
        pc.wait_for_timeout(800)
        pc.evaluate("() => { if (!document.getElementById('settings').classList.contains('open')) document.getElementById('btnSettings').click(); }")
        pc.wait_for_timeout(400)
        pc.evaluate("PluginsUI.open('gdrive')")
        pc.wait_for_selector('[data-gd=others]', timeout=8000)
        txt = pc.inner_text('.gdp')
        check('Seguir donde lo dejaste' in txt and 'Conectar solos por WiFi' in txt, 'Legacy: las opciones en Sincronización')
        pc.screenshot(path=f'{OUT}/6-legacy-opciones.png', full_page=True)
        pc.click('[data-gd=others]')
        pc.wait_for_selector('#othersPanel.on', timeout=5000)
        pc.wait_for_timeout(600)
        pc.screenshot(path=f'{OUT}/7-legacy-otros-aparatos.png')
        pc.evaluate('OtherDevices.close()')
        pc.evaluate("PluginsUI.close()")

        # 8. Desconectar: the address and the key out of Drive, the key dropped
        key_before = lan.get('key')
        ph_info_before = ph.evaluate('Sync.pcInfo()')
        pc.evaluate('GoogleAcct.disconnect(false)')
        pc.wait_for_function('!GoogleAcct.connected()', timeout=10000)
        d2 = drive_json(ph, f'device-{pc_dev}.json')
        check(d2 is not None and 'lan' not in d2, 'Desconectar: la IP y la clave salen del Drive')
        lanst = json.loads(get(f'http://127.0.0.1:{P_PC}/api/lan'))
        check(lanst.get('linked') is False, 'Desconectar: el PC tira la clave')
        r = ph.evaluate(f"""fetch('http://127.0.0.1:{L_PC}/lan/pair', {{ method: 'POST', body: JSON.stringify({{ key: '{key_before}', name: 'Otro' }}) }}).then(r => r.status).catch(() => 0)""")
        check(r == 403, f'la clave vieja ya no empareja ({r})')

        pc.wait_for_timeout(500)
        for n in ('pc', 'phone'):
            check(not errors[n], f'{n}: sin errores en la consola {errors[n][:5]}')
        br.close()
finally:
    for p in procs:
        p.terminate()
    for p in procs:
        try:
            p.wait(5)
        except Exception:
            p.kill()

print(f'\n{len(fails)} fallos' if fails else '\nTodo bien', flush=True)
sys.exit(1 if fails else 0)
