#!/usr/bin/env python3
"""The direct Google sign-in («Iniciar sesión con Google»: loopback + PKCE +
state) end to end, with no internet: MixUps against the fake Google
(fake_google.py), with Playwright as the browser.

    go build -o /tmp/glogin-mixup . && python3 tools/googletest/loopback.py

In test mode (MIXUP_GOOGLE_BASE) MixUp opens no real browser, so the page
opens Google's URL itself (window.open): Playwright gets it as a popup, which
goes to the fake Google, is redirected to MixUp's /api/google/callback and
shows the «you can close this tab» page — the same path as the system browser.

- L (both clients): the button with the official G; click → the waiting
  card («Termina en la ventana de Google…», «Volver a abrir», «Cancelar»,
  «¿No se abre? Usar un código»); the URL (client, redirect, exact scopes,
  S256, state, offline, no prompt); connected; the token marked «desktop»; a
  refresh goes with the desktop client; wrong state refused; the link used
  twice refused; «Cancelar»; denied; «already accepted» → prompt=consent once;
  «¿No se abre? Usar un código» → the code works and refreshes with the TV client
- T (short expiry: MIXUP_GOOGLE_LOGIN_TTL=3): the page says it expired, and the
  late callback is refused
- O (TV only, an account connected with the code before this version): only
  the code button, and the old token refreshes with the TV client
- N (desktop only): the direct button and no «usar un código»
- Screenshots: Legacy and 2.5, 1280x820 and 390x844, plus the intro step.

Ports (MIXUP_PORT_BASE, default 18603): fake Google = base, MixUps base+1…
Output: $LOOPBACK_OUT (default /tmp/glogin-out).
"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.parse
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.environ.get('BIN', '/tmp/glogin-mixup')
OUT = os.environ.get('LOOPBACK_OUT', '/tmp/glogin-out')
BASE = int(os.environ.get('MIXUP_PORT_BASE', '18603'))
FAKE = BASE
TMP = '/tmp/glogin-e2e'
EXACT = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.file'
procs, fails = [], []
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT, exist_ok=True)


def ok(cond, what):
    print(('ok: ' if cond else 'FAIL: ') + what, flush=True)
    if not cond:
        fails.append(what)


def get(url):
    try:
        return urllib.request.urlopen(url, timeout=3).read().decode()
    except Exception:
        return ''


def get_code(url):
    try:
        return urllib.request.urlopen(url, timeout=3).status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def post(url, obj=None):
    req = urllib.request.Request(url, data=json.dumps(obj or {}).encode(), method='POST', headers={'Content-Type': 'application/json'})
    return urllib.request.urlopen(req, timeout=5).read().decode()


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


def fake(path, obj=None):
    u = f'http://127.0.0.1:{FAKE}{path}'
    return json.loads((post(u, obj) if obj is not None else get(u)) or '{}')


def start_mixup(tag, port, client, settings=None, env_extra=None, token=None):
    root = f'{TMP}/m-{tag}'
    for d in (f'{TMP}/h-{tag}', root):
        shutil.rmtree(d, ignore_errors=True)
    os.makedirs(f'{root}/.zentor', exist_ok=True)
    open(f'{root}/.zentor/google-client.json', 'w').write(json.dumps(client))
    if settings:
        open(f'{root}/.zentor/settings.json', 'w').write(json.dumps(settings))
    if token:
        p = f'{root}/.zentor/google-token.json'
        open(p, 'w').write(json.dumps(token))
        os.chmod(p, 0o600)
    env = dict(os.environ, MIXUP_ADDR=f'127.0.0.1:{port}', HOME=f'{TMP}/h-{tag}', MIXUP_GOOGLE_BASE=f'http://127.0.0.1:{FAKE}')
    for k in ('MIXUP_GOOGLE_CLIENT_SECRET', 'MIXUP_GOOGLE_DESKTOP_CLIENT_SECRET', 'MIXUP_GOOGLE_LOGIN_TTL'):
        env.pop(k, None)
    env.update(env_extra or {})
    p = subprocess.Popen([BIN, '-root', root, '-headless'], env=env, stdout=open(f'{OUT}/mixup-{tag}.log', 'w'), stderr=subprocess.STDOUT)
    procs.append(p)
    until(lambda: get(f'http://127.0.0.1:{port}/api/version'))
    return f'http://127.0.0.1:{port}/'


errors = {}
bad_urls = set()


def open_page(browser, name, url, w=1280, h=820, intro_seen=True, design=None):
    ctx = browser.new_context(viewport={'width': w, 'height': h}, locale='es-ES')
    if intro_seen:
        ctx.add_init_script("try { localStorage.setItem('zt.intro', '1') } catch {}")
    pg = ctx.new_page()
    errors[name] = []
    pg.on('console', lambda m: m.type == 'error' and 'ERR_' not in m.text and errors[name].append(m.text))
    pg.on('pageerror', lambda e: errors[name].append('pageerror: ' + str(e)))
    # (no internet: YouTube / covers answer 502, a missing Drive file 404 — those are expected)
    pg.on('response', lambda r: r.status >= 400 and bad_urls.add(f'{r.status} {r.url.split("?")[0]}'))
    pg.goto(url)
    pg.wait_for_function('typeof ZT !== "undefined" && typeof GoogleAcct !== "undefined" && GoogleAcct.known()')
    if design:
        pg.evaluate(f"Mix.setDesign({design!r})")
    pg.wait_for_timeout(1000)
    return pg


def show_plugin(pg):
    pg.evaluate("GDrivePromo.open()")
    pg.wait_for_selector('.gdp-acct', state='visible')
    pg.wait_for_timeout(400)


def click_login(pg, sel='.gdp-acct [data-ga=login]'):
    """click the button; the popup is «the system browser»; returns it once it's back at MixUp"""
    with pg.context.expect_page() as pop:
        pg.click(sel)
    popup = pop.value
    popup.wait_for_load_state()
    return popup


def last_auth():
    a = fake('/_state').get('auth') or [{}]
    return a[-1]


def main():
    fk = subprocess.Popen([sys.executable, os.path.join(HERE, 'fake_google.py'), str(FAKE)])
    procs.append(fk)
    until(lambda: get(f'http://127.0.0.1:{FAKE}/_state'))
    both = {'client_id': 'cid', 'client_secret': 'csec', 'desktop_client_id': 'did', 'desktop_client_secret': 'dsec'}
    L = start_mixup('L', BASE + 1, both)
    T = start_mixup('T', BASE + 2, both, env_extra={'MIXUP_GOOGLE_LOGIN_TTL': '3'})
    old_tok = {'access_token': 'stale', 'refresh_token': 'old-ref', 'expiry': 1, 'scope': 'openid https://www.googleapis.com/auth/drive.file',
               'email': 'old@example.com', 'name': 'Old', 'added': 1}
    fake('/_seed', {'refresh': 'old-ref', 'client': 'cid'})
    O = start_mixup('O', BASE + 3, {'client_id': 'cid', 'client_secret': 'csec'}, token=old_tok)
    # desktop only, with MixUp's real desktop id and a (dummy) secret from the environment, as a build would
    N = start_mixup('N', BASE + 4, {}, env_extra={'MIXUP_GOOGLE_DESKTOP_CLIENT_SECRET': 'dsec'})
    D = start_mixup('D', BASE + 5, both)  # a new install: the welcome steps

    with sync_playwright() as p:
        br = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-proxy-server'])

        # ---- L: the direct sign-in
        pg = open_page(br, 'L', L, design='legacy')
        st = json.loads(get(L + 'api/google'))
        ok(st.get('direct') is True and st.get('device') is True and st.get('configured') is True, f'L: status direct+device {st}')
        show_plugin(pg)
        ok(pg.is_visible('.gdp-acct .gsi') and 'Iniciar sesión con Google' in pg.inner_text('.gdp-acct .gsi'), 'L: «Iniciar sesión con Google» button')
        ok(pg.evaluate("document.querySelectorAll('.gdp-acct .gsi-g svg path').length") == 4, 'L: the four-colour G')
        ok(pg.is_visible('.gdp-acct [data-ga=usecode]'), 'L: «¿No se abre? Usar un código»')
        pg.screenshot(path=f'{OUT}/legacy-pc-1-boton.png')

        # the «browser» goes to Google but the person doesn't come back yet: hold
        fake('/_config', {'mode': 'hold'})
        popup = click_login(pg)
        pg.wait_for_selector('.gdp-acct .ga-wait', state='visible')
        txt = pg.inner_text('.gdp-acct')
        ok('Termina en la ventana de Google' in txt and pg.is_visible('.gdp-acct [data-ga=reopen]') and pg.is_visible('.gdp-acct [data-ga=lcancel]') and pg.is_visible('.gdp-acct [data-ga=usecode]'),
           'L: waiting card with «Volver a abrir», «Cancelar» and «Usar un código»')
        pg.screenshot(path=f'{OUT}/legacy-pc-2-esperando.png')
        q = last_auth()
        want = {'client_id': 'did', 'redirect_uri': f'http://127.0.0.1:{BASE + 1}/api/google/callback', 'response_type': 'code',
                'scope': EXACT, 'code_challenge_method': 'S256', 'access_type': 'offline'}
        ok(all(q.get(k) == v for k, v in want.items()) and len(q.get('state', '')) >= 40 and len(q.get('code_challenge', '')) == 43
           and 'prompt' not in q and 'client_secret' not in q and 'code_verifier' not in q, f'L: Google URL {q}')
        go = popup.get_attribute('#go', 'href')
        ok('127.0.0.1' in go and 'code=' in go, 'L: Google would send the browser back to the loopback')

        # a wrong state (someone else's link): refused, nothing changes
        bad = go.replace('state=' + q['state'], 'state=xyz')
        ok(get_code(bad) == 400, 'L: wrong state refused (400)')
        ok(json.loads(post(L + 'api/google/login/poll'))['state'] == 'pending', 'L: the login keeps waiting after the wrong state')
        ok(fake('/_state')['exchanges'] == 0, 'L: no code exchanged for the wrong state')

        # «Volver a abrir»: Google's page again (a new tab)
        with pg.context.expect_page() as pop2:
            pg.click('.gdp-acct [data-ga=reopen]')
        pop2.value.wait_for_load_state()
        ok(urllib.parse.parse_qs(urllib.parse.urlparse(pop2.value.url).query).get('state', [''])[0] == q['state'], 'L: «Volver a abrir» opens the same login')
        pop2.value.close()

        # the person accepts: back at MixUp
        popup.click('#go')
        popup.wait_for_load_state()
        ok(popup.url.startswith(f'http://127.0.0.1:{BASE + 1}/api/google/callback') and 'Ya puedes cerrar esta pestaña' in popup.inner_text('body'),
           'L: the browser tab says «Ya puedes cerrar esta pestaña»')
        popup.screenshot(path=f'{OUT}/navegador-listo.png')
        pg.wait_for_selector('.gdp-acct .ga-mail', timeout=10000)
        ok('lluc@example.com' in pg.inner_text('.gdp-acct'), 'L: connected, e-mail shown')
        pg.screenshot(path=f'{OUT}/legacy-pc-3-conectado.png')
        tok = json.load(open(f'{TMP}/m-L/.zentor/google-token.json'))
        ok(tok.get('client') == 'desktop' and tok.get('refresh_token', '').startswith('dref-'), 'L: token kept, marked «desktop»')
        ok(oct(os.stat(f'{TMP}/m-L/.zentor/google-token.json').st_mode & 0o777) == '0o600', 'L: token file 0600')
        # the same link again: one use
        ok(get_code(go) == 400, 'L: the link used twice is refused')
        # the access token goes stale: refreshed with the desktop client
        fake('/_expire', {})
        n0 = len(fake('/_state')['refresh_clients'])
        r = pg.evaluate("fetch('/api/google/drive').then(r => r.status)")
        rc = fake('/_state')['refresh_clients'][n0:]
        ok(r == 200 and rc == ['did'], f'L: refreshed with the desktop client {rc} ({r})')
        log = open(f'{OUT}/mixup-L.log').read()
        ok('fake-code' not in log and 'dref-' not in log and 'dsec' not in log and q['state'] not in log, 'L: no code, token, secret or state in the log')
        # disconnect, then «already accepted» → once more with prompt=consent
        pg.evaluate("GoogleAcct.disconnect(false)")
        pg.wait_for_selector('.gdp-acct .gsi', state='visible')
        fake('/_config', {'mode': 'granted'})
        popup = click_login(pg)
        auths = fake('/_state')['auth']
        ok(popup.url.startswith(f'http://127.0.0.1:{BASE + 1}/api/google/callback') and auths[-1].get('prompt') == 'consent' and auths[-2].get('prompt') is None
           and auths[-1]['state'] != auths[-2]['state'], 'L: no refresh token → straight back to Google with prompt=consent, new state')
        pg.wait_for_selector('.gdp-acct .ga-mail', timeout=10000)
        ok(True, 'L: connected after the consent screen')
        popup.close()
        # denied
        pg.evaluate("GoogleAcct.disconnect(false)")
        pg.wait_for_selector('.gdp-acct .gsi', state='visible')
        fake('/_config', {'mode': 'deny'})
        popup = click_login(pg)
        ok('No has dado permiso' in popup.inner_text('body'), 'L: denied: the browser tab says so')
        pg.wait_for_selector('.gdp-acct .ga-err', timeout=6000)
        ok('No has dado permiso' in pg.inner_text('.gdp-acct'), 'L: denied: MixUp says so, and the button is back')
        popup.close()
        # «Cancelar» in MixUp: the link stops working
        fake('/_config', {'mode': 'hold'})
        popup = click_login(pg)
        go = popup.get_attribute('#go', 'href')
        pg.click('.gdp-acct [data-ga=lcancel]')
        pg.wait_for_selector('.gdp-acct .gsi', state='visible')
        popup.click('#go')
        popup.wait_for_load_state()
        ok('no es válido' in popup.inner_text('body') and not json.loads(get(L + 'api/google'))['connected'], 'L: after «Cancelar» the link is refused')
        popup.close()
        # «¿No se abre? Usar un código»: the device flow (TV client) still works
        pg.click('.gdp-acct [data-ga=usecode]')
        pg.wait_for_selector('.ga-uc b', state='visible')
        ok(pg.inner_text('.ga-uc b').startswith('MXUP-'), 'L: «Usar un código» shows the code')
        pg.screenshot(path=f'{OUT}/legacy-pc-4-codigo.png')
        pg.wait_for_selector('.gdp-acct .ga-mail', timeout=20000)
        tok = json.load(open(f'{TMP}/m-L/.zentor/google-token.json'))
        fake('/_expire', {})
        n0 = len(fake('/_state')['refresh_clients'])
        pg.evaluate("fetch('/api/google/drive').then(r => r.status)")
        rc = fake('/_state')['refresh_clients'][n0:]
        ok(tok.get('client') == 'tv' and rc == ['cid'], f'L: code account marked «tv», refreshed with the TV client {rc}')
        pg.evaluate("GoogleAcct.disconnect(false)")
        pg.wait_for_selector('.gdp-acct .gsi', state='visible')

        # 2.5 design: the plugin page and the home card
        pg.evaluate("PluginsUI.close?.()")
        pg.evaluate("Mix.setDesign('v25')")
        pg.wait_for_timeout(1200)
        pg.evaluate("try { localStorage.removeItem('zt.gdPromo') } catch {}")
        pg.reload()
        pg.wait_for_function('typeof GoogleAcct !== "undefined" && GoogleAcct.known()')
        pg.wait_for_timeout(1500)
        has_home = pg.is_visible('.hm-drv .gsi')
        ok(has_home, 'L 2.5: home card has «Iniciar sesión con Google»')
        pg.screenshot(path=f'{OUT}/v25-pc-1-inicio.png')
        fake('/_config', {'mode': 'hold'})
        if has_home:
            popup = click_login(pg, '.hm-drv .gsi')
            pg.wait_for_selector('.gdp-acct .ga-wait', state='visible', timeout=6000)
            ok(True, 'L 2.5: home card → plugin page waiting')
            pg.screenshot(path=f'{OUT}/v25-pc-2-esperando.png')
            popup.click('#go')
            pg.wait_for_selector('.gdp-acct .ga-mail', timeout=10000)
            ok(True, 'L 2.5: connected from the home card')
            pg.screenshot(path=f'{OUT}/v25-pc-3-conectado.png')
            popup.close()
            pg.evaluate("GoogleAcct.disconnect(false)")

        # phones (390x844): Legacy and 2.5
        for design in ('legacy', 'v25'):
            pm = open_page(br, 'L-' + design + '-movil', L, 390, 844, design=design)
            pm.reload()
            pm.wait_for_function('typeof GoogleAcct !== "undefined" && GoogleAcct.known()')
            pm.wait_for_timeout(1200)
            show_plugin(pm)
            pm.screenshot(path=f'{OUT}/{design}-movil-1-boton.png')
            popup = click_login(pm)
            pm.wait_for_selector('.gdp-acct .ga-wait', state='visible')
            pm.screenshot(path=f'{OUT}/{design}-movil-2-esperando.png')
            pm.click('.gdp-acct [data-ga=lcancel]')
            popup.close()
            pm.context.close()

        # ---- T: the expiry
        pt = open_page(br, 'T', T, design='legacy')
        show_plugin(pt)
        fake('/_config', {'mode': 'hold'})
        popup = click_login(pt)
        go = popup.get_attribute('#go', 'href')
        pt.wait_for_selector('.gdp-acct .ga-err', timeout=10000)
        ok('10 minutos' in pt.inner_text('.gdp-acct'), 'T: the page says the sign-in expired')
        popup.click('#go')
        popup.wait_for_load_state()
        ok('no es válido' in popup.inner_text('body') or 'caducado' in popup.inner_text('body'), 'T: the late callback is refused')
        ok(not json.loads(get(T + 'api/google'))['connected'], 'T: not connected')
        # (callback reached before the page noticed: «caducado»)
        popup = click_login(pt)
        go = popup.get_attribute('#go', 'href')
        time.sleep(3.5)
        ok(get_code(go) == 400, 'T: an expired login\'s callback: 400')
        popup.close()

        # ---- O: TV only, an old code account
        po = open_page(br, 'O', O, design='legacy')
        st = json.loads(get(O + 'api/google'))
        ok(st.get('direct') is False and st.get('device') is True and st.get('connected') is True, f'O: TV only, old account connected {st}')
        n0 = len(fake('/_state')['refresh_clients'])
        r = po.evaluate("fetch('/api/google/drive').then(r => r.status)")
        rc = fake('/_state')['refresh_clients'][n0:]
        ok(r == 200 and rc == ['cid'], f'O: the old account refreshes with the TV client {rc}')
        po.evaluate("GoogleAcct.disconnect(false)")
        show_plugin(po)
        ok(po.is_visible('.gdp-acct [data-ga=connect]') and not po.is_visible('.gdp-acct .gsi') and not po.is_visible('.gdp-acct [data-ga=usecode]'),
           'O: without the desktop secret only «Conectar con Google» (the code), as before')
        po.screenshot(path=f'{OUT}/solo-tv.png')

        # ---- N: desktop only
        pn = open_page(br, 'N', N, design='legacy')
        st = json.loads(get(N + 'api/google'))
        ok(st.get('direct') is True and st.get('device') is False, f'N: desktop only {st}')
        show_plugin(pn)
        ok(pn.is_visible('.gdp-acct .gsi') and not pn.is_visible('.gdp-acct [data-ga=usecode]'), 'N: the direct button, no «Usar un código»')
        fake('/_config', {'mode': 'approve'})
        popup = click_login(pn)
        ok(last_auth().get('client_id') == '1056092467056-55436srn2dkh00flad6rki4jt2nf69t0.apps.googleusercontent.com', 'N: MixUp\'s real desktop client id')
        pn.wait_for_selector('.gdp-acct .ga-mail', timeout=10000)
        ok(True, 'N: connected with the build\'s desktop secret')
        popup.close()

        # ---- D: a new install: the welcome step
        for design, (w, h) in (('v25', (1280, 820)), ('v25', (390, 844))):
            pd = open_page(br, f'D-{w}', D, w, h, intro_seen=False)
            pd.wait_for_selector('.intro', timeout=10000)
            for _ in range(6):
                if pd.is_visible('.in-foot .gsi'):
                    break
                pd.click('.in-foot [data-in=next]')
                pd.wait_for_timeout(450)
            ok(pd.is_visible('.in-foot .gsi'), f'D {w}: the welcome step has «Iniciar sesión con Google»')
            pd.screenshot(path=f'{OUT}/intro-{w}-1.png')
            fake('/_config', {'mode': 'hold'})
            popup = click_login(pd, '.in-foot .gsi')
            pd.wait_for_selector('.in-acct .ga-wait', state='visible', timeout=6000)
            pd.screenshot(path=f'{OUT}/intro-{w}-2-esperando.png')
            popup.click('#go')
            pd.wait_for_selector('.in-acct .ga-mail', timeout=10000)
            ok('Empezar' in pd.inner_text('.in-foot'), f'D {w}: connected from the welcome step')
            pd.screenshot(path=f'{OUT}/intro-{w}-3-listo.png')
            popup.close()
            pd.evaluate("GoogleAcct.disconnect(false)")
            pd.context.close()

        br.close()
    print('HTTP errors seen (expected without internet):', sorted(bad_urls))
    for k, v in errors.items():
        real = [x for x in v if 'Failed to load resource' not in x and 'net::' not in x]
        ok(not real, f'{k}: no console errors {real[:3]}')


try:
    main()
except Exception as e:
    import traceback
    traceback.print_exc()
    fails.append('crash: ' + str(e))
finally:
    for p in procs:
        p.terminate()
print('PASS' if not fails else f'{len(fails)} FAILED: {fails}')
sys.exit(1 if fails else 0)
