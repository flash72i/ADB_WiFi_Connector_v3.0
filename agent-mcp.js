// agent-mcp.js — встроенный MCP-сервер для ИИ-агента.
// Даёт агенту два режима:
//   1) визуальное управление интерфейсом (UI-дерево, клики, поля, скролл, скриншоты),
//   2) прямое управление логикой (состояние, команды, задачи, логи, настройки, устройства).
// Транспорт: HTTP POST /mcp (JSON-RPC 2.0) + GET /mcp/schema (README tools). Без внешних
// зависимостей. Все действия выполняются в main-процессе асинхронно; UI не блокируется.
// Управление включается в Настройках (тумблер «Управление агентом») и кнопкой аварийной остановки.

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TOKEN_ENV = process.env.MCP_TOKEN || '';
const PORT = (() => {
  const m = process.argv.find(a => a.indexOf('--mcp-port=') === 0);
  if (m) { const v = parseInt(m.split('=')[1], 10); if (v > 0 && v < 65536) return v; }
  return 3939;
})();

// ---------- состояние агента ----------
const state = {
  enabled: false,          // мастер-тумблер (Настройки) — дублируется в config.agentEnabled
  running: false,          // идёт ли серия действий агента
  stopRequested: false,    // аварийная остановка
  currentTool: null,
  startedAt: 0,
  lastStep: null,
  stepCount: 0
};

const tasks = [];          // реестр задач: {id, kind, title, status, progress, startedAt, finishedAt, result, error}
let taskSeq = 0;
const log = [];            // кольцевой журнал действий агента (в памяти, последние 200)
const MAX_LOG = 200;

function agentLog(level, tool, args, result) {
  const rec = { ts: new Date().toISOString(), level, tool, args: safeArgs(args), result: safeArgs(result) };
  log.push(rec);
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
  try {
    const p = path.join(process.env.APPDATA || os.tmpdir(), 'ADB Wi-Fi Коннектор', 'agent-log.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(rec) + '\n');
  } catch (e) {}
}

function safeArgs(v) {
  if (v == null) return null;
  try { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 600 ? s.slice(0, 600) + '…' : s; }
  catch (e) { return String(v).slice(0, 600); }
}

// ---------- доступ к приложению (инъекция зависимостей из main) ----------
let appRef = null;   // { getWin, getStateFn, callFns, config, saveConfig, getLogs, getErrors, ui: {...} }
function initApp(ref) { appRef = ref; }

function needWin() {
  const w = appRef && appRef.getWin();
  if (!w || w.isDestroyed()) throw new Error('Окно программы закрыто');
  return w;
}

// ---------- JSON-RPC ----------
function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, data: data || undefined } };
}
function rpcOk(id, result) { return { jsonrpc: '2.0', id, result }; }

function authOk(req, token) {
  if (!token) return true; // токен не задан — разрешено локально
  const h = (req.headers.authorization || '');
  return h === 'Bearer ' + token;
}

// ---------- tools: режим 1 (UI) ----------
const uiTools = {

  // Получить список окон приложения
  async get_app_window() {
    const w = appRef && appRef.getWin();
    const wins = [];
    if (w && !w.isDestroyed()) {
      const b = w.getBounds();
      wins.push({
        id: 'main', title: w.getTitle(), visible: w.isVisible(), focused: w.isFocused(),
        minimized: w.isMinimized(), maximized: w.isMaximized(),
        bounds: { x: b.x, y: b.y, width: b.width, height: b.height }
      });
      try {
        const all = require('electron').BrowserWindow.getAllWindows();
        for (const win2 of all) {
          if (win2 === w || win2.isDestroyed()) continue;
          const bb = win2.getBounds();
          wins.push({ id: 'w' + win2.id, title: win2.getTitle(), visible: win2.isVisible(), bounds: { x: bb.x, y: bb.y, width: bb.width, height: bb.height } });
        }
      } catch (e) {}
    }
    return { ok: true, windows: wins };
  },

  // Полное дерево интерфейса: окно, разделы, видимые интерактивные элементы с координатами
  async get_ui_tree() {
    const w = needWin();
    const dump = await w.webContents.executeJavaScript(`(function(){
      function nodeInfo(el){
        const r = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        const out = {
          tag, id: el.id || '', cls: typeof el.className === 'string' ? el.className : '',
          text: (el.innerText || el.value || el.textContent || '').trim().slice(0, 120),
          x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
          visible: r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden',
          disabled: !!el.disabled, checked: el.checked === true, selected: el.selected === true,
          type: el.type || '', value: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') ? (el.value || '') : undefined,
          role: el.getAttribute && (el.getAttribute('role') || '')
        };
        return out;
      }
      const res = { pages: [], controls: [] };
      document.querySelectorAll('.page').forEach(p => {
        res.pages.push({ id: p.id, active: p.classList.contains('active'), title: (p.querySelector('h1') || {}).textContent || '' });
      });
      const activePage = [].find.call(document.querySelectorAll('.page'), p => p.classList.contains('active'));
      const selectors = 'button,a,input,select,textarea,.chip,.rail-item,label[class*=switch-row],.fs-ctx-item,.view-item,[role=button],[role=tab],summary';
      const seen = new Set();
      document.querySelectorAll(selectors).forEach(el => {
        if (el.closest('.hidden') && !el.closest('.hidden').classList.contains('active')) return;
        if (!el.offsetParent && el.tagName !== 'INPUT') return;
        const info = nodeInfo(el);
        if (!info.visible) return;
        const key = info.tag + '|' + info.text + '|' + info.x + '|' + info.y;
        if (seen.has(key)) return; seen.add(key);
        res.controls.push(info);
      });
      res.title = document.title;
      res.activePage = activePage ? activePage.id : null;
      res.size = { w: window.innerWidth, h: window.innerHeight };
      return res;
    })()`, true).catch(e => { throw new Error('Не удалось прочитать интерфейс: ' + e.message); });
    return { ok: true, ...dump };
  },

  // Активный раздел/вкладка
  async get_active_tab() {
    const w = needWin();
    const d = await w.webContents.executeJavaScript(`(function(){
      const p = document.querySelector('.page.active');
      const tabs = [];
      document.querySelectorAll('.tab').forEach(t => { if (t.offsetParent) tabs.push({ id: t.id, text: (t.textContent||'').trim(), active: t.classList.contains('act') }); });
      return { activePage: p ? p.id : null, title: p ? (p.querySelector('h1')||{}).textContent||'' : '', visibleTabs: tabs };
    })()`, true);
    return { ok: true, ...d };
  },

  // выполнить произвольное выражение в главном окне (диагностика/продвинутое
  // управление). Код выполняется в renderer; результат сериализуется. Поддерживаются
  // Promise (executeJavaScript сам дожидается их, если вернуть thenable из IIFE).
  async run_js(p) {
    const w = needWin();
    const code = String(p || '');
    if (!code.trim()) return { ok: false, error: 'Пустой код' };
    const res = await w.webContents.executeJavaScript(`(function(){
      try {
        const v = eval(${JSON.stringify(code)});
        if (v && typeof v.then === 'function') {
          return v.then(x => ({ ok: true, value: JSON.stringify(x) }), e => ({ ok: false, error: (e && e.message) || String(e) }));
        }
        return { ok: true, value: JSON.stringify(v) };
      } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
    })()`, true).catch(e => ({ ok: false, error: 'executeJavaScript: ' + e.message }));
    // value приходит строкой JSON — распаковываем, чтобы агенту было удобно
    if (res && res.ok && typeof res.value === 'string') { try { res.value = JSON.parse(res.value); } catch (e) {} }
    agentLog('info', 'run_js', { p: code.slice(0, 120) }, res);
    return res;
  },

  // Поиск элемента по id/тексту/селектору/координатам
  async find_element(sel) {
    const spec = sel || '';
    const query = typeof spec === 'string' ? spec : JSON.stringify(spec);
    const w = needWin();
    return await w.webContents.executeJavaScript(`(function(){
      const spec = ${JSON.stringify(spec)};
      const byText = (root, txt) => {
        const norm = s => (s||'').replace(/[\\u{1F000}-\\u{1FAFF}\\u2600-\\u27BF\\uFE0F]/gu,'').replace(/\\s+/g,' ').trim();
        const want = norm(txt).toLowerCase();
        const els = root.querySelectorAll('button,a,span,.chip,.rail-item,input,select,label,[data-tip],[data-c]');
        for (const el of els) {
          if (!el.offsetParent) continue;
          const t = norm(el.innerText || el.textContent || el.value || '');
          if (t === norm(txt) || t === want || t.indexOf(norm(txt)) === 0 || t.toLowerCase().indexOf(want) !== -1) return el;
        }
        return null;
      };
      let el = null;
      if (typeof spec === 'string') {
        const s = spec.trim();
        if (s.startsWith('#')) el = document.getElementById(s.slice(1));
        else if (s.startsWith('/') || s.startsWith('.')) { try { el = document.querySelector(s); } catch(e){} }
        else el = byText(document, s) || (document.querySelector('[data-tip="'+s.replace(/"/g,'')+'"]'));
      }
      if (!el) return { ok: false, error: 'Элемент не найден: ' + String(spec) };
      const r = el.getBoundingClientRect();
      return { ok: true, id: el.id || '', tag: el.tagName.toLowerCase(), text: (el.innerText||el.value||'').trim().slice(0,120),
        x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
        visible: r.width>0 && r.height>0, center: { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } };
    })()`, true);
  },

  async click_element(p, pos) {
    const found = await this.find_element(p);
    if (!found.ok) return found;
    const w = needWin();
    const res = await w.webContents.executeJavaScript(`(function(){
      const r = {x:${found.center.x}, y:${found.center.y}};
      const el = document.elementFromPoint(r.x, r.y);
      if (!el) return { ok:false, error:'Ничего не под точкой клика' };
      const target = el.closest('button,a,.chip,.rail-item,input,select,label,.fs-ctx-item') || el;
      const prev = target.disabled;
      target.click();
      return { ok:true, clicked: target.tagName.toLowerCase()+':'+(target.innerText||target.value||'').trim().slice(0,60), wasDisabled: !!prev };
    })()`, true);
    agentLog('info', 'click_element', { p, pos }, res);
    return res;
  },

  async double_click_element(p) {
    const found = await this.find_element(p);
    if (!found.ok) return found;
    const w = needWin();
    const res = await w.webContents.executeJavaScript(`(function(){
      const el = document.elementFromPoint(${found.center.x}, ${found.center.y});
      const target = el ? (el.closest('button,a,.chip,input,select,.fs-row') || el) : null;
      if (!target) return { ok:false, error:'Ничего под точкой' };
      target.dispatchEvent(new MouseEvent('dblclick', { bubbles:true, clientX:${found.center.x}, clientY:${found.center.y} }));
      return { ok:true, target: target.className || target.tagName };
    })()`, true);
    agentLog('info', 'double_click_element', { p }, res);
    return res;
  },

  async right_click_element(p) {
    const found = await this.find_element(p);
    if (!found.ok) return found;
    const w = needWin();
    const res = await w.webContents.executeJavaScript(`(function(){
      const el = document.elementFromPoint(${found.center.x}, ${found.center.y});
      const target = el || document.body;
      const ev = new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:${found.center.x}, clientY:${found.center.y} });
      target.dispatchEvent(ev);
      return { ok:true, target: (target.className||target.tagName).toString() };
    })()`, true);
    agentLog('info', 'right_click_element', { p }, res);
    return res;
  },

  async hover_element(p) {
    const found = await this.find_element(p);
    if (!found.ok) return found;
    const w = needWin();
    await w.webContents.executeJavaScript(`(function(){
      const el = document.elementFromPoint(${found.center.x}, ${found.center.y}) || document.body;
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles:true, clientX:${found.center.x}, clientY:${found.center.y} }));
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles:true, clientX:${found.center.x}, clientY:${found.center.y} }));
    })()`, true);
    return { ok: true, ...found };
  },

  // Прокрутка: направление (up/down/left/right), опционально пиксели или элемент
  async scroll(p, px) {
    const w = needWin();
    const spec = p || 'down'; const amt = px == null ? 300 : +px;
    const expr = `(function(){
      const spec = ${JSON.stringify(spec)};
      const amt = ${amt};
      const sc = document.querySelector('.page.active') || document.scrollingElement || document.documentElement;
      const scrollRunner = (dx, dy) => { sc.scrollBy({ left: dx, top: dy }); return { x: sc.scrollLeft||0, y: sc.scrollTop||0 }; };
      if (typeof spec === 'object' && spec.element) { return { ok:false, error:'element-scroll не поддержан, используйте селектор в to' }; }
      if (typeof spec === 'string') {
        const s = spec.toLowerCase();
        if (s === 'top' || s === 'start') { sc.scrollTop = 0; return { ok:true, y:0 }; }
        if (s === 'bottom' || s === 'end') { sc.scrollTop = sc.scrollHeight; return { ok:true, y: sc.scrollTop }; }
        if (s === 'up') return { ok:true, ...scrollRunner(0, -amt) };
        if (s === 'down') return { ok:true, ...scrollRunner(0, amt) };
        if (s === 'left') return { ok:true, ...scrollRunner(-amt, 0) };
        if (s === 'right') return { ok:true, ...scrollRunner(amt, 0) };
      }
      return { ok:false, error:'Неизвестное направление: ' + spec };
    })()`;
    const res = await w.webContents.executeJavaScript(expr, true);
    agentLog('info', 'scroll', { p, px }, res);
    return res;
  },

  async set_text(p, text) {
    const found = await this.find_element(p);
    if (!found.ok) return found;
    const w = needWin();
    const res = await w.webContents.executeJavaScript(`(function(){
      const spec = ${JSON.stringify(p)};
      const el = ${found.id ? 'document.getElementById(' + JSON.stringify(found.id) + ')' : 'null'} || document.activeElement || document.querySelector('input:not([type=hidden]),textarea');
      if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return { ok:false, error:'Это не поле ввода' };
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      if (setter && setter.set) setter.set.call(el, ${JSON.stringify(String(text))});
      else el.value = ${JSON.stringify(String(text))};
      el.dispatchEvent(new Event('input', { bubbles:true }));
      el.dispatchEvent(new Event('change', { bubbles:true }));
      return { ok:true, value: el.value.slice(0,120) };
    })()`, true);
    agentLog('info', 'set_text', { p, text }, res);
    return res;
  },

  async clear_text(p) {
    const found = await this.find_element(p);
    if (!found.ok) return found;
    const w = needWin();
    const res = await w.webContents.executeJavaScript(`(function(){
      const el = document.activeElement || document.querySelector('input:not([type=hidden]),textarea');
      if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return { ok:false, error:'Это не поле ввода' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      if (setter && setter.set) setter.set.call(el, ''); else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles:true }));
      el.dispatchEvent(new Event('change', { bubbles:true }));
      return { ok:true };
    })()`, true);
    agentLog('info', 'clear_text', { p }, res);
    return res;
  },

  async select_option(p, value) {
    const found = await this.find_element(p);
    const w = needWin();
    const selId = found.ok ? (found.id ? JSON.stringify(found.id) : 'null') : 'null';
    const res = await w.webContents.executeJavaScript(`(function(){
      const sel = ${selId} ? document.getElementById(${selId}) : document.querySelector('select');
      if (!sel || sel.tagName !== 'SELECT') return { ok:false, error:'Не найден выпадающий список' };
      const v = ${JSON.stringify(String(value))};
      let done = false;
      for (const opt of sel.options) {
        if (opt.value === v || opt.textContent.trim() === v) { sel.value = opt.value; done = true; break; }
      }
      if (!done && /^\\d+$/.test(v)) { const i = +v; if (i < sel.options.length) { sel.selectedIndex = i; done = true; } }
      if (!done) return { ok:false, error:'Вариант не найден в списке' };
      sel.dispatchEvent(new Event('change', { bubbles:true }));
      return { ok:true, selected: sel.options[sel.selectedIndex].textContent.trim(), value: sel.value };
    })()`, true);
    agentLog('info', 'select_option', { p, value }, res);
    return res;
  },

  async set_checkbox(p, on) {
    const found = await this.find_element(p);
    const w = needWin();
    const target = found.ok ? (found.id ? JSON.stringify(found.id) : '') : '';
    const res = await w.webContents.executeJavaScript(`(function(){
      let el = ${target ? 'document.getElementById(' + target + ')' : 'null'};
      if (!el) { /* ищем чекбокс в строке/рядом с текстом */
        const labels = document.querySelectorAll('.switch-row,label');
        for (const l of labels) { const t=(l.innerText||'').trim(); if (t.indexOf(${JSON.stringify(String(p))})!==-1) { const cb=l.querySelector('input[type=checkbox]'); if(cb){ el=cb; break; } } }
      }
      if (!el) el = document.querySelector('input[type=checkbox]');
      if (!el) return { ok:false, error:'Чекбокс не найден' };
      const want = ${!!on};
      if (el.checked !== want) { el.click(); }
      return { ok:true, checked: el.checked };
    })()`, true);
    agentLog('info', 'set_checkbox', { p, on }, res);
    return res;
  },

  async select_tab(p) {
    const w = needWin();
    const res = await w.webContents.executeJavaScript(`(function(){
      const spec = ${JSON.stringify(String(p))};
      const norm = s => (s||'').replace(/[\\u{1F000}-\\u{1FAFF}\\u2600-\\u27BF\\uFE0F]/gu,'').replace(/\\s+/g,' ').trim();
      const want = norm(spec).toLowerCase();
      const items = document.querySelectorAll('#rail .rail-item, .tab, [data-page]');
      for (const it of items) {
        const txt = norm(it.textContent);
        const page = it.getAttribute('data-page') || '';
        if (txt === want || txt.indexOf(spec) !== -1 || txt.toLowerCase().indexOf(want) !== -1 || page === spec || page.toLowerCase() === want) { it.click(); return { ok:true, clicked: txt||page }; }
      }
      return { ok:false, error:'Вкладка/раздел не найден: ' + spec };
    })()`, true);
    agentLog('info', 'select_tab', { p }, res);
    return res;
  },

  async open_window(p) {
    return this.select_tab(p);
  },

  async close_window(id) {
    const w = needWin();
    if (id === 'main' || !id) {
      const res = await w.webContents.executeJavaScript(`(function(){
        const ov = document.querySelector('.overlay:not(.hidden) .dlg-x');
        if (ov) { ov.click(); return { ok:true, msg:'закрыт диалог' }; }
        return { ok:false, error:'Нет открытых диалогов' };
      })()`, true);
      return res;
    }
    try {
      const win2 = require('electron').BrowserWindow.getAllWindows().find(x => 'w' + x.id === id);
      if (win2 && !win2.isDestroyed()) { win2.close(); return { ok: true }; }
    } catch (e) {}
    return { ok: false, error: 'Окно не найдено' };
  },

  async drag_and_drop(p, x, y) {
    const found = await this.find_element(p);
    if (!found.ok) return found;
    const w = needWin();
    const res = await w.webContents.executeJavaScript(`(function(){
      const src = document.elementFromPoint(${found.center.x}, ${found.center.y});
      const dst = document.elementFromPoint(${x}, ${y});
      if (!src || !dst) return { ok:false, error:'Точки вне окна' };
      src.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, clientX:${found.center.x}, clientY:${found.center.y} }));
      dst.dispatchEvent(new MouseEvent('mousemove', { bubbles:true, clientX:${x}, clientY:${y} }));
      dst.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, clientX:${x}, clientY:${y} }));
      return { ok:true };
    })()`, true);
    agentLog('info', 'drag_and_drop', { p, x, y }, res);
    return res;
  },

  async read_element(p) {
    const found = await this.find_element(p);
    if (!found.ok) return found;
    const w = needWin();
    const res = await w.webContents.executeJavaScript(`(function(){
      const el = ${found.id ? 'document.getElementById(' + JSON.stringify(found.id) + ')' : 'null'} || document.elementFromPoint(${found.center.x}, ${found.center.y});
      if (!el) return { ok:false, error:'Элемент не найден' };
      const r = el.getBoundingClientRect();
      const out = { ok:true, tag: el.tagName.toLowerCase(), id: el.id||'', text: (el.innerText||el.textContent||'').trim().slice(0,500),
        value: (el.value != null ? el.value : null), checked: el.checked === true, disabled: !!el.disabled,
        className: typeof el.className === 'string' ? el.className : '' };
      const sel = el.tagName === 'SELECT' ? [].map.call(el.options, o => o.textContent.trim()) : null;
      if (sel) out.options = sel;
      return out;
    })()`, true);
    agentLog('info', 'read_element', { p }, res);
    return res;
  },

  async read_table(p) {
    const w = needWin();
    const res = await w.webContents.executeJavaScript(`(function(){
      const container = ${p ? 'document.querySelector(' + JSON.stringify(String(p)) + ')' : 'document'};
      const root = container || document;
      const tables = root.querySelectorAll('table, .list, [class*=table], .cards, #device-list, #fs-list, #apps-list, #hist-list');
      const out = [];
      [].forEach.call(tables, (tb, ti) => {
        if (ti > 4) return;
        const rows = [];
        [].forEach.call(tb.querySelectorAll('.list-row, tr, .dev-card'), r => {
          const cells = [].map.call(r.querySelectorAll('td,th,.mono,.dev-name,.dev-serial,span'), c => (c.innerText||'').trim().slice(0,80)).filter(Boolean);
          if (cells.length) rows.push(cells.slice(0,8));
        });
        if (rows.length) out.push({ table: ti, class: (tb.className||'').toString().slice(0,60), rowCount: rows.length, rows: rows.slice(0,100) });
      });
      return { ok:true, tables: out };
    })()`, true);
    agentLog('info', 'read_table', { p }, res);
    return res;
  },

  async wait_for_element(p, opts) {
    const o = opts || {};
    const timeoutMs = Math.min(60000, Math.max(500, +o.timeoutMs || 10000));
    const mode = o.mode || 'appear';
    const until = o.until;
    const t0 = Date.now();
    for (;;) {
      const f = await this.find_element(p);
      let done = false;
      if (mode === 'disappear') done = !f.ok;
      else if (mode === 'change' && until) done = f.ok && (f.text || '').indexOf(until) !== -1;
      else done = f.ok;
      if (done) return { ok: true, ms: Date.now() - t0, ...(mode === 'disappear' ? { gone: true } : f) };
      if (Date.now() - t0 > timeoutMs) return { ok: false, error: (mode === 'disappear' ? 'Элемент не исчез за ' : 'Элемент не появился за ') + timeoutMs + ' мс' };
      await new Promise(r => setTimeout(r, 350));
    }
  },

  async take_screenshot(p) {
    const w = needWin();
    const opts = { clip: undefined };
    let image;
    if (p && p.element) {
      const f = await this.find_element(p.element);
      if (f.ok) opts.clip = { x: f.x, y: f.y, width: f.w, height: f.h };
    }
    if (!p) image = await w.capturePage();
    else if (p.window === 'all' || p.region === 'all') image = await w.capturePage();
    else image = await w.capturePage(opts.clip || undefined);
    const png = image.toPNG();
    const b64 = png.toString('base64');
    const dir = path.join(appRef.savesDir || os.tmpdir(), 'Агент');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    const file = path.join(dir, 'agent-shot-' + Date.now() + '.png');
    try { fs.writeFileSync(file, png); } catch (e) {}
    return { ok: true, mime: 'image/png', data: b64, bytes: png.length, file: file };
  },

  async get_visual_state() {
    const shot = await this.take_screenshot(null);
    const tree = await this.get_ui_tree();
    return { ok: true, screenshot: shot, ui: { title: tree.title, activePage: tree.activePage, pages: tree.pages, controls: tree.controls.map(c => ({ id: c.id, tag: c.tag, text: c.text, x: c.x, y: c.y, w: c.w, h: c.h, disabled: c.disabled })) } };
  }
};

// ---------- tools: режим 2 (логика) ----------
function logicTools() {
  const a = appRef;
  return {
    async get_app_state() {
      const st = (await a.getStateFn().catch(e => ({ error: e.message })));
      return {
        ok: true,
        activeSerial: a.activeSerial ? await a.activeSerial() : null,
        pages: st.pages, config: { ...(st.config || {}) }, history: a.getHistory
          ? (a.getHistory() || []) : undefined,
        favorites: a.getFavorites ? (a.getFavorites() || []) : undefined,
        tasks: tasks.slice(0, 10),
        agent: { enabled: state.enabled, running: state.running, currentTool: state.currentTool }
      };
    },

    async call_app_function(name, params) {
      const f = a.callFns[name];
      if (!f) return { ok: false, error: 'Функция не найдена: ' + name + ' (доступно: ' + Object.keys(a.callFns).join(', ') + ')' };
      if (state.stopRequested) return { ok: false, error: 'Остановлено агентом' };
      state.currentTool = 'call_app_function:' + name;
      // если агент не указал serial — подставляем АКТИВНОЕ устройство.
      // Если активного нет, берём первое живое из adb devices. Раньше вызовы вроде
      // appsAction/fsList падали с «device 'undefined' not found».
      const p = { ...(params || {}) };
      if (!p.serial) {
        try {
          let s = a.activeSerial && await a.activeSerial();
          if (!s) {
            const dl = await a.callFns.adbDevices().catch(() => null);
            const live = (dl && dl.list ? dl.list : []).find(d => d.state === 'device');
            if (live) s = live.serial;
          }
          if (s) p.serial = s;
        } catch (e) {}
      }
      const r = await f(p);
      agentLog('info', 'call_app_function', { name, params: p }, r);
      return { ok: true, result: r };
    },

    async run_command(name, params) {
      return this.call_app_function(name, params);
    },

    async get_task_list() {
      return { ok: true, tasks: tasks.slice(0, 50), running: state.running, stopRequested: state.stopRequested };
    },

    async cancel_task(id) {
      const t = tasks.find(x => x.id === id);
      if (t) { t.status = 'canceled'; t.finishedAt = Date.now(); }
      if (!id || id === 'all') {
        state.stopRequested = true;
        a.stopAll && a.stopAll();
        return { ok: true, canceled: id || 'all', note: 'Серия действий агента остановлена' };
      }
      const c = a.cancelTask && a.cancelTask(id);
      return { ok: true, canceled: id, extra: c || null };
    },

    async get_logs(last) {
      const n = last || 60;
      if (appRef && appRef.appLogPath) {
        try {
          const txt = fs.readFileSync(appRef.appLogPath, 'utf8');
          const lines = txt.split(/\r?\n/).filter(Boolean);
          return { ok: true, logs: lines.slice(-n) };
        } catch (e) { return { ok: true, logs: [], note: 'app.log недоступен: ' + e.message }; }
      }
      return { ok: true, logs: [] };
    },

    async get_errors(p) {
      const n = (p && p.last) || 20;
      return { ok: true, errors: await a.getErrors(n).catch(() => []) };
    },

    async set_setting(key, value) {
      const allowed = a.setSetting && await a.setSetting(key, value).catch(() => null);
      if (!allowed) return { ok: false, error: 'Настройка не разрешена или несуществующая: ' + key };
      agentLog('info', 'set_setting', { key, value }, allowed);
      return { ok: true, result: allowed };
    },

    async get_setting(key) {
      const cfg = a.getConfig && a.getConfig();
      const v = cfg && cfg[key];
      return { ok: true, key, value: v === undefined ? null : v };
    },

    async connect_device(p) {
      const host = p && p.host; const port = p && +p.port;
      if (!host || !port) return { ok: false, error: 'Нужны host и port' };
      const r = await a.callFns.adbConnect({ host, port }).catch(e => ({ ok: false, error: e.message }));
      agentLog('info', 'connect_device', { host, port }, r);
      return r;
    },

    async disconnect_device(p) {
      const serial = (p && p.serial) || (a.activeSerial ? await a.activeSerial() : null);
      if (!serial) return { ok: false, error: 'Нет активного устройства' };
      const r = await a.callFns.adbDisconnect(serial).catch(e => ({ ok: false, error: e.message }));
      agentLog('info', 'disconnect_device', { serial }, r);
      return r;
    },

    async execute_device_action(action, params) {
      // AORDER передаёт action и params ДВУМЯ аргументами — раньше функция
      // читала их из одного объекта, из-за чего вызов всегда падал «Функция не найдена: undefined»
      const name = typeof action === 'object' ? (action && action.action) : action;
      const prm = typeof action === 'object' ? ((action && action.action ? action.params : action) || {}) : (params || {});
      return this.call_app_function(name, prm);
    },

    // ===== ПОЛНЫЙ ДОСТУП К УСТРОЙСТВУ =====
    // произвольная shell-команда (скрытые настройки, pm/settings/service call, всё)
    async adb_shell(cmd, serial) {
      return this.call_app_function('adbShell', { cmd, serial });
    },
    async adb_raw(args, serial) {
      const a = Array.isArray(args) ? args : String(args || '').trim().split(/\s+/).filter(Boolean);
      if (serial && a.length && !a.includes('-s')) a.unshift('-s', serial);
      return this.call_app_function('adbRaw', { args: a });
    },
    // настройки Android (global/secure/system): get/put/list
    async device_settings(op, ns, key, value) {
      if (op === 'list') return this.call_app_function('settingsList', { ns });
      return this.call_app_function('settingsCmd', { op, ns, key, value });
    },
    async device_input(type, p) {
      const x = p || {};
      if (type === 'tap') return this.call_app_function('inputTap', { x: x.x, y: x.y });
      if (type === 'swipe') return this.call_app_function('inputSwipe', x);
      if (type === 'text') return this.call_app_function('inputText', { text: x.text });
      if (type === 'key') return this.call_app_function('inputKey', { key: x.key });
      if (type === 'combo') return this.call_app_function('inputKeyCombo', { combo: x.combo });
      return { ok: false, error: 'type: tap|swipe|text|key|combo' };
    },
    async device_screen_state(serial) {
      return this.call_app_function('deviceScreenState', { serial });
    },
    async device_screenshot(serial) {
      return this.call_app_function('deviceScreenshot', { serial });
    },
    async app_action(action, pkg, serial) {
      // action: disable|enable|restore|uninstall|clear|clearCache|forceStop|run|phoneInfo
      if (action === 'run') return this.call_app_function('appsRun', { pkg, serial });
      return this.call_app_function('appsAction', { action, pkg, serial });
    },
    async pkg_info(pkg, serial) {
      return this.call_app_function('pkgInfo', { pkg, serial });
    },
    async app_crashes(pkg, serial, limit) {
      const r = await this.call_app_function('appCrashes', { pkg, serial, limit });
      return (r && r.result) ? r.result : r;
    },
    async app_audit(pkg, serial) {
      const r = await this.call_app_function('appAudit', { pkg, serial });
      return (r && r.result) ? r.result : r;
    },
    async find_packages(query, serial) {
      return this.call_app_function('findPackages', { query, serial });
    },
    async install_apk(path, serial) {
      return this.call_app_function('installApk', { path, serial });
    },
    async pull_file(remote, serial) {
      return this.call_app_function('pullFile', { remote, serial });
    },
    async push_file(local, remote, serial) {
      return this.call_app_function('pushFile', { local, remote, serial });
    },
    async reboot_device(mode, serial) {
      return this.call_app_function('rebootDevice', { mode, serial });
    },
    // ===== разблокировка телефона сохранённым паролем =====
    async unlock_device(serial, step, type) {
      return this.call_app_function('unlockDevice', { serial, step: step || 'full', type });
    },
    async unlock_status(serial) {
      return this.call_app_function('unlockStatus', { serial });
    },
    async unlock_list() {
      return this.call_app_function('unlockList', {});
    },
    async unlock_set(pin, serial, type) {
      return this.call_app_function('unlockSet', { pin, serial, type });
    },
    async unlock_delete(serial) {
      return this.call_app_function('unlockDelete', { serial });
    },
    async unlock_delkey(key) {
      return this.call_app_function('unlockDelKey', { key });
    },
    // самоописание возможностей программы для сторонних агентов
    async describe_capabilities() {
      return {
        ok: true,
        app: 'ADB Wi-Fi Коннектор',
        transport: 'HTTP POST /mcp (JSON-RPC 2.0), GET /mcp — схема',
        areas: {
          ui: 'get_ui_tree, click_element, set_text, select_option, select_tab, scroll, take_screenshot, run_js',
          device: 'adb_shell, adb_raw, device_settings, device_input, device_screen_state, device_screenshot, reboot_device, unlock_device',
          unlock: 'unlock_device (разбудить+свайп+ввод сохранённого PIN+Enter), unlock_status, unlock_set, unlock_delete',
          apps: 'app_action (disable/enable/restore/uninstall/clear/clearCache/forceStop/run/phoneInfo), pkg_info, app_crashes, app_audit, find_packages, install_apk',
          files: 'pull_file, push_file, call_app_function(fsList/fsCat)',
          system: 'get_app_state, get_logs, get_errors, set_setting, get_setting, get_task_list, cancel_task',
          control: 'connect_device, disconnect_device, agent/set-enabled, agent/stop'
        },
        notes: [
          'serial не обязателен: подставляется активное устройство (или первое живое из adb devices)',
          'Перед device_screenshot, зеркалом или записью проверяйте device_screen_state: при locked=true вызовите unlock_device (если сохранён PIN) или разблокируйте вручную',
          'device_settings: op=get|put|list, ns=global|secure|system — доступ к скрытым настройкам Android',
          'app_action disable сам обходит запрет прошивки: pm disable-user → pm uninstall -k --user 0',
          'adb_shell принимает ЛЮБУЮ shell-команду: pm, settings, service call, dumpsys, cmd, am, input...'
        ]
      };
    }
  };
}

// ---------- реестр tool-описаний (для схемы) ----------
const TOOL_DEFS = [
  ['get_app_window', 'Получить список открытых окон программы', { }],
  ['get_ui_tree', 'Полное дерево интерфейса: разделы, кнопки, поля, списки, координаты, доступность', { }],
  ['get_active_tab', 'Определить активный раздел и открытый экран', { }],
  ['click_element', 'Нажать элемент по id, тексту, селектору или координатам', { p: 'string', pos: 'string?' }],
  ['double_click_element', 'Двойной клик по элементу', { p: 'string' }],
  ['right_click_element', 'Открыть контекстное меню элемента', { p: 'string' }],
  ['hover_element', 'Навести курсор на элемент', { p: 'string' }],
  ['scroll', 'Прокрутка: up/down/left/right/top/bottom и пиксели', { p: 'string', px: 'number?' }],
  ['set_text', 'Ввести текст в поле', { p: 'string', text: 'string' }],
  ['clear_text', 'Очистить поле', { p: 'string' }],
  ['select_option', 'Выбрать пункт в выпадающем списке', { p: 'string', value: 'string|number' }],
  ['set_checkbox', 'Установить/снять галочку', { p: 'string', on: 'boolean' }],
  ['select_tab', 'Переключить раздел/вкладку по названию', { p: 'string' }],
  ['open_window', 'Открыть раздел / окно программы', { p: 'string' }],
  ['close_window', 'Закрыть диалог или окно (main — активный диалог)', { id: 'string?' }],
  ['drag_and_drop', 'Перетащить элемент в координаты (x, y)', { p: 'string', x: 'number', y: 'number' }],
  ['read_element', 'Прочитать текст/значение/состояние элемента', { p: 'string' }],
  ['read_table', 'Прочитать строки и колонки таблиц/списков', { p: 'string?' }],
  ['wait_for_element', 'Дождаться появления/исчезновения/изменения', { p: 'string', opts: 'object?' }],
  ['run_js', 'Выполнить произвольное JS-выражение в главном окне (продвинутая диагностика/управление)', { p: 'string' }],
  ['take_screenshot', 'Скриншот окна или элемента (base64 PNG)', { p: 'object?' }],
  ['get_visual_state', 'Скриншот + текстовое описание текущего интерфейса', { }],
  ['get_app_state', 'Внутреннее состояние: устройство, вкладка, настройки, задачи', { }],
  ['call_app_function', 'Вызвать внутреннюю функцию программы (см. functions в схеме)', { name: 'string', params: 'object?' }],
  ['run_command', 'Выполнить поддерживаемую команду программы (синоним call_app_function)', { name: 'string', params: 'object?' }],
  ['get_task_list', 'Список активных и завершённых задач', { }],
  ['cancel_task', 'Отменить задачу или остановить серию агента (id: "all")', { id: 'string' }],
  ['get_logs', 'Получить логи программы', { last: 'number?' }],
  ['get_errors', 'Последние ошибки и предупреждения', { last: 'number?' }],
  ['set_setting', 'Изменить настройку (доступен белый список ключей)', { key: 'string', value: 'any' }],
  ['get_setting', 'Прочитать настройку', { key: 'string' }],
  ['connect_device', 'Подключить Android-устройство по host:port', { host: 'string', port: 'number' }],
  ['disconnect_device', 'Отключить устройство', { serial: 'string?' }],
  ['execute_device_action', 'Выполнить действие с телефоном (см. functions)', { action: 'string', params: 'object?' }],
  // полный доступ к устройству
  ['adb_shell', 'ЛЮБАЯ shell-команда на устройстве (pm, settings, cmd, dumpsys, am, service call…)', { cmd: 'string', serial: 'string?' }],
  ['adb_raw', 'Произвольные аргументы adb (push/pull/install/forward/reboot…)', { args: 'string|string[]', serial: 'string?' }],
  ['device_settings', 'Скрытые настройки Android: op=get|put|list, ns=global|secure|system', { op: 'string', ns: 'string?', key: 'string?', value: 'string?' }],
  ['device_input', 'Ввод на телефоне: tap/swipe/text/key/combo', { type: 'string', p: 'object?' }],
  ['device_screen_state', 'Состояние экрана/блокировки; проверка перед screenshot, зеркалом и записью', { serial: 'string?' }],
  ['device_screenshot', 'Снимок экрана ТЕЛЕФОНА в PNG (файл в «Сохранения\\Агент»); требует разблокированного экрана', { serial: 'string?' }],
  ['app_action', 'Действие с приложением: disable/enable/restore/uninstall/clear/clearCache/forceStop/run/phoneInfo', { action: 'string', pkg: 'string', serial: 'string?' }],
  ['pkg_info', 'Подробно о пакете: версия, код, путь APK, даты, установлен ли', { pkg: 'string', serial: 'string?' }],
  ['app_crashes', 'Сбои и ANR конкретного приложения из logcat: время, тип, PID, стек; можно скопировать всё', { pkg: 'string', serial: 'string?', limit: 'number?' }],
  ['app_audit', 'Аудит разрешений и AppOps приложения: опасные доступы, установщик, предупреждения', { pkg: 'string', serial: 'string?' }],
  ['find_packages', 'Поиск пакетов по подстроке (имя/путь)', { query: 'string?', serial: 'string?' }],
  ['install_apk', 'Установить APK с ПК (push + pm install)', { path: 'string', serial: 'string?' }],
  ['pull_file', 'Скачать файл с телефона в «Сохранения\\Агент»', { remote: 'string', serial: 'string?' }],
  ['push_file', 'Загрузить файл с ПК на телефон', { local: 'string', remote: 'string', serial: 'string?' }],
  ['reboot_device', 'Перезагрузить телефон: system/bootloader/recovery/sideload', { mode: 'string?', serial: 'string?' }],
  // разблокировка сохранённым паролем
  ['unlock_device', 'Разблокировать телефон сохранённым в программе паролем (пробуждение → свайп → PIN → Enter) или нарисовать ключ', { serial: 'string?', step: 'string?', type: 'string?' }],
  ['unlock_status', 'Узнать, сохранён ли пароль разблокировки для устройства (сам пароль не возвращается)', { serial: 'string?' }],
  ['unlock_list', 'Список всех сохранённых паролей/ключей (устройство, тип, длина, дата)', { }],
  ['unlock_set', 'Сохранить PIN/пароль или графический ключ (type=pin|pattern) для устройства; шифруется Windows DPAPI', { pin: 'string', serial: 'string?', type: 'string?' }],
  ['unlock_delete', 'Удалить сохранённый пароль текущего/указанного устройства', { serial: 'string?' }],
  ['unlock_delkey', 'Удалить сохранённый пароль по ключу из unlock_list', { key: 'string' }],
  ['describe_capabilities', 'Самоописание: что умеет программа и этот MCP-сервер', { }]
];

async function dispatch(name, params) {
  if (!state.enabled && !['get_app_state', 'get_task_list', 'describe_capabilities', 'get_logs', 'get_errors'].includes(name)) {
    return { ok: false, error: 'Управление агентом выключено. Включите в Настройках (тумблер «Управление агентом»).' };
  }
  if (state.stopRequested && name !== 'cancel_task') {
    return { ok: false, error: 'Остановлено аварийной кнопкой. Сброс: agent/reset или cancel_task("all").' };
  }
  state.currentTool = name;
  state.lastStep = { tool: name, ts: Date.now() };
  state.stepCount++;
  const all = { ...uiTools, ...logicTools() };
  const fn = all[name];
  if (!fn) return { ok: false, error: 'Tool не найден: ' + name };
  // порядок позиционных аргументов по именам параметров
  const AORDER = {
    click_element: ['p', 'pos'], double_click_element: ['p'], right_click_element: ['p'], hover_element: ['p'],
    scroll: ['p', 'px'], set_text: ['p', 'text'], clear_text: ['p'], select_option: ['p', 'value'],
    set_checkbox: ['p', 'on'], select_tab: ['p'], open_window: ['p'], close_window: ['id'],
    drag_and_drop: ['p', 'x', 'y'], read_element: ['p'], read_table: ['p'], wait_for_element: ['p', 'opts'],
    take_screenshot: ['p'], get_visual_state: [], get_app_state: [], get_app_window: [], get_ui_tree: [], get_active_tab: [], run_js: ['p'],
    call_app_function: ['name', 'params'], run_command: ['name', 'params'], get_task_list: [], cancel_task: ['id'],
    get_logs: ['last'], get_errors: ['last'], set_setting: ['key', 'value'], get_setting: ['key'],
    connect_device: ['host', 'port'], disconnect_device: ['serial'], execute_device_action: ['action', 'params'],
    // полный доступ
    adb_shell: ['cmd', 'serial'], adb_raw: ['args', 'serial'], device_settings: ['op', 'ns', 'key', 'value'],
    device_input: ['type', 'p'], device_screen_state: ['serial'], device_screenshot: ['serial'], app_action: ['action', 'pkg', 'serial'],
    pkg_info: ['pkg', 'serial'], app_crashes: ['pkg', 'serial', 'limit'], app_audit: ['pkg', 'serial'], find_packages: ['query', 'serial'], install_apk: ['path', 'serial'],
    pull_file: ['remote', 'serial'], push_file: ['local', 'remote', 'serial'], reboot_device: ['mode', 'serial'],
    unlock_device: ['serial', 'step', 'type'], unlock_status: ['serial'], unlock_list: [], unlock_set: ['pin', 'serial', 'type'], unlock_delete: ['serial'], unlock_delkey: ['key'],
    describe_capabilities: []
  };
  const order = AORDER[name] || ['p'];
  const args = order.map(k => (params || {})[k]);
  try {
    return await fn.apply(all, args);
  } catch (e) {
    agentLog('error', name, params, e.message);
    return { ok: false, error: e.message || String(e) };
  }
}

// ---------- HTTP-сервер ----------
function startServer() {
  const server = http.createServer(async (req, res) => {
    const origin = String(req.headers.origin || '');
    const localOrigin = !origin || /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(origin);
    if (!localOrigin) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Origin не разрешён' }));
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = (req.url || '').split('?')[0];

    if (req.method === 'GET' && url === '/mcp') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true, name: 'adb-wifi-connector-mcp', version: '2.12.0',
        about: 'ADB Wi-Fi Коннектор — подключение Android по Wi-Fi/USB, файлы, приложения, трансляция, полный ADB-доступ.',
        transport: 'HTTP POST /mcp (JSON-RPC 2.0); GET /mcp — эта схема',
        enabled: state.enabled,
        notes: [
          'Перед вызовом инструментов включите тумблер «Управление агентом» в Настройках (agent/set-enabled).',
          'serial можно не указывать — подставится активное устройство / первое живое.',
          'Полный доступ: adb_shell, adb_raw, device_settings (global/secure/system), app_action, install_apk, pull_file, push_file.'
        ],
        tools: TOOL_DEFS.map(d => ({ name: d[0], description: d[1], params: d[2] })),
        functions: appRef ? Object.keys(appRef.callFns || {}) : [],
        discovery: {
          endpoint: 'http://127.0.0.1:' + PORT + '/mcp',
          descriptorFile: '%APPDATA%\\ADB Wi-Fi Коннектор\\mcp-endpoint.json',
          readme: 'MCP-README.md рядом с приложением'
        }
      }, null, 2));
      return;
    }

    if (req.method === 'GET' && (url === '/mcp/schema' || url === '/mcp/tools')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        tools: TOOL_DEFS.map(d => ({ name: d[0], description: d[1], inputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(d[2]).map(([k, v]) => [k, { type: typeof v === 'number' ? 'number' : 'string' }])) } }))
      }, null, 2));
      return;
    }

    if (req.method === 'POST' && url === '/mcp') {
      let body = '';
      req.on('data', d => { if (body.length < 2e6) body += d; });
      req.on('end', async () => {
        let msg;
        try { msg = JSON.parse(body || '{}'); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(rpcError(null, -32700, 'Invalid JSON'))); return; }
        if (!authOk(req, TOKEN_ENV)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(rpcError(msg.id, -32001, 'Неверный токен MCP_TOKEN'))); return; }
        // JSON-RPC notification (без id) не должен получать ответ
        if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
        if (msg.method === 'initialize') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(rpcOk(msg.id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'adb-wifi-connector-mcp', version: '2.12.0' }
          })));
          return;
        }
        if (msg.method === 'notifications/initialized') {
          res.writeHead(202);
          res.end();
          return;
        }
        if (msg.method === 'tools/list') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(rpcOk(msg.id, { tools: TOOL_DEFS.map(d => ({ name: d[0], description: d[1], inputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(d[2]).map(([k, v]) => [k, { type: typeof v === 'number' ? 'number' : 'string' }])) } })) })));
          return;
        }
        if (msg.method === 'tools/call' || msg.method === 'call_tool') {
          const name = (msg.params && (msg.params.name || msg.params.tool)) || '';
          const params = (msg.params && msg.params.arguments) || {};
          agentLog('info', 'rpc:' + name, params, null);
          const r = await dispatch(name, params);
          const text = typeof r === 'string' ? r : JSON.stringify(r);
          const out = (r && typeof r === 'object' && !Array.isArray(r)) ? { ...r } : { result: r };
          out.content = [{ type: 'text', text }];
          out.isError = !!(r && (r.ok === false || r.error));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(rpcOk(msg.id, out)));
          return;
        }
        if (msg.method === 'ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(rpcOk(msg.id, { ok: true }))); return; }
        if (msg.method === 'agent/set-enabled') {
          const v = !!(msg.params && msg.params.enabled);
          state.enabled = v;
          if (appRef && appRef.config) { appRef.config.agentEnabled = v; try { appRef.saveConfig(); } catch (e) {} }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(rpcOk(msg.id, { ok: true, enabled: state.enabled }))); return;
        }
        if (msg.method === 'agent/reset') {
          state.stopRequested = false;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(rpcOk(msg.id, { ok: true, reset: true }))); return;
        }
        if (msg.method === 'agent/stop' || msg.method === 'cancel_task') {
          const id = msg.method === 'cancel_task' ? (msg.params && msg.params.id) : null;
          state.stopRequested = true;
          try { if (appRef && appRef.stopAll) appRef.stopAll(); } catch (e) {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(rpcOk(msg.id, { ok: true, stopped: true, id: id || null }))); return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rpcError(msg.id, -32601, 'Метод не найден: ' + msg.method)));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });

  server.on('error', e => {
    try { if (appRef && appRef.logErr) appRef.logErr('mcp', 'server', e.message); } catch (err) {}
  });
  server.listen(PORT, '127.0.0.1', () => {
    try { if (appRef && appRef.logInfo) appRef.logInfo('mcp', 'запуск', 'port ' + PORT + ' (enabled=' + state.enabled + ')'); } catch (err) {}
    // файл-обнаружение — любой внешний агент (Claude Code, Codex, Cursor, OpenCode…)
    // находит MCP-сервер программы по этому файлу и понимает, как подключиться
    try {
      const dir = path.join(process.env.APPDATA || os.homedir(), 'ADB Wi-Fi Коннектор');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'mcp-endpoint.json'), JSON.stringify({
        name: 'adb-wifi-connector-mcp',
        version: '2.12.0',
        description: 'ADB Wi-Fi Коннектор: подключение Android по Wi-Fi/USB, файлы, приложения, трансляция экрана, полный ADB-доступ (shell, скрытые настройки, установка/удаление, ввод, снимки экрана).',
        endpoint: 'http://127.0.0.1:' + PORT + '/mcp',
        schema: 'http://127.0.0.1:' + PORT + '/mcp/schema',
        transport: 'HTTP JSON-RPC 2.0 (POST /mcp), задания: tools/list, tools/call',
        enabled: state.enabled,
        enableHint: 'Включите «Управление агентом» в Настройках программы (или agent/set-enabled {enabled:true})',
        authHint: TOKEN_ENV ? 'Требуется заголовок Authorization: Bearer <MCP_TOKEN>' : 'Без токена (локальный доступ)',
        coreTools: ['get_app_state', 'adb_shell', 'adb_raw', 'device_settings', 'app_action', 'find_packages', 'pkg_info', 'device_screen_state', 'device_screenshot', 'install_apk', 'pull_file', 'push_file', 'device_input', 'reboot_device', 'unlock_device', 'unlock_status', 'get_ui_tree', 'click_element', 'take_screenshot', 'describe_capabilities'],
        updatedAt: new Date().toISOString()
      }, null, 2), 'utf8');
    } catch (e) {}
  });
  return server;
}

// ---------- внешний API модуля ----------
module.exports = {
  initApp,
  startServer,
  setEnabled(v) { state.enabled = !!v; if (!v) { state.running = false; } },
  isEnabled() { return state.enabled; },
  resetStop() { state.stopRequested = false; },
  stop() { state.stopRequested = true; },
  cancelTask(id) { tasks.push({ id, kind: 'manual', title: 'отмена по запросу', status: 'canceled', startedAt: Date.now(), finishedAt: Date.now() }); },
  addTask(rec) { const t = { id: 't' + (++taskSeq), status: 'running', startedAt: Date.now(), ...rec }; tasks.unshift(t); if (tasks.length > 200) tasks.pop(); return t; },
  finishTask(id, result, error) { const t = tasks.find(x => x.id === id); if (t) { t.status = error ? 'error' : 'done'; t.result = result; t.error = error; t.finishedAt = Date.now(); } return t; },
  agentLog,
  getLog() { return log; },
  dispatch
};