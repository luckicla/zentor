#!/usr/bin/env python3
"""MixUp ↔ Google Drive end to end, with no internet: two MixUps (A and B, as
if they were the PC and the phone) and a fake Google (fake_google.py).

    go build -o /tmp/mixup-google . && python3 tools/googletest/e2e.py

Signs both in with the code, syncs playlists / likes / YouTube songs both
ways (also changes on both sides at once), disconnects one, takes Google away
(offline) and back without its tokens (signed out). Screenshots in /tmp/gshots.
"""
import json, os, shutil, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.environ.get('BIN', '/tmp/mixup-google')
SHOTS = '/tmp/gshots'
FAKE = 47990
procs, fails = [], []
os.makedirs(SHOTS, exist_ok=True)


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


def start_mixup(tag, port, client=True):
    for d in (f'/tmp/h-g{tag}', f'/tmp/m-g{tag}'):
        shutil.rmtree(d, ignore_errors=True)
    os.makedirs(f'/tmp/m-g{tag}/.zentor', exist_ok=True)
    if client:
        open(f'/tmp/m-g{tag}/.zentor/google-client.json', 'w').write('{"client_id":"cid","client_secret":"csec"}')
    env = dict(os.environ, MIXUP_ADDR=f'127.0.0.1:{port}', HOME=f'/tmp/h-g{tag}', MIXUP_GOOGLE_BASE=f'http://127.0.0.1:{FAKE}')
    p = subprocess.Popen([BIN, '-root', f'/tmp/m-g{tag}', '-headless'], env=env, stdout=open(f'/tmp/mixup-g{tag}.log', 'w'), stderr=subprocess.STDOUT)
    procs.append(p)
    until(lambda: get(f'http://127.0.0.1:{port}/api/version'))
    return f'http://127.0.0.1:{port}/'


def fake_state():
    return json.loads(get(f'http://127.0.0.1:{FAKE}/_state') or '{}')


errors = {}


def open_page(browser, name, url, w=1280, h=820):
    ctx = browser.new_context(viewport={'width': w, 'height': h}, locale='es-ES')
    pg = ctx.new_page()
    errors[name] = []
    pg.on('console', lambda m: m.type == 'error' and errors[name].append(m.text))
    pg.on('pageerror', lambda e: errors[name].append('pageerror: ' + str(e)))
    pg.goto(url)
    pg.wait_for_function('typeof ZT !== "undefined" && typeof GoogleAcct !== "undefined"')
    pg.wait_for_timeout(1200)
    return pg


def show_connect(pg):
    pg.evaluate('ZT.openConnect()')
    pg.wait_for_timeout(600)
    # (while «Conectar» belongs to the WiFi plugin's page in this base: open that page)
    if not pg.is_visible('#gDriveCard'):
        pg.evaluate("PluginsUI.open('pclink')")
        pg.wait_for_timeout(400)
    pg.wait_for_selector('#gDriveCard', state='visible')


def sign_in(pg, name):
    show_connect(pg)
    pg.screenshot(path=f'{SHOTS}/{name}-1-sin-conectar.png')
    pg.click('#gDriveCard [data-g=connect]')
    pg.wait_for_selector('.gd-uc b', state='visible')
    code = pg.inner_text('.gd-uc b')
    ok(code.startswith('MXUP-'), f'{name}: shows the code {code}')
    pg.screenshot(path=f'{SHOTS}/{name}-2-codigo.png')
    pg.wait_for_selector('.gd-mail', timeout=20000)
    ok('lluc@example.com' in pg.inner_text('#gAcctCard'), f'{name}: connected as lluc@example.com')


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
    A = start_mixup('A', 47961)
    B = start_mixup('B', 47962)
    C = start_mixup('C', 47963, client=False)
    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-proxy-server'])

        # not set up: says so, nothing breaks
        pc = open_page(br, 'C', C)
        show_connect(pc)
        ok('Todavía no está disponible' in pc.inner_text('#gAcctCard'), 'C (no client): «not set up yet»')
        ok(not pc.is_visible('#gDriveCard [data-g=connect]'), 'C: no connect button')
        pc.screenshot(path=f'{SHOTS}/C-sin-configurar.png')
        pm = open_page(br, 'Cm', C, 390, 844)
        show_connect(pm)
        pm.screenshot(path=f'{SHOTS}/C-movil-sin-configurar.png')
        pm.close(); pc.close()

        pa = open_page(br, 'A', A)
        sign_in(pa, 'A')
        until(lambda: 'Sincronizado' in pa.evaluate('DriveSync.statusText()'), 20)
        ok('Sincronizado' in pa.evaluate('DriveSync.statusText()'), 'A: first sync by itself after connecting')
        pa.screenshot(path=f'{SHOTS}/A-3-conectado.png')

        # A: a YouTube song, a playlist with it, a like
        pa.evaluate('''async () => { YouTube.save([{ v: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', artist: 'Rick Astley', added: Date.now() }]);
          await ZT.reload(); Playlists.create('Para correr', ['yt-dQw4w9WgXcQ']); Playlists.toggleLike('yt-dQw4w9WgXcQ'); }''')
        pa.wait_for_timeout(800)
        st = sync(pa)
        ok(st.startswith('Sincronizado'), 'A: synced: ' + st)
        fs = fake_state()['files']
        folder = [f for f in fs if f['name'] == 'MixUp' and f['parent'] == 'root']
        ok(len(folder) == 1, 'Drive: one MixUp folder')
        names = sorted(f['name'] for f in fs if folder and f['parent'] == folder[0]['id'])
        ok('state.json' in names and 'journal.json' in names, 'Drive: state.json and journal.json in MixUp: ' + str(names))

        pb = open_page(br, 'B', B)
        sign_in(pb, 'B')
        until(lambda: any(l[0] == 'Para correr' for l in state(pb)['lists']), 20)
        sb = state(pb)
        ok(['Para correr', ['yt-dQw4w9WgXcQ']] in sb['lists'], 'B: got the playlist with the YouTube song: ' + str(sb['lists']))
        ok(sb['liked'] == ['yt-dQw4w9WgXcQ'], 'B: got the like')
        ok('yt-dQw4w9WgXcQ' in sb['yt'], 'B: got the YouTube song in its library')

        # changes on both sides at once
        pb.evaluate('''async () => { YouTube.save([{ v: 'kJQP7kiw5Fk', title: 'Despacito', artist: 'Luis Fonsi', added: Date.now() }]);
          await ZT.reload(); const l = Playlists.lists().find(l => l.name === 'Para correr'); Playlists.add(l.id, ['yt-kJQP7kiw5Fk']); Playlists.toggleLike('yt-dQw4w9WgXcQ'); }''')
        pa.evaluate('''() => { const l = Playlists.lists().find(l => l.name === 'Para correr'); Playlists.rename(l.id, 'Correr'); Playlists.create('Chill', ['yt-dQw4w9WgXcQ']); }''')
        pa.wait_for_timeout(600)
        # both at the same time (one of them finds the other's write: conflict, reads again)
        pa.evaluate('DriveSync.run(false)'); pb.evaluate('DriveSync.run(false)')
        for pg in (pa, pb):
            pg.wait_for_function('!DriveSync.busy()', timeout=30000)
        sync(pa); sync(pb); sync(pa)
        sa, sb = state(pa), state(pb)
        want = [['Chill', ['yt-dQw4w9WgXcQ']], ['Correr', ['yt-dQw4w9WgXcQ', 'yt-kJQP7kiw5Fk']]]
        ok(sa['lists'] == want, 'A: merged both sides: ' + str(sa['lists']))
        ok(sb['lists'] == want, 'B: merged both sides: ' + str(sb['lists']))
        ok(sa['liked'] == [] and sb['liked'] == [], 'the unlike on B reached A')
        ok(sa['yt'] == sb['yt'] == ['yt-dQw4w9WgXcQ', 'yt-kJQP7kiw5Fk'], 'same YouTube library on both')

        # a change syncs by itself a few seconds later
        pa.evaluate("Playlists.create('Sola', [])")
        until(lambda: pa.evaluate("JSON.parse(localStorage.getItem('zt.gdBase')||'{}').lists?.some(l => l.name === 'Sola')"), 25, 0.5)
        ok(pa.evaluate("JSON.parse(localStorage.getItem('zt.gdBase')||'{}').lists?.some(l => l.name === 'Sola')"), 'A: a new playlist went up by itself (debounced)')

        # mobile size
        pm = open_page(br, 'Bm', B, 390, 844)
        show_connect(pm)
        pm.screenshot(path=f'{SHOTS}/B-movil-conectado.png', full_page=False)
        pm.evaluate("document.querySelector('#gAcctCard').scrollIntoView()")
        pm.screenshot(path=f'{SHOTS}/B-movil-cuenta.png')
        pm.close()

        # B disconnects: revoked at Google, token file gone, the playlists stay
        show_connect(pb)
        pb.click('#gAcctCard [data-g=disconnect]')
        pb.wait_for_timeout(400)
        pb.screenshot(path=f'{SHOTS}/B-4-confirmar.png')
        pb.locator('button', has_text='Desconectar').last.click()
        pb.wait_for_selector('#gAcctCard [data-g=connect]', timeout=8000)
        ok(len(fake_state()['revoked']) == 1, 'B: token revoked at Google')
        ok(not os.path.exists('/tmp/m-gB/.zentor/google-token.json'), 'B: token file deleted')
        ok(state(pb)['lists'] == want, 'B: playlists still there after disconnecting')
        pb.screenshot(path=f'{SHOTS}/B-5-desconectado.png')

        # Google unreachable: A says so, keeps everything
        procs[0].terminate(); procs[0].wait()
        st = sync(pa)
        ok('Sin conexión' in st, 'A offline: ' + st)
        ok(state(pa)['lists'][:2] == want, 'A offline: nothing lost')
        pa.screenshot(path=f'{SHOTS}/A-6-sin-conexion.png')
        # Google back, but without A's tokens (revoked elsewhere): signed out, data kept
        procs[0] = start_fake()
        sync(pa)
        pa.evaluate('GoogleAcct.refresh()')
        pa.wait_for_selector('#gAcctCard [data-g=connect]', timeout=8000)
        ok(state(pa)['lists'][:2] == want, 'A signed out by Google: nothing lost')

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
