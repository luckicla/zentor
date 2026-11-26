'use strict';
// Tienda de MixUp 2.5 (móvil y PC): plugins con arte propio (web/v25/art/*.svg),
// temas, estilos y tipografías. Todo viene dentro de MixUp: instalar es
// instantáneo (con una animación corta) y los plugins se actualizan con la app.
// Solo usa `Mix` y `V25` (notas/CORE-API.md).
(() => {
  const { esc, icon, html } = V25;
  const ALIVE = { on: false };

  /* ---------------- lo que contamos de cada plugin ---------------- */
  // cat: sound | player | connect | library | system. news: novedades (la primera es la última).
  const CATS = [['sound', 'Sonido y mezcla'], ['player', 'Reproductor'], ['connect', 'Nube y conexión'], ['library', 'Biblioteca'], ['system', 'Rendimiento']];
  const ORDER = ['dj', 'video', 'livelyrics', 'enhance', 'gdrive', 'coveractions', 'upnext', 'sleep', 'share', 'pclink', 'artistinfo', 'dedup', 'infobar', 'logo', 'perf'];
  const FEATURED = ['dj', 'video', 'livelyrics', 'enhance', 'gdrive'];
  const META = {
    dj: {
      cat: 'sound', tag: 'Mezcla tus canciones como en una cabina',
      long: 'Convierte MixUp en una sesión de DJ: las canciones se encadenan igualando el tempo y el tono, con transiciones de energía y efectos para que la música no se corte nunca. Tú decides cuánto interviene: déjalo en automático o toma los mandos.',
      hl: ['Igualado de tempo y tono entre canciones', 'Mezcla por energía: la sesión sube y baja sola', 'Efectos y transiciones para pasar de una a otra', 'Se abre con un gesto hacia la derecha en el reproductor'],
      chg: ['Aparece el botón DJ arriba a la derecha del reproductor grande', 'Se añade su pantalla de ajustes (tempo, tono, energía y efectos)', 'Con el plugin apagado todo suena como siempre'],
      news: ['Nuevo botón en el reproductor grande y gesto hacia la derecha para abrirlo'], files: ['plugins/dj.js', 'dj.js', 'djwork.js'],
    },
    video: {
      cat: 'player', tag: 'El videoclip de tu canción, al compás', isNew: true,
      long: 'Pon el vídeo de la canción sin salir de MixUp: va sin sonido y sincronizado con tu audio, así que sigues escuchando exactamente lo mismo, pero con imagen. Elige dónde se ve: detrás de todo, en la portada, en los dos sitios o solo mientras mantienes pulsada la portada.',
      hl: ['Sin sonido: el audio sigue siendo el tuyo', 'Sincronizado con la música', 'Detrás, en la portada, en los dos sitios o al mantener pulsado', 'Con la portada entera de fondo, eliges vídeo o solo portada'],
      chg: ['La portada puede mostrar el vídeo de la canción', 'Se añade la acción «mantener pulsado» de In Cover Actions para verlo', 'Su pantalla de ajustes elige dónde sale el vídeo'],
      news: ['Nuevo en MixUp 2.5: el vídeo de la canción como plugin'],
    },
    livelyrics: {
      cat: 'player', tag: 'La letra, justo cuando suena',
      long: 'Busca en internet la letra con tiempos y la muestra a la vez que suena, palabra a palabra, para que cantes sin perderte. Se abre desde el reproductor con un botón y ocupa toda la pantalla si quieres.',
      hl: ['Letra con tiempos que avanza sola', 'Se resalta palabra a palabra', 'Se busca sola en internet', 'Un botón en el reproductor para abrirla'],
      chg: ['Aparece el botón de letra en el reproductor', 'Se añade su sección en los ajustes', 'Sin el plugin no se busca ninguna letra'],
      news: ['El botón de letra vive en el reproductor grande de la interfaz 2.5'],
    },
    enhance: {
      cat: 'sound', tag: 'Más claro, incluso con auriculares baratos',
      long: 'Suena más limpio con auriculares baratos y con Bluetooth, y recupera los agudos que le faltan a las canciones de poca calidad. Se activa o se apaga con un toque y no toca tus archivos: solo cambia cómo suenan al reproducirse.',
      hl: ['Sonido más limpio con auriculares baratos y Bluetooth', 'Recupera agudos en canciones de poca calidad', 'Se enciende y se apaga con un toque', 'No modifica tus archivos'],
      chg: ['Se añade «Mejorar sonido» en los ajustes', 'El audio pasa por el filtro mientras esté encendido', 'Apagado, suena igual que antes'],
      news: ['Listo para la interfaz 2.5, sin cambios en el sonido'],
    },
    gdrive: {
      cat: 'connect', tag: 'Tu música igual en todos tus aparatos',
      long: 'Mantén tu música, playlists y ajustes iguales en el PC y en el móvil usando tu propio Google Drive. Inicias sesión una vez y MixUp se encarga de subir y bajar los cambios. Con la cuenta conectada, el botón de ajustes de la interfaz nueva puede mostrar tu foto.',
      hl: ['Música, playlists y ajustes iguales en todos tus aparatos', 'Usas tu propio Google Drive: tu cuenta, tus datos', 'Tu foto en el botón de ajustes del 2.5', 'Las copias «(2)» tras sincronizar se limpian solas con Canciones repetidas'],
      chg: ['Se añade «Sincronización» en los ajustes, con el inicio de sesión de Google', 'Tus aparatos empiezan a compartir biblioteca y ajustes', 'Sin el plugin, cada aparato va por su cuenta'],
      news: ['La foto de tu cuenta puede salir en el botón de ajustes del 2.5'],
    },
    coveractions: {
      cat: 'player', tag: 'Controla la música desde la portada',
      long: 'Pulsa y mantén la portada para repetir un tramo, duplicar la velocidad (x2) y más acciones rápidas, sin salir del reproductor. Ideal para aprender un solo, repasar una frase o saltarte el relleno.',
      hl: ['Repetir un tramo con un toque', 'Velocidad x2', 'Acciones al mantener pulsado, a tu gusto', 'Compatible con el vídeo de la canción'],
      chg: ['La portada gana acciones al pulsar y mantener', 'Se añade su sección en los ajustes para elegir cada gesto', 'Sin el plugin, la portada solo se ve'],
      news: ['Nueva acción «ver el vídeo» al mantener pulsado (necesita el plugin de vídeo)'],
    },
    upnext: {
      cat: 'player', tag: 'Mira qué viene después',
      long: 'Una línea bajo el reproductor con la canción que viene. Tócala y saltas directo a ella. Sencillo, discreto y siempre a la vista.',
      hl: ['La siguiente canción siempre visible', 'Un toque para saltar a ella', 'Respeta la cola y el modo DJ'],
      chg: ['Aparece una línea bajo el reproductor', 'Sin el plugin esa línea desaparece'],
      news: ['En el 2.5 también se ve arriba del reproductor grande'],
    },
    sleep: {
      cat: 'player', tag: 'Duérmete con tu música',
      long: 'Apaga la música pasados unos minutos o cuando acabe la canción, para quedarte dormido con ella sin dejarla sonando toda la noche.',
      hl: ['Elige los minutos o «al acabar la canción»', 'La música se para sola', 'Un botón en el reproductor'],
      chg: ['Se añade el temporizador al reproductor', 'Su pantalla de ajustes guarda tus tiempos'],
      news: ['Sin cambios: funciona igual con la interfaz 2.5'],
    },
    share: {
      cat: 'connect', tag: 'Manda canciones a quien quieras',
      long: 'Desde el menú de cada canción, manda a otra app o persona el archivo o un enlace. Un par de toques y lista.',
      hl: ['Comparte el archivo o un enlace', 'Desde el menú ⋮ de cada canción', 'A cualquier app o persona'],
      chg: ['El menú de cada canción gana la opción «Compartir»', 'Sin el plugin la opción no aparece'],
      news: ['Disponible en el menú de canción del 2.5'],
    },
    pclink: {
      cat: 'connect', tag: 'Móvil y PC en la misma WiFi',
      long: 'Sincroniza el PC y el móvil dentro de la misma red WiFi con un código QR. Sin cables y sin cuentas: escaneas y quedan conectados.',
      hl: ['Emparejado con un código QR', 'Funciona en tu red WiFi', 'Sin cables'],
      chg: ['Aparece la tarjeta de conexión con el código QR en los ajustes', 'Sin el plugin, esa tarjeta se oculta'],
      news: ['Sin cambios: ya funciona con la interfaz nueva'],
    },
    artistinfo: {
      cat: 'library', tag: 'Conoce a quien escuchas', plat: 'Solo PC',
      long: 'Foto y biografía del artista que suena, con datos de Deezer y Wikipedia. Necesita conexión a internet y está pensado para la pantalla grande del PC.',
      hl: ['Foto del artista que suena', 'Biografía de Wikipedia', 'Datos de Deezer'],
      chg: ['El PC muestra la ficha del artista mientras suena su canción', 'Sin el plugin no se consulta nada en internet'],
      news: ['Sin cambios: ya funciona con el panel del PC'],
    },
    dedup: {
      cat: 'library', tag: 'Una sola copia de cada canción',
      long: 'Busca copias de la misma canción y deja solo la mejor. Las copias «(2)» que aparecen tras sincronizar se limpian solas, para que tu biblioteca no se llene de repetidas.',
      hl: ['Encuentra copias de la misma canción', 'Se queda con la mejor', 'Limpia solo las copias «(2)» tras sincronizar'],
      chg: ['Se añade la herramienta en los ajustes de la biblioteca', 'Tras sincronizar, las copias sobrantes se limpian solas'],
      news: ['Sin cambios: compatible con la biblioteca del 2.5'],
    },
    infobar: {
      cat: 'player', tag: 'Volumen y datos, siempre a mano', plat: 'Móvil',
      long: 'Lo de abajo del todo en el móvil: el volumen y la información (canciones, duración, formato). Tú eliges qué se ve.',
      hl: ['Volumen siempre a mano', 'Número de canciones, duración y formato', 'Elige qué se ve'],
      chg: ['Aparece la barra inferior en el móvil', 'Sin el plugin la barra desaparece'],
      news: ['Sin cambios: en el 2.5 el volumen también está en el reproductor grande'],
    },
    logo: {
      cat: 'player', tag: 'Pon tu propio nombre arriba',
      long: 'Cambia el logo de arriba: usa tu propio texto, quítalo del todo o ajusta los colores de cada una de sus letras.',
      hl: ['Tu propio texto como logo', 'Sin logo, si prefieres', 'Colores de las letras a tu gusto'],
      chg: ['El logo de arriba se puede personalizar', 'Sin el plugin vuelve el logo de siempre'],
      news: ['Sin cambios: el logo se ve en la cabecera de la interfaz Legacy'],
    },
    perf: {
      cat: 'system', tag: 'Menos batería, más soltura',
      long: 'Perfiles para que MixUp gaste menos batería y procesador en móviles y PCs sencillos. Recorta animaciones, desenfoques y efectos pesados cuando no hacen falta, sin tocar el sonido.',
      hl: ['Perfiles de un toque', 'Quita desenfoques y animaciones costosas', 'Se nota en móviles con poca memoria', 'El sonido no cambia'],
      chg: ['Se añade «Optimización» en los ajustes', 'Los efectos pesados se atenúan según el perfil', 'En el 2.5, con Optimización alta se reducen el movimiento y el desenfoque'],
      news: ['La interfaz 2.5 respeta los perfiles: menos movimiento y desenfoque'],
    },
  };
  const metaOf = p => META[p.id] || { cat: 'player', tag: (p.desc || '').split(/[.:]/)[0], long: p.desc || '', hl: [], chg: [], news: ['Incluido en MixUp'] };
  const tagOf = p => metaOf(p).tag;

  const TABS = [['discover', 'Descubrir'], ['plugin', 'Plugins'], ['theme', 'Temas'], ['style', 'Estilos'], ['font', 'Tipografías'], ['installed', 'Instalados']];
  const KIND_NAME = { plugin: 'Plugins', theme: 'Temas', style: 'Estilos', font: 'Tipografías' };

  /* ---------------- estado de la vista (sobrevive a ir y volver de una ficha) ---------------- */
  const S = { tab: 'discover', q: '', cat: 'all', appVer: '', upd: { state: 'idle', text: '' } };
  let host = null, offs = [], heroT = 0, busy = 0, dirty = false, justId = '', sig = '', sheetOpen = null;

  /* ---------------- arte ---------------- */
  const artCache = new Map();   // id -> svg text | null (no existe) | Promise
  let artN = 0;
  const unique = svg => {
    const n = ++artN;
    const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    let out = svg;
    for (const id of ids) out = out.split(`id="${id}"`).join(`id="${id}-${n}"`).split(`url(#${id})`).join(`url(#${id}-${n})`);
    return out;
  };
  function loadArt(id) {
    if (artCache.has(id)) return artCache.get(id);
    const p = fetch(`v25/art/${id}.svg`).then(r => (r.ok ? r.text() : null)).catch(() => null).then(t => { const ok = t && /^\s*<svg/.test(t) ? t : null; artCache.set(id, ok); return ok; });
    artCache.set(id, p);
    return p;
  }
  const artBox = (id, cls = '') => `<span class="st-art ${cls}" data-art="${esc(id)}">${icon('store', 24)}</span>`;
  function hydrate(root) {
    root.querySelectorAll('[data-art]:not([data-done])').forEach(box => {
      const id = box.dataset.art;
      const put = svg => { if (!box.isConnected) return; box.dataset.done = '1'; if (svg) box.innerHTML = unique(svg); };
      const c = artCache.get(id);
      if (typeof c === 'string') return put(c);
      Promise.resolve(c === undefined ? loadArt(id) : c).then(t => { if (typeof t === 'string') put(t); else if (id !== 'generic') { box.dataset.art = 'generic'; hydrate(box.parentNode || root); } else box.dataset.done = '1'; });
    });
  }

  /* ---------------- datos ---------------- */
  const plugins = () => Mix.plugins.list().slice().sort((a, b) => { const i = ORDER.indexOf(a.id), j = ORDER.indexOf(b.id); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j); });
  const plugin = id => Mix.plugins.list().find(p => p.id === id);
  const items = k => Mix.store.items(k);
  const cur = () => Mix.settings.get();
  const themeById = id => Mix.settings.themeList().find(t => t.id === id);
  const styleInUse = p => { const c = cur(); return Object.entries(p.set).every(([k, v]) => JSON.stringify(c[k] ?? null) === JSON.stringify(v)); };
  const sizes = new Map();
  async function sizeOf(id) {
    if (sizes.has(id)) return sizes.get(id);
    const files = metaOf({ id }).files || [`plugins/${id}.js`, `plugins/${id}.css`];
    let n = 0;
    await Promise.all(files.map(f => fetch(f, { cache: 'force-cache' }).then(async r => { if (r.ok && !/html/.test(r.headers.get('content-type') || '')) n += (await r.text()).length; }).catch(() => {})));
    sizes.set(id, n); return n;
  }
  const fmtSize = n => (n ? (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`) : '—');
  const verLabel = () => S.appVer || '2.5';

  /* ---------------- piezas de HTML ---------------- */
  const getBtn = (id, o = {}) => `<button type="button" class="st-get${o.big ? ' big' : ''}" data-install="${esc(id)}"${o.dur ? ` data-dur="${o.dur}"` : ''} aria-label="Instalar ${esc(o.name || '')}"><span class="st-get-fill"></span><span class="st-get-lb">${icon('download', 16)}<span>Instalar</span></span></button>`;
  const chip = (txt, cls = '', ic = '') => `<span class="st-chip ${cls}">${ic ? icon(ic, 12) : ''}${esc(txt)}</span>`;
  const pluginAct = (p, o = {}) => p.installed
    ? (p.hasPage ? `<button type="button" class="st-open${o.big ? ' big' : ''}" data-page="${esc(p.id)}">${o.big ? icon('settings', 18) : ''}Abrir</button>` : chip('Instalado', 'ok', 'check'))
    : getBtn(p.id, { name: p.name, big: o.big });
  const pluginChips = p => {
    const m = metaOf(p), c = [];
    if (m.isNew) c.push(chip('Nuevo', 'new'));
    if (p.installed) c.push(chip('Actualizado', 'ok', 'check'));
    if (m.plat) c.push(chip(m.plat));
    return c.join('');
  };
  const card = (p, shelf) => `<article class="st-card" data-id="${esc(p.id)}" data-det="${esc(p.id)}" role="button" tabindex="0" aria-label="${esc(p.name)}">${artBox(p.id, 'cv')}<div class="st-card-tx"><b>${esc(p.name)}</b><small>${esc(tagOf(p))}</small></div><div class="st-card-act"><span class="st-chips">${pluginChips(p)}</span>${pluginAct(p)}</div></article>`;
  const irow = p => `<div class="st-irow" data-det="${esc(p.id)}" role="button" tabindex="0">${artBox(p.id, 'cv')}<span class="st-irow-tx"><b>${esc(p.name)}</b><small>${esc(p.enabled ? 'Actualizado' : 'Apagado')} · MixUp ${esc(verLabel())}</small><small class="nw">${esc(metaOf(p).news[0] || '')}</small></span><button type="button" class="v-switch${p.enabled ? ' on' : ''}" role="switch" aria-checked="${p.enabled}" aria-label="Activar ${esc(p.name)}" data-sw="${esc(p.id)}"></button></div>`;

  function updCard() {
    const u = S.upd, auto = cur().autoUpdate !== false;
    const spin = u.state === 'checking';
    const title = { idle: 'MixUp está al día', checking: 'Buscando actualizaciones…', ok: 'Todo al día', ready: 'Hay una versión nueva', started: 'Buscando actualizaciones…', error: 'No se pudo comprobar', unknown: 'Todo al día' }[u.state];
    const sub = u.text || (auto ? `Los plugins vienen dentro de MixUp${S.appVer ? ` ${S.appVer}` : ''} y se actualizan con la app, solos.` : 'La actualización automática está apagada: busca versiones nuevas a mano.');
    return `<div class="st-upd"><div class="st-upd-head"><span class="st-upd-ic${spin ? ' spin' : ''}">${icon(u.state === 'ok' || u.state === 'idle' || u.state === 'unknown' ? 'check' : 'download', 22)}</span><span><b>${esc(title)}</b><small>${esc(sub)}</small></span></div>
      <div class="st-upd-row"><span><b>Actualizar automáticamente</b><small>MixUp baja las versiones nuevas por su cuenta, plugins incluidos.</small></span><button type="button" class="v-switch${auto ? ' on' : ''}" role="switch" aria-checked="${auto}" aria-label="Actualizar automáticamente" data-auto></button></div>
      <div class="st-upd-btns"><button type="button" class="st-get alt" data-check${spin ? ' disabled' : ''}><span class="st-get-lb">${icon('download', 16)}<span>${spin ? 'Buscando…' : 'Buscar actualizaciones'}</span></span></button></div></div>`;
  }

  /* ---------------- pestañas ---------------- */
  function heroSlide(p) {
    const m = metaOf(p);
    return `<div class="st-slide" data-id="${esc(p.id)}" data-det="${esc(p.id)}" role="group" aria-label="${esc(p.name)}">${artBox(p.id)}<div class="st-slide-tx"><span class="st-kick">${m.isNew ? 'Nuevo en 2.5' : 'Destacado'}</span><b>${esc(p.name)}</b><p>${esc(m.tag)}</p>${pluginAct(p)}</div></div>`;
  }
  const shelfHtml = (title, inner, more) => `<section><h2 class="st-h">${esc(title)}${more ? `<button type="button" data-tab="${more[0]}">${esc(more[1])}</button>` : ''}</h2><div class="st-shelf-row">${inner}</div></section>`;

  function viewDiscover() {
    const ps = plugins(), by = id => ps.find(p => p.id === id);
    const feat = FEATURED.map(by).filter(Boolean);
    const out = [];
    if (feat.length) out.push(`<div class="st-hero"><div class="st-hero-row" data-hero>${feat.map(heroSlide).join('')}</div><div class="st-dots">${feat.map((_, i) => `<button type="button" class="${i ? '' : 'on'}" data-dot="${i}" aria-label="Destacado ${i + 1}"></button>`).join('')}</div></div>`);
    out.push(updCard());
    const nw = ps.filter(p => metaOf(p).isNew);
    if (nw.length) out.push(shelfHtml('Novedades de MixUp 2.5', nw.map(p => card(p)).join('')));
    for (const [cid, cname] of CATS) { const l = ps.filter(p => metaOf(p).cat === cid && !metaOf(p).isNew); if (l.length) out.push(shelfHtml(cname, l.map(p => card(p)).join(''))); }
    const th = items('theme').slice(0, 12);
    out.push(shelfHtml('Temas', th.map(themeCard).join(''), ['theme', 'Ver todos']));
    return out.join('');
  }
  function viewPlugins() {
    const ps = plugins().filter(p => S.cat === 'all' || metaOf(p).cat === S.cat);
    return `<div class="v-seg" role="group" aria-label="Categorías">${[['all', 'Todos'], ...CATS].map(([v, l]) => `<button type="button" data-cat="${v}" class="${v === S.cat ? 'sel' : ''}">${esc(l)}</button>`).join('')}</div>
      <div class="st-grid">${ps.map(p => card(p)).join('') || empty('No hay plugins en esta categoría')}</div>`;
  }
  const empty = t => `<div class="st-empty">${icon('store', 34)}<p>${esc(t)}</p></div>`;

  /* temas */
  function themeCard(t) {
    const th = themeById(t.id.replace(/^theme:/, '')) || {}, id = t.id, use = cur().theme === id.slice(6);
    const c = { bg: th.bg || '#000', sf: th.surface || '#111', fg: th.fg || '#fff', mu: th.muted || '#888', a1: th.a1 || '#fff', a2: th.a2 || '#aaa', a3: th.a3 || '#666' };
    return `<div class="st-tc${use ? ' sel' : ''}" data-id="${esc(id)}"><div class="st-tp" style="background:${c.bg};color:${c.fg}"><div class="st-tp-card" style="background:${c.sf}"><i class="st-tp-cv" style="background:linear-gradient(135deg,${c.a1},${c.a2})"></i><span class="st-tp-ln"><i style="background:${c.fg};width:70%"></i><i style="background:${c.mu};width:44%"></i></span></div><div class="st-tp-dots"><i style="background:${c.a1}"></i><i style="background:${c.a2}"></i><i style="background:${c.a3}"></i><em style="background:${c.a1};color:${c.bg}">Aa</em></div></div>
      <div class="st-tc-tx"><b>${esc(t.name)}</b><small>${use ? 'El que usas ahora' : t.installed ? 'Instalado' : 'Incluido en MixUp'}</small></div>
      <div class="st-tc-act">${tcAct(t, use, 'theme')}</div></div>`;
  }
  function tcAct(t, use, kind) {
    if (!t.installed) return getBtn(t.id, { name: t.name, dur: 600 });
    if (use) return `<span class="st-open on" aria-live="polite">${icon('check', 16)}En uso</span>${kind === 'x' ? '' : ''}`;
    return `<button type="button" class="st-open" data-use="${esc(t.id)}">Usar</button><button type="button" class="st-ix" data-un="${esc(t.id)}" aria-label="Quitar ${esc(t.name)}" title="Quitar">${icon('close', 16)}</button>`;
  }
  const viewThemes = () => `<p class="st-note">Toca «Usar» y MixUp cambia de colores al momento. Quitar un tema solo lo oculta de tus listas: puedes volver a instalarlo cuando quieras.</p><div class="st-cards">${items('theme').map(themeCard).join('')}</div>`;

  /* estilos */
  function styleCard(it) {
    const p = Mix.settings.presets().find(x => x.id === it.id.replace(/^style:/, '')); if (!p) return '';
    const th = themeById(p.set.theme) || {}, ac = p.set.accents || th, r = Math.min(p.set.radius || 0, 14);
    const ff = p.set.font ? `var(--f-${p.set.font})` : 'inherit', use = styleInUse(p);
    return `<div class="st-tc${use ? ' sel' : ''}" data-id="${esc(it.id)}"><div class="st-sp" style="--pv-bg:${th.bg};--pv-fg:${th.fg};--pv-a1:${ac.a1};--pv-a2:${ac.a2};--pv-r:${r}px"><div class="st-sp-ph"><i class="st-sp-cv${p.set.coverFull ? ' full' : ''}"></i><b class="st-sp-t" style="font-family:${ff}">MixUp</b><i class="st-sp-bar"></i><i class="st-sp-pl"></i></div></div>
      <div class="st-tc-tx"><b>${esc(it.name)}</b><small>${esc(p.sub || '')}</small></div><div class="st-tc-act">${tcAct(it, use, 'style')}</div></div>`;
  }
  const viewStyles = () => `<p class="st-note">Un estilo cambia el aspecto entero de MixUp de golpe: colores, esquinas, letras y portada. Después puedes retocar lo que quieras en Ajustes.</p><div class="st-cards">${items('style').map(styleCard).join('')}</div>`;

  /* tipografías */
  const NOUP = new Set(['frak', 'type', 'play', 'sweet', 'marker']);
  const UIF = { original: 'var(--f-mono)', system: "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", poppins: "'Poppins',sans-serif", nunito: "'Nunito',sans-serif", grotesk: "'Space Grotesk',sans-serif", mono: "'Space Mono',monospace", syne: "'Syne',sans-serif", retro: "'Righteous',sans-serif", vt: "'VT323',monospace" };
  const FALLBACK = 'Georgia, serif';
  let cvs = null;
  const fontOk = fam => {   // is the web font really there? (no internet: no)
    const first = (/^var\(--f-(\w+)\)$/.exec(fam) ? getComputedStyle(document.documentElement).getPropertyValue(fam.slice(4, -1)) : fam).split(',')[0].trim();
    if (!first || /^(system-ui|sans-serif|monospace|serif|-apple-system)$/i.test(first.replace(/['"]/g, ''))) return true;
    cvs = cvs || document.createElement('canvas').getContext('2d');
    const w = f => { cvs.font = `40px ${f}`; return cvs.measureText('Wmi@gq0ñ').width; };
    return w(`${first}, monospace`) !== w('monospace') || w(`${first}, serif`) !== w('serif');
  };
  function fontCard(it) {
    const ui = it.of === 'ui', raw = it.id.replace(/^font:(ui:)?/, ''), fam = ui ? (UIF[raw] || 'inherit') : `var(--f-${raw})`;
    const use = ui ? cur().uiFont === raw : cur().font === raw, ok = fontOk(fam);
    const a = ui ? 'Tu música, tu manera' : (NOUP.has(raw) ? 'Tu canción' : 'TU CANCIÓN');
    return `<div class="st-tc${use ? ' sel' : ''}" data-id="${esc(it.id)}"><div class="st-fp${ui ? ' ui' : ''}"><span class="st-fp-a" style="font-family:${fam},${FALLBACK}">${esc(a)}</span><span class="st-fp-b" style="font-family:${fam},${FALLBACK}">abcdefg 0123456789</span>${ok ? '' : chip('Sin conexión')}</div>
      <div class="st-tc-tx"><b>${esc(it.name)}</b><small>${ok ? (ui ? 'Para toda la interfaz' : 'Para el título de la canción') : 'Necesita internet para verse así'}</small></div><div class="st-tc-act">${tcAct(it, use, 'font')}</div></div>`;
  }
  const viewFonts = () => {
    const f = items('font');
    return `<h2 class="st-sub">Letra del título de la canción</h2><div class="st-cards">${f.filter(i => i.of !== 'ui').map(fontCard).join('')}</div><h2 class="st-sub">Letra de toda la interfaz</h2><div class="st-cards">${f.filter(i => i.of === 'ui').map(fontCard).join('')}</div>`;
  };

  /* instalados */
  function viewInstalled() {
    const ps = plugins().filter(p => p.installed);
    const cnt = k => items(k).filter(i => i.installed).length;
    const row = (k, t) => `<button type="button" class="st-box st-srow" data-tab="${k}"><span><b>${t}</b><small>${cnt(k)} instalados</small></span>${icon('back', 18).replace('<svg ', '<svg style="transform:rotate(180deg)" ')}</button>`;
    return `${updCard()}<h2 class="st-h">Plugins instalados<small>${ps.length}</small></h2>${ps.length ? `<div class="st-list">${ps.map(irow).join('')}</div>` : empty('Aún no has instalado ningún plugin')}
      <h2 class="st-h">Aspecto</h2><div class="st-list">${row('theme', 'Temas')}${row('style', 'Estilos')}${row('font', 'Tipografías')}</div>`;
  }

  /* búsqueda */
  function viewSearch(q) {
    const n = q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const hit = (...t) => t.join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(n);
    const ps = plugins().filter(p => hit(p.name, p.desc, metaOf(p).tag, metaOf(p).long));
    const th = items('theme').filter(i => hit(i.name, 'tema'));
    const st = items('style').filter(i => hit(i.name, i.desc || '', 'estilo'));
    const fo = items('font').filter(i => hit(i.name, 'tipografia letra fuente'));
    const sec = (t, inner) => inner ? `<h2 class="st-h">${esc(t)}</h2>${inner}` : '';
    const out = sec('Plugins', ps.length ? `<div class="st-grid">${ps.map(p => card(p)).join('')}</div>` : '')
      + sec('Temas', th.length ? `<div class="st-cards">${th.map(themeCard).join('')}</div>` : '')
      + sec('Estilos', st.length ? `<div class="st-cards">${st.map(styleCard).join('')}</div>` : '')
      + sec('Tipografías', fo.length ? `<div class="st-cards">${fo.map(fontCard).join('')}</div>` : '');
    return out || empty(`Nada para «${q}». Prueba con otra palabra: «sonido», «letra», «tema»…`);
  }

  /* ---------------- ficha de un plugin ---------------- */
  function viewDetail(id) {
    const p = plugin(id);
    if (!p) return `<div class="st">${empty('Este plugin no existe')}</div>`;
    const m = metaOf(p);
    const chg = [...(m.chg || [])];
    return `<div class="st-det" data-id="${esc(id)}"><div class="st-ban">${artBox(id)}<button type="button" class="st-back" data-back aria-label="Volver">${icon('back', 22)}</button></div>
      <div class="st-det-body">
        <div class="st-det-head">${artBox(id, 'cv')}<span><h2>${esc(p.name)}</h2><small>${esc(m.tag)}</small><span class="st-chips">${pluginChips(p)}</span></span></div>
        <div class="st-det-act" data-act>${detActions(p)}</div>
        <div class="st-two"><div class="st-box"><h3>Acerca de</h3><p>${esc(m.long)}</p>${m.hl.length ? `<h3>Lo mejor</h3><ul class="st-ul">${m.hl.map(h => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}</div>
          <div style="display:flex;flex-direction:column;gap:var(--v-s4)">
            <div class="st-box"><h3>Información</h3><div class="st-info"><div><small>Versión</small><b data-ver>${esc(verLabel())}</b></div><div><small>Tamaño</small><b data-size>…</b></div><div><small>Disponible</small><b>Incluido en MixUp</b></div><div><small>Categoría</small><b>${esc((CATS.find(c => c[0] === m.cat) || [])[1] || 'Plugin')}</b></div></div></div>
            <div class="st-box"><h3>Novedades</h3>${(m.news || []).map((t, i) => `<div class="st-news">${chip(i ? 'Antes' : verLabel(), i ? '' : 'ok')}<span>${esc(t)}</span></div>`).join('')}<p class="st-note">Se actualiza con MixUp: no tienes que hacer nada.</p></div>
          </div></div>
        <div class="st-box"><h3>Qué cambia al instalarlo</h3><ul class="st-ul chg">${chg.map(h => `<li>${esc(h)}</li>`).join('')}</ul></div>
        <div class="st-box" data-ctl${p.installed ? '' : ' hidden'}>${p.installed ? ctlRows(p) : ''}</div>
      </div></div>`;
  }
  const detActions = p => p.installed
    ? `${p.hasPage ? `<button type="button" class="st-open big" data-page="${esc(p.id)}">${icon('settings', 18)}Abrir</button>` : chip('Instalado', 'ok', 'check')}<button type="button" class="st-open danger" data-uninstall="${esc(p.id)}">Desinstalar</button>`
    : getBtn(p.id, { big: true, name: p.name });
  const ctlRows = p => `<div class="st-srow"><span><b>Activado</b><small>${p.enabled ? 'Sus botones y funciones están en MixUp' : 'Apagado: no se ve ni hace nada, pero sigue instalado'}</small></span><button type="button" class="v-switch${p.enabled ? ' on' : ''}" role="switch" aria-checked="${p.enabled}" aria-label="Activar ${esc(p.name)}" data-sw="${esc(p.id)}"></button></div>
    ${p.hasPage ? `<button type="button" class="st-srow" data-page="${esc(p.id)}"><span><b>Ajustes</b><small>Las opciones de ${esc(p.name)}</small></span>${icon('settings', 20)}</button>` : ''}`;

  /* ---------------- pintar ---------------- */
  function paintTop() {
    const seg = host.querySelector('.st-top .v-seg');
    seg.querySelectorAll('[data-tab]').forEach(b => { const on = b.dataset.tab === S.tab && !S.q; b.classList.toggle('sel', on); b.setAttribute('aria-selected', on); });
  }
  function paintBody() {
    if (!host) return;
    const body = host.querySelector('.st-body'); if (!body) return;
    clearInterval(heroT);
    let h;
    if (S.q) h = viewSearch(S.q);
    else h = { discover: viewDiscover, plugin: viewPlugins, theme: viewThemes, style: viewStyles, font: viewFonts, installed: viewInstalled }[S.tab]();
    body.innerHTML = h;
    hydrate(body);
    if (justId) { const j = justId; justId = ''; body.querySelectorAll('[data-id]').forEach(n => { if (n.dataset.id === j) { n.classList.add('just'); setTimeout(() => n.classList.remove('just'), 1500); } }); }
    initHero(body);
  }
  function paintDetail(id) {
    const p = plugin(id); if (!p || !host) return;
    host.querySelector('[data-act]').innerHTML = detActions(p);
    const ctl = host.querySelector('[data-ctl]'); if (ctl) { ctl.hidden = !p.installed; ctl.innerHTML = p.installed ? ctlRows(p) : ''; }
    host.querySelector('.st-det-head .st-chips').innerHTML = pluginChips(p);
  }
  function initHero(root) {
    const row = root.querySelector('[data-hero]'); if (!row) return;
    const dots = [...root.querySelectorAll('[data-dot]')], slides = [...row.children];
    const idx = () => { const w = slides[0].offsetWidth + 12; return Math.max(0, Math.min(slides.length - 1, Math.round(row.scrollLeft / w))); };
    const mark = () => { const i = idx(); dots.forEach((d, k) => d.classList.toggle('on', k === i)); };
    row.addEventListener('scroll', mark, { passive: true });
    const go = i => row.scrollTo({ left: slides[i].offsetLeft - slides[0].offsetLeft, behavior: V25.reduced() ? 'auto' : 'smooth' });
    row._go = go;
    if (!V25.reduced()) {
      let pause = 0;
      ['pointerdown', 'wheel', 'touchstart'].forEach(ev => row.addEventListener(ev, () => { pause = Date.now() + 12000; }, { passive: true }));
      heroT = setInterval(() => { if (!host || document.hidden || Date.now() < pause || busy) return; go((idx() + 1) % slides.length); }, 6000);
    }
  }
  function repaint() {
    if (!host) return;
    if (busy) { dirty = true; return; }
    dirty = false;
    const params = V25.current()?.params || {};
    if (params.plugin) paintDetail(params.plugin); else paintBody();
  }

  /* ---------------- acciones ---------------- */
  function runInstall(btn, doIt, id) {
    if (btn.classList.contains('busy') || btn.classList.contains('done')) return;
    const fast = V25.reduced(), dur = fast ? 120 : (+btn.dataset.dur || 950);
    const lb = btn.querySelector('.st-get-lb span');
    btn.classList.add('busy'); btn.setAttribute('aria-busy', 'true'); busy++;
    Mix.haptic('select');
    const t0 = performance.now();
    const step = now => {
      if (!btn.isConnected) { busy = Math.max(0, busy - 1); doIt(); return; }
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      btn.style.setProperty('--p', (e * 100).toFixed(1) + '%');
      lb.textContent = `Instalando ${Math.round(e * 100)}%`;
      if (k < 1) return requestAnimationFrame(step);
      btn.classList.remove('busy'); btn.classList.add('done'); btn.removeAttribute('aria-busy');
      btn.querySelector('.st-get-lb').innerHTML = `${icon('check', 16)}<span>Instalado</span>`;
      Mix.haptic('like');
      setTimeout(() => { busy = Math.max(0, busy - 1); justId = id; try { doIt(); } catch (er) { console.error(er); } if (!ALIVE.on) return; repaint(); }, fast ? 0 : 560);
    };
    requestAnimationFrame(step);
  }
  function confirmUninstall(p) {
    V25.sheet({ body: (el, close) => {
      el.innerHTML = `<div class="st-conf"><h3>${esc(`¿Desinstalar «${p.name}»?`)}</h3><p>Se quitan sus botones y funciones de MixUp. Tus ajustes se guardan y podrás volver a instalarlo cuando quieras desde la Tienda.</p><div class="st-conf-act"><button type="button" class="st-open" data-no>Cancelar</button><button type="button" class="st-open on danger" style="background:#ff6b6b;color:#fff" data-yes>Desinstalar</button></div></div>`;
      el.onclick = e => {
        if (e.target.closest('[data-no]')) close();
        else if (e.target.closest('[data-yes]')) { close(); Mix.plugins.uninstall(p.id); Mix.toast(`${p.name} desinstalado`); Mix.haptic('tap'); repaint(); }
      };
    } });
  }
  async function checkUpdates() {
    if (S.upd.state === 'checking') return;
    S.upd = { state: 'checking', text: 'Comprobando la versión más reciente…' }; repaint();
    const r = await Mix.updates.check();
    const v = r.version ? ` ${r.version}` : '';
    S.upd = { ok: { state: 'ok', text: `Tienes la última versión${S.appVer ? `: MixUp ${S.appVer}` : ''}. Todos tus plugins están actualizados.` },
      ready: { state: 'ready', text: `La versión${v} ya está descargada: se instala al reiniciar MixUp y trae los plugins al día.` },
      started: { state: 'started', text: 'Buscando… si hay una versión nueva, se descarga sola y MixUp te avisará.' },
      error: { state: 'error', text: 'No se pudo comprobar ahora (¿sin conexión?). Se volverá a intentar solo.' },
      unknown: { state: 'unknown', text: 'Esta copia de MixUp se actualiza desde su instalador o tienda. Cuando haya una nueva, los plugins vendrán dentro, sin hacer nada.' } }[r.state] || { state: 'ok', text: '' };
    if (!ALIVE.on) return;
    repaint();
  }

  function onClick(e) {
    const t = e.target;
    const inst = t.closest('[data-install]');
    if (inst) { e.stopPropagation(); const id = inst.dataset.install; runInstall(inst, () => Mix.store.install(id), id); return; }
    const un = t.closest('[data-uninstall]'); if (un) { const p = plugin(un.dataset.uninstall); if (p) confirmUninstall(p); return; }
    const unk = t.closest('[data-un]');
    if (unk) { const id = unk.dataset.un; Mix.store.uninstall(id); Mix.toast('Quitado de tus listas'); repaint(); return; }
    const use = t.closest('[data-use]');
    if (use) { applyItem(use.dataset.use); return; }
    const sw = t.closest('[data-sw]');
    if (sw) { e.stopPropagation(); const id = sw.dataset.sw; Mix.plugins.enabled(id) ? Mix.plugins.disable(id) : Mix.plugins.enable(id); Mix.haptic('select'); repaint(); return; }
    if (t.closest('[data-auto]')) { Mix.settings.set({ autoUpdate: cur().autoUpdate === false }); Mix.haptic('select'); repaint(); return; }
    if (t.closest('[data-check]')) { checkUpdates(); return; }
    const pg = t.closest('[data-page]'); if (pg) { e.stopPropagation(); Mix.plugins.openPage(pg.dataset.page); return; }
    if (t.closest('[data-back]')) { V25.back(); return; }
    const tb = t.closest('[data-tab]'); if (tb) { setTab(tb.dataset.tab); return; }
    const ct = t.closest('[data-cat]'); if (ct) { S.cat = ct.dataset.cat; paintBody(); return; }
    const dt = t.closest('[data-dot]'); if (dt) { host.querySelector('[data-hero]')?._go?.(+dt.dataset.dot); return; }
    const det = t.closest('[data-det]'); if (det) { V25.go('store', { plugin: det.dataset.det }); return; }
  }
  function applyItem(id) {
    const m = /^(theme|style|font):(ui:)?(.*)$/.exec(id); if (!m) return;
    const [, kind, ui, rest] = m;
    if (kind === 'theme') Mix.settings.useTheme(rest);
    else if (kind === 'style') { const p = Mix.settings.presets().find(x => x.id === rest); if (p) Mix.settings.set({ ...p.set }); }
    else Mix.settings.set(ui ? { uiFont: rest } : { font: rest });
    Mix.haptic('select');
    Mix.toast('Listo');
  }
  function setTab(tab) {
    S.tab = tab; S.q = '';
    const inp = host.querySelector('.st-top input'); if (inp) inp.value = '';
    paintTop(); paintBody();
    host.closest('.v-main')?.scrollTo({ top: 0 });
  }

  /* ---------------- la vista ---------------- */
  const signature = () => { const c = cur(); return [c.theme, c.font, c.uiFont, c.autoUpdate, JSON.stringify(c.plugins || {}), Mix.plugins.list().map(p => p.id + p.installed + p.enabled).join()].join('|'); };
  V25.view('store', {
    title: 'Tienda', icon: V25.ICONS.store,
    mount(el, params = {}) {
      ALIVE.on = true; host = el; busy = 0; dirty = false;
      if (params.tab) { S.tab = params.tab; S.q = ''; }
      el.onclick = onClick;
      el.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-det]') && e.target === e.target.closest('[data-det]')) { e.preventDefault(); V25.go('store', { plugin: e.target.dataset.det }); } };
      if (!S.appVer) Mix.updates.version().then(v => { if (v) { S.appVer = v; if (!ALIVE.on) return; host?.querySelectorAll('[data-ver]').forEach(n => { n.textContent = v; }); if (!busy && !params.plugin) repaint(); } });
      ORDER.concat(['generic']).forEach(loadArt);
      sig = signature();
      const sync = () => { const s = signature(); if (s === sig) return; sig = s; repaint(); };
      offs = [Mix.on('plugins', () => { sig = signature(); repaint(); }), Mix.on('settings', sync)];
      if (params.plugin) {
        el.innerHTML = viewDetail(params.plugin);
        hydrate(el);
        sizeOf(params.plugin).then(n => { const b = el.querySelector('[data-size]'); if (b) b.textContent = fmtSize(n); });
        return;
      }
      V25.slot('headactions').innerHTML = `<button type="button" class="v-ibtn" data-hcheck aria-label="Buscar actualizaciones" title="Buscar actualizaciones">${icon('download', 20)}</button>`;
      V25.slot('headactions').onclick = () => { setTab('installed'); checkUpdates(); };
      el.innerHTML = `<div class="st"><div class="st-top"><label class="v-search">${icon('search', 18)}<input type="search" placeholder="Buscar en la Tienda" aria-label="Buscar en la Tienda" autocomplete="off" value="${esc(S.q)}"></label>${html.seg(TABS, S.tab, 'data-tab')}</div><div class="st-body"></div></div>`;
      let tm = 0;
      el.querySelector('.st-top input').addEventListener('input', e => { clearTimeout(tm); const v = e.target.value.trim(); tm = setTimeout(() => { S.q = v; paintTop(); paintBody(); }, 140); });
      paintTop(); paintBody();
    },
    unmount() {
      ALIVE.on = false; clearInterval(heroT); offs.forEach(f => f()); offs = [];
      try { V25.slot('headactions').onclick = null; } catch {}
      if (host) { host.onclick = null; host.onkeydown = null; }
      host = null;
    },
  });

  I18N.add({
    'Tienda': ['Store', 'Botiga'], 'Descubrir': ['Discover', 'Descobrir'], 'Plugins': ['Plugins', 'Plugins'], 'Temas': ['Themes', 'Temes'], 'Estilos': ['Styles', 'Estils'], 'Tipografías': ['Fonts', 'Tipografies'], 'Instalados': ['Installed', 'Instal·lats'],
    'Instalar': ['Install', 'Instal·la'], 'Abrir': ['Open', 'Obre'], 'Desinstalar': ['Uninstall', 'Desinstal·la'], 'Actualizado': ['Up to date', 'Actualitzat'], 'Nuevo': ['New', 'Nou'], 'Usar': ['Use', 'Usa'], 'En uso': ['In use', 'En ús'],
    'Buscar en la Tienda': ['Search the Store', 'Cerca a la Botiga'], 'Buscar actualizaciones': ['Check for updates', 'Cerca actualitzacions'], 'Actualizar automáticamente': ['Update automatically', 'Actualitza automàticament'],
    'Acerca de': ['About', 'Quant a'], 'Lo mejor': ['Highlights', 'El millor'], 'Qué cambia al instalarlo': ['What changes when you install it', 'Què canvia en instal·lar-lo'], 'Información': ['Information', 'Informació'], 'Novedades': ['What\'s new', 'Novetats'],
  });
})();
