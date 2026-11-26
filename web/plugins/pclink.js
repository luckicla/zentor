'use strict';

// Plugin «Conectar por WiFi»: sincronizar el PC y el móvil con un código QR.
//
// The code lives in sync.js (const Sync), lan.go and LocalServer.java; it
// stays in the core because Sync.fp / Sync.nameKey (the song fingerprint)
// are used by DJ, YouTube, Library, Journal and app.js. This plugin owns the
// switch. With it off:
//  - nothing starts from the interface: no pairing (QR), no sync, no
//    "Dispositivos" / «Seguir aquí», no polling of the other device (sync.js
//    asks `linkOn()` before every one of those);
//  - its entry points hide (data-plugin="pclink": #btnDevices, the Conectar
//    section, the library's «Conectar» button, #pairBox) or are left out
//    (the «Copiarlas desde…» option of the playlist menu);
//  - what was already synced stays, and Sync.fp & co. keep working.
// At the top of the Conectar section there is an empty #driveSyncSlot (not
// part of the plugin, index.html) for the Google Drive sync option.

Plugins.describe({
  id: 'pclink', kind: 'plugin', name: 'Conectar por WiFi', legacy: true, rows: '.stab[data-tab="connect"] > .connect-card',
  desc: 'Sincroniza el PC y el móvil en la misma WiFi con un código QR.',
  icon: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1"/>',
});

let seen = false;
Plugins.define('pclink', {
  onEnable() {
    // turned on again from Ajustes → Plugins (not the first time, at start: sync.js starts by itself)
    if (seen) { try { Sync.wake?.(); } catch (e) { console.error(e); } }
    seen = true;
  },
  onDisable() {
    seen = true;
    // a pairing in progress (QR on screen) is closed
    const b = document.getElementById('pairBox');
    if (b && !b.hidden) document.getElementById('pairClose')?.click();
  },
});
