#!/usr/bin/env python3
"""Prueba de las vistas de la Biblioteca del 2.5 (Playwright, sin internet).

  python3 tools/libviewstest/run.py [puerto=47903]

Con MixUp sirviendo una biblioteca grande (make_library.py). Capturas en /tmp/libviews-out."""
import json, os, sys, time
from playwright.sync_api import sync_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else '47903'
URL = f'http://127.0.0.1:{PORT}/'
OUT = os.environ.get('OUT', '/tmp/libviews-out')
os.makedirs(OUT, exist_ok=True)
errors = []


def page_for(b, w, h, mobile=False):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=1, locale='es-ES', has_touch=mobile, is_mobile=mobile)
    ctx.add_init_script("localStorage.setItem('zt.intro','1')")
    # no internet here: YouTube's things fail fast
    ctx.route('**/*', lambda r: r.abort() if not r.request.url.startswith(f'http://127.0.0.1:{PORT}') and not r.request.url.startswith('data:') else r.continue_())
    p = ctx.new_page()
    p.on('console', lambda m: errors.append(f'[{w}x{h}] {m.type}: {m.text[:300]}') if m.type == 'error' and 'net::' not in m.text and 'Failed to load resource' not in m.text else None)
    p.on('pageerror', lambda e: errors.append(f'[{w}x{h}] pageerror: {e}'))
    p.goto(URL)
    p.wait_for_function("typeof V25 !== 'undefined' && V25.active() && Mix.tracks().length > 1000", timeout=30000)
    return p


def shot(p, name):
    p.wait_for_timeout(350)
    p.screenshot(path=os.path.join(OUT, name + '.png'))


def go(p, view, params='{}', opts='{}'):
    p.evaluate(f"V25.go('{view}', {params}, {opts})")
    p.wait_for_timeout(300)


def scroll_perf(p, label):
    r = p.evaluate("""async () => {
      const m = document.querySelector('#v25 .v-main'); const t0 = performance.now(); let frames = 0, worst = 0, last = t0;
      await new Promise(res => { const step = () => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; frames++; m.scrollTop += 120; if (now - t0 < 2500 && m.scrollTop + m.clientHeight < m.scrollHeight - 2) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); });
      return { frames, ms: Math.round(performance.now() - t0), worst: Math.round(worst), rows: document.querySelectorAll('#v25 .lv-vlist > *').length, top: m.scrollTop };
    }""")
    print(f'  scroll {label}: {r}')
    return r


with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required'])
    for (w, h, mob, tag) in [(390, 844, True, 'phone'), (1280, 820, False, 'pc'), (1920, 1080, False, 'pcbig')]:
        print('==', tag)
        p = page_for(b, w, h, mob)
        p.evaluate("Mix.settings.set({ v25LibSections: ['playlists', 'albums', 'artists', 'songs', 'liked', 'youtube'], v25LibSort: {}, v25LibView: {} })")
        go(p, 'library', "{tab:'playlists'}", '{root:true}')
        # a few playlists to see
        p.evaluate("""() => { if (Mix.playlists().filter(x => !x.liked).length < 3) { const t = Mix.tracks(); Mix.pl.create('Para correr', t.slice(0, 40)); Mix.pl.create('Chill', t.slice(100, 112)); Mix.pl.create('Vacía'); for (const x of t.slice(5, 60)) Mix.like(x, true); } }""")
        p.wait_for_timeout(400)
        shot(p, f'{tag}-01-lib-playlists')
        p.click('#v25 .lv-chip[data-sec="albums"]'); shot(p, f'{tag}-02-lib-albums')
        scroll_perf(p, 'albums grid')
        p.click('#v25 .lv-chip[data-sec="artists"]'); shot(p, f'{tag}-03-lib-artists')
        p.click('#v25 .lv-chip[data-sec="songs"]'); shot(p, f'{tag}-04-lib-songs')
        scroll_perf(p, 'songs (1500)')
        p.evaluate("document.querySelector('#v25 .v-main').scrollTop = 0")
        p.fill('#v25 .lv-filter input', 'luna'); p.wait_for_timeout(200); shot(p, f'{tag}-05-lib-filter')
        p.click('#v25 .lv-sortbtn'); shot(p, f'{tag}-06-sort-menu')
        p.locator('#v25 .lv-mi', has_text='A-Z').first.click(); p.wait_for_timeout(200)
        p.click('#v25 .lv-chip-edit'); shot(p, f'{tag}-07-edit-sections')
        p.click('#v25 .lv-ed-row[data-id="files"] [data-tog]'); p.wait_for_timeout(100)
        p.click('#v25 .lv-ed-row[data-id="files"] [data-up]'); p.wait_for_timeout(100)
        print('  sections:', p.evaluate("Mix.settings.get().v25LibSections"))
        p.keyboard.press('Escape'); p.wait_for_timeout(300)
        if p.locator('#v25 .v-sheet-wrap').count(): p.evaluate("V25.back()"); p.wait_for_timeout(300)
        # play a real song (the 8 s tones) from the songs list
        p.click('#v25 .lv-chip[data-sec="songs"]'); p.fill('#v25 .lv-filter input', 'tono'); p.wait_for_timeout(200)
        p.click('#v25 .lv-row[data-track] .lv-rtx'); p.wait_for_timeout(1200)
        print('  playing:', p.evaluate("[Mix.track()?.title, Mix.playing()]"))
        shot(p, f'{tag}-08-playing-row')
        # song menu: right click (PC) / long-press (phone)
        row = p.locator('#v25 .lv-row[data-track]').first
        if mob:
            box = row.bounding_box()
            p.evaluate("""([x, y]) => { const el = document.elementFromPoint(x, y); const o = { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true }; el.dispatchEvent(new PointerEvent('pointerdown', o)); setTimeout(() => el.dispatchEvent(new PointerEvent('pointerup', o)), 650); }""", [box['x'] + 120, box['y'] + 20])
            p.wait_for_timeout(900)
        else:
            row.click(button='right')
        shot(p, f'{tag}-09-song-menu')
        p.locator('#v25 .lv-mi', has_text='Añadir a una playlist').first.click(); p.wait_for_timeout(300)
        shot(p, f'{tag}-10-add-to-playlist')
        p.locator('#v25 .lv-mi', has_text='Para correr').first.click(); p.wait_for_timeout(200)
        # album / artist / playlist
        key = p.evaluate("Mix.albums().find(a => a.count > 6 && a.cover)?.key")
        go(p, 'album', json.dumps({'key': key})); shot(p, f'{tag}-11-album')
        p.evaluate("document.querySelector('#v25 .v-main').scrollTop = 400"); shot(p, f'{tag}-12-album-scrolled')
        akey = p.evaluate("Mix.artists().sort((a,b)=>b.count-a.count)[0].key")
        go(p, 'artist', json.dumps({'key': akey})); shot(p, f'{tag}-13-artist')
        p.evaluate("document.querySelector('#v25 .v-main').scrollTop = 700"); shot(p, f'{tag}-14-artist-scrolled')
        pid = p.evaluate("Mix.playlists().find(x => x.name === 'Para correr').id")
        go(p, 'playlist', json.dumps({'id': pid})); shot(p, f'{tag}-15-playlist')
        before = p.evaluate(f"Mix.playlist('{pid}').tracks.slice(0,4).map(t => t.title)")
        hs = p.locator('#v25 .lv-drag').nth(0).bounding_box()
        p.mouse.move(hs['x'] + hs['width'] / 2, hs['y'] + hs['height'] / 2); p.mouse.down()
        rh = p.evaluate("document.querySelector('#v25 .lv-vlist > .lv-row').offsetHeight")
        for k in range(1, 8):
            p.mouse.move(hs['x'] + 10, hs['y'] + hs['height'] / 2 + k * rh * 2.4 / 7)
            p.wait_for_timeout(30)
        shot(p, f'{tag}-16-dragging')
        p.mouse.up(); p.wait_for_timeout(400)
        after = p.evaluate(f"Mix.playlist('{pid}').tracks.slice(0,4).map(t => t.title)")
        print('  reorder:', before, '->', after)
        p.click('#v25 .lv-act[data-act="more"]'); shot(p, f'{tag}-17-playlist-menu')
        p.keyboard.press('Escape'); p.wait_for_timeout(300)
        go(p, 'playlist', "{id:'liked'}"); shot(p, f'{tag}-18-liked')
        scroll_perf(p, 'liked')
        # search
        go(p, 'search', '{}', '{root:true}'); shot(p, f'{tag}-19-search-empty')
        if p.locator('#v25 .lv-sfield input').count():
            p.fill('#v25 .lv-sfield input', 'luna'); p.wait_for_timeout(500)
        else:
            go(p, 'search', "{q:'luna'}", '{replace:true}')
        shot(p, f'{tag}-20-search-luna')
        p.wait_for_timeout(1200); shot(p, f'{tag}-21-search-yt')
        p.locator('#v25 .lv-bcard').count()
        go(p, 'search', "{browse:'genre:Rock'}"); shot(p, f'{tag}-22-browse')
        go(p, 'library', '{}', '{root:true}')
        print('  rows in DOM (songs):', p.evaluate("document.querySelectorAll('#v25 .lv-vlist > *').length"))
        p.context.close()
    b.close()

print('errores:', len(errors))
for e in errors:
    print(' ', e)
