// adb.js — обёртка над adb.exe (spawn, парсинг вывода, операции)
'use strict';
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

let adbPath = null;
let configOverride = null;

function defaultAdbPath() {
  if (configOverride) return configOverride;
  // в упакованном виде: <resources>/adb/adb.exe ; в разработке: <app>/adb-bundle/adb.exe
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'adb', 'adb.exe'));
  candidates.push(path.join(__dirname, 'adb-bundle', 'adb.exe'));
  candidates.push('adb'); // из PATH
  for (const c of candidates) {
    try {
      if (c === 'adb') return c;
      if (fs.existsSync(c)) return c;
    } catch (e) {}
  }
  return null;
}

function setAdbPath(p) { configOverride = p || null; adbPath = defaultAdbPath(); return adbPath; }
function getAdbPath() { if (!adbPath) adbPath = defaultAdbPath(); return adbPath; }

// Кавычка для аргументов adb shell: adb склеивает argv пробелами и передаёт на
// УСТРОЙСТВЕННЫЙ shell — путь «/sdcard/DCIM/Мои клипы» без кавычек разваливается на
// два слова, и устройство отвечает «ls: клипы: No such file or directory» (жалоба F1).
function shq(s) {
  s = String(s == null ? '' : s);
  if (/^[A-Za-z0-9_@%+=:,./\-]+$/.test(s)) return s; // безопасно и так
  return "'" + s.replace(/'/g, "'\\''") + "'";       // POSIX-одинарные кавычки
}
// ВАЖНО: кавычить нужно ТОЛЬКО пути/имена, не ключи и не служебные слова.
function shellJoin(args) { return args.map(shq).join(' '); }

function run(args, opts = {}) {
  return new Promise((resolve) => {
    const exe = getAdbPath();
    if (!exe) return resolve({ ok: false, error: 'adb не найден. Укажите путь к adb.exe в настройках.', code: 'NO_ADB' });
    // ADB_MDNS=0 глушит mDNS-транспорт adb-сервера НАВСЕГДА (сервер наследует env первого клиента):
    // из-за этого «adb mdns services» всегда пуст и adb auto-connect после pair не работает (корень
    // жалобы «QR подключается бесконечно»). Вместо глушения отключаем только АВТО-подключение —
    // единственность активного устройства контролирует приложение (enforceSingleDevice в main.js).
    const child = spawn(exe, args, { windowsHide: true, env: Object.assign({}, process.env, { ADB_MDNS_AUTO_CONNECT: '0' }) });
    let out = '', err = '';
    const to = opts.timeout || 20000;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, to);
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: 'Не удалось запустить adb: ' + e.message, code: 'SPAWN' }); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: out, stderr: err });
    });
    if (opts.stdin) { child.stdin.write(opts.stdin); child.stdin.end(); }
  });
}

async function version() {
  const r = await run(['version'], { timeout: 8000 });
  if (!r.ok) return { ok: false, error: r.error || r.stderr, path: getAdbPath() };
  const m = r.stdout.match(/Android Debug Bridge version ([0-9.]+)/);
  return { ok: true, version: m ? m[1] : '?', path: getAdbPath() };
}

async function devices() {
  const r = await run(['devices', '-l']);
  if (!r.ok) return { ok: false, error: r.stderr || r.error, list: [] };
  const list = [];
  for (const line of r.stdout.split(/\r?\n/).slice(1)) {
    const t = line.trim();
    if (!t || t.startsWith('*')) continue;
    const m = t.match(/^(\S+)\s+(\w+)(.*)$/);
    if (!m) continue;
    const props = {};
    for (const kv of m[3].trim().split(/\s+/)) {
      const p = kv.split(':');
      if (p.length === 2) props[p[0]] = p[1];
    }
    list.push({ serial: m[1], state: m[2], props });
  }
  return { ok: true, list };
}

async function modelName(serial) {
  const r = await run(['-s', serial, 'shell', 'getprop', 'ro.product.model'], { timeout: 6000 });
  const model = r.ok ? r.stdout.trim() : '';
  const r2 = await run(['-s', serial, 'shell', 'getprop', 'ro.build.version.release'], { timeout: 6000 });
  const android = r2.ok ? r2.stdout.trim() : '';
  return { model, android };
}

async function connect(host, port) {
  const target = `${host}:${port}`;
  const r = await run(['connect', target], { timeout: 15000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = /connected to/i.test(out) && !/cannot|failed|unable/i.test(out);
  return { ok, message: out.trim(), target };
}

async function disconnect(serial) {
  // без явного serial «adb disconnect» отключает ВСЁ сетевое — запрещаем (защита от пустого аргумента)
  if (!serial || !String(serial).includes(':')) return { ok: false, message: 'Нужен serial вида host:port' };
  const r = await run(['disconnect', String(serial)], { timeout: 10000 });
  return { ok: r.ok, message: (r.stdout || r.stderr).trim() };
}

async function pair(host, port, code, onLog) {
  const exe = getAdbPath();
  if (!exe) return { ok: false, error: 'adb не найден' };
  return new Promise((resolve) => {
    // код сопряжения передаём аргументом: надёжно и для 6-значного кода, и для QR-пароля (FIX-9)
    const child = spawn(exe, ['pair', `${host}:${port}`, String(code)], { windowsHide: true });
    let out = '', sent = false, done = false;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {}
      if (!done) { done = true; resolve({ ok: false, error: 'Таймаут сопряжения (30 с)', out }); } }, 30000);
    const feed = (chunk) => {
      out += chunk;
      if (onLog) onLog(chunk);
      if (!sent && /pairing code/i.test(out)) {
        sent = true;
        try { child.stdin.write(String(code) + '\n'); child.stdin.end(); } catch (e) {}
      }
    };
    child.stdout.on('data', d => feed(d.toString('utf8')));
    child.stderr.on('data', d => feed(d.toString('utf8')));
    child.on('error', e => { clearTimeout(timer); if (!done) { done = true; resolve({ ok: false, error: e.message, out }); } });
    child.on('close', c => {
      clearTimeout(timer);
      if (done) return; done = true;
      const ok = /successfully paired/i.test(out);
      resolve({ ok, message: out.trim(), out });
    });
  });
}

async function mdnsServices() {
  const r = await run(['mdns', 'services'], { timeout: 8000 });
  const items = [];
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    // современный platform-tools печатает ТЕБ-разделённые строки: instance<TAB>_adb-…._tcp<TAB>ip:port
    let m = line.match(/^([^\t]*)\t(_adb[a-z-]*\._tcp\.?)\t(.+):(\d+)\s*$/);
    if (!m) {
      // фолбэк на старый формат (пробелы, порт с ведущим двоеточием)
      m = line.match(/^(\S+)\s+(_adb[a-z-]*\._tcp)\s+(\S+?):(\d+)\s*$/);
    }
    if (m && m[3] && !m[3].includes(':')) {
      items.push({ name: m[1].trim(), instance: m[1].trim(), service: m[2], host: m[3], port: parseInt(m[4], 10), raw: line.trim() });
    }
  }
  return { ok: r.ok, items };
}

// Быстрое сканирование подсети: TCP-подключение к порту 5555
function scanSubnet(onProgress, concurrency = 64, portList = [5555]) {
  const ifaces = os.networkInterfaces();
  const bases = new Set();
  for (const key of Object.keys(ifaces)) {
    for (const a of ifaces[key] || []) {
      if (a.family === 'IPv4' && !a.internal) {
        const p = a.address.split('.');
        bases.add(p.slice(0, 3).join('.'));
      }
    }
  }
  const found = [];
  const tasks = [];
  for (const base of bases) for (let i = 1; i <= 254; i++) tasks.push({ host: `${base}.${i}` });
  let idx = 0, finished = 0;
  return new Promise((resolve) => {
    if (!tasks.length) return resolve(found);
    const total = tasks.length * portList.length;
    const next = () => {
      const t = tasks[idx++];
      if (!t) return;
      let pending = portList.length;
      for (const port of portList) {
        const sock = net.connect({ host: t.host, port, timeout: 700 });
        const fin = (open) => {
          try { sock.destroy(); } catch (e) {}
          if (open) found.push({ host: t.host, port });
          if (--pending === 0) {
            finished++;
            if (onProgress) onProgress(finished, total);
            if (finished === total) resolve(found);
            else next();
          }
        };
        sock.once('connect', () => fin(true));
        sock.once('timeout', () => fin(false));
        sock.once('error', () => fin(false));
      }
    };
    for (let i = 0; i < Math.min(concurrency, tasks.length); i++) next();
  });
}

function shellCmd(serial, args, timeout = 15000) { return run(['-s', serial, 'shell', ...args], { timeout }); }

// shell-команда с ПРАВИЛЬНОЙ кавычкой аргументов (пути с пробелами/кириллицей не разваливаются)
async function shellRun(serial, args, opts = {}) {
  return run(['-s', serial, 'shell', shellJoin(args)], Object.assign({ timeout: 15000 }, opts));
}

async function screenshot(serial, dest) {
  const exe = getAdbPath();
  return new Promise((resolve) => {
    const child = spawn(exe, ['-s', serial, 'exec-out', 'screencap', '-p'], { windowsHide: true });
    const chunks = [];
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve({ ok: false, error: 'Таймаут снимка экрана' }); }, 20000);
    child.stdout.on('data', d => chunks.push(d));
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', c => {
      clearTimeout(timer);
      if (c !== 0) return resolve({ ok: false, error: 'screencap завершился с кодом ' + c });
      try { fs.writeFileSync(dest, Buffer.concat(chunks)); resolve({ ok: true, file: dest, bytes: Buffer.concat(chunks).length }); }
      catch (e) { resolve({ ok: false, error: e.message }); }
    });
  });
}

function startRecord(serial, remotePath) {
  const exe = getAdbPath();
  const child = spawn(exe, ['-s', serial, 'shell', 'screenrecord', '--time-limit', '180', remotePath], { windowsHide: true });
  return child;
}

async function pull(serial, remotePath, dest) {
  const r = await run(['-s', serial, 'pull', remotePath, dest], { timeout: 120000 });
  return { ok: r.ok, message: (r.stdout || r.stderr).trim() };
}

async function installApk(serial, apkPath, onLog) {
  const exe = getAdbPath();
  return new Promise((resolve) => {
    const child = spawn(exe, ['-s', serial, 'install', '-r', apkPath], { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve({ ok: false, error: 'Таймаут установки' }); }, 180000);
    child.stdout.on('data', d => { out += d; if (onLog) onLog(d.toString()); });
    child.stderr.on('data', d => { out += d; if (onLog) onLog(d.toString()); });
    child.on('close', c => {
      clearTimeout(timer);
      const ok = /success/i.test(out);
      resolve({ ok, message: out.trim() });
    });
  });
}

function startLogcat(serial, onLine) {
  const exe = getAdbPath();
  const child = spawn(exe, ['-s', serial, 'logcat', '-v', 'time'], { windowsHide: true });
  let buf = '';
  child.stdout.on('data', d => {
    buf += d.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    if (lines.length && onLine) onLine(lines);
  });
  return child;
}

async function pingDevice(serial) {
  const t0 = Date.now();
  const r = await run(['-s', serial, 'shell', 'echo', 'pong'], { timeout: 6000 });
  return { ok: r.ok && /pong/.test(r.stdout), ms: Date.now() - t0 };
}

// Синхронный запуск (для корректного завершения при выходе приложения)
function runSync(args, timeoutMs = 8000) {
  const exe = getAdbPath();
  if (!exe) return { ok: false, error: 'adb не найден' };
  try {
    const r = require('child_process').spawnSync(exe, args, {
      windowsHide: true, timeout: timeoutMs, encoding: 'utf8'
    });
    return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (e) { return { ok: false, error: e.message }; }
}

function killServer() { return runSync(['kill-server'], 6000); }

// Сканирование диапазона портов беспроводной отладки на одном хосте.
// режим раннего выхода (opts.early) — как только найден первый открытый порт,
// ждём graceMs и возвращаем найденное.
// КОРРЕКЦИЯ ДИАПАЗОНА — Android выделяет порты беспроводной отладки из ЭФЕМЕРНОГО
// диапазона Linux 32768–60999; прежний свип 30000–44999 ПРОПУСКАЛ порты 45000–60999,
// из-за чего на сетях с «резаным» multicast (когда прямой перебор — единственный источник)
// сопряжение по QR не находило телефон вовсе («QR не работает»). Новый диапазон покрывает
// весь эфемерный диапазон; ранний выход сохраняет скорость.
function portRangeScan(host, from = 32768, to = 60999, concurrency = 420, timeoutMs = 320, opts = {}) {
  const early = !!opts.early;
  const graceMs = Math.max(200, opts.graceMs || 900);
  const onFound = typeof opts.onFound === 'function' ? opts.onFound : null;
  return new Promise((resolve) => {
    const open = [];
    let next = from;
    let active = 0;
    let finished = false;
    let firstFoundAt = 0;
    let earlyTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(earlyTimer);
      resolve(open.sort((a, b) => a - b));
    };
    const maybeEarlyExit = () => {
      if (!early || !open.length || finished) return;
      if (!firstFoundAt) { firstFoundAt = Date.now(); }
      if (!earlyTimer) earlyTimer = setTimeout(finish, graceMs);
    };
    const tick = () => {
      if (finished) return;
      while (active < concurrency && next <= to) {
        const port = next++;
        active++;
        tcpProbe(host, port, timeoutMs).then(ok => {
          if (ok) { open.push(port); if (onFound) try { onFound(port); } catch (e) {} }
          active--;
          if (finished) return;
          if (next > to && active === 0) finish();
          else { maybeEarlyExit(); tick(); }
        });
      }
    };
    tick();
  });
}

// Быстрый свип: ранний выход после первого найденного порта (скорость сопряжения)
// диапазон 32768–60999 (см. portRangeScan) + onFound: раньше pairing-порт мог быть
// найден в середине свипа, а pair по нему начинался только после grace-паузы — теперь main
// может пробовать каждый найденный порт НЕМЕДЛЕННО (onFound вызывается сразу).
function portScanFast(host, opts = {}) {
  return portRangeScan(host, 32768, 60999, 420, 320, Object.assign({ early: true, graceMs: 900 }, opts));
}

// Быстрый TCP-пробник host:port
function tcpProbe(host, port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: timeoutMs });
    const fin = (ok) => { try { sock.destroy(); } catch (e) {} resolve(ok); };
    sock.once('connect', () => fin(true));
    sock.once('timeout', () => fin(false));
    sock.once('error', () => fin(false));
  });
}

module.exports = {
  setAdbPath, getAdbPath, run, runSync, killServer, tcpProbe, portRangeScan, portScanFast, version, devices, modelName, connect, disconnect,
  pair, mdnsServices, scanSubnet, shellCmd, shellRun, shq, shellJoin, screenshot, startRecord, pull,
  installApk, startLogcat, pingDevice
};
