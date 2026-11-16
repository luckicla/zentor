// Pone nombre, descripción, versión e icono de MixUp dentro del .exe (si no,
// Windows lo enseña como «Electron» en el cortafuegos, el administrador de
// tareas y la barra de tareas). Con rcedit, como en Compass Launcher.
const path = require('path');
module.exports = async ctx => {
  if (ctx.electronPlatformName !== 'win32') return;
  const exe = path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + '.exe');
  const m = require('rcedit'), rcedit = m.rcedit || m.default || m;
  const v = ctx.packager.appInfo.version;
  await rcedit(exe, {
    icon: path.join(__dirname, 'icon.ico'),
    'file-version': v, 'product-version': v,
    'version-string': { CompanyName: 'luckicla', FileDescription: 'MixUp', ProductName: 'MixUp', InternalName: 'MixUp',
      OriginalFilename: 'MixUp.exe', LegalCopyright: '© 2026 luckicla' },
  });
  console.log('  • MixUp: nombre e icono puestos en ' + path.basename(exe));
};
