// Ajustes: «ajustes rápidos» (presets). In sections with many knobs, a normal
// user picks a preset with one tap; the individual knobs are advanced rows
// (data-adv). Each preset is a segmented control; when the knobs no longer
// match any preset it shows «Personalizado». Nothing is changed by merely
// opening settings: only a tap on a preset writes values.
const SettingsPresets = (() => {
  const GROUPS = [
    {
      id: 'sound', tab: 'sound', title: 'Cómo suena', sub: 'Un toque y suena como prefieras. Los deslizadores están en Avanzado',
      anchor: sec => [...sec.querySelectorAll('h3')].find(h => h.textContent.trim() === 'Ecualizador'),
      options: [
        { id: 'normal', name: 'Normal', set: { eq60: 0, eq250: 0, eq1k: 0, eq4k: 0, eq12k: 0, bass: 0 } },
        { id: 'bass', name: 'Graves', set: { eq60: 6, eq250: 3, eq1k: 0, eq4k: 0, eq12k: 1, bass: 4 } },
        { id: 'voice', name: 'Voces', set: { eq60: -2, eq250: -1, eq1k: 2, eq4k: 4, eq12k: 1, bass: 0 } },
        { id: 'treble', name: 'Agudos', set: { eq60: 0, eq250: -1, eq1k: 0, eq4k: 3, eq12k: 5, bass: 0 } },
        { id: 'rock', name: 'Rock', set: { eq60: 4, eq250: 2, eq1k: -2, eq4k: 2, eq12k: 4, bass: 0 } },
        { id: 'electro', name: 'Electro', set: { eq60: 4, eq250: 2, eq1k: -1, eq4k: 1, eq12k: 3, bass: 7 } },
      ],
    },
    {
      id: 'bg', tab: 'bg', title: 'Estilo de fondo', sub: 'Qué hay detrás de todo. Desenfoque y atenuado, en Avanzado',
      anchor: sec => sec.querySelector('h3'),
      options: [
        { id: 'cover', name: 'Portada difuminada', set: { bg: 'cover', coverColors: 'all', coverBlur: 36, coverDim: 0.3 } },
        { id: 'sharp', name: 'Portada nítida', set: { bg: 'cover', coverColors: 'all', coverBlur: 8, coverDim: 0.45 } },
        { id: 'wall', name: 'Imagen', set: { bg: 'wall', wallColors: 'all', wallBlur: 0, wallDim: 0.55 }, after: () => { if (!Settings.get().wallVer) document.getElementById('btnWall')?.click(); } },
        { id: 'flat', name: 'Liso', set: { bg: 'flat', flatGlow: 0.6 } },
      ],
    },
    {
      id: 'music', tab: 'music', title: 'Entre canciones', sub: 'Cómo pasa de una a otra. Los detalles, en Avanzado',
      anchor: sec => sec.querySelector('[data-set="autoplay"]')?.closest('.row'),
      options: [
        { id: 'asusual', name: 'Como siempre', set: { crossfade: 5, trimSilence: true, smoothEnd: true, autoRadio: true } },
        { id: 'oneByOne', name: 'Una a una', set: { crossfade: 0, trimSilence: false, smoothEnd: false, autoRadio: false } },
        { id: 'seamless', name: 'Sin cortes', set: { crossfade: 8, trimSilence: true, smoothEnd: true, autoRadio: true } },
        { id: 'party', name: 'Fiesta', set: { crossfade: 12, trimSilence: true, smoothEnd: true, autoRadio: true } },
      ],
    },
  ];

  const same = (a, b) => typeof b === 'number' ? Math.abs((+a || 0) - b) < 1e-6 : a === b;
  const matches = (o, s) => Object.keys(o.set).every(k => same(s[k], o.set[k]));
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = [];

  function build(g) {
    const sec = document.querySelector(`.stab[data-tab="${g.tab}"]`);
    const at = sec && g.anchor(sec);
    if (!at) return;
    const row = document.createElement('div');
    row.className = 'row col pre-row';
    row.dataset.presets = g.id;
    row.innerHTML = `<span>${esc(g.title)}<small>${esc(g.sub)}</small></span><div class="seg wrap pre-seg" role="group" aria-label="${esc(g.title)}">`
      + g.options.map(o => `<button type="button" data-v="${o.id}">${esc(o.name)}</button>`).join('')
      + '<button type="button" data-v="custom" class="pre-custom" hidden disabled>Personalizado</button></div>';
    at.after(row);
    row.addEventListener('click', e => {
      const b = e.target.closest('button[data-v]'); if (!b || b.disabled) return;
      const o = g.options.find(x => x.id === b.dataset.v); if (!o) return;
      Settings.set({ ...o.set });
      window.ZT?.haptic?.('select');
      o.after?.();
    });
    rows.push({ g, row });
  }

  function paint() {
    const s = Settings.get();
    rows.forEach(({ g, row }) => {
      const cur = g.options.find(o => matches(o, s));
      row.querySelectorAll('button[data-v]').forEach(b => {
        const on = b.dataset.v === (cur ? cur.id : 'custom');
        b.classList.toggle('sel', on);
        b.setAttribute('aria-pressed', on);
      });
      row.querySelector('.pre-custom').hidden = !!cur;
    });
  }

  function init() {
    GROUPS.forEach(build);
    Settings.onChange(paint);
    paint();
    if (window.SettingsAdv) SettingsAdv.arrange(document.getElementById('settings'));
  }
  init();
  return { paint };
})();

I18N.add({
  "Cómo suena": ["How it sounds", "Com sona"],
  "Un toque y suena como prefieras. Los deslizadores están en Avanzado": ["One tap and it sounds the way you like. The sliders are under Advanced", "Un toc i sona com prefereixis. Els lliscadors són a Avançat"],
  "Normal": ["Normal", "Normal"],
  "Graves": ["Bass", "Greus"],
  "Voces": ["Vocals", "Veus"],
  "Agudos": ["Treble", "Aguts"],
  "Rock": ["Rock", "Rock"],
  "Electro": ["Electro", "Electro"],
  "Personalizado": ["Custom", "Personalitzat"],
  "Estilo de fondo": ["Background style", "Estil de fons"],
  "Qué hay detrás de todo. Desenfoque y atenuado, en Avanzado": ["What sits behind everything. Blur and dimming are under Advanced", "Què hi ha darrere de tot. Desenfocament i atenuació, a Avançat"],
  "Portada difuminada": ["Blurred cover", "Portada difuminada"],
  "Portada nítida": ["Sharp cover", "Portada nítida"],
  "Imagen": ["Image", "Imatge"],
  "Liso": ["Plain", "Llis"],
  "Entre canciones": ["Between songs", "Entre cançons"],
  "Cómo pasa de una a otra. Los detalles, en Avanzado": ["How it moves from one to the next. The details are under Advanced", "Com passa de l'una a l'altra. Els detalls, a Avançat"],
  "Como siempre": ["As usual", "Com sempre"],
  "Una a una": ["One by one", "Una a una"],
  "Sin cortes": ["No gaps", "Sense talls"],
  "Fiesta": ["Party", "Festa"],
  "Portada, imagen o liso": ["Cover, image or plain", "Portada, imatge o llis"],
  "Ecualizador y mejorar el sonido": ["Equalizer and sound enhancement", "Equalitzador i millorar el so"],
});
