'use strict';

// Plugins and the store: the optional parts of MixUp.
//
// Every part of MixUp that isn't essential to play music is a plugin: it can
// be turned off, its buttons disappear everywhere, and its settings live on a
// page of its own (Ajustes → Plugins → the plugin). Themes, fonts and styles
// work the same way through the store (Store, below): what isn't installed
// doesn't show up in the pickers.
//
// Who already had MixUp before the plugins keeps everything installed and on
// (nothing changes for them); a new install starts simple, with only what's
// marked `starter`.
//
// A plugin's own code lives in web/plugins/<id>.js and only talks to the rest
// of the app through here:
//
//   Plugins.define('dj', {
//     onEnable() {},          // turned on (also at start, if it's on)
//     onDisable() {},         // turned off (also at start, if it's off)
//     page(el) {},            // (optional) fills its settings page, besides `tab`
//   });
//   Plugins.enabled('dj')     // true / false
//   Plugins.onChange(fn)      // fn(id, on) whenever one is turned on or off
//
// Any element of the interface that belongs to a plugin carries
// data-plugin="<id>": it's hidden while the plugin is off (or not installed).

const PLUGIN_CATALOG = [
  // kind: plugin | theme | font | style | layout
  // legacy: it existed before the plugins (whoever updates keeps it installed
  //   and on; a new install has it installed but off, to turn on in Ajustes → Plugins)
  // starter: a new install comes with it installed and on
  // tab: the settings section (Ajustes) that moves into the plugin's page
  // rows: a CSS selector of loose settings rows (.row) that move into its page
  { id: 'dj', kind: 'plugin', name: 'Modo DJ', desc: 'Mezcla las canciones como en una sesión: tempo, tono, energía y efectos.', legacy: true, tab: 'dj',
    icon: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/><path d="M12 5.6a6.4 6.4 0 0 1 6.4 6.4"/>' },
  { id: 'coveractions', kind: 'plugin', name: 'In Cover Actions', desc: 'Acciones sobre la portada: repetir un tramo, velocidad (x2) y más.', legacy: true,
    icon: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M10 8.5v7l5.5-3.5z"/>' },
  { id: 'perf', kind: 'plugin', name: 'Optimización', desc: 'Perfiles para gastar menos batería y procesador en móviles y PCs sencillos.', legacy: true, tab: 'perf',
    icon: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>' },
  { id: 'pclink', kind: 'plugin', name: 'Conectar por WiFi', desc: 'Sincroniza el PC y el móvil en la misma WiFi con un código QR.', legacy: true, tab: 'connect',
    icon: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1"/>' },
];

const Plugins = (() => {
  const root = document.documentElement;
  const cat = new Map(PLUGIN_CATALOG.map(p => [p.id, p]));
  const code = new Map();     // id -> { onEnable, onDisable, page }
  const listeners = [];
  const applied = new Map();  // id -> the last state the plugin's code was told
  const style = document.createElement('style');
  style.id = 'pluginsOff';
  document.head.appendChild(style);

  const st = () => Settings.get().plugins || {};
  // '*': 'all' (it had MixUp before the plugins) | 'new' (a new install)
  const mode = () => st()['*'] || 'all';
  function entry(id) { const e = st()[id]; return e && typeof e === 'object' ? e : null; }
  function installed(id) {
    const p = cat.get(id), e = entry(id);
    if (e && 'installed' in e) return !!e.installed;
    if (!p) return false;
    return !!p.legacy || !!p.starter;
  }
  function enabled(id) {
    if (!installed(id)) return false;
    const e = entry(id);
    if (e && 'on' in e) return e.on !== false;
    const p = cat.get(id);
    return mode() === 'all' || !p || !!p.starter;
  }
  function write(id, patch) {
    const all = { ...st() };
    all[id] = { ...(entry(id) || { installed: installed(id), on: enabled(id) }), ...patch };
    Settings.set({ plugins: all });
  }

  // the plugin's code hears its state, once per change
  function tell(id) {
    const c = code.get(id), on = enabled(id);
    if (applied.get(id) === on) return;
    applied.set(id, on);
    if (c) { try { on ? c.onEnable?.() : c.onDisable?.(); } catch (e) { console.error('plugin', id, e); } }
    listeners.forEach(fn => { try { fn(id, on); } catch (e) { console.error(e); } });
  }
  function paint() {
    const off = [...new Set([...cat.keys(), ...code.keys()])].filter(id => !enabled(id));
    style.textContent = off.map(id => `[data-plugin="${id}"]`).join(',') + (off.length ? '{display:none!important}' : '');
    off.forEach(id => root.classList.add('plg-off-' + id));
    [...cat.keys()].filter(id => enabled(id)).forEach(id => root.classList.remove('plg-off-' + id));
    for (const id of new Set([...cat.keys(), ...code.keys()])) tell(id);
  }

  function define(id, impl) {
    code.set(id, impl || {});
    if (!cat.has(id)) cat.set(id, { id, kind: 'plugin', name: id, desc: '', icon: '' });
    applied.delete(id);
    if (ready) paint();
  }
  // a plugin from outside the catalog (future store downloads) adds its card
  function describe(meta) { cat.set(meta.id, { kind: 'plugin', ...cat.get(meta.id), ...meta }); }

  function setEnabled(id, on) {
    if (on && !installed(id)) write(id, { installed: true, on: true });
    else write(id, { on: !!on });
    paint();
  }
  function install(id) { write(id, { installed: true, on: true }); paint(); }
  function uninstall(id) { write(id, { installed: false, on: false }); paint(); }

  let ready = false;
  function start() {
    ready = true;
    paint();
    Settings.onChange(() => paint());
  }

  return {
    define, describe, enabled, installed, setEnabled, install, uninstall, start,
    info: id => cat.get(id),
    list: kind => [...cat.values()].filter(p => !kind || p.kind === kind),
    page: id => code.get(id)?.page,
    onChange: fn => listeners.push(fn),
    mode,
  };
})();

// The store (not in the interface yet: the interface is being redesigned).
// It knows what can be installed — plugins, themes, fonts, styles, layouts —
// and installs or removes it. Installing is instant: everything comes inside
// MixUp already; the store only decides what shows up.
const Store = (() => {
  // what a new install starts with; the rest waits in the store (whoever updates has it all)
  const STARTER = {
    theme: ['neon', 'mono', 'paper', 'midnight'],
    style: ['blend', 'expressive', 'crate', 'modern'],
    font: ['vt', 'retro', 'bebas', 'ui:grotesk', 'ui:poppins'],   // 'ui:' = the interface's font
  };
  // the fonts (map §B): the song title's and the interface's. Their buttons live in index.html.
  const FONTS = [
    ['display', 'Recorte'], ['bungee', 'Bloque'], ['frak', 'Gótica'], ['type', 'Máquina'], ['bebas', 'Cartel'], ['marker', 'Marcador'],
    ['pixel', 'Píxel'], ['vt', 'Terminal'], ['neon', 'Neón'], ['glitchy', 'Glitch'], ['retro', 'Retro'], ['sweet', 'Dulce'],
    ['shade', 'Sombra'], ['rubik', 'Rubik'], ['play', 'Playfair'], ['syne', 'Syne'],
  ];
  const UI_FONT_NAMES = [
    ['original', 'Original'], ['system', 'Sistema'], ['poppins', 'Poppins'], ['nunito', 'Nunito'], ['grotesk', 'Grotesk'],
    ['mono', 'Mono'], ['syne', 'Syne'], ['retro', 'Retro'], ['vt', 'Terminal'],
  ];
  const themeId = id => 'theme:' + id;
  const styleId = id => 'style:' + id;
  const fontId = (id, ui) => 'font:' + (ui ? 'ui:' : '') + id;
  const presets = () => (typeof PRESETS !== 'undefined' ? PRESETS : []);
  const entries = () => Settings.get().plugins || {};
  // the catalog: plugins + one item per theme, style and font
  function items(kind) {
    const out = [];
    if (!kind || kind === 'plugin') out.push(...Plugins.list('plugin'));
    if ((!kind || kind === 'theme') && typeof THEMES !== 'undefined') {
      for (const t of THEMES) out.push({ id: themeId(t.id), kind: 'theme', name: t.name, colors: [t.bg, t.a1, t.a2, t.a3] });
    }
    if (!kind || kind === 'style') for (const p of presets()) out.push({ id: styleId(p.id), kind: 'style', name: p.name, desc: p.sub });
    if (!kind || kind === 'font') {
      for (const [id, name] of FONTS) out.push({ id: fontId(id), kind: 'font', of: 'title', name });
      for (const [id, name] of UI_FONT_NAMES) out.push({ id: fontId(id, true), kind: 'font', of: 'ui', name });
    }
    for (const p of Plugins.list()) if (!['plugin', 'theme', 'style', 'font'].includes(p.kind) && (!kind || p.kind === kind)) out.push(p);
    return out.map(i => ({ ...i, installed: has(i.id) }));
  }
  // is the style the one in use? (all of its settings are what's set)
  function styleInUse(pid) {
    const p = presets().find(x => x.id === pid), cur = Settings.get();
    return !!p && Object.entries(p.set).every(([k, v]) => JSON.stringify(cur[k] ?? null) === JSON.stringify(v));
  }
  function has(id) {
    const m = /^(theme|style|font):(.*)$/.exec(id);
    if (!m) return Plugins.installed(id);
    const [, kind, rest] = m, e = entries()[id], cur = Settings.get();
    if (e && 'installed' in e) return !!e.installed;
    // the one in use always counts as installed
    if (kind === 'theme' && cur.theme === rest) return true;
    if (kind === 'style' && styleInUse(rest)) return true;
    if (kind === 'font' && (rest.startsWith('ui:') ? cur.uiFont === rest.slice(3) : cur.font === rest)) return true;
    return Plugins.mode() === 'all' || STARTER[kind].includes(rest);
  }
  function mark(id, installed) {
    if (!/^(theme|style|font):/.test(id)) return false;
    Settings.set({ plugins: { ...entries(), [id]: { installed } } });
    try { document.dispatchEvent(new Event('store-change')); } catch {}
    return true;
  }
  function install(id) { if (!mark(id, true)) Plugins.install(id); }
  function uninstall(id) { if (!mark(id, false)) Plugins.uninstall(id); }
  return {
    items, has, install, uninstall,
    themes: () => (typeof THEMES !== 'undefined' ? THEMES : []).filter(t => has(themeId(t.id))),
    styles: () => presets().filter(p => has(styleId(p.id))),
    font: (id, ui) => has(fontId(id, ui)),
  };
})();
// the pickers in Ajustes (settings.js) were drawn before the store existed: filter them now
try { document.dispatchEvent(new Event('store-change')); } catch {}

// Normal and advanced settings: inside every section (and every plugin's
// page) the normal options come first and, further down, under «Avanzado»,
// the advanced ones. A row is advanced when it carries data-adv; this moves
// those rows, in their order, to the end of their section. Run at start and
// again on anything that adds rows.
const SettingsAdv = (() => {
  function arrange(root) {
    (root || document).querySelectorAll('.stab').forEach(sec => {
      const rows = [...sec.querySelectorAll(':scope > .row[data-adv], :scope > * > .row[data-adv]')].filter(r => !r.closest('.adv-box'));
      if (!rows.length) return;
      let box = sec.querySelector(':scope > .adv-box');
      if (!box) {
        box = document.createElement('div');
        box.className = 'adv-box';
        box.innerHTML = '<h3 class="adv-h">Avanzado</h3>';
        sec.append(box);
      }
      rows.forEach(r => box.append(r));
      // a heading left with nothing under it goes
      sec.querySelectorAll(':scope > h3').forEach(h => {
        let n = h.nextElementSibling, any = false;
        while (n && n.tagName !== 'H3' && !n.classList.contains('adv-box')) { if (!n.hidden && n.matches('.row, .presets, .themes, div')) { any = true; break; } n = n.nextElementSibling; }
        h.hidden = !any;
      });
    });
  }
  return { arrange };
})();

// Ajustes → Plugins: one card per installed plugin (switch + its page). The
// page takes the whole settings panel, with a back arrow, never a dropdown.
const PluginsUI = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ic = d => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  let panel, list, pageEl, openId = null;
  const moved = new Map(); // tab -> its section (moved into the plugin's page)

  function paintList() {
    if (!list) return;
    const ps = Plugins.list('plugin').filter(p => Plugins.installed(p.id));
    list.innerHTML = ps.length ? ps.map(p => `<div class="plg-card" data-id="${esc(p.id)}">
        <button type="button" class="plg-open" data-open="${esc(p.id)}"><span class="plg-ic">${ic(p.icon || '')}</span><span class="plg-tx"><b>${esc(p.name)}</b><small>${esc(p.desc)}</small></span><span class="plg-go" aria-hidden="true">›</span></button>
        <button class="sw${Plugins.enabled(p.id) ? ' on' : ''}" role="switch" aria-checked="${Plugins.enabled(p.id)}" data-sw="${esc(p.id)}" aria-label="${esc(p.name)}"></button>
      </div>`).join('') : '<p class="set-hint">No tienes plugins instalados.</p>';
  }

  function open(id) {
    const p = Plugins.info(id); if (!p) return;
    openId = id;
    pageEl.innerHTML = `<div class="plg-head"><button class="ibtn plg-back" aria-label="Volver a los plugins"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button><span class="plg-ic">${ic(p.icon || '')}</span><h2>${esc(p.name)}</h2><button class="sw${Plugins.enabled(id) ? ' on' : ''}" role="switch" aria-checked="${Plugins.enabled(id)}" data-sw="${esc(id)}" aria-label="${esc(p.name)}"></button></div>
      <p class="set-hint plg-desc">${esc(p.desc)}</p><div class="plg-body"></div><p class="set-hint plg-offnote">Está desactivado: sus botones no salen en ningún sitio.</p>`;
    const body = pageEl.querySelector('.plg-body');
    const key = p.tab || (p.rows ? 'plg:' + id : null);
    if (key && moved.get(key)) { const sec = moved.get(key); sec.classList.add('on'); body.append(sec); SettingsAdv.arrange(body); }
    try { Plugins.page(id)?.(body); } catch (e) { console.error(e); }
    pageEl.classList.toggle('off', !Plugins.enabled(id));
    pageEl.hidden = false;
    panel.classList.add('in-plugin');
    pageEl.scrollTop = 0;
  }
  function close() {
    if (!openId) return false;
    const p = Plugins.info(openId);
    const key = p && (p.tab || (p.rows ? 'plg:' + p.id : null));
    if (key && moved.get(key)) panel.querySelector('.set-body').append(moved.get(key)); // home again (bindings stay)
    moved.forEach(sec => sec.classList.remove('on'));
    openId = null;
    pageEl.hidden = true; pageEl.innerHTML = '';
    panel.classList.remove('in-plugin');
    paintList();
    return true;
  }

  function init() {
    panel = document.getElementById('settings');
    const tabs = document.getElementById('setTabs');
    const sec = panel?.querySelector('.stab[data-tab="plugins"]');
    if (!panel || !tabs || !sec) return;
    list = sec.querySelector('#pluginList');
    pageEl = document.createElement('section');
    pageEl.className = 'plg-page'; pageEl.hidden = true;
    pageEl.setAttribute('aria-label', 'Plugin');
    panel.append(pageEl);
    // the plugins' own sections leave the list of categories: they're reached from their card
    for (const p of Plugins.list('plugin')) {
      if (p.rows) {
        // loose rows: into a section of their own, only shown on the plugin's page
        const rs = [...panel.querySelectorAll(p.rows)];
        if (rs.length) {
          const sec = document.createElement('section');
          sec.className = 'stab plg-rows'; sec.dataset.tab = 'plg-' + p.id;
          rs.forEach(r => sec.append(r));
          panel.querySelector('.set-body').append(sec);
          moved.set('plg:' + p.id, sec);
        }
      }
      if (!p.tab) continue;
      const s = panel.querySelector(`.stab[data-tab="${p.tab}"]`), b = tabs.querySelector(`button[data-tab="${p.tab}"]`);
      if (s) moved.set(p.tab, s);
      if (b) { b.hidden = true; b.dataset.pluginTab = p.id; }
    }
    panel.addEventListener('click', e => {
      const sw = e.target.closest('[data-sw]');
      if (sw && panel.contains(sw)) {
        const id = sw.dataset.sw, on = !Plugins.enabled(id);
        Plugins.setEnabled(id, on);
        panel.querySelectorAll(`[data-sw="${id}"]`).forEach(b => { b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
        if (openId === id) pageEl.classList.toggle('off', !on);
        try { ZT.haptic(on ? 'select' : 'tap'); } catch {}
        return;
      }
      const o = e.target.closest('[data-open]');
      if (o) { open(o.dataset.open); return; }
      if (e.target.closest('.plg-back')) close();
    });
    // the phone's back button and closing the settings: out of the plugin first
    const prevBack = window.ztSetBack;
    window.ztSetBack = () => close() || (prevBack ? prevBack() : false);
    new MutationObserver(() => { if (!panel.classList.contains('open')) close(); }).observe(panel, { attributes: true, attributeFilter: ['class'] });
    Plugins.onChange(() => { if (!openId) paintList(); });
    paintList();
    SettingsAdv.arrange(panel);
  }

  return { init, open, close, paint: paintList };
})();

// (texts in English and Catalan: i18n.js)
I18N.add({
 "Modo DJ": [
  "DJ mode",
  "Mode DJ"
 ],
 "Mezcla las canciones como en una sesión: tempo, tono, energía y efectos.": [
  "Mixes your songs like a DJ set: tempo, key, energy and effects.",
  "Barreja les cançons com en una sessió: tempo, to, energia i efectes."
 ],
 "Acciones sobre la portada: repetir un tramo, velocidad (x2) y más.": [
  "Actions on the cover: repeat a section, speed (x2) and more.",
  "Accions sobre la portada: repetir un tram, velocitat (x2) i més."
 ],
 "Optimización": [
  "Optimisation",
  "Optimització"
 ],
 "Perfiles para gastar menos batería y procesador en móviles y PCs sencillos.": [
  "Profiles to use less battery and processor on modest phones and PCs.",
  "Perfils per gastar menys bateria i processador en mòbils i PCs senzills."
 ],
 "Conectar por WiFi": [
  "Connect over Wi-Fi",
  "Connectar per WiFi"
 ],
 "Sincroniza el PC y el móvil en la misma WiFi con un código QR.": [
  "Syncs the PC and the phone on the same Wi-Fi with a QR code.",
  "Sincronitza el PC i el mòbil a la mateixa WiFi amb un codi QR."
 ],
 "Plugins": [
  "Plugins",
  "Plugins"
 ],
 "Activar, quitar y configurar cada plugin": [
  "Turn on, remove and set up each plugin",
  "Activar, treure i configurar cada plugin"
 ],
 "Las partes de MixUp que no hacen falta para escuchar música. Desactiva las que no uses y sus botones desaparecen; toca una para ver sus ajustes.": [
  "The parts of MixUp you don't need to listen to music. Turn off the ones you don't use and their buttons disappear; tap one to see its settings.",
  "Les parts de MixUp que no calen per escoltar música. Desactiva les que no facis servir i els seus botons desapareixen; toca'n una per veure'n els ajustos."
 ],
 "No tienes plugins instalados.": [
  "You have no plugins installed.",
  "No tens cap plugin instal·lat."
 ],
 "Está desactivado: sus botones no salen en ningún sitio.": [
  "It's off: its buttons don't show up anywhere.",
  "Està desactivat: els seus botons no surten enlloc."
 ],
 "Avanzado":["Advanced","Avançat"],"Volver a los plugins": [
  "Back to the plugins",
  "Tornar als plugins"
 ]
});
