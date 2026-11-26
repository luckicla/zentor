#!/usr/bin/env python3
"""MixUp ↔ Google Drive end to end, with no internet: MixUps (A and B, as if
they were the PC and the phone, and more for other cases) and a fake Google
(fake_google.py).

    go build -o /tmp/mixup-google . && python3 tools/googletest/e2e.py

- C: no OAuth client configured → «not available yet», nothing breaks
- D: a new install → the welcome steps, connecting from there
- E: someone updating MixUp → no welcome, «Dispositivos» out of the bar, the plugin on
- A, B: sign in with the code, profile; playlists (and their pictures), likes,
  YouTube songs, settings, deletions, both ways and both at once; devices;
  disconnect; Google unreachable; signed out by Google
Screenshots in /tmp/gshots.
"""
import json, os, shutil, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.environ.get('BIN', '/tmp/mixup-google')
SHOTS = '/tmp/gshots'
FAKE = 47990
procs, fails = [], []
shutil.rmtree(SHOTS, ignore_errors=True)
os.makedirs(SHOTS, exist_ok=True)
PNG = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000020000000208020000'
                    '00fdd49a730000001649444154789c63fccf00030c0c0c0c0c0c0c00000d1d0103'
                    '6ac29be90000000049454e44ae426082')


def ok(cond, what):
    print(('ok: ' if cond else 'FAIL: ') + what, flush=True)
    if not cond:
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


def start_fake():
    p = subprocess.Popen([sys.executable, os.path.join(HERE, 'fake_google.py'), str(FAKE)])
    procs.append(p)
    until(lambda: get(f'http://127.0.0.1:{FAKE}/_state'))
    return p


def start_mixup(tag, port, client='file', settings=None):
    for d in (f'/tmp/h-g{tag}', f'/tmp/m-g{tag}'):
        shutil.rmtree(d, ignore_errors=True)
    os.makedirs(f'/tmp/m-g{tag}/.zentor', exist_ok=True)
    # 'file': google-client.json (another client, the override); 'env': MixUp's own client id
    # with the secret from MIXUP_GOOGLE_CLIENT_SECRET (as a build with the secret); False: none
    if client == 'file':
        open(f'/tmp/m-g{tag}/.zentor/google-client.json', 'w').write('{"client_id":"cid","client_secret":"csec"}')
    if settings:
        open(f'/tmp/m-g{tag}/.zentor/settings.json', 'w').write(json.dumps(settings))
    env = dict(os.environ, MIXUP_ADDR=f'127.0.0.1:{port}', HOME=f'/tmp/h-g{tag}', MIXUP_GOOGLE_BASE=f'http://127.0.0.1:{FAKE}')
    env.pop('MIXUP_GOOGLE_CLIENT_SECRET', None)
    if client == 'env':
        env['MIXUP_GOOGLE_CLIENT_SECRET'] = 'csec'  # (a dummy secret: the fake Google's)
    p = subprocess.Popen([BIN, '-root', f'/tmp/m-g{tag}', '-headless'], env=env, stdout=open(f'/tmp/mixup-g{tag}.log', 'w'), stderr=subprocess.STDOUT)
    procs.append(p)
    until(lambda: get(f'http://127.0.0.1:{port}/api/version'))
    return f'http://127.0.0.1:{port}/'


def fake_state():
    return json.loads(get(f'http://127.0.0.1:{FAKE}/_state') or '{}')


errors = {}


def open_page(browser, name, url, w=1280, h=820, intro_seen=True):
    ctx = browser.new_context(viewport={'width': w, 'height': h}, locale='es-ES')
    if intro_seen:
        ctx.add_init_script("try { localStorage.setItem('zt.intro', '1') } catch {}")
    pg = ctx.new_page()
    errors[name] = []
    pg.on('console', lambda m: m.type == 'error' and errors[name].append(m.text))
    pg.on('pageerror', lambda e: errors[name].append('pageerror: ' + str(e) + ' ' + str(getattr(e, 'stack', ''))[:600]))
    pg.goto(url)
    pg.wait_for_function('typeof ZT !== "undefined" && typeof GoogleAcct !== "undefined" && GoogleAcct.known()')
    pg.wait_for_timeout(1200)
    return pg


def show_plugin(pg):
    pg.evaluate("() => { if (!document.getElementById('settings').classList.contains('open')) document.getElementById('btnSettings').click(); }")
    pg.wait_for_timeout(400)
    pg.evaluate("PluginsUI.open('gdrive')")
    pg.wait_for_selector('.gdp-acct', state='visible')
    pg.wait_for_timeout(300)


def show_connect(pg):
    pg.evaluate("PluginsUI.close()")
    pg.evaluate('ZT.openConnect()')
    pg.wait_for_timeout(600)
    if not pg.is_visible('#gdSlotCard'):  # (while «Conectar» is the WiFi plugin's page in this base)
        pg.evaluate("PluginsUI.open('pclink')")
        pg.wait_for_timeout(400)


def sign_in(pg, name):
    show_plugin(pg)
    pg.screenshot(path=f'{SHOTS}/{name}-1-sin-conectar.png')
    pg.click('.gdp-acct [data-ga=connect]')
    pg.wait_for_selector('.ga-uc b', state='visible')
    code = pg.inner_text('.ga-uc b')
    ok(code.startswith('MXUP-'), f'{name}: shows the code {code}')
    ok(pg.is_visible('.gdp-acct .ga-qr svg') and pg.is_visible('.gdp-acct [data-ga=copy]') and pg.is_visible('.gdp-acct [data-ga=open]'),
       f'{name}: QR of google.com/device, «Copiar el código» and «Abrir google.com/device»')
    pg.screenshot(path=f'{SHOTS}/{name}-2-codigo.png')
    pg.wait_for_selector('.gdp-acct .ga-mail', timeout=20000)
    txt = pg.inner_text('.gdp-acct')
    ok('lluc@example.com' in txt and 'Lluc' in txt, f'{name}: connected, name and e-mail shown')
    pg.wait_for_timeout(500)
    ok(pg.evaluate("(() => { const i = document.querySelector('.gdp-acct .ga-av img'); return !!i && i.complete && i.naturalWidth > 0 })()"), f'{name}: profile photo shown (from our server)')


def sync(pg):
    pg.evaluate('DriveSync.run(true)')
    pg.wait_for_function('!DriveSync.busy()', timeout=30000)
    pg.wait_for_timeout(300)
    return pg.evaluate('DriveSync.statusText()')


def state(pg):
    return pg.evaluate('''() => { const P = Playlists.raw();
      return { lists: P.lists.map(l => [l.name, l.tracks.slice().sort()]).sort(), liked: P.liked.slice().sort(), yt: YouTube.tracks().map(t => t.id).sort() }; }''')


try:
    start_fake()
    A = start_mixup('A', 47961, client='env')
    B = start_mixup('B', 47962)
    C = start_mixup('C', 47963, client=False)
    D = start_mixup('D', 47964)
    E = start_mixup('E', 47965, settings={'theme': 'synth', 'dj': True})
    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-proxy-server'])

        # C: not set up
        pc = open_page(br, 'C', C)
        show_plugin(pc)
        ok('Todavía no está disponible' in pc.inner_text('.gdp-acct'), 'C (no client): «not set up yet»')
        ok(not pc.is_visible('[data-ga=connect]'), 'C: no connect button')
        pc.screenshot(path=f'{SHOTS}/C-sin-configurar.png')
        pc.close()

        # E: updating user
        pe = open_page(br, 'E', E, intro_seen=False)
        pe.wait_for_timeout(2500)
        ok(not pe.is_visible('.intro'), 'E (updating): no welcome steps')
        ok(not pe.is_visible('#btnDevices'), 'E: «Dispositivos» not in the main bar')
        ok(pe.evaluate("Plugins.enabled('gdrive') && Plugins.enabled('pclink')"), 'E: Sincronización on (legacy), WiFi plugin still on')
        show_connect(pe)
        ok(pe.is_visible('#gdSlotCard') and 'recomendado' in pe.inner_text('#gdSlotCard').lower(), 'E: Conectar recommends Google Drive')
        pe.screenshot(path=f'{SHOTS}/E-conectar.png')
        pe.close()

        # D: new install → welcome steps, connect from there
        pd = open_page(br, 'D', D, intro_seen=False)
        pd.wait_for_selector('.intro.on', timeout=8000)
        ok(True, 'D (new install): welcome steps shown')
        ok(pd.evaluate("Plugins.enabled('gdrive')"), 'D: Sincronización on (starter)')
        pd.screenshot(path=f'{SHOTS}/D-intro-1.png')
        pd.click('[data-in=next]'); pd.wait_for_timeout(250)
        pd.screenshot(path=f'{SHOTS}/D-intro-2.png')
        pd.click('[data-in=next]'); pd.wait_for_timeout(250)
        pd.screenshot(path=f'{SHOTS}/D-intro-3.png')
        # (2.5: there's a «Elige tu diseño» step before the sync one)
        for _ in range(4):
            if pd.is_visible('[data-in=connect]'): break
            pd.click('[data-in=next]'); pd.wait_for_timeout(250)
        pd.click('[data-in=connect]')
        pd.wait_for_selector('.intro .ga-uc b', timeout=8000)
        pd.screenshot(path=f'{SHOTS}/D-intro-4-codigo.png')
        pd.wait_for_selector('.intro [data-in=done].pill', timeout=20000)
        ok('Listo' in pd.inner_text('.intro'), 'D: connected from the welcome steps')
        pd.wait_for_timeout(400)
        pd.screenshot(path=f'{SHOTS}/D-intro-5-listo.png')
        pd.click('[data-in=done]')
        pd.wait_for_timeout(500)
        ok(not pd.is_visible('.intro'), 'D: welcome closed')
        pd.reload(); pd.wait_for_timeout(2500)
        ok(not pd.is_visible('.intro'), 'D: not shown again')
        pm = br.new_context(viewport={'width': 390, 'height': 844}, locale='es-ES').new_page()
        pm.goto(D); pm.wait_for_function('typeof Intro !== "undefined"'); pm.wait_for_timeout(1500)
        pm.evaluate('Intro.open()'); pm.wait_for_timeout(400)
        pm.screenshot(path=f'{SHOTS}/D-movil-intro.png')
        pm.close()
        # (D's account is the same fake account: disconnect so it doesn't sync with A/B below)
        pd.evaluate('DriveSync.stop()'); pd.evaluate('GoogleAcct.disconnect(false)'); pd.wait_for_timeout(500); pd.close()

        pa = open_page(br, 'A', A)
        sign_in(pa, 'A')
        ok(fake_state().get('scope') == 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.file',
           'A: asks Google for exactly the four scopes (secret from the environment)')
        until(lambda: pa.evaluate('DriveSync.last()') > 0, 20)
        ok(pa.evaluate('DriveSync.last()') > 0, 'A: first sync by itself after connecting')
        ok(pa.evaluate("YTHome.load({ force: true }).then(h => h.mode)") == 'account', 'A: YTHome asks YouTube Music as the account (through our server)')

        # A: a YouTube song, a playlist with it and a picture, a like, a setting
        pa.wait_for_timeout(3000)  # (settings changed in the first seconds don't count as the person's: sync.js)
        pa.evaluate('''async () => { YouTube.save([{ v: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', artist: 'Rick Astley', added: Date.now() }]);
          await ZT.reload(); Playlists.create('Para correr', ['yt-dQw4w9WgXcQ']); Playlists.toggleLike('yt-dQw4w9WgXcQ'); }''')
        pid = pa.evaluate("Playlists.lists().find(l => l.name === 'Para correr').id")
        pa.evaluate('''async ([id, hex]) => { const b = new Uint8Array(hex.match(/../g).map(h => parseInt(h, 16)));
          await fetch('/plcover/' + id, { method: 'PUT', body: new Blob([b], { type: 'image/png' }) }); Playlists.setCover(id, Date.now()); }''', [pid, PNG.hex()])
        pa.evaluate("Settings.set({ eq60: 4 })")
        pa.wait_for_timeout(800)
        st = sync(pa)
        ok(st.startswith('Sincronizado'), 'A: synced: ' + st)
        fs = fake_state()['files']
        folder = [f for f in fs if f['name'] == 'MixUp' and f['parent'] == 'root']
        ok(len(folder) == 1, 'Drive: one MixUp folder')
        names = sorted(f['name'] for f in fs if folder and f['parent'] == folder[0]['id'])
        ok({'state.json', 'journal.json', 'plcover-' + pid}.issubset(names) and any(n.startswith('device-') for n in names), 'Drive: state, journal, the picture and a device file: ' + str(names))

        pb = open_page(br, 'B', B)
        sign_in(pb, 'B')
        until(lambda: any(l[0] == 'Para correr' for l in state(pb)['lists']), 20)
        pb.wait_for_function('!DriveSync.busy()', timeout=30000)
        sb = state(pb)
        ok(['Para correr', ['yt-dQw4w9WgXcQ']] in sb['lists'], 'B: got the playlist with the YouTube song: ' + str(sb['lists']))
        ok(sb['liked'] == ['yt-dQw4w9WgXcQ'], 'B: got the like')
        ok('yt-dQw4w9WgXcQ' in sb['yt'], 'B: got the YouTube song in its library')
        ok(pb.evaluate(f"fetch('/plcover/{pid}').then(r => r.ok)"), 'B: got the playlist picture')
        ok(pb.evaluate("Settings.get().eq60") == 4, 'B: got the settings (first sync takes what is in Drive)')

        # devices and the overview, on A's page
        sync(pa)
        show_plugin(pa)
        pa.wait_for_function("document.querySelectorAll('.gdp-dev').length >= 2", timeout=10000)
        ok(pa.locator('.gdp-dev').count() >= 2 and pa.locator('.gdp-me').count() == 1, 'A: the devices listed (A, B and D: same account), this one marked')
        ok('1' in pa.inner_text('.gdp-stats'), 'A: overview of what is in Drive: ' + pa.inner_text('.gdp-stats').replace('\n', ' '))
        pa.screenshot(path=f'{SHOTS}/A-3-pagina.png')
        pa.evaluate("document.querySelector('.gdp-stats').scrollIntoView()")
        pa.screenshot(path=f'{SHOTS}/A-3b-pagina-abajo.png')
        pa.evaluate("document.querySelector('.gdp-dev').scrollIntoView()")
        pa.screenshot(path=f'{SHOTS}/A-3c-dispositivos.png')

        # changes on both sides at once
        pb.evaluate('''async () => { YouTube.save([{ v: 'kJQP7kiw5Fk', title: 'Despacito', artist: 'Luis Fonsi', added: Date.now() }]);
          await ZT.reload(); const l = Playlists.lists().find(l => l.name === 'Para correr'); Playlists.add(l.id, ['yt-kJQP7kiw5Fk']); Playlists.toggleLike('yt-dQw4w9WgXcQ'); }''')
        pa.evaluate('''() => { const l = Playlists.lists().find(l => l.name === 'Para correr'); Playlists.rename(l.id, 'Correr'); Playlists.create('Chill', ['yt-dQw4w9WgXcQ']); Playlists.create('Para borrar', []); }''')
        pa.wait_for_timeout(600)
        pa.evaluate('DriveSync.run(false)'); pb.evaluate('DriveSync.run(false)')
        for pg in (pa, pb):
            pg.wait_for_function('!DriveSync.busy()', timeout=30000)
        sync(pa); sync(pb); sync(pa)
        sa, sb = state(pa), state(pb)
        want = [['Chill', ['yt-dQw4w9WgXcQ']], ['Correr', ['yt-dQw4w9WgXcQ', 'yt-kJQP7kiw5Fk']], ['Para borrar', []]]
        ok(sa['lists'] == want, 'A: merged both sides: ' + str(sa['lists']))
        ok(sb['lists'] == want, 'B: merged both sides: ' + str(sb['lists']))
        ok(sa['liked'] == [] and sb['liked'] == [], 'the unlike on B reached A')
        ok(sa['yt'] == sb['yt'] == ['yt-dQw4w9WgXcQ', 'yt-kJQP7kiw5Fk'], 'same YouTube library on both')

        # deletions travel: a playlist and a YouTube song removed on B
        pb.evaluate('''() => { Playlists.remove(Playlists.lists().find(l => l.name === 'Para borrar').id); YouTube.remove(['yt-kJQP7kiw5Fk']); }''')
        pb.wait_for_timeout(500)
        sync(pb); sync(pa)
        sa = state(pa)
        ok(not any(l[0] == 'Para borrar' for l in sa['lists']), 'a playlist deleted on B is deleted on A')
        ok('yt-kJQP7kiw5Fk' not in sa['yt'], 'a YouTube song removed on B is removed on A: ' + str(sa['yt']))

        # a change goes up by itself a few seconds later
        pa.evaluate("Playlists.create('Sola', [])")
        until(lambda: pa.evaluate("JSON.parse(localStorage.getItem('zt.gdBase')||'{}').lists?.some(l => l.name === 'Sola')"), 25, 0.5)
        ok(pa.evaluate("JSON.parse(localStorage.getItem('zt.gdBase')||'{}').lists?.some(l => l.name === 'Sola')"), 'A: a new playlist went up by itself (debounced)')
        # nothing new anywhere: the periodic look doesn't rewrite anything
        pa.wait_for_function('!DriveSync.busy()', timeout=30000)
        v0 = [(f['name'], f['version']) for f in fake_state()['files']]
        pa.evaluate('DriveSync.run(false)'); pa.wait_for_function('!DriveSync.busy()', timeout=30000)
        ok([(f['name'], f['version']) for f in fake_state()['files']] == v0, 'A: a periodic look with nothing new writes nothing')

        # mobile size
        pm = open_page(br, 'Bm', B, 390, 844)
        show_plugin(pm)
        pm.screenshot(path=f'{SHOTS}/B-movil-pagina.png')
        show_connect(pm)
        pm.screenshot(path=f'{SHOTS}/B-movil-conectar.png')
        pm.close()

        # B disconnects: revoked at Google, token and photo gone, the playlists stay
        show_plugin(pb)
        pb.click('.gdp-acct [data-ga=disconnect]')
        pb.wait_for_timeout(400)
        pb.locator('button', has_text='Desconectar').last.click()
        pb.wait_for_selector('.gdp-acct [data-ga=connect]', timeout=8000)
        ok(len(fake_state()['revoked']) >= 2, 'B: token revoked at Google')
        ok(not os.path.exists('/tmp/m-gB/.zentor/google-token.json') and not os.path.exists('/tmp/m-gB/.zentor/google-photo'), 'B: token and photo deleted')
        ok(len(state(pb)['lists']) >= 2, 'B: playlists still there after disconnecting')
        pb.screenshot(path=f'{SHOTS}/B-5-desconectado.png')

        # Google unreachable: A says so, keeps everything
        before = state(pa)['lists']
        procs[0].terminate(); procs[0].wait()
        st = sync(pa)
        ok('Sin conexión' in st, 'A offline: ' + st)
        ok(state(pa)['lists'] == before, 'A offline: nothing lost')
        # Google back, but without A's tokens (as if revoked elsewhere): signed out, data kept
        procs[0] = start_fake()
        sync(pa)
        pa.evaluate('GoogleAcct.refresh()')
        pa.wait_for_selector('.gdp-acct [data-ga=connect]', timeout=8000)
        ok(state(pa)['lists'] == before, 'A signed out by Google: nothing lost')

        for n, e in errors.items():
            real = [x for x in e if 'fonts.googleapis' not in x and 'Failed to load resource' not in x and 'net::' not in x]
            ok(not real, f'{n}: no console errors {real[:3]}')
        br.close()
finally:
    for p in procs:
        try:
            p.terminate()
        except Exception:
            pass

print('PASS' if not fails else f'{len(fails)} FAILED')
sys.exit(1 if fails else 0)
