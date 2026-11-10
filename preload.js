// preload.js вЂ” РјРѕСЃС‚ РјРµР¶РґСѓ renderer Рё main (contextIsolation: true)
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  // РѕРєРЅРѕ
  winMin: () => ipcRenderer.send('win:min'),
  winMax: () => ipcRenderer.send('win:max'),
  winClose: () => ipcRenderer.send('win:close'),
  onMaximized: (cb) => ipcRenderer.on('win:maximized', (_e, v) => cb(v)),

  // СЃРѕСЃС‚РѕСЏРЅРёРµ / РЅР°СЃС‚СЂРѕР№РєРё
  getState: invoke('state:get'),
  setSetting: invoke('settings:set'),
  pickFile: invoke('dialog:pick-file'),   // РІРѕР·РІСЂР°С‰Р°РµС‚ РњРђРЎРЎРР’ РїСѓС‚РµР№ (РјСѓР»СЊС‚Рё-РІС‹Р±РѕСЂ РїРѕРґРґРµСЂР¶РёРІР°РµС‚СЃСЏ)
  pickSave: invoke('dialog:pick-save'),
  showItem: invoke('shell:show-item'),
  openExternal: invoke('shell:open-external'),

  // adb
  adbConnect: invoke('adb:connect'),
  adbDisconnect: invoke('adb:disconnect'),
  adbDevices: invoke('adb:devices'),
  adbPair: invoke('adb:pair'),
  adbAutoPair: invoke('adb:auto-pair'),
  adbPortScan: invoke('adb:port-scan'),
  adbPing: invoke('adb:ping'),
  scanSubnet: invoke('adb:scan-subnet'),
  mdnsDiscover: invoke('adb:mdns'),
  adbVersion: invoke('adb:version'),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return (file && file.path) || null; } }, // file.path СѓРґР°Р»С‘РЅ РІ Electron 32+
  qrStart: invoke('qr:start'),
  qrCancel: invoke('qr:cancel'),

  // РёСЃС‚РѕСЂРёСЏ / РёР·Р±СЂР°РЅРЅРѕРµ
  histAdd: invoke('hist:add'),
  histRemove: invoke('hist:remove'),
  histClear: invoke('hist:clear'),
  favToggle: invoke('fav:toggle'),

  // РёРЅСЃС‚СЂСѓРјРµРЅС‚С‹
  toolScreenshot: invoke('tools:screenshot'),
  toolRecordStart: invoke('tools:record-start'),
  toolRecordStop: invoke('tools:record-stop'),
  toolLogcatStart: invoke('tools:logcat-start'),
  toolLogcatStop: invoke('tools:logcat-stop'),
  toolLogcatClear: invoke('tools:logcat-clear'),
  toolScrcpy: invoke('tools:scrcpy'),
  toolInstallApk: invoke('tools:install-apk'),
  toolInstallApkCancel: invoke('tools:install-apk-cancel'),
  toolQuick: invoke('tools:quick'),
  toolDiagnostics: invoke('tools:diagnostics'),

  // РѕС€РёР±РєРё СЂРµРЅРґРµСЂР° -> РІ app.log
  uiLog: (m) => ipcRenderer.send('log:ui', m),

  // v2
  devInfo: invoke('dev:info'),
  savedList: invoke('saved:list'),
  savedAdd: invoke('saved:add'),
  savedRemove: invoke('saved:remove'),
  savedRename: invoke('saved:rename'),
  mirrorStart: invoke('mirror:start'),   // mirrorStart(serial, mode: 'h264'|'jpeg')
  mirrorStop: invoke('mirror:stop'),
  mirrorBounce: invoke('mirror:bounce'),  // СЃРІРµР¶РёР№ h264-РїРѕС‚РѕРє Р±РµР· РїРµСЂРµСЃР±РѕСЂРєРё UI
  inputTap: invoke('input:tap'),
  inputSwipe: invoke('input:swipe'),
  inputKey: invoke('input:key'),
  shellStart: invoke('shell:start'),
  shellWrite: invoke('shell:write'),
  shellStop: invoke('shell:stop'),
  fsList: invoke('fs:list'),
  fsPull: invoke('fs:pull'),
  fsPush: invoke('fs:push'),
  fsPhoneTransfer: invoke('fs:phone-transfer'),
  dragPrepare: invoke('drag:prepare'),      // РїРѕРґРіРѕС‚РѕРІРёС‚СЊ С„Р°Р№Р»/РїР°РїРєСѓ Рє РїРµСЂРµС‚Р°СЃРєРёРІР°РЅРёСЋ РЅР° РџРљ
  dragStart: invoke('drag:start'),          // РЅР°С‡Р°С‚СЊ РЅР°С‚РёРІРЅРѕРµ РїРµСЂРµС‚Р°СЃРєРёРІР°РЅРёРµ РІ РџСЂРѕРІРѕРґРЅРёРє
  fsCmd: invoke('fs:cmd'),
  fsStat: invoke('fs:stat'),             // СЃРІРѕР№СЃС‚РІР° С„Р°Р№Р»Р°/РїР°РїРєРё (F6)
  appsList: invoke('apps:list'),
  appsAction: invoke('apps:action'),
  wmSetSize: invoke('wm:setsize'),
  appsPerms: invoke('apps:perms'),
  appsCrashes: invoke('apps:crashes'),
  appsClearCrashes: invoke('apps:crashes-clear'),
  appsAudit: invoke('apps:audit'),      // РїР°РґРµРЅРёСЏ/ANR РєРѕРЅРєСЂРµС‚РЅРѕРіРѕ РїСЂРёР»РѕР¶РµРЅРёСЏ РёР· logcat
  appsPerm: invoke('apps:perm'),
  appsBackup: invoke('apps:backup'),
  appsSaveApk: invoke('apps:saveapk'),      // СЃРѕС…СЂР°РЅРёС‚СЊ APK РїСЂРёР»РѕР¶РµРЅРёСЏ СЃ РµРіРѕ РёРјРµРЅРµРј
  appsIcon: invoke('apps:icon'),         // в†’ { ok, dataUrl?, label? }
  appsIconPeek: invoke('apps:icon-peek'),   // РёРєРѕРЅРєР° РўРћР›Р¬РљРћ РёР· РєСЌС€Р° (serial, pkg)
  appsLabels: invoke('apps:labels'),     // РІРµСЃСЊ РёР·РІРµСЃС‚РЅС‹Р№ РєСЌС€ РёРјС‘РЅ { pkg: name }
  procsList: invoke('procs:list'),
  devStats: invoke('dev:stats'),            // РћР—РЈ/Р·Р°РіСЂСѓР·РєР° С‚РµР»РµС„РѕРЅР° РґР»СЏ РІРєР»Р°РґРєРё РїСЂРѕС†РµСЃСЃРѕРІ
  procsKill: invoke('procs:kill'),
  procsKillApps: invoke('procs:killapps'),  // В«Р—Р°РІРµСЂС€РёС‚СЊ РІСЃРµ РїСЂРёР»РѕР¶РµРЅРёСЏВ»
  devFull: invoke('dev:full'),
  // РёРЅСЃС‚СЂСѓРјРµРЅС‚С‹ СЌРєСЂР°РЅР°/СЃРёСЃС‚РµРјС‹
  devDisplay: invoke('dev:display'),
  devDisplaySet: invoke('dev:display-set'),
  devStatusbar: invoke('dev:statusbar'),
  devAnimations: invoke('dev:animations'),
  devBatteryList: invoke('dev:battery-list'),
  devBatterySet: invoke('dev:battery-set'),
  // СЃРѕС…СЂР°РЅРёС‚СЊ С‚РµРєСЃС‚РѕРІС‹Р№ С„Р°Р№Р» (CSV-СЌРєСЃРїРѕСЂС‚)
  saveTextFile: invoke('file:save-text'),
  // РїР°СЂРѕР»СЊ СЂР°Р·Р±Р»РѕРєРёСЂРѕРІРєРё СѓСЃС‚СЂРѕР№СЃС‚РІР° (С…СЂР°РЅРёС‚СЃСЏ Р·Р°С€РёС„СЂРѕРІР°РЅРЅС‹Рј, РІ UI РЅРµ РѕС‚РґР°С‘С‚СЃСЏ)
  unlockGet: invoke('unlock:get'),
  unlockSet: invoke('unlock:set'),
  unlockDel: invoke('unlock:del'),
  unlockList: invoke('unlock:list'),
  unlockDelKey: invoke('unlock:delkey'),
  unlockRun: invoke('unlock:run'),
  fsVolumes: invoke('fs:volumes'),
  fsCat: invoke('fs:cat'),                  // Р±РёРЅР°СЂРЅРѕРµ С‡С‚РµРЅРёРµ С„Р°Р№Р»Р° (РїСЂРѕСЃРјРѕС‚СЂС‰РёРє/РїР»РµРµСЂ); + maxMB
  mediaUrl: invoke('media:url'),            // РїРѕС‚РѕРєРѕРІР°СЏ СЃСЃС‹Р»РєР° РЅР° РІРёРґРµРѕ/Р°СѓРґРёРѕ СЃ С‚РµР»РµС„РѕРЅР° (Р±РµР· СЃРєР°С‡РёРІР°РЅРёСЏ РЅР° РџРљ)
  // РѕС‚РґРµР»СЊРЅРѕРµ РѕРєРЅРѕ РїР»РµРµСЂР° вЂ” РµРіРѕ РјРѕР¶РЅРѕ С‚Р°С‰РёС‚СЊ РїРѕ РІСЃРµРјСѓ СЌРєСЂР°РЅСѓ Рё РЅР° РІС‚РѕСЂРѕР№ РјРѕРЅРёС‚РѕСЂ
  playerOpen: invoke('player:open'),
  playerAction: (a, st) => ipcRenderer.send('player:action', a, st),
  playerSetTop: invoke('player:settip'),
  playerPause: () => ipcRenderer.send('player:cmd', 'pause'),
  playerVolume: (v) => ipcRenderer.send('player:volume', v),
  onPlayerInit: (cb) => ipcRenderer.on('player:init', (_e, p) => cb(p)),
  onPlayerClosed: (cb) => ipcRenderer.on('player:closed', (_e, s) => cb(s)),
  onPlayerCmd: (cb) => ipcRenderer.on('player:cmd', (_e, c) => cb(c)),
  onPlayerVolume: (cb) => ipcRenderer.on('player:volume', (_e, v) => cb(v)),
  fsOpenOnPc: invoke('fs:open-on-pc'),      // СЃРєР°С‡Р°С‚СЊ РІРѕ РІСЂРµРјРµРЅРЅСѓСЋ РїР°РїРєСѓ Рё РѕС‚РєСЂС‹С‚СЊ СЃРёСЃС‚РµРјРЅРѕР№ РїСЂРѕРіСЂР°РјРјРѕР№ (Р±СЂР°СѓР·РµСЂ/РїР»РµРµСЂ/PDF)
  fsSaveText: invoke('fs:save-text'),       // Р·Р°РїРёСЃР°С‚СЊ РѕС‚СЂРµРґР°РєС‚РёСЂРѕРІР°РЅРЅС‹Р№ С‚РµРєСЃС‚РѕРІС‹Р№ С„Р°Р№Р» РѕР±СЂР°С‚РЅРѕ РЅР° С‚РµР»РµС„РѕРЅ
  fsTmpWrite: invoke('fs:tmp-write'),       // Р±Р°Р№С‚С‹ в†’ РІСЂРµРјРµРЅРЅС‹Р№ Р»РѕРєР°Р»СЊРЅС‹Р№ С„Р°Р№Р» (HTML-РїСЂРµРІСЊСЋ)
  fsExtract: invoke('fs:extract'),          // СЂР°СЃРїР°РєРѕРІРєР° Р°СЂС…РёРІР° РІ РїР°РїРєСѓ СЃ РёРјРµРЅРµРј Р°СЂС…РёРІР° (СЃРІРѕР№СЃС‚РІР° С„Р°Р№Р»Р°)
  shellOpenPath: invoke('shell:open-path'), // РѕС‚РєСЂС‹С‚СЊ Р»РѕРєР°Р»СЊРЅС‹Р№ С„Р°Р№Р» СЃРёСЃС‚РµРјРЅРѕР№ РїСЂРѕРіСЂР°РјРјРѕР№
  usbRestart: invoke('usb:restart'),        // РїРµСЂРµР·Р°РіСЂСѓР·РєР° USB-РїРѕСЂС‚Р° (Р·Р°РІРёСЃС€РёР№ С‚РµР»РµС„РѕРЅ)
  // С„Р°Р№Р»РѕРІС‹Р№ РјРµРЅРµРґР¶РµСЂ вЂ” Р°СЂС…РёРІС‹, РєР°С‚РµРіРѕСЂРёРё, DOCX, USB-РёРЅСЃС‚СЂСѓРјРµРЅС‚С‹
  fsZipCreate: invoke('fs:zipcreate'),      // СЃРѕР±СЂР°С‚СЊ ZIP РёР· С„Р°Р№Р»РѕРІ/РїР°РїРѕРє СѓСЃС‚СЂРѕР№СЃС‚РІР°
  fsZipList: invoke('fs:ziplist'),          // СЃРѕРґРµСЂР¶РёРјРѕРµ ZIP-Р°СЂС…РёРІР° Р±РµР· СЂР°СЃРїР°РєРѕРІРєРё
  fsZipRead: invoke('fs:zipread'),          // РїСЂРѕС‡РёС‚Р°С‚СЊ С„Р°Р№Р» РР— Р°СЂС…РёРІР° (Р±Р°Р№С‚С‹)
  fsSearch: invoke('fs:search'),            // РєР°С‚РµРіРѕСЂРёРё: РІСЃРµ С„РѕС‚Рѕ/РјСѓР·С‹РєР°/РІРёРґРµРѕ/РґРѕРєСѓРјРµРЅС‚С‹
  fsDocx: invoke('fs:docx'),                // DOCX в†’ HTML РґР»СЏ РїСЂРѕСЃРјРѕС‚СЂР°
  apkInstalledInfo: invoke('apk:installedinfo'), // СѓСЃС‚Р°РЅРѕРІР»РµРЅР° Р»Рё РІРµСЂСЃРёСЏ РїР°РєРµС‚Р° РЅР° С‚РµР»РµС„РѕРЅРµ
  apkPhoneInstall: invoke('apk:phoneinstall'),   // СѓСЃС‚Р°РЅРѕРІРёС‚СЊ APK, РєРѕС‚РѕСЂС‹Р№ СѓР¶Рµ Р»РµР¶РёС‚ РЅР° С‚РµР»РµС„РѕРЅРµ
  appsRun: invoke('apps:run'),              // Р·Р°РїСѓСЃС‚РёС‚СЊ СѓСЃС‚Р°РЅРѕРІР»РµРЅРЅРѕРµ РїСЂРёР»РѕР¶РµРЅРёРµ РЅР° С‚РµР»РµС„РѕРЅРµ
  usbInfo: invoke('usb:info'),
  usbFormat: invoke('usb:format'),
  usbLabel: invoke('usb:label'),
  usbCheck: invoke('usb:check'),
  usbEject: invoke('usb:eject'),
  usbFakeTestStart: invoke('usb:faketest-start'),
  usbFakeTestCancel: invoke('usb:faketest-cancel'),
  miniClose: () => ipcRenderer.send('mini:close'), // Р·Р°РєСЂС‹С‚СЊ РјРёРЅРё-РѕРєРЅРѕ APK (window.close Р·Р°РїСЂРµС‰С‘РЅ РІ sandbox)
  miniOpenMain: () => ipcRenderer.send('mini:open-main'), // РѕС‚РєСЂС‹С‚СЊ РѕСЃРЅРѕРІРЅСѓСЋ РїСЂРѕРіСЂР°РјРјСѓ РёР· СѓСЃС‚Р°РЅРѕРІС‰РёРєР°
  trayMenu: (m) => ipcRenderer.send('traymenu:' + m), // СЃРѕР±СЃС‚РІРµРЅРЅРѕРµ С‚СЂРµР№-РјРµРЅСЋ
  apkLocalMeta: invoke('apk:localmeta'),    // РёРєРѕРЅРєР°/РёРјСЏ/РїР°РєРµС‚/РІРµСЂСЃРёСЏ Р»РѕРєР°Р»СЊРЅРѕРіРѕ APK
  apkMakeShortcut: invoke('apk:make-shortcut'), // СЏСЂР»С‹Рє РЅР° СЂР°Р±РѕС‡РµРј СЃС‚РѕР»Рµ СЃ РёРєРѕРЅРєРѕР№ РїСЂРёР»РѕР¶РµРЅРёСЏ
  apkRemoteMeta: invoke('apk:remotemeta'),  // РёРєРѕРЅРєР°/РёРјСЏ APK-С„Р°Р№Р»Р°, Р»РµР¶Р°С‰РµРіРѕ РќРђ РўР•Р›Р•Р¤РћРќР•
  apkInstallBatch: invoke('apk:installbatch'), // РѕС‡РµСЂРµРґСЊ СѓСЃС‚Р°РЅРѕРІРєРё (apk/xapk/apks/obb)
  apkInstallCancel: invoke('apk:installcancel'),
  copyText: invoke('clipboard:write'),      // РєРѕРїРёСЂРѕРІР°РЅРёРµ Р»РѕРіРѕРІ/С‚РµРєСЃС‚Р° С‡РµСЂРµР· main
  clipStart: invoke('clip:start'),
  clipStop: invoke('clip:stop'),
  clipState: invoke('clip:state'),
  clipClear: invoke('clip:clear'),
  clipCopy: invoke('clip:copy'),
  appsMeta: invoke('apps:meta'),            // СЂР°Р·РјРµСЂС‹/РґР°С‚С‹ РґР»СЏ СЃРѕСЂС‚РёСЂРѕРІРєРё
  appsInstallTimes: invoke('apps:installtimes'), // СЂРµР°Р»СЊРЅС‹Рµ РґР°С‚С‹ СѓСЃС‚Р°РЅРѕРІРєРё РїСЂРёР»РѕР¶РµРЅРёР№
  iconsClear: invoke('icons:clear'),
  winClearIconCache: invoke('win:cleariconcache'),  // РєСЌС€ РёРєРѕРЅРѕРє РџСЂРѕРІРѕРґРЅРёРєР° (Windows)        // РѕС‡РёСЃС‚РёС‚СЊ РєСЌС€ РёРєРѕРЅРѕРє (РїР°РјСЏС‚СЊ + СЃС‚Р°СЂР°СЏ РїР°РїРєР°)
  assocGet: invoke('assoc:get'),            // СЃРѕСЃС‚РѕСЏРЅРёРµ Р°СЃСЃРѕС†РёР°С†РёР№ С„Р°Р№Р»РѕРІ
  assocSet: invoke('assoc:set'),
  shellextStatus: invoke('shellext:status'),       // РёРєРѕРЅРєРё РїСЂРёР»РѕР¶РµРЅРёР№ РІ РџСЂРѕРІРѕРґРЅРёРєРµ
  shellextInstall: invoke('shellext:install'),
  shellextUninstall: invoke('shellext:uninstall'),
  restartExplorer: invoke('shellext:restart-explorer'),
  // СЃРІРѕРё РєРѕРјР°РЅРґС‹ С‚РµСЂРјРёРЅР°Р»Р° (F16) вЂ” С…СЂР°РЅСЏС‚СЃСЏ РІ В«РЎРѕС…СЂР°РЅРµРЅРёСЏ/РњРѕРё РєРѕРјР°РЅРґС‹.jsonВ»
  cmdsList: invoke('cmds:list'),
  cmdsAdd: invoke('cmds:add'),
  cmdsRemove: invoke('cmds:remove'),
  // MCP-Р°РіРµРЅС‚ вЂ” С‚СѓРјР±Р»РµСЂ, Р°РІР°СЂРёР№РЅР°СЏ РѕСЃС‚Р°РЅРѕРІРєР°, СЃРѕСЃС‚РѕСЏРЅРёРµ
  agentGetState: invoke('agent:get-state'),
  agentSetEnabled: invoke('agent:set-enabled'),
  agentStop: invoke('agent:stop'),
  agentReset: invoke('agent:reset'),
  agentDispatch: invoke('agent:dispatch'),
  onMirrorChunk: (cb) => ipcRenderer.on('mirror:chunk', (_e, buf) => cb(buf)),
  onMirrorJpeg: (cb) => ipcRenderer.on('mirror:jpeg', (_e, frame) => cb(frame)), // {seq, buf}
  onShellOut: (cb) => ipcRenderer.on('shell:out', (_e, t) => cb(t)),
  onApkMiniFile: (cb) => ipcRenderer.on('apkmini:file', (_e, p) => cb(p)), // РЅРѕРІРѕРµ РёРјСЏ APK РІ РјРёРЅРё-РѕРєРЅРµ

  // СЃРѕР±С‹С‚РёСЏ РёР· main
  onLogcat: (cb) => ipcRenderer.on('logcat:lines', (_e, lines) => cb(lines)),
  onClipItem: (cb) => ipcRenderer.on('clip:item', (_e, item) => cb(item)),
  onClipStatus: (cb) => ipcRenderer.on('clip:status', (_e, st) => cb(st)),
  onTask: (cb) => ipcRenderer.on('task:event', (_e, ev) => cb(ev)),
  onTrayConnect: (cb) => ipcRenderer.on('tray:connect', (_e, h) => cb(h))
});

window.addEventListener('error', (e) => {
  try { ipcRenderer.send('log:renderer', (e.message || 'error') + ' @' + (e.filename || '') + ':' + (e.lineno || 0)); } catch (err) {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { ipcRenderer.send('log:renderer', 'unhandledrejection: ' + String(e.reason && e.reason.message || e.reason).slice(0, 300)); } catch (err) {}
});

