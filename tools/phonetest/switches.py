"""Comprobación común de interruptores y sliders (tools/phonetest y tools/v25pctest).

switches(pg, tag, check, out=None): en la página ya abierta, para Legacy y 2.5 y con
«Esquinas» a 0 y 26, que todos los interruptores visibles de Ajustes (todas las
pestañas), las páginas de los plugins, el DJ, la tienda del 2.5 y la hoja «Barra y
reproductor» se ven igual (tamaño, radios de la pista y del tirador, colores por
estado); con 0, rectos; con 26, redondos. Y espiando ZT.haptic: que al cambiar
cualquiera se llama una sola vez, con 'on' al encender y 'off' al apagar (la de
siempre de Ajustes), y que los sliders dan 'tick' al moverse y 'select' al soltar.
"""
import time

COLLECT = r"""() => {
  const vis = el => { const r = el.getBoundingClientRect(); const c = getComputedStyle(el); return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && !el.closest('[hidden]'); };
  const on = el => el.hasAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true' : el.classList.contains('on');
  return [...document.querySelectorAll('.sw,.v-switch,[role=switch]')].filter(vis).map(el => {
    const c = getComputedStyle(el), k = getComputedStyle(el, '::after');
    const box = el.closest('[id],.v-sheet,.djp,.plg-page,#v25');
    return { where: (box && (box.id || box.className.split(' ')[0])) || '?', cls: el.className,
             on: on(el), geo: [c.width, c.height, c.borderTopLeftRadius, k.width, k.height, k.borderTopLeftRadius].join(' '),
             col: [c.backgroundColor, k.backgroundColor].join(' '), r: c.borderTopLeftRadius, kr: k.borderTopLeftRadius };
  });
}"""

SPY = """() => { window.__hap = []; if (!window.__hapReal) { window.__hapReal = ZT.haptic; ZT.haptic = k => { window.__hap.push(k); }; } }"""


def _gather(pg, d25, phone):
    ev = pg.evaluate
    out = []
    ev("Mix.openSettings()"); time.sleep(0.5)
    for t in ev("[...document.querySelectorAll('#setTabs button')].filter(b => !b.hidden).map(b => b.dataset.tab)"):
        ev(f"document.querySelector('#setTabs [data-tab=\"{t}\"]').click()"); time.sleep(0.12)
        out += ev(COLLECT)
    ev("document.querySelector('#setTabs [data-tab=\"plugins\"]')?.click()"); time.sleep(0.2)
    for i in ev("Plugins.list('plugin').map(p => p.id)"):
        ev(f"PluginsUI.open('{i}')"); time.sleep(0.12)
        out += ev(COLLECT)
        ev("PluginsUI.close()")
    ev("Mix.closeSettings()"); time.sleep(0.3)
    ev("Dj.open()"); time.sleep(0.5)
    ev("document.querySelector('#djTrBtn')?.click()"); time.sleep(0.3)
    out += ev(COLLECT)
    ev("Dj.close()"); time.sleep(0.4)
    if d25:
        ev("V25.go('store')"); time.sleep(0.6); out += ev(COLLECT)
        ev("document.querySelector('#v25 [data-det]')?.click()"); time.sleep(0.6); out += ev(COLLECT)
        ev("V25.go('home')"); time.sleep(0.4)
        if phone:
            ev("P25Prefs.open()"); time.sleep(0.7); out += ev(COLLECT)
            ev("V25.sheet?.close?.()"); pg.keyboard.press('Escape'); time.sleep(0.4)
    return out


def _flip(pg, sel, check, what):
    """Click it for real (twice: back as it was): one haptic, 'on' or 'off' by where it goes."""
    ev = pg.evaluate
    loc = pg.locator(sel).first
    if not loc.count():
        check(False, f'{what}: no está ({sel})'); return
    for _ in range(2):
        was = ev("s => { const el = document.querySelector(s); return el.hasAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true' : el.classList.contains('on'); }", sel)
        ev(SPY)
        loc = pg.locator(sel).first
        loc.scroll_into_view_if_needed(); loc.click(); time.sleep(0.45)
        got = ev("window.__hap.slice()")
        want = ['off' if was else 'on']
        check(got == want, f'{what}: una vibración igual que Ajustes al {"apagar" if was else "encender"} ({got})')


def _slide(pg, sel, check, what):
    ev = pg.evaluate
    loc = pg.locator(sel).first
    if not loc.count():
        check(False, f'{what}: no está ({sel})'); return
    loc.scroll_into_view_if_needed(); loc.focus(); time.sleep(0.1)
    ev(SPY)
    pg.keyboard.press('End'); time.sleep(0.2)
    got = ev("window.__hap.slice()")
    ev(SPY)
    pg.keyboard.press('Home'); time.sleep(0.2)
    got2 = ev("window.__hap.slice()")
    check(got == ['tick', 'select'] and got2 == ['tick', 'select'], f'{what}: «tick» al moverse y «select» al soltar ({got} {got2})')


def switches(pg, tag, check, out=None, phone=False):
    ev = pg.evaluate
    start_design = ev("Mix.design()")
    ev("Plugins.list('plugin').forEach(p => { try { Plugins.setEnabled(p.id, true); } catch {} })")
    for design in ('v25', 'legacy'):
        ev(f"Mix.setDesign('{design}')"); time.sleep(1.2)
        ev("document.querySelector('.news-wrap')?.remove()")
        d25 = design == 'v25'
        for r in (0, 26):
            ev(f"Settings.set({{ radius: {r} }})"); time.sleep(0.3)
            sw = _gather(pg, d25, phone)
            places = sorted({x['where'] for x in sw})
            geo = {x['geo'] for x in sw}
            col = {(x['on'], x['col']) for x in sw}
            check(len(sw) > 20 and len(geo) == 1, f'{tag} {design} esquinas {r}: {len(sw)} interruptores en {len(places)} sitios, la misma forma ({" / ".join(sorted(geo))[:240]})')
            check(len(col) == 2, f'{tag} {design} esquinas {r}: los mismos colores encendido/apagado ({len(col)} combinaciones)')
            rs = {x['r'] for x in sw} | {x['kr'] for x in sw}
            if r == 0:
                check(rs == {'0px'}, f'{tag} {design} esquinas 0: todos rectos ({rs})')
            else:
                check('0px' not in rs, f'{tag} {design} esquinas 26: todos redondos ({rs})')
            if out:
                ev("Mix.openSettings('plugins')"); time.sleep(0.5)
                pg.screenshot(path=f'{out}/{tag}-sw-{design}-r{r}.png')
                ev("Mix.closeSettings()"); time.sleep(0.3)
        # the same vibration everywhere
        ev("Settings.set({ radius: 14 })")
        ev("Mix.openSettings('sound')"); time.sleep(0.5)
        _flip(pg, '#settings .stab.on .sw[data-set]:not([hidden])', check, f'{tag} {design} Ajustes')
        ev("Mix.openSettings('plugins')"); time.sleep(0.5)
        _flip(pg, '#pluginList [data-sw="sleep"]', check, f'{tag} {design} lista de plugins')
        ev("PluginsUI.open('video')"); time.sleep(0.4)
        _flip(pg, '#settings .sw[data-mv="blur"]', check, f'{tag} {design} página de un plugin')
        ev("PluginsUI.close()")
        ev("Mix.openSettings('look')"); time.sleep(0.5)
        _slide(pg, '#settings input[data-set="radius"]', check, f'{tag} {design} slider de Esquinas')
        ev("Settings.set({ radius: 14 })")
        ev("Mix.openSettings('sound')"); time.sleep(0.5)
        ev("document.querySelectorAll('#settings [data-adv]').forEach(e => e.hidden = false); document.querySelectorAll('#settings details').forEach(d => d.open = true)")
        _slide(pg, '#settings #eq60In', check, f'{tag} {design} slider del ecualizador')
        ev("Mix.closeSettings()"); time.sleep(0.3)
        ev("Dj.open()"); time.sleep(0.5); ev("document.querySelector('#djTrBtn')?.click()"); time.sleep(0.4)
        _flip(pg, '.djp .sw[data-tr]', check, f'{tag} {design} transiciones del DJ')
        ev("Dj.close()"); time.sleep(0.4)
        if d25:
            ev("V25.go('store')"); time.sleep(0.6)
            ev("document.querySelector('#v25 [data-det=\"sleep\"]')?.click()"); time.sleep(0.6)
            _flip(pg, '#v25 .v-switch[data-sw]', check, f'{tag} 2.5 tienda')
            ev("V25.go('home')"); time.sleep(0.4)
            if phone:
                ev("P25Prefs.open()"); time.sleep(0.7)
                _flip(pg, '.v-sheet .v-switch[data-sw="barLabels"]', check, f'{tag} 2.5 hoja de la barra')
                pg.keyboard.press('Escape'); time.sleep(0.4)
    ev("Settings.set({ radius: 14 })")
    ev(f"Mix.setDesign('{start_design}')"); time.sleep(1)
    ev("if (window.__hapReal) { ZT.haptic = window.__hapReal; delete window.__hapReal; }")
