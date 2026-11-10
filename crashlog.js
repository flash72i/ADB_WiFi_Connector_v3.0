// crashlog.js — сбор и разбор падений/ANR конкретного приложения из logcat.
// Работает через adb, ничего не устанавливает на телефон.
'use strict';
const adb = require('./adb');

const MAX_BLOCK = 24000;
const CONT_RE = /^(\s|\tat |at |Caused by:|Suppressed:|\s*\.\.\.|#\d+|native: #|backtrace:|Reason:|PID:|Frozen:|Load:|-----|Abort message:|pid: |signal )/;
const START_JAVA = /FATAL EXCEPTION/i;
const START_ANR = /ANR in\s+([^\s,]+)/i;
const START_NATIVE = /Fatal signal|Abort message|\*\*\* \*\*\* \*\*\*|signal \d+ \(SIG/i;

function parseLine(raw) {
  const m = raw.match(/^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^:]*?)\s*:\s?(.*)$/);
  if (!m) return null;
  return { date: m[1], time: m[2], ts: m[1] + ' ' + m[2], pid: m[3], tid: m[4], level: m[5], tag: m[6].trim(), msg: m[7] || '', raw };
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function parse(text, pkg) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const entries = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const e = parseLine(raw);
    if (e) entries.push(e);
    else if (entries.length) {
      const prev = entries[entries.length - 1];
      if (prev.msg.length < 4000) { prev.msg += '\n' + raw; prev.raw += '\n' + raw; }
    }
  }
  const pkgRe = new RegExp('(^|[^\\w.])(' + escapeRe(pkg) + ')(?![\\w.])', 'i');
  const meetsPkg = s => pkgRe.test(s);
  const blocks = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    let type = '';
    let title = '';
    const anr = e.msg.match(START_ANR);
    if (START_JAVA.test(e.msg)) { type = 'java'; title = e.msg.split('\n')[0]; }
    else if (anr) { type = 'anr'; title = 'ANR: ' + anr[1]; }
    else if (START_NATIVE.test(e.msg)) { type = 'native'; title = e.msg.split('\n')[0]; }
    if (!type) continue;
    const pid = e.pid;
    const nativeBlock = type === 'native';
    let end = i + 1;
    let blank = 0;
    for (; end < entries.length && end < i + 220; end++) {
      const n = entries[end];
      if (nativeBlock) {
        // у native-краша строка Fatal signal и блок DEBUG имеют РАЗНЫЕ PID
        if (/Fatal signal/i.test(n.msg) && end !== i) break;
        if (!n.raw.trim()) { if (++blank >= 2) break; }
        else blank = 0;
        continue;
      }
      if (n.pid !== pid) break;
      const isStart = START_JAVA.test(n.msg) || START_ANR.test(n.msg) || START_NATIVE.test(n.msg);
      if (isStart && end !== i) break;
      const cont = CONT_RE.test(n.msg) || n.tag === e.tag;
      if (!cont) { if (++blank >= 2) break; }
      else blank = 0;
      if (n.msg === '' && blank >= 1) break;
    }
    const textBlock = entries.slice(i, end).map(x => x.raw).join('\n');
    if (!meetsPkg(textBlock)) { i = Math.max(i, end - 1); continue; }
    blocks.push({
      time: e.ts, type, title: title.slice(0, 240), pid,
      text: textBlock.slice(0, MAX_BLOCK)
    });
    i = Math.max(i, end - 1);
  }
  // убираем дубли (один и тот же краш мог попасть в crash и main буферы)
  const seen = new Set();
  const uniq = [];
  for (const b of blocks) {
    const key = b.time + '|' + b.pid + '|' + b.type + '|' + b.title;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(b);
  }
  if (!uniq.length) {
    // явного краша нет — показываем последние E/F-строки этого приложения
    const errs = entries.filter(e => (e.level === 'E' || e.level === 'F') && meetsPkg(e.tag + ': ' + e.msg)).slice(-80);
    if (errs.length) {
      uniq.push({
        time: errs[errs.length - 1].ts, type: 'error', title: 'Ошибки приложения в логе', pid: errs[errs.length - 1].pid,
        text: errs.map(e => e.raw).join('\n').slice(0, MAX_BLOCK)
      });
    }
  }
  uniq.sort((a, b) => String(b.time).localeCompare(String(a.time)));
  return uniq;
}

function lineCount(s) { return String(s || '').split('\n').length; }

async function collect(serial, pkg, opts) {
  if (!serial) return { ok: false, error: 'Не выбрано устройство' };
  if (!pkg) return { ok: false, error: 'Не указан пакет' };
  const limit = Math.max(1, Math.min(50, parseInt((opts && opts.limit), 10) || 30));
  const [crash, main] = await Promise.all([
    adb.run(['-s', serial, 'logcat', '-d', '-v', 'threadtime', '-b', 'crash'], { timeout: 20000 }).catch(() => null),
    adb.run(['-s', serial, 'logcat', '-d', '-v', 'threadtime', '-b', 'main', '-t', '6000'], { timeout: 20000 }).catch(() => null)
  ]);
  if ((!crash || !crash.ok) && (!main || !main.ok)) {
    return { ok: false, error: (main && (main.stderr || main.error)) || (crash && (crash.stderr || crash.error)) || 'Не удалось прочитать logcat' };
  }
  const raw = [crash && crash.stdout, main && main.stdout].filter(Boolean).join('\n');
  const items = parse(raw, pkg).slice(0, limit);
  return {
    ok: true, serial, pkg, items, count: items.length,
    scanned: { crash: lineCount(crash && crash.stdout), main: lineCount(main && main.stdout) },
    note: items.length ? '' : 'В буфере logcat нет записей о сбоях этого приложения. Запустите его и повторите.'
  };
}

module.exports = { collect, parse };
