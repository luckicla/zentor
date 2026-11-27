"""Botones de la 2.5 = estilo de Ajustes → Aspecto (web/v25/buttons.css). Lo usan tools/phonetest y tools/v25pctest.

Para varios estilos (presets de settings.js) compara el .play de Legacy (#btnPlay) con el play del reproductor
y el de una cabecera de álbum (.lv-playbig) de la 2.5: mismo border-radius y transform, fondo = acento (--acid),
y sombra desplazada solo donde Legacy la tiene. Después revisa que los botones de icono y los chips de la 2.5
tomen la forma de las esquinas (como .ibtn / .pill de Legacy)."""
import json, time

READ = """(sel) => { const e = document.querySelector(sel); if (!e) return null; const c = getComputedStyle(e);
  const t = document.createElement('i'); t.style.color = 'var(--acid)'; document.body.appendChild(t); const acid = getComputedStyle(t).color; t.remove();
  return { r: c.borderRadius, t: c.transform, bg: c.backgroundColor, acid, sh: c.boxShadow === 'none' ? '' : c.boxShadow, h: e.getBoundingClientRect().height }; }"""
PRESETS = ('legacy', 'retro', 'blend', 'crate')   # cuadrado torcido con sombra, redondo sin nada, fino


def buttons(pg, tag, check, out, phone):
    ev = pg.evaluate
    ev("Mix.playAll()"); time.sleep(0.8)
    play_sel = '.p25-fp-play' if phone else '.pc-play'
    for pid in PRESETS:
        ev(f"Mix.settings.set({{...PRESETS.find(p => p.id === '{pid}').set}})"); time.sleep(0.4)
        ev("Mix.setDesign('legacy')"); time.sleep(0.9)
        ref = ev(READ, '#btnPlay')
        ev("Mix.setDesign('v25')"); time.sleep(1.1)
        k = ev("Mix.albums()[0].key")
        ev("V25.go('album', { key: %s })" % json.dumps(k)); time.sleep(1.1)
        ply, head = ev(READ, play_sel), ev(READ, '.lv-playbig')
        check(bool(ref and ply and head), f'{tag} [{pid}]: hay play de Legacy, del reproductor y de la cabecera')
        if not (ref and ply and head): continue
        check(ply['r'] == ref['r'] == head['r'], f'{tag} [{pid}]: mismo border-radius que Legacy (Legacy {ref["r"]}, reproductor {ply["r"]}, cabecera {head["r"]})')
        check(ply['t'] == ref['t'] == head['t'], f'{tag} [{pid}]: mismo transform que Legacy (inclinación) ({ref["t"][:24]} / {ply["t"][:24]} / {head["t"][:24]})')
        check(ref['bg'] == ref['acid'] and ply['bg'] == ply['acid'] and head['bg'] == head['acid'], f'{tag} [{pid}]: fondo = color de acento ({ref["bg"]} / {ply["bg"]} / {head["bg"]})')
        check(bool(ref['sh']) == bool(ply['sh']) == bool(head['sh']), f'{tag} [{pid}]: sombra desplazada solo si Legacy la tiene ({bool(ref["sh"])} / {bool(ply["sh"])} / {bool(head["sh"])})')
        # the rest of the buttons take the corners' shape (Legacy: .ibtn / .pill = --r; Blend / Expressive: round; Crate: 4px)
        r = ev("parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--r')) || 0")
        ib = ev("(() => { const e = document.querySelector('#v25 .v-ibtn.lv-act, #v25 .v-ibtn.lv-headback'); return e ? getComputedStyle(e).borderRadius : null; })()")
        if ib is not None:
            want = '0px' if r <= 2 else {'blend': '50%'}.get(ev("document.documentElement.dataset.ls"), None)
            if want: check(ib == want, f'{tag} [{pid}]: botón de icono con la forma de las esquinas ({ib}, esperado {want})')
            else: check(ib != '50%' or r > 20, f'{tag} [{pid}]: botón de icono con la forma de las esquinas ({ib})')
        pg.screenshot(path=f'{out}/{tag}-btn-{pid}.png')
    ev("Mix.settings.set({...PRESETS.find(p => p.id === 'blend').set})")
