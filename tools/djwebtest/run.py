#!/usr/bin/env python3
"""Prueba del DJ con música de internet (notas/DJ-INTERNET.md), sin internet.

  go build -o /tmp/mixup-djweb . && python3 tools/djwebtest/run.py

- Tu música: 3 canciones generadas con ffmpeg (120, 88 y 172 BPM, tonos distintos):
  con la de 120 sonando, ninguna de las otras pega -> hace falta internet.
- «YouTube»: 3 vídeos falsos en la caché de YouTube de MixUp (LOCALAPPDATA):
  uno a 121 BPM en el mismo tono (el bueno), otro a 93 BPM y otro roto.
  Las recomendaciones (Recs.pool) se inyectan en la página.
- Comprueba: solo se pide el principio de cada una (/api/djclip), el resultado
  se guarda (/api/djweb) y no se vuelve a pedir tras recargar; elige la buena,
  la prepara entera (ytaudio prep) y la analiza entera antes de mezclar; «Nunca»
  no usa internet; la rota queda marcada; sin errores en consola; capturas.
Puerto: MIXUP_ADDR (por defecto 127.0.0.1:18483). Capturas en /tmp/djwebtest-out."""
import json, os, shutil, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

ADDR = os.environ.get('MIXUP_ADDR', '127.0.0.1:18483')
BIN = os.environ.get('MIXUP_BIN', '/tmp/mixup-djweb')
ASSETS = '/tmp/djweb-assets'
OUT = '/tmp/djwebtest-out'
LAD = '/tmp/djweb-lad'  # LOCALAPPDATA: the YouTube cache goes in LAD/ZenTor/yt/cache
Y1, Y2, Y3 = 'djwebYt0001', 'djwebYt0002', 'djwebYt0003'
fails = []


def check(ok, what):
    print(('ok    ' if ok else 'FALLO ') + what, flush=True)
    if not ok:
        fails.append(what)


def gen(name, bpm, freqs, dur, args):
    p = 60 / bpm
    chord = '+'.join(f'sin(2*PI*{f}*t)' for f in freqs)
    expr = (f"0.55*sin(2*PI*55*t)*exp(-18*mod(t\\,{p}))*(1+0.6*lt(mod(t\\,4*{p})\\,{p}))"
            f"+0.05*sin(2*PI*8000*t)*exp(-60*mod(t+{p}/2\\,{p}))+0.1*({chord})")
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f"aevalsrc=exprs='{expr}':d={dur}:s=44100", *args, os.path.join(ASSETS, name)], check=True)


def assets():
    if os.path.exists(os.path.join(ASSETS, 'ok')):
        return
    os.makedirs(ASSETS, exist_ok=True)
    mp3 = lambda t, a: ['-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', f'title={t}', '-metadata', f'artist={a}', '-metadata', 'genre=House']
    gen('L1.mp3', 120, [220, 261.63, 329.63], 150, mp3('Uno', 'Local A'))
    gen('L2.mp3', 88, [277.18, 349.23, 415.30], 150, mp3('Dos', 'Local B'))
    gen('L3.mp3', 172, [174.61, 207.65, 261.63], 150, mp3('Tres', 'Local C'))
    gen(Y1 + '.high.webm', 121, [220, 261.63, 329.63], 200, ['-c:a', 'libopus', '-b:a', '64k'])
    gen(Y2 + '.high.webm', 93, [185, 233.08, 277.18], 200, ['-c:a', 'libopus', '-b:a', '64k'])
    open(os.path.join(ASSETS, Y3 + '.high.webm'), 'wb').write(os.urandom(300000))
    open(os.path.join(ASSETS, 'ok'), 'w').write('1')


def start(settings):
    home, root = '/tmp/h-djweb', '/tmp/m-djweb'
    for d in (home, root, LAD):
        shutil.rmtree(d, True)
    os.makedirs(home); os.makedirs(os.path.join(root, '.zentor'))
    cache = os.path.join(LAD, 'ZenTor', 'yt', 'cache')
    os.makedirs(cache)
    for f in os.listdir(ASSETS):
        if f.endswith('.mp3'):
            shutil.copy(os.path.join(ASSETS, f), root)
        elif f.endswith('.webm'):
            shutil.copy(os.path.join(ASSETS, f), cache)
    json.dump(settings, open(os.path.join(root, '.zentor', 'settings.json'), 'w'))
    try:
        urllib.request.urlopen(f'http://{ADDR}/api/version', timeout=1)
        sys.exit(f'{ADDR} ya está en uso')
    except OSError:
        pass
    p = subprocess.Popen([BIN, '-root', root, '-headless'], env={**os.environ, 'MIXUP_ADDR': ADDR, 'HOME': home, 'LOCALAPPDATA': LAD},
                         stdout=open('/tmp/djwebtest.log', 'w'), stderr=subprocess.STDOUT)
    for _ in range(80):
        try:
            urllib.request.urlopen(f'http://{ADDR}/api/version', timeout=1); break
        except OSError:
            time.sleep(0.2)
    return p


INJECT = """(() => {
  const items = [
    { v: '%s', title: 'Bueno', artist: 'Web Uno', dur: 200 },
    { v: '%s', title: 'Lento', artist: 'Web Dos', dur: 200 },
    { v: '%s', title: 'Roto', artist: 'Web Tres', dur: 200 },
  ];
  Recs.pool = async () => items;
  YouTube.search = async () => [];
})()""" % (Y1, Y2, Y3)


def wait(pg, expr, timeout, what):
    try:
        pg.wait_for_function(expr, timeout=timeout, polling=500)
        return True
    except Exception:
        st = pg.evaluate("""({ plan: Dj.plan().map(t => t.title + (t.yt ? ' [' + t.yt + ']' : '')), cur: ZT.cur() && ZT.cur().title,
          web: Dj.webState(), an: ZT.allTracks().map(t => t.title + ':' + (Dj.get(t) ? Math.round(Dj.get(t).bpm) + Dj.get(t).key : '-')) })""")
        print(f'  (esperando: {what}) {st}')
        return False


def session(b, tag, first):
    ctx = b.new_context(viewport={'width': 1280, 'height': 820})
    ctx.add_init_script("localStorage.setItem('zt.intro','1')")
    pg = ctx.new_page()
    errs, reqs = [], []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'net::' not in m.text and 'Failed to load resource' not in m.text else None)
    pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
    pg.on('request', lambda r: reqs.append(r.method + ' ' + r.url.split(ADDR, 1)[-1]))
    pg.goto(f'http://{ADDR}/')
    pg.wait_for_function("window.ZT && ZT.allTracks().length >= 3 && typeof Dj !== 'undefined'", timeout=20000)
    pg.evaluate(INJECT)
    pg.evaluate("ZT.playContext({ type: 'all' }, ZT.allTracks().find(t => t.title === 'Uno').id)")
    pg.wait_for_function("ZT.cur() && ZT.cur().title === 'Uno' && ZT.isPlaying()", timeout=10000)
    return ctx, pg, errs, reqs


def main():
    assets()
    os.makedirs(OUT, exist_ok=True)
    p = start({'theme': 'synth', 'dj': True, 'djSeen': True})
    try:
        with sync_playwright() as pw:
            b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required'])
            # ---- 1: little of yours fits -> the internet, only the start of each ----
            ctx, pg, errs, reqs = session(b, 'a', True)
            check(pg.evaluate("DjWeb.mode(Settings.get())") == 'few', 'por defecto: «Si faltan»')
            for _ in range(90):
                store = json.load(urllib.request.urlopen(f'http://{ADDR}/api/djweb'))
                if all(v in store['a'] for v in (Y1, Y2, Y3)):
                    break
                time.sleep(1)
            else:
                print('  (esperando /api/djweb)', store, [r for r in reqs if 'dj' in r])
            a1, a2, a3 = (store['a'].get(v, {}) for v in (Y1, Y2, Y3))
            check(a1.get('part') == 1 and abs(a1.get('bpm', 0) - 121) < 2, f'trozo de la buena analizado ({a1.get("bpm")} BPM, {a1.get("key")})')
            check(a2.get('part') == 1 and abs(a2.get('bpm', 0) - 93) < 2, f'trozo de la lenta analizado ({a2.get("bpm")} BPM)')
            check(a3.get('bad') == 1, 'la rota queda marcada (no se vuelve a probar)')
            check(len(json.dumps(a1)) < 500, f'lo guardado es pequeño ({len(json.dumps(a1))} bytes)')
            pg.wait_for_timeout(500)  # (the page's events arrive while playwright works)
            clips = [r for r in reqs if '/api/djclip/' in r]
            check(len(clips) == 3 and all('s=60' in r and 'd=200' in r for r in clips), f'un trozo por canción, solo el principio ({clips})')
            check(not any(f'/ytaudio/{Y2}' in r or f'/ytaudio/{Y3}' in r for r in reqs), 'las que no elige no se descargan')
            check(wait(pg, f"Dj.plan().length && Dj.plan()[0].yt === '{Y1}'", 30000, 'plan'), 'elige la de internet que pega (misma clave, 121 BPM)')
            # prepared whole ahead, analysed whole (from that file) before the mix
            wait(pg, f"(() => {{ const t = ZT.byId('yt-{Y1}'); const a = t && Dj.get(t); return a && !a.part; }})()", 60000, 'análisis entero')
            check(any(f'/ytaudio/{Y1}' in r and 'prep=1' in r for r in reqs), 'la elegida se prepara entera con antelación (YouTube.ahead)')
            full = pg.evaluate(f"Dj.get(ZT.byId('yt-{Y1}')) || {{ bpm: 0 }}")
            check(abs(full['bpm'] - 121) < 2 and full.get('tb') and not full.get('part'), f'análisis entero para mezclar ({full["bpm"]} BPM, {full["key"]})')
            check(pg.evaluate(f"ZT.byId('yt-{Y1}').tmp === true"), 'no se guarda en tu música (temporal)')
            check(pg.evaluate("Dj.tag(ZT.byId('yt-%s'))" % Y1).find('BPM') >= 0, 'la línea «Siguiente» muestra tono y BPM')
            # settings rows (Legacy)
            pg.evaluate("ZT.openSettings('dj', 'djSec')")
            pg.wait_for_timeout(700)
            sel = pg.evaluate("[...document.querySelectorAll('.seg[data-djw] button.sel')].map(b => b.dataset.v).join(',')")
            check(sel == 'few,100', f'filas de ajustes pintadas ({sel})')
            wifi = pg.evaluate("document.querySelector('.sw[data-djw]').getAttribute('aria-checked')")
            check(wifi == 'false', 'PC: «Solo con WiFi» apagado por defecto')
            row = pg.locator('.seg[data-djw="djWeb"]').first
            if row.is_visible():
                row.scroll_into_view_if_needed()
                pg.screenshot(path=f'{OUT}/legacy-ajustes-dj.png')
            # «Nunca»: no internet ones in the plan
            pg.evaluate("document.querySelector('.seg[data-djw=\"djWeb\"] button[data-v=\"never\"]').click()")
            pg.wait_for_timeout(300)
            pg.evaluate("Dj.replan()")
            pg.wait_for_timeout(300)
            check(pg.evaluate("Settings.get().djWeb") == 'never' and not pg.evaluate("Dj.plan().some(t => t.web)"), '«Nunca»: nada de internet')
            pg.evaluate("document.querySelector('.seg[data-djw=\"djWeb\"] button[data-v=\"few\"]').click()")
            pg.wait_for_timeout(2500)  # (saved to the server, debounced)
            check(pg.evaluate("Settings.get().djWeb") == 'few', '«Si faltan» otra vez')
            # the internet one won't come (its audio fails / not here in time): one of yours, and a while without internet ones
            pg.evaluate(f"Dj.drop(ZT.byId('yt-{Y1}'))")
            pg.wait_for_timeout(600)
            check(pg.evaluate("Dj.plan().length > 0 && !Dj.plan()[0].yt && Dj.webState().cool"), f'si la de internet falla: una tuya ({pg.evaluate("Dj.plan().map(t => t.title)")})')
            check(not errs, f'sin errores en consola ({errs[:3]})')
            ctx.close()
            # ---- 2: again (fresh page): the analyses are kept, nothing listened to twice ----
            ctx, pg, errs, reqs = session(b, 'b', False)
            check(wait(pg, f"Dj.plan().length && Dj.plan()[0].yt === '{Y1}'", 60000, 'plan tras recargar'), 'tras recargar: vuelve a elegir la buena')
            check(not any('/api/djclip/' in r for r in reqs), 'tras recargar: no vuelve a bajar ni analizar ningún trozo')
            # the real mix into it: near the end of «Uno», it comes in mixed and plays
            wait(pg, f"(() => {{ const a = Dj.get(ZT.byId('yt-{Y1}')); return a && !a.part; }})()", 60000, 'análisis entero (2)')
            pg.evaluate("ZT.seek(ZT.duration() - 40)")
            ok = wait(pg, "ZT.cur() && ZT.cur().title === 'Bueno'", 60000, 'mezcla hacia la de internet')
            pg.wait_for_timeout(1500)
            check(ok and pg.evaluate("ZT.isPlaying()"), 'se mezcla con la de internet y sigue sonando (sin silencio)')
            pg.screenshot(path=f'{OUT}/legacy-mezclada.png')
            check(not errs, f'sin errores en consola ({errs[:3]})')
            ctx.close()
            b.close()
    finally:
        p.terminate()
    print('\n' + ('TODO BIEN' if not fails else f'{len(fails)} FALLOS: ' + '; '.join(fails)))
    sys.exit(1 if fails else 0)


main()
