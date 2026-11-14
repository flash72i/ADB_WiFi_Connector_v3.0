// main.js — главный процесс Electron: окно, трей, автостарт, IPC, adb-операции

// Разбудить экран, свайпнуть вверх и ввести пароль (PIN/пароль) или нарисовать графический ключ
async function unlockDevice(serial, opts) {
  const rd = await unlockRead(serial);
  const recType = (rd.rec && rd.rec.type) || 'pin';
  const saved = rd.pin;
  const pin = saved || (opts && opts.pin ? String(opts.pin) : '');
  const type = (opts && opts.type) || recType;
  if (!pin) return { ok: false, error: 'Пароль для этого устройства не сохранён' };
  const run = (args, t) => adb.run(['-s', serial, 'shell', ...args], { timeout: t || 12000 });
  const step = (opts && opts.step) || 'full';
  try {
    // размер экрана нужен и для свайпа, и для сетки ключа
    let w = 1080, h = 2400;
    try {
      const s = await adb.run(['-s', serial, 'shell', 'wm', 'size'], { timeout: 6000 });
      const m = (s.stdout || '').match(/(\d+)x(\d+)/);
      if (m) { w = +m[1]; h = +m[2]; }
    } catch (e) {}
    // 1) включить экран и разбудить
    if (step === 'full' || step === 'wake') {
      await run(['input', 'keyevent', '224']);          // KEYCODE_WAKEUP
      await sleep(250);
      await run(['wm', 'dismiss-keyguard']);            // снять простой экран блокировки
      await sleep(250);
    }
    // 2) свайп вверх
    if (step === 'full' || step === 'swipe') {
      const x = Math.round(w / 2);
      await run(['input', 'swipe', String(x), String(Math.round(h * 0.75)), String(x), String(Math.round(h * 0.25)), '180']);
      await sleep(350);
    }
    // 3) ввод пароля и Enter — или рисунок ключа
    if (step === 'full' || step === 'type') {
      if (type === 'pattern') {
        const r = await drawPattern(serial, pin, w, h);
        if (!r.ok) return r;
      } else {
        const safe = String(pin).replace(/[%\\"]/g, c => '\\' + c).replace(/\s/g, '%s');
        const r = await run(['input', 'text', shqSafe(safe)]);
        if (!r.ok) return { ok: false, error: 'Не удалось ввести пароль: ' + ((r.stderr || r.stdout || '').slice(0, 120)) };
        await sleep(200);
        await run(['input', 'keyevent', '66']);           // KEYCODE_ENTER
        await sleep(400);
      }
    }
    return { ok: true, message: type === 'pattern' ? 'Ключ нарисован' : 'Экран разблокирован' };
  } catch (e) { return { ok: false, error: e.message }; }
}
// Рисование графического ключа: последовательность цифр 1–9 по сетке 3×3.
// Сетка стоит по центру экрана чуть выше середины; на нетипичных прошивках
// координаты можно сдвинуть параметрами calib (cx, cy, step) из MCP.
async function drawPattern(serial, pattern, w, h, calib) {
  const seq = String(pattern).replace(/[^1-9]/g, '').split('').map(Number);
  if (seq.length < 2) return { ok: false, error: 'Ключ должен содержать минимум 2 точки (цифры 1–9)' };
  if (!w || !h) { w = 1080; h = 2400; }
  const c = calib || {};
  const cx = Math.round(c.cx || w / 2);
  const cy = Math.round(c.cy || h * 0.45);
  const step = Math.round(c.step || Math.min(w, h * 0.5) * 0.2);
  const pt = n => ({
    x: Math.round(cx + ((n - 1) % 3 - 1) * step),
    y: Math.round(cy + (Math.floor((n - 1) / 3) - 1) * step)
  });
  const p0 = pt(seq[0]);
  let r = await adb.run(['-s', serial, 'shell', 'input', 'motionevent', 'DOWN', String(p0.x), String(p0.y)], { timeout: 8000 });
  const out0 = ((r.stdout || '') + (r.stderr || '')).trim();
  if (!r.ok || /unknown|error|usage/i.test(out0)) {
    return { ok: false, error: 'Устройство не поддерживает рисование ключа через motionevent (нужен Android 11+)' };
  }
  for (const n of seq.slice(1)) {
    const p = pt(n);
    await sleep(70);
    await adb.run(['-s', serial, 'shell', 'input', 'motionevent', 'MOVE', String(p.x), String(p.y)], { timeout: 8000 });
  }
  await sleep(70);
  const pl = pt(seq[seq.length - 1]);
  await adb.run(['-s', serial, 'shell', 'input', 'motionevent', 'UP', String(pl.x), String(pl.y)], { timeout: 8000 });
  await sleep(450);
  return { ok: true };
}
// единое активное устройство (R8), без автоподключения по умолчанию (R3),
// зеркало h264+фолбэк и валидный time-limit (R9), мульти-установка APK (R10), гашение
// всех дочерних процессов при выходе (A2-ревью), mDNS adb не глушится (корень R5).
'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, clipboard, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');   // сборка ZIP-архивов (fs:zipcreate)
const http = require('http');   // статус локального сервера камеры
const { execFile, spawn } = require('child_process');
const adb = require('./adb');
const crashlog = require('./crashlog');   // разбор падений/ANR по logcat
const appaudit = require('./appaudit');  // аудит разрешений и AppOps
const mdns = require('./mdns');
const agentMcp = require('./agent-mcp');   // встроенный MCP-сервер для ИИ-агента
const qrpair = require('./qrpair');
let devDetectFn = null;

// разрешаем автовоспроизведение медиа в плеере БЕЗ жеста пользователя —
// иначе Chromium блокировал video.play() после асинхронной загрузки файла с телефона
// («открывается плеер, но не воспроизводит, просто чёрный экран»)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// dev/агентный запуск — явно включаем CDP-порт (иначе Electron не всегда сам
// слушает remote-debugging-port, и CDP-тесты «зависают», подключаясь к старому коду)
const DEV_PORT_ARG = process.argv.find(a => a.indexOf('--remote-debugging-port=') === 0);
if (DEV_PORT_ARG) {
  const p = DEV_PORT_ARG.split('=')[1] || '9229';
  app.commandLine.appendSwitch('remote-debugging-port', p);
  app.commandLine.appendSwitch('remote-allow-origins', '*');
}

// база: каталог над APP/, если exe лежит в APP/, иначе каталог exe
const BASE_DIR = (() => {
  const d = path.dirname(process.execPath);
  return path.basename(d).toUpperCase() === 'APP' ? path.dirname(d) : d;
})();
const IS_INSTALLED = (() => { try { return fs.existsSync(path.join(BASE_DIR, '.installed')); } catch (e) { return false; } })();

// (F16): ВСЕ сохранения — строго в папке с программой: <BASE_DIR>/Сохранения
const SAVE_DIR = path.join(BASE_DIR, 'Сохранения');
const CAPTURES = path.join(SAVE_DIR, 'Захваты');          // скриншоты/видео по умолчанию
const CFG_FILE = path.join(SAVE_DIR, 'config.json');
const HIST_FILE = path.join(SAVE_DIR, 'history.json');
const FAV_FILE = path.join(SAVE_DIR, 'favorites.json');
const SAVED_FILE = path.join(SAVE_DIR, 'saved.json');
const CMDS_FILE = path.join(SAVE_DIR, 'Мои команды.json'); // свои команды терминала
const ICON_CACHE = path.join(SAVE_DIR, 'Кэш иконок');      // кэш иконок/имён приложений
const LOG_FILE = path.join(BASE_DIR, 'app.log');
const UNLOCK_FILE = path.join(SAVE_DIR, 'unlock.json');   // PIN/пароли разблокировки (шифрованные)

/* ---------- хранилище PIN/пароля разблокировки ----------
   Пароль нужен, чтобы программа (и MCP-агент) могли сами разбудить и разблокировать
   телефон: включить экран → свайп вверх → ввод PIN → Enter. Хранение:
   safeStorage (DPAPI Windows) — на диск попадает только шифротекст, привязанный
   к учётной записи Windows. Если шифрование недоступно — не сохраняем вовсе. */
let unlockStore = null;
function unlockLoad() {
  if (unlockStore) return unlockStore;
  unlockStore = {};
  try {
    if (fs.existsSync(UNLOCK_FILE)) {
      const raw = JSON.parse(fs.readFileSync(UNLOCK_FILE, 'utf8') || '{}');
      unlockStore = raw && typeof raw === 'object' ? raw : {};
    }
  } catch (e) { unlockStore = {}; }
  return unlockStore;
}
function unlockSave() { saveJson(UNLOCK_FILE, unlockStore || {}); }
// ключ хранилища — аппаратный серийник (ro.serialno), а не host:port:
// у Wi-Fi ADB порт меняется между подключениями, а пароль должен остаться «у устройства».
const unlockKeyCache = new Map();
async function unlockStableKey(serial) {
  const s = String(serial || '');
  if (!s) return 'default';
  if (unlockKeyCache.has(s)) return unlockKeyCache.get(s);
  let key = null;
  try {
    const r = await adb.run(['-s', s, 'shell', 'getprop', 'ro.serialno'], { timeout: 6000 });
    const hw = (r.stdout || '').trim();
    if (r.ok && hw && hw !== 'unknown') key = 'hw:' + hw;
  } catch (e) {}
  if (!key) key = s;
  unlockKeyCache.set(s, key);
  return key;
}
function unlockSeal(text) {
  try {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
    return { enc: safeStorage.encryptString(String(text)).toString('base64') };
  } catch (e) { return null; }
}
function unlockOpen(rec) {
  try {
    if (!rec || !rec.enc) return null;
    return safeStorage.decryptString(Buffer.from(rec.enc, 'base64'));
  } catch (e) { return null; }
}
// Чтение записи: ключ — аппаратный серийник; старые записи по host:port тоже понимаем
async function unlockRead(serial) {
  const key = await unlockStableKey(serial);
  const st = unlockLoad();
  const rec = st[key] || st[String(serial || '')] || null;
  return { key, rec, pin: unlockOpen(rec) };
}
async function unlockStorePin(serial, pin, type) {
  const key = await unlockStableKey(serial);
  const sealed = unlockSeal(pin);
  if (!sealed) return null;
  const st = unlockLoad();
  let model = null;
  try {
    const m = await adb.run(['-s', serial, 'shell', 'getprop', 'ro.product.model'], { timeout: 6000 });
    model = (m.stdout || '').trim() || null;
  } catch (e) {}
  st[key] = {
    enc: sealed.enc, at: Date.now(), len: String(pin).length,
    type: type === 'pattern' ? 'pattern' : 'pin',
    model: model || (st[key] && st[key].model) || null
  };
  delete st[String(serial || '')];   // подчищаем старую запись по host:port
  unlockSave();
  return key;
}
// список сохранённых паролей — для диалога «лист» в интерфейсе и агента
function unlockList() {
  const st = unlockLoad();
  return Object.keys(st).map(k => {
    const r = st[k] || {};
    return { key: k, len: r.len || 0, at: r.at || 0, type: r.type || 'pin', model: r.model || null };
  }).sort((a, b) => (b.at || 0) - (a.at || 0));
}
async function unlockRemove(serial) {
  const key = await unlockStableKey(serial);
  const st = unlockLoad();
  delete st[key];
  delete st[String(serial || '')];
  unlockSave();
}

function shqSafe(p) {
  if (/^[A-Za-z0-9_@%+=:,./\-]+$/.test(p)) return p;
  return "'" + String(p).replace(/'/g, "'\\''") + "'";
}

// ---------- журнал: ошибки (ERROR) + важные события/диагностика (INFO), ротация при переполнении ----------
function logLine(level, tag, ...a) {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      try { fs.renameSync(LOG_FILE, LOG_FILE.replace(/\.log$/, '.old.log')); } catch (e) {}
    }
    const line = new Date().toISOString() + ' ' + level + ' ' + tag + ' ' + a.map(x =>
      typeof x === 'string' ? x : (x instanceof Error ? (x.stack || x.message) : JSON.stringify(x))).join(' ') + '\n';
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {}
}
function logErr(tag, ...a) { logLine('ERROR', tag, ...a); }
// INFO-уровень — диагностика и ключевые события попадают в app.log по просьбе владельца
// («когда я запускаю диагностику, вся эта информация должна отображаться в логфайле»)
function logInfo(tag, ...a) { logLine('INFO ', tag, ...a); }
// совместимость: прежние информационные log() больше НЕ пишут в файл
function log() {}
process.on('uncaughtException', e => { logErr('uncaught', e && (e.stack || e.message) || String(e)); });
process.on('unhandledRejection', e => { logErr('unhandledRejection', e && (e.stack || e.message) || String(e)); });

const DEFAULTS = {
  adbPath: null,
  scrcpyPath: null,
  autostart: false,
  closeToTray: false,
  theme: 'dark',
  scanOnStart: false,
  autoreconnect: false,
  autolast: false,
  autoconnect: false,
sounds: true,
  showPkgNames: false,  // приложения: показывать имена (false) или пакеты (true) — F11
  agentEnabled: false,  // управление программой через MCP-агента (Настройки)
  assocOn: IS_INSTALLED,
  shellextOn: IS_INSTALLED,
  modeInit: false,
  portableCleanupDone: false,
  migrated24: false,    // одноразовая миграция: автовключённые ранее автоподключения выключаем
  migrated25: false,    // одноразовая миграция сохранений в «Сохранения/» (F16)
  migratedCloseQuit: false // по умолчанию крестик завершает программу, а не прячет в трей
};

let config = Object.assign({}, DEFAULTS);
let history = [];   // [{host, port, model, lastTs}]
let favorites = []; // [{host, port, model}]
let win = null;
let tray = null;
let quitting = false;
let miniOnly = false;    // запуск «только установщик» (двойной клик по APK при закрытой программе)
let mainShown = false;   // показывалось ли главное окно в этой сессии
let forceShowMain = false; // «Открыть программу» из установщика — показать окно вопреки пусковой логике
let miniWin = null;   // отдельное окно установки APK (ассоциация файлов — БЕЗ основной программы)
let playerWin = null; // отсоединяемый плеер — своё окно, можно двигать по всему экрану
let playerClosing = false;

const ALLOWED_SETTINGS = new Set(['adbPath', 'scrcpyPath', 'autostart', 'closeToTray', 'theme', 'scanOnStart', 'autoreconnect', 'autolast', 'autoconnect', 'sounds', 'favCmds', 'showPkgNames', 'agentEnabled']);

// трей создаётся лениво — в режиме «только установщик» его нет вовсе
function ensureTray() {
  try {
    if (tray && !tray.isDestroyed()) return;
    tray = new Tray(trayIcon());
    buildTrayMenu();
  } catch (e) { logErr('tray', e.message); }
}

// дочерние процессы — на уровне модуля: before-quit обязан гасить ВСЕ (A2-ревью)
let logcatChild = null;
let recordChild = null;
let recordMeta = null;
let recordQuitClosing = false;
let closeScrcpyWindowFn = null;
let shellChild = null;      // раньше жил в замыкании registerIpc и переживал выход
let installChild = null;    // текущий «adb install» (для отмены)
let installCanceled = false;
let mirrorChild = null, mirrorMode = null, mirrorSerial = null;
let cameraProc = null;       // Python-сервер камеры телефона (страница «Камера»)
let audioProc = null;        // Python-сервер микрофона телефона (страница «Микрофон»)
let mirrorJpegChild = null, mirrorTimer = null, mirrorWatchdog = null;
let mirrorGen = 0, mirrorRestarts = 0, mirrorLastData = 0, jpegSeq = 0;

const PAIR_HTTP_NOTE = 'removed-in-v2';

function localIpv4() {
  const ifaces = os.networkInterfaces();
  for (const k of Object.keys(ifaces)) for (const a of ifaces[k] || []) {
    if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// история буфера обмена телефона без установки APK. scrcpy в режиме
// «без окна/видео/звука» держит control-канал и синхронизирует буфер телефона
// в системный буфер Windows; мы записываем изменения в память.
let clipScrcpy = null, clipPoll = null, clipSerial = null, clipLast = '';
const clipHistory = [];
const CLIP_MAX = 50;
function clipEmit(channel, payload) {
  try { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); } catch (e) {}
}
function clipRead() {
  try { return String(clipboard.readText() || ''); } catch (e) { return ''; }
}
function clipStop(silent) {
  if (clipPoll) { clearInterval(clipPoll); clipPoll = null; }
  const c = clipScrcpy;
  clipScrcpy = null;
  clipSerial = null;
  clipLast = '';
  if (c) { try { c.kill('SIGKILL'); } catch (e) {} }
  if (!silent) clipEmit('clip:status', { running: false });
}
function clipPollOnce() {
  if (!clipScrcpy) return;
  const txt = clipRead().slice(0, 20000);
  if (!txt || txt === clipLast) return;
  clipLast = txt;
  const item = { text: txt, ts: Date.now() };
  clipHistory.unshift(item);
  if (clipHistory.length > CLIP_MAX) clipHistory.length = CLIP_MAX;
  clipEmit('clip:item', item);
}
async function clipFindExe() {
  const candidates = [];
  if (config.scrcpyPath) candidates.push(config.scrcpyPath);
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'scrcpy', 'scrcpy.exe'));
  candidates.push(path.join(__dirname, 'scrcpy-bundle', 'scrcpy.exe'));
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) {}
  }
  return await new Promise(res => execFile('where.exe', ['scrcpy.exe'], { windowsHide: true }, (err, out) => res(err ? null : out.trim().split(/\r?\n/)[0])));
}
async function clipStart(serial) {
  if (!serial) return { ok: false, error: 'Нет подключённого устройства' };
  const exe = await clipFindExe();
  if (!exe || !fs.existsSync(exe)) return { ok: false, error: 'scrcpy.exe не найден' };
  const old = clipSerial;
  clipStop(true);
  if (old && old !== serial) clipHistory.length = 0;
  clipSerial = serial;
  clipLast = clipRead();
  try { await adb.run(['start-server'], { timeout: 8000 }); } catch (e) {}
  try {
    const child = spawn(exe, ['-s', serial, '--no-window', '--no-video', '--no-audio'], {
      windowsHide: true,
      cwd: path.dirname(exe),
      stdio: ['ignore', 'ignore', 'pipe']
    });
    clipScrcpy = child;
    let err = '';
    child.stderr.on('data', d => { err = (err + d.toString('utf8')).slice(-4000); });
    child.on('error', e => {
      if (clipScrcpy === child) {
        clipScrcpy = null;
        if (clipPoll) { clearInterval(clipPoll); clipPoll = null; }
        clipSerial = null;
        clipEmit('clip:status', { running: false, error: e.message });
      }
    });
    child.on('close', () => {
      if (clipScrcpy === child) {
        clipScrcpy = null;
        if (clipPoll) { clearInterval(clipPoll); clipPoll = null; }
        clipSerial = null;
        clipEmit('clip:status', { running: false, error: err.trim().slice(-300) || null });
      }
    });
    clipPoll = setInterval(clipPollOnce, 700);
    setTimeout(clipPollOnce, 1500);
    clipEmit('clip:status', { running: true, serial, items: clipHistory });
    return { ok: true, serial };
  } catch (e) {
    clipStop(true);
    return { ok: false, error: e.message };
  }
}

// Автопайплайн: знаем IP телефона и код -> сами находим порты, сопрягаем, подключаем
// поиск портов — БЫСТРЫЙ (ранний выход после первого найденного порта, ~1–2 с
// вместо полного свипа на ~24 с) — отсюда была «вечная» фаза сопряжения
async function autoPairConnect(host, code, hintPort) {
  let ports;
  if (hintPort) {
    const probe = await adb.tcpProbe(host, hintPort);
    ports = probe ? [hintPort] : await adb.portScanFast(host);
  } else {
    ports = await adb.portScanFast(host);
  }
  let paired = false, pairPort = null;
  for (const p of ports) {
    const r = await adb.pair(host, p, code);
    if (r.ok) { paired = true; pairPort = p; break; }
  }
  if (!paired) {
    return { ok: false, error: 'Сопряжение не удалось (порты: ' + (ports.slice(0, 8).join(', ') || 'не найдены') + '). Держите на телефоне открытым экран «Сопряжение по коду».' };
  }
  // после сопряжения порт сопряжения закрывается и открывается порт отладки — часто СОСЕДНИЙ:
  // сначала пробуем соседние порты (мгновенно), затем быстрый свип
  const after = [];
  for (const p of [pairPort + 1, pairPort - 1, pairPort + 2]) if (p > 1024) after.push(p);
  const swept = await adb.portScanFast(host);
  const connPorts = after.concat(swept).filter((p, i, a) => p !== pairPort && a.indexOf(p) === i);
  if (!connPorts.length) connPorts.push(5555);
  for (const p of connPorts) {
    // подключаем через ЕДИНУЮ точку: rememberDevice + трей (R8)
    const c = await connectDevice(host, p);
    if (c.ok) {
      let name = '';
      try { const m = await adb.modelName(`${host}:${p}`); name = m.model; } catch (e) {}
      return { ok: true, host, port: p, model: name };
    }
  }
  return { ok: false, error: 'Сопряжение выполнено, но подключиться не удалось. Введите IP:порт с экрана «Беспроводная отладка» вручную.' };
}

function ensureDirs() {
  for (const d of [SAVE_DIR, CAPTURES]) try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  // дисковый кэш иконок больше не используется — старую папку убираем как хлам
  try { if (fs.existsSync(ICON_CACHE)) fs.rmSync(ICON_CACHE, { recursive: true, force: true }); } catch (e) {}
}
function loadJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } }
function saveJson(f, v) {
  let text;
  try { text = JSON.stringify(v, null, 2); } catch (e) { logErr('saveJson', f, e.message); return; }
  try {
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, f);
  } catch (e) {
    try { fs.writeFileSync(f, text); } catch (e2) { logErr('saveJson', f, e2.message); }
  }
}
// одноразовая миграция старых сохранений из %APPDATA%/adb-wifi-ru в «Сохранения/» (F16).
// после копирования config.json ПЕРЕЧИТЫВАЕМ его — иначе настройки
// старой установки (adbPath, тема, размеры окна) безвозвратно теряются при обновлении
function migrateSaves() {
  if (config.migrated25) return;
  const OLD = path.join(app.getPath('appData'), 'adb-wifi-ru');
  const files = ['config.json', 'history.json', 'favorites.json', 'saved.json'];
  let copiedCfg = false;
  for (const f of files) {
    const src = path.join(OLD, f), dst = path.join(SAVE_DIR, f);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) { fs.copyFileSync(src, dst); if (f === 'config.json') copiedCfg = true; }
    } catch (e) { logErr('migrate25', f, e.message); }
  }
  // старые иконки из %APPDATA% больше не копируем — кэш иконок не используется
  if (copiedCfg) {
    // перечитываем унаследованные настройки и применяем здесь же (migrated24 уже внутри)
    config = Object.assign({}, DEFAULTS, loadJson(CFG_FILE, {}));
    if (!config.migrated24) { config.autolast = false; config.autoreconnect = false; config.migrated24 = true; }
    if (config.adbPath) adb.setAdbPath(config.adbPath);
  }
  config.migrated25 = true; saveConfig();
}
function loadAll() {
  ensureDirs();
  config = Object.assign({}, DEFAULTS, loadJson(CFG_FILE, {}));
  if (!config.modeInit) {
    config.assocOn = IS_INSTALLED;
    config.shellextOn = IS_INSTALLED;
    config.modeInit = true;
    saveConfig();
  }
  // R3: владелец требует «не подключаться при запуске, если я не выбрал в настройках».
  // Прежние версии включали автоподключения — одноразово выключаем, точечно (winBounds,
  // adbPath, scrcpyPath, favCmds не трогаем); в настройках можно включить обратно.
  if (!config.migrated24) {
    config.autolast = false;
    config.autoreconnect = false;
    config.migrated24 = true;
  }
  migrateSaves(); // должен идти ПОСЛЕ чтения config: использует флаг migrated25
  if (!config.migratedCloseQuit) {
    config.closeToTray = false;
    config.migratedCloseQuit = true;
    saveConfig();
  }
  history = loadJson(HIST_FILE, []);
  favorites = loadJson(FAV_FILE, []);
  if (config.adbPath) adb.setAdbPath(config.adbPath);
}
function saveConfig() { saveJson(CFG_FILE, config); }

// ---------- единая точка подключения (R8: строго одно активное сетевое устройство) ----------
let connectChain = Promise.resolve();
function connectDevice(host, port, opts = {}) {
  const run = async () => {
    const r = await adb.connect(host, port);
    if (!r.ok) return r;
    // adb connect может ответить «OK», а устройство остаться OFFLINE (устаревший порт:
    // TCP приняли, но TLS/ключи не сошлись). Раньше это давало бесконечный цикл
    // «connect OK → active lost» и спам ошибок в журнале. Проверяем фактическое состояние.
    const serial = `${host}:${port}`;
    let st = null;
    for (const delay of [500, 900]) {
      await sleep(delay);
      const d = await adb.devices().catch(() => ({ ok: false, list: [] }));
      st = (d.list || []).find(dd => dd.serial === serial);
      if (st && st.state === 'device') break;
    }
    if (!st || st.state !== 'device') {
      try { await adb.disconnect(serial); } catch (e) {}
      return { ok: false, message: 'Порт ' + port + ' ответил, но устройство не перешло в состояние online — порт устарел. Порт меняется при каждом включении «Беспроводной отладки»: возьмите на телефоне ТЕКУЩИЙ порт.' };
    }
    let name = opts.model || '';
    if (!name) { try { const m = await adb.modelName(`${host}:${port}`); name = m.model; } catch (e) {} }
    rememberDevice(host, port, name);
    // БОЛЬШЕ НЕ ОТКЛЮЧАЕМ другие устройства. Раньше enforceSingleDevice после
    // каждого подключения рвал все прочие Wi-Fi-сессии — со стороны это выглядело как
    // «устройство само отключилось». Теперь устройства живут, пока пользователь не
    // нажмёт «Отключить» (или пока adb сам не потеряет связь).
    sendTask({ kind: 'connected', host, port });
    buildTrayMenu();
    return r;
  };
  const p = connectChain.then(run, run);
  connectChain = p.catch(() => {});
  return p;
}

// принудительное отключение «прочих» устройств убрано — устройства не должны
// пропадать сами. Единственный способ разорвать сессию — кнопка «Отключить» у устройства.

// Автостарт (реестр HKCU Run): состояние пишем ТОЛЬКО при успехе (W6-ревизор)
function setAutostart(on) {
  const exe = process.execPath;
  const key = ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'];
  return new Promise((resolve) => {
    if (!process.platform.startsWith('win')) return resolve({ ok: false, error: 'Доступно только в Windows' });
    const args = on
      ? ['add', key[0], '/v', 'AdbWifiConnectorRu', '/t', 'REG_SZ', '/d', `"${exe}" --hidden`, '/f']
      : ['delete', key[0], '/v', 'AdbWifiConnectorRu', '/f'];
    execFile('reg.exe', args, { windowsHide: true }, (err, out, errOut) => {
      if (!err) { config.autostart = on; saveConfig(); }
      else logErr('autostart', errOut || err.message);
      resolve({ ok: !err, message: err ? (errOut || err.message) : 'OK' });
    });
  });
}

// ---------- окно ----------
function startupApkFile(argv) {
  for (const a of (argv || []).slice(1)) {
    try {
      if (a && fs.existsSync(a) && fs.statSync(a).isFile() &&
          /\.(apk|aab|apks|xapk|apkm|obb|apk\.1|apk\+|apup|apks\.zip|apk\.zip)$/i.test(a)) return a;
    } catch (e) {}
  }
  return null;
}
function createWindow() {
  // окно не должно вылезать за рабочую область: на Windows с масштабом 125–150%
  // жёсткие размеры обрезаются системой — элементы «съезжают» (FIX-L1/L2, R4-2.3.1)
  const { screen } = require('electron');
  let wa = { x: 0, y: 0, width: 1280, height: 800 };
  try { wa = screen.getPrimaryDisplay().workArea; } catch (e) {}
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  // размер и ПОЗИЦИЯ окна — по ЗАМЕРУ владельца: 1159×835, X=420, Y=102.
  // Замер ОДИН РАЗ применяется даже при наличии сохранённых границ (флаг winBoundsApplied272),
  // дальше окно открывается там, куда его поставил пользователь.
  const DEF = { x: 420, y: 102, width: 1159, height: 835 };
  let b;
  if (!config.winBoundsApplied272) { b = DEF; config.winBoundsApplied272 = true; }
  else if (config.winBounds && Number.isFinite(config.winBounds.width)) b = config.winBounds;
  else b = DEF;
  const w = clamp(b.width || DEF.width, 800, wa.width - 12);
  const h = clamp(b.height || DEF.height, 560, wa.height - 12);
  const x = clamp(b.x != null ? b.x : DEF.x, wa.x, wa.x + Math.max(0, wa.width - w - 8));
  const y = clamp(b.y != null ? b.y : DEF.y, wa.y, wa.y + Math.max(0, wa.height - h - 8));
  win = new BrowserWindow({
    x, y, width: w, height: h, minWidth: Math.min(800, wa.width - 8), minHeight: Math.min(560, wa.height - 8),
    show: false, frame: false, backgroundColor: '#0e1418',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  let boundsTimer = null;
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      try {
        if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
        const b = win.getBounds();
        if (b.width >= 800 && b.height >= 560) { config.winBounds = { x: b.x, y: b.y, width: b.width, height: b.height }; saveConfig(); }
      } catch (e) {}
    }, 700);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);   // запоминаем и ПОЗИЦИЮ окна, не только размер
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'),
    process.env.SCREENSHOT_PAGE ? { hash: process.env.SCREENSHOT_PAGE } : undefined);
  // renderer умер/перезапустился — гасим привязанные к нему потоки, иначе невидимые adb живут
  win.webContents.on('render-process-gone', () => {
    logErr('render-process-gone', 'stopping children');
    stopMirrorAll();
    try { if (logcatChild) logcatChild.kill('SIGKILL'); } catch (e) {}
    if (recordChild) {
      const child = recordChild, meta = recordMeta;
      if (typeof closeScrcpyWindowFn === 'function') {
        closeScrcpyWindowFn(child.pid, meta && meta.hwnd).then(ok => {
          if (!ok && recordChild === child) { try { child.kill('SIGKILL'); } catch (err) {} }
        }).catch(() => {
          if (recordChild === child) { try { child.kill('SIGKILL'); } catch (err) {} }
        });
      } else {
        try { child.kill('SIGKILL'); } catch (err) {}
      }
    }
    try { if (shellChild) shellChild.kill('SIGKILL'); } catch (e) {}
  });
  win.once('ready-to-show', () => {
    // если программа запущена ДВОЙНЫМ КЛИКОМ ПО APK — главное окно не показываем,
    // остаётся только окошко установщика (иначе вылезали оба окна)
    const hidden = !forceShowMain && (process.argv.includes('--hidden') || !!startupApkFile(process.argv));
    if (!hidden) { win.show(); mainShown = true; }
    // служебный режим: автотест renderer (AUTOTEST=1)
    if (process.env.AUTOTEST) {
      setTimeout(async () => {
        try {
          const res = await win.webContents.executeJavaScript(`(async () => {
            const R = [];
            const ok = (n, c) => R.push([n, !!c]);
            ok('rail 6 пунктов', document.querySelectorAll('.rail-item').length === 6);
            for (const pg of ['devices','tools','files','apps','apk','settings']) { goPage(pg); ok('страница ' + pg, document.querySelector('#page-' + pg).classList.contains('active')); }
            ok('топбар-селектор устройства', !!document.querySelector('#tb-device'));
            ok('старые селекторы удалены', !document.querySelector('#tool-device') && !document.querySelector('#fs-device') && !document.querySelector('#apps-device'));
            goPage('devices');
            ok('карточка активного устройства', !!document.querySelector('#active-card'));
            ok('способы подключения на одной странице', !!document.querySelector('.connect-ways'));
            ok('QR-кнопка внутри карточки сопряжения', !!document.querySelector('#pair-card #btn-qr-show'));
            ok('в сопряжении нет вкладок — всё на одной странице', document.querySelectorAll('#pair-card .tab').length === 0);
            ok('drag-QR удалён вместе с jsQR', !document.querySelector('#qr-drop') && typeof window.jsQR === 'undefined');
            ok('разделённые поля сопряжения', !!document.querySelector('#pair-ip') && !!document.querySelector('#pair-port') && !!document.querySelector('#pair-code'));
            openDlg('dlg-help'); ok('диалог помощи', !document.querySelector('#dlg-help').classList.contains('hidden')); closeDlg('dlg-help');
            openDlg('dlg-qrpc'); ok('диалог QR-подключения', !!document.querySelector('#qr-pc-canvas') && !!document.querySelector('#qr-pc-log')); closeDlg('dlg-qrpc');
            goPage('tools');
            ok('телефон-рамка зеркала', !!document.querySelector('.phone-frame'));
            ok('плейсхолдер зеркала', !!document.querySelector('#mirror-placeholder'));
            ok('кнопка простого режима зеркала', !!document.querySelector('#btn-mirror-fallback'));
            ok('счётчик FPS зеркала', !!document.querySelector('#mirror-fps'));
            ok('фильтр logcat', !!document.querySelector('#logcat-filter'));
            ok('список команд терминала > 10', document.querySelectorAll('#shell-cmd-select option').length > 10);
            ok('команды сгруппированы по производителям', document.querySelectorAll('#shell-cmd-select optgroup').length >= 5);
            ok('кнопка «свою команду»', !!document.querySelector('#btn-shell-cmd-save') && !!document.querySelector('#btn-shell-cmd-del'));
            ok('автодополнение в терминале', !!document.querySelector('#shell-ac'));
            ok('панель управления рядом с зеркалом', !!document.querySelector('.mirror-zone .chips .chip[data-cmd="home"]'));
            ok('нет дубля scrcpy-карточки', !document.querySelector('#btn-scrcpy'));
            ok('карточка установки APK убрана из инструментов', !document.querySelector('#apk-drop'));
            ok('просмотрщик изображений', !!document.querySelector('#dlg-imgview #imgview-img'));
            ok('медиаплеер с эквалайзером', !!document.querySelector('#dlg-media #media-el') && !!document.querySelector('#media-eq'));
            goPage('files');
            ok('чипы быстрых переходов файлов', document.querySelectorAll('#fs-quick .chip').length >= 4);
            ok('пустое состояние файлов', !!document.querySelector('#fs-empty'));
            ok('кнопка «Назад» в файлах (F5)', !!document.querySelector('#btn-fs-back'));
            ok('иконки типов файлов (F4)', !!document.querySelector('#fs-list .fs-row .fs-ico') || document.querySelector('#fs-list').innerHTML.includes('fs-ico') || typeof window.FSICONS !== 'undefined');
            ok('свойства файла (F6)', !!document.querySelector('#dlg-fsprop #fsprop-body'));
            ok('оверлей перетаскивания файлов (F8)', !!document.querySelector('#fs-drop-overlay'));
            goPage('apps');
            ok('табы приложений (включая «Все»)', document.querySelectorAll('[data-apptab]').length === 5);
            ok('сортировка приложений', !!document.querySelector('#apps-sort'));
            ok('кнопка завершить все приложения', !!document.querySelector('#btn-killall-procs'));
            goPage('apk');
            ok('очередь установки APK', !!document.querySelector('#apk2-drop') && !!document.querySelector('#btn-apk2-installall'));
            ok('селектор устройства установки', !!document.querySelector('#apk-target'));
            goPage('settings');
            ok('тумблер ассоциаций', !!document.querySelector('#set-assoc'));
            ok('кнопка debloat удалена', !document.querySelector('#btn-debloat'));
            ok('поиск приложений', !!document.querySelector('#apps-search'));
            ok('счётчики приложений (F14)', !!document.querySelector('#apps-counts'));
            ok('переключатель имена/пакеты (F11)', !!document.querySelector('#btn-apps-names'));
            ok('описания процессов (F10)', typeof window.PROCDESC !== 'undefined' && window.PROCDESC.length >= 90);
            ok('тултип приложения (F13)', !!document.querySelector('#app-tip'));
            goPage('settings');
            ok('нет слова «приятные»', !document.body.innerHTML.includes('приятные сигналы'));
            ok('тумблер автопереподключения', !!document.querySelector('#set-autoreconnect'));
            ok('модальный ввод вместо prompt', !!document.querySelector('#dlg-input'));
            ok('поле ввода модального диалога', !!document.querySelector('#input-field'));
            const df = document.querySelector('.dialog-foot');
            ok('футер диалогов переносится (R13)', df && (getComputedStyle(df).flexWrap || '') === 'wrap');
            return JSON.stringify(R);
          })()`);
          const arr = JSON.parse(res);
          for (const [n, c] of arr) console.log('TEST ' + (c ? 'PASS' : 'FAIL') + ' | ' + n);
          const fails = arr.filter(x => !x[1]).length;
          console.log('TEST SUMMARY fails=' + fails);
        } catch (e) { console.log('TEST ERROR ' + e.message); }
        app.quit();
      }, 2500);
    }
    // служебный режим: скриншот окна для проверки вёрстки (SCREENSHOT_DIR=/path)
    if (process.env.SCREENSHOT_DIR) {
      setTimeout(async () => {
        try {
          if (process.env.SCREENSHOT_PAGE) {
            await win.webContents.executeJavaScript(`location.hash='${process.env.SCREENSHOT_PAGE}';true`);
            await new Promise(r => setTimeout(r, 400));
          }
          const img = await win.capturePage();
          const f = path.join(process.env.SCREENSHOT_DIR, 'shot-' + Date.now() + '.png');
          fs.writeFileSync(f, img.toPNG());
        } catch (e) {}
        app.quit();
      }, 3000);
    }
  });
  win.on('maximize', () => win.webContents.send('win:maximized', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized', false));
  win.on('close', (e) => {
    if (!quitting && config.closeToTray) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => {
    const shouldQuit = !quitting && !config.closeToTray && !miniOnly;
    win = null;
    if (shouldQuit) {
      try { if (trayMenuWin && !trayMenuWin.isDestroyed()) trayMenuWin.destroy(); } catch (e) {}
      app.quit();
    }
  });
  return win;
}

function showMainWindow() {
  try {
    if (!win || win.isDestroyed()) {
      forceShowMain = true;
      miniOnly = false;
      createWindow();
    }
    if (!win || win.isDestroyed()) return false;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    try { win.moveTop(); } catch (e) {}
    mainShown = true;
    return true;
  } catch (e) {
    logErr('showMainWindow', e.message);
    return false;
  }
}

function sendMainTask(ev) {
  const deliver = () => {
    try {
      if (win && !win.isDestroyed()) win.webContents.send('task:event', ev);
    } catch (e) {}
  };
  const wasAlive = !!(win && !win.isDestroyed());
  showMainWindow();
  if (wasAlive) deliver();
  else {
    try { win.webContents.once('did-finish-load', deliver); } catch (e) {}
  }
}

// ---------- трей ----------
function trayIcon() {
  const p = path.join(__dirname, 'assets', 'tray.png');
  let img = nativeImage.createFromPath(p);
  if (img.isEmpty()) img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  return img.resize({ width: 16, height: 16 });
}

// собственное ПОЛУПРОЗРАЧНОЕ трей-меню в стиле контекстного меню файлов
// (нативное меню Electron не стилизуется — владелец просил «такое же красивое меню»)
let trayMenuWin = null;
function trayMenuShow() {
  if (!tray || tray.isDestroyed()) return;
  try {
    if (trayMenuWin && !trayMenuWin.isDestroyed()) { trayMenuWin.show(); trayMenuWin.focus(); return; }
    trayMenuWin = new BrowserWindow({
      width: 270, height: 270, show: false, frame: false, resizable: false, alwaysOnTop: true,
      skipTaskbar: true, backgroundColor: '#00000000', transparent: true, hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true
      }
    });
    trayMenuWin.setAlwaysOnTop(true, 'floating');
    trayMenuWin.loadFile(path.join(__dirname, 'renderer', 'traymenu.html'));
    trayMenuWin.once('ready-to-show', () => {
      try {
        if (!tray || tray.isDestroyed()) return;
        const pos = tray.getBounds();
        const wa = require('electron').screen.getPrimaryDisplay().workArea;
        const MW = 270, MH = 270;
        // (как в Telegram): левый край меню — у значка, меню раскрывается ВПРАВО и ВВЕРХ.
        // Раньше прижимали правый край — меню уезжало влево от значка.
        let x = Math.round(pos.x - 8);
        let y = Math.round(pos.y - MH + 6);
        if (x < wa.x + 8) x = wa.x + 8;
        if (x + MW > wa.x + wa.width - 8) x = wa.x + wa.width - 8 - MW;
        if (y < wa.y + 8) y = pos.y + pos.height - 6;   // панель задач вверху — открываем вниз
        trayMenuWin.setPosition(x, y);
        trayMenuWin.show();
        trayMenuWin.focus();
      } catch (e) {}
    });
    trayMenuWin.on('blur', () => { try { trayMenuWin.hide(); } catch (e) {} });
    trayMenuWin.on('closed', () => { trayMenuWin = null; });
    trayMenuWin.webContents.on('render-process-gone', () => { trayMenuWin = null; });
  } catch (e) { logErr('traymenu', e.message); }
}

function buildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip('ADB Wi-Fi Коннектор (RU)');
  // КРИТИЧНЫЙ ФИКС «пустого меню». Раньше стоял
  // setContextMenu(Menu.buildFromTemplate([])) — пустое СИСТЕМНОЕ меню перехватывало
  // правый клик и показывало «пусто», а наш красивый popup не открывался.
  // Теперь системного меню НЕТ вообще, правый клик открывает собственное окно-меню.
  tray.setContextMenu(null);
  tray.removeAllListeners('click');
  tray.removeAllListeners('right-click');
  tray.on('click', () => {
    if (!tray || tray.isDestroyed()) return;
    try {
      if (win && !win.isDestroyed() && !win.isMinimized() && win.isVisible()) win.hide();
      else showMainWindow();
    } catch (e) { showMainWindow(); }
  });
  tray.on('right-click', () => {
    if (!tray || tray.isDestroyed()) return;
    trayMenuShow();
  });
}

// ---------- вспомогательное ----------
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }
// события идут И в главное окно, И в мини-окно APK (если открыто)
function sendTask(ev) {
  try { if (win && !win.isDestroyed()) win.webContents.send('task:event', ev); } catch (e) {}
  try { if (miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('task:event', ev); } catch (e) {}
}

// ---------- отдельное мини-окно установки APK ----------
// Владелец: «когда я открываю файл АПК с рабочего стола… она открывается сразу в программе.
// Сделай так, чтобы она открывалась БЕЗ программы, и это окошко можно было перемещать по рабочему
// столу». Отдельное frameless-окно с перетаскиванием за заголовок: иконка/имя/версия APK,
// список устройств, подключение нового устройства прямо из окошка, установка с прогрессом.
function openApkStandalone(filePath) {
  try {
    if (miniWin && !miniWin.isDestroyed()) {
      miniWin.show(); miniWin.focus();
      miniWin.webContents.send('apkmini:file', filePath);
      return true;
    }
    miniWin = new BrowserWindow({
      width: 440, height: 640, minWidth: 380, minHeight: 500,
      show: false, frame: false, resizable: true, backgroundColor: '#0e1418',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true
      }
    });
    miniWin.setAlwaysOnTop(false);
    miniWin.loadFile(path.join(__dirname, 'renderer', 'apkmini.html'), { hash: encodeURIComponent(filePath) });
    miniWin.once('ready-to-show', () => { try { miniWin.show(); miniWin.focus(); } catch (e) {} });
    miniWin.on('closed', () => {
      miniWin = null;
      // запуск «только установщик» — закрыли окошко, значит и программе жить незачем
      if (miniOnly && (!win || win.isDestroyed())) app.quit();
    });
    miniWin.webContents.on('render-process-gone', () => { miniWin = null; });
    return true;
  } catch (e) { logErr('apkmini', e.message); return false; }
}

/* ОТСОЕДИНЯЕМЫЙ ПЛЕЕР.
   Диалог внутри главного окна физически не может выйти за его пределы — это
   ограничение вьюпорта, а не стилей. Поэтому «отделить» = открыть настоящее
   окно Windows без рамки: его можно тащить за заголовок по всему экрану,
   на второй монитор, и оно остаётся поверх остальных окон. */
function closePlayerWin() {
  playerClosing = true;
  try { if (playerWin && !playerWin.isDestroyed()) playerWin.close(); } catch (e) {}
  playerWin = null;
}
function openDetachedPlayer(payload) {
  payload = payload || {};
  try {
    playerClosing = false;
    if (playerWin && !playerWin.isDestroyed()) {
      // окно уже есть — просто обновляем трек и поднимаем его
      try { playerWin.webContents.send('player:init', payload); } catch (e) {}
      playerWin.show(); playerWin.focus();
      return { ok: true, reused: true };
    }
    const { screen } = require('electron');
    let area = { x: 0, y: 0, width: 1280, height: 800 };
    let px = Number(payload.x), py = Number(payload.y);
    if (Number.isFinite(px) && Number.isFinite(py)) {
      try { area = screen.getDisplayNearestPoint({ x: Math.round(px), y: Math.round(py) }).workArea; } catch (e) {}
      px -= 80; py -= 24;
    } else {
      let b = { x: 200, y: 120, width: 520, height: 340 };
      try { if (win && !win.isDestroyed()) b = win.getBounds(); } catch (e) {}
      px = b.x + Math.round((b.width - 560) / 2); py = b.y + 110;
      try { area = screen.getPrimaryDisplay().workArea; } catch (e) {}
    }
    const W = 820, H = 680;
    px = Math.max(area.x, Math.min(Math.round(px), area.x + area.width - 240));
    py = Math.max(area.y, Math.min(Math.round(py), area.y + area.height - 90));
    playerWin = new BrowserWindow({
      x: px, y: py, width: W, height: H, minWidth: 420, minHeight: 320,
      show: false, frame: false, resizable: true, alwaysOnTop: true,
      transparent: true, backgroundColor: '#00000000', hasShadow: false,
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true
      }
    });
    playerWin.setAlwaysOnTop(true, 'floating');
    playerWin.setMenuBarVisibility(false);
    playerWin.loadFile(path.join(__dirname, 'renderer', 'player.html'));
    playerWin.once('ready-to-show', () => { try { playerWin.show(); playerWin.focus(); } catch (e) {} });
    playerWin.webContents.on('did-finish-load', () => {
      try { playerWin.webContents.send('player:init', payload); } catch (e) {}
    });
    playerWin.on('closed', () => {
      playerWin = null;
      if (playerClosing) { playerClosing = false; return; }
      // закрыли крестиком Windows / Alt+F4 — главное окно должно остановить плеер
      try { if (win && !win.isDestroyed()) win.webContents.send('player:closed', { docked: false, aborted: true }); } catch (e) {}
    });
    return { ok: true };
  } catch (e) { logErr('player-open', e.message); return { ok: false, error: e.message }; }
}
ipcMain.handle('player:open', (_e, payload) => openDetachedPlayer(payload));
ipcMain.handle('player:settip', (_e, on) => {
  try {
    if (playerWin && !playerWin.isDestroyed()) playerWin.setAlwaysOnTop(!!on, on ? 'floating' : 'normal');
    return { ok: true, on: !!on };
  } catch (e) { return { ok: false }; }
});
ipcMain.on('player:action', (_e, action, state) => {
  if (action === 'min') { try { if (playerWin && !playerWin.isDestroyed()) playerWin.minimize(); } catch (e) {} return; }
  if (action === 'showmain') { try { if (win && !win.isDestroyed()) { win.show(); win.focus(); } } catch (e) {} return; }
  const docked = action === 'dock';
  closePlayerWin();
  try { if (win && !win.isDestroyed()) win.webContents.send('player:closed', Object.assign({}, state || {}, { docked })); } catch (e) {}
});
ipcMain.on('player:cmd', (_e, cmd) => {
  try { if (playerWin && !playerWin.isDestroyed()) playerWin.webContents.send('player:cmd', cmd); } catch (e) {}
});
ipcMain.on('player:volume', (_e, v) => {
  const val = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  try { if (win && !win.isDestroyed()) win.webContents.send('player:volume', val); } catch (e) {}
});

// Объединённое обнаружение беспроводной отладки: свой mDNS-клиент + adb mdns services
async function mergedDiscover() {
  const [mine, uni, adbMdns] = await Promise.all([
    mdns.discover(2500).catch(() => []),
    mdns.discoverUnicast(3000).catch(() => []),
    adb.mdnsServices().catch(() => ({ items: [] }))
  ]);
  const out = [];
  for (const r of (mine || []).concat(uni || [])) {
    if (!out.some(x => x.host === r.host && x.port === r.port && x.service === r.service)) {
      out.push({ host: r.host, port: r.port, sid: r.sid || null, src: 'mdns', service: r.service, instance: r.instance || null });
    }
  }
  for (const r of ((adbMdns && adbMdns.items) || [])) {
    if (!out.some(x => x.host === r.host && x.port === r.port)) {
      out.push({ host: r.host, port: r.port, sid: null, src: 'adb-mdns', service: r.service, instance: r.instance || null });
    }
  }
  return out;
}

function rememberDevice(host, port, model) {
  history = history.filter(h => !(h.host === host && h.port === port));
  history.unshift({ host, port, model: model || '', lastTs: Date.now() });
  if (history.length > 50) history = history.slice(0, 50);
  saveJson(HIST_FILE, history);
}

// кэш моделей: getprop — это 2 вызова adb на устройство, ответы редко меняются
const modelCache = new Map();
    async function cachedModel(serial) {
      const c = modelCache.get(serial);
      if (c && Date.now() - c.ts < 120000) return c;
      const m = await adb.modelName(serial);
      // человеческое имя устройства (как в настройках телефона/Bluetooth), а не код модели
      let friendly = '';
      try {
        const r = await adb.run(['-s', serial, 'shell', 'settings get global device_name; getprop ro.product.marketname'], { timeout: 8000 });
        const lines = (r.stdout || '').split(/\r?\n/).map(x => x.trim())
          .filter(x => x && x !== 'null' && !/^(unknown|error)/i.test(x));
        friendly = lines[0] || lines[1] || '';
      } catch (e) {}
      const rec = { model: m.model || '', android: m.android || '', friendly, ts: Date.now() };
      modelCache.set(serial, rec);
      return rec;
    }

// ================= встроенное зеркало экрана (R9) =================
// h264-поток screenrecord с АВТОРЕСТАРТОМ (валидный --time-limit 180: значение 3000 из 
// мгновенно убивало процесс на Android 11–13 — отсюда «запускаю трансляцию, ничего не происходит»),
// watchdog молчания 7 с (renderer переключится в простой режим), JPEG/PNG-фолбэк самопланирующимся
// циклом screencap. Все ссылки — на уровне модуля, чтобы before-quit гасил всё гарантированно.
// (L1): борьба с «трансляция отстаёт/зависает»: по Wi-Fi потолок — не кодек, а
// ПРОПУСКНАЯ СПОСОБНОСТЬ: дефолтный битрейт screenrecord (~20 Мбит/с) не пролезает,
// пакеты копятся в очереди — картинка отстаёт на секунды. Ставим --bit-rate 8 Мбит/с и
// уменьшаем разрешение до длинной стороны 1280 (--size) — кадры идут без затыков.
// качество как у scrcpy — НАТИВНОЕ разрешение и битрейт 12 Мбит/с.
// Внешнее окно scrcpy на этой же сети работает чётко, а «мыло» было из-за
// принудительного даунскейла до 1280 по длинной стороне.
const MIRROR_BITRATE = 12000000;
const mirrorSizeCache = new Map(); // serial -> {w,h} физических пикселей экрана
async function mirrorSizeArg(serial) {
  // не уменьшаем разрешение (scrcpy по умолчанию тоже шлёт нативное).
  // Ограничитель — только экстремально большие экраны (>2560 по длинной стороне).
  try {
    let c = mirrorSizeCache.get(serial);
    if (!c) {
      const r = await adb.run(['-s', serial, 'shell', 'wm', 'size'], { timeout: 8000 });
      const m = (r.stdout || '').match(/(\d+)x(\d+)/);
      if (!m) return [];
      c = { w: +m[1], h: +m[2] };
      mirrorSizeCache.set(serial, c);
    }
    const long = Math.max(c.w, c.h);
    if (long <= 2560) return [];
    const k = 2560 / long;
    const short = Math.max(2, Math.round(Math.min(c.w, c.h) * k / 2) * 2);
    return (c.h >= c.w) ? ['--size', `${short}x2560`] : ['--size', `2560x${short}`];
  } catch (e) { return []; }
}
function stopMirrorAll(reason) {
  const deadGen = mirrorGen; // генерация ЗАВЕРШАЕМОЙ сессии — renderer игнорирует чужие стопы
  mirrorGen++;
  if (mirrorTimer) { clearTimeout(mirrorTimer); mirrorTimer = null; }
  if (mirrorWatchdog) { clearInterval(mirrorWatchdog); mirrorWatchdog = null; }
  for (const c of [mirrorChild, mirrorJpegChild]) { try { c && c.kill('SIGKILL'); } catch (e) {} }
  mirrorChild = mirrorJpegChild = null;
  mirrorMode = mirrorSerial = null;
  mirrorRestarts = 0;
  sendTask({ kind: 'mirror-stopped', gen: deadGen, reason });
}

async function spawnH264(serial, gen) {
  const exe = adb.getAdbPath();
  if (!exe) return stopMirrorAll();
  const sizeArgs = await mirrorSizeArg(serial); // уменьшенное разрешение = меньше байт по Wi-Fi (L1)
  const child = require('child_process').spawn(exe,
    ['-s', serial, 'exec-out', 'screenrecord', '--output-format=h264', '--bit-rate', String(MIRROR_BITRATE), ...sizeArgs, '--time-limit', '180', '-'],
    { windowsHide: true });
  mirrorChild = child;
  mirrorLastData = Date.now();
  child.stdout.on('data', d => {
    mirrorLastData = Date.now();
    if (win && !win.isDestroyed()) win.webContents.send('mirror:chunk', d);
  });
  child.stderr.on('data', () => {});
  const onGone = () => {
    if (gen !== mirrorGen) return; // остановлены/сменён режим — рестарт не поднимаем
    const lived = Date.now() - mirrorLastData;
    if (lived > 60000) mirrorRestarts = 0; // жил долго (плановые 180 с) — счётчик сбрасываем
    if (lived < 3000 && ++mirrorRestarts >= 5) {
      // h264 невозможен на этом устройстве: просим renderer уйти в простой режим ДО остановки (R9-3)
      sendTask({ kind: 'mirror-stalled' });
      stopMirrorAll('device-lost');
      return;
    }
    const delay = Math.min(8000, 250 * Math.pow(2, mirrorRestarts++));
    mirrorTimer = setTimeout(() => {
      if (gen === mirrorGen && mirrorMode === 'h264') {
        sendTask({ kind: 'mirror-status', text: 'Перезапуск потока экрана…' });
        spawnH264(serial, gen);
      }
    }, delay);
  };
  child.on('close', onGone);
  child.on('error', onGone);
}

// ---------- нормализация путей файлового менеджера (, L2) ----------
// Жалобы владельца: «/sdcard не открывается, а /sdcard/ открывался»,
// «/sdcard/emulated/0 (путь из ES-проводника) не работает».
// Причины: (1) toybox `ls -l /sdcard` показывает СА СИМЛИНК, а не содержимое —
// нужен хвостовой слэш (ls /sdcard/ следует по ссылке);
// (2) ES-проводник показывает /storage/emulated/0, а владельцы пишут
// /sdcard/emulated/0 — маппим на настоящий путь.
function normalizeFsDir(p) {
  let d = String(p == null ? '/' : p).trim();
  if (!d) d = '/';
  if (!d.startsWith('/')) d = '/' + d;
  d = d.replace(/\/{2,}/g, '/');
  d = d.replace(/\/+$/, '') || '/';
  // популярные неверные варианты одного и того же пути
  d = d.replace(/^\/sdcard\/emulated\/0(?=\/|$)/, '/storage/emulated/0');
  d = d.replace(/^\/sdcard\/emulated(?=\/|$)/, '/storage/emulated');
  d = d.replace(/^\/storage\/emulated\/0\/0(?=\/|$)/, '/storage/emulated/0');
  d = d.replace(/^\/storage\/emulated\/emulated\/0(?=\/|$)/, '/storage/emulated/0');
  d = d.replace(/^\/sdcard\/0(?=\/|$)/, '/storage/emulated/0');
  return d || '/';
}

// прямой мост телефон→телефон. Данные идут по Wi-Fi между самими
// устройствами (tar | nc), компьютер только запускает команды и проверяет итог.
function phoneIpv4(serial) {
  const host = String(serial || '').split(':')[0];
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? host : null;
}

async function phoneWifiIp(serial) {
  const direct = phoneIpv4(serial);
  if (direct) return direct;
  let r = await adb.run(['-s', serial, 'shell', 'ip route get 1.1.1.1'], { timeout: 10000 });
  let m = (r.stdout || '').match(/\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})/);
  if (m) return m[1];
  r = await adb.run(['-s', serial, 'shell', 'ip -4 addr show wlan0'], { timeout: 10000 });
  m = (r.stdout || '').match(/\binet\s+(\d{1,3}(?:\.\d{1,3}){3})/);
  return m ? m[1] : null;
}

async function phoneNetcat(serial) {
  try {
    const r = await adb.run(['-s', serial, 'shell', 'command -v nc'], { timeout: 10000 });
    const p = String(r.stdout || '').trim().split(/\r?\n/).pop();
    if (p) return { cmd: p };
    const b = await adb.run(['-s', serial, 'shell', 'command -v busybox'], { timeout: 10000 });
    const bp = String(b.stdout || '').trim().split(/\r?\n/).pop();
    if (bp) return { cmd: bp + ' nc', busybox: bp };
  } catch (e) {}
  return null;
}
async function ensureNetcatOn(serial, helperSerial) {
  const own = await phoneNetcat(serial);
  if (own) return own;
  const helper = await phoneNetcat(helperSerial);
  if (!helper || !helper.busybox) return null;
  const local = path.join(os.tmpdir(), 'adbwifi-busybox-' + process.pid + '-' + Date.now() + '.bin');
  const remoteDir = '/data/local/tmp/adbwifi';
  const remote = remoteDir + '/busybox';
  try {
    const cached = await adb.run(['-s', serial, 'shell', `test -x ${remote} && ${remote} nc --help`], { timeout: 10000 });
    if (cached.ok) return { cmd: remote + ' nc' };
    const pull = await adb.run(['-s', helperSerial, 'pull', helper.busybox, local], { timeout: 60000 });
    if (!pull.ok || !fs.existsSync(local)) return null;
    const mk = await adb.run(['-s', serial, 'shell', 'mkdir', '-p', remoteDir], { timeout: 10000 });
    if (!mk.ok) return null;
    const push = await adb.run(['-s', serial, 'push', local, remote], { timeout: 60000 });
    if (!push.ok) return null;
    const chmod = await adb.run(['-s', serial, 'shell', 'chmod', '755', remote], { timeout: 10000 });
    if (!chmod.ok) return null;
    const test = await adb.run(['-s', serial, 'shell', remote, 'nc', '--help'], { timeout: 10000 });
    if (!test.ok) return null;
    return { cmd: remote + ' nc' };
  } finally {
    try { fs.unlinkSync(local); } catch (e) {}
  }
}
async function phoneTransferOne(srcSerial, dstSerial, dstIp, srcPath, destDir, port, srcNc, dstNc, replace) {
  const clean = String(srcPath || '').replace(/\/+$/, '');
  const cut = clean.lastIndexOf('/');
  if (cut <= 0) return { ok: false, path: srcPath, error: 'Не удалось определить папку источника' };
  const srcDir = clean.slice(0, cut) || '/';
  const base = clean.slice(cut + 1);
  if (!base) return { ok: false, path: srcPath, error: 'Некорректное имя файла' };
  const dest = destDir.replace(/\/+$/, '') || '/';
  if (replace) {
    try { await adb.run(['-s', dstSerial, 'shell', 'rm', '-rf', adb.shq(dest + '/' + base)], { timeout: 15000 }); } catch (e) {}
  }
  const exe = adb.getAdbPath();
  if (!exe) return { ok: false, path: srcPath, error: 'adb не найден' };

  const recvCmd = dstNc + ' -l -p ' + port + ' | tar -x -C ' + adb.shq(dest);
  const recv = spawn(exe, ['-s', dstSerial, 'shell', recvCmd], { windowsHide: true });
  let recvErr = '';
  recv.stderr.on('data', d => { recvErr += d.toString('utf8'); });
  const recvClosed = new Promise(res => {
    recv.once('error', e => res({ code: -1, error: e.message }));
    recv.once('close', code => res({ code }));
  });
  await new Promise(res => setTimeout(res, 600));
  if (recv.exitCode !== null) {
    return { ok: false, path: srcPath, error: 'Порт ' + port + ' занят: ' + recvErr.trim().slice(0, 160) };
  }

  const sendCmd = 'tar -c -C ' + adb.shq(srcDir) + ' ' + adb.shq(base) + ' | ' + srcNc + ' ' + dstIp + ' ' + port;
  const send = await adb.run(['-s', srcSerial, 'shell', sendCmd], { timeout: 30 * 60 * 1000 });
  const closed = await Promise.race([
    recvClosed,
    new Promise(res => setTimeout(() => res({ code: null, timeout: true }), 6000))
  ]);
  if (closed && closed.timeout) { try { recv.kill('SIGKILL'); } catch (e) {} }
  if (!send.ok) {
    try { recv.kill('SIGKILL'); } catch (e) {}
    return { ok: false, path: srcPath, error: (send.stderr || send.error || 'Передача не удалась').trim().slice(0, 300) };
  }
  const check = await adb.run(['-s', dstSerial, 'shell', 'ls -ld ' + adb.shq(dest + '/' + base)], { timeout: 15000 });
  if (!check.ok) return { ok: false, path: srcPath, error: 'Файл не появился у получателя' };
  if (closed && closed.code !== 0 && !/chown|operation not permitted/i.test(recvErr || '')) {
    return { ok: false, path: srcPath, error: ('Получатель: ' + (recvErr || ('код ' + closed.code))).slice(0, 300) };
  }
  return { ok: true, path: srcPath, name: base };
}

async function uniqueDestName(dstSerial, destDir, base) {
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const dir = destDir.replace(/\/+$/, '');
  for (let i = 1; i < 100; i++) {
    const name = stem + ' (' + i + ')' + ext;
    const r = await adb.run(['-s', dstSerial, 'shell', 'test', '-e', adb.shq(dir + '/' + name)], { timeout: 10000 });
    if (!r.ok) return name;
  }
  return stem + ' (' + Date.now() + ')' + ext;
}
async function phoneTransferMany(srcSerial, dstSerial, paths, destDir, conflict) {
  const dstIp = await phoneWifiIp(dstSerial);
  if (!dstIp) return { ok: false, error: 'У получателя нет Wi-Fi-адреса. Подключите его по Wi-Fi.' };
  const srcNc = await ensureNetcatOn(srcSerial, dstSerial);
  const dstNc = await ensureNetcatOn(dstSerial, srcSerial);
  if (!srcNc) return { ok: false, error: 'На источнике нет nc, а busybox с получателя скопировать не удалось.' };
  if (!dstNc) return { ok: false, error: 'На получателе нет nc, а busybox с источника скопировать не удалось.' };
  const mk = await adb.run(['-s', dstSerial, 'shell', 'mkdir -p ' + adb.shq(destDir)], { timeout: 15000 });
  if (!mk.ok) return { ok: false, error: 'Не удалось создать папку у получателя: ' + (mk.stderr || '').slice(0, 160) };
  const items = [];
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    let sendPath = p, tmpDir = null, replace = false;
    if (conflict === 'rename') {
      const base = p.split('/').pop();
      const finalName = await uniqueDestName(dstSerial, destDir, base);
      tmpDir = '/data/local/tmp/adbwifi-send-' + process.pid + '-' + Date.now() + '-' + i;
      const mkTmp = await adb.run(['-s', srcSerial, 'shell', 'mkdir', '-p', tmpDir], { timeout: 15000 });
      const cp = mkTmp.ok ? await adb.run(['-s', srcSerial, 'shell', 'cp', '-r', adb.shq(p), adb.shq(tmpDir + '/' + finalName)], { timeout: 300000 }) : mkTmp;
      if (!cp.ok) {
        items.push({ ok: false, path: p, error: 'Не удалось подготовить новое имя: ' + (cp.stderr || cp.error || 'ошибка').slice(0, 200) });
        continue;
      }
      sendPath = tmpDir + '/' + finalName;
    } else if (conflict === 'replace') {
      replace = true;
    }
    let last = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const port = 45000 + Math.floor(Math.random() * 4000);
      last = await phoneTransferOne(srcSerial, dstSerial, dstIp, sendPath, destDir, port, srcNc.cmd, dstNc.cmd, replace);
      if (last.ok || !/Порт \d+ занят/.test(last.error || '')) break;
    }
    if (tmpDir) await adb.run(['-s', srcSerial, 'shell', 'rm', '-rf', adb.shq(tmpDir)], { timeout: 15000 });
    items.push(last);
  }
  return { ok: items.every(x => x && x.ok), src: srcSerial, dst: dstSerial, dstIp, dest: destDir, items };
}

// простой режим: строго ПОСЛЕДОВАТЕЛЬНЫЙ цикл screencap (параллельные спавны душат adb по Wi-Fi).
// screencap -j (JPEG) вместо PNG — кодирование на устройстве в 3–5 раз быстрее,
// передаётся в разы меньше байт по Wi-Fi → вместо «1 кадр в секунду» — 2–4 к/с (F15).
// W3-ревизор: если -j не поддерживается устройством (пустые ответы) — НЕ молотим пустыми
// спавнами, а возвращаемся на PNG (как в 2.4.0).
let jpegEmpty = 0, jpegUsePng = false;
function jpegTick() {
  if (mirrorMode !== 'jpeg' || mirrorJpegChild) return;
  const serial = mirrorSerial, gen = mirrorGen;
  const exe = adb.getAdbPath();
  if (!exe) return stopMirrorAll();
  const child = require('child_process').spawn(exe, ['-s', serial, 'exec-out', 'screencap', jpegUsePng ? '-p' : '-j'], { windowsHide: true });
  mirrorJpegChild = child;
  const chunks = []; let bytes = 0;
  const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 7000);
  child.stdout.on('data', d => { if ((bytes += d.length) <= 8 * 1024 * 1024) chunks.push(d); });
  child.on('error', () => {});
  child.on('close', () => {
    clearTimeout(to);
    mirrorJpegChild = null;
    if (gen !== mirrorGen) return;
    const buf = bytes && bytes < 8 * 1024 * 1024 ? Buffer.concat(chunks) : null;
    // валидный кадр: JPEG (FF D8) или PNG (89 50) сигнатура
    const valid = buf && buf.length > 8 && ((buf[0] === 0xFF && buf[1] === 0xD8) || (buf[0] === 0x89 && buf[1] === 0x50));
    if (valid && win && !win.isDestroyed()) {
      jpegEmpty = 0;
      win.webContents.send('mirror:jpeg', { seq: ++jpegSeq, buf });
    } else {
      if (++jpegEmpty === 4 && !jpegUsePng) {
        jpegUsePng = true; // это устройство не умеет -j — на PNG до конца сессии
        sendTask({ kind: 'mirror-status', text: 'JPEG-снимки не поддерживаются — перешёл на PNG (медленнее)' });
      }
      if (jpegEmpty >= 40) return stopMirrorAll('device-lost'); // устройство не отвечает вовсе
    }
    mirrorTimer = setTimeout(jpegTick, 300); // следующий тик строго после завершения предыдущего
  });
}

// ---------- IPC ----------
// тихое восстановление ассоциаций при старте (если владелец их включал).
// Windows/другие установщики иногда сбрасывают ProgID или оставляют чужой UserChoice —
// тогда двойной клик по APK открывает не нашу программу.
const ASSOC_EXTS_START = ['apk', 'aab', 'apks', 'xapk', 'apkm', 'obb', 'apup'];
const ASSOC_PROGID_START = 'AdbWifiConnectorRu.APKFile';
async function assocStartupRepair() {
  if (!process.platform.startsWith('win')) return;
  const exe = process.execPath;
  const key = 'HKCU\\Software\\Classes\\';
  const icoFile = path.join(__dirname, 'assets', 'icon.ico');
  let haveIco = false;
  try { haveIco = fs.existsSync(icoFile); } catch (e) {}
  const iconRef = haveIco ? '"' + icoFile + '"' : '"' + exe + ',0"';
  const args = [];
  for (const ext of ASSOC_EXTS_START) args.push(['add', key + '.' + ext, '/ve', '/t', 'REG_SZ', '/d', ASSOC_PROGID_START, '/f']);
  args.push(['add', key + ASSOC_PROGID_START, '/ve', '/t', 'REG_SZ', '/d', 'Установка APK — ADB Wi-Fi Коннектор', '/f']);
  args.push(['add', key + ASSOC_PROGID_START + '\\DefaultIcon', '/ve', '/t', 'REG_SZ', '/d', iconRef, '/f']);
  args.push(['add', key + ASSOC_PROGID_START + '\\shell\\open\\command', '/ve', '/t', 'REG_SZ', '/d', '"' + exe + '" "%1"', '/f']);
  for (const ext of ASSOC_EXTS_START) args.push(['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.' + ext + '\\UserChoice', '/f']);
  const runReg = (a) => new Promise((res) => execFile('reg.exe', a, { windowsHide: true }, () => res()));
  for (const a of args) await runReg(a);
  const ps =
    'Add-Type -Namespace Win32 -Name Sh3 -MemberDefinition "[DllImport(\'shell32.dll\')] public static extern void SHChangeNotify(int ev, int fl, IntPtr a, IntPtr b);"; ' +
    '[Win32.Sh3]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)';
  await new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, timeout: 15000 }, () => res()));
  logInfo('assoc', 'автовосстановление при старте', 'ProgID записан, UserChoice снят');
}
function registerIpc() {
  ipcMain.on('win:min', () => win.minimize());
  ipcMain.on('win:max', () => win.isMaximized() ? win.unmaximize() : win.maximize());
  ipcMain.on('win:close', () => win.close());

  ipcMain.handle('state:get', async () => ({
    config, history, favorites,
    platform: process.platform,
    localIp: localIpv4(),
    adbPath: adb.getAdbPath(),
    version: app.getVersion(),
    capturesDir: CAPTURES,
    savesDir: SAVE_DIR
  }));

  // белый список ключей настроек: renderer не должен уметь писать произвольные поля
  ipcMain.handle('settings:set', async (_e, key, value) => {
    if (typeof key !== 'string' || !ALLOWED_SETTINGS.has(key)) return { ok: false, error: 'Недопустимый ключ настройки: ' + String(key).slice(0, 50) };
if (key === 'autostart') return setAutostart(!!value);
    config[key] = value; saveConfig();
    if (key === 'adbPath') adb.setAdbPath(value);
    if (key === 'agentEnabled') agentMcp.setEnabled(!!value);
    if (win && !win.isDestroyed()) win.webContents.send('setting:changed', { key, value });
    return { ok: true };
  });

  // MCP-агент — тумблер, аварийная остановка, состояние, запуск серии
  ipcMain.handle('agent:get-state', async () => ({
    ok: true, enabled: agentMcp.isEnabled(), endpoint: agentMcp.endpoint(), logs: agentMcp.getLog().slice(-30)
  }));
  ipcMain.handle('agent:set-enabled', async (_e, v) => {
    agentMcp.setEnabled(!!v);
    config.agentEnabled = !!v; saveConfig();
    return { ok: true, enabled: agentMcp.isEnabled() };
  });
  ipcMain.handle('agent:stop', async () => { agentMcp.stop(); return { ok: true }; });
  ipcMain.handle('agent:reset', async () => { agentMcp.resetStop(); return { ok: true }; });
  ipcMain.handle('agent:dispatch', async (_e, name, params) => agentMcp.dispatch(name, params || {}));

  ipcMain.handle('dialog:pick-file', async (_e, opts) => {
    const properties = (opts && opts.properties) || ['openFile'];
    const r = await dialog.showOpenDialog(win, { properties, filters: opts && opts.filters || [] });
    return r.canceled ? null : r.filePaths;
  });
  ipcMain.handle('dialog:pick-save', async (_e, opts) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: opts && opts.defaultPath, filters: opts && opts.filters || [] });
    return r.canceled ? null : r.filePath;
  });
  // сохранить текстовый файл (CSV-экспорт списка приложений и т.п.)
  ipcMain.handle('file:save-text', async (_e, name, text) => {
    const safeName = String(name || 'export.txt').replace(/[\\/:*?"<>|]+/g, '_');
    const r = await dialog.showSaveDialog(win, {
      defaultPath: path.join(SAVE_DIR, safeName),
      filters: [{ name: 'CSV/текст', extensions: ['csv', 'txt'] }, { name: 'Все файлы', extensions: ['*'] }]
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      let data = String(text == null ? '' : text);
      // CSV для Excel: BOM + разделитель ';' уже подготовлены вызывающей стороной
      if (/\.csv$/i.test(r.filePath) && data.charCodeAt(0) !== 0xFEFF) data = '\uFEFF' + data;
      fs.writeFileSync(r.filePath, data, 'utf8');
      return { ok: true, file: r.filePath };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('shell:show-item', async (_e, p) => { shell.showItemInFolder(p); return { ok: true }; });
  ipcMain.handle('shell:open-external', async (_e, u) => {
    const s = String(u || '');
    if (!/^(https?|file):\/\//i.test(s)) return { ok: false, error: 'Протокол ссылки не поддерживается' };
    shell.openExternal(s);
    return { ok: true };
  });

  ipcMain.handle('adb:version', async () => adb.version());
  ipcMain.handle('adb:devices', async () => {
    const d = await adb.devices();
    if (!d.ok) return d;
        for (const dev of d.list) {
          if (dev.state !== 'device') continue;
          const m = await cachedModel(dev.serial);
          dev.model = m.model; dev.android = m.android; dev.friendly = m.friendly || m.model;
        }
    return d;
  });
  // R8: все пути подключения идут через connectDevice (сериализация + enforce одного устройства)
  // САМОИСЦЕЛЕНИЕ при отказе порта (жалоба: «cannot connect ... 10061» в журнале).
  // Причина ошибки почти всегда одна: порт беспроводной отладки МЕНЯЕТСЯ при каждом включении
  // экрана «Беспроводная отладка», а владельцы часто вводят СТАРЫЙ порт или порт СОПРЯЖЕНИЯ
  // (они разные!). Вместо тупого «Не удалось подключиться» — сами ищем живой порт: mDNS,
  // затем быстрый свип портов. Это занимает секунды и спасает без ручного перебора.
  ipcMain.handle('adb:connect', async (_e, host, port, model) => {
    const r = await connectDevice(host, port, { model });
    if (r.ok) { logInfo('connect', host + ':' + port, 'OK', model || ''); return r; }
    logErr('connect', host + ':' + port, r.message || r.error || 'fail');
    logInfo('connect', host + ':' + port, 'порт закрыт — запускаю автопоиск живого порта');
    const healed = await autoFindAndConnect(host);
    if (healed.ok) {
      logInfo('connect', 'самоисцеление: ' + healed.host + ':' + healed.port);
      return { ok: true, host: healed.host, port: healed.port, healed: true,
        message: 'Подключено через порт ' + healed.port + ' — введённый порт ' + port + ' был закрыт (порт меняется при каждом включении беспроводной отладки).' };
    }
    return { ok: false, message:
      'Порт ' + port + ' закрыт, живой порт не найден. Порт меняется ПРИ КАЖДОМ включении «Беспроводной отладки»: ' +
      'откройте этот экран на телефоне и введите НОВЫЙ порт. И порт СОПРЯЖЕНИЯ и порт ПОДКЛЮЧЕНИЯ — это два разных порта. ' +
      'Также проверьте: телефон в той же Wi-Fi-сети, экран «Беспроводная отладка» открыт.' };
  });
  ipcMain.handle('adb:disconnect', async (_e, serial) => {
    if (!serial || !String(serial).includes(':')) return { ok: false, message: 'Нужен serial вида host:port' };
    return adb.disconnect(serial);
  });
  ipcMain.handle('adb:ping', async (_e, serial) => {
    try { return await adb.pingDevice(serial); } catch (e) { return { ok: false, ms: 0 }; }
  });
  ipcMain.handle('adb:pair', async (_e, host, port, code) => {
    const r = await adb.pair(host, port, code, chunk => sendTask({ kind: 'pair-log', text: chunk }));
    if (!r.ok) logErr('pair', host + ':' + port, r.error || r.message || 'fail');
    return r;
  });
  // поиск ЖИВОГО порта отладки на хосте: mDNS-порт → быстрый свип → соседние порты.
  // Используется самоисцелением adb:connect; максимум ~12 с.
  async function autoFindAndConnect(host) {
    const candidates = [];
    try {
      const recs = await mdns.discover(1200).catch(() => []);
      for (const x of (recs || [])) {
        if (x.host === host && String(x.service || '').includes('_adb-tls-connect')) candidates.push(x.port);
      }
    } catch (e) {}
    const swept = await adb.portScanFast(host).catch(() => []);
    for (const p of (swept || [])) if (!candidates.includes(p)) candidates.push(p);
    for (const p of candidates.slice(0, 6)) {
      const c = await connectDevice(host, p).catch(() => ({ ok: false }));
      if (c.ok) return { ok: true, host, port: p };
    }
    return { ok: false };
  }

  // QR-подключение (Android 11+): статусы идут в renderer через task:event { kind:'qr-status', stage, message }
  ipcMain.handle('qr:start', async () => {
    // передаём QR-сессии «подсказку» — IP телефона (активное устройство или крайнее
    // из истории): по нему работает ПРЯМОЕ сопряжение по портам даже без рабочего mDNS.
    let hintHost = '';
    try {
      const d = await adb.devices();
      const on = (d.list || []).find(x => x.state === 'device' && String(x.serial).includes(':'));
      if (on) hintHost = String(on.serial).split(':')[0];
    } catch (e) {}
    if (!hintHost && history.length && history[0].host) hintHost = history[0].host;
    const r = qrpair.start({
      hintHost,
      sendStatus: (stage, message, extra) => sendTask(Object.assign({ kind: 'qr-status', stage, message }, extra || {})),
      onConnected: (host, port, model) => {
        // R8: подключение через единую точку (enforce одного устройства внутри)
        connectDevice(host, port, { model }).then(() => sendTask({ kind: 'refresh-devices' }));
      },
      log: () => {} // qr-журнал отладочный: в app.log попадают ТОЛЬКО ошибки (F19)
    });
    return r;
  });
  ipcMain.handle('qr:cancel', async () => { qrpair.cancel(); return { ok: true }; });
  ipcMain.on('log:renderer', (_e, msg) => logErr('renderer', String(msg).slice(0, 500)));
  // ошибки, показанные пользователю в интерфейсе (snack/статусы) — тоже в журнал (F19)
  ipcMain.on('log:ui', (_e, msg) => logErr('ui', String(msg).slice(0, 500)));
  // USB-устройства Android, которые Windows видит как MTP/WPD даже без ADB
  // (например, HONOR 9X с выключенной отладкой). Используется и в «Сканировать сеть»,
  // и в кнопке включения режима разработчика.
  async function pnpAndroidUsb() {
    const script = "Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { ($_.Class -eq 'AndroidUsbDeviceClass') -or ($_.Class -eq 'WPD' -and $_.InstanceId -notmatch '^SWD' -and $_.InstanceId -notmatch 'USBSTOR' -and ($_.InstanceId -match '^USB.VID_(12D1|18D1|04E8|2717|22D9|2D95|0BB4|1004|0FCE|1EBF|2A70|22B8|0E8D|2E04|17EF)' -or $_.FriendlyName -match 'Android|MTP|ADB|Xiaomi|Samsung|Pixel|OnePlus|Huawei|Honor|Oppo|Vivo|Realme')) } | Select-Object Status,Class,FriendlyName,InstanceId | ConvertTo-Json -Compress";
    const raw = await new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, timeout: 15000 }, (err, stdout) => resolve(String(stdout || '')));
    });
    try {
      const a = JSON.parse(raw);
      const list = (Array.isArray(a) ? a : [a]).map(x => ({ status: x.Status, cls: x.Class, name: x.FriendlyName, id: x.InstanceId }));
      const seen = new Set();
      return list.filter(x => {
        const k = String(x.name || '') + '|' + String(x.id || '');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    } catch (e) { return []; }
  }
  ipcMain.handle('adb:scan-subnet', async () => {
    sendTask({ kind: 'scan-start' });
    // параллельно: свип 5555, mDNS (свой + adb), повторный опрос известных адресов
    const known = [];
    for (const h of history) known.push({ host: h.host, port: h.port, label: 'из истории' });
    for (const f of favorites) known.push({ host: f.host, port: f.port, label: 'избранное' });
    const [found, md, usb] = await Promise.all([
      adb.scanSubnet((done, total) => {
        if (done % 32 === 0) sendTask({ kind: 'scan-progress', done, total });
      }),
      mergedDiscover(),
      pnpAndroidUsb()
    ]);
    const out = (found || []).map(x => ({ host: x.host, port: x.port, label: 'порт 5555' }));
    for (const m of (md || []).filter(x => (x.service || '').includes('connect'))) {
      if (!out.some(o => o.host === m.host && o.port === m.port)) {
        out.push({ host: m.host, port: m.port, label: x2(m.src), sid: m.sid, instance: m.instance || null });
      }
    }
    // USB-устройства без ADB: показываем отдельными строками, к ним нельзя
    // подключиться по adb, но можно открыть MTP-файлы через Проводник Windows.
    for (const u of (usb || [])) {
      out.push({ usb: true, name: u.name || 'Android USB', id: u.id || '', status: u.status || '', cls: u.cls || '', label: 'USB (MTP/WPD)' });
    }
    // опрос известных адресов (телефон со случайным TLS-портом из истории/избранного)
    const uniqKnown = [];
    for (const k of known) if (!uniqKnown.some(u => u.host === k.host && u.port === k.port)) uniqKnown.push(k);
    const probes = await Promise.all(uniqKnown.slice(0, 20).map(k => adb.tcpProbe(k.host, k.port).then(ok => ok ? k : null)));
    for (const k of probes) {
      if (k && !out.some(o => o.host === k.host && o.port === k.port)) out.push({ host: k.host, port: k.port, label: k.label });
    }
    // ИМЯ УСТРОЙСТВА в результатах скана — из истории/избранного, из adb devices -l
    // (там есть model:) и по аппаратному серийнику из mDNS-имени вида adb-45081e2b-XXXX.
    // Сеть не трогаем лишний раз: для неподключённых устройств имя появится после подключения.
    const bySer = new Map();
    for (const h of history) if (h.model) bySer.set(h.host + ':' + h.port, h.model);
    for (const f of favorites) if (f.model && !bySer.has(f.host + ':' + f.port)) bySer.set(f.host + ':' + f.port, f.model);
    const devs = await adb.devices().catch(() => ({ list: [] }));
    const modelByHw = new Map();
    for (const d of (devs.list || [])) {
      const mdl = (d.props && (d.props.model || d.props.product)) || null;
      if (mdl) modelByHw.set(String(d.serial || '').toLowerCase(), mdl);
      if (mdl && !bySer.has(d.serial)) bySer.set(d.serial, mdl);
    }
    // mDNS-имя вида adb-45081e2b-XXXX содержит АППАРАТНЫЙ серийник: узнаём его у
    // подключённых устройств (getprop ro.serialno), чтобы имя было и у mDNS-строки
    await Promise.all((devs.list || []).filter(d => d.state === 'device').slice(0, 4).map(async d => {
      try {
        const hwR = await adb.run(['-s', d.serial, 'shell', 'getprop', 'ro.serialno'], { timeout: 5000 });
        const hw = (hwR.stdout || '').trim().toLowerCase();
        const mdl = (d.props && (d.props.model || d.props.product)) || null;
        if (hw && mdl) modelByHw.set(hw, mdl);
      } catch (e) {}
    }));
    for (const o of out) {
      const ser = o.host + ':' + o.port;
      if (!o.model && bySer.get(ser)) o.model = bySer.get(ser);
      if (!o.model && o.instance) {
        const hw = (String(o.instance).match(/^adb-([0-9a-f]{6,})-/i) || [])[1];
        if (hw && modelByHw.get(hw.toLowerCase())) o.model = modelByHw.get(hw.toLowerCase());
      }
      if (!o.model) {
        // тот же телефон на другом порту: узнаём по IP из уже известных
        const same = out.find(x => x !== o && x.host === o.host && x.model);
        if (same) o.model = same.model;
      }
    }
    sendTask({ kind: 'scan-done', count: out.length });
    return out;
    function x2(s) { return s === 'adb-mdns' ? 'adb mDNS' : 'mDNS'; }
  });
  ipcMain.handle('adb:mdns', async () => mergedDiscover());
  // список USB-устройств Android (MTP/WPD) для чипа в файловом менеджере
  ipcMain.handle('usb:pnp', async () => pnpAndroidUsb());
  // открыть MTP-папку USB-устройства в Проводнике: файлы доступны даже без ADB
  ipcMain.handle('usb:open-mtp', async (_e, name) => {
    const raw = String(name || '').trim().slice(0, 120);
    if (!raw) return { ok: false, error: 'Не указано устройство' };
    const safe = raw.replace(/'/g, "''");
    const script = "$shell = New-Object -ComObject Shell.Application; $pc = $shell.Namespace(17); $item = $pc.Items() | Where-Object { $_.Name -eq '" + safe + "' } | Select-Object -First 1; if (-not $item) { $item = $pc.Items() | Where-Object { $_.Name -like '*" + safe + "*' } | Select-Object -First 1 }; if ($item) { $item.InvokeVerb('open'); 'OPENED' } else { Start-Process explorer.exe 'shell:MyComputerFolder'; 'THISPC' }";
    const r = await new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, timeout: 20000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || ''), err: String((err && err.message) || '') }));
    });
    if (/OPENED/.test(r.out)) return { ok: true, opened: true };
    if (/THISPC/.test(r.out)) return { ok: true, opened: false, message: 'Устройство не найдено — открыл «Этот компьютер»' };
    return { ok: false, error: r.err || 'Не удалось открыть MTP-устройство' };
  });
  // ===== встроенный MTP-браузер: Android без ADB, через Windows Shell =====
  // PowerShell получает JSON в base64 (никаких кавычек в именах файлов) и
  // проходит по папкам MTP-устройства. Возвращает JSON, а не текст.
  function mtpPowerShell(body, payload, timeout) {
    const json = JSON.stringify(payload || {});
    const b64 = Buffer.from(json, 'utf8').toString('base64');
    const prelude = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')) | ConvertFrom-Json
$deviceName = [string]$payload.device
$parts = @($payload.path)
$shell = New-Object -ComObject Shell.Application
$pc = $shell.Namespace(17)
$dev = $pc.Items() | Where-Object { $_.Name -eq $deviceName } | Select-Object -First 1
if (-not $dev) { [pscustomobject]@{ ok = $false; error = 'DEVICE_NOT_FOUND' } | ConvertTo-Json -Compress; exit 0 }
$folder = $dev.GetFolder
foreach ($p in $parts) {
  $child = $folder.Items() | Where-Object { $_.Name -eq [string]$p } | Select-Object -First 1
  if (-not $child) { [pscustomobject]@{ ok = $false; error = 'PATH_NOT_FOUND' } | ConvertTo-Json -Compress; exit 0 }
  $folder = $child.GetFolder
}
`;
    const script = prelude + body;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true, timeout: timeout || 30000 }, (err, stdout, stderr) => {
        const text = String(stdout || '').replace(/^\uFEFF/, '').trim();
        let data = null;
        try { data = JSON.parse(text.split(/\r?\n/).filter(Boolean).pop() || '{}'); } catch (e) {}
        if (!data) data = { ok: false, error: String(stderr || (err && err.message) || 'MTP error').slice(0, 300) };
        if (err && err.killed) data.timeout = true;
        if (err && data.ok !== true && !data.error) data.error = String(stderr || err.message || 'MTP error').slice(0, 300);
        resolve(data);
      });
    });
  }
  function mtpListBody() {
    return `$items = @($folder.Items() | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; dir = [bool]$_.IsFolder } })
[pscustomobject]@{ ok = $true; items = $items } | ConvertTo-Json -Compress -Depth 4`;
  }
  function mtpPullBody() {
    return `$leaf = [string]$payload.leaf
$item = @($folder.Items() | Where-Object { $_.Name -eq $leaf }) | Select-Object -First 1
if (-not $item -or $item.IsFolder) { [pscustomobject]@{ ok = $false; error = 'FILE_NOT_FOUND' } | ConvertTo-Json -Compress; exit 0 }
$dir = Join-Path $env:TEMP ('mtp-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$dest = $shell.Namespace($dir)
$dest.CopyHere($item, 16)
$safe = $item.Name -replace '/', '_'
$target = Join-Path $dir $safe
$deadline = (Get-Date).AddSeconds(300)
while (-not (Test-Path -LiteralPath $target) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
if (-not (Test-Path -LiteralPath $target)) { [pscustomobject]@{ ok = $false; error = 'COPY_TIMEOUT' } | ConvertTo-Json -Compress; exit 0 }
[pscustomobject]@{ ok = $true; file = $target; name = $item.Name } | ConvertTo-Json -Compress`;
  }
  function mtpPushBody() {
    return `$local = [string]$payload.local
$leaf = Split-Path -Leaf $local
if (-not (Test-Path -LiteralPath $local)) { [pscustomobject]@{ ok = $false; error = 'LOCAL_NOT_FOUND' } | ConvertTo-Json -Compress; exit 0 }
$folder.CopyHere($local, 16)
$deadline = (Get-Date).AddSeconds(300)
while (-not (@($folder.Items() | Where-Object { $_.Name -eq $leaf }).Count) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
if (-not (@($folder.Items() | Where-Object { $_.Name -eq $leaf }).Count)) { [pscustomobject]@{ ok = $false; error = 'COPY_TIMEOUT' } | ConvertTo-Json -Compress; exit 0 }
[pscustomobject]@{ ok = $true; name = $leaf } | ConvertTo-Json -Compress`;
  }
  ipcMain.handle('mtp:list', async (_e, device, pathParts) => {
    return mtpPowerShell(mtpListBody(), { device, path: Array.isArray(pathParts) ? pathParts : [] }, 30000);
  });
  ipcMain.handle('mtp:open', async (_e, device, pathParts, leaf) => {
    const r = await mtpPowerShell(mtpPullBody(), { device, path: Array.isArray(pathParts) ? pathParts : [], leaf }, 320000);
    if (!r || !r.ok) return r;
    const op = await shell.openPath(r.file);
    return op ? { ok: false, error: op, file: r.file } : { ok: true, file: r.file, name: r.name };
  });
  ipcMain.handle('mtp:save', async (_e, device, pathParts, leaf) => {
    const f = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), String(leaf || 'file')) });
    if (f.canceled || !f.filePath) return { ok: false, canceled: true };
    const r = await mtpPowerShell(mtpPullBody(), { device, path: Array.isArray(pathParts) ? pathParts : [], leaf }, 320000);
    if (!r || !r.ok) return r;
    try {
      fs.copyFileSync(r.file, f.filePath);
      fs.rmSync(path.dirname(r.file), { recursive: true, force: true });
      return { ok: true, file: f.filePath };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('mtp:push', async (_e, device, pathParts, localPath) => {
    let local = '';
    if (localPath) {
      if (!fs.existsSync(localPath)) return { ok: false, error: 'LOCAL_NOT_FOUND' };
      local = localPath;
    } else {
      const f = await dialog.showOpenDialog(win, { properties: ['openFile'] });
      if (f.canceled || !f.filePaths || !f.filePaths[0]) return { ok: false, canceled: true };
      local = f.filePaths[0];
    }
    return mtpPowerShell(mtpPushBody(), { device, path: Array.isArray(pathParts) ? pathParts : [], local }, 320000);
  });
  ipcMain.handle('mtp:delete', async (_e, device, pathParts, leaf) => {
    const body = `$leaf = [string]$payload.leaf
$item = @($folder.Items() | Where-Object { $_.Name -eq $leaf }) | Select-Object -First 1
if (-not $item -or $item.IsFolder) { [pscustomobject]@{ ok = $false; error = 'FILE_NOT_FOUND' } | ConvertTo-Json -Compress; exit 0 }
$item.InvokeVerb('delete')
Start-Sleep -Seconds 1
$still = @($folder.Items() | Where-Object { $_.Name -eq $leaf }) | Select-Object -First 1
[pscustomobject]@{ ok = (-not [bool]$still); pending = [bool]$still; name = $leaf } | ConvertTo-Json -Compress`;
    const r = await mtpPowerShell(body, { device, path: Array.isArray(pathParts) ? pathParts : [], leaf }, 15000);
    if (r && r.timeout) return { ok: false, pending: true, error: 'DELETE_TIMEOUT' };
    return r;
  });
  // «Найти порт» — быстрый свип с ранним выходом (~1–2 с вместо ~24 с)
  ipcMain.handle('adb:port-scan', async (_e, host) => adb.portScanFast(host));
  ipcMain.handle('adb:auto-pair', async (_e, host, code, port) => {
    const r = await autoPairConnect(host, code, port || null);
    if (r.ok) sendTask({ kind: 'refresh-devices' });
    return r;
  });

  ipcMain.handle('hist:add', async (_e, rec) => { rememberDevice(rec.host, rec.port, rec.model); return history; });
  ipcMain.handle('hist:remove', async (_e, host, port) => {
    history = history.filter(h => !(h.host === host && h.port === port));
    saveJson(HIST_FILE, history); return history;
  });
  ipcMain.handle('hist:clear', async () => { history = []; saveJson(HIST_FILE, history); return history; });
  ipcMain.handle('fav:toggle', async (_e, rec) => {
    const i = favorites.findIndex(f => f.host === rec.host && f.port === rec.port);
    if (i >= 0) favorites.splice(i, 1); else favorites.push({ host: rec.host, port: rec.port, model: rec.model || '' });
    saveJson(FAV_FILE, favorites); return favorites;
  });

  // ----- инструменты -----
  ipcMain.handle('tools:screenshot', async (_e, serial) => {
    const file = await dialog.showSaveDialog(win, {
      defaultPath: path.join(CAPTURES, `screenshot-${stamp()}.png`),
      filters: [{ name: 'PNG', extensions: ['png'] }]
    });
    if (file.canceled) return { ok: false, canceled: true };
    const r = await adb.screenshot(serial, file.filePath);
    return r;
  });

  function scrcpyExeForRecord() {
    const candidates = [];
    if (config.scrcpyPath) candidates.push(config.scrcpyPath);
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'scrcpy', 'scrcpy.exe'));
    candidates.push(path.join(__dirname, 'scrcpy-bundle', 'scrcpy.exe'));
    for (const c of candidates) {
      try { if (c && fs.existsSync(c)) return c; } catch (e) {}
    }
    return null;
  }

  function psRun(script, timeout) {
    return new Promise(resolve => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
        { windowsHide: true, timeout: timeout || 10000 },
        (err, stdout, stderr) => resolve({
          ok: !err,
          out: String(stdout || '').trim(),
          err: String(stderr || (err && err.message) || '')
        }));
    });
  }

  async function hideScrcpyWindow(pid) {
    const script = [
      'Add-Type @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class ScrcpyRecWin {',
      '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
      '}',
      '"@',
      '$p = Get-Process -Id ' + Number(pid) + ' -ErrorAction SilentlyContinue',
      'if (-not $p) { exit 2 }',
      'for ($i = 0; $i -lt 100; $i++) {',
      '  $p.Refresh()',
      '  $h = $p.MainWindowHandle',
      '  if ($h -ne [IntPtr]::Zero) { [void][ScrcpyRecWin]::ShowWindow($h, 0); [Console]::WriteLine($h.ToInt64()); exit 0 }',
      '  Start-Sleep -Milliseconds 100',
      '}',
      'exit 1'
    ].join('\n');
    const r = await psRun(script, 14000);
    const h = parseInt(r.out, 10);
    return Number.isFinite(h) && h > 0 ? h : 0;
  }

  async function closeScrcpyWindow(pid, hwnd) {
    const script = [
      'Add-Type @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class ScrcpyRecMsg {',
      '  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);',
      '}',
      '"@',
      '$h = [IntPtr]::new(' + Number(hwnd || 0) + ')',
      'if ($h -eq [IntPtr]::Zero) {',
      '  $p = Get-Process -Id ' + Number(pid) + ' -ErrorAction SilentlyContinue',
      '  if ($p) { $h = $p.MainWindowHandle }',
      '}',
      'if ($h -ne [IntPtr]::Zero -and [ScrcpyRecMsg]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { "OK" } else { "FAIL" }'
    ].join('\n');
    const r = await psRun(script, 8000);
    return r.ok && r.out.indexOf('OK') >= 0;
  }
  closeScrcpyWindowFn = closeScrcpyWindow;

  function waitChildClose(child, ms) {
    return new Promise(resolve => {
      if (!child || child.exitCode !== null) return resolve(true);
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(false); } }, ms);
      child.once('close', () => { if (!done) { done = true; clearTimeout(timer); resolve(true); } });
    });
  }

  async function waitForFile(file, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try { if (fs.existsSync(file) && fs.statSync(file).size > 1024) return true; } catch (e) {}
      await sleep(150);
    }
    return false;
  }

  ipcMain.handle('tools:record-start', async (_e, serial) => {
    if (recordChild) return { ok: false, error: 'Запись уже идёт' };
    const exe = scrcpyExeForRecord();
    if (!exe) return { ok: false, error: 'scrcpy.exe не найден — запись со звуком недоступна' };
    const local = path.join(app.getPath('temp'), `adb-wifi-record-${Date.now()}.mp4`);
    const args = [
      '-s', String(serial),
      '--no-audio-playback',
      '--audio-source=playback',
      '--audio-dup',
      '--audio-codec=aac',
      '--audio-bit-rate=128K',
      '--require-audio',
      '--window-width=480',
      '--window-height=270',
      '--window-borderless',
      '--time-limit=180',
      '--record=' + local
    ];
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, cwd: path.dirname(exe) });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const meta = { serial, local, startedAt: Date.now(), hwnd: 0, err: '' };
    recordChild = child;
    recordMeta = meta;
    const collect = d => { meta.err = (meta.err + d.toString()).slice(-3000); };
    child.stderr.on('data', collect);
    child.stdout.on('data', collect);
    child.on('error', e => {
      meta.err = (meta.err + ' ' + e.message).slice(-3000);
      if (recordChild === child) { recordChild = null; recordMeta = null; }
    });
    child.on('close', () => {
      if (recordChild !== child) return;
      recordChild = null;
      const m = recordMeta;
      recordMeta = null;
      if (!m) return;
      let finalFile = '';
      try {
        if (fs.existsSync(m.local) && fs.statSync(m.local).size > 1024) {
          finalFile = path.join(CAPTURES, `record-${stamp()}.mp4`);
          fs.renameSync(m.local, finalFile);
        }
      } catch (e) {}
      sendTask({
        kind: 'record-stopped',
        auto: true,
        file: finalFile,
        error: finalFile ? '' : 'Запись не создана',
        elapsedSec: Math.round((Date.now() - m.startedAt) / 1000)
      });
    });
    meta.hwnd = await hideScrcpyWindow(child.pid);
    const started = await waitForFile(local, 9000);
    if (!started) {
      if (recordChild === child) { recordChild = null; recordMeta = null; }
      await closeScrcpyWindow(child.pid, meta.hwnd);
      await waitChildClose(child, 3000);
      try { child.kill('SIGKILL'); } catch (e) {}
      try { fs.unlinkSync(local); } catch (e) {}
      const detail = meta.err.split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
      return { ok: false, error: 'Не удалось начать запись со звуком' + (detail ? ': ' + detail : '') };
    }
    return { ok: true, maxSec: 180, audio: true };
  });
  ipcMain.handle('tools:record-stop', async () => {
    const child = recordChild;
    const meta = recordMeta;
    if (!child || !meta) return { ok: false, error: 'Запись не идёт' };
    recordChild = null; recordMeta = null;
    const closed = await closeScrcpyWindow(child.pid, meta.hwnd);
    if (!closed) { try { child.kill('SIGKILL'); } catch (e) {} }
    const exited = await waitChildClose(child, 7000);
    if (!exited) {
      try { child.kill('SIGKILL'); } catch (e) {}
      await waitChildClose(child, 1500);
      try { fs.unlinkSync(meta.local); } catch (e) {}
      return { ok: false, error: 'scrcpy не завершил запись' };
    }
    await sleep(250);
    let size = 0;
    try { size = fs.statSync(meta.local).size; } catch (e) {}
    if (!size) return { ok: false, error: 'Файл записи не создан' };
    const file = await dialog.showSaveDialog(win, {
      defaultPath: path.join(CAPTURES, `record-${stamp()}.mp4`),
      filters: [{ name: 'Видео MP4', extensions: ['mp4'] }]
    });
    if (file.canceled) {
      try { fs.unlinkSync(meta.local); } catch (e) {}
      return { ok: false, canceled: true };
    }
    try {
      fs.copyFileSync(meta.local, file.filePath);
      fs.unlinkSync(meta.local);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return { ok: true, file: file.filePath };
  });

  ipcMain.handle('tools:logcat-start', async (_e, serial) => {
    if (logcatChild) {
      // глушим старый процесс до создания нового: его close не должен затереть новую ссылку
      const prev = logcatChild; logcatChild = null;
      try { prev.removeAllListeners('close'); prev.kill('SIGKILL'); } catch (e) {}
    }
    const child = adb.startLogcat(serial, lines => {
      if (win && !win.isDestroyed()) win.webContents.send('logcat:lines', lines);
    });
    logcatChild = child;
    child.on('close', () => {
      if (logcatChild === child) { logcatChild = null; sendTask({ kind: 'logcat-stopped' }); }
    });
    return { ok: true };
  });
  ipcMain.handle('tools:logcat-stop', async () => {
    const c = logcatChild; logcatChild = null;
    if (c) { try { c.removeAllListeners('close'); c.kill('SIGKILL'); } catch (e) {} }
    sendTask({ kind: 'logcat-stopped' });
    return { ok: true };
  });
  ipcMain.handle('tools:logcat-clear', async (_e, serial) => adb.run(['-s', serial, 'logcat', '-c']));

  ipcMain.handle('tools:scrcpy', async (_e, serial) => {
    const candidates = [];
    if (config.scrcpyPath) candidates.push(config.scrcpyPath);
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'scrcpy', 'scrcpy.exe'));
    candidates.push(path.join(__dirname, 'scrcpy-bundle', 'scrcpy.exe'));
    let exe = null;
    for (const c of candidates) { try { if (c && fs.existsSync(c)) { exe = c; break; } } catch (e) {} }
    if (!exe) {
      exe = await new Promise(res => execFile('where.exe', ['scrcpy.exe'], { windowsHide: true }, (err, out) => res(err ? null : out.trim().split(/\r?\n/)[0])));
    }
    if (!exe || !fs.existsSync(exe)) return { ok: false, error: 'scrcpy.exe не найден. Установите scrcpy или укажите путь в настройках.', code: 'NOT_FOUND' };
    // (F15): заранее поднимаем adb-сервер СВОИМ скрытым спавном — иначе scrcpy
    // запустит «adb start-server» сам, и рядом с окном scrcpy появится консоль adb
    try { await adb.run(['start-server'], { timeout: 8000 }); } catch (e) {}
    const { spawn } = require('child_process');
    // рядом со scrcpy.exe есть scrcpy-noconsole.vbs — запускаем через wscript с
    // полностью скрытым окном: раньше при старте внешнего окна рядом открывался терминал
    const vbs = path.join(path.dirname(exe), 'scrcpy-noconsole.vbs');
    try {
      if (fs.existsSync(vbs)) {
        spawn('wscript.exe', [vbs, '-s', serial], { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(exe) }).unref();
      } else {
        spawn(exe, ['-s', serial], { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(exe) }).unref();
      }
      return { ok: true };
    }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // ----- камера телефона (страница «Камера») -----
  const cameraScript = path.join(__dirname, 'camera', 'phonecam_server.py');
  const cameraOrigin = 'http://127.0.0.1:27190';

  async function findPythonw() {
    const found = await new Promise(resolve => {
      execFile('where.exe', ['pythonw.exe'], { windowsHide: true }, (err, out) => {
        resolve(err ? null : (out || '').trim().split(/\r?\n/)[0] || null);
      });
    });
    if (found) return found;
    try {
      const base = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python');
      for (const dir of fs.readdirSync(base)) {
        const exe = path.join(base, dir, 'pythonw.exe');
        if (fs.existsSync(exe)) return exe;
      }
    } catch (e) {}
    return null;
  }

  function cameraStatus() {
    return new Promise(resolve => {
      let done = false;
      const finish = (value) => { if (!done) { done = true; resolve(value); } };
      const req = http.get(cameraOrigin + '/status', { timeout: 1800 }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try { finish({ ok: true, ...JSON.parse(body) }); }
          catch (e) { finish({ ok: false, error: 'Некорректный ответ сервера камеры' }); }
        });
      });
      req.on('timeout', () => { req.destroy(); finish({ ok: false, error: 'Сервер камеры не отвечает' }); });
      req.on('error', (e) => finish({ ok: false, error: e.message }));
    });
  }

  function serverShutdown(origin) {
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(true); } };
      const req = http.get(origin + '/shutdown', { timeout: 1200 }, res => {
        res.resume();
        res.on('end', finish);
      });
      req.on('timeout', () => { req.destroy(); finish(); });
      req.on('error', finish);
    });
  }

  function driversStatus() {
    return new Promise(resolve => {
      const videoExe = path.join(__dirname, 'camera', 'bin', 'PhoneVirtualCam.exe');
      const videoDll = path.join(__dirname, 'camera', 'bin', 'VirtualCameraSource.dll');
      const audioSetup = path.join(__dirname, 'camera', 'drivers', 'VBCABLE', 'VBCABLE_Setup_x64.exe');
      const video = fs.existsSync(videoExe) && fs.existsSync(videoDll);
      const ps = "$d = Get-CimInstance Win32_SoundDevice | Where-Object { $_.Name -match 'VB-Audio' }; if ($d) { '1' } else { '0' }";
      execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, out) => {
        const audio = !err && String(out || '').trim() === '1';
        resolve({
          ok: true,
          video: { installed: video, bundled: video, exe: videoExe, dll: videoDll },
          audio: { installed: audio, setup: fs.existsSync(audioSetup), setupPath: audioSetup }
        });
      });
    });
  }

  async function pickCameraSerial(serial) {
    const requested = String(serial || '').trim();
    if (requested) return requested;
    try {
      const d = await adb.devices();
      const entry = (d.list || []).find(x => x.state === 'device') || (d.list || [])[0];
      return entry ? entry.serial : '';
    } catch (e) {
      return '';
    }
  }

  ipcMain.handle('camera:start', async (_e, camera, options, serial) => {
    if (!fs.existsSync(cameraScript)) {
      return { ok: false, error: 'Файл camera/phonecam_server.py не найден' };
    }
    const pythonw = await findPythonw();
    if (!pythonw) {
      return { ok: false, error: 'Python 3 не найден. Для встроенной камеры нужен Python с OpenCV.' };
    }
    const prev = cameraProc;
    cameraProc = null;
    if (prev) {
      await serverShutdown(cameraOrigin);
      try { prev.removeAllListeners('exit'); prev.kill(); } catch (e) {}
      await new Promise(r => setTimeout(r, 260));
    }
    const targetSerial = await pickCameraSerial(serial);
    const cam = Math.max(0, Math.min(7, Number(camera) || 0));
    const width = Math.max(320, Math.min(3840, Number(options && options.width) || 1280));
    const height = Math.max(240, Math.min(2160, Number(options && options.height) || 720));
    const fps = Math.max(15, Math.min(120, Number(options && options.fps) || 60));
    const child = spawn(pythonw, [
      cameraScript,
      '--port', '27190',
      '--camera', String(cam),
      '--width', String(width),
      '--height', String(height),
      '--fps', String(fps),
      '--adb', adb.getAdbPath() || '',
      '--serial', targetSerial
    ], {
      cwd: path.dirname(cameraScript),
      stdio: 'ignore',
      windowsHide: true
    });
    cameraProc = child;
    child.on('error', () => {
      if (cameraProc === child) cameraProc = null;
    });
    child.on('exit', () => {
      if (cameraProc === child) cameraProc = null;
    });
    return { ok: true, port: 27190, camera: cam, serial: targetSerial };
  });

  ipcMain.handle('camera:install', async (_e, serial) => {
    const apk = path.join(__dirname, 'camera', 'android-cam.apk');
    if (!fs.existsSync(apk)) {
      return { ok: false, error: 'Файл camera/android-cam.apk не найден' };
    }
    const target = await pickCameraSerial(serial);
    if (!target) return { ok: false, error: 'Телефон не найден. Подключите его по ADB.' };
    const r = await adb.run(['-s', target, 'install', '-r', '-g', apk], { timeout: 180000 });
    const output = String((r.stdout || '') + (r.stderr || '')).trim().slice(-500);
    return { ok: !!r.ok, serial: target, output, error: r.ok ? '' : (output || 'adb install завершился с ошибкой') };
  });

  ipcMain.handle('camera:stop', async () => {
    await serverShutdown(cameraOrigin);
    const child = cameraProc;
    cameraProc = null;
    if (child) {
      try { child.removeAllListeners('exit'); child.kill(); } catch (e) {}
    }
    return { ok: true };
  });

  ipcMain.handle('camera:status', async () => cameraStatus());

  function cameraCaptureDir() {
    const dir = path.join(__dirname, 'camera', 'captures');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function cameraCaptureStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  }

  function toIpcBuffer(data) {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (data && data.type === 'Buffer' && Array.isArray(data.data)) return Buffer.from(data.data);
    return Buffer.from(data || []);
  }

  ipcMain.handle('camera:save-photo', async (_e, dataUrl) => {
    try {
      const match = String(dataUrl || '').match(/^data:image\/(png|jpeg);base64,(.+)$/);
      if (!match) return { ok: false, error: 'Некорректный кадр' };
      const ext = match[1] === 'jpeg' ? 'jpg' : 'png';
      const file = path.join(cameraCaptureDir(), `camera-photo-${cameraCaptureStamp()}.${ext}`);
      fs.writeFileSync(file, Buffer.from(match[2], 'base64'));
      return { ok: true, path: file };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('camera:save-video', async (_e, data, mime) => {
    try {
      const buffer = toIpcBuffer(data);
      if (!buffer.length) return { ok: false, error: 'Пустой видеофайл' };
      const ext = /mp4/i.test(String(mime || '')) ? 'mp4' : 'webm';
      const file = path.join(cameraCaptureDir(), `camera-video-${cameraCaptureStamp()}.${ext}`);
      fs.writeFileSync(file, buffer);
      return { ok: true, path: file };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('camera:open-captures', async () => {
    try {
      const dir = cameraCaptureDir();
      const error = await shell.openPath(dir);
      return error ? { ok: false, error } : { ok: true, path: dir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('drivers:status', async () => driversStatus());

  ipcMain.handle('drivers:install-audio', async () => {
    const setup = path.join(__dirname, 'camera', 'drivers', 'VBCABLE', 'VBCABLE_Setup_x64.exe');
    if (!fs.existsSync(setup)) {
      return { ok: false, error: 'Установщик VB-CABLE не найден в комплекте' };
    }
    const ps = `Start-Process -FilePath '${setup.replace(/'/g, "''")}' -ArgumentList '-i','-h' -Verb RunAs -Wait`;
    return new Promise(resolve => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
        windowsHide: true,
        timeout: 180000
      }, (err, stdout, stderr) => {
        const output = String((stdout || '') + (stderr || '')).trim();
        resolve({ ok: !err, error: err ? (output || err.message) : '', output });
      });
    });
  });

  ipcMain.handle('drivers:uninstall-audio', async () => {
    const setup = path.join(__dirname, 'camera', 'drivers', 'VBCABLE', 'VBCABLE_Setup_x64.exe');
    if (!fs.existsSync(setup)) {
      return { ok: false, error: 'Установщик VB-CABLE не найден в комплекте' };
    }
    const ps = `Start-Process -FilePath '${setup.replace(/'/g, "''")}' -ArgumentList '-u','-h' -Verb RunAs -Wait`;
    return new Promise(resolve => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
        windowsHide: true,
        timeout: 180000
      }, (err, stdout, stderr) => {
        const output = String((stdout || '') + (stderr || '')).trim();
        resolve({ ok: !err, error: err ? (output || err.message) : '', output });
      });
    });
  });

  ipcMain.handle('drivers:open-audio', async () => {
    const script = path.join(__dirname, 'camera', 'PhoneAudio.py');
    if (!fs.existsSync(script)) {
      return { ok: false, error: 'Файл camera/PhoneAudio.py не найден' };
    }
    const pythonw = await findPythonw();
    if (!pythonw) {
      return { ok: false, error: 'Python 3 не найден. Для микрофона нужен Python с sounddevice.' };
    }
    const target = await pickCameraSerial('');
    const args = [script, '--adb', adb.getAdbPath() || ''];
    if (target) args.push('--serial', target);
    try {
      const child = spawn(pythonw, args, {
        cwd: path.dirname(script),
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      child.unref();
      return { ok: true, serial: target };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  const audioScript = path.join(__dirname, 'camera', 'phoneaudio_server.py');
  const audioOrigin = 'http://127.0.0.1:27191';

  function audioStatus() {
    return new Promise(resolve => {
      const req = http.get(audioOrigin + '/status', { timeout: 1800 }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try { resolve({ ok: true, ...JSON.parse(body) }); }
          catch (e) { resolve({ ok: false, error: 'Некорректный ответ аудиосервера' }); }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Аудиосервер не отвечает' }); });
      req.on('error', e => resolve({ ok: false, error: e.message }));
    });
  }

  ipcMain.handle('audio:start', async (_e, serial) => {
    if (!fs.existsSync(audioScript)) {
      return { ok: false, error: 'Файл camera/phoneaudio_server.py не найден' };
    }
    const current = await audioStatus();
    if (current && current.ok) return { ok: true, already: true, ...current };
    const pythonw = await findPythonw();
    if (!pythonw) {
      return { ok: false, error: 'Python 3 не найден. Для микрофона нужен Python с sounddevice.' };
    }
    const prev = audioProc;
    audioProc = null;
    if (prev) {
      await serverShutdown(audioOrigin);
      try { prev.removeAllListeners('exit'); prev.kill(); } catch (e) {}
      await new Promise(r => setTimeout(r, 260));
    }
    const targetSerial = await pickCameraSerial(serial);
    const child = spawn(pythonw, [
      audioScript,
      '--port', '27191',
      '--adb', adb.getAdbPath() || '',
      '--serial', targetSerial
    ], {
      cwd: path.dirname(audioScript),
      stdio: 'ignore',
      windowsHide: true
    });
    audioProc = child;
    child.on('error', () => { if (audioProc === child) audioProc = null; });
    child.on('exit', () => { if (audioProc === child) audioProc = null; });
    return { ok: true, port: 27191, serial: targetSerial };
  });

  ipcMain.handle('audio:stop', async () => {
    await serverShutdown(audioOrigin);
    const child = audioProc;
    audioProc = null;
    if (child) {
      try { child.removeAllListeners('exit'); child.kill(); } catch (e) {}
    }
    return { ok: true };
  });

  ipcMain.handle('audio:status', async () => audioStatus());

  ipcMain.handle('audio:open-recordings', async () => {
    const dir = path.join(__dirname, 'camera', 'recordings');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const { shell } = require('electron');
      const error = await shell.openPath(dir);
      return error ? { ok: false, error } : { ok: true, path: dir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  const winAudioScript = path.join(__dirname, 'camera', 'win-audio.ps1');

  function runWinAudio(args) {
    return new Promise(resolve => {
      if (!fs.existsSync(winAudioScript)) {
        resolve({ ok: false, error: 'Файл camera/win-audio.ps1 не найден' });
        return;
      }
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', winAudioScript, ...args
      ], { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        const errText = String(stderr || '').trim();
        if (err) resolve({ ok: false, error: errText || err.message, stdout: out });
        else resolve({ ok: true, stdout: out });
      });
    });
  }

  ipcMain.handle('audio:system-mics', async () => {
    const r = await runWinAudio(['list']);
    if (!r.ok) return r;
    try {
      const parsed = JSON.parse(r.stdout || '[]');
      const devices = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      return { ok: true, devices };
    } catch (e) {
      return { ok: false, error: 'Не удалось разобрать список микрофонов', raw: r.stdout };
    }
  });

  ipcMain.handle('audio:set-default-mic', async (_e, id) => {
    const deviceId = String(id || '').trim();
    if (!deviceId) return { ok: false, error: 'Не выбрано устройство' };
    const r = await runWinAudio(['set', deviceId]);
    return r.ok ? { ok: true } : r;
  });

  ipcMain.handle('audio:rename-mic', async (_e, id, name) => {
    const deviceId = String(id || '').trim();
    const newName = String(name || '').trim() || 'Микрофон Android';
    if (!deviceId) return { ok: false, error: 'Не выбрано устройство' };
    const quote = (value) => String(value).replace(/'/g, "''");
    const inner = `$p = '${quote(winAudioScript)}'; & $p rename '${quote(deviceId)}' '${quote(newName)}'; exit $LASTEXITCODE`;
    const encoded = Buffer.from(inner, 'utf16le').toString('base64');
    const outer = `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'; exit $p.ExitCode`;
    return new Promise(resolve => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer], {
        windowsHide: true,
        timeout: 120000
      }, (err, stdout, stderr) => {
        if (err) {
          const details = String(stderr || '').trim() || err.message;
          resolve({ ok: false, error: 'Переименование не выполнено: ' + details });
        } else {
          resolve({ ok: true });
        }
      });
    });
  });

  ipcMain.handle('audio:open-sound-settings', async () => {
    try {
      const child = spawn('rundll32.exe', ['shell32.dll,Control_RunDLL', 'mmsys.cpl,,1'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      child.unref();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('clip:start', async (_e, serial) => clipStart(serial));
  ipcMain.handle('clip:stop', async () => { clipStop(false); return { ok: true }; });
  ipcMain.handle('clip:state', async () => ({ ok: true, running: !!clipScrcpy, serial: clipSerial, items: clipHistory.slice() }));
  ipcMain.handle('clip:clear', async () => { clipHistory.length = 0; return { ok: true }; });
  ipcMain.handle('clip:copy', async (_e, text) => {
    try { clipboard.writeText(String(text || '')); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // R10: установка ОДНОГО или НЕСКОЛЬКИХ APK с пофайловым статусом и отменой
  ipcMain.handle('tools:install-apk', async (_e, serial, paths) => {
    let list = Array.isArray(paths) ? paths.filter(x => typeof x === 'string' && x) : null;
    if (!list) {
      const f = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'APK', extensions: ['apk'] }] });
      if (f.canceled) return { ok: false, canceled: true };
      list = f.filePaths;
    }
    list = list.slice(0, 20);
    if (!list.length) return { ok: false, error: 'Файлы не выбраны' };
    installCanceled = false;
    const results = [];
    let installed = 0, failed = 0, canceled = false;
    for (let i = 0; i < list.length; i++) {
      if (installCanceled) { canceled = true; break; }
      const apkPath = list[i];
      const base = path.basename(apkPath);
      sendTask({ kind: 'apk-progress', index: i, total: list.length, file: base, stage: 'install' });
      if (!fs.existsSync(apkPath)) {
        failed++;
        sendTask({ kind: 'apk-progress', index: i, total: list.length, file: base, stage: 'fail' });
        results.push({ file: base, ok: false, message: 'файл не найден' });
        continue;
      }
      const r = await new Promise((resolve) => {
        const exe = adb.getAdbPath();
        if (!exe) return resolve({ ok: false, message: 'adb не найден' });
        const child = require('child_process').spawn(exe, ['-s', serial, 'install', '-r', apkPath], { windowsHide: true });
        installChild = child;
        let out = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve({ ok: false, message: 'Таймаут установки' }); }, 300000);
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { out += d; });
        child.on('error', e => { clearTimeout(timer); resolve({ ok: false, message: e.message }); });
        child.on('close', () => { clearTimeout(timer); resolve({ ok: /success/i.test(out), message: out.trim() }); });
      });
      installChild = null;
      if (r.ok) installed++; else { failed++; logErr('install-apk', base, (r.message || '').split('\n')[0].slice(0, 150)); }
      sendTask({ kind: 'apk-progress', index: i, total: list.length, file: base, stage: r.ok ? 'done' : 'fail' });
      results.push({ file: base, ok: r.ok, message: (r.message || '').split('\n')[0].slice(0, 200) });
    }
    log('install-apk done', `installed=${installed}`, `failed=${failed}`, canceled ? 'canceled' : ''); // no-op (журнал = только ошибки)
    return { ok: installed > 0, installed, failed, canceled, results };
  });
  ipcMain.handle('tools:install-apk-cancel', async () => {
    installCanceled = true;
    try { if (installChild) installChild.kill('SIGKILL'); } catch (e) {}
    return { ok: true };
  });

  ipcMain.handle('tools:quick', async (_e, serial, cmd) => {
    const map = {
      home: ['input', 'keyevent', '3'],
      back: ['input', 'keyevent', '4'],
      recents: ['input', 'keyevent', '187'],
      power: ['input', 'keyevent', '26'],
      wake: ['input', 'keyevent', '224'],
      volup: ['input', 'keyevent', '24'],
      voldown: ['input', 'keyevent', '25'],
      media: ['input', 'keyevent', '85'],
      brightup: ['input', 'keyevent', '221'],
      brightdown: ['input', 'keyevent', '220'],
      reboot: ['reboot'],
      bootloader: ['reboot', 'bootloader'],
      recovery: ['reboot', 'recovery'],
      landscape: ['shell', 'settings', 'put', 'system', 'user_rotation', '1'],
      portrait: ['shell', 'settings', 'put', 'system', 'user_rotation', '0']
    };
    const args = map[cmd];
    if (!args) return { ok: false, error: 'Неизвестная команда' };
    const isReboot = cmd === 'reboot' || cmd === 'bootloader' || cmd === 'recovery';
    const isRot = cmd === 'landscape' || cmd === 'portrait';
    const full = (isReboot || isRot)
      ? ['-s', serial, ...args]
      : ['-s', serial, 'shell', ...args];
    const r = await adb.run(full, { timeout: 20000 });
    return { ok: r.ok, message: (r.stdout || r.stderr).trim() };
  });

  // полный отчёт диагностики пишется в app.log (INFO) — владелец просил
  // «когда я запускаю диагностику, вся эта информация должна отображаться в логфайле»
  // диагностика расширена и честнее. Раздел mDNS-ADB теперь:
  //  * показывает СЫРОЙ вывод «adb mdns services» (видно даже то, что парсер не понял);
  //  * «ок» = команда отработала, а не «что-то найдено» (пустой список — жёлтое предупреждение,
  //    а не красная ошибка: сервисы видны только пока на телефоне открыт экран беспроводной отладки);
  //  * добавлены разделы собственного mDNS-клиента и unicast-свипа подсети.
  ipcMain.handle('tools:diagnostics', async (_e, serial) => {
    const rep = { sections: [], suggestions: [] };
    const v = await adb.version();
    rep.sections.push({ id: 'adb', title: 'ADB', ok: v.ok, lines: v.ok ? [`версия ${v.version}`, `путь: ${v.path}`] : [v.error || 'adb не найден'] });
    if (!v.ok) rep.suggestions.push('Укажите путь к adb.exe в настройках или перезапустите приложение.');
    const d = await adb.devices();
    rep.sections.push({ id: 'devices', title: 'Устройства', ok: d.ok && d.list.length > 0, lines: d.ok ? (d.list.length ? d.list.map(x => `${x.serial} — ${x.state}`) : ['устройств нет']) : [d.error || 'ошибка'] });
    if (d.ok && !d.list.length) rep.suggestions.push('Подключите устройство по IP или выполните сопряжение.');
    if (serial) {
      const p = await adb.pingDevice(serial);
      rep.sections.push({ id: 'response', title: 'Отклик устройства', ok: p.ok, lines: p.ok ? [`ответ за ${p.ms} мс`] : ['нет ответа'] });
      if (!p.ok) rep.suggestions.push('Проверьте, что телефон в той же сети и беспроводная отладка включена.');
    }
    // --- mDNS-сервисы adb: raw + статус warn вместо fail ---
    const m = await adb.mdnsServices();
    const raw = await adb.run(['mdns', 'services'], { timeout: 8000 }).catch(() => null);
    const rawLines = ((raw && raw.stdout) || '').split(/\r?\n/).filter(x => x.trim()).slice(0, 10);
    rep.sections.push({
      id: 'mdns',
      title: 'mDNS-сервисы (adb mdns services)',
      ok: m.ok, warn: m.ok && !m.items.length,
      lines: m.ok
        ? (m.items.length
          ? m.items.map(x => `${x.service} → ${x.host}:${x.port}`)
          : ['сервисов сейчас нет (это НЕ ошибка команды)', ...rawLines.map(x => '  raw: ' + x)])
        : [raw && raw.stderr ? ('команда вернула ошибку: ' + raw.stderr.trim().slice(0, 160)) : 'команда не ответила']
    });
    if (m.ok && !m.items.length) rep.suggestions.push('Откройте на телефоне экран «Беспроводная отладка» (сервисы публикуются только пока он открыт) и повторите диагностику. Если пусто и так — проверьте, что сеть Windows «Частная», а брандмауэр разрешает UDP 5353.');
    if (!m.ok) rep.suggestions.push('Команда «adb mdns services» не отработала — попробуйте перезапустить программу (adb-сервер перезапустится вместе с ней).');
    // --- собственный mDNS-клиент + unicast-свип (работают там, где adb mdns глушится сетью) ---
    const [mine, uni] = await Promise.all([
      mdns.discover(2500).catch(() => []),
      mdns.discoverUnicast(2500).catch(() => [])
    ]);
    rep.sections.push({
      id: 'mdns-own', title: 'mDNS-обнаружение (свой клиент)', ok: true, warn: !mine.length,
      lines: mine.length ? mine.map(x => `${(x.service || '').replace('.local', '')} → ${x.host}:${x.port}`) : ['мульткаст-ответов нет (роутер может резать multicast)']
    });
    rep.sections.push({
      id: 'mdns-uni', title: 'Unicast-обход подсети (роутеры без multicast)', ok: true, warn: !uni.length,
      lines: uni.length ? uni.map(x => `${(x.service || '').replace('.local', '')} → ${x.host}:${x.port}`) : ['unicast-ответов нет (телефон выключен/другая сеть)']
    });
    if (!mine.length && !uni.length) rep.suggestions.push('Телефон не виден по mDNS ни одним способом. Проверьте: телефон и ПК в одной Wi-Fi-сети; на телефоне включена «Беспроводная отладка»; сеть Windows помечена «Частной».');
    try {
      const t = new Date().toISOString();
      const dev = serial ? ('устройство: ' + serial) : 'устройство: не выбрано';
      logInfo('diag', '=== ДИАГНОСТИКА', t, dev, '===');
      for (const sec of rep.sections) {
        const st = !sec.ok ? 'ОШИБКА' : (sec.warn ? 'ВНИМАНИЕ' : 'OK');
        logInfo('diag', '[' + st + '] ' + sec.title + ':', sec.lines.join(' | '));
      }
      if (rep.suggestions.length) logInfo('diag', 'Рекомендации:', rep.suggestions.map(s => '- ' + s).join(' '));
      logInfo('diag', '=== КОНЕЦ ДИАГНОСТИКИ ===');
    } catch (e) {}
    return rep;
  });

  /* ================= инфо об устройстве ================= */
  ipcMain.handle('dev:info', async (_e, serial) => {
    const g = async (args) => { const r = await adb.run(['-s', serial, 'shell', ...args], { timeout: 8000 }); return (r.stdout || '').trim(); };
    const [man, model, rel, bat, wm, df] = await Promise.all([
      g(['getprop', 'ro.product.manufacturer']), g(['getprop', 'ro.product.model']),
      g(['getprop', 'ro.build.version.release']), g(['dumpsys', 'battery']),
      g(['wm', 'size']), g(['df', '/data'])
    ]);
    const level = (bat.match(/level:\s*(\d+)/) || [])[1] || '?';
    const size = (wm.match(/(\d+x\d+)/) || [])[1] || '';
    let storage = null;
    const dfl = df.split(/\r?\n/)[1];
    if (dfl) { const p = dfl.split(/\s+/); storage = { total: p[1], used: p[2], free: p[3] }; }
    return { manufacturer: man, model, android: rel, battery: level, screen: size, storage };
  });

  /* ================= сохранённые устройства ================= */
  let saved = loadJson(SAVED_FILE, []); // путь — из верхнего уровня: Сохранения/saved.json (F16)
  ipcMain.handle('saved:list', async () => saved);
  ipcMain.handle('saved:add', async (_e, rec) => {
    rec.id = rec.id || String(Date.now());
    saved = saved.filter(x => !(x.host === rec.host && x.port === rec.port));
    saved.unshift(rec); saveJson(SAVED_FILE, saved); return saved;
  });
  ipcMain.handle('saved:remove', async (_e, id) => { saved = saved.filter(x => x.id !== id); saveJson(SAVED_FILE, saved); return saved; });
  ipcMain.handle('saved:rename', async (_e, id, name) => {
    const it = saved.find(x => x.id === id); if (it) { it.name = name; saveJson(SAVED_FILE, saved); }
    return saved;
  });

  /* ================= встроенное зеркало экрана ================= */
  ipcMain.handle('mirror:start', async (_e, serial, mode) => {
    mode = mode === 'jpeg' ? 'jpeg' : 'h264';
    if (mirrorMode) return { ok: false, error: 'Трансляция уже идёт' };
    if (!serial) return { ok: false, error: 'Нет активного устройства' };
    mirrorSerial = serial;
    mirrorMode = mode;
    mirrorGen++;
    const gen = mirrorGen;
    mirrorRestarts = 0;
    if (mode === 'h264') {
      spawnH264(serial, gen);
      // watchdog: 7 с без данных → renderer переключит в простой режим (R9)
      mirrorWatchdog = setInterval(() => {
        if (gen !== mirrorGen) return;
        if (Date.now() - mirrorLastData > 7000) sendTask({ kind: 'mirror-stalled' });
      }, 1000);
    } else {
      jpegTick();
    }
    logInfo('mirror', 'старт', serial, 'режим ' + mode);
    return { ok: true, mode, gen };
  });
  ipcMain.handle('mirror:stop', async () => { stopMirrorAll(); return { ok: true }; });
  // «перезапуск потока на месте» — renderer переключает режим декодера и просит
  // СВЕЖИЙ поток (SPS/PPS/IDR в начале), не трогая генерацию сессии и UI
  ipcMain.handle('mirror:bounce', async () => {
    if (mirrorMode !== 'h264' || !mirrorSerial) return { ok: false };
    const gen = mirrorGen, serial = mirrorSerial;
    try { if (mirrorChild) { mirrorChild.removeAllListeners('close'); mirrorChild.kill('SIGKILL'); mirrorChild = null; } } catch (e) {}
    await sleep(150);
    if (gen === mirrorGen && mirrorMode === 'h264') spawnH264(serial, gen);
    logInfo('mirror', 'bounce: поток перезапущен для нового декодера');
    return { ok: true };
  });
  ipcMain.handle('input:tap', async (_e, serial, x, y) => adb.run(['-s', serial, 'shell', 'input', 'tap', String(x), String(y)], { timeout: 5000 }));
  ipcMain.handle('input:swipe', async (_e, serial, x1, y1, x2, y2, ms) => adb.run(['-s', serial, 'shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(ms)], { timeout: 8000 }));
  ipcMain.handle('input:key', async (_e, serial, key) => adb.run(['-s', serial, 'shell', 'input', 'keyevent', String(key)], { timeout: 5000 }));

  async function devGet(serial, key) {
    const r = await adb.run(['-s', serial, 'shell', 'settings', 'get', 'global', key], { timeout: 8000 });
    return (r.stdout || '').trim();
  }
  async function devPut(serial, key, value) {
    const r = await adb.run(['-s', serial, 'shell', 'settings', 'put', 'global', key, String(value)], { timeout: 8000 });
    return r.ok;
  }
  async function devTapBuildNumber(serial) {
    const tmp = path.join(os.tmpdir(), 'adbwc-dev-' + Date.now() + '.xml');
    try {
      await adb.run(['-s', serial, 'shell', 'am', 'start', '-a', 'android.settings.DEVICE_INFO_SETTINGS'], { timeout: 10000 });
      await sleep(1200);
      const sz = await adb.run(['-s', serial, 'shell', 'wm', 'size'], { timeout: 8000 });
      const mm = /(\d+)x(\d+)/.exec(sz.stdout || '');
      const w = mm ? +mm[1] : 1080, h = mm ? +mm[2] : 1920;
      const re = /(номер сборки|build number|версия hyperos|hyperos|версия miui|miui|build)/i;
      for (let i = 0; i < 5; i++) {
        const d = await adb.run(['-s', serial, 'shell', 'uiautomator', 'dump', '/sdcard/adbwc_dev.xml'], { timeout: 15000 });
        if (!d.ok) return false;
        const p = await adb.run(['-s', serial, 'pull', '/sdcard/adbwc_dev.xml', tmp], { timeout: 15000 });
        if (!p.ok) return false;
        const xml = fs.readFileSync(tmp, 'utf8');
        const hits = [...xml.matchAll(/<node[^>]*text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)]
          .map(m => ({ text: m[1], x1: +m[2], y1: +m[3], x2: +m[4], y2: +m[5] }))
          .filter(n => n.text && re.test(n.text));
        if (hits.length) {
          const n = hits[0];
          const x = Math.round((n.x1 + n.x2) / 2), y = Math.round((n.y1 + n.y2) / 2);
          for (let k = 0; k < 7; k++) { await adb.run(['-s', serial, 'shell', 'input', 'tap', String(x), String(y)], { timeout: 5000 }); await sleep(180); }
          await sleep(900);
          return true;
        }
        await adb.run(['-s', serial, 'shell', 'input', 'swipe', String(Math.round(w / 2)), String(Math.round(h * 0.75)), String(Math.round(w / 2)), String(Math.round(h * 0.3)), '300'], { timeout: 8000 });
        await sleep(600);
      }
      return false;
    } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
  }
  ipcMain.handle('dev:state', async (_e, serial) => {
    if (!serial) return { ok: false, error: 'Нет устройства' };
    const dev = await devGet(serial, 'development_settings_enabled');
    const adbOn = await devGet(serial, 'adb_enabled');
    return { ok: true, dev: dev === '1', adb: adbOn === '1' };
  });
  async function devDetect() {
    const out = { adb: [], usb: [], wifi: [], lan: [] };
    const d = await adb.run(['devices', '-l'], { timeout: 8000 }).catch(() => null);
    for (const line of String((d && d.stdout) || '').split(/\r?\n/)) {
      const m = /^(\S+)\s+device\b(.*)$/.exec(line.trim());
      if (m) out.adb.push({ serial: m[1], info: m[2].trim() });
    }
    const ps = (script) => new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, timeout: 15000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') }));
    });
    const pnp = await pnpAndroidUsb();
    out.usb = pnp;
    const lan = await ps("$ifs = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | ForEach-Object { $_.InterfaceAlias } | Select-Object -Unique); if (-not $ifs.Count) { $ifs = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { $_.InterfaceAlias }) }; Get-NetNeighbor -InterfaceAlias $ifs -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object IPAddress,LinkLayerAddress,State | ConvertTo-Json -Compress");
    if (lan.ok && lan.out.trim()) {
      try {
        const a = JSON.parse(lan.out);
        const OK = new Set([3, 4, 5]);   // Delay, Stale, Reachable
        out.lan = (Array.isArray(a) ? a : [a])
          .map(x => ({ ip: x.IPAddress, mac: x.LinkLayerAddress, state: x.State }))
          .filter(x => x.ip && !/^(224|239|255|127|0|169\.254)\./.test(x.ip) && !/\.255$/.test(x.ip))
          .filter(x => x.mac && x.mac !== '00-00-00-00-00-00' && x.mac !== 'FF-FF-FF-FF-FF-FF')
          .filter(x => OK.has(Number(x.state)))
          .slice(0, 8);
      } catch (e) {}
    }
    try {
      out.wifi = (await mergedDiscover())
        .filter(x => x && (/_adb|adb/i.test(String(x.service || '')) || x.src === 'adb-mdns'))
        .map(x => ({ host: x.host, port: x.port, service: x.service, src: x.src }));
    } catch (e) {}
    return { ok: true, ...out };
  }
  async function devEnable(serial) {
    if (!serial) {
      const d = await adb.run(['devices'], { timeout: 8000 });
      const line = String(d.stdout || '').split(/\r?\n/).find(l => /\sdevice$/.test(l));
      serial = line ? line.trim().split(/\s+/)[0] : '';
    }
    if (!serial) return { ok: false, error: 'Телефон не найден по ADB. Подключите его по USB или через QR/Wi-Fi — одной сети Wi-Fi без отладки недостаточно.' };
    let dev = (await devGet(serial, 'development_settings_enabled')) === '1';
    let method = dev ? 'already' : '';
    if (!dev) {
      await devPut(serial, 'development_settings_enabled', 1);
      await devPut(serial, 'adb_enabled', 1);
      dev = (await devGet(serial, 'development_settings_enabled')) === '1';
      method = 'settings';
    } else {
      await devPut(serial, 'adb_enabled', 1);
    }
    if (!dev) {
      const tapped = await devTapBuildNumber(serial);
      dev = tapped && (await devGet(serial, 'development_settings_enabled')) === '1';
      if (dev) method = 'tap';
    }
    if (!dev) return { ok: false, error: 'Не удалось включить режим разработчика. Разблокируйте телефон и попробуйте ещё раз.' };
    await devPut(serial, 'adb_enabled', 1);
    await adb.run(['-s', serial, 'shell', 'am', 'start', '-a', 'android.settings.APPLICATION_DEVELOPMENT_SETTINGS'], { timeout: 10000 });
    let wifi = null;
    if (!/^\d+\.\d+\.\d+\.\d+/.test(serial)) {
      try {
        const ipr = await adb.run(['-s', serial, 'shell', 'ip', 'route', 'get', '1.1.1.1'], { timeout: 8000 });
        const ipm = /src\s+(\d+\.\d+\.\d+\.\d+)/.exec(ipr.stdout || '');
        if (ipm) {
          await adb.run(['-s', serial, 'tcpip', '5555'], { timeout: 10000 });
          await sleep(800);
          const cr = await adb.run(['connect', ipm[1] + ':5555'], { timeout: 10000 });
          wifi = { host: ipm[1], port: 5555, ok: cr.ok, out: (cr.stdout || '').trim() };
        }
      } catch (e) {}
    }
    return { ok: true, dev: true, adb: true, method, wifi };
  }
  ipcMain.handle('dev:detect', () => devDetect());
  ipcMain.handle('dev:enable', (_e, serial) => devEnable(serial));
  devDetectFn = devDetect;

  /* ================= свои команды терминала (F16): строго в «Сохранения/» ================= */
  let customCmds = loadJson(CMDS_FILE, []); // [{name, cmd}]
  ipcMain.handle('cmds:list', async () => customCmds);
  ipcMain.handle('cmds:add', async (_e, name, cmd) => {
    if (typeof name !== 'string' || !name.trim() || typeof cmd !== 'string' || !cmd.trim()) return { ok: false, error: 'Нужно имя и команда' };
    if (customCmds.length >= 200) return { ok: false, error: 'Слишком много своих команд (макс. 200)' };
    customCmds = customCmds.filter(c => c.cmd !== cmd.trim());
    customCmds.unshift({ name: name.trim().slice(0, 80), cmd: cmd.trim().slice(0, 500) });
    saveJson(CMDS_FILE, customCmds);
    return { ok: true, list: customCmds };
  });
  ipcMain.handle('cmds:remove', async (_e, cmd) => {
    customCmds = customCmds.filter(c => c.cmd !== cmd);
    saveJson(CMDS_FILE, customCmds);
    return { ok: true, list: customCmds };
  });

  /* ================= терминал adb shell ================= */
  ipcMain.handle('shell:start', async (_e, serial) => {
    if (shellChild) {
      // старую сессию глушим до создания новой — её close не должен затирать shellChild
      const prev = shellChild; shellChild = null;
      try { prev.removeAllListeners('close'); prev.kill('SIGKILL'); } catch (e) {}
    }
    const exe = adb.getAdbPath();
    const child = require('child_process').spawn(exe, ['-s', serial, 'shell'], { windowsHide: true });
    shellChild = child;
    const emit = d => { if (win && !win.isDestroyed()) win.webContents.send('shell:out', { serial, data: d.toString('utf8') }); };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.on('close', () => { if (shellChild === child) { shellChild = null; sendTask({ kind: 'shell-stopped' }); } });
    return { ok: true };
  });
  ipcMain.handle('shell:write', async (_e, line) => {
    if (!shellChild) return { ok: false };
    shellChild.stdin.write(line + '\n'); return { ok: true };
  });
  ipcMain.handle('shell:stop', async () => {
    const c = shellChild; shellChild = null; // обнуляем ДО kill — close старого не сработает по identity
    if (c) { try { c.removeAllListeners('close'); c.kill('SIGKILL'); } catch (e) {} }
    return { ok: true };
  });

  /* ================= файловый менеджер ================= */
  // ls с КАВЫЧКОЙ пути (F1: «Мои клипы» с пробелом разваливался на два слова —
  // устройство отвечало «ls: клипы: No such file or directory»)
  // (L2): путь нормализуем + хвостовой слэш — иначе ls -l /sdcard
  // показывает сам симлинк вместо содержимого («/sdcard не открывается»)
  ipcMain.handle('fs:list', async (_e, serial, dir) => {
    const d = normalizeFsDir(dir);
    const dirArg = d === '/' ? '/' : d + '/';
    let r = await adb.shellRun(serial, ['ls', '-lAp', dirArg], { timeout: 15000 });
    // если stdout пуст — пробуем без -p; stderr с Permission denied при этом
    // не означает, что весь каталог недоступен: ls может отдать часть файлов.
    if (!(r.stdout || '').trim()) r = await adb.shellRun(serial, ['ls', '-la', dirArg], { timeout: 15000 });
    const stderr = String(r.stderr || '').trim();
    const denied = /permission denied/i.test(stderr);
    const items = [];
    // toybox ls -l на Android: perms links user group size date name
    // (колонка links есть почти всегда; старые сборки — без неё; дата: «2024-05-01 10:12», «May 1 10:12» или «05-01 10:12»)
    const RE = /^([dl\-][rwxsStT\-]{8,})\s+(?:(\d+)\s+)?(\S+)\s+(\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?|\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?|\d{2}-\d{2}\s+\d{1,2}:\d{2})\s+(.+)$/;
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      const m = line.trim().match(RE);
      if (!m) continue;
      let name = m[7];
      if (name === '.' || name === '..') continue;
      const isDir = m[1][0] === 'd' || name.endsWith('/');
      name = name.replace(/\/+$/, '');
      // симлинки toybox печатает как «имя -> цель» — оставляем только имя (W1-ревизор)
      const arrow = name.indexOf(' -> ');
      if (arrow > 0) name = name.slice(0, arrow);
      if (!name) continue;
      items.push({ name, dir: isDir, size: parseInt(m[5], 10) || 0, date: m[6], perms: m[1] });
    }
    // каталог вернул текст, но основной парсер не понял НИ ОДНОЙ строки — включаем
    // терпимый фолбэк-парсер (иначе пользователь видит «Папка пуста» там, где файлы есть — F3)
    if (!items.length && r.ok && (r.stdout || '').trim()) {
      for (const line of (r.stdout || '').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || /^total/i.test(t)) continue;
        // имя = всё после последнего времени ЧЧ:ММ; perms — первый токен
        const m2 = t.match(/^(\S+)\s+.*?\s(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/);
        if (!m2) continue;
        let name = m2[3].replace(/\/+$/, '');
        const arrow = name.indexOf(' -> ');
        if (arrow > 0) name = name.slice(0, arrow);
        if (!name || name === '.' || name === '..') continue;
        // размер: последний чисто-числовой токен перед датой (W2-ревизор: старый mm-regex был мёртвым)
        const toks = t.split(/\s+/);
        const tIdx = toks.indexOf(m2[2]);
        let size = 0;
        for (let k = tIdx - 1; k > 0; k--) { if (/^\d+$/.test(toks[k])) { size = parseInt(toks[k], 10) || 0; break; } }
        const perms = (t.match(/^[dlbct\-][rwxsStT\-\.\+]{7,}/) || [''])[0];
        items.push({ name, dir: perms[0] === 'd', size, date: m2[2], perms });
      }
    }
    items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    // ls возвращает ненулевой код, если не смог прочитать отдельные записи, но
    // stdout при этом содержит нормальный список. Считаем каталог открытым,
    // если есть элементы или строка total (пустая папка).
    const listingOk = r.ok || items.length > 0 || /(^|\n)total\s+\d+/m.test(String(r.stdout || ''));
    if (!listingOk) logErr('fs:list', serial, d, (stderr || r.error || '').slice(0, 200));
    const err = listingOk ? null : (denied
      ? (d === '/data'
        ? 'Раздел /data защищён Android: без root содержимое недоступно. Это не ошибка.'
        : 'Нет доступа: раздел защищён — нужен root')
      : (stderr || r.error || 'Не удалось прочитать папку').slice(0, 220));
    return { ok: listingOk, items, path: d, error: err, denied };
  });
  ipcMain.handle('fs:pull', async (_e, serial, remote) => {
    const f = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), path.basename(remote)) });
    if (f.canceled) return { ok: false, canceled: true };
    // adb pull сам работает с argv (без shell) — кавычка не нужна, но 'adb pull' на
    // удалённой стороне путей с пробелами НЕ касаемся: тут путь идёт как аргумент протокола
    const r = await adb.run(['-s', serial, 'pull', remote, f.filePath], { timeout: 300000 });
    if (!r.ok) logErr('fs:pull', serial, remote, (r.stderr || '').slice(0, 150));
    return { ok: r.ok, file: f.filePath, message: (r.stdout || r.stderr).trim() };
  });
  ipcMain.handle('fs:push', async (_e, serial, local, remoteDir) => {
    if (!local) {
      const f = await dialog.showOpenDialog(win, { properties: ['openFile'] });
      if (f.canceled) return { ok: false, canceled: true };
      local = f.filePaths[0];
    }
    // push в КОНКРЕТНУЮ открытую папку (F7): хвост слэша гарантирует «внутрь каталога»
    const target = /[\/]$/.test(remoteDir) ? remoteDir : remoteDir.replace(/\/+$/, '') + '/';
    const r = await adb.run(['-s', serial, 'push', local, target], { timeout: 300000 });
    if (!r.ok) logErr('fs:push', serial, local, target, (r.stderr || '').slice(0, 150));
    return { ok: r.ok, message: (r.stdout || r.stderr).trim() };
  });
  // прямая передача выбранных файлов/папок на другой телефон по Wi-Fi.
  // Компьютер не перекачивает данные через себя: на получателе запускается nc+tar,
  // на источнике — tar|nc. Компьютер только поднимает обе стороны и проверяет итог.
  ipcMain.handle('fs:phone-transfer', async (_e, payload) => {
    const p = payload || {};
    const src = String(p.src || p.srcSerial || '');
    const dst = String(p.dst || p.dstSerial || '');
    const paths = Array.isArray(p.paths) ? p.paths.map(String).filter(Boolean).slice(0, 200) : [];
    const dest = normalizeFsDir(p.dest || '/sdcard/Download');
    const conflict = (p.conflict === 'replace' || p.conflict === 'rename') ? p.conflict : '';
    if (!src || !dst) return { ok: false, error: 'Не выбраны источник и получатель' };
    if (!paths.length) return { ok: false, error: 'Не выбраны файлы для передачи' };
    try {
      const r = await phoneTransferMany(src, dst, paths, dest, conflict);
      if (!r.ok) logErr('fs:phone-transfer', src, dst, (r.error || (r.items || []).map(x => x && x.error).filter(Boolean).join('; ')).slice(0, 300));
      return r;
    } catch (e) {
      logErr('fs:phone-transfer', src, dst, e.message);
      return { ok: false, error: e.message || 'Ошибка передачи' };
    }
  });
  // ПЕРЕТАСКИВАНИЕ ИЗ ПРОГРАММЫ В ПРОВОДНИК / НА РАБОЧИЙ СТОЛ.
  // Windows принимает в drag только локальный путь, поэтому сначала тянем файл
  // (или папку) с телефона во временную папку, затем startDrag. Повторное
  // перетаскивание того же файла берёт готовую копию из кэша.
  const dragTmpRoot = () => path.join(app.getPath('temp'), 'gigatool-drag');
  const dragCache = new Map();
  ipcMain.handle('drag:prepare', async (_e, serial, remote) => {
    if (!serial || !remote) return { ok: false, error: 'Не указан файл' };
    const key = serial + '|' + remote;
    const hit = dragCache.get(key);
    if (hit) { try { if (fs.existsSync(hit)) return { ok: true, path: hit }; } catch (e) {} dragCache.delete(key); }
    try {
      const root = dragTmpRoot();
      fs.mkdirSync(root, { recursive: true });
      const uniq = path.join(root, Date.now() + '-' + Math.random().toString(36).slice(2, 7));
      fs.mkdirSync(uniq, { recursive: true });
      const clean = path.basename(String(remote).replace(/\/+$/, '')).replace(/[\\/:*?"<>|]+/g, '_') || 'file';
      const dest = path.join(uniq, clean);
      const r = await adb.run(['-s', serial, 'pull', remote, dest], { timeout: 600000 });
      if (!r.ok) {
        try { fs.rmSync(uniq, { recursive: true, force: true }); } catch (e) {}
        return { ok: false, error: (r.stderr || r.stdout || 'adb pull').trim().slice(0, 200) };
      }
      dragCache.set(key, dest);
      return { ok: true, path: dest };
    } catch (e) { logErr('drag:prepare', e.message); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('drag:start', (e, p) => {
    try {
      let icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
      if (icon.isEmpty()) icon = nativeImage.createEmpty();
      else icon = icon.resize({ width: 48, height: 48 });
      e.sender.startDrag({ file: p, icon });
      return { ok: true };
    } catch (e) { logErr('drag:start', e.message); return { ok: false, error: e.message }; }
  });
  // fs:cmd идёт ЧЕРЕЗ shellRun: аргументы (rm/mkdir/chmod + путь) кавычятся — пути с пробелами работают
  ipcMain.handle('fs:cmd', async (_e, serial, args) => {
    const r = await adb.shellRun(serial, Array.isArray(args) ? args : [String(args || '')], { timeout: 30000 });
    if (!r.ok) logErr('fs:cmd', serial, JSON.stringify(args).slice(0, 120), (r.stderr || '').slice(0, 150));
    return r;
  });

  // свойства файла/папки (F6)
  ipcMain.handle('fs:stat', async (_e, serial, remotePath) => {
    const out = { ok: false, path: remotePath };
    try {
      const q = adb.shq(remotePath);
      const st = await adb.run(['-s', serial, 'shell', `stat -c '%A|%F|%s|%u|%g|%y|%h|%b' ${q} 2>/dev/null`], { timeout: 12000 });
      const line = (st.stdout || '').trim().split(/\r?\n/)[0] || '';
      const p = line.split('|');
      if (p.length >= 8 && p[1]) {
        out.ok = true;
        out.perms = p[0]; out.kind = p[1]; out.size = parseInt(p[2], 10) || 0;
        out.uid = p[3]; out.gid = p[4]; out.mtime = p[5]; out.links = p[6]; out.blocks = parseInt(p[7], 10) || 0;
      }
      const isDir = /directory/i.test(out.kind || '') || (out.perms || '')[0] === 'd';
      if (out.ok && isDir) {
        const cnt = await adb.run(['-s', serial, 'shell', `ls -1A ${q} 2>/dev/null | wc -l`], { timeout: 12000 });
        out.items = parseInt((cnt.stdout || '0').trim(), 10) || 0;
        const du = await adb.run(['-s', serial, 'shell', `du -s ${q} 2>/dev/null`], { timeout: 30000 });
        const dkb = parseInt(((du.stdout || '').match(/^(\d+)/) || [])[1] || '0', 10) || 0;
        if (dkb) out.duBytes = dkb * 1024;
      }
      if (!out.ok) {
        // старые toybox без stat: фолбэк на ls -ld
        const ld = await adb.run(['-s', serial, 'shell', `ls -ld ${q}`], { timeout: 12000 });
        const t = (ld.stdout || '').trim();
        if (t) {
          out.ok = true;
          out.perms = (t.match(/^[dlbct\-][rwxsStT\-\.\+]{7,}/) || [''])[0] || '';
          out.kind = out.perms[0] === 'd' ? 'directory' : 'regular file';
          out.lsLine = t;
        }
      }
    } catch (e) { logErr('fs:stat', serial, remotePath, e.message); }
    return out;
  });

  /* ================= менеджер приложений ================= */
  ipcMain.handle('apps:list', async (_e, serial) => {
    // только реально установленные приложения. «Удалённые для пользователя»
    // (pm uninstall -k --user 0) в списках НЕ показываются — их больше нет на телефоне.
    const [u, s, d] = await Promise.all([
      adb.run(['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'], { timeout: 20000 }),
      adb.run(['-s', serial, 'shell', 'pm', 'list', 'packages', '-s'], { timeout: 20000 }),
      adb.run(['-s', serial, 'shell', 'pm', 'list', 'packages', '-d'], { timeout: 20000 })
    ]);
    const parse = x => (x.stdout || '').split(/\r?\n/).filter(l => l.startsWith('package:')).map(l => l.slice(8).trim());
    const disabled = new Set(parse(d));
    return {
      ok: true,
      user: parse(u), system: parse(s),
      disabled: Array.from(disabled)
    };
  });
  ipcMain.handle('apps:action', async (_e, serial, action, pkg) => {
const map = {
      disable: ['pm', 'disable-user', '--user', '0', pkg],
      enable: ['pm', 'enable', '--user', '0', pkg],
      removeUser: ['pm', 'uninstall', '-k', '--user', '0', pkg],
      restore: ['cmd', 'package', 'install-existing', '--user', '0', pkg],
      clear: ['pm', 'clear', pkg],
      // кэш без удаления данных (Android 13+; на старых версиях честно вернётся ошибка — F12)
      clearCache: ['pm', 'clear', '--cache-only', pkg],
      forceStop: ['am', 'force-stop', pkg],
      uninstall: ['pm', 'uninstall', pkg],
      // «Свойства на телефоне» — открыть страницу приложения в настройках Android
      phoneInfo: ['am', 'start', '-a', 'android.settings.APPLICATION_DETAILS_SETTINGS', '-d', 'package:' + pkg]
    };
    const args = map[action];
    if (!args) return { ok: false, error: 'Неизвестное действие' };
    const run = (a) => adb.run(['-s', serial, 'shell', ...a], { timeout: 60000 });
    let r = await run(args);
    // механизм ADB AppControl — на MIUI/HyperOS/OneUI `pm disable-user` для
    // системных пакетов бьётся SecurityException «Cannot disable system packages».
    // Рабочий обход, который использует ADB AppControl: `pm uninstall --user 0 <pkg>` —
    // «удаление для текущего пользователя», обратимое через `cmd package install-existing`.
    let usedFallback = false;
    const textOf = (x) => (((x && x.stdout) || '') + ' ' + ((x && x.stderr) || '')).trim();
    if (action === 'disable' && /cannot disable system packages|securityexception/i.test(textOf(r))) {
      r = await run(['pm', 'uninstall', '-k', '--user', '0', pkg]);
      usedFallback = true;
    }
    if (action === 'restore' && !r.ok) {
      const en = await run(['pm', 'enable', '--user', '0', pkg]);
      if (en.ok) { r = en; usedFallback = true; }
    }
    if ((action === 'enable' || action === 'restore') && !r.ok) {
      r = await run(['cmd', 'package', 'install-existing', '--user', '0', pkg]);
      if (!r.ok) r = await run(['pm', 'install-existing', '--user', '0', pkg]);
      usedFallback = true;
    }
    // am force-stop / pm disable-user НЕ печатают «success» — раньше из-за этого
    // кнопки «Остановить»/«Отключить» врали «Не удалось». Считаем успехом отсутствие ошибки.
    const out = ((r.stdout || '') + ' ' + (r.stderr || '')).trim();
    const bad = /error|exception|failure|failed|unknown package|not installed|denied/i.test(out);
    const ok = r.ok && !bad;
    if (!ok) logErr('apps:action', action, pkg, out.slice(0, 150));
    // человечная причина отказа для системных приложений (без дампа стека на экран)
    let message = out;
    if (!ok && /cannot disable system packages/i.test(out)) {
      message = 'Отключение системного приложения на этой прошивке запрещено Android (нужны права root или adb root). Можно «Остановить» процесс или очистить данные.';
    }
    if (ok && usedFallback) {
      message = action === 'disable'
        ? 'Отключено для пользователя (системный пакет сохранён, обратимо через «Включить»)'
        : 'Восстановлено';
    }
    return { ok, message: ok ? (message === 'ok' || !message ? 'ok' : message.slice(0, 260)) : message.slice(0, 260) };
  });
  ipcMain.handle('apps:perms', async (_e, serial, pkg) => {
    const r = await adb.run(['-s', serial, 'shell', 'dumpsys', 'package', pkg], { timeout: 20000 });
    const out = [];
    for (const m of (r.stdout || '').matchAll(/^\s*([a-z][\w.]*\.permission[a-zA-Z0-9_.]*|[a-z][\w.]*\.[A-Z][\w.]*):\s*granted=(true|false)/gmi)) {
      const perm = m[1];
      if (!out.some(x => x.perm === perm)) out.push({ perm, granted: m[2] === 'true' });
    }
    return { ok: r.ok, perms: out };
  });
  ipcMain.handle('apps:perm', async (_e, serial, action, pkg, perm) => {
    const r = await adb.run(['-s', serial, 'shell', 'pm', action, pkg, perm], { timeout: 15000 });
    return { ok: r.ok, message: (r.stdout || r.stderr).trim() };
  });
  // падения/ANR конкретного приложения из crash/main буферов logcat
  ipcMain.handle('apps:crashes', async (_e, serial, pkg, opts) => crashlog.collect(serial, pkg, opts));
  // полная очистка журналов logcat на телефоне (все буферы)
  ipcMain.handle('apps:crashes-clear', async (_e, serial) => {
    if (!serial) return { ok: false, error: 'Нет устройства' };
    const r = await adb.run(['-s', serial, 'logcat', '-b', 'all', '-c'], { timeout: 15000 });
    const message = ((r.stdout || '') + ' ' + (r.stderr || '')).trim();
    return { ok: r.ok, message: message || (r.ok ? 'Журналы очищены' : 'Не удалось очистить журналы') };
  });
  ipcMain.handle('apps:audit', async (_e, serial, pkg) => appaudit.collect(serial, pkg));
  // На части устройств adbd не читает /data/app напрямую: shell видит файл,
  // а adb pull отвечает «remote object does not exist». Копируем через shell
  // в /sdcard/Download и забираем оттуда, затем удаляем временный файл.
  async function pullApkFile(serial, remote, dest) {
    const direct = await adb.run(['-s', serial, 'pull', remote, dest], { timeout: 600000 }).catch(() => null);
    if (direct && direct.ok) return direct;
    const tmp = '/sdcard/Download/.adbwc-' + Date.now() + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 8) + '.apk';
    const cp = await adb.run(['-s', serial, 'shell', 'cp', remote, tmp], { timeout: 60000 }).catch(() => null);
    if (!cp || !cp.ok) return direct || cp;
    try {
      const pulled = await adb.run(['-s', serial, 'pull', tmp, dest], { timeout: 600000 }).catch(() => null);
      if (pulled && pulled.ok) return pulled;
      return pulled || direct;
    } finally {
      await adb.run(['-s', serial, 'shell', 'rm', '-f', tmp], { timeout: 15000 }).catch(() => null);
    }
  }
  ipcMain.handle('apps:backup', async (_e, serial, pkgs) => {
    const dir = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (dir.canceled) return { ok: false, canceled: true };
    let done = 0;
    for (const pkg of pkgs) {
      const p = await adb.run(['-s', serial, 'shell', 'pm', 'path', pkg], { timeout: 15000 });
      const apk = (p.stdout.match(/package:(\S+)/) || [])[1];
      if (!apk) continue;
      const dest = path.join(dir.filePaths[0], pkg + '.apk');
      const r = await pullApkFile(serial, apk, dest);
      if (r.ok) done++;
    }
    return { ok: done > 0, done, total: pkgs.length, dir: dir.filePaths[0] };
  });
  // сохранить приложение на ПК с ИМЕНЕМ приложения (а не именем пакета)
  ipcMain.handle('apps:saveapk', async (_e, serial, pkg, label) => {
    const p = await adb.run(['-s', serial, 'shell', 'pm', 'path', pkg], { timeout: 15000 }).catch(() => null);
    const apk = ((p && p.stdout) || '').match(/package:(\S+)/);
    if (!apk) return { ok: false, error: 'APK пакета не найден на устройстве' };
    const d = await adb.run(['-s', serial, 'shell', 'dumpsys', 'package', pkg], { timeout: 15000 }).catch(() => null);
    const vn = (((d && d.stdout) || '').match(/versionName=(\S+)/) || [])[1] || '';
    const base = String(label || pkg).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || pkg;
    const def = path.join(SAVE_DIR, base + (vn ? ' ' + vn : '') + '.apk');
    const res = await dialog.showSaveDialog(win, { title: 'Сохранить приложение на ПК', defaultPath: def, filters: [{ name: 'APK', extensions: ['apk'] }] });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    const dest = /\.apk$/i.test(res.filePath) ? res.filePath : res.filePath + '.apk';
    const r = await pullApkFile(serial, apk[1], dest);
    if (!r || !r.ok) return { ok: false, error: ((r && r.stderr) || '').slice(0, 200) || 'не удалось скопировать файл' };
    return { ok: true, path: dest };
  });
  ipcMain.handle('dev:full', async (_e, serial) => {
    const g = async (args) => { const r = await adb.run(['-s', serial, 'shell', ...args], { timeout: 8000 }); return (r.stdout || '').trim(); };
    const [man, model, rel, patch, abi, build, bat, wm, df, mem, up, host] = await Promise.all([
      g(['getprop', 'ro.product.manufacturer']), g(['getprop', 'ro.product.model']),
      g(['getprop', 'ro.build.version.release']), g(['getprop', 'ro.build.version.security_patch']),
      g(['getprop', 'ro.product.cpu.abi']), g(['getprop', 'ro.build.display.id']),
      g(['dumpsys', 'battery']), g(['wm', 'size']), g(['df', '/data']),
      g(['cat', '/proc/meminfo']), g(['uptime']), g(['getprop', 'net.hostname'])
    ]);
    const level = (bat.match(/level:\s*(\d+)/) || [])[1] || '?';
    const size = (wm.match(/(\d+x\d+)/) || [])[1] || '';
    const memLine = (mem.split(/\r?\n/)[0] || '').replace(/\D+/g, ' ');
    const dfl = df.split(/\r?\n/)[1];
    let storage = null;
    if (dfl) { const p = dfl.split(/\s+/); storage = { total: p[1], used: p[2], free: p[3] }; }
    return { manufacturer: man, model, android: rel, patch, abi, build, battery: level, screen: size, storage, memTotalKb: memLine.trim().split(' ')[0] || '', uptime: up.split('\n')[0], hostname: host, serial };
  });
  // ===== инструменты экрана/системы (как в ADB AppControl) =====
  ipcMain.handle('dev:display', async (_e, serial) => {
    const g = async (a) => { const r = await adb.run(['-s', serial, 'shell', ...a], { timeout: 8000 }); return (r.stdout || '').trim(); };
    const [size, density, policy] = await Promise.all([
      g(['wm', 'size']), g(['wm', 'density']), g(['settings', 'get', 'global', 'policy_control'])
    ]);
    const physical = (size.match(/Physical size:\s*(\d+x\d+)/) || [])[1] || '';
    const override = (size.match(/Override size:\s*(\d+x\d+)/) || [])[1] || '';
    const dPhys = (density.match(/Physical density:\s*(\d+)/) || [])[1] || '';
    const dOver = (density.match(/Override density:\s*(\d+)/) || [])[1] || '';
    return { ok: true, physical, override, density: dPhys, densityOverride: dOver, immersive: /immersive\.(full|status|navigation)\s*=/i.test(policy) ? policy : '' };
  });
  ipcMain.handle('dev:display-set', async (_e, serial, op, value) => {
    const run = (a) => adb.run(['-s', serial, 'shell', ...a], { timeout: 10000 });
    if (op === 'size') {
      const v = String(value || '').trim();
      if (!/^\d+x\d+$/.test(v)) return { ok: false, error: 'Формат разрешения: 1080x2400' };
      const r = await run(['wm', 'size', v]);
      return { ok: r.ok, message: ((r.stdout || '') + (r.stderr || '')).trim() };
    }
    if (op === 'reset-size') { const r = await run(['wm', 'size', 'reset']); return { ok: r.ok, message: ((r.stdout || '') + (r.stderr || '')).trim() }; }
    if (op === 'density') {
      const v = +value;
      if (!(v >= 100 && v <= 1000)) return { ok: false, error: 'Плотность: 100–1000' };
      const r = await run(['wm', 'density', String(v)]);
      return { ok: r.ok, message: ((r.stdout || '') + (r.stderr || '')).trim() };
    }
    if (op === 'reset-density') { const r = await run(['wm', 'density', 'reset']); return { ok: r.ok, message: ((r.stdout || '') + (r.stderr || '')).trim() }; }
    return { ok: false, error: 'Неизвестная операция' };
  });
  // скрыть/показать статус-бар и навигацию (immersive) — как «Tools: StatusBar» в ADB AppControl
  ipcMain.handle('dev:statusbar', async (_e, serial, hide) => {
    const r = await adb.run(['-s', serial, 'shell', 'settings', 'put', 'global', 'policy_control', hide ? 'immersive.full=*' : 'null'], { timeout: 8000 });
    return { ok: r.ok, message: ((r.stdout || '') + (r.stderr || '')).trim() };
  });
  // скорость анимаций: 1 = обычная, 0.5 = быстрее, 0 = выключить
  ipcMain.handle('dev:animations', async (_e, serial, speed) => {
    const v = String(speed);
    const cmds = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'];
    let ok = true;
    for (const k of cmds) {
      const r = await adb.run(['-s', serial, 'shell', 'settings', 'put', 'global', k, v], { timeout: 8000 });
      if (!r.ok) ok = false;
    }
    return { ok, scale: v };
  });
  // список приложений в белом списке оптимизации батареи (не «усыпляются»)
  ipcMain.handle('dev:battery-list', async (_e, serial) => {
    const r = await adb.run(['-s', serial, 'shell', 'dumpsys', 'deviceidle', 'whitelist'], { timeout: 15000 });
    const items = (r.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(l => /^[a-z][\w.]+\.[\w.]+$/i.test(l));
    return { ok: r.ok, items: [...new Set(items)] };
  });
  ipcMain.handle('dev:battery-set', async (_e, serial, pkg, on) => {
    const r = await adb.run(['-s', serial, 'shell', 'cmd', 'deviceidle', 'whitelist', (on ? '+' : '-') + pkg], { timeout: 10000 });
    return { ok: r.ok, message: ((r.stdout || '') + (r.stderr || '')).trim() };
  });
  // ---------- пароль разблокировки устройства ----------
  ipcMain.handle('unlock:get', async (_e, serial) => {
    const { rec, pin } = await unlockRead(serial);
    const has = !!pin;
    return {
      ok: true,
      has,
      // сам пароль в интерфейс не отдаём — только маску («сохранён, N символов»)
      length: has ? String(pin).length : 0,
      type: (rec && rec.type) || 'pin',
      model: (rec && rec.model) || null,
      encrypted: !!(safeStorage && safeStorage.isEncryptionAvailable())
    };
  });
  ipcMain.handle('unlock:set', async (_e, serial, pin, type) => {
    const p = String(pin || '');
    if (!p) return { ok: false, error: 'Пустой пароль' };
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'Системное шифрование Windows недоступно — пароль не сохраняю (так безопаснее)' };
    }
    const key = await unlockStorePin(serial, p, type);
    if (!key) return { ok: false, error: 'Не удалось зашифровать пароль' };
    return { ok: true, length: p.length, type: type === 'pattern' ? 'pattern' : 'pin' };
  });
  ipcMain.handle('unlock:del', async (_e, serial) => {
    await unlockRemove(serial);
    return { ok: true, has: false };
  });
  // список сохранённых паролей и удаление по ключу (для «листа» в интерфейсе)
  ipcMain.handle('unlock:list', async () => ({ ok: true, items: unlockList() }));
  ipcMain.handle('unlock:delkey', async (_e, key) => {
    const st = unlockLoad();
    delete st[String(key || '')];
    unlockSave();
    return { ok: true, items: unlockList() };
  });
  ipcMain.handle('unlock:run', async (_e, serial, step) => {
    const r = await unlockDevice(serial, { step: step || 'full' });
    if (!r.ok) logErr('unlock', serial, r.error);
    return r;
  });

  ipcMain.handle('fs:volumes', async (_e, serial) => {
    // раньше отдавали только `ls /storage`, из-за чего SD-карта не отображалась вовсе.
    // Теперь — реальные смонтированные тома через `sm list-volumes all` + `ls /storage` как фолбэк,
    // плюс проверка root (для доступа к /data, /system).
    const [sm, ls, id] = await Promise.all([
      adb.run(['-s', serial, 'shell', 'sm', 'list-volumes', 'all'], { timeout: 10000 }).catch(() => ({ ok: false, stdout: '' })),
      adb.run(['-s', serial, 'shell', 'ls', '/storage'], { timeout: 10000 }).catch(() => ({ ok: false, stdout: '' })),
      adb.run(['-s', serial, 'shell', 'id'], { timeout: 8000 }).catch(() => ({ ok: false, stdout: '' }))
    ]);
    const mounts = [];
    const seen = new Set();
    for (const line of (sm.stdout || '').split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      // public:179,65 mounted /storage/1A2B-3C4D
      const m = t.match(/^(public|emulated|private|stub):(\S+)\s+(\w+)\s*(\/\S*)?/);
      if (!m) continue;
      const type = m[1], state = m[3], p = m[4] || '';
      if (state !== 'mounted' || !p) continue;
      if (p === '/storage/emulated' || p === '/storage/self') continue;
      if (seen.has(p)) continue;
      seen.add(p);
      mounts.push({ path: p, type, id: m[2] });
    }
    // фолбэк/дополнение: физические папки в /storage (флешки вида XXXX-XXXX).
    // sdcard/sdcard0 — это симлинки на внутреннюю память, а не отдельные SD-карты;
    // раньше они попадали в список как две «SD-карты» и путали выбор тома.
    const vols = [];
    for (const v of (ls.stdout || '').split(/\s+/).filter(Boolean)) {
      if (!/^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$/.test(v)) continue;
      vols.push(v);
      const p = '/storage/' + v;
      if (!seen.has(p)) {
        seen.add(p);
        mounts.push({ path: p, type: 'public', id: v });
      }
    }
    // SD-карта в современных Android тоже public-том; помечаем тип по расположению
    const isRoot = /\buid=0\b/.test(id.stdout || '');
    return { ok: true, vols, mounts, root: isRoot, shell: (id.stdout || '').trim() };
  });
  // ИКОНКИ БЕЗ ДИСКОВОГО КЭША. Иконка читается из APK по требованию и живёт
  // только в памяти текущей сессии (Map). На диск НИЧЕГО не пишется — папка «Кэш иконок»
  // удаляется как лишний хлам. Имена приложений — маленький текстовый файл в «Сохранениях»
  // (это не иконки; без него поиск по названиям не работал бы после перезапуска).
  const iconFail = new Set(); // ключ: serial|pkg — чтобы не тянуть заведомо битый APK повторно
  const serialTag = s => String(s || 'default').replace(/[^a-z0-9._:-]/gi, '_');
  const labelsFile = serial => path.join(SAVE_DIR, 'labels-' + serialTag(serial) + '.json');
  function labelsLoad(serial) { return loadJson(labelsFile(serial), {}); }
  function labelsSave(serial, m) { saveJson(labelsFile(serial), m); }
  const ICON_MEM = new Map(); // serialTag|pkg -> { dataUrl, label }
  const ICON_MEM_MAX = 500;
  function iconMemSet(k, v) {
    if (ICON_MEM.size >= ICON_MEM_MAX && !ICON_MEM.has(k)) ICON_MEM.delete(ICON_MEM.keys().next().value);
    ICON_MEM.set(k, v);
  }
  // имена приложений могут быть на любом языке. Собираем известные метки
  // из всех labels-*.json (старые serial/mDNS), а не только из файла текущего serial.
  function labelsAll(serial) {
    const base = labelsLoad(serial);
    try {
      for (const f of fs.readdirSync(SAVE_DIR)) {
        if (!/^labels-.*\.json$/i.test(f)) continue;
        const m = loadJson(path.join(SAVE_DIR, f), {});
        for (const k of Object.keys(m || {})) if (m[k] && !base[k]) base[k] = m[k];
      }
    } catch (e) {}
    return base;
  }
  ipcMain.handle('apps:labels', async (_e, serial) => labelsAll(serial)); // мгновенно: всё, что уже известно
  // «Очистить кэш иконок»: память сессии + старая папка на диске (если осталась)
    ipcMain.handle('icons:clear', async () => {
      ICON_MEM.clear(); iconFail.clear();
      try { fsApkFail.clear(); } catch (e) {}
      try { if (fs.existsSync(ICON_CACHE)) fs.rmSync(ICON_CACHE, { recursive: true, force: true }); } catch (e) {}
      return { ok: true };
    });
    // «Очистить кэш иконок» — теперь кэш иконок WINDOWS (Проводника),
    // чтобы значки .apk в папках обновились. Explorer НЕ перезапускаем.
    ipcMain.handle('win:cleariconcache', async () => {
      if (!process.platform.startsWith('win')) return { ok: false, error: 'Только Windows' };
      const run = (exe, args) => new Promise((res) => execFile(exe, args, { windowsHide: true, timeout: 20000 }, () => res()));
      await run('ie4uinit.exe', ['-ClearIconCache']);
      await run('ie4uinit.exe', ['-show']);
      let removed = 0;
      try {
        const icDir = path.join(app.getPath('appData'), '..', 'Local', 'Microsoft', 'Windows', 'Explorer');
        for (const f of fs.readdirSync(icDir)) {
          if (/^iconcache.*\.db$/i.test(f)) { try { fs.unlinkSync(path.join(icDir, f)); removed++; } catch (e) {} }
        }
      } catch (e) {}
      const ps =
        'Add-Type -Namespace Win32 -Name Sh4 -MemberDefinition "[DllImport(\'shell32.dll\')] public static extern void SHChangeNotify(int ev, int fl, IntPtr a, IntPtr b);"; ' +
        '[Win32.Sh4]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)';
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps]);
      return { ok: true, removed };
    });
  ipcMain.handle('apps:icon', async (_e, serial, pkg) => {
    try {
      const memKey = serialTag(serial) + '|' + pkg;
      const hit = ICON_MEM.get(memKey);
      if (hit) return { ok: !!hit.dataUrl, dataUrl: hit.dataUrl, label: hit.label, cached: true };
      const failKey = serialTag(serial) + '|' + pkg;
      if (iconFail.has(failKey)) return { ok: false, failed: true, label: labelsLoad(serial)[pkg] || null };
      const labels = labelsLoad(serial);
      const cachedLabel = labels[pkg] || null;
      const p = await adb.run(['-s', serial, 'shell', 'pm', 'path', pkg], { timeout: 10000 });
      const apkPaths = (p.stdout.match(/package:\S+/g) || []).map(x => x.slice(8)).filter(Boolean);
      if (!apkPaths.length) { iconFail.add(failKey); return { ok: false, label: cachedLabel }; }
      // у split-APK иконка часто лежит не в base.apk, а в split_config.xxhdpi.apk.
      // Сначала пробуем density-split (он меньше), затем base. Это чинит иконки Яндекс Карт,
      // Навигатора и других приложений, у которых base.apk без растровой иконки.
      const ordered = apkPaths.slice().sort((a, b) => {
        const da = /(?:xxhdpi|xhdpi|hdpi|mdpi|ldpi|dpi)/i.test(a) ? 1 : 0;
        const db = /(?:xxhdpi|xhdpi|hdpi|mdpi|ldpi|dpi)/i.test(b) ? 1 : 0;
        return db - da;
      });
      // быстрый «прямой» путь — не тянем весь APK. На телефоне unzip отдаёт
      // только выбранный файл иконки (обычно 5–50 КБ), поэтому превью появляется сразу.
      try {
        let best = null;
        for (const apk of apkPaths) {
          const list = await adb.run(['-s', serial, 'shell', 'unzip -l ' + adb.shq(apk)], { timeout: 20000 });
          for (const line of (list.stdout || '').split(/\r?\n/)) {
            const m = line.trim().match(/^(\d+)\s+\S+\s+\S+\s+(res\/(?:mipmap|drawable)[^/]*\/[^/]+\.(?:png|webp|jpe?g))$/i);
            if (!m) continue;
            const size = parseInt(m[1], 10) || 0;
            const name = m[2];
            let score = 0;
            if (/ic_launcher|app_icon|launcher_icon|appicon/i.test(name)) score += 100;
            if (/foreground|background|notification|exo_|google|splash|banner|logo_icon/i.test(name)) score -= 200;
            if (/(?:xxxhdpi|xxhdpi|xhdpi)/i.test(name)) score += 20;
            score += Math.min(20, Math.round(size / 2048));
            if (!best || score > best.score) best = { apk, name, size, score };
          }
        }
        if (best && best.score > 0) {
          const b64 = await adb.run(['-s', serial, 'shell', 'unzip -p ' + adb.shq(best.apk) + ' ' + adb.shq(best.name) + ' | base64'], { timeout: 30000 });
          const raw = (b64.stdout || '').replace(/\s+/g, '');
          if (b64.ok && raw) {
            const buf = Buffer.from(raw, 'base64');
            if (buf.length > 32) {
              const mime = /\.png$/i.test(best.name) ? 'image/png' : (/\.webp$/i.test(best.name) ? 'image/webp' : 'image/jpeg');
              const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
              iconMemSet(memKey, { dataUrl, label: cachedLabel });
              return { ok: true, dataUrl, label: cachedLabel, direct: true };
            }
          }
        }
      } catch (e) {}
      let label = cachedLabel;
      let dataUrl = null;
      for (const apk of ordered) {
        const sz = await adb.run(['-s', serial, 'shell', 'stat', '-c', '%s', adb.shq(apk)], { timeout: 10000 });
        const apkSize = parseInt(sz.stdout, 10) || 0;
        if (apkSize > 300 * 1024 * 1024) continue;
        const key = pkg.replace(/[^a-z0-9._]/gi, '_') + '-' + Math.abs(apk.split('/').pop().length);
        const tmp = path.join(os.tmpdir(), 'icon-' + serialTag(serial) + '-' + key + '.apk');
        const pr = await pullApkFile(serial, apk, tmp);
        if (!pr.ok) continue;
        let apkBuf;
        try { apkBuf = fs.readFileSync(tmp); } catch (e) { apkBuf = null; }
        try { fs.unlinkSync(tmp); } catch (e) {}
        if (!apkBuf) continue;
        let meta = null;
        try { meta = require('./apkicon.js').extractMeta(apkBuf); } catch (e) { meta = null; }
        if (!meta) continue;
        if (meta.label && !label) {
          label = meta.label;
          labels[pkg] = label; labelsSave(serial, labels);
        }
        if (meta.icon) {
          dataUrl = 'data:' + meta.icon.mime + ';base64,' + meta.icon.data.toString('base64');
          break;
        }
      }
      if (!dataUrl) {
        iconFail.add(failKey);
        iconMemSet(memKey, { dataUrl: null, label });
        return { ok: false, label };
      }
      iconMemSet(memKey, { dataUrl, label });
      return { ok: true, dataUrl, label };
    } catch (e) { iconFail.add(serialTag(serial) + '|' + pkg); return { ok: false, error: e.message }; }
  });
  // список ПОЛЬЗОВАТЕЛЬСКИХ пакетов (pm list packages -3) — чтобы на вкладке «Процессы»
  // честно отделять пользовательские приложения от системных служб (com.android.* и т.п.).
  const userPkgsCache = new Map(); // serial -> { pkgs:Set, ts }
  async function userPackages(serial) {
    const c = userPkgsCache.get(serial);
    if (c && Date.now() - c.ts < 30000) return c.pkgs;
    const pkgs = new Set();
    try {
      const r = await adb.run(['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'], { timeout: 12000 });
      if (r.ok) for (const line of (r.stdout || '').split(/\r?\n/)) {
        const m = line.trim().match(/^package:(.+)$/);
        if (m) pkgs.add(m[1].trim());
      }
    } catch (e) {}
    userPkgsCache.set(serial, { pkgs, ts: Date.now() });
    return pkgs;
  }
  // проверка «процесс действительно умер» — раньше успех определялся кодом возврата adb,
  // а am force-stop возвращает 0 даже для несуществующего пакета.
  async function procAlive(serial, pid, base) {
    let r = await adb.run(['-s', serial, 'shell', 'ps', '-A', '-o', 'PID,NAME'], { timeout: 12000 }).catch(() => null);
    let text = (r && r.ok && /PID/.test(r.stdout || '')) ? (r.stdout || '') : '';
    if (!text) {
      const plain = await adb.run(['-s', serial, 'shell', 'ps'], { timeout: 12000 }).catch(() => null);
      if (plain && plain.ok) text = plain.stdout || '';
    }
    if (!text || text.split(/\r?\n/).filter(Boolean).length < 2) return null;
    for (const line of text.split(/\r?\n/).slice(1)) {
      const t = line.trim(); if (!t) continue;
      const m = t.match(/^(\d+)\s+(\S+)/);
      const f = t.split(/\s+/);
      const p = m ? +m[1] : (+f[1] || 0);
      const n = m ? m[2] : f[f.length - 1];
      if (!p) continue;
      if (p === +pid) return true;
      if (base && (n === base || n.startsWith(base + ':'))) return true;
    }
    return false;
  }
  // нагрузка телефона — ОЗУ и загрузка CPU для вкладки «Процессы»
  ipcMain.handle('dev:stats', async (_e, serial) => {
    const r = await adb.run(['-s', serial, 'shell',
      'cat /proc/meminfo; echo ==; cat /proc/loadavg; echo ==; grep -c ^processor /proc/cpuinfo'],
      { timeout: 10000 }).catch(() => null);
    const t = (r && r.stdout) || '';
    const [memPart = '', loadPart = '', cpuPart = ''] = t.split('==');
    const mem = k => { const m = memPart.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')); return m ? parseInt(m[1], 10) * 1024 : 0; };
    const total = mem('MemTotal'), free = mem('MemFree'), available = mem('MemAvailable') || free;
    const loads = (loadPart.trim().split(/\s+/).map(x => parseFloat(x)) || []).filter(x => !isNaN(x));
    const cpu = parseInt(cpuPart.trim(), 10) || 1;
    if (!total) return { ok: false };
    return { ok: true, total, free, available, cpu, load1: loads[0] || 0, load5: loads[1] || 0, load15: loads[2] || 0 };
  });
  ipcMain.handle('procs:list', async (_e, serial) => {
    // RSS нужен для колонки памяти. ВАЖНО (): на Android 8+ NAME обрезается до 15 символов,
    // и force-stop уходил по несуществующему «com.google.and…». Поэтому сначала пробуем ARGS
    // (полная командная строка), затем NAME, затем старый формат ps -A.
    const tryPs = async (fields) => {
      const r = await adb.run(['-s', serial, 'shell', 'ps', '-A', '-o', fields], { timeout: 20000 })
        .catch(e => ({ ok: false, stdout: '', error: e.message }));
      return (r && r.ok && /PID/.test(r.stdout || '')) ? r : null;
    };
    const upSet = await userPackages(serial);
    const upArr = [...upSet];
    const isUserPkg = n => upSet.has(n) || upArr.some(p => n.startsWith(p + ':'));
    let r = await tryPs('PID,RSS,NAME,ARGS');
    let mode = 'args';
    if (!r) { r = await tryPs('PID,RSS,NAME'); mode = 'name'; }
    if (!r) {
      r = await adb.run(['-s', serial, 'shell', 'ps', '-A'], { timeout: 20000 })
        .catch(e => ({ ok: false, stdout: '', error: e.message }));
      mode = 'simple';
    }
    let lines = (r && r.stdout || '').split(/\r?\n/).filter(Boolean);
    if (!r || !r.ok || lines.length < 2) {
      const plain = await adb.run(['-s', serial, 'shell', 'ps'], { timeout: 20000 })
        .catch(e => ({ ok: false, stdout: '', error: e.message }));
      if (plain && plain.ok && (plain.stdout || '').split(/\r?\n/).filter(Boolean).length > 1) {
        r = plain;
        mode = 'simple';
        lines = (plain.stdout || '').split(/\r?\n/).filter(Boolean);
      }
    }
    const items = [];
    for (const line of lines.slice(1)) {
      const t = line.trim();
      if (mode === 'args') {
        // PID RSS NAME ARGS — NAME может быть обрезан, полное имя берём из ARGS
        const mm = t.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        if (mm) {
          const full = (mm[4] || '').trim().split(/\s+/)[0] || mm[3];
          items.push({ pid: +mm[1], rss: +mm[2] || 0, name: full || mm[3] });
        }
      } else if (mode === 'name') {
        const mm = t.match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (mm) items.push({ pid: +mm[1], rss: +mm[2] || 0, name: mm[3].trim() });
      } else {
        // USER PID PPID VSIZE RSS WCHAN ADDR S NAME (в конце, возможны пробелы)
        const mm = t.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+\S+\s+\S\s+(.+)$/);
        if (mm) items.push({ pid: +mm[2], name: mm[6].trim(), rss: +mm[5] || 0 });
      }
    }
    for (const it of items) it.user = isUserPkg(it.name);
    return { ok: r.ok, items };
  });
  ipcMain.handle('procs:kill', async (_e, serial, pid, name) => {
    // «Убить» реально закрывает приложение И ПРОВЕРЯЕТ результат.
    // `kill -9` от shell запрещён (Operation not permitted — UID 2000 не может убить чужой UID),
    // правильный способ — `am force-stop <пакет>`; для системных процессов остаётся kill.
    const pname = String(name || '').trim();
    const base = pname.split(':')[0];
    const pkgLike = /^[A-Za-z_][\w]*(\.[\w]+)+$/.test(base); // похоже на имя пакета
    if (pkgLike) {
      await adb.run(['-s', serial, 'shell', 'am', 'force-stop', base], { timeout: 15000 }).catch(() => {});
      if (await procAlive(serial, pid, base) === false) {
        return { ok: true, message: 'Приложение ' + base + ' остановлено' };
      }
      // не умерло (autostart/сервис) — мягкий am kill как второй шанс
      await adb.run(['-s', serial, 'shell', 'am', 'kill', base], { timeout: 12000 }).catch(() => {});
      if (await procAlive(serial, pid, base) === false) {
        return { ok: true, message: 'Приложение ' + base + ' остановлено' };
      }
    }
    const r = await adb.run(['-s', serial, 'shell', 'kill', '-9', String(pid)], { timeout: 12000 }).catch(e => ({ ok: false, stderr: e.message }));
    const alive = await procAlive(serial, pid, pkgLike ? base : '');
    if (alive === false) return { ok: true, message: (pkgLike ? 'Процесс ' + base : 'Процесс') + ' завершён' };
    if (alive === null) {
      // проверить не удалось — честно отдаём код возврата команды
      const out = ((r.stdout || '') + ' ' + (r.stderr || '')).trim();
      return { ok: !!r.ok, message: out || (r.ok ? 'Команда выполнена (проверка недоступна)' : 'Не удалось завершить процесс') };
    }
    logErr('procs:kill', serial, pid, base, (r.stderr || '').slice(0, 120));
    return { ok: false, message: 'Не удалось завершить: ' + (base || pid) + ' — системный процесс или защищён системой' };
  });
  ipcMain.handle('wm:setsize', async (_e, serial, v) => {
    const args = v === 'reset' ? ['wm', 'size', 'reset'] : ['wm', 'size', v];
    const r = await adb.run(['-s', serial, 'shell', ...args], { timeout: 10000 });
    return { ok: r.ok, message: (r.stdout || r.stderr).trim() };
  });

  /* ================= просмотрщик/плеер — бинарное чтение файла с телефона ================= */
  // exec-out cat — единственный быстрый способ забрать файл без диалога сохранения;
  // сырой spawn (adb.run текстовый, бинарник портит). Прогресс — в renderer событиями.
  // maxMB — отдельный лимит для текстов/PDF (8 МБ), медиа — как раньше (768 МБ).
  // ПОТОКОВОЕ ВИДЕО — локальный HTTP-сервер с поддержкой Range читает файл
  // с телефона «на лету» (tail/head), поэтому просмотр НЕ скачивает видео на диск ПК.
  let mediaSrv = null, mediaSrvPort = 0;
  function ensureMediaServer() {
    return new Promise((resolve) => {
      if (mediaSrv && mediaSrvPort) return resolve(mediaSrvPort);
      const http = require('http');
      const MIME = {
        mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
        avi: 'video/x-msvideo', mov: 'video/quicktime', ts: 'video/mp2t', '3gp': 'video/3gpp',
        mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg',
        flac: 'audio/flac', wav: 'audio/wav', wma: 'audio/x-ms-wma',
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
        webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic'
      };
      const srv = http.createServer(async (req, res) => {
        try {
          const u = new URL(req.url, 'http://127.0.0.1');
          if (u.pathname !== '/media') { res.writeHead(404); res.end(); return; }
          const serial = u.searchParams.get('serial') || '';
          const remote = u.searchParams.get('path') || '';
          if (!serial || !remote) { res.writeHead(400); res.end(); return; }
          const exe = adb.getAdbPath();
          if (!exe) { res.writeHead(503); res.end(); return; }
          const src = adb.shq(remote);
          // размер файла (toybox stat есть на Android 6+)
          const sizeOut = await new Promise((resolve) => {
            const p = require('child_process').spawn(exe, ['-s', serial, 'shell', 'stat -c %s ' + src], { windowsHide: true });
            let s = ''; p.stdout.on('data', d => s += d); p.on('error', () => resolve(0)); p.on('close', () => resolve(parseInt(s.trim(), 10) || 0));
          });
          if (!sizeOut) { res.writeHead(404); res.end(); return; }
          const ext = (remote.split('.').pop() || '').toLowerCase();
          const mime = MIME[ext] || 'application/octet-stream';
          let start = 0, end = sizeOut - 1;
          const rh = req.headers.range;
          if (rh) {
            const m = /bytes=(\d*)-(\d*)/.exec(rh);
            if (m) {
              if (m[1]) start = parseInt(m[1], 10);
              if (m[2]) end = parseInt(m[2], 10);
              if (isNaN(start)) start = 0;
              if (isNaN(end) || end >= sizeOut) end = sizeOut - 1;
              if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + sizeOut }); res.end(); return; }
            }
          }
          const len = end - start + 1;
          const head = {
            'Content-Type': mime,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(len),
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
          };
          if (rh) { head['Content-Range'] = 'bytes ' + start + '-' + end + '/' + sizeOut; res.writeHead(206, head); }
          else res.writeHead(200, head);
          if (req.method === 'HEAD') { res.end(); return; }
          const from = start + 1;
          const cmd = 'tail -c +' + from + ' ' + src;
          const p = require('child_process').spawn(exe, ['-s', serial, 'exec-out', cmd], { windowsHide: true });
          let left = len, ended = false;
          const finish = () => {
            if (ended) return;
            ended = true;
            try { res.end(); } catch (e) {}
          };
          p.stdout.on('data', chunk => {
            if (ended || left <= 0) return;
            const take = chunk.length <= left ? chunk : chunk.subarray(0, left);
            left -= take.length;
            let ok = true;
            try { ok = res.write(take); } catch (e) { ok = false; }
            if (left <= 0) {
              try { p.kill('SIGKILL'); } catch (e) {}
              finish();
            } else if (!ok) {
              try { p.stdout.pause(); } catch (e) {}
              res.once('drain', () => { try { p.stdout.resume(); } catch (e) {} });
            }
          });
          p.stdout.on('end', finish);
          p.stdout.on('error', finish);
          p.on('error', finish);
          p.on('close', finish);
          req.on('close', () => { try { p.kill('SIGKILL'); } catch (e) {} });
        } catch (e) { try { res.writeHead(500); res.end(); } catch (e2) {} }
      });
      srv.listen(0, '127.0.0.1', () => { mediaSrv = srv; mediaSrvPort = srv.address().port; resolve(mediaSrvPort); });
    });
  }
  ipcMain.handle('media:url', async (_e, serial, remote) => {
    const port = await ensureMediaServer();
    const url = 'http://127.0.0.1:' + port + '/media?serial=' + encodeURIComponent(serial) + '&path=' + encodeURIComponent(remote);
    return { ok: true, url };
  });
  app.on('before-quit', () => { try { mediaSrv && mediaSrv.close(); } catch (e) {} });
  ipcMain.handle('fs:cat', async (e, serial, remote, maxMB) => {
    const exe = adb.getAdbPath();
    if (!exe) return { ok: false, error: 'adb не найден' };
    const MAX = Math.max(1, parseInt(maxMB, 10) || 768) * 1024 * 1024;
    return await new Promise((resolve) => {
      const child = require('child_process').spawn(exe, ['-s', serial, 'exec-out', 'cat ' + adb.shq(remote)], { windowsHide: true });
      const chunks = []; let bytes = 0; let lastE = 0; let capped = false;
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (err) {} }, 300000);
      child.stdout.on('data', d => {
        bytes += d.length;
        if (bytes > MAX) { if (!capped) { capped = true; try { child.kill('SIGKILL'); } catch (err) {} } return; }
        chunks.push(d);
        if (Date.now() - lastE > 350) { lastE = Date.now(); try { e.sender.send('task:event', { kind: 'fsload-progress', file: remote, bytes }); } catch (err) {} }
      });
      child.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
      child.on('close', () => {
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        if (capped) return resolve({ ok: false, capped: true, error: 'Файл слишком большой для просмотра в окне (' + Math.round(MAX / 1048576) + ' МБ лимит) — скачайте его кнопкой «Скачать»' });
        // пустой ответ и/или «cat: <path>: No such file» — отдаём ошибку
        if (!buf.length) return resolve({ ok: false, error: 'Устройство не вернуло файл (путь существует?)' });
        resolve({ ok: true, buf, bytes });
      });
    });
  });

  /* ================= открыть файл с телефона в ПОЛЬЗОВАТЕЛЬСКОЙ программе на ПК ============ */
  // HTML — в системном браузере (триjs-анимации требуют CDN и полного JS), видео/аудио с редкими
  // кодеками — в системном плеере, PDF — в системной программе. Файл тянется во временную папку.
  ipcMain.handle('fs:open-on-pc', async (e, serial, remote) => {
    const exe = adb.getAdbPath();
    if (!exe) return { ok: false, error: 'adb не найден' };
    const tmpDir = path.join(os.tmpdir(), 'adbwifi-open');
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (err) {}
    const local = path.join(tmpDir, path.basename(remote).replace(/[\\/:*?"<>|]/g, '_'));
    sendTask({ kind: 'fsload-progress', file: remote, bytes: 0 });
    const r = await adb.run(['-s', serial, 'pull', remote, local], { timeout: 600000 });
    if (!r.ok) return { ok: false, error: 'Не удалось скачать файл: ' + ((r.stderr || r.error || '').trim().slice(0, 150) || 'ошибка') };
    const open = await shell.openPath(local);
    return open ? { ok: false, error: 'Файл скачан (' + local + '), но системная программа его не открыла: ' + open } : { ok: true, file: local };
  });

  /* ============ редактор текстовых файлов с телефона ============ */
  // 1) fs:save-text — записать отредактированный текст ОБРАТНО на телефон (b64 закодирован
  //    в renderer: utf-8 или windows-1251, как был исходный файл); push поверх того же пути.
  // 2) fs:tmp-write — сохранить байты во временную папку ПК (для HTML-превью во iframe).
  ipcMain.handle('fs:save-text', async (_e, serial, remote, b64) => {
    const exe = adb.getAdbPath();
    if (!exe) return { ok: false, error: 'adb не найден' };
    const tmp = path.join(os.tmpdir(), 'adbwifi-save-' + Date.now() + '.txt');
    try { fs.writeFileSync(tmp, Buffer.from(String(b64 || ''), 'base64')); } catch (err) { return { ok: false, error: err.message }; }
    const r = await adb.run(['-s', serial, 'push', tmp, remote], { timeout: 120000 });
    try { fs.unlinkSync(tmp); } catch (err) {}
    if (!r.ok) return { ok: false, error: 'Не удалось записать файл на телефон: ' + ((r.stderr || r.error || '').trim().slice(0, 150) || 'ошибка') };
    return { ok: true };
  });
  ipcMain.handle('fs:tmp-write', async (_e, name, b64) => {
    try {
      const tmpDir = path.join(os.tmpdir(), 'adbwifi-open');
      fs.mkdirSync(tmpDir, { recursive: true });
      const local = path.join(tmpDir, String(name || ('f' + Date.now())).replace(/[\\/:*?"<>|]/g, '_'));
      fs.writeFileSync(local, Buffer.from(String(b64 || ''), 'base64'));
      return { ok: true, path: local };
    } catch (err) { return { ok: false, error: err.message };
    }
  });

  /* ================= распаковка архива на устройстве (свойства → «Распаковать») ============ */
  // Поддержка: zip/jar (unzip на устройстве; если unzip нет — скачаем на ПК, распакуем своим
  // парсером и зальём обратно), tar/tar.gz/tgz/tar.bz2/tar.xz (tar на устройстве).
  // RAR/7z честно отклоняем: распаковщиков на Android нет.
  ipcMain.handle('fs:extract', async (e, serial, remote) => {
    const base = path.basename(remote);
    const dir = path.posix.dirname(remote.replace(/\\/g, '/'));
    const mExt = base.match(/\.(tar\.gz|tar\.bz2|tar\.xz|tgz|tbz2|zip|jar|tar)$/i);
    if (!mExt) return { ok: false, error: 'Распаковка поддерживается для ZIP/JAR/TAR(.gz/.bz2/.xz). RAR и 7z на устройстве распаковать нельзя — скачайте файл и распакуйте на компьютере.' };
    const ext = mExt[1].toLowerCase();
    const folderName = base.slice(0, base.length - mExt[0].length).replace(/[\\/:*?"<>|]/g, '_').trim() || 'archive';
    const dest = (dir === '/' ? '' : dir) + '/' + folderName;
    const q = (s) => adb.shq(s);
    const run = (args, timeout) => adb.run(['-s', serial, 'shell', args], { timeout: timeout || 600000 });
    // 1) создаём папку
    const mk = await run(`mkdir -p ${q(dest)}`, 15000);
    if (!mk.ok) return { ok: false, error: 'Не удалось создать папку ' + dest + ': ' + ((mk.stderr || '').slice(0, 120)) };
    // 2) пробуем распаковать НА УСТРОЙСТВЕ
    let cmd = null;
    if (ext === 'zip' || ext === 'jar') cmd = `unzip -o -q ${q(remote)} -d ${q(dest)} 2>/dev/null || unzip -o ${q(remote)} -d ${q(dest)} 2>/dev/null`; // -q есть не везде
    else if (ext === 'tar') cmd = `tar -xf ${q(remote)} -C ${q(dest)}`;
    else if (ext === 'tar.gz' || ext === 'tgz') cmd = `tar -zxf ${q(remote)} -C ${q(dest)} 2>/dev/null || tar -xf ${q(remote)} -C ${q(dest)}`;
    else if (ext === 'tar.bz2' || ext === 'tbz2') cmd = `tar -jxf ${q(remote)} -C ${q(dest)} 2>/dev/null || tar -xf ${q(remote)} -C ${q(dest)}`;
    else if (ext === 'tar.xz') cmd = `tar -Jxf ${q(remote)} -C ${q(dest)} 2>/dev/null || tar -xf ${q(remote)} -C ${q(dest)}`;
    sendTask({ kind: 'fs-extract-progress', file: base, stage: 'device' });
    let r = cmd ? await run(cmd, 900000) : { ok: false };
    let where = 'на устройстве';
    // 3) фолбэк: unzip отсутствует на устройстве — распаковываем НА ПК и заливаем папку
    if ((!r.ok || /not found|not recognized/i.test((r.stderr || '') + (r.stdout || ''))) && (ext === 'zip' || ext === 'jar')) {
      sendTask({ kind: 'fs-extract-progress', file: base, stage: 'pc' });
      const st = await adb.run(['-s', serial, 'shell', `stat -c %s ${q(remote)}`], { timeout: 15000 }).catch(() => null);
      const size = parseInt((st && st.stdout) || '0', 10) || 0;
      if (size > 300 * 1024 * 1024) return { ok: false, error: 'На устройстве нет unzip, а архив больше 300 МБ — скачайте его и распакуйте на компьютере.' };
      const tmpZip = path.join(os.tmpdir(), 'adbwifi-ext-' + Date.now() + '-' + base.replace(/[^\w.\-]/g, '_'));
      const pulled = await adb.run(['-s', serial, 'pull', remote, tmpZip], { timeout: 600000 });
      if (!pulled.ok) return { ok: false, error: 'Не удалось скачать архив для распаковки: ' + ((pulled.stderr || '').slice(0, 120)) };
      try {
        const buf = fs.readFileSync(tmpZip);
        const z = require('./apkicon.js').parseZip(buf);
        if (!z) throw new Error('архив повреждён или защищён паролем');
        const names = Object.keys(z.entries).filter(n => !n.endsWith('/'));
        let done = 0;
        const tmpRoot = path.join(os.tmpdir(), 'adbwifi-extd-' + Date.now());
        fs.mkdirSync(tmpRoot, { recursive: true });
        for (const n of names) {
          const data = require('./apkicon.js').zipRead(z, n);
          if (!data) continue;
          const safe = n.replace(/\\/g, '/').replace(/\.\.(\/|$)/g, '__'); // защита от ../
          const outP = path.join(tmpRoot, safe);
          fs.mkdirSync(path.dirname(outP), { recursive: true });
          fs.writeFileSync(outP, data);
          done++;
        }
        const pushed = await adb.run(['-s', serial, 'push', tmpRoot + '/.', dest + '/'], { timeout: 900000 });
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); fs.unlinkSync(tmpZip); } catch (err) {}
        if (!pushed.ok) return { ok: false, error: 'Распаковано на ПК (' + done + ' файлов), но загрузка на телефон не удалась: ' + ((pushed.stderr || '').slice(0, 120)) };
        r = { ok: true, stdout: '' };
        where = 'на компьютере (на устройстве нет unzip)';
      } catch (err) {
        try { fs.unlinkSync(tmpZip); } catch (e2) {}
        return { ok: false, error: 'Распаковка не удалась: ' + err.message };
      }
    }
    if (!r.ok) {
      const msg = ((r.stderr || r.stdout || '').trim().split('\n')[0] || '').slice(0, 160);
      await run(`rm -rf ${q(dest)}`, 30000).catch(() => {});
      return { ok: false, error: 'Распаковать не удалось' + (msg ? ': ' + msg : '') + '. Если это RAR/7z — на устройстве нет распаковщика, скачайте файл.' };
    }
    const cnt = await run(`find ${q(dest)} -type f 2>/dev/null | wc -l`, 30000);
    const files = parseInt((cnt.stdout || '0').trim(), 10) || 0;
    return { ok: true, dest, files, where };
  });

  /* ================= открыть ЛОКАЛЬНЫЙ файл системной программой ================= */
  ipcMain.handle('shell:open-path', async (_e, p) => {
    try {
      if (!p || !fs.existsSync(p)) return { ok: false, error: 'Файл не найден: ' + p };
      const err = await shell.openPath(p);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  // перезагрузка USB-порта (когда телефон завис и не виден по кабелю).
  // pnputil /restart-device требует прав администратора: если программа запущена НЕ от админа —
  // прозрачно поднимаем отдельный PowerShell через UAC, результат читаем из временного файла,
  // чтобы вернуть точную причину (отмена диалога, устройство не найдено, код pnputil).
  ipcMain.handle('usb:restart', async (_e, serial) => {
    if (!process.platform.startsWith('win')) return { ok: false, error: 'Только Windows' };
    const s = String(serial || '').trim();
    const auto = s === 'auto';
    if (!auto && !/^[0-9a-fA-F]{6,}$/.test(s)) return { ok: false, error: 'Перезагрузка USB-порта доступна только для устройства, подключённого кабелем' };
    const ps1 = [
      'param([string]$Serial, [string]$OutFile)',
      '$ErrorActionPreference = "Continue"',
      'function W($v) { try { Add-Content -Path $OutFile -Value $v -Encoding UTF8 } catch {} }',
      'if ($Serial -eq "auto") {',
      '  $ids = @(Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match "VID_2717&PID_FF48" -or $_.FriendlyName -match "ADB Interface" } | Select-Object -ExpandProperty InstanceId)',
      '} else {',
      '  $dev = Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match ("(?i)" + [regex]::Escape($Serial)) } | Select-Object -First 1',
      '  $ids = @(); if ($dev) { $ids = @($dev.InstanceId) }',
      '}',
      'if (-not $ids.Count) { W "NOTFOUND"; exit 3 }',
      'foreach ($id in $ids) {',
      '  $out = & pnputil.exe /restart-device $id 2>&1 | Out-String',
      '  W ("ID=" + $id)',
      '  if ($out.Trim()) { W ($out.Trim()) } else { W "(pnputil: без вывода)" }',
      '  W ("EXIT=" + $LASTEXITCODE)',
      '}'
    ].join("\n");
    const scriptPath = path.join(os.tmpdir(), 'adbwifi-usbrestart-' + Date.now() + '.ps1');
    const outFile = path.join(os.tmpdir(), 'adbwifi-usbrestart-' + Date.now() + '.txt');
    try { fs.writeFileSync(scriptPath, ps1, 'utf8'); } catch (e) { return { ok: false, error: 'Не удалось создать скрипт: ' + e.message }; }
    const isAdmin = (() => {
      try {
        const ps = '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';
        return require('child_process').execSync('powershell.exe -NoProfile -Noprofile -Command "' + ps + '"', { windowsHide: true, timeout: 15000, encoding: 'utf8' }).trim() === 'True';
      } catch (e) { return false; }
    })();
    let runRes;
    if (isAdmin) {
      runRes = await new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Serial', s, '-OutFile', outFile], { windowsHide: true, timeout: 120000 }, (err, out, errOut) => res({ err, out, errOut })));
    } else {
      const cmd = "try { Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','" + scriptPath + "','-Serial','" + s + "','-OutFile','" + outFile + "') -Wait -Verb RunAs -WindowStyle Hidden } catch { Add-Content -Path '" + outFile + "' -Value 'UACCANCEL' -Encoding UTF8 }";
      runRes = await new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true, timeout: 150000 }, (err, out, errOut) => res({ err, out, errOut })));
    }
    try { fs.unlinkSync(scriptPath); } catch (e) {}
    let out = '';
    try { out = fs.readFileSync(outFile, 'utf8'); } catch (e) {}
    try { fs.unlinkSync(outFile); } catch (e) {}
    if (/UACCANCEL/.test(out)) return { ok: false, error: 'Отменено — для перезагрузки USB-порта нужны права администратора (подтвердите диалог)' };
    if (/NOTFOUND/.test(out)) return { ok: false, error: 'USB-устройство телефона не найдено — проверьте кабель' };
    const ids = Array.from(out.matchAll(/ID=(.*)/g)).map((m) => m[1].trim());
    if (!ids.length) return { ok: false, error: 'USB-устройство телефона не найдено (не удалось прочитать результат)' };
    const bad = [];
    for (const m of out.matchAll(/EXIT=(-?\d+)/g)) if (m[1] !== '0') bad.push(m[1]);
    if (bad.length) {
      const lines = out.split(/\r?\n/).filter((l) => l && !/^(ID=|EXIT=)/.test(l)).join(' ');
      return { ok: false, error: 'Windows не смог перезапустить порт (код ' + bad.join(', ') + ')' + (lines ? ': ' + lines.slice(0, 220) : '') };
    }
    return { ok: true, instance: ids.join(', '), count: ids.length };
  });

  /* ================= мета APK-ФАЙЛА на телефоне (иконка/имя для файлового менеджера) === */
  // Тянем APK во временную папку (лимит 300 МБ — владельцу нужны иконки и у «тяжёлых»
  // приложений; раньше молча отказывали после 80 МБ — «приложения не отображаются»),
  // иконка APK-файла на телефоне — тоже БЕЗ диска, только память сессии.
  const fsApkFail = new Set();
  const FS_ICON_MEM = new Map(); // serial|path|size -> { dataUrl, label }
  ipcMain.handle('apk:remotemeta', async (e, serial, remotePath) => {
    try {
      const q = adb.shq(remotePath);
      const st = await adb.run(['-s', serial, 'shell', `stat -c '%s|%Y' ${q} 2>/dev/null`], { timeout: 15000 });
      const [sz, mt] = ((st.stdout || '').trim().split('|'));
      const size = parseInt(sz, 10) || 0;
      if (size > 300 * 1024 * 1024) return { ok: false, reason: 'big', size };
      // БЕЗ уведомлений и БЕЗ записей в логфайл на каждый файл
      const key = serialTag(serial) + '|' + remotePath + '|' + size;
      const hit = FS_ICON_MEM.get(key);
      if (hit) return { ok: true, ...hit, size, mtime: (parseInt(mt, 10) || 0) * 1000 };
      if (fsApkFail.has(key)) return { ok: false, reason: 'fail', size };
      const tmp = path.join(os.tmpdir(), 'icon-' + require('crypto').createHash('sha1').update(key).digest('hex').slice(0, 20) + '.apk');
      const pr = await adb.run(['-s', serial, 'pull', remotePath, tmp], { timeout: 900000 });
      if (!pr.ok) { fsApkFail.add(key); return { ok: false, reason: 'pull', size }; }
      let meta = null;
      try { meta = require('./apkicon.js').extractMeta(fs.readFileSync(tmp)); } catch (e) {}
      try { fs.unlinkSync(tmp); } catch (e) {}
      if (!meta || (!meta.icon && !meta.label)) { fsApkFail.add(key); return { ok: false, reason: 'meta', size }; }
      const dataUrl = meta.icon ? ('data:' + meta.icon.mime + ';base64,' + meta.icon.data.toString('base64')) : null;
      const packed = {
        dataUrl,
        label: meta.label || null,
        package: meta.package || null,
        versionName: meta.versionName || null,
        versionCode: meta.versionCode || null
      };
      if (FS_ICON_MEM.size >= 300 && !FS_ICON_MEM.has(key)) FS_ICON_MEM.delete(FS_ICON_MEM.keys().next().value);
      FS_ICON_MEM.set(key, packed);
      return { ok: true, ...packed, size, mtime: (parseInt(mt, 10) || 0) * 1000 };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /* ================= иконка процесса БЕЗ скачивания APK (только память сессии) ======= */
  ipcMain.handle('apps:icon-peek', async (_e, serial, pkg) => {
    try {
      const hit = ICON_MEM.get(serialTag(serial) + '|' + pkg);
      const label = labelsLoad(serial)[pkg] || null;
      return hit && hit.dataUrl ? { ok: true, dataUrl: hit.dataUrl, label: hit.label || label } : { ok: false, label };
    } catch (e) { return { ok: false }; }
  });

  /* ================= APK НА ТЕЛЕФОНЕ — установлена ли версия + «Установить на телефон» ==== */
  // Сравнение: versionName/Code УЖЕ УСТАНОВЛЕННОГО пакета (dumpsys package) против версии
  // из самого APK-файла — владелец видит, какой новее, и ставит одной кнопкой.
  ipcMain.handle('apk:installedinfo', async (_e, serial, pkg) => {
    if (!pkg) return { ok: false, error: 'пакет не указан' };
    const r = await adb.run(['-s', serial, 'shell', 'dumpsys', 'package', String(pkg)], { timeout: 20000 });
    const t = r.stdout || '';
    if (!r.ok || !t || /Not installed|No packages/i.test(t.slice(0, 400))) return { ok: true, installed: false };
    const ver = (t.match(/versionName=([\w.\-]+)/) || [])[1] || '';
    const code = (t.match(/versionCode=(\d+)/) || [])[1] || '';
    const first = (t.match(/firstInstallTime=([^\r\n]+)/) || [])[1] || '';
    return { ok: true, installed: true, versionName: ver, versionCode: code, firstInstall: first.trim() };
  });
  ipcMain.handle('apk:phoneinstall', async (e, serial, remoteApk) => {
    // APK уже лежит НА ТЕЛЕФОНЕ — скачивать не нужно: pm install -r напрямую
    const tmp = '/data/local/tmp/adbwifi-install-' + Date.now() + '.apk';
    let r = { ok: false, stdout: '', stderr: '' };
    try {
      const cp = await adb.run(['-s', serial, 'shell', `cp ${adb.shq(remoteApk)} ${adb.shq(tmp)}`], { timeout: 120000 });
      if (!cp.ok) {
        r = { ok: false, stdout: cp.stdout || '', stderr: cp.stderr || cp.error || 'Не удалось скопировать APK во временную папку' };
      } else {
        r = await adb.run(['-s', serial, 'shell', 'pm', 'install', '-r', adb.shq(tmp)], { timeout: 300000 });
      }
    } finally {
      adb.run(['-s', serial, 'shell', 'rm', '-f', adb.shq(tmp)], { timeout: 15000 }).catch(() => {});
    }
    const out = ((r.stdout || '') + '\n' + (r.stderr || '')).trim();
    const ok = r.ok && /success/i.test(r.stdout || '');
    const fail = out.match(/Failure\s*\[([^\]]+)\]/i);
    const errLine = out.match(/Error:\s*([^\n]+)/i);
    const msg = ok ? 'установлено' : (fail ? 'Failure [' + fail[1] + ']' : (errLine ? errLine[1].trim() : (out.split(/\r?\n/).pop() || 'ошибка установки')));
    if (!ok) logErr('apk:phoneinstall', serial, remoteApk, out.slice(0, 500));
    return { ok, message: msg.slice(0, 300), detail: out.slice(0, 4000) };
  });

  /* ================= мета локальных APK (иконка/имя/пакет/версия) ================= */
  // APKM/XAPK/APKS — это ZIP-контейнеры с base.apk внутри. Достаём метаданные
  // из вложенного APK; если иконка не разобралась — берём родную иконку Windows,
  // которую Проводник уже показывает для этого файла.
  function bundleApkMeta(buf) {
    try {
      const ic = require('./apkicon.js');
      const z = ic.parseZip(buf);
      if (!z) return null;
      const names = Object.keys(z.entries).filter(n => /\.apk$/i.test(n));
      names.sort((a, b) => {
        const ab = /(^|\/)base[^/]*\.apk$/i.test(a) ? 0 : 1;
        const bb = /(^|\/)base[^/]*\.apk$/i.test(b) ? 0 : 1;
        if (ab !== bb) return ab - bb;
        return (z.entries[b].csize || 0) - (z.entries[a].csize || 0);
      });
      for (const n of names.slice(0, 6)) {
        const inner = ic.zipRead(z, n);
        if (!inner || inner.length < 1024) continue;
        const m = ic.extractMeta(inner);
        if (m) return m;
      }
    } catch (e) {}
    return null;
  }
  ipcMain.handle('apk:localmeta', async (_e, filePath) => {
    try {
      if (!fs.existsSync(filePath)) return { ok: false, error: 'Файл не найден' };
      const st = fs.statSync(filePath);
      if (!st.isFile()) return { ok: false, error: 'Это не файл' };
      if (st.size > 400 * 1024 * 1024) return { ok: false, error: 'Файл больше 400 МБ — слишком большой для разбора', size: st.size };
      const ext = path.extname(filePath).toLowerCase();
      const apkLike = ext === '.apk' || ext === '.apup' || ext === '.apk+' || /\.apk\.(?:1|\+)$/i.test(filePath);
      const bundleLike = ['.xapk', '.apkm', '.apks', '.apkv'].includes(ext);
      const buf = fs.readFileSync(filePath);
      let meta = apkLike ? require('./apkicon.js').extractMeta(buf) : (bundleLike ? bundleApkMeta(buf) : null);
      if (!meta && apkLike) meta = bundleApkMeta(buf);
      let icon = meta && meta.icon ? ('data:' + meta.icon.mime + ';base64,' + meta.icon.data.toString('base64')) : null;
      if (!icon) {
        try {
          const img = await app.getFileIcon(filePath, { size: 'large' });
          if (img && !img.isEmpty()) icon = img.toDataURL();
        } catch (e) {}
      }
      return {
        ok: true, size: st.size, mtime: st.mtimeMs,
        icon,
        label: (meta && meta.label) || null,
        package: (meta && meta.package) || null,
        versionName: (meta && meta.versionName) || null,
        versionCode: (meta && meta.versionCode) || null
      };
    } catch (e2) { return { ok: false, error: e2.message }; }
  });

  /* ================= ярлык на рабочем столе с РОДНОЙ иконкой приложения ============
     Windows для всех .apk показывает иконку программы-ассоциации. Чтобы у ярлыка YouTube
     был значок YouTube, извлекаем иконку из APK → пишем .ico → создаём .lnk с этим IconLocation. */
  ipcMain.handle('apk:make-shortcut', async (_e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'Файл не найден' };
      const buf = fs.readFileSync(filePath);
      const meta = require('./apkicon.js').extractMeta(buf);
      const pkg = (meta && meta.package) || path.basename(filePath).replace(/\.(apk|apks|xapk|apkm|apk\.1|apk\+|apup|aab)$/i, '');
      const label = (meta && meta.label) || pkg;
      const iconDir = path.join(SAVE_DIR, 'Иконки ярлыков');
      let icoPath = null;
      if (meta && meta.icon && meta.icon.data && meta.icon.data.length > 32) {
        const png = meta.icon.data;
        let w = 256, h = 256;
        if (png.length > 24) { w = png.readUInt32BE(16) || 256; h = png.readUInt32BE(20) || 256; }
        // ICO с PNG-содержимым (поддерживается Windows Vista+): 6 байт ICONDIR + 16 байт записи
        const head = Buffer.alloc(22);
        head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
        head[6] = w >= 256 ? 0 : w; head[7] = h >= 256 ? 0 : h;
        head[8] = 0; head[9] = 0;
        head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
        head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
        fs.mkdirSync(iconDir, { recursive: true });
        icoPath = path.join(iconDir, pkg.replace(/[^a-z0-9._-]/gi, '_') + '.ico');
        fs.writeFileSync(icoPath, Buffer.concat([head, png]));
      }
      const desktop = path.join(os.homedir(), 'Desktop');
      const safeName = String(label + ' (' + pkg + ')').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 90);
      const lnk = path.join(desktop, safeName + '.lnk');
      const q = s => String(s).replace(/'/g, "''");
      const ps = `$W=New-Object -ComObject WScript.Shell;` +
        `$s=$W.CreateShortcut('${q(lnk)}');` +
        `$s.TargetPath='${q(filePath)}';` +
        `$s.WorkingDirectory='${q(path.dirname(filePath))}';` +
        `$s.Description='${q(label)}';` +
        (icoPath ? `$s.IconLocation='${q(icoPath)},0';` : '') +
        `$s.Save();`;
      const res = await new Promise((resolve) => {
        const ch = require('child_process').execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
          { windowsHide: true, timeout: 20000 },
          (err, so, se) => resolve({ ok: !err, err: err && err.message, out: (so || '') + (se || '') })
        );
        void ch;
      });
      if (!res.ok) return { ok: false, error: (res.err || res.out || 'не удалось создать ярлык').slice(0, 200) };
      return { ok: true, message: 'Ярлык на рабочем столе: ' + safeName + (icoPath ? ' (со значком приложения)' : ' (иконка приложения не найдена в APK)'), lnk, icon: icoPath };
    } catch (e2) { return { ok: false, error: e2.message }; }
  });

  /* ================= размеры/даты приложений для сортировки ================= */
  // один раз собираем пути APK (pm list packages -f), потом статы пачками; кэш на serial
  const appMetaCache = new Map(); // serial -> {ts, map}
  ipcMain.handle('apps:meta', async (_e, serial, pkgs) => {
    const c = appMetaCache.get(serial);
    if (c && Date.now() - c.ts < 10 * 60 * 1000) return { ok: true, meta: c.map };
    const want = new Set(Array.isArray(pkgs) ? pkgs : []);
    const paths = new Map(); // pkg -> apk path
    for (const extra of [['-3'], ['-s']]) {
      const r = await adb.run(['-s', serial, 'shell', 'pm', 'list', 'packages', '-f', ...extra], { timeout: 25000 });
      for (const line of (r.stdout || '').split(/\r?\n/)) {
        const m = line.trim().match(/^package:(\S+)=(.+)$/);
        if (m && (!want.size || want.has(m[2]))) paths.set(m[2], m[1]);
      }
    }
    const list = Array.from(paths.entries());
    const map = {};
    const CH = 40;
    for (let i = 0; i < list.length; i += CH) {
      const chunk = list.slice(i, i + CH);
      const statArgs = chunk.map(([, p]) => adb.shq(p)).join(' ');
      const st = await adb.run(['-s', serial, 'shell', "stat -c '%n|%s|%Y' " + statArgs], { timeout: 30000 }).catch(() => null);
      const t = (st && st.stdout) || '';
      for (const line of t.split(/\r?\n/)) {
        const pr = line.trim().split('|');
        if (pr.length < 3) continue;
        const pkg = Array.from(paths.entries()).find(([, p]) => p === pr[0]);
        if (!pkg) continue;
        map[pkg[0]] = { size: parseInt(pr[1], 10) || 0, mtime: (parseInt(pr[2], 10) || 0) * 1000 };
      }
    }
      appMetaCache.set(serial, { ts: Date.now(), map });
        return { ok: true, meta: map };
      });
      // РЕАЛЬНАЯ дата установки (firstInstallTime), только пользовательские приложения —
      // для сортировки «последние установленные». Кэш на 10 минут.
      const installTimesCache = new Map(); // serial -> { ts, times }
      ipcMain.handle('apps:installtimes', async (_e, serial) => {
        const c = installTimesCache.get(serial);
        if (c && Date.now() - c.ts < 10 * 60 * 1000) return { ok: true, times: c.times };
        const r = await adb.run(['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'], { timeout: 25000 });
        const pkgs = (r.stdout || '').split(/\r?\n/)
          .map(l => (l.trim().match(/^package:(\S+)$/) || [])[1]).filter(Boolean).slice(0, 400);
        const times = {};
        let idx = 0;
        const worker = async () => {
          while (idx < pkgs.length) {
            const pkg = pkgs[idx++];
            const d = await adb.run(['-s', serial, 'shell', 'dumpsys', 'package', pkg], { timeout: 15000 }).catch(() => null);
            const m = ((d && d.stdout) || '').match(/firstInstallTime=(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
            if (m) times[pkg] = Date.parse(m[1].replace(' ', 'T')) || 0;
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        installTimesCache.set(serial, { ts: Date.now(), times });
        return { ok: true, times };
      });

  /* ================= «Завершить все приложения» в процессах ================= */
  ipcMain.handle('procs:killapps', async (_e, serial, pkgs, mode) => {
    const list = [...new Set((Array.isArray(pkgs) ? pkgs : []).map(p => String(p).split(':')[0]).filter(Boolean))].slice(0, 300);
    // кнопка «Завершить все приложения» работает ПО ВКЛАДКЕ:
    //  режим all  — принудительная остановка (am force-stop) всех процессов-приложений;
    //  режим user — мягкое am kill фоновых процессов пользовательских приложений.
    const force = mode === 'all';
    let killed = 0, failed = 0;
    for (const p of list) {
      const args = force ? ['am', 'force-stop', String(p)] : ['am', 'kill', String(p)];
      const r = await adb.run(['-s', serial, 'shell', ...args], { timeout: 8000 });
      if (r.ok) killed++; else failed++;
    }
    return {
      ok: killed > 0, killed, failed, total: list.length, force,
      message: (force ? 'Принудительно остановлено' : 'Мягко завершено') + ': ' + killed +
        ' из ' + list.length + (failed ? ' (не удалось: ' + failed + ')' : '')
    };
  });

  /* ================= ЗАПУСК УСТАНОВЛЕННОГО ПРИЛОЖЕНИЯ НА ТЕЛЕФОНЕ ================= */
  ipcMain.handle('apps:run', async (_e, serial, pkg) => {
    // monkey с LAUNCHER-категорией запускает главное activity пакета — надёжно без знания имени activity
    const r = await adb.run(['-s', serial, 'shell', 'monkey', '-p', String(pkg), '-c', 'android.intent.category.LAUNCHER', '1'], { timeout: 15000 });
    const ok = r.ok && !/error|injection/i.test((r.stdout || '') + (r.stderr || ''));
    if (!ok) logErr('apps:run', pkg, ((r.stdout || '') + ' ' + (r.stderr || '')).slice(0, 150));
    return { ok, message: (r.stderr || r.stdout || '').trim().split('\n')[0] || (ok ? 'запущено' : 'не удалось запустить') };
  });

/* ================= мини-окно APK — кнопка «Закрыть» (window.close в sandbox запрещён) === */
  ipcMain.on('mini:close', () => { try { if (miniWin && !miniWin.isDestroyed()) miniWin.close(); } catch (e) {} });
  // кнопка «Открыть программу» в окошке установщика — поднимает главное окно и трей
  ipcMain.on('mini:open-main', () => {
    try {
      miniOnly = false;
      showMainWindow();
      ensureTray();
      mainShown = true;
    } catch (e) { logErr('mini:open-main', e.message); }
  });

  /* ================= собственное трей-меню (вместо системного) ================= */
  ipcMain.handle('tray:state', async () => {
    let list = [];
    try {
      const r = await adb.devices();
      list = (r.list || []).filter(d => d.state === 'device');
    } catch (e) {}
    const devices = await Promise.all(list.map(async d => {
      let model = (d.props && (d.props.model || d.props.product)) || '';
      try {
        const m = await cachedModel(d.serial);
        model = (m && (m.friendly || m.model)) || model;
      } catch (e) {}
      return { serial: d.serial, model: model || d.serial };
    }));
    return {
      ok: true,
      autoconnect: !!config.autoconnect,
      devices
    };
  });

  ipcMain.handle('tray:set-autoconnect', async (_e, value) => {
    config.autoconnect = !!value;
    saveConfig();
    if (win && !win.isDestroyed()) win.webContents.send('setting:changed', { key: 'autoconnect', value: config.autoconnect });
    return { ok: true, autoconnect: config.autoconnect };
  });

  ipcMain.on('traymenu:show', () => {
    showMainWindow();
    try { if (trayMenuWin && !trayMenuWin.isDestroyed()) trayMenuWin.hide(); } catch (e) {}
  });
  ipcMain.on('traymenu:scan', () => {
    sendMainTask({ kind: 'scan-request' });
    try { if (trayMenuWin && !trayMenuWin.isDestroyed()) trayMenuWin.hide(); } catch (e) {}
  });
  ipcMain.on('traymenu:conn', () => {
    sendMainTask({ kind: 'open-connect' });
    try { if (trayMenuWin && !trayMenuWin.isDestroyed()) trayMenuWin.hide(); } catch (e) {}
  });
  ipcMain.on('traymenu:sett', () => {
    sendMainTask({ kind: 'open-settings' });
    try { if (trayMenuWin && !trayMenuWin.isDestroyed()) trayMenuWin.hide(); } catch (e) {}
  });
  ipcMain.on('traymenu:exit', () => {
    quitting = true;
    // сначала мгновенно убираем окна и иконку из трея, чтобы «Выход»
    // срабатывал без видимой задержки. Очистка adb/дочерних процессов идёт уже после.
    try { if (trayMenuWin && !trayMenuWin.isDestroyed()) trayMenuWin.hide(); } catch (e) {}
    try { if (tray) { tray.destroy(); tray = null; } } catch (e) {}
    try { if (win && !win.isDestroyed()) win.hide(); } catch (e) {}
    try { if (playerWin && !playerWin.isDestroyed()) playerWin.hide(); } catch (e) {}
    try { if (miniWin && !miniWin.isDestroyed()) miniWin.hide(); } catch (e) {}
    setTimeout(() => app.quit(), 0);
  });

  /* ================= КАТЕГОРИИ ФАЙЛОВ (все фото/музыка/видео/документы устройства) ======= */
  // Виртуальная «папка»: find по внутренней памяти собирает файлы данной категории со ВСЕХ
  // папок (как требуется: «нажму фотографии — покажет все изображения со всего телефона»).
  const CAT_KINDS = {
    photo: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'dng'],
    music: ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'wma', 'mid', 'midi', 'amr'],
    video: ['mp4', 'mkv', 'webm', 'avi', 'mov', '3gp', 'm4v', 'ts', 'wmv', 'flv', 'mpg', 'mpeg'],
    docs: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'txt', 'md', 'csv', 'epub', 'fb2', 'vcf']
  };
  // /sdcard — СИМЛИНК на /storage/emulated/0. toybox find БЕЗ -H его не обходит,
  // поэтому категории («Все фото», «Вся музыка»…) раньше всегда были пустыми.
  // Теперь ищем с -H и по всем реальным хранилищам (внутренняя память + SD-карта).
  async function fsCatRoots(serial) {
    const roots = [];
    try {
      const r = await adb.run(['-s', serial, 'shell', 'ls /storage'], { timeout: 10000 });
      for (const line of (r.stdout || '').split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        if (t === 'emulated') { if (!roots.includes('/storage/emulated/0')) roots.push('/storage/emulated/0'); continue; }
        if (t === 'self' || t === 'sdcard0' || t === 'sdcard') continue;
        if (!/^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$/.test(t)) continue;
        const p = '/storage/' + t;
        if (!roots.includes(p)) roots.push(p);
      }
    } catch (e) {}
    if (!roots.length) roots.push('/storage/emulated/0');
    return roots;
  }
  ipcMain.handle('fs:search', async (_e, serial, kind, roots) => {
    const exts = CAT_KINDS[kind];
    if (!exts) return { ok: false, error: 'Неизвестная категория' };
    const rootsList = (Array.isArray(roots) && roots.length ? roots : await fsCatRoots(serial)).slice(0, 6);
    const items = [];
    const seen = new Set();
    let truncated = false;
    for (const root of rootsList) {
      const pat = exts.map(e => '-iname "*.' + e + '"').join(' -o ');
      // -H: обходить симлинк /sdcard. 2>/dev/null: недоступные каталоги — норма, пропускаем.
      const r = await adb.run(['-s', serial, 'shell', `find -H ${adb.shq(root)} -type f \\( ${pat} \\) 2>/dev/null | head -n 4001`], { timeout: 60000 });
      for (const line of (r.stdout || '').split(/\r?\n/)) {
        const p = line.trim();
        if (!p || p.length < 2 || seen.has(p)) continue;
        seen.add(p);
        if (items.length < 4000) {
          const name = p.split('/').pop();
          items.push({ path: p, name, dir: false, size: 0, date: '' });
        }
        if (seen.size > 4000) { truncated = true; break; }
      }
      if (truncated) break;
    }
    let total = seen.size;
    if (truncated) {
      let exact = 0, countOk = true;
      for (const root of rootsList) {
        try {
          const pat = exts.map(e => '-iname "*.' + e + '"').join(' -o ');
          const cr = await adb.run(['-s', serial, 'shell', `find -H ${adb.shq(root)} -type f \\( ${pat} \\) 2>/dev/null | wc -l`], { timeout: 60000 });
          const m = String(cr.stdout || '').trim().match(/(\d+)\s*$/);
          if (m) exact += Number(m[1]); else countOk = false;
        } catch (e) { countOk = false; }
      }
      if (countOk) total = exact;
    }
    return { ok: true, items, total, kind, roots: rootsList };
  });
  // Количество файлов каждой категории — для подписей на кнопках «Все фото» и т.д.
  // Считаем на телефоне (find | wc -l), не тянем сами пути: иначе это были бы мегабайты.
  ipcMain.handle('fs:counts', async (_e, serial) => {
    const rootsList = (await fsCatRoots(serial)).slice(0, 6);
    const counts = {};
    const extToKind = new Map();
    for (const kind of Object.keys(CAT_KINDS)) {
      counts[kind] = 0;
      for (const e of CAT_KINDS[kind]) extToKind.set(String(e).toLowerCase(), kind);
    }
    const pat = [...extToKind.keys()].map(e => '-iname "*.' + e + '"').join(' -o ');
    const seen = new Set();
    for (const root of rootsList) {
      try {
      const r = await adb.run(['-s', serial, 'shell', `find -H ${adb.shq(root)} -type f \\( ${pat} \\) 2>/dev/null | head -n 4001`], { timeout: 60000 });
        for (const line of (r.stdout || '').split(/\r?\n/)) {
          const p = line.trim();
          if (!p || seen.has(p)) continue;
          const m = p.match(/\.([A-Za-z0-9]+)$/);
          if (!m) continue;
          const kind = extToKind.get(m[1].toLowerCase());
          if (!kind) continue;
          seen.add(p);
          counts[kind]++;
        }
      } catch (e) {}
    }
    return { ok: true, counts, roots: rootsList };
  });

  /* ================= СОЗДАНИЕ ZIP-АРХИВА НА УСТРОЙСТВЕ (из файлов/папок) ================= */
  // Сжимаем НА ПК (zlib) — на телефоне нет zip-создавалки. Файлы тянутся во временную папку,
  // пакуются и заливаются обратно. Лимит 500 МБ / 4000 файлов — честная ошибка сверх.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function dosDateTime(d) {
    const dt = d || new Date();
    const time = ((dt.getHours() & 31) << 11) | ((dt.getMinutes() & 63) << 5) | ((Math.floor(dt.getSeconds() / 2)) & 31);
    const date = (((dt.getFullYear() - 1980) & 127) << 9) | (((dt.getMonth() + 1) & 15) << 5) | (dt.getDate() & 31);
    return { time, date };
  }
  function makeZip(entries) {
    // entries: [{name, data}] → Buffer (deflate; если сжатие не помогает — store)
    const locals = []; const centrals = []; let offset = 0;
    for (const ent of entries) {
      const nameB = Buffer.from(ent.name.replace(/\\/g, '/'), 'utf8');
      const crc = crc32(ent.data);
      let method = 8, comp = null;
      try { comp = zlib.deflateRawSync(ent.data, { level: 6 }); } catch (e) { comp = null; }
      if (!comp || comp.length >= ent.data.length) { method = 0; comp = ent.data; }
      const { time, date } = dosDateTime();
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
      lh.writeUInt16LE(method, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
      lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(ent.data.length, 22);
      lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
      locals.push(lh, nameB, comp);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0, 8); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14);
      ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(ent.data.length, 24);
      ch.writeUInt16LE(nameB.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
      ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
      centrals.push(ch, nameB);
      offset += 30 + nameB.length + comp.length;
    }
    const centralBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...locals, centralBuf, eocd]);
  }
  ipcMain.handle('fs:zipcreate', async (e, serial, paths, destZip) => {
    const send = (stage, msg, done, total) => { try { e.sender.send('task:event', { kind: 'fs-zip', stage, msg, done, total }); } catch (err) {} };
    try {
      const list = (Array.isArray(paths) ? paths : []).slice(0, 50);
      if (!list.length) return { ok: false, error: 'Ничего не выбрано' };
      const tmpDir = path.join(os.tmpdir(), 'adbwifi-zip-' + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });
      const entries = [];
      let totalBytes = 0, filesCount = 0;
      // собираем список файлов
      for (const p of list) {
        const st = await adb.run(['-s', serial, 'shell', `stat -c '%F' ${adb.shq(p)}`], { timeout: 15000 });
        const isDir = /directory/i.test(st.stdout || '');
        if (!isDir) {
          entries.push({ remote: p, arcName: path.posix.basename(p.replace(/\\/g, '/')) });
          filesCount++;
        } else {
          const baseName = path.posix.basename(p.replace(/\/+/, ''));
          const r = await adb.run(['-s', serial, 'shell', `find ${adb.shq(p)} -type f 2>/dev/null | head -n 4000`], { timeout: 60000 });
          for (const line of (r.stdout || '').split(/\r?\n/)) {
            const f = line.trim();
            if (!f) continue;
            const rel = f.startsWith(p) ? f.slice(p.length).replace(/^\/+/, '') : path.posix.basename(f);
            entries.push({ remote: f, arcName: baseName + '/' + rel.replace(/\\/g, '/') });
            filesCount++;
            if (filesCount > 4000) break;
          }
        }
        if (filesCount > 4000) break;
      }
      if (!entries.length) return { ok: false, error: 'В выбранных папках не нашлось файлов' };
      // тянем и пакуем
      const zipEntries = [];
      let done = 0;
      for (const ent of entries) {
        if (totalBytes > 500 * 1024 * 1024) { send('err', 'Лимит 500 МБ — архивные файлы сверх не включены', done, entries.length); break; }
        send('run', path.posix.basename(ent.arcName), done, entries.length);
        const tmp = path.join(tmpDir, 'f' + done);
        const pr = await adb.run(['-s', serial, 'pull', ent.remote, tmp], { timeout: 300000 });
        if (!pr.ok) { done++; continue; }
        try {
          const data = fs.readFileSync(tmp);
          totalBytes += data.length;
          zipEntries.push({ name: ent.arcName, data });
        } catch (err) {}
        try { fs.unlinkSync(tmp); } catch (err) {}
        done++;
      }
      send('pack', 'Собираю архив…', zipEntries.length, entries.length);
      if (!zipEntries.length) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (err) {} return { ok: false, error: 'Ни один файл не удалось прочитать' }; }
      const zipBuf = makeZip(zipEntries);
      const tmpZip = path.join(tmpDir, 'out.zip');
      fs.writeFileSync(tmpZip, zipBuf);
      send('push', 'Загружаю архив на устройство…', 1, 1);
      const dest = String(destZip || '').replace(/\/+$/, '');
      const push = await adb.run(['-s', serial, 'push', tmpZip, dest], { timeout: 600000 });
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (err) {}
      if (!push.ok) return { ok: false, error: 'Архив собран (' + zipEntries.length + ' файлов), но не записан: ' + ((push.stderr || '').slice(0, 120)) };
      return { ok: true, files: zipEntries.length, bytes: zipBuf.length, dest };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  /* ================= ПРОСМОТР АРХИВА БЕЗ РАСПАКОВКИ (как в Проводнике) ================= */
  let zipBrowseCache = null; // { key, z } — один активный архив в памяти (LRU-1)
  async function zipForRead(serial, remote, capMB) {
    const cap = Math.max(1, parseInt(capMB, 10) || 200) * 1024 * 1024;
    const st = await adb.run(['-s', serial, 'shell', `stat -c '%s|%Y' ${adb.shq(remote)}`], { timeout: 15000 });
    const [szs, mts] = ((st.stdout || '').trim().split('|'));
    const size = parseInt(szs, 10) || 0;
    const key = remote + '|' + size + '|' + (mts || '');
    if (zipBrowseCache && zipBrowseCache.key === key) return { ok: true, z: zipBrowseCache.z, size };
    if (size > cap) return { ok: false, error: 'Архив больше ' + Math.round(cap / 1048576) + ' МБ — скачайте его кнопкой «Скачать»' };
    const tmp = path.join(os.tmpdir(), 'adbwifi-arcview-' + Date.now() + path.posix.basename(remote).replace(/[^\w.\-]/g, '_'));
    const pr = await adb.run(['-s', serial, 'pull', remote, tmp], { timeout: 600000 });
    if (!pr.ok) return { ok: false, error: 'Не удалось скачать архив: ' + ((pr.stderr || '').slice(0, 120)) };
    try {
      const buf = fs.readFileSync(tmp);
      const z = require('./apkicon.js').parseZip(buf);
      try { fs.unlinkSync(tmp); } catch (err) {}
      if (!z) return { ok: false, error: 'Архив повреждён или это не ZIP/JAR' };
      zipBrowseCache = { key, z };
      return { ok: true, z, size };
    } catch (err) { try { fs.unlinkSync(tmp); } catch (e2) {} return { ok: false, error: err.message }; }
  }
  ipcMain.handle('fs:ziplist', async (_e, serial, remote) => {
    const r = await zipForRead(serial, remote, 200);
    if (!r.ok) return r;
    const z = r.z; const out = [];
    for (const name of Object.keys(z.entries)) {
      const en = z.entries[name];
      // usize берём из central directory (off+24) — дочитывать данные не нужно
      let usize = 0;
      try { usize = z.buf.readUInt32LE(en.lh >= 0 ? 0 : 0); } catch (e) {}
      out.push({ name, dir: name.endsWith('/'), csize: en.csize || 0, usize });
    }
    // точные размеры: центральный каталог пройдёмся одним циклом
    try {
      let eocd = -1;
      const b = z.buf;
      for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) { if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
      if (eocd >= 0) {
        const count = b.readUInt16LE(eocd + 10);
        let off = b.readUInt32LE(eocd + 16);
        const sizeByName = {};
        for (let i = 0; i < count; i++) {
          if (b.readUInt32LE(off) !== 0x02014b50) break;
          const nlen = b.readUInt16LE(off + 28);
          const name = b.slice(off + 46, off + 46 + nlen).toString('utf8');
          sizeByName[name] = { usize: b.readUInt32LE(off + 24), method: b.readUInt16LE(off + 10) };
          off += 46 + nlen + b.readUInt16LE(off + 30) + b.readUInt16LE(off + 32);
        }
        for (const it of out) { const s = sizeByName[it.name]; if (s) { it.usize = s.usize; } }
      }
    } catch (e) {}
    out.sort((a, b2) => (a.dir === b2.dir ? a.name.localeCompare(b2.name) : a.dir ? -1 : 1));
    return { ok: true, entries: out, size: r.size };
  });
  ipcMain.handle('fs:zipread', async (_e, serial, remote, entryName) => {
    const r = await zipForRead(serial, remote, 200);
    if (!r.ok) return r;
    const data = require('./apkicon.js').zipRead(r.z, String(entryName));
    if (!data) return { ok: false, error: 'Не удалось прочитать файл из архива (метод сжатия не поддержан)' };
    return { ok: true, buf: data, bytes: data.length };
  });

  /* ================= ПРОСМОТР DOCX (текст документа прямо в программе) ================= */
  function xmlDecode(s) {
    return String(s || '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
  }
  function docxToHtml(buf) {
    const z = require('./apkicon.js').parseZip(buf);
    if (!z) return null;
    const doc = require('./apkicon.js').zipRead(z, 'word/document.xml');
    if (!doc) return null;
    const xml = doc.toString('utf8');
    const body = (xml.match(/<w:body[^>]*>[\s\S]*<\/w:body>/) || [xml])[0];
    // разбираем body ПОСЛЕДОВАТЕЛЬНО (таблицы и абзацы в порядке документа) —
    // прежний вариант через маркеры терял таблицы, стоявшие между абзацами
    const renderTable = (tbl) => {
      const rows = [];
      for (const trM of tbl.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)) {
        const cells = [];
        for (const tcM of trM[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)) {
          const texts = [];
          for (const tM of tcM[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)) texts.push(xmlDecode(tM[1]));
          cells.push('<td>' + texts.join('') + '</td>');
        }
        rows.push('<tr>' + cells.join('') + '</tr>');
      }
      return '<table class="docx-tbl">' + rows.join('') + '</table>';
    };
    const renderPara = (p) => {
      const runs = [];
      for (const rM of p.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)) {
        const r = rM[0];
        let t = '';
        for (const tM of r.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)) t += xmlDecode(tM[1]);
        if (/<w:tab\b/.test(r)) t += '\t';
        if (/<w:br\b/.test(r)) t += '\n';
        if (!t) continue;
        const bold = /<w:b\b/.test(r) && !/w:val="0"/.test(r);
        const ital = /<w:i\b/.test(r) && !/w:val="0"/.test(r);
        const und = /<w:u\b/.test(r) && !/w:val="none"/.test(r);
        let html = esc2(t);
        if (bold) html = '<b>' + html + '</b>';
        if (ital) html = '<i>' + html + '</i>';
        if (und) html = '<u>' + html + '</u>';
        runs.push(html);
      }
      if (!runs.length) return '';
      const text = runs.join('');
      const hm = p.match(/<w:pStyle w:val="Heading(\d)"/i);
      if (/<w:numPr>/.test(p)) return '<div class="docx-li">•&nbsp; ' + text + '</div>';
      if (hm) { const lv = Math.min(4, +hm[1] + 1); return '<h' + lv + '>' + text + '</h' + lv + '>'; }
      return '<p>' + text + '</p>';
    };
    const segRe = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g;
    const out = [];
    let mm;
    while ((mm = segRe.exec(body))) {
      out.push(mm[0].startsWith('<w:tbl') ? renderTable(mm[0]) : renderPara(mm[0]));
    }
    const html = out.join('\n');
    return html || '<p class="muted">(документ без текста)</p>';
  }
  function esc2(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  ipcMain.handle('fs:docx', async (_e, serial, remote) => {
    try {
      const st = await adb.run(['-s', serial, 'shell', `stat -c %s ${adb.shq(remote)}`], { timeout: 15000 });
      const size = parseInt((st.stdout || '0').trim(), 10) || 0;
      if (size > 40 * 1024 * 1024) return { ok: false, error: 'DOCX больше 40 МБ — откройте на компьютере' };
      const tmp = path.join(os.tmpdir(), 'adbwifi-docx-' + Date.now() + '.docx');
      const pr = await adb.run(['-s', serial, 'pull', remote, tmp], { timeout: 120000 });
      if (!pr.ok) return { ok: false, error: 'Не удалось скачать файл: ' + ((pr.stderr || '').slice(0, 120)) };
      const html = docxToHtml(fs.readFileSync(tmp));
      try { fs.unlinkSync(tmp); } catch (err) {}
      if (html == null) return { ok: false, error: 'Это не DOCX (внутри нет word/document.xml)' };
      return { ok: true, html };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  /* ================= ИНСТРУМЕНТЫ USB/OTG-НАКОПИТЕЛЯ (формат, метка, ошибки, фейк-память) ==== */
  const usbTest = { running: false, cancel: false };
  function usbVolId(vol) { return String(vol || '').trim(); }
  async function smVolumes(serial) {
    const r = await adb.run(['-s', serial, 'shell', 'sm list-volumes all'], { timeout: 15000 });
    return (r.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  }
  async function usbMountInfo(serial, vol) {
    // mounts: /dev/block/vold/public:179,65 /storage/1A2B-3C4D vfat ...
    const r = await adb.run(['-s', serial, 'shell', 'cat /proc/mounts'], { timeout: 15000 });
    const lines = (r.stdout || '').split(/\r?\n/);
    for (const l of lines) {
      const p = l.split(/\s+/);
      if (p.length >= 3 && p[1] === '/storage/' + vol) return { dev: p[0], mount: p[1], fstype: p[2], opts: p.slice(3).join(' ') };
    }
    return null;
  }
  ipcMain.handle('usb:info', async (_e, serial, vol) => {
    vol = usbVolId(vol);
    const out = { ok: true, vol };
    try {
      const m = await usbMountInfo(serial, vol);
      if (m) { Object.assign(out, m); out.mounted = true; } else out.mounted = false;
      const vols = await smVolumes(serial);
      const line = vols.find(l => l.includes(vol)) || vols.find(l => l.startsWith('public:') && l.includes('mounted'));
      out.smLine = line || '';
      if (m) {
        const df = await adb.run(['-s', serial, 'shell', `df ${adb.shq(m.mount)}`], { timeout: 15000 });
        const dfl = (df.stdout || '').split(/\r?\n/)[1];
        if (dfl) { const p = dfl.split(/\s+/); out.total = p[1]; out.used = p[2]; out.free = p[3]; out.totalBytes = (parseInt(p[1], 10) || 0) * 1024; }
        const lbl = await adb.run(['-s', serial, 'shell', `ls ${adb.shq('/storage')}`], { timeout: 8000 });
        void lbl;
      }
      out.smVolumes = vols;
    } catch (err) { return { ok: false, error: err.message }; }
    return out;
  });
  ipcMain.handle('usb:format', async (_e, serial, vol, label) => {
    vol = usbVolId(vol);
    const warnings = [];
    try {
      // 1) стандартный путь Android: sm format <vol-id> (том перезаписывается заводской ФС)
      const vols = await smVolumes(serial);
      let target = vols.find(l => l.includes(vol) && /public|private/.test(l));
      let id = target ? target.split(/\s+/)[0] : null;
      if (!id) {
        // id вида public:179,65 иногда надо собрать из disk: `sm list-disks` → adoptable; пробуем public:<vol>
        id = 'public:' + vol;
        warnings.push('том в sm list-volumes не найден, пробую public:' + vol);
      }
      let r = await adb.run(['-s', serial, 'shell', 'sm format ' + id], { timeout: 120000 });
      if (!r.ok && /unknown|usage/i.test((r.stderr || '') + (r.stdout || ''))) {
        r = await adb.run(['-s', serial, 'shell', 'sm format ' + vol], { timeout: 120000 });
      }
      if (r.ok) {
        // 2) метка: newfs_msdos -L (есть не на всех устройствах; форматирование уже сделано sm)
        if (label) {
          const m = await usbMountInfo(serial, vol);
          const dev = m && m.dev;
          if (dev) {
            const nf = await adb.run(['-s', serial, 'shell', `newfs_msdos -F 32 -L ${adb.shq(label)} ${adb.shq(dev)}`], { timeout: 120000 });
            if (!nf.ok) warnings.push('метку задать не удалось (newfs_msdos отсутствует): ' + ((nf.stderr || '').trim().split('\n')[0] || '').slice(0, 100));
          } else warnings.push('устройство не найдено в /proc/mounts — метку задать не удалось');
        }
        return { ok: true, message: 'Форматирование выполнено (sm format)' + (label ? ', метка: ' + label : ''), warnings };
      }
      return { ok: false, error: 'sm format не сработал: ' + ((r.stderr || r.stdout || '').trim().split('\n')[0] || 'ошибка').slice(0, 140), warnings };
    } catch (err) { return { ok: false, error: err.message, warnings }; }
  });
  ipcMain.handle('usb:label', async (_e, serial, vol, label) => {
    vol = usbVolId(vol);
    try {
      const m = await usbMountInfo(serial, vol);
      if (!m) return { ok: false, error: 'Флешка не смонтирована' };
      const nf = await adb.run(['-s', serial, 'shell', `newfs_msdos -F 32 -L ${adb.shq(label)} ${adb.shq(m.dev)}`], { timeout: 120000 });
      if (nf.ok) return { ok: true, message: 'Метка изменена на «' + label + '» (ФС пересоздана)' };
      return { ok: false, error: 'Смена метки требует пересоздания ФС, а newfs_msdos на устройстве нет: ' + ((nf.stderr || '').trim().split('\n')[0] || '').slice(0, 120) };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('usb:check', async (_e, serial, vol) => {
    vol = usbVolId(vol);
    const tried = [];
    try {
      const m = await usbMountInfo(serial, vol);
      if (!m) return { ok: false, error: 'Флешка не смонтирована' };
      const bins = [['fsck_msdos', ['-y']], ['fsck.fat', ['-a', '-w']], ['dosfsck', ['-a']], ['fsck.exfat', ['-y']]];
      for (const [b, args] of bins) {
        const r = await adb.run(['-s', serial, 'shell', `command -v ${b} >/dev/null 2>&1 && echo YES`], { timeout: 10000 });
        if (!/YES/.test(r.stdout || '')) continue;
        tried.push(b);
        const f = await adb.run(['-s', serial, 'shell', [b, ...args, adb.shq(m.dev)].join(' ')], { timeout: 300000 });
        return { ok: true, tool: b, message: ((f.stdout || '') + (f.stderr || '')).trim().slice(0, 600) || (b + ' завершился') };
      }
      // фолбэк: перемонтирование — лечит «ФС повреждена» после кэширования/резкого выдёргивания
      const vols = await smVolumes(serial);
      const id = (vols.find(l => l.includes(vol)) || '').split(/\s+/)[0];
      if (id) {
        await adb.run(['-s', serial, 'shell', 'sm unmount ' + id], { timeout: 60000 });
        await new Promise(r2 => setTimeout(r2, 1500));
        const rm = await adb.run(['-s', serial, 'shell', 'sm mount ' + id], { timeout: 60000 });
        if (rm.ok) return { ok: true, tool: 'remount', message: 'Проверяющих утилит (fsck) на устройстве нет — том ПЕРЕМОНТИРОВАН. Если ошибки остались, переставьте флешку.' };
      }
      return { ok: false, error: 'На устройстве нет fsck-утилит и перемонтирование не удалось' };
    } catch (err) { return { ok: false, error: err.message, tried }; }
  });
  ipcMain.handle('usb:eject', async (_e, serial, vol) => {
    const vols = await smVolumes(serial);
    const id = (vols.find(l => l.includes(usbVolId(vol))) || '').split(/\s+/)[0];
    if (!id) return { ok: false, error: 'Том не найден в sm list-volumes' };
    const r = await adb.run(['-s', serial, 'shell', 'sm unmount ' + id], { timeout: 60000 });
    return { ok: r.ok, message: r.ok ? 'Флешка безопасно извлечена' : ((r.stderr || r.stdout || '').trim().slice(0, 120)) };
  });
  // Проверка на ФЕЙКОВУЮ ПАМЯТЬ (H2testw-метод, без root):
  //  фаза W — последовательная заливка файлами-блоками с маркером номера блока;
  //  фаза R — чтение ПЕРВЫХ байт каждого блока: у фейка запись «заворачивается» на начало,
  //  поэтому в ранних блоках оказываются НОМЕРА ПОЗДНИХ блоков — это и есть доказательство.
  // Реальный объём ≈ последний корректно прочитанный блок.
  ipcMain.handle('usb:faketest-start', async (e, serial, vol, blockMB) => {
    if (usbTest.running) return { ok: false, error: 'Проверка уже идёт' };
    const m = await usbMountInfo(serial, vol);
    if (!m) return { ok: false, error: 'Флешка не смонтирована' };
    const blk = Math.max(16, Math.min(512, parseInt(blockMB, 10) || 64));
    usbTest.running = true; usbTest.cancel = false;
    const send = (obj) => { try { e.sender.send('task:event', Object.assign({ kind: 'usb-faketest' }, obj)); } catch (err) {} };
    (async () => {
      const mount = m.mount;
      const dir = mount + '/ADB-FAKETEST-' + Date.now();
      const count4M = Math.round(blk / 4);
      const maxBlocks = 4096;
      let written = 0;
      try {
        await adb.run(['-s', serial, 'shell', 'mkdir -p ' + adb.shq(dir)], { timeout: 20000 });
        send({ stage: 'write', blk, dir });
        // фаза записи
        for (let i = 0; i < maxBlocks; i++) {
          if (usbTest.cancel) { send({ stage: 'canceled', written }); break; }
          const f = dir + '/p' + String(i).padStart(4, '0');
          const marker = 'ADBFAKE-' + String(i).padStart(9, '0') + '-HDR';
          const w = await adb.run(['-s', serial, 'shell',
            `printf '${marker}' > ${adb.shq(f)} && dd if=/dev/zero bs=4M count=${count4M} >> ${adb.shq(f)} 2>/dev/null`],
            { timeout: 300000 });
          if (!w.ok) {
            // ENOSPC/ошибка записи — конец реального объёма
            send({ stage: 'wfail', at: i, written });
            break;
          }
          written = i + 1;
          send({ stage: 'write-progress', done: written, blockBytes: blk * 1024 * 1024 });
          if (written >= maxBlocks) break;
        }
        // фаза чтения заголовков
        let realBlocks = 0, wrappedAt = -1;
        send({ stage: 'verify', written });
        for (let i = 0; i < written; i++) {
          if (usbTest.cancel) { send({ stage: 'canceled', written }); break; }
          const f = dir + '/p' + String(i).padStart(4, '0');
          const rd = await adb.run(['-s', serial, 'shell', `tail -c +1 ${adb.shq(f)} | dd bs=1 count=32 2>/dev/null`], { timeout: 60000 });
          const head = (rd.stdout || '').trim();
          const want = 'ADBFAKE-' + String(i).padStart(9, '0') + '-HDR';
          if (head !== want) {
            // прочитался ДРУГОЙ блок → память «завернулась» до этого места
            wrappedAt = i;
            break;
          }
          realBlocks = i + 1;
          send({ stage: 'verify-progress', done: realBlocks, total: written });
        }
        const realBytes = realBlocks * blk * 1024 * 1024;
        send({ stage: 'done', realBytes, writtenBlocks: written, wrappedAt, blk, canceled: usbTest.cancel });
      } catch (err) {
        send({ stage: 'error', error: err.message });
      } finally {
        try { await adb.run(['-s', serial, 'shell', 'rm -rf ' + adb.shq(dir)], { timeout: 120000 }); } catch (err) {}
        usbTest.running = false;
      }
    })();
    return { ok: true, blk };
  });
  ipcMain.handle('usb:faketest-cancel', async () => { usbTest.cancel = true; return { ok: true }; });


  /* ================= ассоциации файлов APK на уровне системы =================
     владелец жаловался «ассоциация не работает, должна мгновенно примениться».
     Причины: (1) Проводник не перечитывает ассоциации, пока не скажешь ему SHCNE_ASSOCCHANGED
     и не сбросишь кэш иконок (ie4uinit); (2) если у расширения есть UserChoice
     (Explorer\FileExts\<ext>\UserChoice — «всегда открывать этим»), Windows использует ЕГО,
     а не наш ProgID — UserChoice мы вправе снять, владелец сам включил тумблер. */
  const ASSOC_EXTS = ['apk', 'aab', 'apks', 'xapk', 'apkm', 'obb', 'apup'];
  const ASSOC_PROGID = 'AdbWifiConnectorRu.APKFile';
  function assocRegArgs(on, exe) {
    const key = 'HKCU\\Software\\Classes\\';
    // DefaultIcon указывает на НАСТОЯЩИЙ .ico-файл, а не на «exe,0»:
    // Проводник часто не мог взять иконку из exe (кэш/права), и .xapk на рабочем столе
    // оставался с БЕЛЫМ значком. Прямая ссылка на ico-файл надёжнее.
    const icoFile = path.join(__dirname, 'assets', 'icon.ico');
    const haveIco = (() => { try { return fs.existsSync(icoFile); } catch (e) { return false; } })();
    const iconRef = haveIco ? `"${icoFile}"` : `"${exe},0"`;
    const args = [];
    if (on) {
      for (const ext of ASSOC_EXTS) {
        args.push(['add', key + '.' + ext, '/ve', '/t', 'REG_SZ', '/d', ASSOC_PROGID, '/f']);
      }
      args.push(['add', key + ASSOC_PROGID, '/ve', '/t', 'REG_SZ', '/d', 'Установка APK — ADB Wi-Fi Коннектор', '/f']);
      args.push(['add', key + ASSOC_PROGID + '\\DefaultIcon', '/ve', '/t', 'REG_SZ', '/d', iconRef, '/f']);
      args.push(['add', key + ASSOC_PROGID + '\\shell\\open\\command', '/ve', '/t', 'REG_SZ', '/d', `"${exe}" "%1"`, '/f']);
    } else {
      for (const ext of ASSOC_EXTS) args.push(['delete', key + '.' + ext, '/ve', '/f']);
      args.push(['delete', key + ASSOC_PROGID, '/f']);
    }
    return args;
  }
  function regBatch(args) {
    return new Promise((resolve) => {
      let i = 0, errs = [];
      const next = () => {
        if (i >= args.length) return resolve({ ok: errs.length === 0, errors: errs });
        execFile('reg.exe', args[i++], { windowsHide: true }, (err, out, errOut) => {
          if (err) errs.push(String(errOut || err.message).slice(0, 120));
          next();
        });
      };
      next();
    });
  }
  ipcMain.handle('assoc:get', async () => {
    const state = {};
    for (const ext of ASSOC_EXTS) {
      state[ext] = await new Promise((resolve) => {
        execFile('reg.exe', ['query', 'HKCU\\Software\\Classes\\.' + ext, '/ve'], { windowsHide: true }, (err, out) => {
          resolve(!err && String(out || '').includes(ASSOC_PROGID));
        });
      });
    }
    return { ok: true, state, note: 'apks.zip / apk.zip — двойные расширения, Windows их не ассоциирует: открывайте через правую кнопку → «Открыть с помощью». Иконки в Проводнике обновятся сразу; если старая программа ещё помнится — снимите её «Открыть по умолчанию» один раз.' };
  });
  async function assocApply(on) {
    if (!process.platform.startsWith('win')) return { ok: false, error: 'Только Windows' };
    const r = await regBatch(assocRegArgs(!!on, process.execPath));
    if (r.ok) { config.assocOn = !!on; saveConfig(); }
    let leftChoice = [];
    if (r.ok) {
      // (1) снимаем UserChoice — иначе Windows продолжит открывать прежней программой
      const uc = [];
      for (const ext of ASSOC_EXTS) {
        uc.push(['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.' + ext + '\\UserChoice', '/f']);
      }
      await regBatch(uc);
      // проверяем, что UserChoice реально снят (Windows его защищает от изменения)
      for (const ext of ASSOC_EXTS) {
        const still = await new Promise((res) => execFile('reg.exe',
          ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.' + ext + '\\UserChoice', '/ve'],
          { windowsHide: true }, (err, out) => res(!err && String(out || '').includes('ProgId'))));
        if (still) leftChoice.push('.' + ext);
      }
      // (2) мгновенное применение: ПОЛНЫЙ сброс кэша иконок + извещение Проводника о смене ассоциаций
      await new Promise((res) => execFile('ie4uinit.exe', ['-ClearIconCache'], { windowsHide: true, timeout: 15000 }, () => res()));
      await new Promise((res) => execFile('ie4uinit.exe', ['-show'], { windowsHide: true }, () => res()));
      // дополнительно чистим кэш значков Проводника (iconcache*.db) — иначе белый
      // значок .xapk на рабочем столе мог держаться до перезагрузки
      try {
        const icDir = path.join(app.getPath('appData'), '..', 'Local', 'Microsoft', 'Windows', 'Explorer');
        for (const f of fs.readdirSync(icDir)) {
          if (/^iconcache.*\.db$/i.test(f)) { try { fs.unlinkSync(path.join(icDir, f)); } catch (e) {} }
        }
      } catch (e) {}
      const ps =
        'Add-Type -Namespace Win32 -Name Sh -MemberDefinition "[DllImport(\'shell32.dll\')] public static extern void SHChangeNotify(int ev, int fl, IntPtr a, IntPtr b);"; ' +
        '[Win32.Sh]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)';
      await new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, timeout: 15000 }, () => res()));
      logInfo('assoc', on ? 'включены' : 'выключены', 'UserChoice снят, SHChangeNotify отправлен');
    }
    if (on && leftChoice.length) {
      r.warning = 'Windows сохранила прежний выбор программы для ' + leftChoice.join(', ') +
        '. Если файл открывается старой программой: правый клик → «Открыть с помощью» → выберите программу и «Всегда».';
    }
    return r;
  }
  ipcMain.handle('assoc:set', (_e, on) => assocApply(on));

  /* ================= иконки приложений в Проводнике (apkshellext, HKLM) ================= */
  // Shell-расширение читает настоящую иконку из APK/AAB/XAPK/APKM/APKS/APKV; для OBB — значок Android.
  // Регистрация только в HKLM: HKCU-COM на Windows 11 не активируется (проверено).
  const SHELLEXT_CLSID = '{1F869CEE-4FDA-35D9-896F-43975A87D1F6}';
  const SHELLEXT_EXTS = ['apk', 'aab', 'xapk', 'apkm', 'apks', 'apkv', 'obb'];
  const SHELLEXT_FILES = ['ApkShellext2.dll', 'ApkShellext2.dll.config', 'Google.Protobuf.dll', 'libwebp_x64.dll', 'libsharpyuv.dll'];

  function shellextDir() {
    const base = process.env.LOCALAPPDATA || app.getPath('appData');
    return path.join(base, 'ADB-WiFi-Connector', 'ShellExt');
  }

  function cleanShellextTemp(dir) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (/\.(old|new)-[a-z0-9]+$/i.test(name)) {
          try { fs.unlinkSync(path.join(dir, name)); } catch (e) {}
        }
      }
    } catch (e) {}
  }

  function replaceShellextFile(src, target, id) {
    const staged = target + '.new-' + id;
    fs.copyFileSync(src, staged);
    let old = null;
    if (fs.existsSync(target)) {
      old = target + '.old-' + id;
      try {
        fs.renameSync(target, old);
      } catch (renameError) {
        try {
          fs.copyFileSync(staged, target);
          fs.unlinkSync(staged);
          return;
        } catch (copyError) {
          try { fs.unlinkSync(staged); } catch (e) {}
          throw new Error('Файл занят: ' + path.basename(target) + '. Перезапустите Проводник и повторите установку.');
        }
      }
    }
    try {
      fs.renameSync(staged, target);
    } catch (moveError) {
      if (old) { try { fs.renameSync(old, target); } catch (e) {} }
      try { fs.unlinkSync(staged); } catch (e) {}
      throw moveError;
    }
    if (old) { try { fs.unlinkSync(old); } catch (e) {} }
  }

  function regRead(key, name) {
    return new Promise((resolve) => {
      const args = ['query', key];
      if (name) args.push('/v', name); else args.push('/ve');
      execFile('reg.exe', args, { windowsHide: true, timeout: 10000 }, (err, out) => {
        if (err) return resolve(null);
        for (const line of String(out || '').split(/\r?\n/)) {
          const i = line.indexOf('REG_');
          if (i < 0) continue;
          const left = line.slice(0, i).trim();
          const val = line.slice(i).replace(/^REG_\w+\s*/, '').trim();
          if (!name || left === name || left === '(Default)') return resolve(val);
        }
        resolve(null);
      });
    });
  }

  async function shellextStatus() {
    const dir = shellextDir();
    const missing = SHELLEXT_FILES.filter((f) => {
      try { return !fs.existsSync(path.join(dir, f)); } catch (e) { return true; }
    });
    const codebase = await regRead('HKLM\\Software\\Classes\\CLSID\\' + SHELLEXT_CLSID + '\\InprocServer32', 'CodeBase');
    const norm = String(codebase || '').replace(/\//g, '\\').toLowerCase();
    const exts = {};
    for (const ext of SHELLEXT_EXTS) {
      const v = await regRead('HKLM\\Software\\Classes\\.' + ext + '\\ShellEx\\IconHandler', '');
      exts[ext] = String(v || '') === SHELLEXT_CLSID;
    }
    const installed = !missing.length && norm.indexOf('shellext\\apkshellext2.dll') >= 0;
    return { ok: true, installed, dir, missing, codebase, exts };
  }

  function shellextPsScript() {
    return [
      "param([string]$Mode, [string]$Dir, [string]$Clsid, [string]$Exts, [string]$Result)",
      "$ErrorActionPreference = 'Stop'",
      "try {",
      "  $dll = Join-Path $Dir 'ApkShellext2.dll'",
      "  if (-not (Test-Path -LiteralPath $dll)) { throw 'ApkShellext2.dll не найден' }",
      "  $classes = 'HKLM:\\Software\\Classes'",
      "  $clsidKey = Join-Path $classes ('CLSID\\' + $Clsid)",
      "  if ($Mode -eq 'install') {",
      "    $asm = [System.Reflection.AssemblyName]::GetAssemblyName($dll).FullName",
      "    $code = ([Uri]$dll).AbsoluteUri",
      "    New-Item -Path $clsidKey -Force | Out-Null",
      "    Set-Item -Path $clsidKey -Value 'ApkShellext2.ApkIconHandler'",
      "    $ip = Join-Path $clsidKey 'InprocServer32'",
      "    New-Item -Path $ip -Force | Out-Null",
      "    Set-Item -Path $ip -Value (Join-Path $env:SystemRoot 'System32\\mscoree.dll')",
      "    Set-ItemProperty -Path $ip -Name 'ThreadingModel' -Value 'Both'",
      "    Set-ItemProperty -Path $ip -Name 'Class' -Value 'ApkShellext2.ApkIconHandler'",
      "    Set-ItemProperty -Path $ip -Name 'Assembly' -Value $asm",
      "    Set-ItemProperty -Path $ip -Name 'RuntimeVersion' -Value 'v4.0.30319'",
      "    Set-ItemProperty -Path $ip -Name 'CodeBase' -Value $code",
      "    foreach ($ext in $Exts.Split(',')) {",
      "      $extKey = Join-Path $classes ('.' + $ext)",
      "      New-Item -Path $extKey -Force | Out-Null",
      "      $prog = ''",
      "      try { $prog = [string](Get-Item -LiteralPath $extKey).GetValue('') } catch { }",
      "      if (-not $prog) { try { $prog = [string](Get-Item -LiteralPath (Join-Path 'HKCU:\\Software\\Classes' ('.' + $ext))).GetValue('') } catch { } }",
      "      if (-not $prog) { $prog = 'AdbWifiConnectorRu.APKFile' }",
      "      $targets = @($extKey)",
      "      if ($prog) { $targets += (Join-Path $classes $prog) }",
      "      foreach ($t in $targets) {",
      "        $se = Join-Path $t 'ShellEx\\IconHandler'",
      "        New-Item -Path $se -Force | Out-Null",
      "        Set-Item -Path $se -Value $Clsid",
      "      }",
      "    }",
      "    $approved = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Approved'",
      "    New-Item -Path $approved -Force | Out-Null",
      "    Set-ItemProperty -Path $approved -Name $Clsid -Value 'APK icon handler'",
      "  } else {",
      "    foreach ($ext in $Exts.Split(',')) {",
      "      $extKey = Join-Path $classes ('.' + $ext)",
      "      $prog = ''",
      "      try { $prog = [string](Get-Item -LiteralPath $extKey).GetValue('') } catch { }",
      "      if (-not $prog) { try { $prog = [string](Get-Item -LiteralPath (Join-Path 'HKCU:\\Software\\Classes' ('.' + $ext))).GetValue('') } catch { } }",
      "      if (-not $prog) { $prog = 'AdbWifiConnectorRu.APKFile' }",
      "      $targets = @($extKey)",
      "      if ($prog) { $targets += (Join-Path $classes $prog) }",
      "      foreach ($t in $targets) {",
      "        $se = Join-Path $t 'ShellEx\\IconHandler'",
      "        if (Test-Path -LiteralPath $se) {",
      "          $v = ''",
      "          try { $v = [string](Get-Item -LiteralPath $se).GetValue('') } catch { }",
      "          if ($v -eq $Clsid) { Remove-Item -LiteralPath $se -Recurse -Force }",
      "        }",
      "      }",
      "    }",
      "    if (Test-Path -LiteralPath $clsidKey) { Remove-Item -LiteralPath $clsidKey -Recurse -Force }",
      "    $approved = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Approved'",
      "    if (Test-Path -LiteralPath $approved) { Remove-ItemProperty -Path $approved -Name $Clsid -ErrorAction SilentlyContinue }",
      "  }",
      "  Add-Type -Namespace Win32Shell -Name Notify -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int ev, int fl, IntPtr a, IntPtr b);'",
      "  [Win32Shell.Notify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)",
      "  @{ ok = $true; error = '' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $Result -Encoding UTF8",
      "} catch {",
      "  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress | Set-Content -LiteralPath $Result -Encoding UTF8",
      "  exit 1",
      "}"
    ].join('\r\n');
  }

  function runElevatedScript(scriptPath, argList) {
    return new Promise((resolve) => {
      const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      const all = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath].concat(argList);
      const cmd = 'Start-Process -FilePath ' + q('powershell.exe') + ' -Verb RunAs -Wait -ArgumentList @(' + all.map(q).join(',') + ')';
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', cmd],
        { windowsHide: true, timeout: 300000 }, (err, out, errOut) => {
          resolve({ ok: !err, error: err ? String(errOut || err.message).trim() : '' });
        });
    });
  }

  async function refreshShellIcons() {
    await new Promise((res) => execFile('ie4uinit.exe', ['-ClearIconCache'], { windowsHide: true, timeout: 15000 }, () => res()));
    let removed = 0;
    try {
      const icDir = path.join(app.getPath('appData'), '..', 'Local', 'Microsoft', 'Windows', 'Explorer');
      for (const f of fs.readdirSync(icDir)) {
        if (/^iconcache.*\.db$/i.test(f)) { try { fs.unlinkSync(path.join(icDir, f)); removed++; } catch (e) {} }
      }
    } catch (e) {}
    const ps =
      'Add-Type -Namespace Win32 -Name Sh -MemberDefinition "[DllImport(\'shell32.dll\')] public static extern void SHChangeNotify(int ev, int fl, IntPtr a, IntPtr b);"; ' +
      '[Win32.Sh]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)';
    await new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, timeout: 15000 }, () => res()));
    return { removed };
  }

  async function shellextApply(mode) {
    try {
      const dir = shellextDir();
      const bundle = path.join(__dirname, 'shellext');
      if (mode === 'install') {
        fs.mkdirSync(dir, { recursive: true });
        cleanShellextTemp(dir);
        const copyId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        for (const f of SHELLEXT_FILES) {
          const src = path.join(bundle, f);
          if (!fs.existsSync(src)) return { ok: false, error: 'Не найден файл расширения: ' + f };
          replaceShellextFile(src, path.join(dir, f), copyId);
        }
      }
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const scriptPath = path.join(os.tmpdir(), 'adbwc-shellext-' + id + '.ps1');
      const resultPath = path.join(os.tmpdir(), 'adbwc-shellext-' + id + '.json');
      fs.writeFileSync(scriptPath, '\ufeff' + shellextPsScript(), 'utf8');
      try { fs.unlinkSync(resultPath); } catch (e) {}
      const run = await runElevatedScript(scriptPath, ['-Mode', mode, '-Dir', dir, '-Clsid', SHELLEXT_CLSID,
        '-Exts', SHELLEXT_EXTS.join(','), '-Result', resultPath]);
      let res = null;
      try { res = JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {}
      try { fs.unlinkSync(scriptPath); } catch (e) {}
      if (!run.ok) return { ok: false, error: run.error || 'Установка отменена администратором' };
      if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'Не удалось зарегистрировать расширение' };
      const cache = await refreshShellIcons();
      config.shellextOn = mode === 'install';
      saveConfig();
      logInfo('shellext', mode, 'ok');
      return { ok: true, dir, cacheRemoved: cache.removed, restartNeeded: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  ipcMain.handle('shellext:status', () => shellextStatus());
  ipcMain.handle('shellext:install', () => shellextApply('install'));
  ipcMain.handle('shellext:uninstall', () => shellextApply('uninstall'));
  ipcMain.handle('shellext:restart-explorer', () => new Promise((resolve) => {
    execFile('taskkill.exe', ['/f', '/im', 'explorer.exe'], { windowsHide: true }, () => {
      setTimeout(() => {
        try { require('child_process').spawn('explorer.exe', [], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (e) {}
        setTimeout(() => resolve({ ok: true }), 1500);
      }, 1200);
    });
  }));

  /* ================= очередь установки APK (новая вкладка) ================= */
  // поддерживает: .apk | .apks/.xapk/.apkm/.apks.zip/.apk.zip (сплиты через install-multiple)
  // | .obb (push в Android/obb) | .aab — честная ошибка (нужен bundletool)
  ipcMain.handle('apk:installbatch', async (e, serial, files) => {
    const list = (Array.isArray(files) ? files : []).filter(x => x && typeof x.path === 'string').slice(0, 40);
    if (!list.length) return { ok: false, error: 'Список пуст' };
    installCanceled = false;
    const { spawn: sp } = require('child_process');
    const tmpDir = path.join(os.tmpdir(), 'adbwifi-apk-' + Date.now());
    let installed = 0, failed = 0, canceled = false;
    const send = (obj) => { try { e.sender.send('task:event', Object.assign({ kind: 'apk-queue' }, obj)); } catch (err) {} };

    // ОДНО подтверждение в программе — и БЕЗ вопросов на самом телефоне.
    // Причины «каждый APK спрашивает разрешение»: (а) verifier_verify_adb_installs
    // (Play-защита при установке через adb), (б) на MIUI — adb_install_need_confirm
    // («Установка через USB»). На время пакета обе настройки выключаем, после — возвращаем
    // ИСХОДНЫЕ значения, чтобы не менять безопасность устройства навсегда.
    async function setSoft(what, val) {
      return adb.run(['-s', serial, 'shell', 'settings', 'put', 'global', what, String(val)], { timeout: 10000 });
    }
    async function getSoft(what) {
      const r = await adb.run(['-s', serial, 'shell', 'settings', 'get', 'global', what], { timeout: 10000 });
      return (r.stdout || '').trim();
    }
    const reverts = [];
    try {
      const v0 = await getSoft('verifier_verify_adb_installs');
      if (v0 !== '0' && v0 !== 'null') { await setSoft('verifier_verify_adb_installs', 0); reverts.push(['verifier_verify_adb_installs', v0]); }
    } catch (err) {}
    try {
      const m0 = await getSoft('adb_install_need_confirm');
      // на MIUI/HyperOS встречается и '1', и 'true' — раньше второй вариант игнорировался
      if (m0 === '1' || m0 === 'true') { await setSoft('adb_install_need_confirm', 0); reverts.push(['adb_install_need_confirm', m0]); }
    } catch (err) {}

    // человеческие пояснения к кодам INSTALL_FAILED_* — раньше пользователь видел
    // только «устройство не установило пакет» и не понимал причину
    function explainInstall(raw) {
      const t = String(raw || '');
      const known = [
        ['INSTALL_FAILED_VERSION_DOWNGRADE', 'на телефоне уже стоит более новая версия приложения'],
        ['INSTALL_FAILED_UPDATE_INCOMPATIBLE', 'подписи не совпадают с установленной версией — сначала удалите старое приложение'],
        ['INSTALL_FAILED_INSUFFICIENT_STORAGE', 'недостаточно места на телефоне'],
        ['INSTALL_FAILED_OLDER_SDK', 'приложение требует более новый Android, чем на телефоне'],
        ['INSTALL_FAILED_DEPRECATED_SDK_VERSION', 'приложение требует более новый Android, чем на телефоне'],
        ['INSTALL_FAILED_NO_MATCHING_ABIS', 'APK собран для другой архитектуры процессора'],
        ['INSTALL_FAILED_CPU_ABI_INCOMPATIBLE', 'APK собран для другой архитектуры процессора'],
        ['INSTALL_FAILED_USER_RESTRICTED', 'на телефоне запрещена установка через USB — включите «Установка через USB» в параметрах разработчика'],
        ['INSTALL_FAILED_VERIFICATION_FAILURE', 'установку заблокировала проверка Play Protect'],
        ['INSTALL_PARSE_FAILED_NO_CERTIFICATES', 'APK без подписи или подпись изменена — файл пересобран/модифицирован'],
        ['INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES', 'в APK разные подписи — файл изменён или собран из разных частей'],
        ['INSTALL_PARSE_FAILED_MANIFEST_MALFORMED', 'манифест APK повреждён — файл изменён или недокачан'],
        ['INSTALL_PARSE_FAILED_MANIFEST_EMPTY', 'в APK пустой манифест — файл повреждён'],
        ['INSTALL_PARSE_FAILED_BAD_MANIFEST', 'манифест APK не читается — файл повреждён'],
        ['INSTALL_PARSE_FAILED_UNEXPECTED_EXCEPTION', 'Android не смог разобрать APK — файл повреждён или изменён'],
        ['INSTALL_PARSE_FAILED_NOT_APK', 'это не APK-файл (переименованный архив/другой формат)'],
        ['INSTALL_FAILED_INVALID_APK', 'APK изменён или повреждён — пересоберите и подпишите заново'],
        ['INSTALL_FAILED_TEST_ONLY', 'APK помечен как тестовый (test-only)'],
        ['INSTALL_FAILED_MISSING_SPLIT', 'не хватает частей сплит-пакета — нужен полный .xapk/.apks'],
        ['INSTALL_FAILED_SESSION_INVALID', 'части сплит-пакета не совпадают — скачайте архив заново'],
        ['INSTALL_FAILED_DUPLICATE_PERMISSION', 'конфликт разрешений с другим приложением'],
        ['INSTALL_FAILED_CONFLICTING_PROVIDER', 'конфликт с уже установленным приложением'],
        ['INSTALL_FAILED_ALREADY_EXISTS', 'приложение уже установлено'],
        ['INSTALL_FAILED_DUPLICATE_PACKAGE', 'пакет с таким именем уже установлен'],
        ['INSTALL_FAILED_DEXOPT', 'ошибка оптимизации кода (dexopt) на телефоне'],
        ['INSTALL_FAILED_UID_CHANGED', 'у приложения сменился UID — удалите старую версию'],
        ['INSTALL_FAILED_SHARED_USER_INCOMPATIBLE', 'APK требует системную подпись/общий UID'],
        ['INSTALL_FAILED_MISSING_SHARED_LIBRARY', 'APK требует библиотеку, которой нет на телефоне'],
        ['INSTALL_FAILED_INTERNAL_ERROR', 'внутренняя ошибка установщика Android — перезагрузите телефон'],
        ['INSTALL_FAILED_ABORTED', 'установка прервана на телефоне'],
        ['INSTALL_FAILED_PACKAGE_CHANGED', 'пакет изменился во время установки — повторите'],
        ['INSTALL_FAILED_REPLACE_COULDNT_DELETE', 'не удалось удалить старую версию — удалите вручную'],
        ['INSTALL_FAILED_CONTAINER_ERROR', 'ошибка доступа к памяти телефона'],
        ['INSTALL_FAILED_INVALID_INSTALL_LOCATION', 'недопустимое место установки (память/SD)']
      ];
      for (const [code, hint] of known) if (t.includes(code)) return code + ' — ' + hint;
      const any = t.match(/INSTALL_[A-Z_]+/);
      if (any) return any[0] + ' — Android отклонил установку, точное пояснение см. в логе';
      if (/device (offline|not found)|no devices\/emulators/i.test(t)) return 'телефон отключился от ADB — проверьте кабель или Wi-Fi';
      if (/INSTALL_CANCELED_BY_USER|user rejected/i.test(t)) return 'установку отклонили на экране телефона';
      return '';
    }
    // чистим вывод adb: убираем проценты вида [ 45%], склеенные \r-перерисовки
    function cleanInstallOut(out) {
      return String(out || '').replace(/\r/g, '\n').split('\n')
        .map(s => s.replace(/\[\s*\d+%\]\s*/g, '').trim()).filter(Boolean);
    }
    const runInstall = (args) => new Promise((resolve) => {
      const exe = adb.getAdbPath();
      if (!exe) return resolve({ ok: false, message: 'adb не найден' });
      const child = sp(exe, args, { windowsHide: true });
      installChild = child;
      let out = '', settled = false;
      const finish = (res) => { if (settled) return; settled = true; installChild = null; resolve(res); };
      const t = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (err) {}
        finish({ ok: false, message: 'Таймаут 10 мин: передача прервана. Установка на телефоне могла продолжиться.' });
      }, 600000);
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      child.on('error', err => { clearTimeout(t); finish({ ok: false, message: err.message }); });
      child.on('close', () => {
        clearTimeout(t);
        const lines = cleanInstallOut(out);
        const ok = /\bSuccess\b/i.test(out) && !/INSTALL_FAILED|Failure\s*\[/i.test(out);
        const hint = ok ? '' : explainInstall(out);
        const detail = lines.filter(s => !/^Performing Streamed Install$/i.test(s)).join('\n');
        finish({ ok, raw: detail.slice(0, 8000), message: ok ? 'установлено' : (hint || detail.slice(-300) || 'ошибка установки') });
      });
    });

    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (err) {}
    const results = []; // подробный итог по каждому файлу — UI больше не теряет причину ошибки
    try {
    for (let i = 0; i < list.length; i++) {
      if (installCanceled) { canceled = true; break; }
      const fp = list[i].path, base = path.basename(fp);
      const send2 = (stage, message, raw) => send({ index: i, total: list.length, file: base, stage, message, raw: raw || '' });
      send2('run', '');
      if (!fs.existsSync(fp)) { failed++; results.push({ file: base, ok: false, message: 'файл не найден' }); send2('fail', 'файл не найден'); continue; }
      try {
        if (/\.aab$/i.test(fp)) {
          failed++; results.push({ file: base, ok: false, message: 'AAB — формат для Google Play' }); send2('fail', 'AAB — формат для Google Play: соберите APK через bundletool и установите его');
          continue;
        }
        if (/\.obb$/i.test(fp)) {
          // расширение игры: кладём в /sdcard/Android/obb/<pkg или корень obb>
          let pkg = (list[i].meta && list[i].meta.package) || null;
          if (!pkg) pkg = (base.match(/^([\w.]+)[._]/) || [])[1] || null;
          if (!pkg) {
            failed++; results.push({ file: base, ok: false, message: 'не удалось определить пакет игры' });
            send2('fail', 'не удалось определить пакет игры для OBB — переименуйте файл как <пакет>.<версия>.obb');
            continue;
          }
          const dst = '/sdcard/Android/obb/' + pkg;
          await adb.run(['-s', serial, 'shell', 'mkdir', '-p', adb.shq(dst)], { timeout: 15000 });
          const pr = await adb.run(['-s', serial, 'push', fp, dst + '/'], { timeout: 600000 });
          if (pr.ok) { installed++; results.push({ file: base, ok: true, message: 'OBB скопирован в ' + dst }); send2('done', 'OBB скопирован в ' + dst); }
          else { failed++; const m = 'push не удался: ' + ((pr.stderr || '').slice(0, 120) || 'ошибка'); results.push({ file: base, ok: false, message: m }); send2('fail', m); }
          continue;
        }
        if (/\.(apks|xapk|apkm)$/i.test(fp) || /\.apks\.zip$|\.apk\.zip$/i.test(fp)) {
          // сплит-пакет: достаём все *.apk и ставим одним сеансом install-multiple
          send2('run', 'разбираю сплит-пакет…');
          const buf = fs.readFileSync(fp);
          const z = require('./apkicon.js').parseZip(buf);
          if (!z) { failed++; results.push({ file: base, ok: false, message: 'архив повреждён' }); send2('fail', 'архив повреждён'); continue; }
          const names = Object.keys(z.entries).filter(n => /\.apk$/i.test(n));
          if (!names.length) { failed++; results.push({ file: base, ok: false, message: 'внутри архива нет .apk' }); send2('fail', 'внутри архива нет .apk'); continue; }
          // base.apk первым (или самый большой) — так надёжнее для install-multiple
          names.sort((a, b) => {
            const ba = /(^|\/)base\.apk$/i.test(a) ? 2 : 0, bb = /(^|\/)base\.apk$/i.test(b) ? 2 : 0;
            if (ba !== bb) return bb - ba;
            return (z.entries[b].csize || 0) - (z.entries[a].csize || 0);
          });
          const parts = [];
          const skipped = [];
          let baseSeen = false;
          for (const n of names) {
            const data = require('./apkicon.js').zipRead(z, n);
            if (!data) { skipped.push(path.basename(n)); continue; } // метод сжатия не поддержан (zstd/bzip2/LZMA)
            const tmpF = path.join(tmpDir, i + '-' + path.basename(n));
            fs.writeFileSync(tmpF, data);
            parts.push(tmpF);
            if (/(^|\/)base\.apk$/i.test(n)) baseSeen = true;
          }
          if (!parts.length) { failed++; results.push({ file: base, ok: false, message: 'не удалось распаковать сплиты' }); send2('fail', 'не удалось распаковать сплиты'); continue; }
          if (skipped.length) {
            const m = 'часть сплитов не распакована (' + skipped.slice(0, 3).join(', ') + '): архив сжат неподдерживаемым методом — распакуйте .xapk вручную и установите base.apk + split-файлы';
            failed++; results.push({ file: base, ok: false, message: m }); send2('fail', m); continue;
          }
          if (!baseSeen && parts.length > 1) {
            // в APKM/XAPK база может называться иначе — ставим всё равно, но предупреждаем в лог
            logErr('installbatch', serial, base, 'base.apk не найден среди сплитов');
          }
          const r = await runInstall(['-s', serial, 'install-multiple', '-r', ...parts]);
          if (r.ok) { installed++; results.push({ file: base, ok: true, message: 'установлено' }); send2('done', 'установлено (сплит: ' + parts.length + ' части)'); }
          else {
            failed++;
            results.push({ file: base, ok: false, message: r.message || 'ошибка установки', raw: r.raw || '' });
            send2('fail', (r.message || 'ошибка установки').slice(0, 200), r.raw || '');
            logErr('installbatch', serial, base, (r.raw || r.message || '').slice(0, 400));
          }
          for (const p of parts) { try { fs.unlinkSync(p); } catch (err) {} }
          continue;
        }
        // обычный .apk (и .apk.1/.apk+/.apup — это просто переименованные apk)
        let r = await runInstall(['-s', serial, 'install', '-r', fp]);
        // даунгрейд — предлагаем повтор с -d (частая причина «этот ставится, а этот нет»)
        if (!r.ok && /VERSION_DOWNGRADE/i.test((r.raw || '') + ' ' + (r.message || '')) && !installCanceled) {
          send2('run', 'версия ниже установленной — пробую с разрешением понижения…');
          r = await runInstall(['-s', serial, 'install', '-r', '-d', fp]);
        }
        if (r.ok) { installed++; results.push({ file: base, ok: true, message: 'установлено' }); send2('done', 'установлено'); }
        else {
          failed++;
          const msg = (r.message || 'ошибка установки').slice(0, 300);
          results.push({ file: base, ok: false, message: msg, raw: r.raw || '' });
          send2('fail', msg, r.raw || msg);
          logErr('installbatch', serial, base, (r.raw || msg).slice(0, 400));
        }
      } catch (err) {
        failed++; results.push({ file: base, ok: false, message: err.message });
        send2('fail', err.message);
        logErr('installbatch', serial, base, err && (err.stack || err.message));
      }
    }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (err) {}
      // возвращаем настройки verifier ВСЕГДА (finally) — раньше при исключении
      // на телефоне навсегда оставалась отключённой проверка установки
      for (const [what, val] of reverts) { try { await setSoft(what, val); } catch (err) {} }
    }
    return { ok: installed > 0, installed, failed, canceled, results };
  });
  ipcMain.handle('apk:installcancel', async () => {
    installCanceled = true;
    try { if (installChild) installChild.kill('SIGKILL'); } catch (e) {}
    return { ok: true };
  });
  // надёжное копирование в буфер (navigator.clipboard в file:// не всегда доступен)
  ipcMain.handle('clipboard:write', async (_e, text) => {
    try { clipboard.writeText(String(text == null ? '' : text)); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  });
  const INTEGRATION_INSTALL = process.argv.includes('--install-integration');
  const INTEGRATION_CLEAN = process.argv.includes('--clean-integration');
  if (INTEGRATION_INSTALL || INTEGRATION_CLEAN) {
    setTimeout(async () => {
      try {
        if (INTEGRATION_INSTALL) {
          await assocApply(true);
          await shellextApply('install');
        } else {
          await assocApply(false);
          try {
            const st = await shellextStatus();
            if (st && st.installed) await shellextApply('uninstall');
          } catch (e) {}
          try { fs.rmSync(shellextDir(), { recursive: true, force: true }); } catch (e) {}
          config.assocOn = false;
          config.shellextOn = false;
          config.portableCleanupDone = true;
          saveConfig();
        }
      } catch (e) { try { logErr('integration', e.message); } catch (e2) {} }
      app.exit(0);
    }, 600);
  }
}

// ---------- запуск ----------
  // dev/агентный запуск (--remote-debugging-port) НЕ берёт single-instance lock —
  // иначе второй инстанс с CDP мгновенно умирает (app.quit), а мы подключаемся к старому коду.
  const DEV_AGENT_RUN = process.argv.some(a => a.indexOf('--remote-debugging-port=') === 0);
  const gotLock = DEV_AGENT_RUN ? true : app.requestSingleInstanceLock();
  // ассоциации файлов — двойной клик по .apk/.xapk/.obb открывает мини-окно установки.
  // Файл может прийти и в первом запуске (argv), и во второй инстанс (second-instance).
  function fileFromArgv(argv) {
    for (const a of (argv || []).slice(1)) {
      try {
        if (a && fs.existsSync(a) && fs.statSync(a).isFile() &&
            /\.(apk|aab|apks|xapk|apkm|obb|apk\.1|apk\+|apup|apks\.zip|apk\.zip)$/i.test(a)) return a;
      } catch (e) {}
    }
    return null;
  }
  if (!gotLock && !DEV_AGENT_RUN) { app.quit(); } else {
  app.on('second-instance', (_e, argv) => {
      const f = fileFromArgv(argv);
      if (f) {
        // APK с рабочего стола открывается в ОТДЕЛЬНОМ окошке, основную программу не показываем
        if (!openApkStandalone(f)) { if (win) { win.show(); win.focus(); } sendTask({ kind: 'open-apk', path: f }); }
        return;
      }
      if (win) { win.show(); win.focus(); }
    });
app.whenReady().then(async () => {
    try { fs.rmSync(path.join(app.getPath('temp'), 'gigatool-drag'), { recursive: true, force: true }); } catch (e) {}
    loadAll();
    // если программа запущена ДВОЙНЫМ КЛИКОМ ПО APK — главное окно и трей вообще
    // не создаются, на экране только окошко установщика (в нём есть кнопка «Открыть программу»)
    const startupFile = startupApkFile(process.argv);
    // APK-файл в командной строке важнее любого режима отладки — иначе отладочный
    // запуск снова показывал бы главное окно и трей при двойном клике по APK
    miniOnly = !!startupFile;
    if (!miniOnly) createWindow();
    registerIpc();
    // MCP-сервер агента — мост между ним и функциями программы
    {
      const errList = [];
      const lastErrors = (n) => errList.slice(-n);
      const screenStateOf = async (serial) => {
        const r = await adb.run(['-s', serial, 'shell', "dumpsys power | grep -E 'mWakefulness|mScreenState'; dumpsys window | grep -E 'mDreamingLockscreen|mCurrentFocus' | head -n 6"], { timeout: 12000 }).catch(() => null);
        const t = ((r && r.stdout) || '') + ' ' + ((r && r.stderr) || '');
        const wake = (t.match(/mWakefulness=(\w+)/) || [])[1] || '';
        const screen = (t.match(/mScreenState=(\w+)/) || [])[1] || '';
        const asleep = /mWakefulness=(Asleep|Dozing)/i.test(t) || /mScreenState=OFF/i.test(t);
        const screenOn = /mWakefulness=Awake/i.test(t) ? true : (asleep ? false : null);
        const locked = /mDreamingLockscreen=true/i.test(t) || /mCurrentFocus=.*NotificationShade/i.test(t);
        const focus = (t.match(/mCurrentFocus=([^\r\n]+)/) || [])[1] || '';
        return { ok: !!(r && r.ok), screenOn, locked, wakefulness: wake, screenState: screen, focus: focus.trim(), raw: t.trim().slice(0, 1200) };
      };
      agentMcp.initApp({
        getWin: () => win,
        getStateFn: async () => ({ ok: true, config, history, favorites, savesDir: SAVE_DIR, pages: ['devices', 'tools', 'files', 'apps', 'apk', 'settings'] }),
        activeSerial: () => { try { return (win && !win.isDestroyed()) ? win.webContents.executeJavaScript('(window.activeSerial||null)', true) : null; } catch (e) { return null; } },
        getConfig: () => config,
        getHistory: () => history,
        getFavorites: () => favorites,
        savesDir: SAVE_DIR,
        appLogPath: LOG_FILE,
        logInfo: (...a) => logInfo(...a),
        logErr: (...a) => { try { errList.push(String(a[2] || a[1] || '').slice(0, 400)); } catch (e) {} logErr(...a); },
        getLogs: async () => [],          // основной лог в app.log — агент берёт его файлом
        getErrors: async (n) => lastErrors(n || 20),
        setSetting: async (k, v) => {
          if (typeof k !== 'string' || !ALLOWED_SETTINGS.has(k)) return { ok: false, error: 'Ключ не разрешён' };
          config[k] = v; saveConfig();
          if (k === 'agentEnabled') agentMcp.setEnabled(!!v);
          if (k === 'adbPath') adb.setAdbPath(v);
          try { if (win && !win.isDestroyed()) win.webContents.send('setting:changed', { key: k, value: v }); } catch (e) { logErr('setSetting', k, e.message); }
          return { ok: true };
        },
        // безопасные внутренние функции (режим 2)
        callFns: {
          adbDevices: async () => adb.devices(),
          devDetect: async () => (devDetectFn ? devDetectFn() : { ok: false, error: 'Обнаружение недоступно' }),
          adbConnect: async ({ host, port }) => connectDevice(host, +port),
          adbDisconnect: async ({ serial }) => adb.disconnect(serial),
          adbPing: async ({ serial }) => { try { return await adb.pingDevice(serial); } catch (e) { return { ok: false }; } },
          appsList: async ({ serial }) => {
            const [user, system, disabled] = await Promise.all([
              adb.run(['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'], { timeout: 20000 }),
              adb.run(['-s', serial, 'shell', 'pm', 'list', 'packages', '-s'], { timeout: 20000 }),
              adb.run(['-s', serial, 'shell', 'pm', 'list', 'packages', '-d'], { timeout: 20000 })
            ]);
            const parse = r => (r.stdout || '').split(/\r?\n/).map(l => l.trim().match(/^package:(.+)$/)).filter(Boolean).map(m => m[1]);
            return { ok: true, user: parse(user), system: parse(system), disabled: parse(disabled) };
          },
          appsRun: async ({ serial, pkg }) => adb.run(['-s', serial, 'shell', 'monkey', '-p', pkg, '1'], { timeout: 20000 }),
      appsAction: async ({ serial, action, pkg }) => {
        // тот же механизм, что у кнопок UI (см. apps:action выше) — включая
        // обход «Cannot disable system packages» через pm uninstall -k --user 0.
        const runA = (cmd) => adb.run(['-s', serial, 'shell', cmd], { timeout: 30000 });
        if (action === 'phoneInfo') {
          const r = await adb.run(['-s', serial, 'shell', 'am', 'start',
            '-a', 'android.settings.APPLICATION_DETAILS_SETTINGS',
            '-d', 'package:' + pkg], { timeout: 20000 });
          return { ok: r.ok, message: ((r.stdout || '') + ' ' + (r.stderr || '')).trim().slice(0, 300) };
        }
        let cmd = action === 'forceStop' ? 'am force-stop ' + adb.shq(pkg)
          : action === 'disable' ? 'pm disable-user --user 0 ' + adb.shq(pkg)
          : action === 'enable' ? 'pm enable ' + adb.shq(pkg)
          : action === 'clear' || action === 'clearCache' ? 'pm clear ' + adb.shq(pkg)
          : action === 'restore' ? 'cmd package install-existing --user 0 ' + adb.shq(pkg)
          : action === 'uninstall' ? 'pm uninstall --user 0 ' + adb.shq(pkg)
          : null;
        if (!cmd) return { ok: false, error: 'Неизвестное действие: ' + action };
        let r = await runA(cmd);
        const txt = () => ((r.stdout || '') + ' ' + (r.stderr || '')).trim();
        let fallback = false;
        if (action === 'disable' && /cannot disable system packages|securityexception/i.test(txt())) {
          r = await runA('pm uninstall -k --user 0 ' + adb.shq(pkg));
          fallback = true;
        }
        if (action === 'restore' && !r.ok) {
          const en = await runA('pm enable --user 0 ' + adb.shq(pkg));
          if (en.ok) { r = en; fallback = true; }
        }
        if ((action === 'enable' || action === 'restore') && !r.ok) {
          r = await runA('cmd package install-existing --user 0 ' + adb.shq(pkg));
          if (!r.ok) r = await runA('pm install-existing --user 0 ' + adb.shq(pkg));
          fallback = true;
        }
        const bad = /Failure|Exception|error:/i.test(txt());
        return {
          ok: r.ok && !bad,
          message: txt().slice(0, 300),
          fallback: fallback || undefined
        };
      },
          appsMeta: () => Promise.resolve({ ok: true, meta: {} }),
          fsList: async ({ serial, path: p }) => {
            const q = adb.shq(p || '/sdcard');
            const r = await adb.run(['-s', serial, 'shell', 'ls -la ' + q + ' 2>/dev/null'], { timeout: 20000 });
            return { ok: r.ok, items: (r.stdout || '').split(/\r?\n/).filter(Boolean).map(l => { const m = l.match(/^([d-])[rwxst-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+([A-Za-z]{3}\s+\d+\s+[\d:]{4,5})\s+(.+)$/); return m ? { dir: m[1] === 'd', size: +m[2], name: m[3] } : { dir: false, name: l.replace(/^.*?\s+/, '').trim() }; }) };
          },
          fsCat: async ({ serial, path: p, maxMB }) => {
            const res = await new Promise((resolve) => {
              const exe = adb.getAdbPath();
              const MAX = Math.max(1, parseInt(maxMB, 10) || 32) * 1024 * 1024;
              const child = require('child_process').spawn(exe, ['-s', serial, 'exec-out', 'cat ' + adb.shq(p)], { windowsHide: true });
              const chunks = []; let bytes = 0, capped = false;
              const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 60000);
              child.stdout.on('data', (dd) => { bytes += dd.length; if (bytes > MAX) { if (!capped) { capped = true; try { child.kill('SIGKILL'); } catch (e) {} } return; } chunks.push(dd); });
              child.on('close', () => { clearTimeout(t); const buf = Buffer.concat(chunks); resolve({ ok: !capped && buf.length > 0, bytes, capped }); });
              child.on('error', () => { clearTimeout(t); resolve({ ok: false, error: 'spawn failed' }); });
            });
            return res;
          },
          procsList: async ({ serial }) => {
            let r = await adb.run(['-s', serial, 'shell', 'ps -A -o PID,NAME'], { timeout: 20000 });
            let text = (r && r.ok && /PID/.test(r.stdout || '')) ? (r.stdout || '') : '';
            if (!text) {
              const plain = await adb.run(['-s', serial, 'shell', 'ps'], { timeout: 20000 });
              if (plain && plain.ok) text = plain.stdout || '';
            }
            const items = [];
            for (const l of String(text || '').split(/\r?\n/).slice(1)) {
              const t = l.trim(); if (!t) continue;
              const m = t.match(/^(\d+)\s+(\S+)/);
              if (m) { items.push({ pid: +m[1], name: m[2] }); continue; }
              const f = t.split(/\s+/);
              if (f.length >= 3 && /^\d+$/.test(f[1])) items.push({ pid: +f[1], name: f[f.length - 1] });
            }
            return { ok: !!text, items };
          },
          procsKill: async ({ serial, pid, name }) => {
            const r = await adb.run(['-s', serial, 'shell', 'kill -9 ' + (+pid || 0) + ' 2>/dev/null'], { timeout: 15000 });
            return { ok: r.ok, pid, name };
          },
          devFull: async ({ serial }) => {
            const r = await adb.run(['-s', serial, 'shell', 'getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release'], { timeout: 15000 });
            const lines = (r.stdout || '').split(/\r?\n/);
            return { ok: r.ok, manufacturer: lines[0] || '', model: lines[1] || '', android: lines[2] || '' };
          },
          logcat: async ({ serial, lines }) => {
            const r = await adb.run(['-s', serial, 'logcat', '-d', '-t', String(lines || 50)], { timeout: 15000 });
            return { ok: r.ok, output: (r.stdout || '').slice(-30000) };
          },
          settingsGet: async ({ serial, key }) => {
            const r = await adb.run(['-s', serial, 'shell', 'settings get global ' + key], { timeout: 15000 });
            return { ok: r.ok, value: (r.stdout || '').trim() };
          },
          // ===== ПОЛНЫЙ ДОСТУП для агента =====
          // произвольная shell-команда на устройстве (включая скрытые настройки,
          // отключение системных приложений, чтение любых данных)
          adbShell: async ({ serial, cmd, timeout }) => {
            if (!cmd) return { ok: false, error: 'Не указана команда' };
            const r = await adb.run(['-s', serial, 'shell', String(cmd)], { timeout: Math.min(300000, +timeout || 30000) });
            return { ok: r.ok, stdout: (r.stdout || '').slice(0, 60000), stderr: (r.stderr || '').slice(0, 4000), code: r.code };
          },
          // произвольные аргументы adb (push/pull/install/shell/forward/reboot и т.д.)
          adbRaw: async ({ args, timeout }) => {
            const arr = Array.isArray(args) ? args.map(String) : String(args || '').trim().split(/\s+/).filter(Boolean);
            if (!arr.length) return { ok: false, error: 'Не указаны аргументы adb' };
            const r = await adb.run(arr, { timeout: Math.min(600000, +timeout || 60000) });
            return { ok: r.ok, stdout: (r.stdout || '').slice(0, 60000), stderr: (r.stderr || '').slice(0, 4000), code: r.code };
          },
          // скрытые настройки Android: get/set/list для namespace global/secure/system
          settingsCmd: async ({ serial, op, ns, key, value }) => {
            const space = ['global', 'secure', 'system'].includes(ns) ? ns : 'global';
            const o = op === 'put' || op === 'set' ? 'put' : 'get';
            const cmd = o === 'put'
              ? 'settings put ' + space + ' ' + adb.shq(key) + ' ' + adb.shq(value)
              : 'settings ' + o + ' ' + space + ' ' + adb.shq(key);
            const r = await adb.run(['-s', serial, 'shell', cmd], { timeout: 15000 });
            return { ok: r.ok, value: (r.stdout || '').trim(), stderr: (r.stderr || '').slice(0, 500) };
          },
          settingsList: async ({ serial, ns }) => {
            const space = ['global', 'secure', 'system'].includes(ns) ? ns : 'global';
            const r = await adb.run(['-s', serial, 'shell', 'settings list ' + space], { timeout: 20000 });
            return { ok: r.ok, output: (r.stdout || '').slice(0, 60000) };
          },
          // ввод: тапы, свайпы, кнопки, текст
          inputTap: async ({ serial, x, y }) => adb.run(['-s', serial, 'shell', 'input', 'tap', String(x), String(y)], { timeout: 8000 }),
          inputSwipe: async ({ serial, x1, y1, x2, y2, ms }) => adb.run(['-s', serial, 'shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(ms || 300)], { timeout: 12000 }),
          inputKey: async ({ serial, key }) => adb.run(['-s', serial, 'shell', 'input', 'keyevent', String(key)], { timeout: 8000 }),
          inputText: async ({ serial, text }) => {
            const safe = String(text || '').replace(/[%\\"]/g, c => '\\' + c).replace(/\s/g, '%s');
            const r = await adb.run(['-s', serial, 'shell', 'input text ' + adb.shq(safe)], { timeout: 15000 });
            return { ok: r.ok, stderr: (r.stderr || '').slice(0, 300) };
          },
          inputKeyCombo: async ({ serial, combo }) => {
            const r = await adb.run(['-s', serial, 'shell', 'input keycombination ' + String(combo || '')], { timeout: 8000 });
            return { ok: r.ok, stderr: (r.stderr || '').slice(0, 300) };
          },
          // снимок экрана ТЕЛЕФОНА (PNG в папку «Сохранения\Агент»)
          deviceScreenState: async ({ serial }) => screenStateOf(serial),
          deviceUi: async ({ serial }) => {
            if (!serial) return { ok: false, error: 'Нет активного устройства' };
            const remote = '/sdcard/.adbwifi-ui.xml';
            const dump = await adb.run(['-s', serial, 'shell', 'uiautomator', 'dump', remote], { timeout: 25000 });
            const cat = await adb.run(['-s', serial, 'shell', 'cat', remote], { timeout: 25000 });
            adb.run(['-s', serial, 'shell', 'rm', '-f', remote], { timeout: 5000 }).catch(() => {});
            if (!cat.ok || !cat.stdout || !cat.stdout.trim()) {
              return {
                ok: false,
                error: ((dump.stderr || dump.stdout || cat.stderr || cat.stdout || 'uiautomator dump не вернул XML').trim()).slice(0, 500)
              };
            }
            const decode = (s) => String(s || '')
              .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
              .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
            const nodes = [];
            const nodeRe = /<node\b([^>]*?)\/?>/g;
            let match;
            while ((match = nodeRe.exec(cat.stdout)) && nodes.length < 600) {
              const attrs = {};
              const attrRe = /([\w:-]+)="([^"]*)"/g;
              let attr;
              while ((attr = attrRe.exec(match[1]))) attrs[attr[1]] = attr[2];
              nodes.push({
                text: decode(attrs.text),
                desc: decode(attrs['content-desc']),
                id: attrs['resource-id'] || '',
                cls: attrs.class || '',
                package: attrs.package || '',
                bounds: attrs.bounds || '',
                clickable: attrs.clickable === 'true',
                enabled: attrs.enabled !== 'false',
                selected: attrs.selected === 'true',
                checked: attrs.checked === 'true',
                focused: attrs.focused === 'true'
              });
            }
            return { ok: true, count: nodes.length, nodes, xml: cat.stdout.slice(0, 300000) };
          },
          deviceScreenshot: async ({ serial }) => {
            let screen = await screenStateOf(serial);
            if (screen.screenOn === false) {
              await adb.run(['-s', serial, 'shell', 'input keyevent 224'], { timeout: 8000 }).catch(() => null);
              await new Promise(r => setTimeout(r, 700));
              screen = await screenStateOf(serial);
            }
            if (screen.locked) return { ok: false, error: 'Экран заблокирован. Вызовите unlock_device (если сохранён PIN через unlock_set) или разблокируйте вручную.', screen };
            if (screen.screenOn === false) return { ok: false, error: 'Экран выключен и не просыпается — включите/разблокируйте устройство.', screen };
            const dir = path.join(SAVE_DIR, 'Агент');
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, 'device-' + stamp() + '.png');
            const r = await new Promise((resolve) => {
              const exe = adb.getAdbPath();
              const child = require('child_process').spawn(exe, ['-s', serial, 'exec-out', 'screencap', '-p'], { windowsHide: true });
              const chunks = [];
              const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve({ ok: false, error: 'таймаут снимка' }); }, 20000);
              child.stdout.on('data', d => chunks.push(d));
              child.on('close', () => {
                clearTimeout(to);
                const buf = Buffer.concat(chunks);
                if (!buf.length) return resolve({ ok: false, error: 'пустой ответ screencap' });
                try { fs.writeFileSync(file, buf); resolve({ ok: true, file, bytes: buf.length }); }
                catch (e) { resolve({ ok: false, error: e.message }); }
              });
              child.on('error', (e) => { clearTimeout(to); resolve({ ok: false, error: e.message }); });
            });
            return { ...r, screen };
          },
          // подробная информация о пакете (версия, код, дата установки, путь apk, права)
          pkgInfo: async ({ serial, pkg }) => {
            const r = await adb.run(['-s', serial, 'shell', 'dumpsys', 'package', String(pkg)], { timeout: 25000 });
            const t = r.stdout || '';
            const ver = (t.match(/versionName=([\w.\-]+)/) || [])[1] || '';
            const code = (t.match(/versionCode=(\d+)/) || [])[1] || '';
            const pathM = (t.match(/codePath=([^\r\n]+)/) || [])[1] || '';
            const first = (t.match(/firstInstallTime=([^\r\n]+)/) || [])[1] || '';
            const last = (t.match(/lastUpdateTime=([^\r\n]+)/) || [])[1] || '';
            const installed = /installed=true/i.test(t);
            return { ok: r.ok, installed, versionName: ver, versionCode: code, apkPath: pathM.trim(), firstInstall: first.trim(), lastUpdate: last.trim() };
          },
          appCrashes: async ({ serial, pkg, limit }) => crashlog.collect(serial, pkg, { limit }),
          appAudit: async ({ serial, pkg }) => appaudit.collect(serial, pkg),
          // поиск пакетов по подстроке
          findPackages: async ({ serial, query }) => {
            const q = String(query || '').toLowerCase();
            const r = await adb.run(['-s', serial, 'shell', 'pm list packages -f'], { timeout: 25000 });
            const all = (r.stdout || '').split(/\r?\n/).filter(Boolean)
              .map(l => { const m = l.match(/^package:(.+)=(.+)$/); return m ? { path: m[1], pkg: m[2] } : null; })
              .filter(Boolean);
            const hit = q ? all.filter(x => x.pkg.toLowerCase().includes(q) || x.path.toLowerCase().includes(q)) : all;
            return { ok: r.ok, count: hit.length, items: hit.slice(0, 200) };
          },
          // установка APK по локальному пути (полный цикл: push + pm install)
          installApk: async ({ serial, path: apkPath }) => {
            if (!apkPath || !fs.existsSync(apkPath)) return { ok: false, error: 'Файл не найден: ' + apkPath };
            const r = await adb.run(['-s', serial, 'install', '-r', '-g', apkPath], { timeout: 600000 });
            const out = ((r.stdout || '') + ' ' + (r.stderr || '')).trim();
            return { ok: r.ok && /Success/i.test(out), message: out.slice(0, 500) };
          },
          // выгрузка файла с телефона в папку «Сохранения\Агент»
          pullFile: async ({ serial, remote }) => {
            if (!remote) return { ok: false, error: 'Не указан путь на устройстве' };
            const dir = path.join(SAVE_DIR, 'Агент');
            fs.mkdirSync(dir, { recursive: true });
            const name = String(remote).split('/').pop() || 'file.bin';
            const dest = path.join(dir, name);
            const r = await adb.run(['-s', serial, 'pull', remote, dest], { timeout: 600000 });
            return { ok: r.ok, file: r.ok ? dest : null, message: ((r.stdout || '') + ' ' + (r.stderr || '')).trim().slice(0, 400) };
          },
          // загрузка файла с ПК на телефон
          pushFile: async ({ serial, local, remote }) => {
            if (!local || !fs.existsSync(local)) return { ok: false, error: 'Файл не найден: ' + local };
            if (!remote) return { ok: false, error: 'Не указан путь назначения на устройстве' };
            const r = await adb.run(['-s', serial, 'push', local, remote], { timeout: 600000 });
            return { ok: r.ok, message: ((r.stdout || '') + ' ' + (r.stderr || '')).trim().slice(0, 400) };
          },
          rebootDevice: async ({ serial, mode }) => {
            const m = ['', 'bootloader', 'recovery', 'sideload'].includes(String(mode || '')) ? String(mode || '') : '';
            const r = await adb.run(['-s', serial, 'reboot', ...(m ? [m] : [])], { timeout: 15000 });
            return { ok: r.ok, mode: m || 'system' };
          },
          usbRestart: async ({ serial }) => {
            const r = await adb.run(['-s', serial, 'shell', 'true'], { timeout: 5000 });
            return { ok: r.ok, note: 'Полная перезагрузка USB-порта — через UI-кнопку «Перезагрузить USB-порт»' };
          },
          // разблокировка сохранённым паролем (для MCP-агента и «Своих команд»)
          unlockDevice: async ({ serial, step, type }) => unlockDevice(serial, { step: step || 'full', type }),
          unlockStatus: async ({ serial }) => {
            const { rec, pin } = await unlockRead(serial);
            return { ok: true, has: !!pin, length: pin ? String(pin).length : 0, type: (rec && rec.type) || 'pin', model: (rec && rec.model) || null };
          },
          unlockList: async () => ({ ok: true, items: unlockList() }),
          unlockDelKey: async ({ key }) => {
            const st = unlockLoad();
            delete st[String(key || '')];
            unlockSave();
            return { ok: true, items: unlockList() };
          },
          unlockSet: async ({ serial, pin, type }) => {
            const p = String(pin || '');
            if (!p) return { ok: false, error: 'Пустой пароль' };
            if (!safeStorage || !safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Системное шифрование Windows недоступно' };
            const key = await unlockStorePin(serial, p, type);
            if (!key) return { ok: false, error: 'Не удалось зашифровать пароль' };
            return { ok: true, length: p.length, type: type === 'pattern' ? 'pattern' : 'pin' };
          },
          unlockDelete: async ({ serial }) => {
            await unlockRemove(serial);
            return { ok: true };
          },
          mirror: async () => ({ ok: false, error: 'Зеркало доступно через UI (визуальный режим)' })
        }
      });
      agentMcp.setEnabled(!!config.agentEnabled);
      agentMcp.startServer();
    }
if (config.assocOn) setTimeout(() => { assocStartupRepair().catch(() => {}); }, 1500);
    if (!miniOnly) {
      if (tray) { try { tray.destroy(); } catch (e) {} }
      ensureTray();
    }
    // файл, переданный ассоциацией при ПЕРВОМ запуске (argv[1])
    if (startupFile) setTimeout(() => {
      // в режиме «только установщик» главного окна нет — sendTask просто проигнорирует
      if (!openApkStandalone(startupFile)) {
        if (win && !win.isDestroyed()) { win.show(); win.focus(); }
        sendTask({ kind: 'open-apk', path: startupFile });
      }
    }, miniOnly ? 200 : 1200);

    // R3: автоподключение ТОЛЬКО если владелец явно включил его в настройках; при этом
    // подключается строго ОДНО устройство (последнее используемое / первое живое избранное)
    if (config.autolast && history.length) {
      const h = history[0];
      setTimeout(() => connectDevice(h.host, h.port), 1500);
    } else if (config.autoreconnect && favorites.length) {
      setTimeout(async () => {
        for (const f of favorites) {
          const r = await connectDevice(f.host, f.port);
          if (r.ok) break; // строго одно: до первого успеха
        }
      }, 1500);
    }
  });
  app.on('window-all-closed', () => { if (miniOnly || !config.closeToTray) app.quit(); });
  app.on('before-quit', (e) => {
    if (recordChild && !recordQuitClosing) {
      e.preventDefault();
      recordQuitClosing = true;
      quitting = true;
      const child = recordChild, meta = recordMeta;
      (async () => {
        let closed = false;
        try { closed = await closeScrcpyWindow(child.pid, meta && meta.hwnd); } catch (err) {}
        if (closed) await waitChildClose(child, 6000);
        if (recordChild === child) { try { child.kill('SIGKILL'); } catch (err) {} }
        app.quit();
      })();
      return;
    }
    quitting = true;
    try { if (trayMenuWin && !trayMenuWin.isDestroyed()) trayMenuWin.destroy(); } catch (err) {}
    trayMenuWin = null;
    try { if (tray) tray.destroy(); } catch (err) {}
    tray = null;
    // W4-ревизор: запись экрана добиваем СИГНАЛОМ НА УСТРОЙСТВЕ (SIGINT device-side):
    // device-screenrecord финализирует mp4-контейнер — файл остаётся играбельным,
    // и владелец найдёт его в Movies/ADB-WiFi-Connector (просто закрыл программу во время записи)
    // гасим ВСЕ свои дочерние процессы (A2-ревью: mirror/shell/install раньше переживали выход)
    stopMirrorAll();
    try { clipStop(true); } catch (e) {}
    try { if (shellChild) shellChild.kill('SIGKILL'); } catch (e) {}
    try { if (installChild) installChild.kill('SIGKILL'); } catch (e) {}
    try { if (logcatChild) logcatChild.kill('SIGKILL'); } catch (e) {}
    try { if (recordChild) recordChild.kill('SIGKILL'); } catch (e) {}
    try { if (cameraProc) cameraProc.kill('SIGKILL'); } catch (e) {}
    try { if (audioProc) audioProc.kill('SIGKILL'); } catch (e) {}
    try { execFile('taskkill', ['/F', '/IM', 'PhoneVirtualCam.exe'], { windowsHide: true }, () => {}); } catch (e) {}
    try { qrpair.cancel(); } catch (e) {}
    // не ждём adb kill-server (раньше runSync мог держать выход до 6 с)
    killAdbServerSoon();
  });
  // process.on('exit') с синхронным adb kill-server убран: он задерживал завершение.
}

function killAdbServerSoon() {
  try {
    const exe = adb.getAdbPath();
    if (!exe) return;
    const cp = require('child_process').spawn(exe, ['kill-server'], { detached: true, stdio: 'ignore', windowsHide: true });
    cp.on('error', () => {});
    cp.unref();
  } catch (e) {}
}




