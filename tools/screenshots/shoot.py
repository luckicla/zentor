# Takes the README screenshots from a ZenTor already running on
# 127.0.0.1:47811 with the demo library (see demo.py and the "Capturas"
# workflow). PC at 1440x900 and the phone at 412x915, both on high DPI.
import sys
from playwright.sync_api import sync_playwright

out = sys.argv[1] if len(sys.argv) > 1 else "docs"
URL = "http://127.0.0.1:47811/"

# the phone app's bridge, enough for the page to think it's on Android
STUB = """
window.ZenTorAndroid = new Proxy({}, { get: (_, k) =>
  k === 'systemVolume' ? () => 1 : () => '' });
"""
SETTINGS = "try { localStorage.setItem('zt.settings', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('zt.settings') || '{}'), %s))) } catch {}"

def ready(pg):
    # the first time, the page reloads to restore what it had saved: wait
    # until it has been loaded and quiet for a few seconds
    for _ in range(30):
        try:
            pg.wait_for_function("window.ZT && ZT.tracks().length > 20", timeout=20000)
            n = pg.evaluate("performance.timeOrigin")
            pg.wait_for_timeout(3000)
            if pg.evaluate("performance.timeOrigin") == n:
                return
        except Exception:
            pg.wait_for_timeout(1000)
    raise SystemExit("ZenTor didn't load")

def setup(pg):
    # a playlist like a real one, and something playing from it
    pg.evaluate("""() => {
      const ts = ZT.tracks();
      const pick = (...names) => names.map(n => ts.find(t => t.title === n)).filter(Boolean).map(t => t.id);
      let l = Playlists.lists().find(l => l.name === 'Noches');
      if (!l) l = Playlists.create('Noches', pick('Ciudad de cristal', 'Overdrive', 'Paper Hearts', 'Señales', 'Mareas',
        'Glitch Kiss', 'Último metro', 'Static', 'Polaroid', 'Afterglow', 'Sal en la piel', 'Neón de madrugada', 'Satellite Love', 'Red Line'));
      Playlists.create('Para entrenar', pick('Overdrive', 'Red Line', 'Zero Hour', 'Gold Rush', 'Fuego lento'));
      Playlists.create('Domingo', pick('Domingo', 'Casa vacía', 'Ventanas', 'Faro', 'Verano 03'));
      for (const id of pick('Ciudad de cristal', 'Paper Hearts', 'Mareas', 'Polaroid')) if (!Playlists.isLiked(id)) Playlists.toggleLike(id);
      const l2 = Playlists.lists().find(l => l.name === 'Noches');
      ZT.playContext({ type: 'list', id: l2.id }, pick('Neón de madrugada')[0]);
      return l2.id;
    }""")
    pg.wait_for_timeout(2500)
    pg.evaluate("() => { const a = [...document.querySelectorAll('audio')].find(a => !a.paused) || document.querySelector('audio'); if (a && a.duration) a.currentTime = a.duration * 0.58; }")
    pg.wait_for_timeout(2500)

with sync_playwright() as p:
    b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])

    # ---- PC
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2, locale="es-ES")
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL); ready(pg); setup(pg)
    pg.evaluate("() => { const id = Playlists.lists().find(l => l.name === 'Noches').id; Library.nav('list:' + id); }")
    pg.wait_for_timeout(1500)
    pg.screenshot(path=f"{out}/pc-playlist.png")
    pg.evaluate("() => Library.nav('albums')"); pg.wait_for_timeout(1200)
    pg.screenshot(path=f"{out}/pc-albumes.png")
    pg.evaluate("() => document.getElementById('btnSettings').click()"); pg.wait_for_timeout(1200)
    pg.screenshot(path=f"{out}/pc-ajustes.png")
    print("pc errors:", errs)
    ctx.close()

    # ---- phone
    ctx = b.new_context(viewport={"width": 412, "height": 915}, device_scale_factor=3, locale="es-ES", is_mobile=True, has_touch=True,
                        user_agent="Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36 ZenTorAndroid")
    ctx.add_init_script(STUB)
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL); ready(pg); setup(pg)
    pg.screenshot(path=f"{out}/android-reproductor.png")
    pg.evaluate("() => { const id = Playlists.lists().find(l => l.name === 'Noches').id; Library.open(); Library.nav('list:' + id); }")
    pg.wait_for_timeout(1500)
    pg.screenshot(path=f"{out}/android-playlist.png")
    print("android errors:", errs)
    ctx.close()
    b.close()
