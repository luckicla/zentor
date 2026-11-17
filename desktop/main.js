'use strict';
// MixUp para escritorio: la misma app de siempre (el servidor en Go que lee tu
// música y sirve la interfaz) dentro de una ventana propia, con su icono en la
// barra de tareas, un instalador y una versión portable.
//
//  - Arranca mixup-core.exe (MixUp.exe compilado en GitHub) con -shell: sirve
//    la interfaz en 127.0.0.1:47811 y no abre ventanas ni se actualiza solo.
//  - Portable (MixUp-Portable.exe): la música y los ajustes van en la carpeta
//    del .exe (en un USB, en el USB), como siempre.
//  - Instalada: se actualiza sola con electron-updater desde la release
//    «pc-latest» del repositorio (latest.yml + MixUp-Instalador.exe).
const { app, BrowserWindow, Menu, shell, ipcMain, nativeImage, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 47811;
const URL = `http://127.0.0.1:${PORT}/`;
const UPDATES = 'https://github.com/luckicla/zentor/releases/download/pc-latest/';
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR || '';
const portable = !!portableDir;

// portable: también lo de la ventana (su almacenamiento, la caché) va junto al .exe
if (portable) {
  try { app.setPath('userData', path.join(portableDir, '.zentor', 'escritorio')); } catch {}
}
app.setAppUserModelId('com.zentor.player.desktop');
// la música suena sin tener que tocar antes la ventana
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'Translate');

const first = app.requestSingleInstanceLock();
if (!first) app.quit(); // ya estaba abierta: se le pasa el foco (second-instance)

let win = null, core = null, quitting = false, updState = null;

function log(m) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'escritorio.log'), `${new Date().toISOString()} ${m}\n`); } catch {}
}

function corePath() {
  const packed = path.join(process.resourcesPath || '', 'core', 'mixup-core.exe');
  if (fs.existsSync(packed)) return packed;
  // para probar sin compilar el instalador: el exe de Go al lado (desktop/bin)
  const dev = path.join(__dirname, 'bin', process.platform === 'win32' ? 'mixup-core.exe' : 'mixup-core');
  return fs.existsSync(dev) ? dev : '';
}

function startCore() {
  const exe = corePath();
  if (!exe) { log('no hay mixup-core: se usa uno que ya esté abierto'); return; }
  const args = ['-shell'];
  if (portable) args.push('-root', portableDir);
  const me = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore' });
  core = me;
  me.on('exit', code => {
    log('mixup-core salió: ' + code);
    if (core === me) core = null;
    // se fue con la ventana abierta (otro MixUp más nuevo se quedó el puerto,
    // o se cerró por lo que sea): si no hay ningún MixUp sirviendo la página,
    // se arranca otra vez (nunca se cierra la app por eso)
    if (!quitting) setTimeout(() => keepServed(), 2500);
  });
}

let restarts = [];
async function keepServed() {
  if (quitting || core) return;
  if (await up()) return; // otro MixUp (más nuevo) la sirve: vale
  restarts = restarts.filter(t => Date.now() - t < 10 * 60e3);
  if (restarts.length >= 5) { log('mixup-core no aguanta: se deja'); return; }
  restarts.push(Date.now());
  startCore();
  if (await waitCore(15000) && win) win.webContents.reload();
}
// cada poco: que siempre haya un MixUp sirviendo la página
setInterval(() => { if (!quitting && !core) keepServed(); }, 15000);

function up() {
  return new Promise(ok => {
    const r = net.request({ url: URL + 'api/version', method: 'GET' });
    // (con el puerto abierto pero el servidor aún leyendo la música, la
    // petición no contestaría nunca)
    const t = setTimeout(() => { try { r.abort(); } catch {} ok(false); }, 2500);
    r.on('response', res => { clearTimeout(t); ok(res.statusCode === 200); res.on('data', () => {}); });
    r.on('error', () => { clearTimeout(t); ok(false); });
    r.end();
  });
}

// (la primera vez lee toda la carpeta Música antes de contestar: con mucha
// música, o en OneDrive, tarda; mientras el servidor siga vivo, se espera)
async function waitCore(ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms || (core && Date.now() - t0 < 5 * 60e3)) {
    if (await up()) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

function iconPath() {
  const p = path.join(process.resourcesPath || '', 'icon.ico');
  if (fs.existsSync(p)) return p;
  const dev = path.join(__dirname, 'build', 'icon.ico');
  return fs.existsSync(dev) ? dev : undefined;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 360, minHeight: 560,
    backgroundColor: '#0a0a0d',
    title: 'MixUp',
    icon: iconPath(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      // la música y las mezclas del DJ van con temporizadores: minimizada
      // tienen que seguir a su ritmo
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'splash.html'));
  // enlaces de fuera (GitHub, YouTube, Wikipedia…): en el navegador
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(URL)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(URL) && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
});

app.whenReady().then(async () => {
  if (!first) return;
  createWindow();
  if (portable) setTimeout(cleanPortable, 8000);
  // siempre el suyo: si había otro MixUp abierto (un ZenTor.exe de antes),
  // el suyo le pide que se vaya y se queda la música; si el otro es más
  // nuevo, se queda el otro y la ventana usa ese
  startCore();
  const ok = await waitCore();
  if (!win) return;
  if (!ok) {
    win.webContents.executeJavaScript(`document.body.classList.add('err')`).catch(() => {});
    return;
  }
  await win.loadURL(URL);
  firstLogo();
  setTimeout(checkUpdates, 15000);
  setInterval(checkUpdates, 6 * 3600e3);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  if (core) { try { core.kill(); } catch {} }
});

/* ---------- lo que la página puede pedir (preload.js → window.MixUpShell) ---------- */

ipcMain.handle('shell', async (_e, what, arg) => {
  switch (what) {
    case 'info': return { version: app.getVersion(), portable, dir: portableDir };
    case 'icon': return setIcon(String(arg || ''));
    case 'check': checkUpdates(true); return updState;
    case 'install': return installUpdate();
    // (de antes: la portable abría el navegador; ahora se baja y se cambia sola)
    case 'download': checkUpdates(true); return updState;
    case 'state': return updState;
  }
  return null;
});

// el logo elegido en el instalador: la app empieza con él (una vez)
function firstLogo() {
  const f = path.join(app.getPath('userData'), 'icono-elegido.txt');
  let name = '';
  try { name = fs.readFileSync(f, 'utf8').trim(); fs.unlinkSync(f); } catch { return; }
  if (!/^[a-z]+$/.test(name)) return;
  win.webContents.executeJavaScript(`try { Settings.set({ appIcon: ${JSON.stringify(name)}, appIconPicked: true }) } catch (e) {}`).catch(() => {});
}

// el icono elegido en Ajustes → Icono de la app: en la ventana, la barra de
// tareas y los accesos directos (menú Inicio y escritorio)
async function setIcon(name) {
  if (!win || !/^[a-z]+$/.test(name)) return false;
  try {
    const r = await fetch(URL + 'icons/' + name + '.ico');
    if (!r.ok) return false;
    const dir = path.join(app.getPath('userData'), 'iconos');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, name + '.ico');
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    const img = nativeImage.createFromPath(f);
    if (!img.isEmpty()) win.setIcon(img);
    if (process.platform === 'win32' && !portable) {
      const links = [
        path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'MixUp.lnk'),
        path.join(app.getPath('desktop'), 'MixUp.lnk'),
      ];
      for (const l of links) if (fs.existsSync(l)) { try { shell.writeShortcutLink(l, 'update', { icon: f, iconIndex: 0 }); } catch {} }
    }
    return true;
  } catch { return false; }
}

let wantInstall = false; // pulsó «Actualizar» antes de que estuviera bajada: al acabar, se instala
function tell(s) {
  updState = s;
  if (win) win.webContents.send('shell-update', s);
  if (s.state === 'ready' && wantInstall) { wantInstall = false; setTimeout(installUpdate, 1200); }
  if (s.state === 'error' || s.state === 'none') wantInstall = false;
}

const newer = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
};

// «Actualizar sola» de Ajustes (si la página no contesta, sí)
async function autoOn() {
  if (!win) return true;
  try { return (await win.webContents.executeJavaScript('(() => { try { return Settings.get().autoUpdate !== false } catch (e) { return true } })()')) !== false; }
  catch { return true; }
}

/* ---------- la portable: se baja la nueva y se pone en el sitio de esta ----------
   desktop.txt (en pc-latest) dice «<versión> <sha256 instalador> <sha256 portable>».
   Se baja MixUp-Portable.exe junto a la de ahora (mismo disco: el cambio es
   instantáneo), se comprueba, y al reiniciar un PowerShell espera a que esta
   se cierre, la sustituye y abre la nueva. Nunca pasa por el navegador. */
const portableFile = process.env.PORTABLE_EXECUTABLE_FILE || '';
let portableNew = null; // { version, file } lista para ponerse

async function getText(url) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error(url.split('/').pop() + ': HTTP ' + r.status);
  return r.text();
}

async function download(url, dest, sha) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
  const total = Number(r.headers.get('content-length')) || 0;
  const part = dest + '.part';
  const h = require('crypto').createHash('sha256');
  const out = fs.createWriteStream(part);
  let got = 0, last = -1;
  try {
    const rd = r.body.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      h.update(value);
      if (!out.write(Buffer.from(value))) await new Promise(ok => out.once('drain', ok));
      got += value.length;
      const pct = total ? Math.floor(got * 100 / total) : 0;
      if (pct !== last) { last = pct; tell({ state: 'downloading', pct }); }
    }
    await new Promise((ok, ko) => out.end(e => e ? ko(e) : ok()));
  } catch (e) { out.destroy(); try { fs.unlinkSync(part); } catch {} throw e; }
  if (sha && h.digest('hex').toLowerCase() !== sha.toLowerCase()) { try { fs.unlinkSync(part); } catch {} throw new Error('la descarga no coincide'); }
  try { fs.unlinkSync(dest); } catch {}
  fs.renameSync(part, dest);
}

async function checkPortable(manual) {
  tell({ state: 'checking' });
  const f = (await getText(UPDATES + 'desktop.txt')).trim().split(/\s+/);
  if (f.length < 3) throw new Error('desktop.txt vacío');
  const [ver, , sha] = f;
  if (!newer(ver, app.getVersion())) { tell({ state: 'none', version: app.getVersion() }); return; }
  if (!portableFile) { tell({ state: 'error', msg: 'no se sabe dónde está la portable' }); return; }
  if (!manual && !(await autoOn())) { tell({ state: 'available', version: ver }); return; }
  const dest = portableFile.replace(/\.exe$/i, '') + '.nueva.exe';
  tell({ state: 'downloading', pct: 0, version: ver });
  await download(UPDATES + 'MixUp-Portable.exe', dest, sha);
  portableNew = { version: ver, file: dest };
  log('portable: ' + ver + ' lista en ' + dest);
  tell({ state: 'ready', version: ver });
}

// PowerShell con -EncodedCommand: rutas con tildes, espacios o lo que sea
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
// The portable's launcher closes, with the app, every process the app started:
// the script is started by Windows itself (WMI, Win32_Process.Create), so it's
// nobody's child and outlives this. Resolves once it's started.
function runPS(script) {
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  const inner = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ' + enc;
  const outer = `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${inner}'; ProcessStartupInformation = $si }
exit [int]$r.ReturnValue`;
  return new Promise(ok => {
    let done = false;
    const end = how => { if (!done) { done = true; log('cambio: ' + how); ok(); } };
    try {
      const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-EncodedCommand', Buffer.from(outer, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true });
      c.on('error', e => end('powershell: ' + e.message));
      c.on('exit', code => end('lanzado (' + code + ')'));
      setTimeout(() => end('sin respuesta, sigo'), 15000);
    } catch (e) { end('powershell: ' + e.message); }
  });
}

async function installPortable() {
  const { file } = portableNew;
  const target = portableFile;
  const old = target.replace(/\.exe$/i, '') + '.vieja.exe';
  const plog = path.join(app.getPath('userData'), 'cambio.log');
  // 1) el cambio, ya: Windows deja renombrar un .exe que está abierto
  //    (la portable sigue abierta mientras dure esta)
  let swapped = false;
  try {
    try { fs.unlinkSync(old); } catch {}
    fs.renameSync(target, old);
    try { fs.renameSync(file, target); swapped = true; }
    catch (e) { fs.renameSync(old, target); throw e; }
    log('portable: cambiada por la ' + portableNew.version);
  } catch (e) { log('portable: no se pudo cambiar ahora (' + e.message + '), se cambia al cerrar'); }
  // 2) al cerrarse esta (y su portable): se abre la nueva y se borra la vieja.
  //    Si el cambio no se pudo hacer antes, se hace ahora (hasta 1 minuto).
  const pids = [process.pid, process.ppid].filter(n => n > 0).join(',');
  const script = `$ErrorActionPreference = 'SilentlyContinue'
$dst = ${psQuote(target)}; $new = ${psQuote(file)}; $old = ${psQuote(old)}; $log = ${psQuote(plog)}
function L($m) { Add-Content -LiteralPath $log -Value ((Get-Date -Format s) + ' ' + $m) }
L 'esperando a que se cierre'
for ($i = 0; $i -lt 120; $i++) { if (-not (Get-Process -Id ${pids} -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 250 }
if (Test-Path -LiteralPath $new) {
  for ($i = 0; $i -lt 120; $i++) {
    try { Move-Item -LiteralPath $new -Destination $dst -Force -ErrorAction Stop; L 'cambiada'; break } catch { Start-Sleep -Milliseconds 500 }
  }
}
Start-Sleep -Milliseconds 500
L ('abriendo ' + $dst)
Start-Process -FilePath $dst -WorkingDirectory (Split-Path -Parent $dst)
for ($i = 0; $i -lt 40 -and (Test-Path -LiteralPath $old); $i++) { Start-Sleep -Milliseconds 500; Remove-Item -LiteralPath $old -Force }
L 'hecho'`;
  tell({ state: 'installing', version: portableNew.version });
  await runPS(script);
  quitting = true;
  if (core) { try { core.kill(); } catch {} }
  setTimeout(() => app.exit(0), 300);
}

// la vieja que quedó del último cambio (si no se pudo borrar entonces)
function cleanPortable() {
  if (!portableFile) return;
  for (const n of ['.vieja.exe', '.nueva.exe.part']) { try { fs.unlinkSync(portableFile.replace(/\.exe$/i, '') + n); } catch {} }
}

function installUpdate() {
  if (!updState || updState.state !== 'ready') { wantInstall = true; checkUpdates(true); return false; }
  log('instalando ' + updState.version);
  if (portable) { if (portableNew) installPortable(); return true; }
  quitting = true;
  if (core) { try { core.kill(); } catch {} } // (el instalador no tiene que esperarlo)
  // en silencio: sin volver a preguntar carpeta ni opciones, y se abre sola al acabar
  try { require('electron-updater').autoUpdater.quitAndInstall(true, true); }
  catch (e) { log('instalar: ' + e.message); quitting = false; tell({ state: 'error', msg: e.message }); return false; }
  return true;
}

let au = null, checking = false;
async function checkUpdates(manual) {
  if (!app.isPackaged || checking) return;
  if (updState && updState.state === 'ready') { tell(updState); return; }
  if (updState && updState.state === 'downloading' && !manual) return;
  checking = true;
  try {
    if (portable) { await checkPortable(manual); return; }
    if (!au) {
      au = require('electron-updater').autoUpdater;
      au.logger = { info: m => log('updater: ' + m), warn: m => log('updater: ' + m), error: m => log('updater: ' + m), debug: () => {} };
      au.autoInstallOnAppQuit = true;
      au.on('checking-for-update', () => tell({ state: 'checking' }));
      au.on('update-available', i => { if (!au.autoDownload) tell({ state: 'available', version: i.version }); });
      au.on('update-not-available', () => tell({ state: 'none', version: app.getVersion() }));
      au.on('download-progress', p => tell({ state: 'downloading', pct: Math.round(p.percent || 0) }));
      au.on('update-downloaded', i => tell({ state: 'ready', version: i.version }));
      au.on('error', e => { log('actualizar: ' + (e && e.message)); tell({ state: 'error', msg: e && e.message }); });
    }
    // pulsado «Buscar ahora» / «Actualizar»: se baja aunque «Actualizar sola» esté apagado
    au.autoDownload = manual || await autoOn();
    const r = await au.checkForUpdates();
    // (con autoDownload, checkForUpdates ya espera a la descarga)
    if (r && r.downloadPromise) await r.downloadPromise.catch(() => {});
  } catch (e) {
    log('actualizar: ' + e.message);
    tell({ state: 'error', msg: e.message });
  } finally { checking = false; }
}
