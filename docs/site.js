'use strict';
// La web de MixUp: el QR de la app de Android y, desde GitHub Releases, la
// última versión, las novedades y la tabla de todas las versiones.
const REPO = 'luckicla/zentor';
const $ = s => document.querySelector(s);
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const APK = `https://github.com/${REPO}/releases/download/android-latest/MixUp.apk`;
// the page's language (es: /, en: /en/)
const EN = document.documentElement.lang === 'en';
const T = EN
  ? { ver: 'Version', free: 'Free · Windows 10/11, macOS 11+ and Android 7+', latest: 'Latest', none: 'No notes.', dl: 'Download',
      noLoad: `Couldn't load the versions. See them on <a href="https://github.com/${REPO}/releases">GitHub</a>.`,
      all: `See every version on <a href="https://github.com/${REPO}/releases">GitHub</a>.` }
  : { ver: 'Versión', free: 'Gratis · Windows 10/11, macOS 11+ y Android 7+', latest: 'Última', none: 'Sin notas.', dl: 'Descargar',
      noLoad: `No he podido cargar las versiones. Míralas en <a href="https://github.com/${REPO}/releases">GitHub</a>.`,
      all: `Mira todas las versiones en <a href="https://github.com/${REPO}/releases">GitHub</a>.` };

// el QR para descargar la app en el móvil
try { const q = qrcode(0, 'M'); q.addData(APK); q.make(); $('#qr').innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); } catch (e) { console.error(e); }

// markdown sencillo para las notas: títulos, listas, negritas, cursivas, código y enlaces
function md(t) {
  const out = []; let list = false;
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\W)_(.+?)_(?=\W|$)/g, '$1<i>$2</i>').replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  for (const raw of String(t || '').replace(/\r/g, '').split('\n')) {
    const l = raw.trimEnd(); let m;
    if ((m = /^\s*[-*]\s+(.*)/.exec(l))) { if (!list) { out.push('<ul>'); list = true; } out.push('<li>' + inline(m[1]) + '</li>'); continue; }
    if (list) { out.push('</ul>'); list = false; }
    if ((m = /^(#{1,4})\s+(.*)/.exec(l))) out.push(`<h4>${inline(m[2])}</h4>`);
    else if (l.trim()) out.push('<p>' + inline(l) + '</p>');
  }
  if (list) out.push('</ul>');
  return out.join('');
}
const fecha = d => new Date(d).toLocaleDateString(EN ? 'en' : 'es', { day: 'numeric', month: 'long', year: 'numeric' });
const asset = (r, re) => (r.assets || []).find(a => re.test(a.name));
const mb = b => (b / 1048576).toFixed(0) + ' MB';
// (only the MixUp ones: v2 and later; the ZenTor 1.x ones are kept in the table)
const isMix = r => /^v?2\./.test(r.tag_name);

(async () => {
  let rel = [];
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, { headers: { Accept: 'application/vnd.github+json' } });
    if (r.ok) rel = (await r.json()).filter(x => !x.draft && !x.prerelease && /^v\d/.test(x.tag_name));
  } catch {}
  rel.sort((a, b) => b.tag_name.localeCompare(a.tag_name, undefined, { numeric: true }));
  const latest = rel.find(isMix) || rel[0];
  if (latest) $('#ver').textContent = `${T.ver} ${latest.tag_name.replace(/^v/, '')} · ${fecha(latest.published_at)} · ${T.free}`;
  // novedades: las notas de las últimas versiones
  const items = rel.slice(0, 6);
  $('#log').innerHTML = items.length ? items.map((r, i) => `<article class="card rel${i === 0 ? ' new' : ''}">
    <header><b>${isMix(r) ? 'MixUp' : 'ZenTor'} ${esc(r.tag_name.replace(/^v/, ''))}</b>${i === 0 ? `<span class="tag">${T.latest}</span>` : ''}<small>${fecha(r.published_at)}</small></header>
    <div class="body">${md((r.body || '').split(/\n### ¿Es seguro\?/)[0]) || `<p class="small">${T.none}</p>`}</div></article>`).join('')
    : `<p class="small">${T.noLoad}</p>`;
  // todas las versiones, para descargar cualquiera
  const link = a => a ? `<a href="${a.browser_download_url}">${T.dl}</a> <small>${mb(a.size)}</small>` : '<small>—</small>';
  $('#vers tbody').innerHTML = rel.length ? rel.map(r => `<tr><td><b>${esc(r.tag_name)}</b></td><td>${fecha(r.published_at)}</td><td>${link(asset(r, /Instalador.*\.exe$/i) || asset(r, /^(MixUp|ZenTor)\.exe$/i))}</td><td>${link(asset(r, /Portable.*\.exe$/i))}</td><td>${link(asset(r, /\.apk$/i))}</td><td>${link(asset(r, /\.dmg$/i))}</td></tr>`).join('')
    : `<tr><td colspan="6" class="small">${T.all}</td></tr>`;
})();
