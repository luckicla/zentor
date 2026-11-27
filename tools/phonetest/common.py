"""Ayudas comunes para las pruebas del móvil 2.5 (tools/phonetest)."""
import json, os, shutil, subprocess, time, urllib.request

ADDR = os.environ.get('MIXUP_ADDR', '127.0.0.1:47901')
BIN = os.environ.get('MIXUP_BIN', '/tmp/mixup-phone')
ASSETS = os.environ.get('PHONE_ASSETS', '/tmp/phone-assets')


def start(tag, settings=None, songs=True, extra=None):
    tag = os.environ.get('PHONETEST_TAG', '') + tag  # (several runs at once: their own folders)
    home, root = f'/tmp/h-{tag}-phone', f'/tmp/m-{tag}-phone'
    shutil.rmtree(home, True); shutil.rmtree(root, True)
    os.makedirs(home); os.makedirs(root)
    if songs:
        for f in sorted(os.listdir(ASSETS)):
            shutil.copy(os.path.join(ASSETS, f), root)
    if extra and os.path.isdir(extra):  # (more songs, e.g. with their own covers)
        for f in sorted(os.listdir(extra)):
            shutil.copy(os.path.join(extra, f), root)
    if settings is not None:
        os.makedirs(os.path.join(root, '.zentor'))
        json.dump(settings, open(os.path.join(root, '.zentor', 'settings.json'), 'w'))
    env = {**os.environ, 'MIXUP_ADDR': ADDR, 'HOME': home}
    p = subprocess.Popen([BIN, '-root', root, '-headless'], env=env, stdout=open(f'/tmp/phonetest-{tag}.log', 'w'), stderr=subprocess.STDOUT)
    for _ in range(60):
        try:
            urllib.request.urlopen(f'http://{ADDR}/api/version', timeout=1); break
        except Exception:
            time.sleep(0.2)
    return p


def page(browser, w=390, h=844, touch=True):
    ctx = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, has_touch=touch, is_mobile=touch)
    ctx.add_init_script("localStorage.setItem('zt.intro','1')")
    pg = ctx.new_page()
    errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'net::' not in m.text and 'Failed to load resource' not in m.text else None)
    pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
    return ctx, pg, errs
