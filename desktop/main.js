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
  core = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore' });
  core.on('exit', code => {
    log('mixup-core salió: ' + code);
    core = null;
    // se fue con la ventana abierta (no porque la cerráramos): se cierra todo
    if (!quitting) setTimeout(() => { if (!quitting && !core) up().then(ok => { if (!ok) app.quit(); }); }, 4000);
  });
}

function up() {
  return new Promise(ok => {
    const r = net.request({ url: URL + 'api/version', method: 'GET' });
    r.on('response', res => { ok(res.statusCode === 200); res.on('data', () => {}); });
    r.on('error', () => ok(false));
    r.end();
  });
}

async function waitCore(ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await up()) return true;
    await new Promise(r => setTimeout(r, 150));
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
  if (!(await up())) startCore();
  const ok = await waitCore();
  if (!win) return;
  if (!ok) {
    win.webContents.executeJavaScript(`document.body.classList.add('err')`).catch(() => {});
    return;
  }
  await win.loadURL(URL);
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
    case 'install': if (updState && updState.state === 'ready') { quitting = true; try { require('electron-updater').autoUpdater.quitAndInstall(false, true); } catch (e) { log(e.message); } } return true;
    case 'download': shell.openExternal(UPDATES + 'MixUp-Portable.exe'); return true;
    case 'state': return updState;
  }
  return null;
});

// el icono elegido en Ajustes → Icono de la app, en la ventana y la barra de tareas
async function setIcon(name) {
  if (!win || !/^[a-z]+$/.test(name)) return false;
  try {
    const r = await fetch(URL + 'icons/' + name + '.ico');
    if (!r.ok) return false;
    const f = path.join(os.tmpdir(), `mixup-icon-${name}.ico`);
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    const img = nativeImage.createFromPath(f);
    if (!img.isEmpty()) win.setIcon(img);
    return true;
  } catch { return false; }
}

function tell(s) {
  updState = s;
  if (win) win.webContents.send('shell-update', s);
}

const newer = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
};

let au = null, checking = false;
async function checkUpdates(manual) {
  if (!app.isPackaged || checking) return;
  if (updState && updState.state === 'ready') { tell(updState); return; }
  checking = true;
  try {
    if (portable) {
      // la portable no se instala sola: se avisa y se descarga la nueva
      tell({ state: 'checking' });
      const r = await fetch(UPDATES + 'latest.yml?t=' + Date.now(), { cache: 'no-store' });
      const m = r.ok ? /^version:\s*([\d.]+)/m.exec(await r.text()) : null;
      if (m && newer(m[1], app.getVersion())) tell({ state: 'portable', version: m[1] });
      else tell({ state: 'none', version: app.getVersion() });
      return;
    }
    if (!au) {
      au = require('electron-updater').autoUpdater;
      au.autoDownload = true;
      au.autoInstallOnAppQuit = true;
      au.on('checking-for-update', () => tell({ state: 'checking' }));
      au.on('update-not-available', () => tell({ state: 'none', version: app.getVersion() }));
      au.on('download-progress', p => tell({ state: 'downloading', pct: Math.round(p.percent || 0) }));
      au.on('update-downloaded', i => tell({ state: 'ready', version: i.version }));
      au.on('error', e => { log('actualizar: ' + (e && e.message)); tell({ state: 'error' }); });
    }
    await au.checkForUpdates();
  } catch (e) {
    log('actualizar: ' + e.message);
    if (manual) tell({ state: 'error' });
  } finally { checking = false; }
}
