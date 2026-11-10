/* app.js — логика интерфейса (renderer). - файлы: иконки типов, кнопка «назад», свойства файлов, перетаскивание с ПК, загрузка в текущую папку
   - приложения: счётчики, человеческие имена (± пакеты), процессы с описаниями
   - свойства приложения: разрешения колонками, тултипы в стиле приложения, «Очистить кэш», «Удалить приложение»
   - терминал: команды по производителям, свои команды (Сохранения/), автодополнение
   - зеркало: вотчдог «данные идут, но кадров нет», быстрый JPEG-режим; журнал = только ошибки (F19) */
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let state = null;
let devices = [];          // [{serial, state, model, android, props}]
let activeSerial = null;   // ЕДИНСТВЕННОЕ активное устройство (R8)
Object.defineProperty(window, 'activeSerial', { get: () => activeSerial, configurable: true });
let savedItems = [];       // «Мои устройства» — для офлайн-опций селектора (R7)
let scanFound = [];
let recTimer = null, recStart = 0;
let logcatOn = false, logcatPaused = false, logcatBuf = [];

/* ---------- утилиты ---------- */
// оборачивает input в контейнер с крестиком очистки внутри поля
function attachClear(inputId) {
  const inp = document.getElementById(inputId);
  if (!inp || inp.parentElement.classList.contains('input-clear-wrap')) return;
  const wrap = document.createElement('span');
  wrap.className = 'input-clear-wrap' + (inp.classList.contains('grow') ? ' grow' : '');
  if (inp.classList.contains('grow')) inp.classList.remove('grow');
  inp.parentNode.insertBefore(wrap, inp);
  wrap.appendChild(inp);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'input-clear-x';
  btn.textContent = '\u2715';
  btn.title = 'Очистить поле';
  wrap.appendChild(btn);
  const sync = () => wrap.classList.toggle('has-text', !!inp.value);
  inp.addEventListener('input', sync);
  btn.addEventListener('click', () => {
    inp.value = '';
    sync();
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.focus();
  });
  sync();
}
const ERR_MSG_RE = /не удалось|ошибка|невозможно|недоступен|нет подключ|отказано|занято|слишком/i;
let snackEl = null;
function snack(msg, ms = 3500) {
  // F19: каждая ошибка, показанная в интерфейсе, обязана попасть в журнал (app.log = только ошибки)
  if (ERR_MSG_RE.test(String(msg))) { try { window.api.uiLog(String(msg).slice(0, 400)); } catch (e) {} }
  snackEl = snackEl || $('#snackbar');
  snackEl.textContent = msg; snackEl.classList.remove('hidden');
  clearTimeout(snackEl._t);
  snackEl._t = setTimeout(() => snackEl.classList.add('hidden'), ms);
}
function openDlg(id) { $('#' + id).classList.remove('hidden'); }
function closeDlg(id) { $('#' + id).classList.add('hidden'); }

/* модальный ввод (замена системного диалога ввода, которого нет в Electron) */
let inputResolve = null;
function askText(title, label, value) {
  return new Promise(resolve => {
    inputResolve = resolve;
    $('#input-title').textContent = title;
    $('#input-label').textContent = label || '';
    const f = $('#input-field'); f.value = value || '';
    openDlg('dlg-input');
    setTimeout(() => { try { f.focus(); f.select(); } catch (e) {} }, 60);
  });
}
function finishInput(okVal) {
  if (!inputResolve) { closeDlg('dlg-input'); return; }
  const r = inputResolve; inputResolve = null;
  closeDlg('dlg-input');
  r(okVal ? $('#input-field').value.trim() : null);
}
$('#input-ok').onclick = () => finishInput(true);
$('#input-field').addEventListener('keydown', e => { if (e.key === 'Enter') finishInput(true); });

// подтверждение вместо нативного confirm() — не выбивается из кастомного окна (A1)
// opts.checkbox — «Больше не спрашивать»: возвращает {ok, dontAsk} вместо boolean;
// подтверждающие галочки запоминаются в localStorage — владелец больше не кликает по сто раз
let confirmCb = null, confirmCancelCb = null;
function uiConfirm(title, body, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    confirmCb = () => resolve({ ok: true, dontAsk: !!(opts.checkbox && $('#confirm-dontask') && $('#confirm-dontask').checked) });
    confirmCancelCb = () => resolve({ ok: false, dontAsk: false });
    $('#confirm-title').textContent = title;
    $('#confirm-body').textContent = body || '';
    const cb = $('#confirm-dontask');
    if (cb) {
      if (opts.checkbox) { cb.parentElement.classList.remove('hidden'); cb.checked = false; }
      else cb.parentElement.classList.add('hidden');
    }
    openDlg('dlg-confirm');
  });
}
async function confirmOnce(key, title, body) {
  // подтверждение «один раз навсегда» для конкретного действия (ключ в localStorage)
  try { if (localStorage.getItem(key) === '1') return { ok: true, dontAsk: true }; } catch (e) {}
  const r = await uiConfirm(title, body, { checkbox: 'Больше не спрашивать' });
  if (r.ok && r.dontAsk) { try { localStorage.setItem(key, '1'); } catch (e) {} }
  return r;
}

// флаг активной QR-сессии: нужен обработчику data-close ниже и блоку QR-подключения
let qrActive = false;

function fmtTs(ts) {
  const d = new Date(ts);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}
function relTime(ts) {
  const t = Number(ts);
  if (!t || !isFinite(t)) return '';
  let diff = Date.now() - t;
  if (diff < 0) diff = 0;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return min + ' ' + plural(min, 'минуту', 'минуты', 'минут') + ' назад';
  const hours = Math.floor(min / 60);
  if (hours < 24) return hours + ' ' + plural(hours, 'час', 'часа', 'часов') + ' назад';
  const days = Math.floor(hours / 24);
  if (days === 1) return 'вчера';
  if (days < 30) return days + ' ' + plural(days, 'день', 'дня', 'дней') + ' назад';
  return fmtTs(ts);
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtBytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : n + ' Б'; }
function copyText(t) {
  const s = String(t == null ? '' : t);
  try {
    if (window.api && window.api.copyText) window.api.copyText(s);
    else navigator.clipboard.writeText(s);
    snack('Скопировано: ' + (s.length > 80 ? s.slice(0, 80) + '…' : s));
  } catch (e) {}
}

/* ---------- звуки действий ---------- */
const snd = {
  ctx: null, on: true,
  play(kind) {
    if (!this.on) return;
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const t = this.ctx.currentTime;
      const mk = (f, st, d, g, type) => {
        const o = this.ctx.createOscillator(), gn = this.ctx.createGain();
        o.type = type || 'sine'; o.frequency.value = f;
        gn.gain.setValueAtTime(0, t + st);
        gn.gain.linearRampToValueAtTime(g || 0.07, t + st + 0.012);
        gn.gain.exponentialRampToValueAtTime(0.0001, t + st + d);
        o.connect(gn); gn.connect(this.ctx.destination);
        o.start(t + st); o.stop(t + st + d + 0.03);
      };
      if (kind === 'ok') { mk(660, 0, 0.12); mk(880, 0.09, 0.16); }
      else if (kind === 'connect') { mk(523, 0, 0.1); mk(659, 0.09, 0.1); mk(784, 0.18, 0.2); }
      else if (kind === 'err') { mk(196, 0, 0.22, 0.09, 'triangle'); mk(147, 0.12, 0.25, 0.08, 'triangle'); }
      else if (kind === 'found') { mk(740, 0, 0.09); mk(988, 0.08, 0.13); }
      else if (kind === 'click') { mk(520, 0, 0.05, 0.035); }
      else if (kind === 'drop') { mk(392, 0, 0.08); mk(523, 0.07, 0.1); }
    } catch (e) {}
  }
};
document.addEventListener('click', (e) => { if (e.target.closest('.btn,.chip,.rail-item,.star')) snd.play('click'); }, true);
const _snack = snack;
snack = function (msg, ms) { _snack(msg, ms); snd.play(ERR_MSG_RE.test(String(msg)) ? 'err' : 'ok'); };

/* ---------- тултипы в стиле приложения (F13): нативные Windows-подсказки заменены ---------- */
(function tooltip() {
  const tip = document.createElement('div');
  tip.id = 'app-tip'; tip.className = 'hidden';
  document.body.appendChild(tip);
  let raf = 0;
  function show(txt, x, y) {
    tip.textContent = txt;
    tip.classList.remove('hidden');
    const r = tip.getBoundingClientRect();
    const w = window.innerWidth, h = window.innerHeight;
    let px = Math.min(Math.max(8, x + 14), w - r.width - 10);
    let py = y + 18;
    if (py + r.height > h - 8) py = Math.max(8, y - r.height - 12);
    tip.style.left = px + 'px'; tip.style.top = py + 'px';
  }
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) return;
    const txt = t.getAttribute('data-tip') || '';
    if (!txt) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => show(txt, e.clientX, e.clientY));
  });
  document.addEventListener('mousemove', (e) => {
    if (tip.classList.contains('hidden')) return;
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) { tip.classList.add('hidden'); return; }
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => show(t.getAttribute('data-tip') || '', e.clientX, e.clientY));
  });
  document.addEventListener('mousedown', () => tip.classList.add('hidden'), true);
  document.addEventListener('mouseleave', () => tip.classList.add('hidden'));
})();

/* ---------- титульная панель / навигация ---------- */
$('#btn-min').onclick = () => window.api.winMin();
$('#btn-max').onclick = () => window.api.winMax();
$('#btn-close').onclick = () => window.api.winClose();
window.api.onMaximized(v => { $('#btn-max').innerHTML = v ? '&#10697;' : '&#9633;'; });

$$('.rail-item').forEach(b => b.onclick = () => goPage(b.dataset.page));

$$('[data-close]').forEach(b => b.onclick = () => {
  if (b.dataset.close === 'dlg-input') finishInput(false);
  if (b.dataset.close === 'dlg-qrpc' && qrActive) { qrActive = false; window.api.qrCancel(); }
  if (b.dataset.close === 'dlg-confirm' && confirmCancelCb) { const c = confirmCancelCb; confirmCancelCb = null; confirmCb = null; c(); }
  // закрытие просмотрщика фото ИЗ ПОЛНОГО ЭКРАНА — сначала выходим из fullscreen
  // и снимаем «внутренний» полноэкранный класс, иначе окно программы оставалось
  // развёрнутым на весь монитор и интерфейс не отвечал
  if (b.dataset.close === 'dlg-imgview') {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      }
    } catch (e) {}
    const shell = $('#imgview-shell');
    if (shell) shell.classList.remove('imgview-full');
  }
  closeDlg(b.dataset.close);
});
$('#confirm-yes').onclick = () => { closeDlg('dlg-confirm'); if (confirmCb) confirmCb(); confirmCb = null; confirmCancelCb = null; };

$$('.tabs .tab').forEach(t => t.onclick = () => {
  $$('.tabs .tab').forEach(x => x.classList.toggle('active', x === t));
  $$('.tab-page').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
});

/* ---------- состояние ---------- */
let savesDir = '';
async function loadState() {
  state = await window.api.getState();
  document.body.dataset.theme = state.config.theme || 'dark';
  // по просьбе владельца версия в интерфейсе не показывается
  if ($('#tb-version')) $('#tb-version').textContent = '';
  if ($('#about-ver')) $('#about-ver').textContent = '';
  // F16: все сохранения — в «Сохранения/» рядом с программой
  savesDir = state.savesDir || state.capturesDir || '';
  $('#data-dir-label').textContent = 'Все сохранения хранятся строго в папке с программой: ' + savesDir;
  // поля путей adb/scrcpy убраны из настроек — используются встроенный adb и автопоиск scrcpy
  $('#set-autostart').checked = !!state.config.autostart;
  $('#set-tray').checked = state.config.closeToTray !== false;
  $('#set-autoreconnect').checked = !!state.config.autoreconnect;
  $('#set-sounds').checked = state.config.sounds !== false;
  $('#set-autolast').checked = !!state.config.autolast;
  snd.on = state.config.sounds !== false;
  $('#set-theme').value = state.config.theme || 'dark';
  await refreshAdbStatus();
  renderHistory(); renderFavorites(); renderSaved();
}

async function refreshAdbStatus() {
  const v = await window.api.adbVersion();
  if (v.ok) {
    // слово «adb» в левой панели убрано (по просьбе владельца) — остаётся только линия-разделитель
    $('#adb-status').textContent = '';
    $('#adb-status').dataset.tip = 'adb ' + v.version;
    if ($('#adb-ver-label')) $('#adb-ver-label').textContent = '— версия ' + v.version;
    $('#adb-banner').classList.add('hidden');
  } else {
    $('#adb-status').textContent = 'adb не найден';
    $('#adb-banner').classList.remove('hidden');
  }
}

/* ---------- ЕДИНОЕ активное устройство (R7/R8) ---------- */
function onlineDevices() { return devices.filter(d => d.state === 'device'); }
function isOnline(serial) { return onlineDevices().some(d => d.serial === serial); }
// USB — это «голый» серийник (45081e2b). Беспроводные бывают двух видов:
// IP:порт (192.0.2.42:5555) И mDNS-имя adb-<serial>-<suffix>._adb-tls-connect._tcp —
// у mDNS двоеточия нет, из-за чего раньше ВСЕ Wi-Fi-устройства показывались как USB.
function isUsb(serial) {
  const s = String(serial || '');
  if (!s) return false;
  if (s.includes(':')) return false;                       // IP:порт — Wi-Fi
  if (s.includes('_adb-tls') || s.includes('._tcp')) return false; // беспроводная отладка
  if (s.startsWith('adb-')) return false;                  // mDNS-имя устройства
  return true;                                             // USB-серийник
}
// Значки типа подключения (SVG, наследуют цвет через currentColor)
const CONN_ICONS = {
  wifi: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2.5 8.6a16 16 0 0 1 19 0"/><path d="M5.7 12.3a11 11 0 0 1 12.6 0"/><path d="M8.9 16a6 6 0 0 1 6.2 0"/><circle cx="12" cy="19.4" r="1.15" fill="currentColor" stroke="none"/></svg>',
  usb: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.5V7"/><path d="M9 10l3-3 3 3"/><path d="M12 13.2 8 10.8V8.2"/><path d="M12 15.4l4-2.4V10"/><circle cx="8" cy="7.2" r="1.2" fill="currentColor" stroke="none"/><rect x="15" y="9.2" width="2.4" height="2.4" rx=".5" fill="currentColor" stroke="none"/><circle cx="12" cy="20.8" r="1.1" fill="currentColor" stroke="none"/></svg>'
};
function connIcon(serial) {
  if (!serial) return '';
  const usb = isUsb(serial);
  const kind = usb ? 'usb' : 'wifi';
  const tip = usb ? 'Подключено по USB' : 'Подключено по Wi-Fi';
  return '<span class="conn-ico ' + kind + '" data-tip="' + tip + '">' + CONN_ICONS[kind] + '</span>';
}
function nameOf(serial) {
  const d = devices.find(x => x.serial === serial);
  return (d && (d.friendly || d.model || d.props && d.props.product)) || serial || '';
}
function stText(serial) {
  if (!serial) return '';
  if (isOnline(serial)) return serial === activeSerial ? '✓ активно' : '● в сети' + (isUsb(serial) ? ' [USB]' : '');
  return '○ не подключено';
}
function chipClass(serial) {
  if (!isOnline(serial)) return 'st-chip st-off';
  return serial === activeSerial ? 'st-chip st-active' : 'st-chip st-online';
}

function renderTbDevice() {
  const sel = $('#tb-device');
  const online = onlineDevices();
  // офлайн-адреса из «Моих устройств» и истории — для быстрого подключения из любого места
  const hist = (state && state.history) || [];
  const lastBy = {};
  for (const h of hist) lastBy[h.host + ':' + h.port] = h.lastTs;
  const offline = [];
  for (const s of savedItems) {
    const ser = s.host + ':' + s.port;
    if (!online.some(d => d.serial === ser) && !offline.some(o => o.serial === ser)) offline.push({ serial: ser, label: (s.name || s.host) + ':' + s.port, lastTs: lastBy[ser] });
  }
  for (const h of hist) {
    const ser = h.host + ':' + h.port;
    if (!online.some(d => d.serial === ser) && !offline.some(o => o.serial === ser)) offline.push({ serial: ser, label: h.host + ':' + h.port, lastTs: h.lastTs });
  }
  let html = '';
  if (!online.length && !offline.length) {
    html = '<option value="">Нет устройства — подключите ниже</option>';
  } else {
    for (const d of online) {
      const act = d.serial === activeSerial;
      html += `<option value="${esc(d.serial)}">${act ? '✓' : '●'} ${esc(d.friendly || d.model || d.serial)}${isUsb(d.serial) ? ' [USB]' : ''} — ${act ? 'активно' : 'в сети'}</option>`;
    }
    for (const o of offline) {
      const ago = o.lastTs ? relTime(o.lastTs) : '';
      html += `<option value="${esc(o.serial)}">○ ${esc(o.label)} — не подключено${ago ? ' · последнее: ' + esc(ago) : ''}</option>`;
    }
    if (!online.some(d => d.serial === activeSerial)) html = `<option value="">— устройство не выбрано —</option>` + html;
  }
  const prev = sel.value;
  sel.innerHTML = html;
  const want = activeSerial && online.some(d => d.serial === activeSerial) ? activeSerial : '';
  sel.value = want || sel.options[0] && sel.options[0].value || '';
  sel.setAttribute('data-tip', sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : 'Активное устройство');
  // значок Wi-Fi/USB рядом с выпадающим списком
  const ico = $('#tb-conn-ico');
  if (ico) ico.innerHTML = want ? connIcon(want) : '';
  void prev;
}

$('#tb-device').onchange = () => {
  const v = $('#tb-device').value;
  if (!v) return;
  if (isOnline(v)) {
    setActive(v);
    snack('Активное устройство: ' + nameOf(v) + ' (' + v + ')');
  } else {
    const [h, p] = v.split(':');
    doConnect(h, +p);
  }
};

// смена активного устройства ОБЯЗАНА сбрасывать кэш приложений/иконок,
// иначе в списке остаются иконки и имена от предыдущего телефона.
function invalidateAppsCache() {
  // базовая инвалидация — всегда
  appsData = null;
  appsMetaMap = {};
  appLabels = {};
  // очереди/кэши объявлены ниже по файлу — обращаемся безопасно
  try {
    iconQueue.length = 0;
    iconInFlight.clear();
    if (procIconsRendered) procIconsRendered.clear();
    // иконки процессов от прошлого телефона не должны остаться в памяти
    if (procIconUrl) { procIconUrl.clear(); procIconWait.clear(); procIconQ.length = 0; }
    if (thumbCache) thumbCache.clear();
    if (thumbFail) thumbFail.clear();
    if (fsApkIconDone) fsApkIconDone.clear();
  } catch (e) {}
}

// при смене активного телефона останавливаем всё, что связано со старым:
// зеркало, запись, logcat, shell и кэш файлового менеджера. Иначе кадры/логи/файлы
// прошлого устройства продолжают жить в интерфейсе нового.
function resetActiveDeviceState() {
  try { window.api.mirrorStop().catch(() => {}); } catch (e) {}
  try { mirrorStopUI(true); } catch (e) {}
  try {
    if (recTimer) {
      window.api.toolRecordStop().catch(() => {});
      clearInterval(recTimer);
      recTimer = null;
      recordUIReset();
    }
  } catch (e) {}
  try {
    if (logcatOn) {
      window.api.toolLogcatStop().catch(() => {});
      logcatOn = false;
      logcatPaused = false;
      logcatBuf = [];
      const lv = $('#logcat-view');
      if (lv) lv.textContent = '';
      logcatButtons();
    }
  } catch (e) {}
  try {
    if (shellOn) {
      window.api.shellStop().catch(() => {});
      shellOn = false;
      const sv = $('#shell-view');
      if (sv) sv.textContent += '\n[переключение устройства — сессия остановлена]\n';
    }
  } catch (e) {}
  try {
    window.api.clipStop().catch(() => {});
    window.api.clipClear().catch(() => {});
    if (typeof clipItems !== 'undefined') clipItems = [];
    if (typeof clipRunning !== 'undefined') clipRunning = false;
    if (typeof clipRender === 'function') clipRender();
  } catch (e) {}
  try {
    fsSeq++;
    fsDir = '/sdcard';
    fsHist = [];
    fsFwd = [];
    fsItems = [];
    fsCatKind = null;
    fsCatItems = [];
    fsClip = { paths: [], cut: false };
    fsFlash = null;
    thumbQueue.length = 0;
    fsApkQueue.length = 0;
    if (thumbObs) { thumbObs.disconnect(); thumbObs = null; }
  } catch (e) {}
  ['dlg-appinfo', 'dlg-crashlog', 'dlg-appaudit', 'dlg-phonetransfer', 'dlg-clipboard'].forEach(id => {
    try { closeDlg(id); } catch (e) {}
  });
}

function setActive(serial) {
  const next = serial || null;
  const prev = activeSerial;
  if (next === prev) {
    renderTbDevice();
    renderActiveCard();
    renderDevices();
    renderSavedChipsState();
    updateToolsState();
    clipAutoStart();
    return;
  }
  if (prev) resetActiveDeviceState();
  activeSerial = next;
  invalidateAppsCache();
  // пользователь уже на вкладке приложений — сразу перечитываем список нового телефона
  if (next && $('#page-apps') && $('#page-apps').classList.contains('active')) appsLoad();
  if ($('#page-files') && $('#page-files').classList.contains('active')) {
    if (next) fsNavigate('/sdcard');
    else fsRender();
  }
  renderTbDevice();
  renderActiveCard();
  renderDevices();
  renderSavedChipsState();
  updateToolsState();
  clipAutoStart();
}

/* карточка активного устройства на странице «Подключение» */
async function renderActiveCard() {
  const card = $('#active-card'), empty = $('#active-empty');
  const lastEl = $('#active-empty-last');
  if (lastEl) lastEl.textContent = '';
  const s = activeSerial;
  if (!s || !isOnline(s)) {
    card.classList.add('hidden');
    empty.classList.remove('hidden');
    if (lastEl) {
      const last = ((state && state.history) || []).slice().sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))[0];
      if (last && last.lastTs) {
        lastEl.textContent = 'Последнее подключение: ' + (last.model || (last.host + ':' + last.port)) + ' — ' + relTime(last.lastTs);
      }
    }
    $('#tools-active-label').textContent = '';
    $('#fs-active-label').textContent = '';
    $('#apps-active-label').textContent = '';
    return;
  }
  card.classList.remove('hidden');
  empty.classList.add('hidden');
  $('#ad-name').textContent = nameOf(s);
  $('#ad-serial').textContent = s + (isUsb(s) ? ' · USB' : '');
  const d = devices.find(x => x.serial === s);
  const chips = [];
  if (d && d.android) chips.push('Android <b>' + esc(d.android) + '</b>');
  const info = infoCache[s] && infoCache[s].info;
  if (info && info.battery && info.battery !== '?') chips.push('Батарея <b>' + esc(info.battery) + '%</b>');
  if (pingCache[s] != null) chips.push('Пинг <b>' + pingCache[s] + ' мс</b>');
  chips.push(isUsb(s) ? '<b>USB</b>' : '<b>Wi-Fi</b>');
  $('#ad-chips').innerHTML = chips.join('');
  const label = nameOf(s);
  $('#tools-active-label').textContent = 'Устройство: ' + label;
  $('#fs-active-label').textContent = 'Устройство: ' + label;
  $('#apps-active-label').textContent = 'Устройство: ' + label;
  devInfoText(s);
}
const pingCache = {};
let pingBusy = false;
async function pingActive() {
  if (!activeSerial || !isOnline(activeSerial) || pingBusy) return;
  pingBusy = true;
  try {
    const r = await window.api.adbPing(activeSerial);
    if (r.ok) {
      pingCache[activeSerial] = r.ms;
      if (activeSerial) renderActiveCard();
    }
  } catch (e) {}
  pingBusy = false;
}

/* ---------- устройства: карточки + списки ---------- */
let refreshBusy = false; // W10-ревизор: не плодим параллельные опросы adb на медленном устройстве
// активное устройство НЕ сбрасывается с первого пропуска опроса — adb иногда
// «моргает» на 1–2 секунды, а из-за этого пропадал телефон и глушились инструменты.
let _activeMiss = 0;
let _activeMissSerial = null;
async function refreshDevices() {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    const r = await window.api.adbDevices();
    devices = r.ok ? r.list : [];
  // adb показывает один и тот же телефон ДВАЖДЫ — по IP и по mDNS
  // (adb-<serial>-..._adb-tls-connect._tcp). Оставляем IP-запись, mDNS-дубль скрываем.
  const _seenDev = new Set();
  devices = devices.filter(d => {
    if (d.state !== 'device') return true;
    const key = ((d.props && d.props.device) || '') + '|' + (d.model || (d.props && d.props.model) || '');
    if (key === '|') return true;
    const mdns = /_adb-tls|\._tcp/.test(d.serial);
    if (_seenDev.has(key) && mdns) return false;
    _seenDev.add(key);
    return true;
  });
  const online = onlineDevices();
  // потеря активного устройства (A1-ревью): сбрасываем, глушим привязанные инструменты,
  // если в сети ровно одно — назначаем его активным автоматически.
  // только после 3 подряд пропусков (~15 с), чтобы не терять устройство из-за сбоя.
  const activeGone = !!activeSerial && !online.some(d => d.serial === activeSerial);
  if (activeGone) {
    if (_activeMissSerial !== activeSerial) { _activeMissSerial = activeSerial; _activeMiss = 0; }
    _activeMiss++;
  } else {
    _activeMiss = 0;
    _activeMissSerial = null;
  }
  if (activeGone && _activeMiss >= 3) {
    logLostActive(activeSerial);
    setActive(null);
    _activeMiss = 0;
    _activeMissSerial = null;
    if (online.length === 1) setActive(online[0].serial);
  }
  // если активное не выбрано, а устройства в сети есть — выбираем ПЕРВОЕ,
  // иначе шапка оставалась «устройство не выбрано» при подключённом телефоне.
  if (!activeSerial && online.length) setActive(online[0].serial);
  renderTbDevice();
  renderActiveCard();
  renderDevices();
  renderSavedChipsState();
  updateToolsState();
  } finally { refreshBusy = false; }
}

// «active lost» в журнале не чаще раза в 2 минуты на serial — раньше при устаревшем
// порте сообщение спамило каждые 5 секунд (refreshDevices) и засоряло логфайл
const _lostLoggedAt = {};
function logLostActive(serial) {
  const t = Date.now();
  if (_lostLoggedAt[serial] && t - _lostLoggedAt[serial] < 120000) return;
  _lostLoggedAt[serial] = t;
  try { window.api.uiLog('active lost: ' + serial); } catch (e) {}
}

function renderDevices() {
  const box = $('#device-list');
  const online = onlineDevices();
  // активное устройство показано в карточке ВЫШЕ — не дублируем его в списке,
  // иначе «одно и то же устройство в двух местах». Список = остальные подключённые.
  const others = online.filter(d => d.serial !== activeSerial);
  $('#device-empty').classList.toggle('hidden', others.length > 0);
  if (!others.length) {
    const inner = online.length
      ? '<div class="empty">Подключено только активное устройство — оно показано выше.</div>'
      : '<div class="empty">Нет подключённых устройств. Подключите телефон способами ниже.</div>';
    box.innerHTML = inner;
    return;
  }
  box.innerHTML = others.map(d => {
    const isNet = !isUsb(d.serial);
    const [host, port] = isNet ? d.serial.split(':') : [null, null];
    const fav = (state.favorites || []).some(f => f.host === host && f.port === +port);
    const act = d.serial === activeSerial;
    return `<div class="card dev-card">
      <div class="dev-name"><span class="dot${act ? '' : ' off'}"></span>${connIcon(d.serial)}${esc(d.friendly || d.model || d.props.product || d.serial)}
        <span class="${chipClass(d.serial)}">${stText(d.serial)}</span>
        ${isNet ? `<button class="star ${fav ? 'on' : ''}" data-fav="${esc(d.serial)}" data-tip="В избранное">&#9733;</button>` : ''}
      </div>
      <div class="dev-serial" data-copy="${esc(d.serial)}" data-tip="Нажмите, чтобы скопировать">${esc(d.serial)} <span id="info-${esc(d.serial).replace(/[:.]/g, '_')}"></span></div>
      <div class="dev-actions">
        ${!act ? `<button class="btn btn-tonal btn-sm" data-setact="${esc(d.serial)}" data-tip="Сделать активным (текущее не отключается)">Сделать активным</button>` : ''}
        <button class="btn btn-tonal btn-sm" data-tools="${esc(d.serial)}">Инструменты</button>
        <button class="btn btn-text btn-sm" data-info="${esc(d.serial)}">Об устройстве</button>
        ${isNet ? `<button class="btn btn-text btn-sm" data-disc="${esc(d.serial)}">Отключить</button>` : ''}
        ${!isNet ? `<button class="btn btn-text btn-sm" data-usbrestart="${esc(d.serial)}" data-tip="Перезагрузить USB-порт без отключения кабеля — помогает, когда телефон завис и перестал определяться. Windows запросит права администратора.">Перезагрузить USB</button>` : ''}
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-tools]').forEach(b => b.onclick = () => {
    setActive(b.dataset.tools);
    goPage('tools');
  });
  box.querySelectorAll('[data-setact]').forEach(b => b.onclick = () => {
    setActive(b.dataset.setact);
    snack('Активное устройство: ' + nameOf(b.dataset.setact));
  });
  box.querySelectorAll('[data-info]').forEach(b => b.onclick = () => openDevInfo(b.dataset.info));
  box.querySelectorAll('[data-disc]').forEach(b => b.onclick = async () => {
    const ser = b.dataset.disc;
    const r = await window.api.adbDisconnect(ser);
    // вместе с IP-адресом отключаем и его mDNS-дубль, иначе телефон «не отключается»
    const mdns = online.find(d => d.serial !== ser && /^adb-.*\._tcp/.test(d.serial));
    if (mdns) await window.api.adbDisconnect(mdns.serial).catch(() => null);
    if (activeSerial === ser || (mdns && activeSerial === mdns.serial)) {
      activeSerial = null;
      _activeMiss = 0;
      invalidateAppsCache();
    }
    snack(r.message || 'Отключено');
    refreshDevices();
  });
  box.querySelectorAll('[data-usbrestart]').forEach(b => b.onclick = async () => {
    const ser = b.dataset.usbrestart;
    const yes = await uiConfirm('Перезагрузка USB-порта', 'Перезагрузить USB-устройство «' + nameOf(ser) + '»? Кабель можно не отключать. Windows запросит права администратора.');
    if (!yes || !yes.ok) return;
    b.disabled = true; b.textContent = 'Перезагружаю…';
    const r = await window.api.usbRestart(ser).catch(e => ({ ok: false, error: e.message }));
    b.disabled = false; b.textContent = 'Перезагрузить USB';
    snack(r && r.ok ? 'USB-порт перезагружен' + (r.instance ? ': ' + r.instance : '') : 'Не удалось: ' + ((r && r.error) || 'ошибка'));
    setTimeout(() => refreshDevices(), 2500);
  });
  box.querySelectorAll('[data-copy]').forEach(el => el.onclick = () => copyText(el.dataset.copy));
  for (const d of others) {
    devInfoText(d.serial).then(t => {
      const el = document.getElementById('info-' + d.serial.replace(/[:.]/g, '_'));
      if (el) el.textContent = t ? '· ' + t : '';
    });
  }
  box.querySelectorAll('[data-fav]').forEach(b => b.onclick = async () => {
    const [host, port] = b.dataset.fav.split(':');
    const d = devices.find(x => x.serial === b.dataset.fav);
    state.favorites = await window.api.favToggle({ host, port: +port, model: d && d.model });
    renderDevices(); renderFavorites();
  });
}
// вместо пустой заглушки — реальное обновление статусов «Моих устройств» и «Избранного».
// Перерисовываем только когда изменился набор онлайн-устройств или активное (без мигания каждые 5 с).
let _savedSig = '';
function renderSavedChipsState() {
  const sig = (activeSerial || '') + '|' + onlineDevices().map(d => d.serial).sort().join(',');
  if (sig === _savedSig) return;
  _savedSig = sig;
  Promise.resolve().then(() => { renderSaved(); renderFavorites(); }).catch(() => {});
}

function renderHistory() {
  const box = $('#hist-list');
  const h = (state && state.history) || [];
  $('#hist-empty').classList.toggle('hidden', h.length > 0);
  box.innerHTML = h.map(x => {
    const ser = x.host + ':' + x.port;
    return `<div class="list-row">
      <span class="scan-ico" data-tip="Подключение по Wi-Fi">${CONN_ICONS.wifi}</span>
      <span class="mono grow2" data-copy="${esc(ser)}" style="cursor:copy">${esc(x.model || 'Без имени')} <span class="muted">${esc(x.host)}:${esc(x.port)}</span> <span class="${chipClass(ser)}">${stText(ser)}</span></span>
      <span class="muted" title="${esc(x.lastTs ? fmtTs(x.lastTs) : '')}">${esc(x.lastTs ? relTime(x.lastTs) : '')}</span>
      <button class="btn btn-tonal btn-sm" data-hc="${esc(ser)}">Подключить</button>
      <button class="btn btn-text btn-sm" data-hx="${esc(ser)}" data-tip="Убрать">&#x2715;</button>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-hc]').forEach(b => b.onclick = () => {
    const [host, port] = b.dataset.hc.split(':');
    doConnect(host, +port);
  });
  box.querySelectorAll('[data-hx]').forEach(b => b.onclick = async () => {
    const [host, port] = b.dataset.hx.split(':');
    state.history = await window.api.histRemove(host, +port);
    renderHistory(); renderRecents();
  });
  box.querySelectorAll('[data-copy]').forEach(el => el.onclick = () => copyText(el.dataset.copy));
  renderRecents();
}

// чипы «Недавно подключённые» — быстрый доступ без прокрутки к истории (A1)
function renderRecents() {
  const box = $('#recents-chips');
  if (!box) return;
  const h = ((state && state.history) || []).slice(0, 3);
  box.innerHTML = h.length ? '<span class="muted small">Недавние:</span>' + h.map(x => {
    const ser = x.host + ':' + x.port;
    return `<button class="chip" data-rc="${esc(ser)}" data-tip="${esc(ser)}">${esc(x.model || x.host)} <span class="muted">${stText(ser)}</span></button>`;
  }).join('') : '';
  box.querySelectorAll('[data-rc]').forEach(b => b.onclick = () => {
    const [host, port] = b.dataset.rc.split(':');
    doConnect(host, +port);
  });
}

function renderFavorites() {
  const box = $('#fav-list');
  const f = state.favorites || [];
  $('#fav-empty').classList.toggle('hidden', f.length > 0);
  box.innerHTML = f.map(x => {
    const ser = x.host + ':' + x.port;
    return `<div class="card dev-card">
      <div class="dev-name"><span class="dot${isOnline(ser) ? (ser === activeSerial ? '' : ' off') : ' off'}"></span>${connIcon(ser)}${esc(x.model || x.host)}
        <span class="${chipClass(ser)}">${stText(ser)}</span>
        <button class="star on" data-favr="${esc(ser)}">&#9733;</button></div>
      <div class="dev-serial" data-copy="${esc(ser)}" style="cursor:copy">${esc(ser)}</div>
      <div class="dev-actions"><button class="btn btn-tonal btn-sm" data-fc="${esc(ser)}">Подключить</button></div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-fc]').forEach(b => b.onclick = () => {
    const [host, port] = b.dataset.fc.split(':');
    doConnect(host, +port);
  });
  box.querySelectorAll('[data-favr]').forEach(b => b.onclick = async () => {
    const [host, port] = b.dataset.favr.split(':');
    state.favorites = await window.api.favToggle({ host, port: +port });
    renderDevices(); renderFavorites();
  });
  box.querySelectorAll('[data-copy]').forEach(el => el.onclick = () => copyText(el.dataset.copy));
}

async function doConnect(host, port) {
  if (!host) return snack('Введите IP-адрес');
  snack('Подключение к ' + host + ':' + port + '…');
  const r = await window.api.adbConnect(host, +port);
  if (r.ok) {
    // main может «самоисцелиться» — найти живой порт, если введённый закрыт
    const hp = r.host ? r.host : host, hport = r.port ? r.port : port;
    snack(r.healed ? (r.message || 'Подключено через другой порт') : 'Подключено: ' + hp + ':' + hport);
    state = await window.api.getState();
    setActive(hp + ':' + hport);
    renderHistory(); renderFavorites();
    refreshDevices();
    snd.play('connect');
  } else {
    snack('Не удалось подключиться: ' + (r.message || r.error || 'ошибка'), 7000);
  }
}

$('#btn-connect').onclick = () => {
  let host = $('#in-ip').value.trim();
  let port = $('#in-port').value.trim() || '5555';
  const m = host.match(/^([\d.]+):(\d+)$/);   // «192.0.2.42:5555» как на телефоне
  if (m) { host = m[1]; port = m[2]; $('#in-ip').value = host; $('#in-port').value = port; }
  doConnect(host, port);
};
$('#in-ip').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-connect').click(); });
$('#btn-hist-clear').onclick = async () => { state.history = await window.api.histClear(); renderHistory(); };
  $('#btn-help').onclick = () => openDlg('dlg-help');
  $('#btn-usb-restart').onclick = async () => {
    const yes = await uiConfirm('Перезагрузка USB-порта', 'Найти USB-устройство телефона и перезагрузить порт? Кабель можно не отключать. Windows запросит права администратора.');
    if (!yes || !yes.ok) return;
    const b = $('#btn-usb-restart');
    b.disabled = true; b.textContent = 'Перезагружаю…';
    const r = await window.api.usbRestart('auto').catch(e => ({ ok: false, error: e.message }));
    b.disabled = false; b.textContent = 'Перезагрузить USB-порт';
    snack(r && r.ok ? 'USB-порт перезагружен' + (r.instance ? ': ' + r.instance : '') : 'Не удалось: ' + ((r && r.error) || 'ошибка'));
    setTimeout(() => refreshDevices(), 3000);
  };
$('#adb-banner-link').onclick = (e) => { e.preventDefault(); goPage('settings'); };

/* активная карточка: кнопки */
$('#btn-ad-tools').onclick = () => goPage('tools');
$('#btn-ad-info').onclick = () => { if (activeSerial) openDevInfo(activeSerial); };
$('#btn-ad-disc').onclick = async () => {
  if (!activeSerial) return;
  const ser = activeSerial;
  const r = await window.api.adbDisconnect(ser).catch(() => ({ ok: false, message: 'не удалось отключить' }));
  // отключаем и mDNS-дубль активного устройства
  const mdns = (devices || []).find(d => d.serial !== ser && /^adb-.*\._tcp/.test(d.serial));
  if (mdns) await window.api.adbDisconnect(mdns.serial).catch(() => null);
  activeSerial = null;
  _activeMiss = 0;
  invalidateAppsCache();
  snack(r.message || (r.ok ? 'Отключено' : 'Отключено'));
  refreshDevices();
};
$('#ad-serial').onclick = () => copyText($('#ad-serial').textContent);

/* ---------- сканирование ---------- */
function renderScanResults() {
  const box = $('#scan-results');
  if (!scanFound.length) {
    box.innerHTML = '<div class="empty">В локальной сети не найдено ни открытого порта 5555, ни mDNS-сервисов беспроводной отладки. Смотрите подсказку ниже.</div>';
    return;
  }
  box.innerHTML = scanFound.map((f, i) => {
    // значок способа обнаружения — сразу видно, откуда взялось устройство
    const lbl = String(f.label || 'порт 5555');
    const ico = /mDNS/i.test(lbl) ? '&#128225;'          // 📡 mDNS-обнаружение
      : /истори/i.test(lbl) ? '&#128337;'               // 🕘 из истории
      : /избран/i.test(lbl) ? '&#11088;'                // ⭐ избранное
      : /порт/i.test(lbl) ? '&#128268;'                 // 🔌 свип портов 5555
      : '&#127760;';                                    // 🌐 сеть
    return `<div class="list-row">
      <span class="scan-ico" data-tip="${esc(lbl)}">${ico}</span>
      <span class="mono grow2">${f.model ? '<b>' + esc(f.model) + '</b> · ' : ''}${esc(f.host)}:${esc(f.port)} <span class="muted">· ${esc(lbl)}${f.sid ? ' · ' + esc(f.sid) : ''}${f.model ? '' : ' · имя появится после подключения'}</span></span>
      <button class="btn btn-tonal btn-sm" data-sc="${i}">Подключить</button>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-sc]').forEach(b => b.onclick = () => {
    const f = scanFound[+b.dataset.sc];
    doConnect(f.host, f.port);
  });
}

$('#btn-scan').onclick = async () => {
  $('#scan-card').classList.remove('hidden');
  $('#scan-card').classList.remove('scanning-done');
  $('#scan-progress').classList.remove('hidden');
  $('#scan-title').textContent = 'Сканирование локальной сети…';
  $('#scan-results').innerHTML = '';
  $('#scan-bar').style.width = '0%';
  $('#scan-progress-text').textContent = '0%';
  scanFound = [];
  const found = await window.api.scanSubnet();
  scanFound = (found || []).map(x => ({ host: x.host, port: x.port, label: x.label || 'порт 5555', sid: x.sid, model: x.model || null }));
  renderScanResults();
};

/* ---------- сопряжение (инлайн на странице, R4/R6) ---------- */
$('#btn-do-pair').onclick = async () => {
  const host = $('#pair-ip').value.trim();
  const port = $('#pair-port').value.trim();
  const code = $('#pair-code').value.trim();
  if (!/^[\d.]+$/.test(host)) return snack('Введите IP сопряжения');
  if (!port) return snack('Введите порт сопряжения или нажмите «Найти порт»');
  if (!/^\d{4,8}$/.test(code)) return snack('Введите код сопряжения (цифры)');
  $('#btn-do-pair').disabled = true;
  snack('Сопряжение…');
  const r = await window.api.adbPair(host, port, code);
  $('#btn-do-pair').disabled = false;
  if (r.ok) {
    snack('Сопряжение выполнено. Теперь найдём устройство…');
    await pairFindAndConnect(host);
  } else {
    snack('Сопряжение не удалось: ' + (r.error || r.message || ''));
  }
};

$('#btn-find-port').onclick = async () => {
  const host = $('#pair-ip').value.trim();
  if (!/^[\d.]+$/.test(host)) return snack('Сначала введите IP');
  snack('Ищу порты на ' + host + '…');
  const ports = await window.api.adbPortScan(host);
  if (!ports.length) return snack('Открытых портов в диапазоне 30000–44999 нет');
  $('#pair-port').value = ports[0];
  snack('Найдены порты: ' + ports.join(', ') + ' — подставлен первый');
};

$('#btn-auto-pair').onclick = async () => {
  const host = $('#pair-ip').value.trim();
  const code = $('#pair-code').value.trim();
  const port = $('#pair-port').value.trim();
  if (!/^[\d.]+$/.test(host)) return snack('Введите IP');
  if (!/^\d{4,8}$/.test(code)) return snack('Введите код с телефона');
  $('#btn-auto-pair').disabled = true;
  snack('Авто: поиск портов, сопряжение, подключение…');
  const r = await window.api.adbAutoPair(host, code, port ? +port : null);
  $('#btn-auto-pair').disabled = false;
  if (r.ok) {
    snack('Подключено: ' + r.host + ':' + r.port);
    state = await window.api.getState();
    setActive(r.host + ':' + r.port);
    renderHistory(); refreshDevices();
  }
  else snack(r.error || 'Не удалось');
};

async function pairFindAndConnect(knownHost) {
  const md = await window.api.mdnsDiscover();
  const conn = (md || []).filter(x => (x.service || '').includes('connect'));
  if (conn.length) {
    for (const c of conn) await doConnect(c.host, c.port);
    return;
  }
  if (knownHost) {
    const ports = await window.api.adbPortScan(knownHost);
    const cand = ports.filter(p => p !== +$('#pair-port').value);
    for (const p of cand) { const r = await window.api.adbConnect(knownHost, p); if (r.ok) return; }
    if (cand.length) return snack('Порты найдены, но подключение не удалось — разрешите отладку на телефоне');
  }
  snack('Устройство не найдено по mDNS. Введите IP и порт с экрана «Беспроводная отладка».');
}

$('#btn-pair-mdns').onclick = () => pairFindAndConnect($('#pair-ip').value.trim() || null);

/* ---------- QR-подключение: ПК показывает код, телефон сканирует камерой (R2) ----------
   QR показывается СРАЗУ на карточке сопряжения (панель #qr-inline ~156×149 px),
   без отдельного диалога и без повторных нажатий; шаги «поиск → сопряжение → подключено»
   видны мгновенно строкой под кодом. */
function qrSetStatus(text, cls) {
  const el = $('#qr-pc-status');
  el.textContent = text;
  el.className = 'qr-status' + (cls ? ' ' + cls : '');
  qrLog(text);
}
function qrLog(text) {
  const box = $('#qr-pc-log');
  if (!box) return;
  const div = document.createElement('div');
  div.textContent = text;
  box.appendChild(div);
  while (box.children.length > 4) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}
async function qrBegin() {
  const panel = $('#qr-inline');
  if (panel) panel.classList.remove('hidden');
  qrSetStatus('Готовим QR-код…', '');
  const r = await window.api.qrStart();
  if (!r.ok) { qrSetStatus(r.error || 'Не удалось запустить сессию', 'err'); return; }
  qrActive = true;
  QRCodeLib.toCanvas($('#qr-pc-canvas'), r.qrText, { width: 156, height: 149, margin: 0, color: { dark: '#000000', light: '#ffffff' } }, err => {
    if (err) qrSetStatus('Ошибка отрисовки QR: ' + err.message, 'err');
    else qrSetStatus('Сканируйте камерой телефона: «Беспроводная отладка» → «Подключить по QR-коду»', '');
  });
}
function qrHidePanel() { qrActive = false; const p = $('#qr-inline'); if (p) p.classList.add('hidden'); }
$('#btn-qr-show').onclick = () => { if (qrActive) { window.api.qrCancel(); } qrBegin(); };
$('#btn-qr-cancel-inline').onclick = () => { window.api.qrCancel(); qrHidePanel(); };

/* ---------- инструменты: состояние и общие ---------- */
function currentSerial() { return activeSerial; }
function updateToolsState() {
  const ok = !!activeSerial;
  $$('#tools-grid .btn, #tools-grid .chip').forEach(b => {
    if (b.id === 'btn-diag') return; // диагностика доступна и без устройства
    if (b.id === 'btn-unlock-clear') return; // очистка рисунка работает и без телефона
    b.disabled = !ok;
    if (!ok && !b.dataset.tip) b.setAttribute('data-tip', 'Сначала подключите устройство на странице «Подключение»');
  });
  $('#tools-grid').style.opacity = ok ? '1' : '.5';
  $('#tools-nodevice').classList.toggle('hidden', ok);
}

/* история буфера обмена телефона (через временный scrcpy-server, без APK) */
let clipItems = [];
let clipRunning = false;
function clipRender() {
  const list = $('#clip-list');
  if (!list) return;
  const b = $('#btn-clip-toggle');
  const st = $('#clip-status');
  if (b) b.textContent = clipRunning ? 'Остановить' : 'Подключить';
  if (st) st.textContent = clipRunning ? 'подключено — копируйте текст на телефоне' : 'не подключено';
  if (!clipItems.length) {
    list.innerHTML = '<div class="empty">' + (clipRunning
      ? 'Пока пусто. Скопируйте текст на телефоне — он появится здесь.'
      : 'Подключите буфер, затем скопируйте текст на телефоне.') + '</div>';
    return;
  }
  list.innerHTML = clipItems.map((it, i) => {
    const one = String(it.text || '').replace(/\s+/g, ' ').slice(0, 180);
    return `<div class="list-row">
      <span class="mono grow2" style="word-break:break-all">${esc(one)}</span>
      <span class="muted small">${esc(fmtTs(it.ts))}</span>
      <button class="btn btn-text btn-sm" data-clip-copy="${i}" data-tip="Скопировать в буфер Windows">Копировать</button>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-clip-copy]').forEach(btn => btn.onclick = async () => {
    const it = clipItems[+btn.dataset.clipCopy];
    if (!it) return;
    const r = await window.api.clipCopy(it.text);
    snack(r && r.ok ? 'Скопировано в буфер Windows' : 'Не удалось скопировать');
  });
}
function clipAutoStart() {
  // буфер обмена всегда включён — запускаем вместе с активным устройством.
  if (!activeSerial || clipRunning) return;
  window.api.clipStart(activeSerial).catch(() => {});
}
async function clipRefresh() {
  try {
    const r = await window.api.clipState();
    if (r && r.ok) { clipRunning = !!r.running; clipItems = (r.items || []).slice(); }
  } catch (e) {}
  clipRender();
}
async function clipToggle() {
  if (clipRunning) {
    await window.api.clipStop().catch(() => {});
    clipRunning = false;
    clipRender();
    return;
  }
  const s = activeSerial;
  if (!s) return snack('Сначала подключите устройство');
  const b = $('#btn-clip-toggle');
  if (b) b.disabled = true;
  if ($('#clip-status')) $('#clip-status').textContent = 'Запускаю scrcpy…';
  const r = await window.api.clipStart(s);
  if (b) b.disabled = false;
  if (!r || !r.ok) {
    snack('Не удалось запустить: ' + ((r && r.error) || 'ошибка'));
    clipRunning = false;
  } else {
    clipRunning = true;
    snack('Буфер обмена подключён. Скопируйте текст на телефоне.');
  }
  clipRender();
}
$('#btn-clipboard').onclick = () => { openDlg('dlg-clipboard'); clipRefresh(); };
$('#btn-clip-toggle').onclick = clipToggle;
$('#btn-clip-clear').onclick = async () => {
  await window.api.clipClear().catch(() => {});
  clipItems = [];
  clipRender();
};
window.api.onClipItem(item => {
  if (!item || !item.text) return;
  clipItems.unshift(item);
  if (clipItems.length > 50) clipItems.length = 50;
  if ($('#dlg-clipboard') && !$('#dlg-clipboard').classList.contains('hidden')) clipRender();
});
window.api.onClipStatus(st => {
  if (!st) return;
  clipRunning = !!st.running;
  if (st.error) snack('Буфер обмена: ' + st.error);
  clipRender();
});

$('#btn-devices-refresh').onclick = refreshDevices;

$('#btn-screenshot').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет подключённого устройства');
  snack('Делаю снимок…');
  const r = await window.api.toolScreenshot(s);
  if (r.ok) { snack('Сохранено: ' + r.file); window.api.showItem(r.file); }
  else if (!r.canceled) snack('Ошибка снимка: ' + (r.error || ''));
};

function recordUIReset() {
  $('#btn-record-stop').classList.add('hidden');
  $('#btn-record-start').classList.remove('hidden');
}
$('#btn-record-start').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет подключённого устройства');
  const r = await window.api.toolRecordStart(s);
  if (!r.ok) return snack(r.error || 'Ошибка записи');
  recStart = Date.now();
  $('#btn-record-start').classList.add('hidden');
  $('#btn-record-stop').classList.remove('hidden');
  recTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - recStart) / 1000);
    $('#rec-timer').textContent = String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  }, 500);
};
$('#btn-record-stop').onclick = async () => {
  clearInterval(recTimer); recTimer = null;
  recordUIReset();
  snack('Останавливаю запись и сохраняю…');
  const r = await window.api.toolRecordStop();
  if (r.ok) { snack('Видео сохранено: ' + r.file); window.api.showItem(r.file); }
  else if (!r.canceled) snack('Ошибка записи: ' + (r.error || ''));
};

/* ---------- пароль разблокировки устройства ---------- */
function unlockTypeLabel(t) { return t === 'pattern' ? 'графический ключ' : 'PIN/пароль'; }
async function unlockRefresh() {
  const s = currentSerial();
  const st = $('#unlock-status');
  if (!st) return;
  await unlockCountRefresh();
  if (!s) { st.textContent = 'нет подключённого устройства'; return; }
  try {
    const r = await window.api.unlockGet(s);
    if (r && r.has) st.textContent = 'сохранён: ' + unlockTypeLabel(r.type) + ', ' + r.length + ' символов' + (r.model ? ' · ' + r.model : '');
    else if (r && r.encrypted === false) st.textContent = 'пароль не сохранён (шифрование Windows недоступно)';
    else st.textContent = 'пароль не сохранён';
    if (r && r.has) $('#unlock-type').value = r.type || 'pin';
    unlockHintUpdate();
  } catch (e) { st.textContent = 'пароль не сохранён'; }
}
async function unlockCountRefresh() {
  try {
    const r = await window.api.unlockList();
    const n = (r && r.items) ? r.items.length : 0;
    const b = $('#btn-unlock-list');
    if (b) b.textContent = 'Список сохранённых (' + n + ')';
    return n;
  } catch (e) { return 0; }
}
function unlockHintUpdate() {
  const h = $('#unlock-hint');
  const isPattern = $('#unlock-type').value === 'pattern';
  const wrap = $('#unlock-pad-wrap');
  if (wrap) wrap.classList.toggle('hidden', !isPattern);
  const pin = $('#unlock-pin');
  if (pin) pin.classList.toggle('hidden', isPattern);
  if (!h) return;
  h.textContent = isPattern
    ? 'Нарисуйте ключ мышью или введите последовательность цифрами (например 1-5-9-6-3). Одну точку нельзя использовать дважды — как на телефоне. Ключ будет нарисован на экране (Android 11+).'
    : 'Поддерживается цифровой PIN и текстовый пароль. Если пароля нет вообще (только свайп), хватит пробуждения и свайпа — поле можно оставить пустым.';
}
/* рисуемое поле графического ключа — точь-в-точь как на телефоне */
const unlockPad = (() => {
  const cv = $('#unlock-pad');
  if (!cv) return null;
  const ctx = cv.getContext('2d');
  const seq = [];
  let dragging = false, cx = -1, cy = -1;
  const N = 3, DPR = () => Math.min(2, window.devicePixelRatio || 1);
  function parsePattern(v) {
    const seen = new Set(), out = [];
    for (const ch of String(v || '')) {
      const n = ch.charCodeAt(0) - 48;
      if (n >= 1 && n <= 9 && !seen.has(n)) { seen.add(n); out.push(n - 1); }
    }
    return out;
  }
  function layout() {
    const dpr = DPR();
    const cssW = cv.clientWidth || 240, cssH = cv.clientHeight || 240;
    if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
      cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    }
    const pad = 34 * dpr, sz = Math.min(cv.width, cv.height) - pad * 2;
    const step = sz / (N - 1);
    return { dpr, ox: pad, oy: (cv.height - sz) / 2, step, r: Math.max(7, step * 0.17) };
  }
  function nodePos(i, L) {
    const col = i % N, row = Math.floor(i / N);
    return { x: L.ox + col * L.step, y: L.oy + row * L.step };
  }
  function draw() {
    const L = layout();
    ctx.clearRect(0, 0, cv.width, cv.height);
    // дорожка
    if (seq.length) {
      ctx.lineWidth = Math.max(3, L.step * 0.09);
      ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--accent') || '#7c9cff';
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      const first = nodePos(seq[0], L);
      ctx.moveTo(first.x, first.y);
      for (let k = 1; k < seq.length; k++) { const p = nodePos(seq[k], L); ctx.lineTo(p.x, p.y); }
      if (dragging && cx >= 0) ctx.lineTo(cx, cy);
      ctx.stroke();
    }
    // точки
    for (let i = 0; i < N * N; i++) {
      const p = nodePos(i, L);
      const active = seq.includes(i);
      ctx.beginPath();
      ctx.arc(p.x, p.y, active ? L.r * 1.35 : L.r, 0, Math.PI * 2);
      ctx.fillStyle = active ? (getComputedStyle(document.body).getPropertyValue('--accent') || '#7c9cff') : 'rgba(150,165,180,.35)';
      ctx.fill();
      if (active) {
        ctx.beginPath(); ctx.arc(p.x, p.y, L.r * 0.55, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fill();
      }
    }
  }
  function hit(px, py, L) {
    for (let i = 0; i < N * N; i++) {
      const p = nodePos(i, L);
      const dx = px - p.x, dy = py - p.y;
      if (dx * dx + dy * dy <= Math.pow(L.step * 0.42, 2)) return i;
    }
    return -1;
  }
  function pos(e) {
    const r = cv.getBoundingClientRect();
    const L = layout();
    return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height), L };
  }
  function syncInput() {
    const inp = $('#unlock-pattern');
    if (inp && document.activeElement !== inp) inp.value = seq.map(i => i + 1).join('-');
  }
  function syncLabel() {
    const el = $('#unlock-pad-seq');
    if (el) el.textContent = seq.length ? 'Ключ: ' + seq.map(i => i + 1).join('-') : 'Ключ не нарисован';
    syncInput();
  }
  function reset() {
    seq.length = 0; dragging = false; cx = cy = -1; draw(); syncLabel();
    const inp = $('#unlock-pattern'); if (inp) inp.value = '';
  }
  function setValue(v) {
    const next = parsePattern(v);
    seq.length = 0;
    for (const i of next) seq.push(i);
    dragging = false; cx = cy = -1; draw(); syncLabel();
  }
  cv.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    const p = pos(e); dragging = true; cx = p.x; cy = p.y;
    const i = hit(p.x, p.y, p.L);
    if (i >= 0 && !seq.includes(i)) seq.push(i);
    draw(); syncLabel();
  });
  cv.addEventListener('pointermove', e => {
    if (!dragging) return;
    const p = pos(e); cx = p.x; cy = p.y;
    const i = hit(p.x, p.y, p.L);
    if (i >= 0 && !seq.includes(i)) seq.push(i);
    draw(); syncLabel();
  });
  const up = () => { if (!dragging) return; dragging = false; cx = cy = -1; draw(); syncLabel(); };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('pointerleave', up);
  new ResizeObserver(() => draw()).observe(cv);
  draw(); syncLabel();
  return { get value() { return seq.map(i => i + 1).join('-'); }, reset, draw, set: setValue };
})();
$('#unlock-type').onchange = () => { unlockHintUpdate(); if (unlockPad) setTimeout(() => unlockPad.draw(), 50); };
const unlockPatternInput = $('#unlock-pattern');
if (unlockPatternInput && unlockPad) {
  unlockPatternInput.addEventListener('input', () => unlockPad.set(unlockPatternInput.value));
  unlockPatternInput.addEventListener('blur', () => { unlockPatternInput.value = unlockPad.value; });
}
const unlockClearBtn = $('#btn-unlock-clear');
if (unlockClearBtn) unlockClearBtn.onclick = () => {
  if (unlockPad) unlockPad.reset();
  snack('Ключ очищен');
};
$('#btn-unlock-save').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет подключённого устройства');
  const inp = $('#unlock-pin');
  const patternInp = $('#unlock-pattern');
  const type = $('#unlock-type').value;
  if (type === 'pattern' && unlockPad && patternInp && patternInp.value.trim()) {
    unlockPad.set(patternInp.value);
  }
  const pin = type === 'pattern'
    ? (unlockPad ? unlockPad.value : '')
    : (inp.value || '').trim();
  if (!pin) return snack(type === 'pattern' ? 'Нарисуйте ключ в поле выше (минимум две точки)' : 'Введите PIN или пароль');
  if (type === 'pattern' && !/^[1-9][\s\-–]*([1-9][\s\-–]*)+$/.test(pin)) return snack('Ключ: минимум две точки');
  const r = await window.api.unlockSet(s, pin, type);
  if (r.ok) {
    inp.value = '';
    if (type === 'pattern' && unlockPad) unlockPad.reset();
    snack((type === 'pattern' ? 'Ключ' : 'Пароль') + ' сохранён для ' + s);
  } else snack('Не сохранён: ' + (r.error || ''));
  unlockRefresh();
};
$('#btn-unlock-del').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет подключённого устройства');
  const ok = await uiConfirm('Удалить пароль', 'Удалить сохранённый пароль разблокировки для ' + s + '? Автоматическая разблокировка перестанет работать.');
  if (!ok || !ok.ok) return;
  await window.api.unlockDel(s);
  $('#unlock-pin').value = '';
  if (unlockPad) unlockPad.reset();
  snack('Пароль удалён');
  unlockRefresh();
};
$('#btn-unlock-run').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет подключённого устройства');
  const st = await window.api.unlockGet(s);
  if (!st.ok || !st.has) return snack('Сначала сохраните пароль для этого устройства');
  snack('Разблокирую…');
  const r = await window.api.unlockRun(s, 'full');
  snack(r.ok ? (st.type === 'pattern' ? 'Ключ нарисован' : 'Экран разблокирован') : ('Не удалось: ' + (r.error || '')));
};
// «лист» сохранённых паролей: для какого устройства, какой способ, когда сохранён
$('#btn-unlock-list').onclick = async () => {
  const box = $('#unlock-list-body');
  const r = await window.api.unlockList();
  const items = (r && r.items) || [];
  if (!items.length) {
    box.innerHTML = '<div class="empty">Список пуст — ни один пароль ещё не сохранён.</div>';
  } else {
    box.innerHTML = items.map(x => {
      const title = x.model ? esc(x.model) : (String(x.key).startsWith('hw:') ? 'Телефон ' + esc(String(x.key).slice(3)) : esc(x.key));
      return `<div class="list-row">
        <span class="grow2">${title} <span class="muted small">· ${esc(unlockTypeLabel(x.type))} · ${x.len} симв. · ${fmtTs(x.at)}</span></span>
        <button class="btn btn-text btn-sm" data-udel="${esc(x.key)}" data-tip="Удалить">Удалить</button>
      </div>`;
    }).join('');
  }
  box.querySelectorAll('[data-udel]').forEach(b => b.onclick = async () => {
    const ok = await uiConfirm('Удалить пароль', 'Удалить сохранённый пароль этого устройства?');
    if (!ok || !ok.ok) return;
    await window.api.unlockDelKey(b.dataset.udel);
    $('#btn-unlock-list').click();
    unlockRefresh();
  });
  openDlg('dlg-unlock-list');
};



/* ---------- сохранённые устройства ---------- */
async function renderSaved() {
  savedItems = await window.api.savedList();
  const list = savedItems;
  const box = $('#saved-list');
  $('#saved-empty').classList.toggle('hidden', list.length > 0);
  const hist = (state && state.history) || [];
  box.innerHTML = list.map(x => {
    const ser = x.host + ':' + x.port;
    const last = hist.find(h => h.host === x.host && h.port === x.port);
    return `<div class="card dev-card">
    <div class="dev-name"><span class="dot${ser === activeSerial ? '' : ' off'}"></span>${connIcon(ser)}${esc(x.name || x.host)}
      <span class="${chipClass(ser)}">${stText(ser)}</span></div>
    <div class="dev-serial" data-copy="${esc(ser)}" style="cursor:copy">${esc(ser)}${x.model ? ' · ' + esc(x.model) : ''}${last && last.lastTs ? ' · последнее: ' + esc(relTime(last.lastTs)) : ''}</div>
    <div class="dev-actions">
      <button class="btn btn-tonal btn-sm" data-sconn="${esc(x.id)}">${isOnline(ser) ? 'Сделать активным' : 'Подключить'}</button>
      <button class="btn btn-text btn-sm" data-sren="${esc(x.id)}">Переименовать</button>
      <button class="btn btn-text btn-sm" data-sdel="${esc(x.id)}">Удалить</button>
    </div></div>`;
  }).join('');
  box.querySelectorAll('[data-sconn]').forEach(b => b.onclick = async () => {
    const it = list.find(x => x.id === b.dataset.sconn);
    const ser = it.host + ':' + it.port;
    if (isOnline(ser)) { setActive(ser); snack('Активное устройство: ' + (it.name || ser)); }
    else doConnect(it.host, it.port);
  });
  box.querySelectorAll('[data-sren]').forEach(b => b.onclick = async () => {
    const it = list.find(x => x.id === b.dataset.sren);
    const name = await askText('Переименовать устройство', 'Имя устройства:', it.name || it.host);
    if (name) { await window.api.savedRename(it.id, name); renderSaved(); }
  });
  box.querySelectorAll('[data-sdel]').forEach(b => b.onclick = async () => {
    await window.api.savedRemove(b.dataset.sdel); renderSaved(); snack('Удалено из списка');
  });
  box.querySelectorAll('[data-copy]').forEach(el => el.onclick = () => copyText(el.dataset.copy));
  renderTbDevice();
}

$('#btn-saved-add').onclick = async () => {
  const online = onlineDevices();
  if (online.length) {
    const d = online[0];
    const [host, port] = d.serial.includes(':') ? d.serial.split(':') : [null, null];
    if (host) { await window.api.savedAdd({ host, port: +port, name: (d.friendly || d.model) || host, model: d.model }); }
    else snack('USB-устройства сохраняются автоматически при подключении по сети');
  } else {
    const s = await askText('Добавить устройство', 'IP:порт устройства (например 192.0.2.42:5555):', '');
    if (!s) return;
    const m = s.match(/^([\d.]+):(\d+)$/);
    if (!m) return snack('Формат: IP:порт');
    const name = (await askText('Имя устройства', 'Как назвать это устройство:', m[1])) || m[1];
    await window.api.savedAdd({ host: m[1], port: +m[2], name });
  }
  renderSaved(); snack('Сохранено');
};

/* ---------- инфо об устройстве ---------- */
const infoCache = {};
async function devInfoText(serial) {
  if (infoCache[serial] && Date.now() - infoCache[serial].ts < 30000) return infoCache[serial].text;
  try {
    const i = await window.api.devInfo(serial);
    const dv = (devices || []).find(x => x.serial === serial); const title = (dv && dv.friendly) || (i.manufacturer && i.model ? i.manufacturer + ' ' + i.model : ''); const text = [title, i.android ? 'Android ' + i.android : '', i.battery && i.battery !== '?' ? i.battery + '%' : '', i.screen ? i.screen : ''].filter(Boolean).join(' · ');
    infoCache[serial] = { ts: Date.now(), text, info: i };
    return text;
  } catch (e) { return ''; }
}

async function openDevInfo(serial) {
  let i;
  try { i = await window.api.devFull(serial); } catch (e) { snack('Не удалось получить данные устройства: ' + (e.message || e)); return; }
  if (!i || !i.model && !i.manufacturer) { snack('Устройство не отвечает'); return; }
  const st = i.storage ? ('занято ' + i.storage.used + ' из ' + i.storage.total + ', свободно ' + i.storage.free) : '—';
  $('#devinfo-body').innerHTML = [
    ['Производитель', i.manufacturer], ['Модель', i.model], ['Android', i.android],
    ['Сборка', i.build], ['Патч безопасности', i.patch], ['Процессор (ABI)', i.abi],
    ['Экран', i.screen], ['Батарея', i.battery + '%'], ['Память /data', st],
    ['ОЗУ (всего)', i.memTotalKb ? Math.round(i.memTotalKb / 1024 / 1024 * 10) / 10 + ' ГБ' : '—'],
    ['Имя в сети', i.hostname], ['Адрес подключения', serial]
  ].map(r => '<div><b>' + esc(r[0]) + ':</b> ' + esc(r[1] || '—') + '</div>').join('');
  openDlg('dlg-devinfo');
}

/* ---------- logcat: пауза + фильтр (R14) ---------- */
function logcatButtons() {
  $('#btn-logcat-start').classList.toggle('hidden', logcatOn);
  $('#btn-logcat-stop').classList.toggle('hidden', !logcatOn);
}
$('#btn-logcat-start').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет подключённого устройства');
  $('#logcat-view').textContent = '';
  logcatBuf = [];
  await window.api.toolLogcatStart(s);
  logcatOn = true; logcatPaused = false;
  $('#btn-logcat-pause').textContent = 'Пауза';
  logcatButtons();
};
$('#btn-logcat-stop').onclick = async () => {
  await window.api.toolLogcatStop();
  logcatOn = false;
  logcatButtons();
};
$('#btn-logcat-pause').onclick = () => {
  if (!logcatOn) return;
  logcatPaused = !logcatPaused;
  $('#btn-logcat-pause').textContent = logcatPaused ? 'Продолжить' : 'Пауза';
};
$('#btn-logcat-clear').onclick = async () => {
  $('#logcat-view').textContent = '';
  logcatBuf = [];
  const s = currentSerial(); if (s) await window.api.toolLogcatClear(s);
};
window.api.onLogcat(lines => {
  if (!logcatOn || logcatPaused) return;
  const q = ($('#logcat-filter').value || '').toLowerCase();
  const v = $('#logcat-view');
  let add = lines;
  if (q) add = lines.filter(l => l.toLowerCase().includes(q));
  if (add.length) {
    v.textContent += add.join('\n') + '\n';
    if (v.textContent.length > 200000) v.textContent = v.textContent.slice(-150000);
    v.scrollTop = v.scrollHeight;
  }
});

/* ---------- терминал: библиотека команд + свои команды + автодополнение (F16/F17) ---------- */
let shellOn = false;
const shellHist = []; let shellHistIdx = -1;
const ERR_RE = /\b(error|failed|failure|exception|not found|denied|invalid|unable|cannot|no such)\b/i;
function appendShell(text) {
  const v = $('#shell-view');
  for (const line of text.split('\n')) {
    const div = document.createElement('div');
    if (ERR_RE.test(line)) div.className = 'line-err';
    div.textContent = line;
    v.appendChild(div);
  }
  while (v.children.length > 1500) v.removeChild(v.firstChild);
  v.scrollTop = v.scrollHeight;
}
window.api.onShellOut(t => appendShell(t));
$('#btn-shell-toggle').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет подключённого устройства');
  if (shellOn) { await window.api.shellStop(); shellOn = false; $('#shell-view').textContent += '\n[сессия остановлена]\n'; }
  else { await window.api.shellStart(s); shellOn = true; $('#shell-view').textContent = '[сессия adb shell запущена]\n'; }
};
function shellSend() {
  const inp = $('#shell-input');
  const line = inp.value.trim();
  if (!line) return;
  $('#shell-view').textContent += '$ ' + line + '\n';
  shellHist.push(line); if (shellHist.length > 100) shellHist.shift();
  shellHistIdx = shellHist.length;
  window.api.shellWrite(line);
  inp.value = '';
  shellAcClose();
}
$('#btn-shell-send').onclick = shellSend;
$('#btn-shell-clear').onclick = () => { $('#shell-view').textContent = ''; };

// все варианты: библиотека по производителям + свои (Сохранения/Мои команды.json) + старые избранные
let customCmds = [];
function shellCmdOptions() {
  const lib = (window.CMDLIB || []).map(g => ({
    group: g.group,
    cmds: (g.cmds || []).map(c => ({ name: c.name, cmd: c.cmd, desc: c.desc || '', danger: !!c.danger, custom: false }))
  }));
  if (customCmds.length) {
    lib.unshift({ group: 'Мои команды (Сохранения)', cmds: customCmds.map(c => ({ name: c.name, cmd: c.cmd, desc: 'Своя команда — хранится в папке «Сохранения»', danger: false, custom: true })) });
  }
  return lib;
}
function allCmdFlat() {
  const out = [];
  for (const g of shellCmdOptions()) for (const c of g.cmds) out.push(c);
  return out;
}
function renderShellSelect() {
  const sel = $('#shell-cmd-select');
  sel.innerHTML = shellCmdOptions().map(g =>
    '<optgroup label="' + esc(g.group) + '">' +
    g.cmds.map(o => '<option title="' + esc(o.desc) + '" value="' + esc(o.cmd) + '">' + esc(o.name) + (o.danger ? ' ⚠' : '') + (o.custom ? ' ★' : '') + '</option>').join('') +
    '</optgroup>').join('');
  shellDesc();
}
function shellDesc() {
  const sel = $('#shell-cmd-select');
  const o = allCmdFlat().find(x => x.cmd === sel.value);
  $('#shell-cmd-desc').innerHTML = o
    ? (o.danger ? '<b style="color:var(--warn)">⚠ Внимание:</b> ' : '') + esc(o.desc)
    : '';
}
$('#shell-cmd-select').onchange = () => { shellDesc(); $('#shell-input').value = $('#shell-cmd-select').value; shellAcClose(); };
$('#shell-cmd-select').onmouseover = shellDesc;

// сохранить свою команду с именем (F16) — файл «Сохранения/Мои команды.json»
$('#btn-shell-cmd-save').onclick = async () => {
  const v = $('#shell-input').value.trim();
  if (!v) return snack('Сначала введите команду в поле ниже');
  const name = await askText('Своя команда', 'Как назвать команду для списка:', v.slice(0, 40));
  if (!name) return;
  const r = await window.api.cmdsAdd(name, v);
  if (!r.ok) return snack('Не удалось сохранить: ' + (r.error || ''));
  customCmds = r.list;
  renderShellSelect();
  snack('Сохранено в «Сохранения/Мои команды.json» ★');
};
// удалить выбранную свою команду
$('#btn-shell-cmd-del').onclick = async () => {
  const v = $('#shell-cmd-select').value;
  const c = customCmds.find(x => x.cmd === v);
  if (!c) return snack('Выберите в списке СВОЮ команду (группа «Мои команды»), чтобы удалить');
  const r = await window.api.cmdsRemove(v);
  customCmds = r.list;
  renderShellSelect();
  snack('Удалено из списка');
};

/* автодополнение ввода команд (F17): подсказки из всей библиотеки + своих */
const shellAc = $('#shell-ac');
let shellAcItems = [], shellAcIdx = -1;
function shellAcClose() { shellAc.classList.add('hidden'); shellAc.innerHTML = ''; shellAcItems = []; shellAcIdx = -1; }
function shellAcPick(i) {
  const it = shellAcItems[i];
  if (!it) return;
  $('#shell-input').value = it.cmd;
  shellAcClose();
  $('#shell-input').focus();
}
function shellAcRender() {
  shellAc.innerHTML = shellAcItems.map((it, i) =>
    '<div class="shell-ac-item' + (i === shellAcIdx ? ' sel' : '') + '" data-i="' + i + '">' +
    '<span class="ac-name">' + esc(it.name) + (it.danger ? ' ⚠' : '') + '</span>' +
    '<span class="ac-cmd mono">' + esc(it.cmd) + '</span></div>').join('');
  shellAc.classList.remove('hidden');
  shellAc.querySelectorAll('.shell-ac-item').forEach(el => {
    el.onmousedown = (e) => { e.preventDefault(); shellAcPick(+el.dataset.i); };
  });
}
$('#shell-input').addEventListener('input', () => {
  const q = $('#shell-input').value.trim().toLowerCase();
  if (!q) return shellAcClose();
  const flat = allCmdFlat();
  const starts = [], has = [];
  for (const c of flat) {
    const hay = (c.name + ' ' + c.cmd).toLowerCase();
    if (c.cmd.toLowerCase().startsWith(q) || c.name.toLowerCase().startsWith(q)) starts.push(c);
    else if (hay.includes(q)) has.push(c);
    if (starts.length >= 8) break;
  }
  shellAcItems = starts.concat(has).slice(0, 8);
  shellAcIdx = shellAcItems.length ? 0 : -1;
  shellAcItems.length ? shellAcRender() : shellAcClose();
});
$('#shell-input').addEventListener('keydown', e => {
  if (shellAcItems.length) {
    if (e.key === 'ArrowDown') { shellAcIdx = (shellAcIdx + 1) % shellAcItems.length; shellAcRender(); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') { shellAcIdx = (shellAcIdx - 1 + shellAcItems.length) % shellAcItems.length; shellAcRender(); e.preventDefault(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { if (shellAcIdx >= 0) { shellAcPick(shellAcIdx); e.preventDefault(); return; } }
    if (e.key === 'Escape') { shellAcClose(); return; }
  }
  if (e.key === 'Enter') shellSend();
  else if (e.key === 'ArrowUp') {
    if (shellHistIdx > 0) { shellHistIdx--; $('#shell-input').value = shellHist[shellHistIdx] || ''; }
    e.preventDefault();
  } else if (e.key === 'ArrowDown') {
    if (shellHistIdx < shellHist.length - 1) { shellHistIdx++; $('#shell-input').value = shellHist[shellHistIdx] || ''; }
    else { shellHistIdx = shellHist.length; $('#shell-input').value = ''; }
  }
});
document.addEventListener('click', (e) => { if (!e.target.closest('#shell-ac, #shell-input')) shellAcClose(); });

async function initTerminalLib() {
  try { customCmds = await window.api.cmdsList() || []; } catch (e) { customCmds = []; }
  // одноразовая миграция старых «избранных» (config.favCmds) в «Мои команды» с именем
  const favs = (state && state.config && state.config.favCmds) || [];
  for (const f of favs) {
    if (!customCmds.some(c => c.cmd === f)) {
      try {
        const r = await window.api.cmdsAdd(f.length > 40 ? f.slice(0, 40) + '…' : f, f);
        if (r.ok) customCmds = r.list;
      } catch (e) {}
    }
  }
  if (favs.length) { try { await window.api.setSetting('favCmds', []); } catch (e) {} }
  renderShellSelect();
}
renderShellSelect(); // сразу — библиотека доступна без ожидания конфига

/* ---------- зеркало экрана (R9): h264 + смена SPS + простой режим + FPS ---------- */
let mirrorOn = false, mirrorMode = 'h264', mirrorDec = null, mirrorPts = 0;
let mirrorCarry = new Uint8Array(0);
let mirrorSPS = null, mirrorPPS = null, mirrorDev = null, mirrorWaitingKey = false;
let mirrorFrames = 0, mirrorFpsLast = 0, mirrorFpsTimer = null, mirrorJpegSeq = 0;
let mirrorFpsLastSeen = 0, mirrorFpsSeenAt = 0;   // последний ненулевой FPS
let mirrorStallHandled = false, mirrorBlackRun = 0, mirrorGen = 0;
// лестница декодера — жалоба «данные идут, но ни одного кадра не выдано»: на части
// машин аппаратный декодер WebCodecs молча не выдаёт кадры. Раньше мы сразу уезжали в
// снимки экрана; теперь пробуем ступени: 0 — avcC (как было), 1 — Annex-B без description,
// 2 — Annex-B + ПРОГРАММНОЕ декодирование (работает везде), и лишь потом — простой режим.
let mirrorDecStage = 0, mirrorQueued = 0, mirrorFirstQueueAt = 0;
let mirrorBounced = false;   // однократный перезапуск потока, если заголовок/кадры не приходят
const SC4 = new Uint8Array([0, 0, 0, 1]);
// вотчдог «данные идут, а кадров нет»: реальный кейс владельца — декодер сконфигурирован,
// байты капают, но ни один кадр так и не выдан → вечный чёрный экран (F15)
let mirrorLastChunkAt = 0, mirrorLastFrameAt = 0;
const mcanvas = () => $('#mirror-canvas');

function avccConfig(sps, pps) {
  const d = new Uint8Array(11 + sps.length + pps.length);
  const v = new DataView(d.buffer);
  d.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1], 0);
  v.setUint16(6, sps.length); d.set(sps, 8);
  const pos = 8 + sps.length;
  d[pos] = 1;
  v.setUint16(pos + 1, pps.length); d.set(pps, pos + 3);
  return d;
}
function hex(b) { return b.toString(16).padStart(2, '0'); }
function sameBytes(a, b) { return a && b && a.length === b.length && a.every((x, i) => x === b[i]); }
function mirrorDecClose() { if (mirrorDec) { try { mirrorDec.close(); } catch (e) {} mirrorDec = null; } }

function mirrorFpsLabel(extra) {
  $('#mirror-fps').textContent = extra || '';
}
// любая ошибка трансляции уходит в журнал приложения (app.log),
// чтобы её можно было разобрать постфактум, а не только увидеть в статусе
function mirrorLogErr(text) {
  try { window.api.uiLog('mirror: ' + String(text || '').slice(0, 300)); } catch (e) {}
}
function mirrorFpsTick() {
  if (!mirrorOn) return;
  const now = Date.now();
  const fps = Math.round((mirrorFrames - mirrorFpsLast) * 1000 / Math.max(1, now - (mirrorFpsTick._t || now - 1000)));
  mirrorFpsLast = mirrorFrames;
  mirrorFpsTick._t = now;
  const c = mcanvas();
  const modeTxt = mirrorMode === 'jpeg' ? 'снимки' : 'h264 · 12 Мбит/с';
  const q = (mirrorDec && mirrorDec.decodeQueueSize) || 0;
  // на статичном экране H.264 не шлёт кадры — «0 к/с» пугало.
  // Показываем последний ненулевой FPS, если кадры вообще идут.
  if (fps > 0) { mirrorFpsLastSeen = fps; mirrorFpsSeenAt = now; }
  const shownFps = (fps > 0) ? fps : (now - (mirrorFpsSeenAt || 0) < 8000 ? (mirrorFpsLastSeen || 0) : 0);
  mirrorFpsLabel((shownFps > 0 ? shownFps + ' к/с' : 'ждёт изменения экрана') + ' · ' + c.width + '×' + c.height + ' · ' + modeTxt + (q > 8 ? ' · буфер ' + q : ''));
  // F15/поток живой (байты капают), а кадров нет → сначала пробуем ДРУГИЕ способы
  // декодирования (Annex-B → программный декодер, каждый раз со свежим потоком), и только
  // после них — снимки экрана. В сразу включался простой режим — выглядело как «сломалось».
  // если в потоке ВООБЩЕ не появились SPS/PPS (заголовок кодека) или декодер ни разу
  // не принял кадр — сначала ОДИН раз перезапускаем поток (bounce — свежий SPS/PPS/IDR):
  // частая причина «данные идут, но декодер не принял поток» — пропущенное начало потока.
  if (mirrorMode === 'h264' && mirrorLastChunkAt && now - mirrorLastChunkAt < 3000 && !mirrorFrames) {
    if (!mirrorSPS && now - mirrorLastChunkAt > 3200 && !mirrorBounced) {
      mirrorBounced = true;
      $('#mirror-status').textContent = 'Перезапускаю поток — жду заголовок кодека (SPS/PPS)…';
      window.api.mirrorBounce().catch(() => {});
    } else if (mirrorQueued > 0 && mirrorFirstQueueAt && now - mirrorFirstQueueAt > 2200) mirrorEscalate();
    else if (mirrorLastFrameAt && now - mirrorLastFrameAt > 6000 && !mirrorQueued) {
      if (!mirrorBounced) {
        mirrorBounced = true;
        $('#mirror-status').textContent = 'Перезапускаю поток — декодер не принял ни кадра…';
        window.api.mirrorBounce().catch(() => {});
      } else scheduleFallback('данные идут, но декодер так и не принял поток');
    }
  }
}
function mirrorEscalate() {
  if (!mirrorOn || mirrorMode !== 'h264' || mirrorStallHandled) return;
  if (mirrorDecStage >= 2) { scheduleFallback('декодер так и не выдал кадр (проверены Annex-B и программное декодирование)'); return; }
  mirrorDecStage++;
  mirrorDecClose();
  mirrorSPS = mirrorPPS = null;   // реконфиг из СВЕЖЕГО потока после bounce
  mirrorWaitingKey = true;
  mirrorCarry = new Uint8Array(0);
  mirrorQueued = 0; mirrorFirstQueueAt = 0;
  const how = mirrorDecStage === 1 ? 'Annex-B' : 'программный декодер';
  $('#mirror-status').textContent = 'Кадров нет — переключаю способ декодирования (' + how + ')…';
  snack('Видео не декодируется — пробую другой способ (' + how + ')…');
  window.api.mirrorBounce().catch(() => {}); // свежий SPS/PPS/IDR для нового декодера
}

function mirrorFeed(buf) {
  // ПЕРЕПИСАН разбор потока. Причина «чёрного экрана/низкого FPS»: прежний
  // парсер резал NAL по последнему старт-коду и терял SPS/PPS, из-за чего декодер
  // вообще не создавался. Проверено на живом потоке — этот алгоритм декодирует кадры.
  let data = buf;
  if (mirrorCarry.length > 4 * 1024 * 1024) mirrorCarry = new Uint8Array(0);
  if (mirrorCarry.length) {
    data = new Uint8Array(mirrorCarry.length + buf.length);
    data.set(mirrorCarry, 0); data.set(buf, mirrorCarry.length);
  }
  // все старт-коды
  const starts = [];
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 1) { starts.push({ pos: i, sc: 3 }); i += 2; }
      else if (data[i + 2] === 0 && data[i + 3] === 1) { starts.push({ pos: i, sc: 4 }); i += 3; }
    }
  }
  if (!starts.length) {
    mirrorCarry = data.length > 4 * 1024 * 1024 ? new Uint8Array(0) : data;
    return;
  }
  // последний start-код — начало неполного NAL: оставляем его целиком в carry
  const last = starts[starts.length - 1];
  mirrorCarry = data.slice(last.pos);
  for (let k = 0; k < starts.length - 1; k++) {
    const s = starts[k].pos + starts[k].sc;
    const e = starts[k + 1].pos;
    if (e <= s) continue;
    const nal = data.subarray(s, e);
    const type = nal[0] & 0x1f;
    if (type === 7) {                     // SPS
      if (!sameBytes(nal, mirrorSPS)) { mirrorSPS = nal.slice(); mirrorPPS = null; mirrorDecClose(); mirrorWaitingKey = true; }
      continue;
    }
    if (type === 8) {                     // PPS
      if (!sameBytes(nal, mirrorPPS)) { mirrorPPS = nal.slice(); if (mirrorSPS && !mirrorDec) mirrorInitDecoder(); }
      continue;
    }
    if (type === 6) continue;             // SEI
    if (type !== 1 && type !== 5) continue;
    if (mirrorSPS && mirrorPPS && !mirrorDec) mirrorInitDecoder();
    if (type === 5) mirrorWaitingKey = false;
    if (mirrorWaitingKey) continue;
    if (!mirrorDec || mirrorDec.state !== 'configured') continue;
    if (type === 1) {
      const q = mirrorDec.decodeQueueSize || 0;
      if (q > 24) { mirrorDecClose(); mirrorWaitingKey = true; continue; }
      if (q > 8) { mirrorFrames++; continue; }   // осознанный пропуск — догоняем «сейчас»
    }
    const avcc = new Uint8Array(4 + nal.length);
    new DataView(avcc.buffer).setUint32(0, nal.length);
    avcc.set(nal, 4);
    if (!mirrorFirstQueueAt) mirrorFirstQueueAt = Date.now();
    mirrorQueued++;
    try {
      mirrorDec.decode(new EncodedVideoChunk({ type: type === 5 ? 'key' : 'delta', timestamp: mirrorPts += 33000, data: avcc }));
    } catch (e) { try { window.api.uiLog('mirror decode: ' + e.message); } catch (e2) {} }
  }
}
function mirrorInitDecoder() {
  const sps = mirrorSPS;
  const codec = 'avc1.' + hex(sps[1]) + hex(sps[2]) + hex(sps[3]);
  mirrorDec = new VideoDecoder({
    output: (frame) => {
      const c = mcanvas();
      if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) { c.width = frame.displayWidth; c.height = frame.displayHeight; }
      const ctx = c.getContext('2d');
      ctx.drawImage(frame, 0, 0);
      frame.close();
      mirrorFrames++;
      mirrorLastFrameAt = Date.now();
      mirrorBlackDetect(ctx, c);
    },
    error: (e) => { $('#mirror-status').textContent = 'Ошибка декодера: ' + e.message; scheduleFallback('ошибка декодера'); }
  });
  try {
    // ступени декодера (см. mirrorDecStage): 0 — avcC, 1 — Annex-B, 2 — Annex-B + software
    const cfg = { codec, optimizeForLatency: true };
    if (mirrorDecStage === 0) cfg.description = avccConfig(mirrorSPS, mirrorPPS);
    else cfg.hardwareAcceleration = mirrorDecStage === 2 ? 'prefer-software' : 'no-preference';
    mirrorDec.configure(cfg);
    $('#mirror-status').textContent = 'Трансляция идёт (кодек ' + codec +
      (mirrorDecStage === 1 ? ' · Annex-B' : mirrorDecStage === 2 ? ' · программный декодер' : '') + ')';
  } catch (e) { $('#mirror-status').textContent = 'Не удалось настроить декодер: ' + e.message; scheduleFallback('декодер не настроился'); }
}
// «чёрный экран» детектим сам: 3 кадра подряд почти чёрные → просим простой режим (A3-ревью)
const blackCnv = document.createElement('canvas'); blackCnv.width = 64; blackCnv.height = 64;
const blackCtx = blackCnv.getContext('2d', { willReadFrequently: true });
function mirrorBlackDetect(ctx, c) {
  try {
    blackCtx.drawImage(c, 0, 0, 64, 64);
    const d = blackCtx.getImageData(0, 0, 64, 64).data;
    let sum = 0;
    for (let k = 0; k < d.length; k += 16) sum += (d[k] + d[k + 1] + d[k + 2]) / 3;
    const avg = sum / (d.length / 16);
    if (avg < 10) { if (++mirrorBlackRun >= 3) { mirrorBlackRun = 0; scheduleFallback('чёрный экран'); } }
    else mirrorBlackRun = 0;
  } catch (e) {}
}
function scheduleFallback(reason) {
  if (!mirrorOn || mirrorMode !== 'h264' || mirrorStallHandled) return;
  mirrorStallHandled = true;
  mirrorLogErr('fallback на снимки: ' + reason);
  snack('Видеопоток недоступен (' + reason + ') — включаю простой режим (снимки экрана)');
  switchMirrorMode('jpeg');
}
window.api.onMirrorChunk(buf => { if (mirrorOn && mirrorMode === 'h264') { mirrorLastChunkAt = Date.now(); if (!mirrorLastFrameAt) mirrorLastFrameAt = mirrorLastChunkAt; mirrorFeed(new Uint8Array(buf)); } });
// простой режим: PNG/JPEG-кадры из main (самопланирующийся цикл screencap -j, )
window.api.onMirrorJpeg(frame => {
  if (!mirrorOn || mirrorMode !== 'jpeg') return;
  if (!frame || frame.seq <= mirrorJpegSeq) return; // устаревшие кадры дропаем
  mirrorJpegSeq = frame.seq;
  mirrorLastChunkAt = Date.now();
  // формат определяем по сигнатуре: FF D8 = JPEG, иначе PNG (screencap -j мог не сработать)
  const b = frame.buf;
  const isJpeg = b && b.length > 3 && b[0] === 0xFF && b[1] === 0xD8;
  const blob = new Blob([b], { type: isJpeg ? 'image/jpeg' : 'image/png' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const c = mcanvas();
    if (c.width !== img.naturalWidth || c.height !== img.naturalHeight) { c.width = img.naturalWidth; c.height = img.naturalHeight; }
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    mirrorFrames++;
    mirrorLastFrameAt = Date.now();
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
});

async function startMirror(serial, mode) {
  mirrorMode = mode || 'h264';
  mirrorDev = (infoCache[serial] && infoCache[serial].info) || null;
  if (!mirrorDev) { try { mirrorDev = (await window.api.devInfo(serial)); } catch (e) {} }
  mirrorOn = true; mirrorSPS = mirrorPPS = null; mirrorPts = 0; mirrorCarry = new Uint8Array(0);
  mirrorWaitingKey = false; mirrorStallHandled = false; mirrorBlackRun = 0;
  mirrorFrames = 0; mirrorFpsLast = 0; mirrorJpegSeq = 0;
  mirrorDecStage = 0; mirrorQueued = 0; mirrorFirstQueueAt = 0;
  mirrorBounced = false;
  mirrorLastChunkAt = 0; mirrorLastFrameAt = 0;
  mirrorDecClose();
  // сбрасываем канвас: кадр прошлой сессии/устройства не должен выдаваться за новый
  try { const c0 = mcanvas(); c0.width = 720; c0.height = 1600; c0.getContext('2d').clearRect(0, 0, 720, 1600); } catch (e) {}
  $('#mirror-canvas').classList.remove('hidden');
  $('#mirror-placeholder').classList.add('hidden');
  $('#btn-mirror-start').classList.add('hidden');
  $('#btn-mirror-stop').classList.remove('hidden');
  $('#mirror-status').textContent = mirrorMode === 'jpeg' ? 'Простой режим (снимки экрана)…' : 'Запускаю трансляцию…';
  if (mirrorFpsTimer) clearInterval(mirrorFpsTimer);
  mirrorFpsTick._t = Date.now();
  mirrorFpsTimer = setInterval(mirrorFpsTick, 1000);
  const r = await window.api.mirrorStart(serial, mirrorMode);
  if (!r.ok) { snack(r.error || 'Не удалось начать трансляцию'); mirrorStopUI(); }
  else mirrorGen = (r.gen != null) ? r.gen : mirrorGen + 1;
}
function mirrorStopUI(silent) {
  mirrorOn = false;
  mirrorGen = -1; // маркер «сессии нет»: поздний mirror-stopped от старой сессии не убьёт новую
  mirrorCarry = new Uint8Array(0);
  mirrorDecClose();
  if (mirrorFpsTimer) { clearInterval(mirrorFpsTimer); mirrorFpsTimer = null; }
  mirrorFpsLabel('');
  $('#mirror-canvas').classList.add('hidden');
  $('#mirror-placeholder').classList.remove('hidden');
  $('#btn-mirror-stop').classList.add('hidden');
  $('#btn-mirror-start').classList.remove('hidden');
  if (!silent) $('#mirror-status').textContent = '';
}
async function switchMirrorMode(mode) {
  const s = currentSerial(); if (!s) return;
  await window.api.mirrorStop();
  mirrorStopUI(true);
  startMirror(s, mode);
}
$('#btn-mirror-start').onclick = () => {
  const s = currentSerial(); if (!s) return snack('Нет подключённого устройства');
  // h264 — живое видео (низкая задержка). Декодер починен; при сбое поток
  // сам уйдёт в простой режим, поэтому старт безопасен.
  startMirror(s, 'h264');
};
$('#btn-mirror-stop').onclick = async () => { await window.api.mirrorStop(); mirrorStopUI(); };

$('#btn-mirror-ext').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет подключённого устройства');
  const r = await window.api.toolScrcpy(s);
  if (!r.ok) snack(r.error || 'Не удалось запустить scrcpy');
  else snack('scrcpy запущен во внешнем окне');
};
$('#btn-mirror-back').onclick = () => { const s = currentSerial(); if (s) window.api.inputKey(s, 4); };
$('#btn-mirror-home').onclick = () => { const s = currentSerial(); if (s) window.api.inputKey(s, 3); };

function mirrorCoords(e) {
  const c = mcanvas();
  const r = c.getBoundingClientRect();
  const w = mirrorDev && mirrorDev.screen ? parseInt(mirrorDev.screen.split('x')[0], 10) : c.width;
  const h = mirrorDev && mirrorDev.screen ? parseInt(mirrorDev.screen.split('x')[1], 10) : c.height;
  return { x: Math.round((e.clientX - r.left) / r.width * w), y: Math.round((e.clientY - r.top) / r.height * h) };
}
let mDown = null;
document.addEventListener('mousedown', e => { if (e.target === mcanvas()) mDown = { e, t: Date.now() }; });
document.addEventListener('mouseup', e => {
  if (!mDown || e.target !== mcanvas()) { mDown = null; return; }
  const s = currentSerial();
  const a = mirrorCoords(mDown.e), b = mirrorCoords(e);
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  if (s) {
    if (dist > 30) window.api.inputSwipe(s, a.x, a.y, b.x, b.y, 250);
    else window.api.inputTap(s, a.x, a.y);
  }
  mDown = null;
});

/* ---------- вкладка «Установка APK» — очередь с иконками/именами/версиями ---------- */
const APKQ_EXTS = /\.(apk|aab|apks|xapk|apkm|obb|apk\.1|apk\+|apup|apks\.zip|apk\.zip)$/i;
let apkQueue = [];        // [{path, name, meta:{icon,label,package,versionName,size}, status, msg}]
let apkInstalling = false;
function renderApkTargets() {
  const sel = $('#apk-target');
  const online = onlineDevices();
  sel.innerHTML = online.length
    ? online.map(d => `<option value="${esc(d.serial)}">${esc(d.friendly || d.model || d.serial)}${isUsb(d.serial) ? ' [USB]' : ''}</option>`).join('')
    : '<option value="">Нет подключённых устройств</option>';
  if (activeSerial && online.some(d => d.serial === activeSerial)) sel.value = activeSerial;
  // мини-окно установки — тот же список
  const sel2 = $('#apkmini-target');
  sel2.innerHTML = sel.innerHTML;
  if (activeSerial && online.some(d => d.serial === activeSerial)) sel2.value = activeSerial;
}
function apkQRender() {
  const box = $('#apk2-list');
  // зона перетаскивания СЖИМАЕТСЯ, когда в списке уже есть файлы — раньше она
  // оставалась «в полэкрана» и один файл с большой иконкой выглядел как сломанная вёрстка
  const dz = $('#apk2-drop');
  if (dz) {
    dz.classList.toggle('compact', apkQueue.length > 0);
    dz.innerHTML = apkQueue.length
      ? 'Можно добавить ещё: перетащите файлы сюда или <button class="btn btn-text btn-sm" id="btn-apk2-pick2">выберите…</button>'
      : 'Перетащите APK / XAPK / APKS / APKM / OBB сюда<br><span class="muted small">или</span><br><button class="btn btn-tonal" id="btn-apk2-pick" style="margin-top:8px">Выбрать файлы…</button>';
    const pk2 = document.getElementById('btn-apk2-pick2');
    if (pk2) pk2.onclick = apkPickFiles;
    const pk1 = document.getElementById('btn-apk2-pick');
    if (pk1) pk1.onclick = apkPickFiles;   // кнопка пересоздаётся вместе с dropzone — перепривязываем каждый раз
  }
  box.innerHTML = apkQueue.map((f, i) => {
    const st = f.status === 'ok' ? '<span class="st-chip st-active apkq-status">✓ установлено</span>'
      : f.status === 'fail' ? '<span class="st-chip st-off apkq-status st-fail" data-tip="' + esc(f.msg || '') + '">✗ ошибка</span>'
      : f.status === 'run' ? '<span class="st-chip st-online apkq-status">устанавливаю…</span>'
      : '<span class="st-chip st-off apkq-status">в очереди</span>';
    const m = f.meta || {};
    const sub = [m.versionName ? 'v' + m.versionName : null, m.package, m.size ? fmtBytesLong(m.size) : null].filter(Boolean).join(' · ');
    const shortMsg = f.msg ? String(f.msg).split('\n')[0].slice(0, 180) : '';
    const errBlock = f.status === 'fail'
      ? `<div class="apkq-err">
          <div class="apkq-err-line" data-tip="${esc(f.msg || '')}"><b>Причина:</b> ${esc(shortMsg || 'ошибка установки')}</div>
          <div class="apkq-err-act">
            <button class="btn btn-text btn-xs" data-apkcopy="${i}">Копировать</button>
            ${f.log ? `<button class="btn btn-text btn-xs" data-apklog="${i}">Подробнее</button>` : ''}
          </div>
          ${f.log ? `<pre class="apkq-log hidden">${esc(f.log)}</pre>` : ''}
        </div>`
      : '';
    return `<div class="list-row apkq-row">
      <img class="apkq-ico" src="${m.icon || (window.FSICONS.iconFor(f.name, false).src)}" alt="">
      <span class="apkq-main"><span class="apkq-name">${esc(m.label || f.name)}</span><span class="apkq-sub">${esc(sub || f.name)}</span></span>
      ${st}
      ${apkInstalling ? '' : '<button class="btn btn-text btn-sm" data-apkshort="' + i + '" data-tip="Создать на рабочем столе ярлык с РОДНОЙ иконкой этого APK (в Проводнике все .apk выглядят одинаково — так Windows показывает файлы одного типа)">Файл-ярлык</button>'}
      ${apkInstalling ? '' : '<button class="btn btn-text btn-sm" data-apkqdel="' + i + '" data-tip="Убрать из списка">✕</button>'}
      ${errBlock}
    </div>`;
  }).join('');
  box.querySelectorAll('[data-apkqdel]').forEach(b => b.onclick = () => { apkQueue.splice(+b.dataset.apkqdel, 1); apkQRender(); });
  // ярлык на рабочем столе с РОДНОЙ иконкой APK — Проводник рисует для всех .apk
  // иконку ассоциации, поэтому у файлов одного типа она одинаковая
  box.querySelectorAll('[data-apkshort]').forEach(b => b.onclick = async () => {
    const f = apkQueue[+b.dataset.apkshort]; if (!f) return;
    const r = await window.api.apkMakeShortcut(f.path);
    snack(r.ok ? r.message : ('Не удалось: ' + (r.error || '')));
  });
  box.querySelectorAll('[data-apkcopy]').forEach(b => b.onclick = () => {
    const f = apkQueue[+b.dataset.apkcopy]; if (!f) return;
    copyText((f.msg ? f.msg + '\n\n' : '') + (f.log || ''));
  });
box.querySelectorAll('[data-apklog]').forEach(b => b.onclick = () => {
    const row = b.closest('.apkq-row');
    const pre = row && row.querySelector('.apkq-log');
    if (!pre) return;
    const hid = pre.classList.toggle('hidden');
    b.textContent = hid ? 'Подробнее' : 'Свернуть';
  });
  $('#btn-apk2-installall').disabled = !apkQueue.length || !$('#apk-target').value || apkInstalling;
  $('#apk2-summary').textContent = apkQueue.length
    ? 'В очереди: ' + apkQueue.length + ' · ' + fmtBytesLong(apkQueue.reduce((a, f) => a + ((f.meta && f.meta.size) || 0), 0))
    : 'Список пуст — добавьте файлы, и я покажу имена, иконки, версии и пакеты.';
}
async function apkAddFiles(paths) {
  let added = 0;
  for (const p of paths) {
    if (!APKQ_EXTS.test(p)) continue;
    if (apkQueue.some(f => f.path === p)) continue;
    const item = { path: p, name: p.split(/[\\/]/).pop(), meta: null, status: 'wait', msg: '' };
    apkQueue.push(item); added++;
    apkQRender();
    const m = await window.api.apkLocalMeta(p);
    if (m && m.ok) {
      item.meta = { icon: m.icon, label: m.label, package: m.package, versionName: m.versionName, size: m.size };
      item.msg = (!m.icon && !m.label) ? 'иконку/имя извлечь не удалось — установится как есть' : '';
    } else {
      item.msg = (m && m.error) || 'не удалось разобрать APK';
      if (m && m.size) item.meta = { size: m.size };
    }
    apkQRender();
  }
  if (added) {
    snd.play('drop'); snack('Добавлено файлов: ' + added);
    if (apkAutoInstallOn()) setTimeout(() => apkStartInstall(true), 350);
  } else snack('Подходящих файлов нет (нужны .apk/.apks/.xapk/.apkm/.obb/.aab)');
}
async function apkPickFiles() {
  const files = await window.api.pickFile({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Android пакеты', extensions: ['apk', 'aab', 'apks', 'xapk', 'apkm', 'obb', 'apup'] }] });
  if (files && files.length) apkAddFiles(files);
}
// стартовая привязка для СТАТИЧЕСКОЙ кнопки из разметки (apkQRender перепривяжет
// её при каждой перерисовке dropzone — кнопка пересоздаётся вместе с ней)
$('#btn-apk2-pick').onclick = apkPickFiles;
const apk2Drop = $('#apk2-drop');
apk2Drop.ondragover = e => { e.preventDefault(); apk2Drop.classList.add('over'); };
apk2Drop.ondragleave = () => apk2Drop.classList.remove('over');
apk2Drop.ondrop = async e => {
  e.preventDefault();
  e.stopPropagation();
  apk2Drop.classList.remove('over');
  const paths = [];
  for (const f of Array.from(e.dataTransfer.files || [])) {
    const p = await window.api.pathForFile(f);
    if (p) paths.push(p);
  }
  if (paths.length) apkAddFiles(paths);
};
/* перетаскивание APK в ЛЮБОЕ место окна — файл сразу попадает в очередь установки.
   перехватываем dragover глобально — иначе Windows/Chromium рисует «запрещённый знак» */
document.addEventListener('dragover', e => {
  if (!e.dataTransfer) return;
  const hasFiles = Array.from(e.dataTransfer.types || []).includes('Files') || (e.dataTransfer.items && e.dataTransfer.items.length > 0);
  if (!hasFiles) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
}, true);
document.addEventListener('dragenter', e => {
  if (!e.dataTransfer) return;
  if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
  e.preventDefault();
}, true);
document.addEventListener('drop', async e => {
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  if (!files.length) return;
  // на странице «Файлы» APK — обычный файл. Пользователь хочет его
  // СКОПИРОВАТЬ на телефон, а не установить, поэтому установщик не открываем.
  if (document.querySelector('#page-files.active')) return;
  if (!files.some(f => APKQ_EXTS.test(f.name))) return;
  e.preventDefault();
  goPage('apk');
  const paths = [];
  for (const f of files) {
    if (!APKQ_EXTS.test(f.name)) continue;
    const p = await window.api.pathForFile(f);
    if (p) paths.push(p);
  }
  if (paths.length) apkAddFiles(paths);
}, true);
$('#btn-apk2-clear').onclick = () => { if (apkInstalling) return snack('Идёт установка — сначала прервите'); apkQueue = []; apkQRender(); };
$('#btn-apk-target-refresh').onclick = () => { refreshDevices().then(renderApkTargets); };
$('#btn-apk2-installall').onclick = () => apkStartInstall(false);
async function apkStartInstall(silent) {
  const serial = $('#apk-target').value;
  if (!serial) { if (!silent) snack('Сначала подключите устройство и выберите его в списке'); return; }
  if (!apkQueue.length || apkInstalling) return;
  if (!silent) {
    const yes = await uiConfirm('Установка ' + apkQueue.length + ' файл(ов)', 'Установить на «' + nameOf(serial) + '»? Очередь пойдёт по порядку, по каждому файлу будет видно статус.');
    if (!yes || !yes.ok) return;
  }
  apkInstalling = true;
  apkQueue.forEach(f => { f.status = 'wait'; f.msg = ''; f.log = ''; });
  $('#btn-apk2-cancel').classList.remove('hidden');
  apkQRender();
  window.api.apkInstallBatch(serial, apkQueue.map(f => ({ path: f.path, meta: f.meta }))).then(r => {
    apkInstalling = false;
    $('#btn-apk2-cancel').classList.add('hidden');
    if (r && Array.isArray(r.results)) r.results.forEach((res, idx) => {
      if (!res || !apkQueue[idx]) return;
      if (res.message) apkQueue[idx].msg = res.message;
      if (res.raw) apkQueue[idx].log = res.raw;
    });
    if (r && r.canceled) snack('Установка прервана');
    else if (r && r.ok) snack('Установлено: ' + r.installed + (r.failed ? ', ошибок: ' + r.failed : ''));
    else snack('Установка не удалась' + (r && r.error ? ': ' + r.error : ''));
    apkQRender();
  });
}
/* автоустановка после добавления файлов (запоминается между запусками) */
const APK_AUTO_KEY = 'apk-auto-install';
const apkAutoBox = $('#set-apk-autoinstall');
try { if (apkAutoBox) apkAutoBox.checked = localStorage.getItem(APK_AUTO_KEY) === '1'; } catch (e) {}
if (apkAutoBox) apkAutoBox.onchange = () => {
  try { localStorage.setItem(APK_AUTO_KEY, apkAutoBox.checked ? '1' : '0'); } catch (e) {}
  if (apkAutoBox.checked) snack('Автоустановка включена: файлы ставятся сразу после добавления');
};
function apkAutoInstallOn() { return !!(apkAutoBox && apkAutoBox.checked); }
$('#btn-apk2-cancel').onclick = () => window.api.apkInstallCancel();

/* ---------- мини-окно установки (двойной клик по файлу при ассоциации) ---------- */
let apkMiniBusy = false;
async function openApkMini(filePath) {
  goPage('apk');
  openDlg('dlg-apkmini');
  renderApkTargets();
  $('#apkmini-file').textContent = filePath;
  $('#apkmini-body').innerHTML = '<div>Читаю файл…</div>';
  $('#apkmini-icon').src = '';
  $('#apkmini-install').disabled = true;
  const m = await window.api.apkLocalMeta(filePath);
  if (!m || !m.ok) {
    $('#apkmini-body').innerHTML = '<div>Не удалось прочитать файл: ' + esc((m && m.error) || 'ошибка') + '</div>';
    return;
  }
  $('#apkmini-title').textContent = m.label || filePath.split(/[\\/]/).pop();
  if (m.icon) $('#apkmini-icon').src = m.icon;
  $('#apkmini-body').innerHTML = [
    ['Версия', m.versionName || '—'],
    ['Пакет', m.package || '—'],
    ['Размер', m.size ? fmtBytesLong(m.size) : '—']
  ].map(r2 => '<div><b>' + esc(r2[0]) + ':</b> ' + esc(r2[1]) + '</div>').join('') +
    '<div class="muted" style="margin-top:6px">Выберите устройство и нажмите «Установить».</div>';
  $('#apkmini-install').disabled = !$('#apkmini-target').value;
  $('#apkmini-install').onclick = async () => {
    if (apkMiniBusy) return;
    const serial = $('#apkmini-target').value;
    if (!serial) return snack('Нет подключённых устройств — сначала подключите телефон');
    apkMiniBusy = true;
    $('#apkmini-install').disabled = true;
    $('#apkmini-install').textContent = 'Устанавливаю…';
    const r = await window.api.apkInstallBatch(serial, [{ path: filePath, meta: { package: m.package } }]);
    apkMiniBusy = false;
    $('#apkmini-install').disabled = false;
    $('#apkmini-install').textContent = 'Установить';
    if (r && r.ok && r.installed) { snack('Установлено: ' + (m.label || filePath)); closeDlg('dlg-apkmini'); }
    else snack('Не удалось установить: ' + ((r && r.error) || 'ошибка'));
  };
}

/* ---------- быстрые команды + опасные ---------- */
const DANGER = { reboot: 'Перезагрузка устройства', bootloader: 'Перезагрузка в bootloader', recovery: 'Перезагрузка в recovery' };
$$('.chip[data-cmd]').forEach(c => c.onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет подключённого устройства');
  const cmd = c.dataset.cmd;
  const run = async () => {
    const r = await window.api.toolQuick(s, cmd);
    snack(r.ok ? 'Команда выполнена' : 'Ошибка: ' + (r.message || r.error || ''));
  };
  if (DANGER[cmd]) {
    const yes = await uiConfirm(DANGER[cmd], 'Выполнить «' + DANGER[cmd] + '» для ' + s + '?');
    if (yes) run();
  } else run();
});

$('#btn-diag').onclick = async () => {
  const s = currentSerial();
  $('#diag-report').innerHTML = '<div class="muted">Выполняется…</div>';
  const rep = await window.api.toolDiagnostics(s);
  // КОМПАКТНО и без вылезания за экран: сетка в 2 колонки, каждая строка — отдельный
  // div с переносом длинных слов (в <pre> не переносил длинные mDNS-имена — строка
  // уезжала за границу окна); рекомендации — обычным списком, тоже с переносом.
  // три состояния — ок (зелёный), предупреждение (жёлтый), ошибка (красный)
  const ico = sec => sec.ok
    ? (sec.warn ? '<span class="d-warn">&#9888;</span>' : '<span class="d-ok">&#10004;</span>')
    : '<span class="d-err">&#10008;</span>';
  $('#diag-report').innerHTML =
    '<div class="diag-grid">' +
    rep.sections.map(sec => `<div class="diag-sec ${sec.ok ? (sec.warn ? 'is-warn' : 'is-ok') : 'is-err'}">` +
      `<b>${ico(sec)} ${esc(sec.title)}</b>` +
      `<div class="diag-lines">${sec.lines.map(l => '<div class="diag-line">' + esc(l) + '</div>').join('')}</div></div>`).join('') +
    '</div>' +
    (rep.suggestions.length ? `<div class="diag-sugg"><b>Рекомендации</b><ul class="diag-sugg-list">${rep.suggestions.map(x => '<li>' + esc(x) + '</li>').join('')}</ul></div>` : '');
};

/* ---------- файловый менеджер: файлы видны СРАЗУ (R11); F4–F8 ---------- */
let fsDir = '/sdcard';
let fsHist = [];            // история переходов для кнопки «Назад» (F5)
let fsItems = [];           // кэш последнего списка — для просмотрщика/плеера/флешки
let fsFlash = null;         // путь смонтированной OTG-флешки (/storage/XXXX-XXXX) или null
let fsCatKind = null;       // категория «со всех папок» (photo/music/video/docs) или null
let fsCatItems = [];        // результаты категории (полные пути)
// буфер обмена проводника — Копировать/Вырезать → Вставить в любую папку
// (в т.ч. с памяти телефона на флешку и обратно)
let fsClip = { paths: [], cut: false };
const FS_QUICK = [
  { label: 'Внутренняя память', dir: '/sdcard' },
  { label: 'Download', dir: '/sdcard/Download' },
  { label: 'DCIM', dir: '/sdcard/DCIM' },
  { label: 'Documents', dir: '/sdcard/Documents' },
  { label: 'Music', dir: '/sdcard/Music' },
  { label: 'Pictures', dir: '/sdcard/Pictures' },
  { label: 'Movies', dir: '/sdcard/Movies' }
];
// (L2): та же нормализация, что в main.js — чтобы крошки/операции совпадали с реальностью
function fsNormalize(p) {
  let d = String(p == null ? '/' : p).trim();
  if (!d) d = '/';
  if (!d.startsWith('/')) d = '/' + d;
  d = d.replace(/\/{2,}/g, '/');
  d = d.replace(/\/+$/, '') || '/';
  d = d.replace(/^\/sdcard\/emulated\/0(?=\/|$)/, '/storage/emulated/0');
  d = d.replace(/^\/sdcard\/emulated(?=\/|$)/, '/storage/emulated');
  d = d.replace(/^\/storage\/emulated\/0\/0(?=\/|$)/, '/storage/emulated/0');
  d = d.replace(/^\/storage\/emulated\/emulated\/0(?=\/|$)/, '/storage/emulated/0');
  d = d.replace(/^\/sdcard\/0(?=\/|$)/, '/storage/emulated/0');
  return d || '/';
}
function renderFsQuick() {
  const box = $('#fs-quick');
  const catChips = [
    { kind: 'photo', label: 'Все фото', ico: '&#128444;' },
    { kind: 'music', label: 'Вся музыка', ico: '&#9835;' },
    { kind: 'video', label: 'Всё видео', ico: '&#127909;' },
    { kind: 'docs', label: 'Документы', ico: '&#128196;' }
  ];
  box.innerHTML = FS_QUICK.map(q => `<button class="chip${fsCatKind ? '' : (fsDir === q.dir ? ' view-chip active' : '')}" data-qdir="${esc(q.dir)}">${esc(q.label)}</button>`).join('') +
    catChips.map(c => `<button class="chip${fsCatKind === c.kind ? ' view-chip active' : ''}" data-qcat="${c.kind}" data-tip="Показать ${esc(c.label.toLowerCase())} СО ВСЕХ папок телефона">${c.ico} ${esc(c.label)}</button>`).join('');
  box.querySelectorAll('[data-qdir]').forEach(b => b.onclick = () => fsNavigate(b.dataset.qdir));
  box.querySelectorAll('[data-qcat]').forEach(b => b.onclick = () => fsNavigate('cat:' + b.dataset.qcat));
}
// ОДНА кнопка «Вид» с выпадающим меню как в Проводнике Windows 11 — пункты + ползунок
// размера значков. ВАЖНО: в здесь был crash-баг всего приложения: IIFE syncFsViewChips
// читала let fsView ДО его объявления (TDZ ReferenceError) — app.js умирал на этой строке,
// и ВСЁ, что объявлено ниже, оставалось неинициализированным: не работали файлы, приложения,
// ассоциации, плеер, половина кнопок. Теперь fsView объявлен ЗДЕСЬ, выше использования.
// ползунок ПЛАВНЫЙ, как в Проводнике Windows: 0–34 — список, 35–67 — значки
// (ячейка растёт 76→130 px), 68–100 — огромные (130→250 px). Останавливаться можно на ЛЮБОЙ
// позиции — размер ячейки меняется непрерывно, а не тремя ступенями.
let fsView = 'list';
let fsSlider = 0;             // 0..100 — позиция ползунка
try { fsSlider = Math.max(0, Math.min(100, parseInt(localStorage.getItem('fs.slider') || '0', 10) || 0)); } catch (e) {}
fsView = fsSliderViewOf(fsSlider);
function fsSliderViewOf(v) { return v <= 34 ? 'list' : (v <= 67 ? 'icons' : 'xl'); }
function fsCellPxOf(v) {
  if (v <= 34) return 0;
  if (v <= 67) return Math.round(76 + (v - 35) / 32 * 54);   // 76..130
  return Math.round(130 + (v - 67) / 33 * 120);              // 130..250
}
const VIEW_NAMES = { list: 'Список', icons: 'Значки', xl: 'Огромные' };
function syncFsViewUI() {
  fsView = fsSliderViewOf(fsSlider);
  const name = $('#fs-view-name'); if (name) name.textContent = VIEW_NAMES[fsView];
  $$('#fs-view-menu .view-item').forEach(x => x.classList.toggle('active', x.dataset.view === fsView));
  const r = $('#fs-view-range'); if (r) r.value = String(fsSlider);
}
function setFsSlider(v) {
  fsSlider = Math.max(0, Math.min(100, v | 0));
  try { localStorage.setItem('fs.slider', String(fsSlider)); } catch (e) {}
  syncFsViewUI();
  fsRender();
}
setFsViewAnchors();
function setFsViewAnchors() {
  // пункты меню = якоря ползунка: Список=0, Значки=50, Огромные=100
  $$('#fs-view-menu .view-item').forEach(c => {
    c.onclick = () => { setFsSlider(c.dataset.view === 'list' ? 0 : c.dataset.view === 'icons' ? 50 : 100); $('#fs-view-menu').classList.add('hidden'); };
  });
}
syncFsViewUI();
$('#btn-fs-view').onclick = (e) => { e.stopPropagation(); $('#fs-view-menu').classList.toggle('hidden'); };
(function viewSlider() {
  const r = $('#fs-view-range');
  let deb = null;
  r.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => setFsSlider(+r.value), 60); });
})();
document.addEventListener('click', (e) => { const m = $('#fs-view-menu'); if (m && !e.target.closest('#fs-views')) m.classList.add('hidden'); });

// навигация С историей: кнопка «Назад» возвращает на предыдущую папку (F5)
// 'cat:photo|music|video|docs' — виртуальная категория со ВСЕХ папок телефона
const CAT_TITLES = { photo: 'Все фото устройства', music: 'Вся музыка устройства', video: 'Всё видео устройства', docs: 'Все документы устройства' };
let fsFwd = [];   // история «Вперёд» (боковые кнопки мыши, как в Проводнике)
function fsCurToken() { return fsCatKind ? 'cat:' + fsCatKind : fsDir; }
function fsNavigate(newDir, { back, fwd } = {}) {
  if (newDir && String(newDir).startsWith('cat:')) {
    const kind = String(newDir).slice(4);
    if (!CAT_TITLES[kind]) return;
    if (fsCatKind !== kind || fsDir) { if (fsDir || fsCatKind) { fsHist.push(fsCurToken()); fsFwd = []; } }
    fsCatKind = kind;
    $('#btn-fs-back').disabled = !fsHist.length;
    const fbtn = $('#btn-fs-fwd'); if (fbtn) fbtn.disabled = !fsFwd.length;
    renderFsQuick();
    fsRender();
    return;
  }
  if (back || fwd) {
    const stack = back ? fsHist : fsFwd;
    const other = back ? fsFwd : fsHist;
    const prev = stack.pop();
    if (prev == null) { return; }
    other.push(fsCurToken());
    if (other.length > 60) other.shift();
    if (String(prev).startsWith('cat:')) {
      fsCatKind = prev.slice(4); fsDir = '/sdcard';
    } else {
      fsCatKind = null;
      fsDir = fsNormalize(prev || '/sdcard');
    }
  } else {
    const target = fsNormalize(newDir || '/sdcard');
    if (target !== fsDir || fsCatKind) {
      fsHist.push(fsCurToken());
      fsFwd = [];
    }
    if (fsHist.length > 60) fsHist.shift();
    fsCatKind = null;
    fsDir = target;
  }
  $('#btn-fs-back').disabled = !fsHist.length;
  const fbtn = $('#btn-fs-fwd'); if (fbtn) fbtn.disabled = !fsFwd.length;
  renderFsQuick();
  fsRender();
}

function fmtBytesLong(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' ГБ';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' МБ';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' КБ';
  return n + ' Б';
}

let fsSeq = 0; // защита от гонок: ответ устаревшего ls не должен перезаписать свежую папку
const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|heic|avif)$/i;
const VID_RE = /\.(mp4|mkv|webm|avi|mov|3gp|m4v|ts)$/i;
const AUD_RE = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|wma)$/i;
// категории для новых просмотрщиков/действий
const TXT_RE = /\.(txt|log|md|xml|json|js|css|htm|html|ini|conf|cfg|csv|nfo|srt|ass|ssa|lua|py|sh|bat|java|c|cpp|h|hpp|cs|yml|yaml|toml|properties|prop|rc|gitignore|sql|reg|vtt)$/i;
const PDF_RE = /\.pdf$/i;
const HTML_RE = /\.(html?|xhtml)$/i;
const ARC_RE = /\.(zip|jar|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|rar|7z)$/i;
const APK_RE = /\.(apk|apks|xapk|apkm)$/i;
const DOCX_RE = /\.docx$/i;   // просмотр DOCX внутри программы
const VCF_RE = /\.vcf$/i;     // просмотр контактов vCard
// fsView объявлен и инициализирован ВЫШЕ (блок кнопки «Вид») — здесь больше не дублируется
const thumbCache = new Map();     // путь → dataURL (миниатюры фото в режиме значков)
const thumbFail = new Set();
let thumbQueue = [], thumbRun = 0;
const THUMB_CONC = 2;
function queueThumbs(cells) { thumbQueue.push(...cells); pumpThumbs(); }
// Превью грузим лениво: только для ячеек, которые реально видны (плюс запас
// 300 px). Иначе «Все фото» с тысячами файлов ставит в очередь тысячи чтений.
let thumbObs = null;
let thumbElJobs = new WeakMap();
function lazyThumbs(jobs) {
  if (!('IntersectionObserver' in window)) { queueThumbs(jobs); return; }
  if (!thumbObs) {
    const root = document.getElementById('content');
    thumbObs = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const job = thumbElJobs.get(en.target);
        if (!job) continue;
        thumbElJobs.delete(en.target);
        thumbObs.unobserve(en.target);
        queueThumbs([job]);
      }
    }, { root: root || null, rootMargin: '300px' });
  }
  for (const job of jobs) {
    if (!job.el) continue;
    thumbElJobs.set(job.el, job);
    thumbObs.observe(job.el);
  }
}
function pumpThumbs() {
  while (thumbRun < THUMB_CONC) {
    const job = thumbQueue.shift();
    if (!job) return;
    thumbRun++;
    loadThumb(job).finally(() => { thumbRun--; pumpThumbs(); });
  }
}
async function loadThumb(job) {
  const { path: p, el } = job;
  // Видео читаем не целиком (fsCat), а кадром из потока media-сервера:
  // файл на компьютер не скачивается, в память попадает только JPEG-кадр.
  if (VID_RE.test(p)) { queueVidThumb(job); return; }
  if (thumbCache.has(p)) { if (el && el.isConnected) { el.src = thumbCache.get(p); el.classList.add('is-loaded'); } return; }
  if (thumbFail.has(p)) return;
  const s = currentSerial(); if (!s) return;
  try {
    const r = await window.api.fsCat(s, p, 12);
    // элемент мог уйти (переход в другую папку) — чужой src не трогаем
    if (!el || !el.isConnected || el.dataset.path !== p) return;
    if (!r.ok || !r.buf || !r.buf.length) { thumbFail.add(p); return; }
    const blob = new Blob([r.buf], { type: /jpe?g$/i.test(p) ? 'image/jpeg' : /png$/i.test(p) ? 'image/png' : /gif$/i.test(p) ? 'image/gif' : /webp$/i.test(p) ? 'image/webp' : /bmp$/i.test(p) ? 'image/bmp' : 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    await new Promise((res, rej) => { el.onload = res; el.onerror = rej; el.src = url; });
    thumbCache.set(p, el.src);
  } catch (e) { thumbFail.add(p); }
}
/* Видео-превью: берём один кадр из потока media-сервера (тот же, что играет плеер)
   и рисуем его в canvas → JPEG dataURL. Файл на ПК не сохраняется: ADB отдаёт
   только запрошенные байты по Range. Поток один за раз — не забиваем канал ADB. */
const vidThumbQueue = [];
let vidThumbRun = 0;
function queueVidThumb(job) { vidThumbQueue.push(job); pumpVidThumbs(); }
function pumpVidThumbs() {
  while (vidThumbRun < 1) {
    const job = vidThumbQueue.shift();
    if (!job) return;
    vidThumbRun++;
    loadVideoThumb(job).finally(() => { vidThumbRun--; pumpVidThumbs(); });
  }
}
function vidGrabFrame(url) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    let done = false;
    const finish = val => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { v.pause(); } catch (e) {}
      try { v.removeAttribute('src'); v.load(); } catch (e) {}
      try { v.remove(); } catch (e) {}
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), 20000);
    v.preload = 'metadata'; v.muted = true; v.playsInline = true;
    v.crossOrigin = 'anonymous';   // media-сервер отдаёт Access-Control-Allow-Origin: *
    v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    v.addEventListener('loadedmetadata', () => {
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      try { v.currentTime = dur > 3 ? Math.min(2, dur * 0.1) : 0.1; } catch (e) { finish(null); }
    });
    v.addEventListener('seeked', () => {
      try {
        const w = 320, h = 180;
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        const vw = v.videoWidth || w, vh = v.videoHeight || h;
        const sc = Math.min(w / vw, h / vh);
        const dw = vw * sc, dh = vh * sc;
        ctx.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh);
        finish(cv.toDataURL('image/jpeg', 0.72));
      } catch (e) { finish(null); }
    });
    v.addEventListener('error', () => finish(null));
    v.src = url;
    document.body.appendChild(v);
    try { v.load(); } catch (e) {}
  });
}
async function loadVideoThumb(job) {
  const { path: p, el } = job;
  if (thumbCache.has(p)) { if (el && el.isConnected) { el.src = thumbCache.get(p); el.classList.add('is-loaded'); } return; }
  if (thumbFail.has(p)) return;
  const s = currentSerial(); if (!s) return;
  try {
    const r = await window.api.mediaUrl(s, p);
    if (!r || !r.ok || !r.url) { thumbFail.add(p); return; }
    const frame = await vidGrabFrame(r.url);
    if (!frame) { thumbFail.add(p); return; }
    if (!el || !el.isConnected || el.dataset.path !== p) return;
    el.src = frame;
    el.classList.add('is-loaded');
    if (thumbCache.size < 800) thumbCache.set(p, frame);
  } catch (e) { thumbFail.add(p); }
}
// отложенные иконки APK-файлов с телефона (родная иконка приложения) — очередь на 1 поток
const fsApkIconDone = new Set();
let fsApkQueue = [], fsApkRun = 0;
function queueFsApkIcons(jobs) { fsApkQueue.push(...jobs); pumpFsApkIcons(); }
function pumpFsApkIcons() {
  while (fsApkRun < 1) {
    const job = fsApkQueue.shift();
    if (!job) return;
    if (fsApkIconDone.has(job.path)) continue;
    fsApkRun++;
    (async () => {
      const s = currentSerial(); if (!s) return;
      const r = await window.api.apkRemoteMeta(s, job.path).catch(() => null);
      fsApkIconDone.add(job.path);
      // защита от «переехавшей» папки: обновляем элемент ТОЛЬКО если это тот же файл
      const img = document.getElementById(job.id);
      if (r && r.ok && r.dataUrl && img && img.dataset.path === job.path && img.isConnected) {
        img.src = r.dataUrl; const b = document.getElementById(job.id + '-badge'); if (b) b.style.display = 'block';
        if (r.label) { const t = document.getElementById(job.id + '-name'); if (t && t.dataset.path === job.path) t.textContent = r.label + ' (' + job.name + ')'; }
      }
    })().finally(() => { fsApkRun--; pumpFsApkIcons(); });
  }
}
function fsBadgeHtml(isApk) {
  return isApk ? '<img class="android-badge" src="' + window.FSICONS.ANDROID_BADGE + '" data-tip="Приложение Android — иконка подгружается из APK" alt="">'
    : '';
}
// удаление не должно возвращать список в начало. Прокручивается #content,
// а не #fs-list (сам список растянут по высоте и своего скролла не имеет).
async function fsKeepScroll(fn) {
  const content = $('#content');
  const list = $('#fs-list');
  const prevScroll = content ? content.scrollTop : 0;
  const prevMin = list ? list.style.minHeight : '';
  // Пока список перерисовывается, не даём ему схлопнуться: иначе #content
  // мгновенно уезжает в 0, и восстановление позиции выглядит как прыжок.
  if (list) list.style.minHeight = Math.max(list.offsetHeight, 0) + 'px';
  try { return await fn(); }
  finally {
    if (list) list.style.minHeight = prevMin;
    if (content) {
      // theme-v3 задаёт #content scroll-behavior: smooth; для восстановления
      // позиции нужен мгновенный переход, а не анимация сверху вниз.
      const prevBehavior = content.style.scrollBehavior;
      content.style.scrollBehavior = 'auto';
      content.scrollTop = prevScroll;
      content.style.scrollBehavior = prevBehavior;
    }
  }
}
/* Удаление без перерисовки списка: убираем строку/ячейку из DOM и из fsItems.
   Никакого «Загружаю список файлов…» и скачка прокрутки — остальные элементы
   остаются теми же DOM-узлами, экран не мыркает. */
function fsRemovePathsFromList(paths) {
  const box = $('#fs-list');
  if (!box || !paths || !paths.length) return;
  const content = $('#content');
  const prevScroll = content ? content.scrollTop : null;
  const dir = fsDir.replace(/\/+$/, '');
  const pathOf = it => (it && it.path) ? it.path : (dir + '/' + (it ? it.name : ''));
  const set = new Set(paths.map(String));
  for (let i = fsItems.length - 1; i >= 0; i--) {
    if (set.has(pathOf(fsItems[i]))) fsItems.splice(i, 1);
  }
  for (const p of set) { thumbCache.delete(p); thumbFail.delete(p); }
  box.querySelectorAll('.fs-row, .fs-cell').forEach(el => {
    const p = el.dataset.fsfull || el.dataset.fspath;
    if (p && set.has(p)) el.remove();
  });
  // элементы хранят индекс в fsItems — после удаления индексы сдвинулись
  box.querySelectorAll('.fs-row[data-fs-i], .fs-cell[data-fs-i]').forEach(el => {
    const p = el.dataset.fsfull || el.dataset.fspath;
    const idx = fsItems.findIndex(it => pathOf(it) === p);
    if (idx >= 0) el.dataset.fsI = idx;
  });
  if (!box.querySelector('.fs-row, .fs-cell')) {
    box.innerHTML = fsItems.length
      ? '<div class="empty">Нет файлов по фильтру</div>'
      : (fsCatKind
        ? '<div class="empty">Файлов этой категории не найдено на внутренней памяти</div>'
        : '<div class="empty">Папка пуста</div>');
  }
  fsBatchUpdate();
  if (content && prevScroll != null) {
    const pb = content.style.scrollBehavior;
    content.style.scrollBehavior = 'auto';
    content.scrollTop = prevScroll;
    content.style.scrollBehavior = pb;
  }
}
async function fsDeletePath(name, path) {
  const s = currentSerial();
  if (!s) return snack('Нет устройства');
  let r;
  try { r = await window.api.fsCmd(s, ['rm', '-rf', path]); }
  catch (e) { r = { ok: false, error: (e && e.message) || 'ошибка' }; }
  if (r && r.ok) {
    // файл просто исчезает из списка, без полной перерисовки
    fsRemovePathsFromList([path]);
    snack('Удалено: ' + name);
    return true;
  }
  snack('Не удалось удалить: ' + ((r && (r.stderr || r.error)) || 'ошибка'), 7000);
  return false;
}
/* загрузка файлов/папок, перетащенных из Проводника, в папку телефона. */
async function fsUploadLocalPaths(paths, dir) {
  const s = currentSerial();
  if (!s) { snack('Сначала подключите телефон'); return 0; }
  let ok = 0;
  for (let i = 0; i < paths.length; i++) {
    snack('Загружаю ' + (i + 1) + ' из ' + paths.length + '…', 120000);
    const r = await window.api.fsPush(s, paths[i], dir).catch(() => null);
    if (r && r.ok) ok++;
  }
  snack('Загружено: ' + ok + ' из ' + paths.length, 6000);
  const same = !fsCatKind && dir.replace(/\/+$/, '') === fsDir.replace(/\/+$/, '');
  if (ok && same) await fsKeepScroll(() => fsRender({ silent: true }));
  return ok;
}
async function fsRender(opts) {
  opts = opts || {};
  const seq = ++fsSeq;
  // сбрасываем очереди миниатюр/иконок ПРОШЛОЙ папки — иначе догоняющие задачи
  // занимали канал и (для APK-иконок, поиск по индексному id) рисовали иконки/имена
  // из ПРЕДЫДУЩЕЙ папки в текущей («перешёл в другую папку — а там как было»)
  thumbQueue.length = 0;
  fsApkQueue.length = 0;
  if (thumbObs) thumbObs.disconnect();
  thumbElJobs = new WeakMap();
  const s = currentSerial();
  const box = $('#fs-list');
  const empty = $('#fs-empty');
  // РЕЖИМ КАТЕГОРИИ — «Все фото / Вся музыка / Всё видео / Документы» со ВСЕХ папок
  if (fsCatKind) {
    $('#fs-path').value = CAT_TITLES[fsCatKind] || fsCatKind;
    $('#fs-crumb').textContent = CAT_TITLES[fsCatKind] + ' (виртуальная папка — файлы лежат по своим местам)';
    if (!s) { box.innerHTML = ''; box.classList.add('hidden'); empty.classList.remove('hidden'); return; }
    if (seq !== fsSeq) return;
    empty.classList.add('hidden');
    box.classList.remove('hidden');
box.classList.remove('fs-grid', 'fs-xl');
    // Radar-загрузка по центру (стилизованная анимация-спиннер, как радиолокатор)
    box.innerHTML = `<div class="fs-radar-wrap"><div class="fs-radar"></div><div class="fs-radar-txt">Ищу файлы по всему телефону…</div></div>`;
    // roots не задаём — main сам берёт РЕАЛЬНЫЕ хранилища (/storage/emulated/0, SD)
    // и ищет с find -H, иначе симлинк /sdcard не обходится и список пустой
    const r = await window.api.fsSearch(s, fsCatKind, null).catch(() => null);
    if (seq !== fsSeq) return;
    fsCatItems = (r && r.items) || [];
    fsItems = fsCatItems;
    const q2 = ($('#fs-filter').value || '').toLowerCase();
    let items2 = fsCatItems;
    if (q2) items2 = items2.filter(it => it.name.toLowerCase().includes(q2));
    if (!items2.length) {
      box.innerHTML = '<div class="empty">Файлов этой категории не найдено на внутренней памяти</div>';
      return;
    }
    // сортировка по имени; клик открывает просмотрщик по ПОЛНОМУ пути
    items2 = items2.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const catGrid = fsView !== 'list';
    const catCellPx = fsCellPxOf(fsSlider) || 110;
    const catThumbJobs = [];
    box.classList.toggle('fs-grid', catGrid);
    box.classList.toggle('fs-xl', fsView === 'xl');
    if (catGrid) box.style.setProperty('--fs-cell', catCellPx + 'px');
    else box.style.removeProperty('--fs-cell');
    if (!catGrid) {
      box.innerHTML = items2.map((it, i) => `<div class="list-row fs-row" data-fs-i="${i}" data-fspath="${esc(it.path)}">
      <span class="fs-ico-wrap"><img class="fs-ico" src="${window.FSICONS.iconFor(it.name, false).src}" alt="" data-fscat="${esc(it.path)}" style="cursor:pointer"></span>
      <span class="mono grow2 fs-name" data-fscat="${esc(it.path)}" style="cursor:pointer" data-tip="${esc(it.path)}">${esc(it.name)}</span>
      <span class="muted small" style="max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.path.replace(/^\/sdcard\/?/, ''))}</span>
      <button class="btn btn-text btn-sm" data-fsgetp="${esc(it.path)}" data-tip="Скачать файл с телефона">Скачать</button>
      <button class="btn btn-text btn-sm" data-fspropp="${esc(it.path)}" data-isdir="0" data-tip="Свойства">Свойства</button>
    </div>`).join('');
    } else {
      box.innerHTML = items2.map((it, i) => {
        const name = it.name;
        const ic = window.FSICONS.iconFor(name, false);
        const id = 'fscat-' + i;
        const isVid = VID_RE.test(name);
        // фото — байты в память, видео — кадр из потока; на диск ПК ничего не пишем
        const canThumb = (IMG_RE.test(name) || isVid) && (!it.size || it.size < (isVid ? 8 * 1024 * 1024 * 1024 : 25 * 1024 * 1024));
        if (canThumb) catThumbJobs.push({ path: it.path, el: null, id });
        return `<div class="fs-cell" data-fs-i="${i}" data-fspath="${esc(it.path)}" data-tip="${esc(it.path)}">
      <span class="fs-cell-pic"><img class="fs-cell-ico${canThumb ? ' fs-thumb' : ''}" id="${id}" src="${ic.src}" alt="" data-path="${esc(it.path)}" data-fscat="${esc(it.path)}">${canThumb && isVid ? '<span class="fs-vid-play" aria-hidden="true">▶</span>' : ''}</span>
      <span class="fs-cell-name" data-fscat="${esc(it.path)}">${esc(name)}</span>
      <span class="fs-cell-sub">${it.size ? fmtBytes(it.size) : ''}</span>
      <span class="fs-cell-actions">
        <button class="btn btn-text btn-sm" data-fsgetp="${esc(it.path)}" data-tip="Скачать на компьютер">⭳</button>
        <button class="btn btn-text btn-sm" data-fspropp="${esc(it.path)}" data-isdir="0" data-tip="Свойства">ℹ</button>
      </span>
    </div>`;
      }).join('');
    }
    box.querySelectorAll('[data-fscat]').forEach(el => el.onclick = () => {
      const p = el.dataset.fscat; const nm = p.split('/').pop();
      const fake = { name: nm, dir: false, path: p };
      if (IMG_RE.test(nm)) openImgViewer(p);
      else if (VID_RE.test(nm) || AUD_RE.test(nm)) openMediaPlayer(p);
      else openTextViewer(p);
      void fake;
    });
    box.querySelectorAll('[data-fsgetp]').forEach(b => b.onclick = async () => {
      snack('Скачиваю ' + b.dataset.fsgetp.split('/').pop() + '…');
      const res = await window.api.fsPull(s, b.dataset.fsgetp);
      if (res.ok) snack('Сохранено: ' + res.file);
    });
    box.querySelectorAll('[data-fspropp]').forEach(b => b.onclick = () => {
      const p = b.dataset.fspropp; const nm = p.split('/').pop();
      openFsProps({ name: nm, dir: false, path: p });
    });
    // правый клик по результату категории — то же меню, что и в обычной папке
    box.querySelectorAll('[data-fspath]').forEach(row => {
      row.oncontextmenu = (e) => {
        e.preventDefault(); e.stopPropagation();
        const p = row.dataset.fspath; const nm = p.split('/').pop();
        const fake = { name: nm, dir: false, path: p };
        openFsContextMenu(e.clientX, e.clientY, fake, {
          path: p,
          open: () => { if (IMG_RE.test(nm)) openImgViewer(p); else if (VID_RE.test(nm) || AUD_RE.test(nm)) openMediaPlayer(p); else openTextViewer(p); },
          props: () => openFsProps(fake),
          download: () => window.api.fsPull(s, p).then(res => { if (res.ok) snack('Сохранено: ' + res.file); }),
          reveal: () => fsRevealFile(p),
          refresh: fsRender
        });
      };
    });
    if (catThumbJobs.length) {
      for (const j of catThumbJobs) {
        const el = document.getElementById(j.id);
        if (el) { j.el = el; lazyThumbs([j]); }
      }
    }
    return;
  }
  $('#fs-path').value = fsDir;
  $('#fs-crumb').textContent = fsDir;
  if (!s) {
    if (seq !== fsSeq) return;
    box.innerHTML = '';
    box.classList.add('hidden');
    empty.classList.remove('hidden');
    $('#fs-empty-title').textContent = 'Файлы появятся здесь сразу после подключения';
    $('#fs-empty-text').textContent = 'Подключите телефон на странице «Подключение» — список откроется сам, нажимать ничего не нужно.';
    return;
  }
  if (seq !== fsSeq) return;
  empty.classList.add('hidden');
  box.classList.remove('hidden');
  box.innerHTML = opts.silent ? box.innerHTML : '<div class="empty">Загружаю список файлов…</div>';
  const r = await window.api.fsList(s, fsDir);
  if (seq !== fsSeq) return; // пока грузили — пользователь уже ушёл в другую папку
  // (L2): main нормализует путь (/sdcard/emulated/0 → /storage/emulated/0 и т.п.) —
  // синхронизируем, чтобы крошки и операции работали по настоящему пути
  if (r.path && r.path !== fsDir) { fsDir = r.path; $('#fs-path').value = fsDir; $('#fs-crumb').textContent = fsDir; }
  if (!r.ok) {
    box.innerHTML = '<div class="empty">Не удалось открыть папку: ' + esc(r.error || '') + '</div>';
    try { window.api.uiLog('fs:list ' + fsDir + ' → ' + (r.error || 'ошибка')); } catch (e) {}
    return;
  }
  fsItems = r.items || [];
  const q = ($('#fs-filter').value || '').toLowerCase();
  let items = fsItems;
  if (q) items = items.filter(it => it.name.toLowerCase().includes(q));
  // контекст флешки — кнопки «на флешку/на телефон» видны ТОЛЬКО когда флешка вставлена
  const onFlash = !!(fsFlash && fsDir.startsWith(fsFlash));
  const full = (name) => fsDir.replace(/\/+$/, '') + '/' + name;
  const flashBtns = (name) => fsFlash ? (
    onFlash
      ? `<button class="btn btn-text btn-sm" data-fs2phone="${esc(name)}" data-tip="Скопировать на телефон в /sdcard/Download">На телефон</button>
         <button class="btn btn-text btn-sm" data-fs2phonemv="${esc(name)}" data-tip="ПЕРЕМЕСТИТЬ на телефон в /sdcard/Download">На телефон ✂</button>`
      : `<button class="btn btn-text btn-sm" data-fs2flash="${esc(name)}" data-tip="Скопировать на флешку (${esc(fsFlash)})">На флешку</button>
         <button class="btn btn-text btn-sm" data-fs2flashmv="${esc(name)}" data-tip="ПЕРЕМЕСТИТЬ на флешку (${esc(fsFlash)})">На флешку ✂</button>`
  ) : '';

  const bindCommon = (root) => {
    const byIdx = i => items[i];
    const openItem = (it) => {
      if (it.dir) return fsNavigate(fsDir.replace(/\/+$/, '') + '/' + it.name);
      const fp = full(it.name);
      if (IMG_RE.test(it.name)) openImgViewer(fp);
      else if (VID_RE.test(it.name) || AUD_RE.test(it.name)) openMediaPlayer(fp);
      else if (TXT_RE.test(it.name) || PDF_RE.test(it.name)) openTextViewer(fp);
      else if (HTML_RE.test(it.name)) openTextViewer(fp); // HTML — встроенный просмотр (Превью/Код), «Открыть на ПК» внутри
      else openFsProps(it);
    };
    // клик по квадратной отметке выбора НЕ должен открывать файл.
    // В режиме «Значки» обработчик висит на всей ячейке, поэтому отсекаем
    // клики по чекбоксу и служебным кнопкам.
    root.querySelectorAll('[data-fsopen]').forEach(el => el.onclick = (e) => {
      if (e.target && e.target.closest && e.target.closest('input, button, .fs-sel, .fs-sel-cell, [data-fssel]')) return;
      openItem(byIdx(+el.dataset.fsI));
    });
    root.querySelectorAll('[data-fssel]').forEach(cb => {
      cb.addEventListener('click', e => e.stopPropagation());
      cb.addEventListener('pointerdown', e => e.stopPropagation());
    });
    root.querySelectorAll('[data-fsopen-i]').forEach(el => el.onclick = () => openItem(byIdx(+el.dataset.fsopenI)));
    root.querySelectorAll('[data-fsprop]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openFsProps(byIdx(+(b.closest('[data-fs-i]') || b.closest('.fs-row')).querySelector('[data-fs-i]').dataset.fsI)); });
    root.querySelectorAll('[data-fsget]').forEach(b => b.onclick = async (e) => {
      e.stopPropagation();
      snack('Скачиваю ' + b.dataset.fsget + '…');
      const res = await window.api.fsPull(s, full(b.dataset.fsget));
      if (res.ok) snack('Сохранено: ' + res.file);
    });
    const doTransfer = async (name, mv, dstDirOverride) => {
      const src = full(name);
      const dstDir = dstDirOverride || (onFlash ? '/sdcard/Download' : (() => {
        const rel = fsDir === fsFlash ? '' : fsDir.slice(fsFlash.length).replace(/^\/+/, '');
        return fsFlash + (rel ? '/' + rel : '');
      })());
      const verb = mv ? 'Перемещаю' : 'Копирую';
      snack(verb + ' ' + name + ' → ' + dstDir + '…');
      await window.api.fsCmd(s, ['mkdir', '-p', dstDir]);
      // mv между РАЗНЫМИ томами (память ⟷ флешка) даёт EXDEV — тогда копируем и удаляем источник
      let r2 = await window.api.fsCmd(s, [mv ? 'mv' : 'cp', '-rf', src, dstDir + '/']);
      if (!r2.ok && mv) {
        const rc = await window.api.fsCmd(s, ['cp', '-rf', src, dstDir + '/']);
        if (rc.ok) { await window.api.fsCmd(s, ['rm', '-rf', src]); r2 = { ok: true }; }
        else r2 = rc;
      }
      if (r2.ok) snack((mv ? 'Перемещено: ' : 'Скопировано: ') + name + ' → ' + dstDir);
      else snack('Не удалось: ' + ((r2.stderr || r2.stdout || 'ошибка').slice(0, 120)));
      fsRender();
    };
    root.querySelectorAll('[data-fs2flash]').forEach(b => b.onclick = (e) => { e.stopPropagation(); doTransfer(b.dataset.fs2flash, false); });
    root.querySelectorAll('[data-fs2flashmv]').forEach(b => b.onclick = (e) => { e.stopPropagation(); doTransfer(b.dataset.fs2flashmv, true); });
    root.querySelectorAll('[data-fs2phone]').forEach(b => b.onclick = (e) => { e.stopPropagation(); doTransfer(b.dataset.fs2phone, false); });
    root.querySelectorAll('[data-fs2phonemv]').forEach(b => b.onclick = (e) => { e.stopPropagation(); doTransfer(b.dataset.fs2phonemv, true); });
    // ПРАВАЯ КНОПКА — контекстное меню (Открыть/Копировать/Вырезать/Переименовать/
    // Скачать/В архив/Свойства/Удалить) для файлов И папок
    root.querySelectorAll('.fs-row[data-fs-i], .fs-cell[data-fs-i]').forEach(rowEl => {
      rowEl.oncontextmenu = (e) => {
        const it = byIdx(+(rowEl.dataset.fsI));
        if (!it) return;
        e.preventDefault(); e.stopPropagation();
        openFsContextMenu(e.clientX, e.clientY, it, {
          path: it.path || full(it.name),
          open: () => openItem(it),
          props: () => openFsProps(it),
          download: it.dir ? null : () => window.api.fsPull(s, it.path || full(it.name)).then(res => { if (res.ok) snack('Сохранено: ' + res.file); }),
          // «Открыть расположение» — только в виртуальных категориях (вся музыка/видео/фото),
          // в обычной папке путь и так известен
          reveal: null,
          refresh: fsRender
        });
      };
    });
root.querySelectorAll('[data-fsdel]').forEach(b => b.onclick = async (e) => {
      e.stopPropagation();
      const yes = await uiConfirm('Удаление', 'Удалить ' + b.dataset.fsdel + ' с устройства? (папки — с содержимым)');
      if (!yes || !yes.ok) return;
      await fsDeletePath(b.dataset.fsdel, full(b.dataset.fsdel));
    });
    // строки и ячейки можно перетаскивать в Проводник
    root.querySelectorAll('.fs-row, .fs-cell').forEach(el => {
      if (el.dataset.fsfull || el.dataset.fspath) el.draggable = true;
    });
  };

  const thumbJobs = [], apkJobs = [];
  if (fsView === 'list') {
    box.classList.remove('fs-grid', 'fs-xl');
    box.innerHTML = items.map((it, i) => {
      const ic = window.FSICONS.iconFor(it.name, it.dir);
      const isApk = !it.dir && APK_RE.test(it.name);
      const media = !it.dir && (IMG_RE.test(it.name) || VID_RE.test(it.name) || AUD_RE.test(it.name));
      if (isApk) apkJobs.push({ path: full(it.name), name: it.name, id: 'fsapk-' + i });
      return `<div class="list-row fs-row" data-fs-i="${i}" data-fsfull="${esc(full(it.name))}" data-fsdir="${it.dir ? 1 : 0}">
      <input type="checkbox" class="fs-sel" data-fssel="${esc(full(it.name))}" data-tip="Отметить файл для пакетных действий">
      <span class="fs-ico-wrap"><img class="fs-ico" src="${ic.src}" alt="" data-fsopen-i="${i}" id="fsapk-${i}" data-path="${esc(full(it.name))}">${fsBadgeHtml(isApk)}</span>
      <span class="mono grow2 fs-name" data-fsopen="${esc(it.name)}" data-isdir="${it.dir ? 1 : 0}" data-fs-i="${i}" style="cursor:pointer" id="fsapk-${i}-name" data-path="${esc(full(it.name))}" data-tip="${it.dir ? 'Открыть папку' : (media ? 'Открыть в просмотрщике/плеере' : 'Двойной клик — свойства')}">${esc(it.name)}</span>
      <span class="muted fs-size">${it.dir ? '' : fmtBytes(it.size)}</span>
      <span class="muted fs-date">${esc(it.date || '')}</span>
      <button class="btn btn-text btn-sm" data-fsprop="${esc(it.name)}" data-isdir="${it.dir ? 1 : 0}" data-tip="Свойства: размер, дата, права доступа, содержимое">Свойства</button>
      ${it.dir ? '' : '<button class="btn btn-text btn-sm" data-fsget="' + esc(it.name) + '" data-tip="Скачать файл с телефона на компьютер">Скачать</button>'}
      ${flashBtns(it.name)}
      <button class="btn btn-text btn-sm" data-fsdel="${esc(it.name)}" data-tip="Удалить с телефона (папки — с содержимым)">Удалить</button>
    </div>`;
    }).join('') || '<div class="empty">Папка пуста</div>';
  } else {
    // значки / огромные значки — сетка как в Проводнике
    // размер ячейки ПЛАВНЫЙ (ползунок 35–100 → 76..250 px), как в Windows
    const cellPx = fsCellPxOf(fsSlider) || 110;
    const xl = fsView === 'xl';
    box.classList.add('fs-grid'); box.classList.toggle('fs-xl', xl);
    box.style.setProperty('--fs-cell', cellPx + 'px');
    box.innerHTML = items.map((it, i) => {
      const ic = window.FSICONS.iconFor(it.name, it.dir);
      const isApk = !it.dir && APK_RE.test(it.name);
      const isImg = !it.dir && IMG_RE.test(it.name);
      const isVid = !it.dir && VID_RE.test(it.name);
      const id = 'fscell-' + i;
      // Превью в любом размере сетки (не только XL): фото — байты через fsCat → blob URL,
      // видео — один кадр из потока media-сервера. На диск компьютера ничего не пишем.
      const canThumb = (isImg || isVid) && (!it.size || it.size < (isVid ? 8 * 1024 * 1024 * 1024 : 25 * 1024 * 1024));
      if (canThumb) thumbJobs.push({ path: full(it.name), el: null, id });
      if (isApk) apkJobs.push({ path: full(it.name), name: it.name, id });
      return `<div class="fs-cell" data-fsopen="${esc(it.name)}" data-isdir="${it.dir ? 1 : 0}" data-fs-i="${i}" data-fsfull="${esc(full(it.name))}" data-tip="${it.dir ? 'Открыть папку (правая кнопка — меню)' : 'Клик — открыть, правая кнопка — меню'}">
      <input type="checkbox" class="fs-sel-cell" data-fssel="${esc(full(it.name))}" data-tip="Отметить для пакетных действий">
      ${canThumb
        ? '<span class="fs-cell-pic"><img class="fs-cell-ico fs-thumb" id="' + id + '" src="' + ic.src + '" alt="" data-path="' + esc(full(it.name)) + '">' + (isVid ? '<span class="fs-vid-play" aria-hidden="true">▶</span>' : '') + '</span>'
        : '<span style="position:relative;display:inline-block"><img class="fs-cell-ico" id="' + id + '" src="' + ic.src + '" alt="" data-path="' + esc(full(it.name)) + '">' + fsBadgeHtml(isApk) + '</span>'}
      <span class="fs-cell-name" id="${id}-name" data-path="${esc(full(it.name))}">${esc(it.name)}</span>
      <span class="fs-cell-sub">${it.dir ? 'папка' : fmtBytes(it.size) + (isVid ? ' · видео' : isApk ? ' · приложение' : '')}</span>
      <span class="fs-cell-actions">
        <button class="btn btn-text btn-sm" data-fsprop="${esc(it.name)}" data-isdir="${it.dir ? 1 : 0}" data-tip="Свойства">ℹ</button>
        ${it.dir ? '' : '<button class="btn btn-text btn-sm" data-fsget="' + esc(it.name) + '" data-tip="Скачать на компьютер">⭳</button>'}
        ${it.dir ? '' : '<button class="btn btn-text btn-sm" data-fsdel="' + esc(it.name) + '" data-tip="Удалить">✕</button>'}
      </span>
    </div>`;
    }).join('') || '<div class="empty">Папка пуста</div>';
  }
  bindCommon(box);
  if (thumbJobs.length) {
    // миниатюры: подставляем реальные <img> после вставки разметки
    for (const j of thumbJobs) { const el = document.getElementById(j.id); if (el) { j.el = el; lazyThumbs([j]); } }
  }
  if (apkJobs.length) {
    for (const j of apkJobs) { const el = document.getElementById(j.id); if (el && el.dataset.path === j.path) queueFsApkIcons([{ ...j, id: el.id }]); }
  }
  fsBatchUpdate();   // после перерисовки панель мультивыбора скрываем
}

/* ================= КОНТЕКСТНОЕ МЕНЮ (правая кнопка) =================
   Для файлов и папок: Открыть · Скачать · Копировать · Вырезать · Переименовать ·
   В архив ZIP · Открыть архив (для архивов) · Свойства · Удалить. Закрытие — клик мимо/Esc. */
function closeFsCtx() { const m = $('#fs-ctx'); if (m) { m.classList.add('hidden'); m.innerHTML = ''; } }
document.addEventListener('click', closeFsCtx);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFsCtx(); });
window.addEventListener('blur', closeFsCtx);
/* открыть папку, где лежит файл, и подсветить его */
function fsRevealFile(p) {
  const parent = String(p || '').replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
  fsNavigate(parent);
  setTimeout(() => {
    let found = null;
    $$('#fs-list [data-path]').forEach(el => { if (!found && el.dataset.path === p) found = el; });
    if (found) {
      const row = found.closest('.fs-row, .fs-cell') || found;
      row.classList.add('fs-flash');
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => row.classList.remove('fs-flash'), 2600);
    }
  }, 900);
}
function openFsContextMenu(x, y, it, act) {
  const m = $('#fs-ctx');
  const items = [];
  const isArc = !it.dir && ARC_RE.test(it.name);
  const isApk = !it.dir && APK_RE.test(it.name);
  const p = act.path;
items.push({ t: it.dir ? '&#128449; Открыть папку' : '&#128196; Открыть', fn: act.open });
  // «слушать фоном» — аудио играет в левой панели, пока ходишь по другим разделам
  if (!it.dir && AUD_RE.test(it.name)) items.push({ t: '&#9835; Слушать фоном', fn: () => rmPlayFull(p) });
  if (act.reveal) items.push({ t: '&#128194; Открыть расположение файла', fn: act.reveal });
  if (isArc) items.push({ t: '&#128230; Открыть архив (не распаковывая)', fn: () => openArcViewer(p, it.name) });
  if (!it.dir && act.download) items.push({ t: '&#11015; Скачать на компьютер', fn: act.download });
  items.push({ sep: true });
  // массовое выделение из контекстного меню — не кликать по одному
  items.push({ t: '&#9745; Выделить все', fn: () => {
    $$('#fs-list [data-fssel]').forEach(c => c.checked = true);
    fsBatchUpdate(); snack('Отмечено: ' + fsSelPaths().length);
  } });
  items.push({ t: '&#9744; Снять выделение', fn: () => {
    $$('#fs-list [data-fssel]').forEach(c => c.checked = false);
    fsBatchUpdate(); snack('Выделение снято');
  } });
  items.push({ sep: true });
  items.push({ t: '&#128203; Копировать', fn: () => { fsClip = { paths: [p], cut: false }; showFsClipbar(); snack('Скопировано в буфер: ' + it.name); } });
  items.push({ t: '&#9986; Вырезать', fn: () => { fsClip = { paths: [p], cut: true }; showFsClipbar(); snack('Вырезано: ' + it.name); } });
  items.push({ t: '&#128193; Переместить в…', fn: () => openFsMoveDialog([p], true, it.name) });
  if (!it.dir) items.push({ t: '&#128193; Копировать в…', fn: () => openFsMoveDialog([p], false, it.name) });
  items.push({ t: '&#9998; Переименовать', fn: () => fsRename(p, it.name) });
  items.push({ sep: true });
  items.push({ t: '&#128230; Добавить в архив ZIP', fn: () => fsZipItems([p], it.name) });
  items.push({ t: '&#9432; Свойства', fn: act.props });
  items.push({ sep: true });
  items.push({ t: '&#10060; Удалить', danger: true, fn: async () => {
    const yes = await uiConfirm('Удаление', 'Удалить ' + it.name + (it.dir ? ' (папка — с содержимым)' : '') + ' с устройства?');
    if (!yes || !yes.ok) return;
    await fsDeletePath(it.name, p);
  } });
  m.innerHTML = items.map((x, i) => x.sep ? '<div class="fs-ctx-sep"></div>' :
    `<button class="fs-ctx-item${x.danger ? ' danger' : ''}" data-i="${i}">${x.t}</button>`).join('');
  m.querySelectorAll('.fs-ctx-item').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    closeFsCtx();
    const fn = items[+b.dataset.i].fn;
    if (fn) fn();
  });
  m.classList.remove('hidden');
  const w = m.offsetWidth || 240, h = m.offsetHeight || 200;
  m.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
  m.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  m.style.zIndex = '500';
}
/* ---------- буфер обмена проводника: панель + вставка (в любую папку, любой том) ---------- */
function showFsClipbar() {
  const bar = $('#fs-clipbar');
  if (!fsClip.paths.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const names = fsClip.paths.map(p => p.split('/').pop());
  const shown = names.length > 3 ? names.slice(0, 3).join(', ') + ' + ещё ' + (names.length - 3) : names.join(', ');
  $('#fs-cliptext').textContent = (fsClip.cut ? 'Вырезано: ' : 'Скопировано: ') + shown + ' → вставьте в нужной папке';
}
async function fsPasteInto(dstDir) {
  const s = currentSerial(); if (!s || !fsClip.paths.length) return;
  snack((fsClip.cut ? 'Перемещаю ' : 'Копирую ') + fsClip.paths.length + ' объект(ов) → ' + dstDir + '…');
  await window.api.fsCmd(s, ['mkdir', '-p', dstDir]);
  let okN = 0;
  for (const p of fsClip.paths) {
    const name = p.split('/').filter(Boolean).pop() || 'file';
    let dest = dstDir.replace(/\/+$/, '') + '/' + name;
    if (p.replace(/\/+$/, '') === dest) dest = dstDir.replace(/\/+$/, '') + '/копия_' + name; // вставка в ту же папку
    let r = await window.api.fsCmd(s, [fsClip.cut ? 'mv' : 'cp', '-rf', p, dest]);
    if (!r.ok && fsClip.cut) {
      const rc = await window.api.fsCmd(s, ['cp', '-rf', p, dest]);
      if (rc.ok) { await window.api.fsCmd(s, ['rm', '-rf', p]); r = { ok: true }; }
    }
    if (r.ok) okN++;
    else snack('Не удалось: ' + name + ' — ' + ((r.stderr || r.stdout || 'ошибка').slice(0, 100)));
  }
  if (fsClip.cut && okN === fsClip.paths.length) fsClip = { paths: [], cut: false };
  showFsClipbar();
  snack('Готово: ' + okN + ' из ' + fsClip.paths.length);
  fsRender();
}
async function fsRename(p, oldName) {
  const s = currentSerial(); if (!s) return;
  const newName = await askText('Переименовать', 'Новое имя:', oldName);
  if (!newName || newName === oldName) return;
  if (/[\/\\]/.test(newName)) return snack('Имя не может содержать / или \\');
  const parent = p.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
  const r = await window.api.fsCmd(s, ['mv', p, (parent === '/' ? '' : parent) + '/' + newName]);
  if (r.ok) { snack('Переименовано: ' + oldName + ' → ' + newName); fsRender(); }
  else snack('Не удалось переименовать: ' + ((r.stderr || r.stdout || 'ошибка').slice(0, 120)));
}
async function fsZipItems(paths, firstName) {
  const s = currentSerial(); if (!s) return;
  const base = (firstName || 'архив').replace(/\.[a-z0-9]+$/i, '');
  let dest = (fsCatKind ? '/sdcard' : fsDir).replace(/\/+$/, '') + '/' + base + '.zip';
  const ex = await window.api.fsStat(s, dest);
  if (ex && ex.ok) dest = dest.replace(/\.zip$/, '') + '-' + Date.now().toString(36).slice(-4) + '.zip';
  snack('Собираю ZIP: ' + dest.split('/').pop() + '…');
  const r = await window.api.fsZipCreate(s, paths, dest);
  if (r.ok) { snack('Архив создан: ' + r.dest + ' (' + r.files + ' файлов, ' + fmtBytesLong(r.bytes) + ')'); fsRender(); }
  else snack('Не удалось собрать архив: ' + (r.error || ''), 6000);
}
$('#btn-fs-mkdir').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  const name = await askText('Новая папка', 'Имя новой папки:', '');
  if (!name) return;
  await window.api.fsCmd(s, ['mkdir', '-p', fsDir.replace(/\/+$/, '') + '/' + name]);
  fsRender();
};
$('#btn-fs-newfile').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  const name = await askText('Новый файл', 'Имя файла (например заметка.txt):', 'новый.txt');
  if (!name) return;
  if (/[\/\\]/.test(name)) return snack('Имя не может содержать / или \\');
  const target = (fsCatKind ? '/sdcard' : fsDir).replace(/\/+$/, '') + '/' + name;
  const r = await window.api.fsCmd(s, ['sh', '-c', 'touch ' + adbShqSafe(target)]);
  if (r.ok) { snack('Создан файл: ' + name); fsRender(); }
  else snack('Не удалось создать: ' + ((r.stderr || r.stdout || 'ошибка').slice(0, 120)));
};
function adbShqSafe(p) {
  if (/^[A-Za-z0-9_@%+=:,./\-]+$/.test(p)) return p;
  return "'" + String(p).replace(/'/g, "'\\''") + "'";
}
$('#btn-fs-paste').onclick = () => fsPasteInto(fsCatKind ? '/sdcard' : fsDir);
$('#btn-fs-clipcancel').onclick = () => { fsClip = { paths: [], cut: false }; showFsClipbar(); };

/* ================= МУЛЬТИВЫБОР ФАЙЛОВ (галочки) =================
   Отметил несколько файлов → «Скачать», «Копировать», «Вырезать», «Удалить» пачкой. */
function fsSelPaths() { return $$('#fs-list [data-fssel]:checked').map(c => c.dataset.fssel); }
function fsBatchUpdate() {
  const n = fsSelPaths().length;
  const bar = $('#fs-batch');
  if (!bar) return;
  bar.classList.toggle('hidden', !n);
  const t = $('#fs-batch-text');
  if (t) t.textContent = 'Отмечено: ' + n;
  const ph = $('#btn-fs-batch-phone');
  if (ph) {
    const has = onlineDevices().some(d => d.serial !== activeSerial);
    ph.disabled = !has;
    ph.setAttribute('data-tip', has
      ? 'Передать отмеченные файлы на другой подключённый телефон напрямую по Wi-Fi'
      : 'Нужен второй телефон в той же Wi-Fi-сети');
  }
}

// передача выбранного на другой телефон. Выбор получателя и папки —
// в отдельном диалоге; сами данные идут между телефонами, не через ПК.
const ptCtx = { paths: [], src: null };
function ptOtherDevices() {
  return onlineDevices().filter(d => d.serial !== activeSerial);
}
function ptOpen(paths) {
  const others = ptOtherDevices();
  if (!others.length) return snack('Нужен второй телефон в той же Wi-Fi-сети');
  if (!activeSerial) return snack('Нет устройства-источника');
  ptCtx.paths = paths.slice();
  ptCtx.src = activeSerial;
  $('#pt-sub').textContent = 'Источник: ' + nameOf(activeSerial) + ' (' + activeSerial + ')';
  $('#pt-target').innerHTML = others.map(d =>
    `<option value="${esc(d.serial)}">${esc(d.friendly || d.model || d.serial)} — ${esc(d.serial)}</option>`).join('');
  $('#pt-files').innerHTML = '<b>К передаче: ' + paths.length + '</b>' +
    paths.slice(0, 12).map(p => '<div class="mono small" style="word-break:break-all">' + esc(p) + '</div>').join('') +
    (paths.length > 12 ? '<div class="muted small">… и ещё ' + (paths.length - 12) + '</div>' : '');
  $('#pt-dest').value = '/sdcard/Download';
  $('#pt-status').textContent = 'Данные пойдут напрямую по Wi-Fi между телефонами. Компьютер только запускает передачу.';
  $('#btn-pt-start').disabled = false;
  openDlg('dlg-phonetransfer');
}
async function ptRun() {
  if (!ptCtx.paths.length || !ptCtx.src) return;
  const dst = $('#pt-target').value;
  const dest = ($('#pt-dest').value || '').trim() || '/sdcard/Download';
  if (!dst) return;
  const btn = $('#btn-pt-start');
  btn.disabled = true;
  $('#pt-status').textContent = 'Передаю ' + ptCtx.paths.length + ' объект(ов)… Не закрывайте программу.';
  try {
    const r = await window.api.fsPhoneTransfer({ src: ptCtx.src, dst, paths: ptCtx.paths, dest });
    const items = (r && r.items) || [];
    const okN = items.filter(x => x && x.ok).length;
    if (r && r.ok) {
      $('#pt-status').textContent = 'Готово: ' + okN + ' из ' + items.length + ' передано в ' + dest + ' на ' + dst + '.';
      snack('Передано на ' + dst + ': ' + okN + ' из ' + items.length, 5000);
      $$('#fs-list [data-fssel]').forEach(c => c.checked = false);
      fsBatchUpdate();
    } else {
      const bad = items.filter(x => x && !x.ok).slice(0, 5)
        .map(x => (x.path || '') + ': ' + (x.error || 'ошибка')).join('\n');
      $('#pt-status').textContent = 'Ошибка: ' + ((r && r.error) || (bad || 'передача не удалась'));
      if (bad && !(r && r.error)) $('#pt-status').textContent += '\n' + bad;
      snack('Передача не удалась: ' + ((r && r.error) || 'см. подробности в окне'), 6000);
    }
  } catch (e) {
    $('#pt-status').textContent = 'Ошибка: ' + e.message;
    snack('Передача не удалась: ' + e.message, 6000);
  } finally {
    btn.disabled = false;
  }
}
document.addEventListener('change', e => {
  if (e.target && e.target.matches && e.target.matches('#fs-list [data-fssel]')) fsBatchUpdate();
});
document.addEventListener('click', e => {
  const b = e.target && e.target.closest && e.target.closest('#btn-fs-batch-clear');
  if (b) { $$('#fs-list [data-fssel]').forEach(c => c.checked = false); fsBatchUpdate(); }
});
$('#btn-fs-batch-copy').onclick = () => {
  const paths = fsSelPaths();
  if (!paths.length) return;
  fsClip = { paths, cut: false };
  showFsClipbar(); snack('Скопировано в буфер: ' + paths.length + ' объект(ов)');
  $$('#fs-list [data-fssel]').forEach(c => c.checked = false); fsBatchUpdate();
};
$('#btn-fs-batch-cut').onclick = () => {
  const paths = fsSelPaths();
  if (!paths.length) return;
  fsClip = { paths, cut: true };
  showFsClipbar(); snack('Вырезано в буфер: ' + paths.length + ' объект(ов)');
  $$('#fs-list [data-fssel]').forEach(c => c.checked = false); fsBatchUpdate();
};
$('#btn-fs-batch-phone').onclick = () => {
  const paths = fsSelPaths();
  if (!paths.length) return;
  ptOpen(paths);
};
$('#btn-pt-start').onclick = ptRun;
$('#btn-fs-batch-get').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  const paths = fsSelPaths().filter(p => {
    const row = $$('#fs-list [data-fsfull]').find(r => r.dataset.fsfull === p);
    return !row || row.dataset.fsdir !== '1';   // папки не скачиваем по одной кнопке
  });
  if (!paths.length) return snack('Отмечены только папки — скачивание недоступно');
  snack('Скачиваю ' + paths.length + ' файл(ов)…');
  let okN = 0;
  for (const p of paths) {
    const r = await window.api.fsPull(s, p);
    if (r.ok) okN++;
  }
  snack('Скачано: ' + okN + ' из ' + paths.length, 5000);
  $$('#fs-list [data-fssel]').forEach(c => c.checked = false); fsBatchUpdate();
};
$('#btn-fs-batch-del').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  const paths = fsSelPaths();
  if (!paths.length) return;
  const yes = await uiConfirm('Удаление', 'Удалить ' + paths.length + ' отмеченных объектов с устройства? Папки — с содержимым.');
  if (!yes || !yes.ok) return;
  let okN = 0;
  const okPaths = [];
  for (const p of paths) {
    const r = await window.api.fsCmd(s, ['rm', '-rf', p]);
    if (r.ok) { okN++; okPaths.push(p); }
  }
  if (okPaths.length) fsRemovePathsFromList(okPaths);
  snack('Удалено: ' + okN + ' из ' + paths.length);
  fsBatchUpdate();
};


/* ================= «Переместить в… / Копировать в…» — выбор папки назначения ======= */
const fsm = { paths: [], move: true, dir: '/sdcard', resolve: null };
function fsmRenderList() {
  const box = $('#fsm-list');
  box.innerHTML = '<div class="empty">Читаю папки…</div>';
  window.api.fsList(currentSerial(), fsm.dir).then(r => {
    if (!r.ok) { box.innerHTML = '<div class="empty">Не удалось открыть: ' + esc(r.error || '') + '</div>'; return; }
    const dirs = (r.items || []).filter(x => x.dir);
    $('#fsm-path').value = fsm.dir;
    box.innerHTML = dirs.map(d => `<div class="list-row" data-fsmd="${esc(d.name)}">
      <span class="fs-ico-wrap"><img class="fs-ico" src="${window.FSICONS.iconFor('', true).src}" alt=""></span>
      <span class="grow2">${esc(d.name)}</span><span class="muted small">открыть</span></div>`).join('') || '<div class="empty">Вложенных папок нет</div>';
    box.querySelectorAll('[data-fsmd]').forEach(el => el.onclick = () => {
      fsm.dir = fsm.dir.replace(/\/+$/, '') + '/' + el.dataset.fsmd;
      fsmRenderList();
    });
  });
}
function openFsMoveDialog(paths, move, firstName) {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  fsm.paths = paths; fsm.move = !!move;
  fsm.dir = fsCatKind ? '/sdcard' : (fsFlash && (fsDir + '/').startsWith(fsFlash) ? fsFlash : '/sdcard');
  $('#fsm-title').textContent = move ? 'Переместить в…' : 'Копировать в…';
  $('#fsm-sub').textContent = (move ? 'Переместить' : 'Скопировать') + ' «' + (firstName || paths[0].split('/').pop()) + '» в выбранную папку. Папку можно открыть на любом томе (память/флешка).';
  openDlg('dlg-fsmove');
  fsmRenderList();
}
$('#btn-fsm-up').onclick = () => { const p = fsm.dir.replace(/\/+$/, '').split('/'); p.pop(); fsm.dir = p.join('/') || '/'; fsmRenderList(); };
$('#btn-fsm-refresh').onclick = fsmRenderList;
$('#fsm-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') { fsm.dir = fsNormalize($('#fsm-path').value.trim() || '/sdcard'); fsmRenderList(); } });
$('#btn-fsm-ok').onclick = async () => {
  const dest = fsNormalize($('#fsm-path').value.trim() || fsm.dir);
  closeDlg('dlg-fsmove');
  if (fsm.resolve) { const fn = fsm.resolve; fsm.resolve = null; fn(dest); return; }
  const s = currentSerial();
  snack((fsm.move ? 'Перемещаю ' : 'Копирую ') + fsm.paths.length + ' объект(ов) → ' + dest + '…');
  await window.api.fsCmd(s, ['mkdir', '-p', dest]);
  for (const p of fsm.paths) {
    const name = p.split('/').filter(Boolean).pop();
    let r = await window.api.fsCmd(s, [fsm.move ? 'mv' : 'cp', '-rf', p, dest + '/' + name]);
    if (!r.ok && fsm.move) {
      const rc = await window.api.fsCmd(s, ['cp', '-rf', p, dest + '/' + name]);
      if (rc.ok) { await window.api.fsCmd(s, ['rm', '-rf', p]); r = { ok: true }; }
    }
    if (!r.ok) snack('Не удалось: ' + name + ' — ' + ((r.stderr || r.stdout || 'ошибка').slice(0, 100)));
  }
  snack('Готово → ' + dest);
  fsRender();
};

/* ================= ПРОСМОТР АРХИВА БЕЗ РАСПАКОВКИ (как в Проводнике) ============== */
const arc = { path: null, name: '', entries: [] };
async function openArcViewer(archivePath, arcName) {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  arc.path = archivePath; arc.name = arcName || archivePath.split('/').pop();
  $('#arc-title').textContent = arc.name;
  $('#arc-info').textContent = 'Читаю содержимое…';
  $('#arc-list').innerHTML = '<div class="empty">Скачиваю архив и читаю оглавление…</div>';
  openDlg('dlg-arcview');
  const r = await window.api.fsZipList(s, archivePath);
  if (!r.ok) { $('#arc-list').innerHTML = '<div class="empty">' + esc(r.error || 'не удалось прочитать архив') + '</div>'; return; }
  arc.entries = r.entries || [];
  const files = arc.entries.filter(e => !e.dir);
  $('#arc-info').textContent = 'файлов: ' + files.length + (r.size ? ' · ' + fmtBytesLong(r.size) : '');
  arcRenderList();
}
function arcRenderList() {
  const box = $('#arc-list');
  const q = ($('#arc-filter').value || '').toLowerCase();
  let list = arc.entries;
  if (q) list = list.filter(e => e.name.toLowerCase().includes(q));
  // индексы — ТОЛЬКО глобальные (arc.entries.indexOf), иначе при активном
  // фильтре «Посмотреть/Скачать/Извлечь» указывали на чужие файлы
  box.innerHTML = list.map(e => {
    const gi = arc.entries.indexOf(e);
    return `<div class="list-row" data-arci="${gi}">
      <input type="checkbox" data-arcsel="${gi}" ${e.dir ? 'disabled' : ''}>
      <span class="fs-ico-wrap"><img class="fs-ico" src="${window.FSICONS.iconFor(e.dir ? '' : e.name.split('/').pop(), e.dir).src}" alt=""></span>
      <span class="mono grow2" style="cursor:pointer">${esc(e.name)}</span>
      <span class="muted small">${e.dir ? 'папка' : fmtBytesLong(e.usize || 0)}</span>
      ${e.dir ? '' : '<button class="btn btn-text btn-sm" data-arcview="' + gi + '" data-tip="Посмотреть файл, не распаковывая архив">Посмотреть</button>'}
      ${e.dir ? '' : '<button class="btn btn-text btn-sm" data-arcsave="' + gi + '" data-tip="Сохранить файл на компьютер">Скачать</button>'}
    </div>`;
  }).join('') || '<div class="empty">В архиве нет файлов под фильтр</div>';
  box.querySelectorAll('.list-row .mono').forEach(el => el.ondblclick = () => {
    const row = el.closest('[data-arci]');
    const e = arc.entries[+row.dataset.arci];
    if (e && !e.dir) arcViewEntry(e);
  });
  box.querySelectorAll('[data-arcview]').forEach(b => b.onclick = () => arcViewEntry(arc.entries[+b.dataset.arcview]));
  box.querySelectorAll('[data-arcsave]').forEach(b => b.onclick = async () => {
    const e = arc.entries[+b.dataset.arcsave];
    const s = currentSerial();
    const r = await window.api.fsZipRead(s, arc.path, e.name);
    if (!r.ok) return snack(r.error || 'не удалось прочитать файл из архива');
    const sv = await window.api.pickSave({ defaultPath: e.name.split('/').pop() });
    if (!sv || sv.canceled) return;
    const wr = await window.api.fsTmpWrite(e.name.split('/').pop() + '.' + Date.now().toString(36), bytesToB64(new Uint8Array(r.buf)));
    if (!wr.ok) return snack('Не удалось подготовить файл: ' + (wr.error || ''));
    // fsTmpWrite пишет во временную папку — копируем в выбранное место через push-механику нет;
    // используем прямой путь: fsTmpWrite в tmp, затем показать в папке
    await window.api.shellOpenPath(wr.path);
    snack('Файл из архива: ' + wr.path);
  });
}
async function arcViewEntry(e) {
  const s = currentSerial();
  snack('Читаю из архива: ' + e.name.split('/').pop() + '…');
  const r = await window.api.fsZipRead(s, arc.path, e.name);
  if (!r.ok) return snack(r.error || 'не удалось прочитать файл из архива');
  const nm = e.name.split('/').pop();
  const wr = await window.api.fsTmpWrite('arcview-' + Date.now().toString(36) + '-' + nm, bytesToB64(new Uint8Array(r.buf)));
  if (!wr.ok) return snack('Не удалось подготовить просмотр: ' + (wr.error || ''));
  const op = await window.api.shellOpenPath(wr.path);
  if (!op.ok) snack('Системная программа не открыла файл: ' + (op.error || ''));
}
$('#arc-filter').addEventListener('input', arcRenderList);
$('#btn-arc-extract-all').onclick = async () => {
  closeDlg('dlg-arcview');
  const s = currentSerial();
  const b = { disabled: false };
  snack('Распаковываю ' + arc.name + '…');
  const r = await window.api.fsExtract(s, arc.path);
  if (r.ok) { snack('Распаковано (' + (r.where || 'на устройстве') + '): ' + r.files + ' файлов → ' + r.dest); fsNavigate(r.dest); }
  else snack(r.error || 'Не удалось распаковать', 6000);
};
$('#btn-arc-extract-sel').onclick = async () => {
  const sel = $$('#arc-list [data-arcsel]:checked').map(c => arc.entries[+c.dataset.arcsel]).filter(e => e && !e.dir);
  if (!sel.length) return snack('Отметьте файлы галочками');
  const s = currentSerial();
  const dest = arc.path.replace(/\.[^/.]+$/, '') + '_распаковано';
  await window.api.fsCmd(s, ['mkdir', '-p', dest]);
  snack('Извлекаю ' + sel.length + ' файл(ов)…');
  let ok = 0;
  for (const e of sel) {
    const r = await window.api.fsZipRead(s, arc.path, e.name);
    if (!r.ok) continue;
    const nm = e.name.split('/').pop();
    const wr = await window.api.fsTmpWrite('arcsel-' + Date.now().toString(36) + '-' + nm, bytesToB64(new Uint8Array(r.buf)));
    if (!wr.ok) continue;
    const rel = e.name.replace(/^\/+/, '').split('/').slice(0, -1).join('/');
    if (rel) await window.api.fsCmd(s, ['mkdir', '-p', dest + '/' + rel]);
    const pr = await window.api.fsPush(s, wr.path, dest + (rel ? '/' + rel : ''));
    if (pr.ok) ok++;
  }
  snack('Извлечено: ' + ok + ' из ' + sel.length + ' → ' + dest);
  closeDlg('dlg-arcview');
  fsNavigate(dest);
};

/* ================= ИНСТРУМЕНТЫ USB/OTG-ФЛЕШКИ ================================== */
let usbVol = null;
async function openUsbTools(vol) {
  usbVol = vol;
  openDlg('dlg-usbtools');
  $('#usb-log').textContent = '';
  usbRefreshInfo();
}
async function usbRefreshInfo() {
  const s = currentSerial(); if (!s || !usbVol) return;
  $('#usb-info').textContent = 'Читаю данные тома…';
  const r = await window.api.usbInfo(s, usbVol);
  if (!r.ok) { $('#usb-info').textContent = 'Ошибка: ' + (r.error || ''); return; }
  const parts = ['Том: /storage/' + usbVol];
  if (r.fstype) parts.push('ФС: ' + r.fstype);
  if (r.dev) parts.push('устройство: ' + r.dev);
  if (r.total) parts.push('объём: ' + r.total + 'К, занято ' + r.used + 'К, свободно ' + r.free + 'К');
  if (r.mounted === false) parts.push('НЕ СМОНТИРОВАНА');
  $('#usb-info').textContent = parts.join(' · ');
}
function usbLog(t) { const el = $('#usb-log'); el.textContent += t + '\n'; el.scrollTop = el.scrollHeight; }
$('#btn-usb-refresh').onclick = usbRefreshInfo;
$('#btn-usb-check').onclick = async () => {
  const s = currentSerial(); if (!s) return;
  usbLog('Проверяю файловую систему (попробую fsck, иначе перемонтирование)…');
  const r = await window.api.usbCheck(s, usbVol);
  usbLog((r.ok ? '✓ ' : '✗ ') + (r.tool ? r.tool + ': ' : '') + (r.message || r.error || ''));
  if (r.ok) snack('Проверка завершена — подробности в журнале ниже');
};
$('#btn-usb-eject').onclick = async () => {
  const s = currentSerial();
  const r = await window.api.usbEject(s, usbVol);
  snack(r.message || (r.ok ? 'Извлечено' : 'Не удалось извлечь'));
  if (r.ok) { closeDlg('dlg-usbtools'); renderFsVolumes(); }
};
$('#btn-usb-label').onclick = async () => {
  const s = currentSerial();
  const label = $('#usb-label').value.trim();
  if (!label) return snack('Введите метку тома');
  const yes = await uiConfirm('Смена метки', 'Метка меняется ПЕРЕСОЗДАНИЕМ файловой системы — ВСЕ ДАННЫЕ будут стёрты. Продолжить?');
  if (!yes || !yes.ok) return;
  usbLog('Меняю метку на «' + label + '»…');
  const r = await window.api.usbLabel(s, usbVol, label);
  usbLog((r.ok ? '✓ ' : '✗ ') + (r.message || r.error || ''));
};
$('#btn-usb-format').onclick = async () => {
  const s = currentSerial();
  const label = $('#usb-label').value.trim();
  const yes = await uiConfirm('Форматирование', 'ПОЛНОСТЬЮ отформатировать флешку ' + usbVol + '? ВСЕ ДАННЫЕ БУДУТ СТЁРТЫ.');
  if (!yes || !yes.ok) return;
  usbLog('Форматирую…');
  const r = await window.api.usbFormat(s, usbVol, label || null);
  usbLog((r.ok ? '✓ ' : '✗ ') + (r.message || r.error || ''));
  for (const w of (r.warnings || [])) usbLog('· ' + w);
  if (r.ok) snack('Форматирование выполнено');
};
$('#btn-usb-fake').onclick = async () => {
  const s = currentSerial();
  const blk = +$('#usb-fake-blk').value || 64;
  $('#usb-fake-progress').classList.remove('hidden');
  $('#usb-fake-bar').style.width = '0%';
  $('#usb-fake-status').textContent = 'Запускаю проверку памяти…';
  $('#btn-usb-fake-cancel').classList.remove('hidden');
  $('#btn-usb-fake').disabled = true;
  const r = await window.api.usbFakeTestStart(s, usbVol, blk);
  if (!r.ok) { $('#usb-fake-status').textContent = r.error || 'не удалось начать'; $('#btn-usb-fake').disabled = false; $('#btn-usb-fake-cancel').classList.add('hidden'); $('#usb-fake-progress').classList.add('hidden'); }
};
$('#btn-usb-fake-cancel').onclick = () => window.api.usbFakeTestCancel();
function usbFakeEvent(ev) {
  const bar = $('#usb-fake-bar'), st = $('#usb-fake-status');
  if (!st) return;
  if (ev.stage === 'write') { st.textContent = 'Заливаю флешку блоками по ' + ev.blk + ' МБ (записываются маркеры)…'; }
  else if (ev.stage === 'write-progress') {
    const mb = ev.done * (ev.blockBytes / 1048576);
    st.textContent = 'Записано: ' + (mb >= 1024 ? (mb / 1024).toFixed(1) + ' ГБ' : Math.round(mb) + ' МБ') + ' — не выдёргивайте флешку';
    bar.style.width = Math.min(70, ev.done * 2) + '%';
  }
  else if (ev.stage === 'wfail') { st.textContent = 'Запись остановилась на блоке ' + ev.at + ' (конец реального объёма). Проверяю…'; bar.style.width = '75%'; }
  else if (ev.stage === 'verify') { st.textContent = 'Читаю маркеры назад (' + ev.written + ' блоков)…'; bar.style.width = '80%'; }
  else if (ev.stage === 'verify-progress') { st.textContent = 'Проверено: ' + ev.done + ' / ' + ev.total; bar.style.width = (80 + 18 * ev.done / Math.max(1, ev.total)) + '%'; }
  else if (ev.stage === 'done') {
    $('#btn-usb-fake').disabled = false;
    $('#btn-usb-fake-cancel').classList.add('hidden');
    bar.style.width = '100%';
    const real = ev.realBytes || 0;
    const realTxt = real >= 1073741824 ? (real / 1073741824).toFixed(2) + ' ГБ' : Math.round(real / 1048576) + ' МБ';
    if (ev.canceled) { st.textContent = 'Проверка остановлена. Успешно проверено: ' + realTxt; return; }
    if (ev.wrappedAt >= 0 || ev.wfail != null) {
      st.innerHTML = '✗ ФЕЙКОВАЯ ПАМЯТЬ: реальный объём ≈ <b>' + realTxt + '</b>. Запись «завернулась» на блоке ' +
        (ev.wrappedAt >= 0 ? ev.wrappedAt : '(запись кончилась раньше)');
      usbLog('РЕЗУЛЬТАТ: реальный объём ≈ ' + realTxt + ' (маркеры совпали до блока ' + (ev.wrappedAt >= 0 ? ev.wrappedAt - 1 : ev.writtenBlocks - 1) + ')');
      usbLog('Что делать: сохраняйте на неё не больше ' + realTxt + '; честный объём можно задать утилитой производителя (SD Card Formatter / H2testw после подключения к ПК).');
      snack('Похоже на фейковую память: реальный объём ≈ ' + realTxt, 10000);
    } else {
      st.innerHTML = '✓ Память ЧЕСТНАЯ: все ' + ev.writtenBlocks + ' блоков прочитались верно (≥ ' + realTxt + ')';
      usbLog('РЕЗУЛЬТАТ: память честная, проверено ≥ ' + realTxt);
      snack('Память оригинальная (проверено ≥ ' + realTxt + ')', 8000);
    }
  }
  else if (ev.stage === 'error') { $('#btn-usb-fake').disabled = false; $('#btn-usb-fake-cancel').classList.add('hidden'); st.textContent = 'Ошибка: ' + (ev.error || ''); }
  else if (ev.stage === 'canceled') { st.textContent = 'Остановлено.'; }
}

/* свойства файла/папки (F6); + распаковка архивов, открытие текста/PDF/HTML,
   родная иконка и имя APK-файла с телефона, Android-бейдж на иконке */
async function openFsProps(it) {
  const s = currentSerial();
  if (!s) return snack('Нет устройства');
  const full = it.path || (fsDir.replace(/\/+$/, '') + '/' + it.name); // путь из категории тоже
  const isApk = !it.dir && APK_RE.test(it.name);
  const ic = window.FSICONS.iconFor(it.name, it.dir);
  // Android-бейдж в углу иконки для APK (требование владельца); обёртка идемпотентная
  const imgEl = $('#fsprop-icon');
  if (imgEl && !(imgEl.parentElement && imgEl.parentElement.classList.contains('fsprop-ico-wrap'))) {
    const wrap = document.createElement('span');
    wrap.className = 'fsprop-ico-wrap';
    imgEl.replaceWith(wrap);
    wrap.appendChild(imgEl);
  }
  const wrapEl = document.querySelector('#dlg-fsprop .fsprop-ico-wrap');
  if (wrapEl) {
    wrapEl.querySelectorAll('.android-badge').forEach(b => b.remove());
    if (isApk) {
      const b = document.createElement('img');
      b.className = 'android-badge';
      b.src = window.FSICONS.ANDROID_BADGE;
      b.setAttribute('data-tip', 'Приложение Android');
      wrapEl.appendChild(b);
    }
  }
  $('#fsprop-icon').src = ic.src;
  $('#fsprop-title').textContent = it.name;
  $('#fsprop-body').innerHTML = '<div class="muted">Читаю свойства…</div>';
  // кнопки действий: очищаем и наполняем по типу
  const foot = document.querySelector('#dlg-fsprop .dialog-foot');
  foot.querySelectorAll('[data-v27]').forEach(b => b.remove());
  const addBtn = (id, label, tip) => {
    const b = document.createElement('button');
    b.className = 'btn btn-tonal btn-sm'; b.id = id; b.textContent = label;
    b.setAttribute('data-v27', '1'); b.setAttribute('data-tip', tip || '');
    foot.insertBefore(b, foot.firstChild);
    return b;
  };
  const openBtns = [];
  if (!it.dir) {
    if (TXT_RE.test(it.name) || PDF_RE.test(it.name) || DOCX_RE.test(it.name) || VCF_RE.test(it.name)) openBtns.push(addBtn('btn-fsprop-open', DOCX_RE.test(it.name) ? 'Открыть документ' : VCF_RE.test(it.name) ? 'Открыть контакты' : TXT_RE.test(it.name) ? 'Открыть как текст' : 'Открыть PDF', 'Просмотр прямо в программе'));
    if (HTML_RE.test(it.name)) openBtns.push(addBtn('btn-fsprop-html', 'Открыть в браузере', 'Скачает и откроет в системном браузере — со всеми скриптами и CDN'));
    if (ARC_RE.test(it.name)) openBtns.push(addBtn('btn-fsprop-arcview', 'Открыть архив (не распаковывая)', 'Содержимое ZIP/JAR со списком файлов и точечным извлечением'));
    if (ARC_RE.test(it.name)) openBtns.push(addBtn('btn-fsprop-extract', 'Распаковать в папку', 'Распаковать архив в папку с именем архива, в эту же папку устройства'));
  }
  // Копировать/Вырезать/Переименовать/В архив — прямо из свойств (для всех)
  const actBtns = [];
  actBtns.push(addBtn('btn-fsprop-clipcopy', 'Копировать', 'Положить в буфер: вставьте в любой папке (панель «Вставить сюда»)'));
  actBtns.push(addBtn('btn-fsprop-clipcut', 'Вырезать', 'Переместить: вставьте в любой папке'));
  actBtns.push(addBtn('btn-fsprop-rename', 'Переименовать', 'Переименовать файл или папку'));
  actBtns.push(addBtn('btn-fsprop-tozip', 'В архив ZIP', 'Собрать ZIP (файлы/папки) в текущей папке'));
  openDlg('dlg-fsprop');
  const st = await window.api.fsStat(s, full);
  const isDir = it.dir || /directory/i.test(st.kind || '');
  const rows = [
    ['Тип', isDir ? 'Папка' : ('Файл · ' + ((it.name.match(/\.([a-z0-9]+)$/i) || ['', 'без расширения'])[1].toUpperCase()))],
    ['Полный путь', full],
    ['Размер', st.size != null && !isDir ? fmtBytesLong(st.size) + ' (' + st.size + ' Б)' : (it.size ? fmtBytesLong(it.size) : '—')],
    isDir && st.items != null ? ['Внутри объектов', String(st.items)] : null,
    isDir && st.duBytes ? ['Занято на диске', '≈ ' + fmtBytesLong(st.duBytes)] : null,
    ['Изменён', (st.mtime || it.date || '—').toString().trim()],
    ['Права доступа', st.perms || it.perms || '—'],
    ['Владелец', st.uid != null ? (st.uid + (st.gid ? ' / группа ' + st.gid : '')) : '—'],
    ['Ссылок', st.links || null],
    ['Устройство', nameOf(s)]
  ].filter(Boolean);
  $('#fsprop-body').innerHTML = rows.map(r => '<div class="prop-row"><b>' + esc(r[0]) + ':</b><span>' + esc(r[1] || '—') + '</span></div>').join('');
  // родная иконка/имя APK: тянем мету файла с телефона (кэшируется после первого раза)
  if (isApk) {
    const meta = await window.api.apkRemoteMeta(s, full).catch(() => null);
    if (meta && meta.ok && meta.dataUrl) {
      const img = $('#fsprop-icon'); if (img) img.src = meta.dataUrl;
      if (meta.label || meta.package) {
        $('#fsprop-body').insertAdjacentHTML('afterbegin',
          '<div class="prop-row"><b>Приложение:</b><span>' + esc(meta.label || '—') + (meta.package ? ' · <span class="mono">' + esc(meta.package) + '</span>' : '') + (meta.versionName ? ' · v' + esc(meta.versionName) : '') + '</span></div>');
      }
    } else if (meta && meta.reason === 'big') {
      $('#fsprop-body').insertAdjacentHTML('afterbegin', '<div class="prop-row"><b>Иконка приложения:</b><span>APK больше 80 МБ — для скорости не разбираю</span></div>');
    }
    // СРАВНЕНИЕ С УСТАНОВЛЕННОЙ ВЕРСИЕЙ + кнопка «Установить на телефон»
    if (meta && meta.ok && meta.package) {
      const inst = await window.api.apkInstalledInfo(s, meta.package).catch(() => null);
      const fileV = meta.versionName || null;
      if (inst && inst.installed) {
        const cmp = (() => {
          const a = String(inst.versionCode || ''), b = String(meta.versionCode || '');
          if (a && b && +a > +b) return 'УСТАНОВЛЕННАЯ НОВЕЕ файла';
          if (a && b && +a < +b) return 'файл НОВЕЕ установленной';
          if (String(inst.versionName || '') === String(fileV || '')) return 'версии совпадают';
          return 'версии различаются';
        })();
        $('#fsprop-body').insertAdjacentHTML('beforeend',
          '<div class="prop-row"><b>Установлено на телефоне:</b><span>v' + esc(inst.versionName || '?') + (inst.versionCode ? ' (код ' + esc(inst.versionCode) + ')' : '') + ' · ' + esc(cmp) + '</span></div>');
      } else {
        $('#fsprop-body').insertAdjacentHTML('beforeend',
          '<div class="prop-row"><b>Установлено на телефоне:</b><span>не установлено</span></div>');
      }
      if (/\.apk$/i.test(it.name)) {
        const ib = addBtn('btn-fsprop-phoneinstall', 'Установить на телефон', 'Установить этот APK прямо с памяти телефона (pm install -r) — без скачивания на ПК');
        ib.classList.add('btn-filled');
        ib.onclick = async () => {
          ib.disabled = true; ib.textContent = 'Устанавливаю…';
          const r = await window.api.apkPhoneInstall(s, full);
          ib.disabled = false; ib.textContent = 'Установить на телефон';
          if (r.ok) snack('Установлено: ' + (meta.label || it.name));
          else snack('Не удалось установить: ' + (r.message || r.error || 'ошибка'), 7000);
        };
      }
    }
  }
  for (const b of actBtns) {
    if (b.id === 'btn-fsprop-clipcopy') b.onclick = () => { fsClip = { paths: [full], cut: false }; showFsClipbar(); snack('Скопировано в буфер: ' + it.name); };
    if (b.id === 'btn-fsprop-clipcut') b.onclick = () => { fsClip = { paths: [full], cut: true }; showFsClipbar(); snack('Вырезано: ' + it.name); };
    if (b.id === 'btn-fsprop-rename') b.onclick = () => { closeDlg('dlg-fsprop'); fsRename(full, it.name); };
    if (b.id === 'btn-fsprop-tozip') b.onclick = () => { closeDlg('dlg-fsprop'); fsZipItems([full], it.name); };
  }
  for (const b of openBtns) {
    if (b.id === 'btn-fsprop-open') b.onclick = () => { closeDlg('dlg-fsprop'); openTextViewer(full); };
    if (b.id === 'btn-fsprop-html') b.onclick = () => { closeDlg('dlg-fsprop'); openHtmlOnPc(full, it.name); };
    if (b.id === 'btn-fsprop-arcview') b.onclick = () => { closeDlg('dlg-fsprop'); openArcViewer(full, it.name); };
    if (b.id === 'btn-fsprop-extract') b.onclick = async () => {
      b.disabled = true; b.textContent = 'Распаковываю…';
      const r = await window.api.fsExtract(s, full);
      b.disabled = false; b.textContent = 'Распаковать в папку';
      if (r.ok) {
        snack('Распаковано (' + (r.where || 'на устройстве') + '): ' + r.files + ' файлов → ' + r.dest);
        closeDlg('dlg-fsprop');
        fsNavigate(r.dest);
      } else snack(r.error || 'Не удалось распаковать');
    };
  }
  $('#btn-fsprop-folder').classList.toggle('hidden', !isDir);
  $('#btn-fsprop-folder').onclick = () => { closeDlg('dlg-fsprop'); if (isDir) fsNavigate(full); };
}

/* тома устройства: чипы над списком файлов.
   emulated/self больше НЕ дублируются («зачем две кнопки Внутренняя память?»);
   внешние тома (OTG-флешки XXXX-XXXX) — со значком USB и кнопками обмена */
const USB_ICON_SVG = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#4fc3f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="10" width="6" height="11" rx="1.5"/><path d="M10 10V6l2-3 2 3v4"/><rect x="10.6" y="3.4" width="1" height="1" fill="#4fc3f7" stroke="none"/><rect x="12.4" y="4.6" width="1" height="1" fill="#4fc3f7" stroke="none"/></svg>');
const SD_ICON_SVG = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#66bb6a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M9 7v3M11.5 6v4M14 7v3"/></svg>');
async function renderFsVolumes() {
  const s = currentSerial();
  if (!s) { $('#fs-volumes').innerHTML = ''; fsFlash = null; return; }
  const r = await window.api.fsVolumes(s);
  const box = $('#fs-volumes');
  const vols = (r.vols || []).filter(v => v !== 'emulated' && v !== 'self'); // дубль «Внутренней памяти» убран ()
  // показываем ВСЕ смонтированные тома (внутренняя, SD-карта, OTG), а не только FAT-UUID.
  const mounts = Array.isArray(r.mounts) ? r.mounts.slice() : [];
  // если main вернул только имена (старое поведение) — достраиваем из vols
  for (const v of vols) {
    const p = '/storage/' + v;
    if (!mounts.some(m => m.path === p)) mounts.push({ path: p, type: 'public', id: v });
  }
  const internal = mounts.find(m => /emulated/.test(m.path));
  const external = mounts.filter(m => !/emulated/.test(m.path));
  fsFlash = external.length ? external[0].path : null;
  const label = m => {
    const base = m.path.split('/').pop();
    if (/^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$/.test(base)) return 'Флешка ' + base;
    if (/emulated/.test(m.path)) return 'Внутренняя память';
    return 'SD-карта ' + base;
  };
  box.innerHTML = external.map(m =>
    `<button class="chip vol-chip" data-vol="${esc(m.path)}" data-tip="Открыть ${esc(label(m))}: ${esc(m.path)} (правая кнопка — меню)">
      <img src="${SD_ICON_SVG}" alt="">${esc(label(m))}</button>`
  ).join('') +
    (external.length ? '<button class="chip" id="btn-usb-tools" data-tip="Форматирование, метка тома, проверка ошибок, проверка на фейковую память">⚙ Инструменты флешки</button>' +
      '<span class="muted small" data-tip="Кнопки «На флешку»/«На телефон» появляются у файлов, когда флешка вставлена">обмен телефон ⟷ флешка включён</span>' : '') +
    (internal ? '' : '');
  box.querySelectorAll('[data-vol]').forEach(b => {
    const p = b.dataset.vol;
    const name = p.split('/').pop();
    b.onclick = () => fsNavigate(p);
    b.oncontextmenu = (e) => {
      e.preventDefault();
      openFsContextMenu(e.clientX, e.clientY, { name: label({ path: p }), dir: true }, {
        path: p,
        open: () => fsNavigate(p),
        props: () => openUsbTools(name),
        download: null,
        refresh: renderFsVolumes
      });
    };
  });
  const ut = document.getElementById('btn-usb-tools');
  if (ut) ut.onclick = () => openUsbTools(fsFlash ? fsFlash.split('/').pop() : external[0].id);
  renderFsSysVolumes(r);
}

/* системные разделы — отдельные чипы с честным статусом доступа */
function renderFsSysVolumes(r) {
  const box = document.getElementById('fs-sysvol');
  if (!box) return;
  const root = !!(r && r.root);
  const sys = [
    { p: '/', n: 'Корень /' },
    { p: '/system', n: 'Система /system' },
    { p: '/data', n: 'Данные /data' },
    { p: '/vendor', n: 'Vendor /vendor' }
  ];
  box.innerHTML = sys.map(v =>
    `<button class="chip sys-chip" data-sysvol="${esc(v.p)}" data-tip="${root ? 'Открыть ' : 'Без root содержимое может быть недоступно: '}${esc(v.p)}">${esc(v.n)}${root ? '' : ' 🔒'}</button>`
  ).join('') + (root
    ? '<span class="count-chip" data-tip="Устройство даёт root-доступ — системные разделы доступны на чтение">root ✓</span>'
    : '<span class="muted small">Системные разделы доступны только с root</span>');
  box.querySelectorAll('[data-sysvol]').forEach(b => b.onclick = () => fsNavigate(b.dataset.sysvol));
}

/* ---------- просмотрщик изображений (зум, пан, полный экран, листание) ---------- */
let iv = { list: [], idx: 0, scale: 1, tx: 0, ty: 0, rot: 0, natural: { w: 1, h: 1 }, loading: null };
function ivImageList() { return fsItems.filter(it => !it.dir && IMG_RE.test(it.name)); }
function ivApply() {
  const img = $('#imgview-img');
  img.style.transform = `translate(calc(-50% + ${iv.tx}px), calc(-50% + ${iv.ty}px)) rotate(${iv.rot}deg) scale(${iv.scale})`;
  $('#imgview-zoom').textContent = Math.round(iv.scale * 100) + '%';
}
function ivFit() {
  const st = $('#imgview-stage');
  const pad = 24;
  const k = Math.min((st.clientWidth - pad) / iv.natural.w, (st.clientHeight - pad) / iv.natural.h);
  iv.scale = Math.min(1, k) > 0 ? Math.min(1, k) : 1;
  if (k > 1) iv.scale = 1;
  iv.tx = 0; iv.ty = 0;
  ivApply();
}
function ivRotateFix() { // EXIF-поворот не нужен: adb отдаёт как есть; rot 90° сохраняем
  iv.rot = (iv.rot + 90) % 360;
  ivApply();
}
async function ivLoad(full) {
  const s = currentSerial(); if (!s) return;
  const img = $('#imgview-img'), msg = $('#imgview-msg');
  if (iv.loading) { try { iv.loading.xhr = true; } catch (e) {} }
  msg.classList.remove('hidden');
  msg.textContent = 'Загрузка…';
  $('#imgview-status').textContent = full;
  img.src = '';
  const token = { xhr: false };
  iv.loading = token;
  // картинки тоже показываем ПОТОКОМ с телефона — в кэш ПК файл не скачивается.
  // Если потоковый сервер недоступен, откатываемся на blob (как раньше).
  let url = null, bytes = 0;
  try {
    const su = await window.api.mediaUrl(s, full);
    if (su && su.ok) url = su.url;
  } catch (e) {}
  if (!url) {
    const r = await window.api.fsCat(s, full, 64);
    if (iv.loading !== token) return;
    if (!r.ok) { msg.textContent = r.error || 'Не удалось загрузить файл'; return; }
    bytes = r.bytes || 0;
    const blob = new Blob([r.buf], { type: /jpe?g$/i.test(full) ? 'image/jpeg' : /png$/i.test(full) ? 'image/png' : /gif$/i.test(full) ? 'image/gif' : /webp$/i.test(full) ? 'image/webp' : /bmp$/i.test(full) ? 'image/bmp' : 'image/png' });
    url = URL.createObjectURL(blob);
  }
  if (iv.loading !== token) return;
  img.onload = () => {
    iv.natural = { w: img.naturalWidth || 1, h: img.naturalHeight || 1 };
    msg.classList.add('hidden');
    ivFit();
    $('#imgview-status').textContent = full + ' · ' + iv.natural.w + '×' + iv.natural.h + (bytes ? ' · ' + fmtBytesLong(bytes) : ' · поток с телефона');
  };
  img.onerror = () => { msg.textContent = 'Формат не поддерживается встроенным просмотрщиком (например HEIC) — скачайте файл'; };
  img.src = url;
}
// плёнка-карусель внизу просмотрщика — карточки изображений папки, как в Windows.
// Клик по карточке = переход к этому фото; текущая подсвечена; миниатюры грузятся лениво.
let stripThumbs = new Map(); // путь → dataURL (кэш на открытие папки)
function ivStripCard(it, i) {
  const cur = i === iv.idx ? ' cur' : '';
  const p = fsDir.replace(/\/+$/, '') + '/' + it.name;
  const cached = stripThumbs.get(p);
  return `<div class="strip-card${cur}" data-strip="${i}" data-tip="${esc(it.name)}">
    ${cached ? '<img src="' + cached + '" alt="">' : '<div class="strip-ph">&#128444;</div>'}
    <span class="strip-name">${esc(it.name)}</span>
  </div>`;
}
function ivRenderStrip() {
  const strip = $('#imgview-strip');
  if (!iv.list.length) { strip.innerHTML = ''; return; }
  strip.innerHTML = iv.list.map((it, i) => ivStripCard(it, i)).join('');
  strip.querySelectorAll('[data-strip]').forEach(c => c.onclick = () => {
    const target = +c.dataset.strip;
    ivNav(target - iv.idx);
  });
  const cur = strip.querySelector('.strip-card.cur');
  if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
  // ленивые миниатюры: по 3 параллельно, только для карточек без кэша
  const jobs = iv.list.map((it, i) => ({ it, i, p: fsDir.replace(/\/+$/, '') + '/' + it.name }))
    .filter(j => !stripThumbs.has(j.p)).slice(0, 60);
  let run = 0; let idx = 0;
  const next = () => {
    while (run < 3 && idx < jobs.length) {
      const j = jobs[idx++];
      run++;
      window.api.fsCat(currentSerial(), j.p, 12).then(r => {
        if (r.ok && r.buf && r.buf.length) {
          const blob = new Blob([r.buf], { type: /jpe?g$/i.test(j.p) ? 'image/jpeg' : 'image/png' });
          stripThumbs.set(j.p, URL.createObjectURL(blob));
        }
      }).catch(() => {}).finally(() => { run--; next(); if (run === 0) ivRenderStrip(); });
    }
  };
  next();
}
async function openImgViewer(full) {
  iv.list = ivImageList();
  const name = full.split('/').pop();
  iv.idx = Math.max(0, iv.list.findIndex(x => x.name === name));
  $('#imgview-title').textContent = name;
  $('#imgview-pos').textContent = iv.list.length ? (iv.idx + 1) + '/' + iv.list.length : '';
  iv.scale = 1; iv.tx = 0; iv.ty = 0; iv.rot = 0; ivApply();
  openDlg('dlg-imgview');
  ivLoad(full);
  ivRenderStrip();
}
function ivNav(d) {
  if (!iv.list.length) return;
  iv.idx = (iv.idx + d + iv.list.length) % iv.list.length;
  const it = iv.list[iv.idx];
  const full = fsDir.replace(/\/+$/, '') + '/' + it.name;
  $('#imgview-title').textContent = it.name;
  $('#imgview-pos').textContent = (iv.idx + 1) + '/' + iv.list.length;
  iv.scale = 1; iv.tx = 0; iv.ty = 0; iv.rot = 0; ivApply();
  ivLoad(full);
  ivRenderStrip();
}
// второй полноэкранный режим — реальный фулскрин монитора через Fullscreen API
function toggleMonitorFullscreen(el) {
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    }
  } catch (e) { snack('Полноэкранный режим не поддержался: ' + (e.message || e)); }
}
(function ivEvents() {
  const stage = $('#imgview-stage');
  let drag = null;
  stage.addEventListener('mousedown', e => { drag = { x: e.clientX, y: e.clientY, tx: iv.tx, ty: iv.ty }; e.preventDefault(); });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    iv.tx = drag.tx + (e.clientX - drag.x);
    iv.ty = drag.ty + (e.clientY - drag.y);
    ivApply();
  });
  window.addEventListener('mouseup', () => { drag = null; });
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    iv.scale = Math.min(12, Math.max(0.05, iv.scale * k));
    ivApply();
  }, { passive: false });
  stage.addEventListener('dblclick', () => { iv.scale > 1.02 ? ivFit() : (iv.scale = 1, iv.tx = 0, iv.ty = 0, ivApply()); });
  $('#imgview-zin').onclick = () => { iv.scale = Math.min(12, iv.scale * 1.25); ivApply(); };
  $('#imgview-zout').onclick = () => { iv.scale = Math.max(0.05, iv.scale / 1.25); ivApply(); };
  $('#imgview-fit').onclick = ivFit;
  $('#imgview-100').onclick = () => { iv.scale = 1; iv.tx = 0; iv.ty = 0; ivApply(); };
  $('#imgview-rot').onclick = ivRotateFix;
  $('#imgview-prev').onclick = () => ivNav(-1);
  $('#imgview-next').onclick = () => ivNav(1);
  $('#imgview-full').onclick = () => $('#imgview-shell').classList.toggle('imgview-full');
  $('#imgview-fullmon').onclick = () => toggleMonitorFullscreen($('#imgview-shell'));
})();

/* ================= просмотр текстовых файлов (все форматы) и PDF =================
   + КОПИРОВАНИЕ, РЕДАКТИРОВАНИЕ с записью обратно на телефон (utf-8/windows-1251
   сохраняется) и ПРЕВЬЮ HTML-файлов как страницы (iframe с локальной временной копии) */
const tv = { full: null, isPdf: false, pdfDoc: null, pdfPage: 1, pdfLibLoading: false,
             text: '', buf: null, encoding: 'utf-8', editing: false, isHtml: false, previewing: false,
             isDocx: false, isVcf: false };
function bytesToB64(u8) {
  let s = '', CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
// windows-1251 → байты (для файлов, открытых в 1251): А-Я/а-я → 0xC0..0xFF, Ё→0xA8, ё→0xB8
function encode1251(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) out[i] = c;
    else if (c >= 0x410 && c <= 0x44F) out[i] = c - 0x410 + 0xC0;
    else if (c === 0x401) out[i] = 0xA8;
    else if (c === 0x451) out[i] = 0xB8;
    else if (c === 0x2116) out[i] = 0xB9;      // №
    else out[i] = 0x3F;                        // ? — символа нет в 1251
  }
  return out;
}
function tvButtons() {
  $('#textview-copy').classList.toggle('hidden', tv.isPdf || tv.isDocx || tv.isVcf);
  $('#textview-edit').classList.toggle('hidden', tv.isPdf || !tv.text || tv.isDocx || tv.isVcf);
  $('#textview-save').classList.add('hidden');
  $('#textview-preview').classList.toggle('hidden', !tv.isHtml);
  $('#textview-code').classList.add('hidden');
}
// показать СФОРМИРОВАННЫЙ HTML (DOCX/контакты VCF) во встроенном фрейме
function tvShowHtml(html, statusText) {
  const frame = $('#textview-frame'), pre = $('#textview-pre');
  const doc = '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><style>' +
    'body{font-family:Segoe UI,Roboto,sans-serif;max-width:760px;margin:0 auto;padding:22px 26px;color:#1c2430;background:#fff;line-height:1.55}' +
    'h1{font-size:22px;margin:2px 0 10px}h2,h3{margin:16px 0 6px}p{margin:8px 0}' +
    '.docx-tbl{border-collapse:collapse;margin:10px 0}.docx-tbl td,.docx-tbl th{border:1px solid #c9d2dc;padding:5px 9px;font-size:14px}' +
    '.docx-li{margin:4px 0 4px 10px}' +
    '.vcf-card{border:1px solid #d7dee6;border-radius:12px;padding:12px 16px;margin:10px 0;background:#f7f9fb}' +
    '.vcf-name{font-size:17px;font-weight:700;margin-bottom:4px}' +
    '.vcf-row{margin:2px 0;font-size:14px;color:#2a3644}.vcf-row b{color:#5a6a7c;font-weight:600;margin-right:6px}' +
    '.vcf-row a{color:#0a66d0;text-decoration:none}' +
    '</style></head><body>' + html + '</body></html>';
  frame.srcdoc = doc;
  frame.classList.remove('hidden');
  pre.classList.add('hidden');
  $('#textview-status').textContent = statusText;
}
// парсер vCard (.vcf) — карточки контактов: имя, телефоны, email, организация и др.
function vcfToHtml(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  // разворачиваем свернутые строки (продолжение с пробела в начале)
  const unfolded = [];
  for (const l of lines) {
    if (/^[ \t]/.test(l) && unfolded.length) unfolded[unfolded.length - 1] += l.slice(1);
    else unfolded.push(l);
  }
  const escH = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const unesc = (s) => String(s || '').replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
  const cards = [];
  let cur = null;
  for (const l of unfolded) {
    const t = l.trim();
    if (/^BEGIN:VCARD/i.test(t)) { cur = { name: '', rows: [] }; continue; }
    if (/^END:VCARD/i.test(t)) { if (cur) cards.push(cur); cur = null; continue; }
    if (!cur) continue;
    const m = t.match(/^([^:;]+)((?:;[^:]*)?):(.*)$/);
    if (!m) continue;
    const key = m[1].toUpperCase().split(';')[0];
    const params = m[2] || '';
    let val = unesc(m[3]);
    if (!val.trim()) continue;
    if (key === 'FN') cur.name = val;
    else if (key === 'N') {
      const parts = val.split(/[;,]/).map(x => x.trim()).filter(Boolean);
      if (!cur.name && parts.length) cur.name = parts.slice(0, 2).reverse().join(' ');
    }
    else if (key === 'TEL') { const t2 = (params.match(/TYPE=([^;:]+)/i) || [])[1]; cur.rows.push(['Телефон' + (t2 ? ' (' + t2.toLowerCase() + ')' : ''), '<a href="tel:' + escH(val.replace(/[^\d+]/g, '')) + '">' + escH(val) + '</a>']); }
    else if (key === 'EMAIL') cur.rows.push(['Email', '<a href="mailto:' + escH(val) + '">' + escH(val) + '</a>']);
    else if (key === 'ORG') cur.rows.push(['Организация', escH(val.replace(/;/g, ' · '))]);
    else if (key === 'TITLE') cur.rows.push(['Должность', escH(val)]);
    else if (key === 'ADR') cur.rows.push(['Адрес', escH(val.replace(/;/g, ', ').replace(/,+$/, ''))]);
    else if (key === 'NOTE') cur.rows.push(['Заметка', escH(val)]);
    else if (key === 'BDAY') cur.rows.push(['День рождения', escH(val)]);
    else if (key === 'URL') cur.rows.push(['Сайт', '<a href="' + escH(val) + '" target="_blank">' + escH(val) + '</a>']);
    else if (key === 'IMPP' || key === 'X-...' || key === 'NICKNAME') cur.rows.push([key === 'NICKNAME' ? 'Ник' : 'Мессенджер', escH(val.replace(/^.*:/, ''))]);
  }
  if (!cards.length) return null;
  return '<h1>Контакты: ' + cards.length + '</h1>' + cards.map(c =>
    '<div class="vcf-card"><div class="vcf-name">' + escH(c.name || '(без имени)') + '</div>' +
    c.rows.map(r => '<div class="vcf-row"><b>' + r[0] + ':</b> ' + r[1] + '</div>').join('') +
    '</div>').join('');
}
async function openTextViewer(full) {
  const s = currentSerial(); if (!s) return;
  tv.full = full;
  tv.isPdf = PDF_RE.test(full);
  tv.isHtml = HTML_RE.test(full);
  tv.isDocx = DOCX_RE.test(full);   // 
  tv.isVcf = VCF_RE.test(full);     // 
  tv.editing = false; tv.previewing = false; tv.text = ''; tv.buf = null; tv.encoding = 'utf-8';
  const name = full.split('/').pop();
  $('#textview-title').textContent = name;
  $('#textview-status').textContent = full;
  $('#textview-pos').textContent = '';
  $('#textview-pre').classList.remove('hidden');
  const frame = $('#textview-frame');
  frame.classList.add('hidden');
  try { frame.srcdoc = ''; } catch (e) {}
  try { frame.src = 'about:blank'; } catch (e) {}
  $('#textview-pre').contentEditable = 'false';
  $('#pdfview-box').classList.toggle('hidden', !tv.isPdf);
  tvButtons();
  openDlg('dlg-textview');
  if (tv.isPdf) return loadPdf(full);
  // DOCX — тянем файл целиком, конвертируем в HTML на ПК (word/document.xml), показываем во фрейме
  if (tv.isDocx) {
    const pre0 = $('#textview-pre');
    pre0.textContent = 'Читаю документ…';
    const d = await window.api.fsDocx(s, full).catch(() => null);
    if (d && d.ok) { tvShowHtml(d.html, full + ' · документ DOCX'); }
    else {
      pre0.textContent = '';
      $('#textview-status').textContent = (d && d.error) || 'Не удалось прочитать DOCX';
      snack((d && d.error) || 'Не удалось прочитать DOCX — попробуйте «Скачать» или «На ПК»', 6000);
    }
    return;
  }
  const pre = $('#textview-pre');
  pre.textContent = 'Загрузка…';
  const r = await window.api.fsCat(s, full, 8);
  if (!r.ok) {
    pre.textContent = '';
    $('#textview-status').textContent = r.error || 'Не удалось загрузить файл';
    if (r.capped) snack('Файл больше 8 МБ — показывать целиком не буду. Кнопка «Скачать» внизу работает.');
    return;
  }
  tv.buf = new Uint8Array(r.buf);
  // декодирование: UTF-8, при сбое — windows-1251 (файлы с русским текстом в 866/1251)
  try { tv.text = new TextDecoder('utf-8', { fatal: true }).decode(tv.buf); tv.encoding = 'utf-8'; }
  catch (e) { try { tv.text = new TextDecoder('windows-1251').decode(tv.buf); tv.encoding = 'windows-1251'; } catch (e2) { tv.text = tv.buf.toString('latin1'); tv.encoding = 'latin1'; } }
  // VCF — карточки контактов во фрейме (и «чистый текст» доступен по кнопке «Код»-стиля нет — vcf простой текст)
  if (tv.isVcf) {
    const html = vcfToHtml(tv.text);
    if (html) { tvShowHtml(html, full + ' · контакты vCard'); return; }
    // не распарсился — покажем как обычный текст ниже
  }
  const shown = tv.text.length > 400000 ? tv.text.slice(0, 400000) : tv.text;
  $('#textview-pos').textContent = tv.text.length > 400000 ? '(показаны первые 400 000 символов)' : '';
  pre.textContent = shown;
  $('#textview-status').textContent = full + ' · ' + fmtBytesLong(r.bytes || 0) + (tv.encoding !== 'utf-8' ? ' · кодировка ' + tv.encoding : '');
  tvButtons();
}
async function tvSaveBack() {
  if (!tv.full || !tv.editing) return;
  const s = currentSerial(); if (!s) return;
  const pre = $('#textview-pre');
  const clean = (pre.innerText || '').replace(/\u00A0/g, ' ');
  const bytes = tv.encoding === 'windows-1251' ? encode1251(clean) : new TextEncoder().encode(clean);
  const btn = $('#textview-save');
  btn.disabled = true; btn.textContent = 'Сохраняю…';
  const r = await window.api.fsSaveText(s, tv.full, bytesToB64(bytes));
  btn.disabled = false; btn.textContent = 'Сохранить на телефон';
  if (r.ok) {
    tv.text = clean;
    tv.editing = false;
    pre.contentEditable = 'false';
    pre.textContent = clean.length > 400000 ? clean.slice(0, 400000) : clean;
    $('#textview-save').classList.add('hidden');
    $('#textview-edit').classList.remove('hidden');
    $('#textview-status').textContent = tv.full + ' · сохранено на телефон ✓';
    snack('Сохранено на телефон: ' + tv.full.split('/').pop());
  } else {
    snack('Не удалось сохранить: ' + (r.error || 'ошибка'));
  }
}
async function tvPreview() {
  if (!tv.isHtml || !tv.buf) return;
  // file://-iframe в sandboxed-renderer НЕ рендерит страницу (ограничение Chromium).
  // Читаем байты из памяти и показываем через srcdoc — HTML и его inline-скрипты работают.
  const text = new TextDecoder('utf-8').decode(tv.buf);
  const frame = $('#textview-frame');
  frame.srcdoc = text;
  frame.classList.remove('hidden');
  $('#textview-pre').classList.add('hidden');
  $('#textview-preview').classList.add('hidden');
  $('#textview-code').classList.remove('hidden');
  tv.previewing = true;
  $('#textview-status').textContent = 'Превью страницы — скрипты и стили из самого файла работают; внешние ссылки (CDN) доступны только в браузере';
}
$('#textview-code').onclick = () => {
  $('#textview-frame').classList.add('hidden');
  $('#textview-pre').classList.remove('hidden');
  $('#textview-code').classList.add('hidden');
  $('#textview-preview').classList.remove('hidden');
  tv.previewing = false;
};
$('#textview-preview').onclick = tvPreview;
$('#textview-copy').onclick = () => { if (tv.text) copyText(tv.text.slice(0, 400000)); };
$('#textview-edit').onclick = () => {
  const pre = $('#textview-pre');
  if (tv.previewing) $('#textview-code').click();
  tv.editing = true;
  pre.contentEditable = 'true';
  pre.focus();
  $('#textview-edit').classList.add('hidden');
  $('#textview-save').classList.remove('hidden');
  $('#textview-status').textContent = 'Режим редактирования — измените текст и нажмите «Сохранить на телефон»';
};
$('#textview-save').onclick = tvSaveBack;
async function loadPdf(full) {
  const s = currentSerial(); if (!s) return;
  $('#pdfview-page').textContent = 'загрузка…';
  if (!window.pdfjsLib) {
    if (tv.pdfLibLoading) return;
    tv.pdfLibLoading = true;
    try {
      await new Promise((res, rej) => {
        const sc = document.createElement('script');
        sc.src = 'lib/pdf.min.js'; sc.onload = res; sc.onerror = () => rej(new Error('не удалось загрузить pdf.js'));
        document.head.appendChild(sc);
      });
      if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
      }
    } catch (e) {
      tv.pdfLibLoading = false;
      $('#pdfview-page').textContent = 'pdf.js не загрузился — нажмите «Открыть на ПК»';
      return;
    }
    tv.pdfLibLoading = false;
  }
  try {
    const r = await window.api.fsCat(s, full, 128);
    if (!r.ok) { $('#pdfview-page').textContent = r.error || 'не удалось загрузить'; return; }
    tv.pdfDoc = await window.pdfjsLib.getDocument({ data: r.buf }).promise;
    tv.pdfPage = 1;
    renderPdfPage();
  } catch (e) {
    $('#pdfview-page').textContent = 'Не удалось открыть PDF: ' + (e.message || e).slice(0, 80);
  }
}
async function renderPdfPage() {
  if (!tv.pdfDoc) return;
  const page = await tv.pdfDoc.getPage(Math.min(tv.pdfPage, tv.pdfDoc.numPages));
  const box = $('#pdfview-box');
  const scale = Math.min(1.6, (box.clientWidth - 40) / page.getViewport({ scale: 1 }).width);
  const vp = page.getViewport({ scale: Math.max(0.4, scale) });
  const cv = $('#pdfview-canvas');
  cv.width = vp.width; cv.height = vp.height;
  await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  $('#pdfview-page').textContent = tv.pdfPage + ' / ' + tv.pdfDoc.numPages;
}
$('#pdfview-prev').onclick = async () => { if (tv.pdfDoc && tv.pdfPage > 1) { tv.pdfPage--; await renderPdfPage(); } };
$('#pdfview-next').onclick = async () => { if (tv.pdfDoc && tv.pdfPage < tv.pdfDoc.numPages) { tv.pdfPage++; await renderPdfPage(); } };
$('#textview-wrap').onclick = () => $('#textview-pre').classList.toggle('wrap');
$('#textview-dl').onclick = async () => {
  if (!tv.full) return;
  const res = await window.api.fsPull(currentSerial(), tv.full);
  if (res.ok) snack('Сохранено: ' + res.file);
};
$('#textview-openpc').onclick = async () => {
  if (!tv.full) return;
  snack('Скачиваю и открываю системной программой…');
  const r = await window.api.fsOpenOnPc(currentSerial(), tv.full);
  snack(r.ok ? 'Открыто на компьютере' : (r.error || 'Не удалось'));
};
// HTML-файлы с телефона открываются в СИСТЕМНОМ браузере — там работают и CDN-скрипты
// (триjs-анимации владельца), и весь JS. Встроенный iframe был бы зажат CSP и без сети.
async function openHtmlOnPc(full, name) {
  const s = currentSerial(); if (!s) return;
  const yes = await uiConfirm('Открыть HTML в браузере', '«' + name + '» будет скачан во временную папку и открыт в системном браузере — так работают все скрипты, стили и CDN. Открыть?');
  if (!yes || !yes.ok) return;
  snack('Скачиваю и открываю в браузере…');
  const r = await window.api.fsOpenOnPc(s, full);
  snack(r.ok ? 'Открыто в системном браузере: ' + name : (r.error || 'Не удалось'));
}

/* ---------- →медиаплеер (видео+аудио), эквалайзер, 10 визуализаций ----------
   визуализации из window.VISLIB (в т.ч. по мотивам анимаций владельца), с номерами
   и названиями, листаются стрелками ◀ ▶, выбор запоминается между запусками; анимация живёт
   ВСЕГДА, пока открыт плеер, а при воспроизведении реагирует на звук через анализатор. */
const mp = {
  list: [], idx: 0, isVideo: false,
  ctx: null, src: null, analyser: null, filters: [], out: null,
  visIdx: 0, raf: 0, loadedUrl: null, wantPlay: true, loadSeq: 0,
  // ПРЯМОЕ воспроизведение по умолчанию (элемент el2 мимо WebAudio) — корень жалоб
  // «чёрный экран / запускаю и ничего»: граф WebAudio (createMediaElementSource) на части
  // машин молчит или подвешивает элемент. Эквалайзер теперь ВКЛЮЧАЕТСЯ КНОПКОЙ — тогда
  // звук идёт через аудио-движок; всё остальное время играет напрямую, всегда надёжно.
eqOn: false, silT: 0, vol: 5, detached: false
};
const MEDIA_VOL_DEFAULT = 5;
try { mp.vol = mediaVolLoad(); } catch (e) {}
try { mp.visIdx = Math.min(window.VISLIB.length - 1, Math.max(0, parseInt(localStorage.getItem('media.vis') || '0', 10) || 0)); } catch (e) {}
try { mp.eqOn = localStorage.getItem('media.eq') === '1'; } catch (e) {}
const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  'Плоско': [0,0,0,0,0,0,0,0,0,0],
  'Басы': [7,6,4,2,0,0,0,0,0,0],
  'Вокал': [-2,-1,0,2,4,4,3,1,0,-1],
  'Рок': [5,4,2,-1,-2,1,3,4,4,3],
  'Поп': [-1,2,4,4,2,0,-1,-1,1,2],
  'Джаз': [3,2,1,2,-1,-1,0,1,3,4],
  'Классика': [4,3,2,0,-1,-1,0,2,3,4],
  'Электро': [6,5,1,0,-2,2,1,2,5,6]
};
function mediaList() { return fsItems.filter(it => !it.dir && (VID_RE.test(it.name) || AUD_RE.test(it.name))); }
function mpFmtTime(t) {
  if (!isFinite(t)) return '0:00';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}
/* громкость плеера запоминается между сессиями (localStorage) — раньше после
   закрытия плеера возвращалась максимальная */
function mediaVolLoad() { return MEDIA_VOL_DEFAULT; }
function mediaVolSet(v, save) {
  const val = Math.min(100, Math.max(0, Math.round(v)));
  mp.vol = val;
  if (typeof rm !== 'undefined' && rm) rm.vol = val;
  const ms = $('#media-vol'); if (ms) ms.value = val;
  const rs = $('#rm-vol'); if (rs) rs.value = val;
  const ml = $('#yt-vol-lbl'); if (ml) ml.textContent = val + '%';
  const rl = $('#rm-vol-lbl'); if (rl) rl.textContent = val + '%';
  for (const el of [$('#media-el'), $('#media-el2')]) {
    if (el) { try { el.volume = val / 100; } catch (e) {} }
  }
  if (typeof rm !== 'undefined' && rm && rm.el) { try { rm.el.volume = val / 100; } catch (e) {} }
  if (save !== false) { try { localStorage.setItem('media.vol', String(val)); } catch (e) {} }
}
function mpVolSet(v, save) { mediaVolSet(v, save); }
function curMediaEl() { return mp.eqOn ? $('#media-el') : $('#media-el2'); }
/* полная остановка плеера (крестик / закрытие диалога) — останавливает и музыку, и видео */
function mpStop() {
  clearTimeout(mp.silT);
  mp.wantPlay = false;
  try { $('#media-el').pause(); } catch (e) {}
  try { $('#media-el2').pause(); } catch (e) {}
  try { $('#media-el').removeAttribute('src'); $('#media-el').load(); } catch (e) {}
  try { $('#media-el2').removeAttribute('src'); $('#media-el2').load(); } catch (e) {}
  if (mp.loadedUrl) { try { URL.revokeObjectURL(mp.loadedUrl); } catch (e) {} mp.loadedUrl = null; }
  mp.lastFull = null;
  if (mp.ctx && mp.ctx.state !== 'closed') { try { mp.ctx.close(); } catch (e) {} mp.ctx = null; mp.analyser = null; mp.src = null; mp.out = null; mp.filters = []; }
  if (mpDirectCtx && mpDirectCtx.state !== 'closed') { try { mpDirectCtx.close(); } catch (e) {} mpDirectCtx = null; mp.analyser2 = null; }
}
function mpResumeCtx() {
  if (mp.eqOn && mp.ctx && mp.ctx.state === 'suspended') { try { mp.ctx.resume(); } catch (e) {} }
  if (!mp.eqOn && mpDirectCtx && mpDirectCtx.state === 'suspended') { try { mpDirectCtx.resume(); } catch (e) {} }
}
/* автоскрытие панели в полноэкранном режиме; в обычном окне панель всегда видна */
let mpBarT = 0;
function mpShowBar(force) {
  const bar = $('#media-ytbar'); if (!bar) return;
  const dlg = $('#dlg-media .media-dlg');
  const isFs = dlg.classList.contains('media-full') || document.fullscreenElement || document.webkitFullscreenElement;
  bar.classList.remove('yt-hidden');
  clearTimeout(mpBarT);
  if (isFs && !force) mpBarT = setTimeout(() => bar.classList.add('yt-hidden'), 2600);
}
function mpHideBarSoon() {
  const bar = $('#media-ytbar'); if (!bar) return;
  const dlg = $('#dlg-media .media-dlg');
  const isFs = dlg.classList.contains('media-full') || document.fullscreenElement || document.webkitFullscreenElement;
  if (!isFs) { bar.classList.remove('yt-hidden'); return; }
  clearTimeout(mpBarT); mpBarT = setTimeout(() => bar.classList.add('yt-hidden'), 2600);
}
function mpEnsureAudio() {
  if (mp.ctx) return;
  const el = $('#media-el');
  mp.ctx = new (window.AudioContext || window.webkitAudioContext)();
  mp.src = mp.ctx.createMediaElementSource(el);
  mp.filters = EQ_FREQS.map((f, i) => {
    const b = mp.ctx.createBiquadFilter();
    b.type = i === 0 ? 'lowshelf' : (i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking');
    b.frequency.value = f; b.Q.value = 1.0; b.gain.value = 0;
    return b;
  });
  mp.analyser = mp.ctx.createAnalyser();
  mp.analyser.fftSize = 512;
  mp.analyser.smoothingTimeConstant = 0.82;
  mp.out = mp.ctx.createGain();
  let prev = mp.src;
  for (const f of mp.filters) { prev.connect(f); prev = f; }
  prev.connect(mp.analyser); mp.analyser.connect(mp.out); mp.out.connect(mp.ctx.destination);
}
/* анализатор для ПРЯМОГО воспроизведения (визуализации реагируют на звук даже без
   эквалайзера). el2.captureStream() НЕ крадёт звук у элемента — он играет как раньше,
   а мы лишь подслушиваем поток через MediaStreamAudioSourceNode (без destination) */
let mpDirectCtx = null;
function mpEnsureDirectAnalyser() {
  const el2 = $('#media-el2');
  if (mp.analyser2 || !el2 || !el2.captureStream) return;
  try {
    const st = el2.captureStream();
    if (!st || !st.getAudioTracks().length) return;
    mpDirectCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (mpDirectCtx.state === 'suspended') { try { mpDirectCtx.resume(); } catch (e) {} }
    mp.analyser2 = mpDirectCtx.createAnalyser();
    mp.analyser2.fftSize = 512;
    mp.analyser2.smoothingTimeConstant = 0.82;
    const srcNode = mpDirectCtx.createMediaStreamSource(st);
    srcNode.connect(mp.analyser2);
  } catch (e) { mp.analyser2 = null; }
}
function mpApplyEq(gains) {
  if (!mp.filters.length) return;
  mp.filters.forEach((b, i) => { b.gain.value = gains[i] || 0; const sl = document.querySelector('#eq-bands [data-band="' + i + '"]'); if (sl) { sl.value = gains[i] || 0; const v = sl.parentElement.querySelector('.eq-val'); if (v) v.textContent = (gains[i] > 0 ? '+' : '') + (gains[i] || 0) + ' дБ'; } });
}
function mpBuildEq() {
  const box = $('#eq-bands');
  box.innerHTML = EQ_FREQS.map((f, i) => `<div class="eq-band">
      <span class="eq-val">0 дБ</span>
      <input type="range" min="-12" max="12" step="1" value="0" data-band="${i}" data-tip="Полоса ${f >= 1000 ? (f/1000) + ' кГц' : f + ' Гц'}">
      <span class="eq-freq">${f >= 1000 ? (f / 1000) + 'k' : f}</span>
    </div>`).join('');
  box.querySelectorAll('input[type=range]').forEach(sl => sl.oninput = () => {
    if (mp.filters[+sl.dataset.band]) mp.filters[+sl.dataset.band].gain.value = +sl.value;
    const v = sl.parentElement.querySelector('.eq-val');
    if (v) v.textContent = (+sl.value > 0 ? '+' : '') + sl.value + ' дБ';
  });
  $('#eq-presets').innerHTML = Object.keys(EQ_PRESETS).map(p => `<button class="chip" data-eqp="${esc(p)}" style="padding:4px 10px;font-size:12px">${esc(p)}</button>`).join('');
  $('#eq-presets').querySelectorAll('[data-eqp]').forEach(b => b.onclick = () => mpApplyEq(EQ_PRESETS[b.dataset.eqp]));
}
function mpVisLabel() {
  const name = (window.VISLIB[mp.visIdx] || {}).name || '';
  const label = (mp.visIdx + 1) + '. ' + name;
  const el = $('#media-vis-name'); if (el) el.textContent = label;
  [['#media-vis-prev', 'Предыдущая визуализация'], ['#media-vis-next', 'Следующая визуализация'],
   ['#rm-vis-prev', 'Предыдущая визуализация'], ['#rm-vis-next', 'Следующая визуализация']]
    .forEach(([sel, prefix]) => { const b = $(sel); if (b) b.dataset.tip = prefix + (name ? ': ' + name : ''); });
}
function mpVisNav(d) {
  mp.visIdx = (mp.visIdx + d + window.VISLIB.length) % window.VISLIB.length;
  try { localStorage.setItem('media.vis', String(mp.visIdx)); } catch (e) {}
  mpVisLabel();
  snd.play('click');
}
function mpVisAudioData() {
  const a = { bass: 0, mid: 0, treble: 0, energy: 0, spectrum: [], wave: [] };
  const an = mp.eqOn ? mp.analyser : mp.analyser2;
  if (!an) return a;
  try {
    const n = an.frequencyBinCount;
    const fd = new Uint8Array(n), td = new Uint8Array(n);
    an.getByteFrequencyData(fd);
    an.getByteTimeDomainData(td);
    let sum = 0, wsum = 0;
    for (let i = 0; i < n; i++) { sum += fd[i]; wsum += Math.abs(td[i] - 128); }
    if (!sum && !wsum) return a;
    a.spectrum = fd; a.wave = td;
    let b = 0, m = 0, tr = 0;
    for (let i = 0; i < 8 && i < n; i++) b += fd[i];
    for (let i = 8; i < 60 && i < n; i++) m += fd[i];
    for (let i = 60; i < Math.min(n, 200); i++) tr += fd[i];
    a.bass = b / (8 * 255);
    a.mid = m / (52 * 255);
    a.treble = tr / (Math.max(1, Math.min(n, 200) - 60) * 255);
    a.energy = a.bass * 0.5 + a.mid * 0.35 + a.treble * 0.15;
  } catch (e) {}
  return a;
}
function mpDraw() {
  if ($('#dlg-media').classList.contains('hidden')) { mp.raf = 0; return; }
  mp.raf = requestAnimationFrame(mpDraw);
  const cv = $('#media-vis'), ctx = cv.getContext('2d');
  // битмап канваса = фактический размер на экране (DPR до 1.5) — раньше канвас был
  // жёстко 960×320 и «растягивался» неровно в полном экране; теперь анимация заполняет
  // окно/экран ровно при любом размере
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const cw = Math.max(64, Math.round(cv.clientWidth * dpr));
  const ch = Math.max(48, Math.round(cv.clientHeight * dpr));
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
  const W = cv.width, H = cv.height;
  // данные анализатора → амплитуды; если анализатор молчит, VISLIB
  // получает пустые spectrum/wave и рисует time-based анимацию.
  const a = mpVisAudioData();
  const vis = window.VISLIB[mp.visIdx];
  // время для визуализации идёт, только пока реально играет звук.
  // Раньше анимации «жили» сами по себе (sin(t)) и двигались даже в тишине.
  const elNow = curMediaEl();
  const playing = !!(elNow && !elNow.paused && !elNow.ended && elNow.readyState >= 2);
  mp.visT = (mp.visT || 0) + (playing ? 0.016 : 0) + (playing ? a.energy * 0.02 : 0);
  if (vis) {
    const t = playing ? mp.visT : (mp.visT || 0);
    try { vis.draw(ctx, W, H, t, playing ? a : { bass: 0, mid: 0, treble: 0, energy: 0, spectrum: [], wave: [] }); } catch (e) {}
  }
}
async function mpLoad(full) {
  const seq = (mp.loadSeq = (mp.loadSeq || 0) + 1);
  const s = currentSerial(); if (!s) return;
  const el = $('#media-el'), el2 = $('#media-el2');
  const name = full.split('/').pop();
  try { el.pause(); el2.pause(); } catch (e) {}
  if (rm.el && !rm.el.paused) { try { rm.el.pause(); } catch (e) {} rm.playing = false; }
  mp.isVideo = VID_RE.test(name);
  if (mp.isVideo) {
    // Мини-плеер — только для музыки. Видео не должно оставлять в нём
    // название, статус «играет» и живую анимацию.
    rm.full = null; rm.name = ''; rm.playing = false;
    rm.list = []; rm.idx = -1;
  } else {
    rm.full = full; rm.name = name;
  }
  rm.el = null; rm.boundEl = null; rmRender();
  if (mp.isVideo) {
    const rv = $('#rm-vis');
    if (rv) { try { rv.getContext('2d').clearRect(0, 0, rv.width, rv.height); } catch (e) {} }
  }
  $('#media-title').textContent = name;
  $('#media-now-name').textContent = name;
  $('#media-now-sub').textContent = 'Загрузка с устройства…';
  $('#media-status').textContent = full;
  const visual = $('#media-visual');
  visual.classList.toggle('hidden-when-video', mp.isVideo);
  // сообщаем CSS-классу сцены, что сейчас видео (для центровки и fullscreen-логики)
  $('#media-stage').classList.toggle('is-video', mp.isVideo);
  $('#dlg-media .media-dlg').classList.toggle('is-video', mp.isVideo);
  // ЛЮБОЕ медиа (видео И музыка) играем потоком с телефона — на ПК ничего не качается.
  // Blob остаётся только аварийным вариантом, если локальный сервер не поднялся.
  let streamUrl = null;
  try {
    const su = await window.api.mediaUrl(s, full);
    if (su && su.ok) streamUrl = su.url;
  } catch (e) {}
  if (seq !== mp.loadSeq) return;
  let r = null;
  if (!streamUrl) {
    r = await window.api.fsCat(s, full);
    if (seq !== mp.loadSeq) return;
    if (!r.ok) { if (seq === mp.loadSeq) $('#media-now-sub').textContent = r.error || 'Не удалось загрузить'; return; }
  }
  if (seq !== mp.loadSeq) return;
  const mime = mp.isVideo
    ? (/webm$/i.test(name) ? 'video/webm' : (/mkv|avi|ts$/i.test(name) ? 'video/x-matroska' : 'video/mp4'))
    : (/ogg|opus|oga$/i.test(name) ? 'audio/ogg' : /flac$/i.test(name) ? 'audio/flac' : /wav$/i.test(name) ? 'audio/wav' : /aac$/i.test(name) ? 'audio/aac' : /m4a$/i.test(name) ? 'audio/mp4' : /wma$/i.test(name) ? 'audio/x-ms-wma' : 'audio/mpeg');
  let nextUrl = streamUrl;
  if (!nextUrl) nextUrl = URL.createObjectURL(new Blob([r.buf], { type: mime }));
  if (seq !== mp.loadSeq) {
    if (!streamUrl) { try { URL.revokeObjectURL(nextUrl); } catch (e) {} }
    return;
  }
  if (mp.loadedUrl) { try { URL.revokeObjectURL(mp.loadedUrl); } catch (e) {} }
  mp.loadedUrl = nextUrl;
  mp.isStream = !!streamUrl;
  mp.lastFull = full;   // для перезапуска при переключении режима звука
  const sub = (mp.isVideo ? 'Видео' : 'Аудио') + (streamUrl ? ' · поток с телефона' : ' · ' + fmtBytesLong((r && r.bytes) || 0));
  // эквалайзер ВЫКЛЮЧЕН по умолчанию → ПРЯМОЕ воспроизведение через el2 (без WebAudio):
  // гарантированно звучит и показывает видео на любой машине. Эквалайзер — опция (кнопка EQ).
  if (!mp.eqOn) {
    try { el.pause(); } catch (e) {}
    el.classList.add('hidden');
    if (streamUrl) { el2.crossOrigin = 'anonymous'; } else { el2.removeAttribute('crossorigin'); }
    el2.src = mp.loadedUrl;
    mpVolSet(mp.vol, false);
    el2.classList.toggle('hidden', !mp.isVideo);
    $('#media-now-sub').textContent = sub + ' · прямое воспроизведение';
    try { el2.load(); } catch (e) {}
    try {
      await el2.play();
      if (seq !== mp.loadSeq) return;
      $('#media-now-sub').textContent = sub;
      mpEnsureDirectAnalyser();   // визуализации слушают звук напрямую
    } catch (e) {
      if (seq === mp.loadSeq) $('#media-now-sub').textContent = 'Не удалось запустить автоматически — нажмите ▶';
    }
    return;
  }
  // режим с эквалайзером: звук идёт через WebAudio-граф (el подключён к нему насовсем)
  mpEnsureAudio();
  if (mp.ctx && mp.ctx.state === 'suspended') { try { await mp.ctx.resume(); } catch (e) {} }
  if (seq !== mp.loadSeq) return;
  try { el2.pause(); } catch (e) {}
  el.classList.toggle('hidden', !mp.isVideo);
  el2.classList.add('hidden');
  if (streamUrl) { el.crossOrigin = 'anonymous'; } else { el.removeAttribute('crossorigin'); }
  el.src = mp.loadedUrl;
  mpVolSet(mp.vol, false);
  $('#media-now-sub').textContent = sub + ' · эквалайзер';
  try { el.load(); } catch (e) {}
  try {
    await el.play();
    if (seq !== mp.loadSeq) return;
    $('#media-now-sub').textContent = sub + ' · эквалайзер';
  } catch (e) {
    if (seq === mp.loadSeq) $('#media-now-sub').textContent = 'Не удалось запустить автоматически — нажмите ▶';
  }
}
// страховка остаётся ТОЛЬКО для режима эквалайзера: играет el, а спектр молчит —
// честно предлагаем выключить EQ (прямое воспроизведение всегда надёжно)
function mpSilenceWatch() {
  clearTimeout(mp.silT);
  mp.silT = setTimeout(() => {
    const el = $('#media-el');
    if (!mp.eqOn || !mp.analyser || el.paused || mp.isVideo) return;
    try {
      const n = mp.analyser.frequencyBinCount;
      const fd = new Uint8Array(n);
      mp.analyser.getByteFrequencyData(fd);
      let sum = 0; for (let i = 0; i < n; i++) sum += fd[i];
      if (sum === 0 && !el.muted && el.volume > 0 && !el.error) {
        mp.eqOn = false;
        try { localStorage.setItem('media.eq', '0'); } catch (e) {}
        const eqBox = $('#media-eq');
        if (eqBox) eqBox.classList.add('hidden');
        try { el.pause(); } catch (e2) {}
        if (mp.lastFull) mpLoad(mp.lastFull).catch(() => {});
        snack('Звук через эквалайзер молчал — вернул прямое воспроизведение');
      }
    } catch (e) {}
  }, 2500);
}
async function openMediaPlayer(full, startAt) {
  // плеер ВСЕГДА отдельное окно. Никакого «переключения» при перетаскивании:
  // файл сразу открывается в том же внешнем окне, которое можно двигать по экрану.
  const s = currentSerial();
  if (!s) { snack('Сначала подключите телефон'); return; }
  try { if (rm && rm.full) rmStop(); } catch (e) {}
  try { $('#media-el').pause(); $('#media-el2').pause(); } catch (e) {}
  const dir = fsDir.replace(/\/+$/, '');
  const items = mediaList();
  const paths = items.map(it => it.path || (dir + '/' + it.name));
  const name = full.split('/').pop();
  let idx = items.findIndex(it => (it.path || (dir + '/' + it.name)) === full);
  if (idx < 0) idx = items.findIndex(it => it.name === name);
  if (idx < 0) idx = 0;
  if (!paths.length) paths.push(full);
  const payload = {
    serial: s, path: full, name,
    list: paths, idx,
    time: Math.max(0, Number(startAt) || 0),
    playing: true,
    vol: mp.vol, fit: mpFitMode(), visIdx: mp.visIdx,
    eq: !!mp.eqOn, theme: document.body.dataset.theme || 'dark'
  };
  let r = null;
  try { r = await window.api.playerOpen(payload); } catch (e) {}
  if (!r || !r.ok) { snack('Не удалось открыть окно плеера'); return; }
  mp.detached = true;
}
/* ОТДЕЛЬНОЕ ОКНО ПЛЕЕРА.
   Диалог внутри окна программы физически не может выехать за его пределы —
   это ограничение вьюпорта. Поэтому «наружу» открываем настоящее окно Windows
   без рамки: его можно тащить за заголовок по всему экрану и на второй монитор,
   а при возврате оно отдаёт текущий трек и позицию. */
function mpPlaylistPaths() {
  return (mp.list || []).map(it => (it && it.path) ? it.path : (fsDir.replace(/\/+$/, '') + '/' + (it ? it.name : '')));
}
function mpFitMode() {
  try {
    const m = localStorage.getItem('media.fit') || 'contain';
    return (m === 'cover' || m === 'fill') ? m : 'contain';
  } catch (e) { return 'contain'; }
}
async function detachPlayer(cursorX, cursorY) {
  if (mp.detached) return;
  const paths = mpPlaylistPaths();
  const path = mp.lastFull || paths[mp.idx];
  if (!path) { snack('Сначала откройте трек или видео'); return; }
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {}
  }
  const el = curMediaEl();
  const payload = {
    serial: currentSerial(), path, name: path.split('/').pop(),
    list: paths, idx: mp.idx,
    time: el ? (el.currentTime || 0) : 0,
    playing: !!(el && !el.paused && !el.ended),
    vol: mp.vol, fit: mpFitMode(), visIdx: mp.visIdx,
    eq: !!mp.eqOn, theme: document.body.dataset.theme || 'dark'
  };
  if (Number.isFinite(cursorX)) payload.x = Math.round(cursorX);
  if (Number.isFinite(cursorY)) payload.y = Math.round(cursorY);
  try { if (el) el.pause(); } catch (e) {}
  let r = null;
  try { r = await window.api.playerOpen(payload); } catch (e) {}
  if (r && r.ok) {
    mp.detached = true;
    $('#dlg-media').classList.add('hidden');
    snack('Плеер в отдельном окне — перетаскивайте его за заголовок по всему экрану');
  } else {
    snack('Не удалось открыть отдельное окно плеера');
  }
}
async function resumeDetached(st) {
  mp.detached = false;
  if (Array.isArray(st.list) && st.list.length) {
    mp.list = st.list.map(p => ({ name: String(p).split('/').pop(), path: String(p) }));
    mp.idx = Math.max(0, Math.min(mp.list.length - 1, Number(st.idx) || 0));
  }
  openDlg('dlg-media');
  if (Number.isFinite(+st.vol)) { try { mpVolSet(+st.vol, true); } catch (e) {} }
  if (st.fit) {
    try { localStorage.setItem('media.fit', st.fit); } catch (e) {}
    const dlgBox = $('#dlg-media .media-dlg');
    ['contain', 'cover', 'fill'].forEach(m => dlgBox.classList.toggle('fit-' + m, m === st.fit));
    ['#media-el', '#media-el2'].forEach(sel => { const x = $(sel); if (x) { x.style.objectFit = st.fit; x.style.objectPosition = 'center'; } });
  }
  if (Number.isFinite(+st.visIdx)) {
    mp.visIdx = Math.max(0, Math.min(window.VISLIB.length - 1, +st.visIdx));
    try { mpVisLabel(); } catch (e) {}
  }
  const dlgEl = $('#dlg-media .media-dlg');
  if (dlgEl) { dlgEl.tabIndex = -1; try { dlgEl.focus({ preventScroll: true }); } catch (e) {} }
  mpBuildEq();
  $('#media-eq').classList.toggle('hidden', !mp.eqOn);
  mpVisLabel();
  if (!mp.raf) mp.raf = requestAnimationFrame(mpDraw);
  await mpLoad(st.path);
  const m = curMediaEl();
  if (!m) return;
  const at = Number(st.time) || 0;
  const apply = () => {
    try { m.currentTime = at; } catch (e) {}
    if (st.playing) { const pr = m.play(); if (pr && pr.catch) pr.catch(() => {}); }
  };
  if (m.readyState >= 1) apply();
  else m.addEventListener('loadedmetadata', apply, { once: true });
}
function mpNav(d) {
  if (!mp.list.length) return;
  mp.idx = (mp.idx + d + mp.list.length) % mp.list.length;
  const it = mp.list[mp.idx];
  // В категориях («Вся музыка» и т.п.) файлы лежат в разных папках;
  // путь из fsDir + имя там неверный. Берём сохранённый it.path.
  const full = (it && it.path) ? it.path : (fsDir.replace(/\/+$/, '') + '/' + (it ? it.name : ''));
  if (!full) return;
  mpLoad(full);
}
(function mpEvents() {
  const el = $('#media-el'), el2 = $('#media-el2');   // активный элемент — через curMediaEl()
  function bindMedia(m) {
    m.onplay = () => { $('#media-play').textContent = '⏸'; mpShowBar(true); };
    m.onpause = () => { $('#media-play').textContent = '▶'; }; 
    m.onloadeddata = () => { if (m === curMediaEl()) $('#media-now-sub').textContent = (mp.isVideo ? 'Видео' : 'Аудио') + ' · готово'; };
    m.ontimeupdate = () => {
      if (m !== curMediaEl()) return;
      $('#media-time').textContent = mpFmtTime(m.currentTime) + ' / ' + mpFmtTime(m.duration);
      if (m.duration) $('#media-seek').value = Math.round(m.currentTime / m.duration * 1000);
    };
    m.onended = () => { if (m === curMediaEl()) mpNav(1); };
    m.onerror = () => {
      if (m !== curMediaEl()) return;
      $('#media-now-sub').textContent = 'Этот формат/кодек браузер не играет (например mkv с редким кодеком) — нажмите «На ПК», там проиграет системный плеер';
      $('#media-status').textContent = 'Кодек не поддержан Chromium. Кнопки «Скачать» и «На ПК» выше — рабочие.';
    };
  }
  bindMedia(el); bindMedia(el2);
  $('#media-play').onclick = async () => {
    const m = curMediaEl();
    if (!m.src) return;
    mpResumeCtx();
    m.paused ? m.play() : m.pause();
  };
$('#media-seek').oninput = () => { const m = curMediaEl(); if (m.duration) m.currentTime = (+$('#media-seek').value / 1000) * m.duration; };
  $('#media-seek').addEventListener('wheel', e => {
    e.preventDefault();
    const m = curMediaEl(); if (!m || !m.duration) return;
    const step = (e.deltaMode === 1 ? 30 : 10) * (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 3 : 1);
    m.currentTime = Math.min(m.duration - 0.05, Math.max(0, m.currentTime + step));
  }, { passive: false });
  $('#media-vol').addEventListener('wheel', e => {
    e.preventDefault();
    const step = (e.deltaMode === 1 ? 10 : 1) * (e.deltaY < 0 ? 1 : -1);
    mpVolSet(mp.vol + step, true);
  }, { passive: false });
  $('#media-vol').oninput = () => { mpVolSet(+$('#media-vol').value, true); };
  $('#yt-volbtn').onclick = () => {
    const el = curMediaEl(); if (!el) return;
    if (el.muted || mp.vol === 0) { el.muted = false; mpVolSet(mp.vol || MEDIA_VOL_DEFAULT, true); }
    else { el.muted = true; $('#yt-vol-lbl').textContent = '0%'; }
  };
  $('#media-prev').onclick = () => mpNav(-1);
  $('#media-next').onclick = () => mpNav(1);
  // EQ — опция. ВКЛ: звук через WebAudio (перезапуск текущего трека с той же позиции);
  // ВЫКЛ: обратно на прямое воспроизведение. Так «чёрный экран/молчание» невозможны по умолчанию.
  $('#media-eqbtn').onclick = async () => {
    const wasOn = mp.eqOn;
    mp.eqOn = !wasOn;
    try { localStorage.setItem('media.eq', mp.eqOn ? '1' : '0'); } catch (e) {}
$('#media-eq').classList.toggle('hidden', !mp.eqOn);
    const m = curMediaEl();
    const t = (m && m.currentTime) || 0;
    if (mp.eqOn) mpEnsureAudio();
    if (mp.ctx && mp.ctx.state === 'suspended') { try { await mp.ctx.resume(); } catch (e) {} }
    if (mp.lastFull) { await mpLoad(mp.lastFull).catch(() => {}); }
    const m2 = curMediaEl();
    if (t > 0 && m2 && m2.duration) { try { m2.currentTime = Math.min(t, m2.duration - 0.5); } catch (e) {} }
    snack(mp.eqOn ? 'Эквалайзер включён (звук через аудио-движок)' : 'Прямое воспроизведение (эквалайзер выключен)');
  };
  // «Скачать» и «Скачать и открыть системным плеером» — для любых непроигрываемых форматов
  $('#media-dl').onclick = async () => {
    const f = mp.list[mp.idx]; if (!f) return;
    const res = await window.api.fsPull(currentSerial(), fsDir.replace(/\/+$/, '') + '/' + f.name);
    if (res.ok) snack('Сохранено: ' + res.file);
  };
  $('#media-openpc').onclick = async () => {
    const f = mp.list[mp.idx]; if (!f) return;
    snack('Скачиваю и открываю системным плеером…');
    const r = await window.api.fsOpenOnPc(currentSerial(), fsDir.replace(/\/+$/, '') + '/' + f.name);
    snack(r.ok ? 'Открыто в системном плеере' : (r.error || 'Не удалось'));
  };
  // «Во весь экран» — большой режим внутри программы; «на монитор» — нативный fullscreen.
  // Режимы не складываются: выход из нативного fullscreen всегда возвращает в обычное окно.
  const mediaDlg = () => $('#dlg-media .media-dlg');
  const isNativeFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  function mpSyncFullUi() {
    const full = mediaDlg().classList.contains('media-full') || isNativeFull();
    const b = $('#media-full');
    if (b) b.textContent = full ? 'В окно' : 'Во весь экран';
  }
  function mpExitFullscreenToWindow() {
    if (isNativeFull()) {
      try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {}
    }
    mediaDlg().classList.remove('media-full');
    mpSyncFullUi();
    mpShowBar(true);
  }
  $('#media-full').onclick = () => {
    if (isNativeFull()) { mpExitFullscreenToWindow(); return; }
    mediaDlg().classList.toggle('media-full');
    mpSyncFullUi();
    mpShowBar(true);
  };
  $('#yt-full').onclick = () => toggleMonitorFullscreen(mediaDlg());
  $('#yt-window').onclick = () => mpExitFullscreenToWindow();
  $('#yt-close').onclick = () => closeMedia();
  // кнопка media-fullmon удалена из разметки (заменена на #yt-full).
  // Прямое обращение к null.onclick роняло ВЕСЬ app.js на этой строке — из-за этого
  // не инициализировались appsData/rm/интервалы: «не подключается», нет мини-плеера.
  const fullmonBtn = $('#media-fullmon');
  if (fullmonBtn) fullmonBtn.onclick = () => toggleMonitorFullscreen(mediaDlg());
  const fsSyncMedia = () => {
    // При входе в fullscreen монитора снимаем «в окне», при выходе — обычное окно.
    mediaDlg().classList.remove('media-full');
    mpSyncFullUi();
    const bar = $('#media-ytbar');
    if (bar) bar.classList.remove('yt-hidden');   // при входе/выходе из fullscreen панель показываем сразу
    mpShowBar(true);
  };
  mpSyncFullUi();
  document.addEventListener('fullscreenchange', fsSyncMedia);
  document.addEventListener('webkitfullscreenchange', fsSyncMedia);
  // движение мыши в полном экране — показать панель; уход с неё — скрыть через 2.6 с
  const stage = $('#media-stage');
  stage.addEventListener('mousemove', () => mpShowBar());
  stage.addEventListener('mouseleave', () => mpHideBarSoon());
  stage.addEventListener('click', e => {
    if (e.target.closest('.media-ytbar')) return;
    if (e.target.closest('video')) { const m = curMediaEl(); if (m) { m.paused ? m.play() : m.pause(); } }
  });
  // режим заполнения видео — «вписать» (contain) → «заполнить» (cover) → «растянуть» (fill)
  const FIT_MODES = ['contain', 'cover', 'fill'];
  const FIT_LABELS = { contain: 'Вписать', cover: 'Заполнить', fill: 'Растянуть' };
  function mpApplyFit() {
    let mode = 'contain';
    try { mode = localStorage.getItem('media.fit') || 'contain'; } catch (e) {}
    if (!FIT_MODES.includes(mode)) mode = 'contain';
    const dlg = $('#dlg-media .media-dlg');
    FIT_MODES.forEach(m => dlg.classList.toggle('fit-' + m, m === mode));
    // Inline object-fit надёжнее классов: в fullscreen CSS позже задаёт
    // object-fit: contain и перебивал режимы «заполнить/растянуть».
    [$('#media-el'), $('#media-el2')].forEach(el => {
      if (!el) return;
      el.style.objectFit = mode;
      el.style.objectPosition = 'center';
    });
    const b = $('#media-fit');
    if (b) { b.textContent = mode === 'cover' ? '⤢' : mode === 'fill' ? '▣' : '□'; b.dataset.tip = 'Заполнение: ' + FIT_LABELS[mode] + ' (клик — сменить)'; }
  }
  $('#media-fit').onclick = () => {
    let mode = 'contain';
    try { mode = localStorage.getItem('media.fit') || 'contain'; } catch (e) {}
    const next = FIT_MODES[(FIT_MODES.indexOf(mode) + 1) % FIT_MODES.length];
    try { localStorage.setItem('media.fit', next); } catch (e) {}
    mpApplyFit();
    snack('Видео: ' + FIT_LABELS[next]);
  };
  mpApplyFit();
  const closeMedia = () => {
    // если закрываем ИЗ полного экрана — сначала выходим из fullscreen,
    // иначе интерфейс программы оставался «под» полноэкранным элементом и не кликался
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      }
    } catch (e) {}
    $('#dlg-media .media-dlg').classList.remove('media-full');
    mpSyncFullUi();
    mpStop(); $('#media-ytbar').classList.remove('yt-hidden'); closeDlg('dlg-media');
  };
  $('#btn-media-close').onclick = closeMedia;
  $('#btn-media-close').removeAttribute('data-close');   // закрытие плеера останавливает воспроизведение
  // отдельное окно — можно утащить плеер за пределы приложения
  const detachBtn = $('#btn-media-detach');
  if (detachBtn) detachBtn.onclick = () => detachPlayer(null, null);
  // «свернуть» — плеер уходит в мини-плеер слева, музыка продолжает играть
  $('#btn-media-min').onclick = async () => {
    const full = mp.lastFull;
    const isAudio = !mp.isVideo;
    const pos = (() => { const m = curMediaEl(); return m && m.currentTime ? m.currentTime : 0; })();
    if (!full || !isAudio) { closeMedia(); return; }
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {}
    }
    $('#dlg-media .media-dlg').classList.remove('media-full');
    mpSyncFullUi();
    mpStop(); closeDlg('dlg-media');
    await rmPlayFull(full, pos);
    snack('Свёрнуто в мини-плеер — музыка играет');
  };
  $('#dlg-media').addEventListener('click', e => { if (e.target === $('#dlg-media')) closeMedia(); });
  // стрелки навигации визуализаций (номер + название, выбор запоминается)
  $('#media-vis-prev').onclick = () => mpVisNav(-1);
  $('#media-vis-next').onclick = () => mpVisNav(1);
  document.addEventListener('keydown', e => {
    if ($('#dlg-media').classList.contains('hidden')) return;
    // Плеер теперь немодальный: горячие клавиши работают только когда
    // фокус/событие внутри него, а не при работе с основным интерфейсом.
    if (!(e.target && e.target.closest && e.target.closest('#dlg-media'))) return;
    if (e.key === 'Escape') {
      // Esc работает даже когда фокус на ползунке громкости/перемотки.
      if (isNativeFull()) { mpExitFullscreenToWindow(); e.preventDefault(); return; }
      if (mediaDlg().classList.contains('media-full')) {
        mediaDlg().classList.remove('media-full');
        mpSyncFullUi();
        mpShowBar(true);
        e.preventDefault();
        return;
      }
      closeMedia();
      return;
    }
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); $('#media-play').click(); }
    if (e.key === 'ArrowLeft') { if (e.shiftKey) mpVisNav(-1); else mpNav(-1); }
    if (e.key === 'ArrowRight') { if (e.shiftKey) mpVisNav(1); else mpNav(1); }
    if (e.key === 'v' || e.key === 'V' || e.key === 'м' || e.key === 'М') mpVisNav(1);
  });
  // просмотрщик: стрелки листают фото
  document.addEventListener('keydown', e => {
    if ($('#dlg-imgview').classList.contains('hidden')) return;
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') ivNav(-1);
    if (e.key === 'ArrowRight') ivNav(1);
    if (e.key === 'Escape' && $('#imgview-shell').classList.contains('imgview-full')) $('#imgview-shell').classList.remove('imgview-full');
  });
})();

$('#btn-fs-back').onclick = () => fsNavigate(null, { back: true });
$('#btn-fs-fwd').onclick = () => fsNavigate(null, { fwd: true });
// боковые кнопки мыши — «назад»/«вперёд», как в Проводнике Windows.
// В Chromium боковые кнопки приходят как button 3 (back) и 4 (forward) на mouseup.
document.addEventListener('mouseup', (e) => {
  if (e.button !== 3 && e.button !== 4) return;
  if (document.getElementById('dlg-media') && !document.getElementById('dlg-media').classList.contains('hidden')) return;
  if (document.getElementById('dlg-imgview') && !document.getElementById('dlg-imgview').classList.contains('hidden')) return;
  if (!$('#page-files') || !$('#page-files').classList.contains('active')) return;
  e.preventDefault();
  if (e.button === 3) fsNavigate(null, { back: true });
  else fsNavigate(null, { fwd: true });
});
$('#btn-fs-go').onclick = () => fsNavigate($('#fs-path').value.trim() || '/sdcard');
$('#fs-path').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-fs-go').click(); });
$('#btn-fs-up').onclick = () => { const p = fsDir.replace(/\/+$/, '').split('/'); p.pop(); fsNavigate(p.join('/') || '/'); };
$('#btn-fs-refresh').onclick = fsRender;
$('#fs-filter').addEventListener('input', () => fsRender());
$('#btn-fs-toconnect').onclick = () => goPage('devices');

/* загрузка на телефон — ВСЕГДА в ОТКРЫТУЮ папку (F7) */
$('#btn-fs-push').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  const files = await window.api.pickFile({ properties: ['openFile', 'multiSelections'] });
  if (!files || !files.length) return;
  snack('Загружаю в ' + fsDir + '…');
  let okCount = 0;
  for (const f of files) {
    const r = await window.api.fsPush(s, f, fsDir);
    if (r.ok) okCount++;
  }
  snack('Загружено в ' + fsDir + ': ' + okCount + ' из ' + files.length);
  fsRender();
};
// обработчик «Новая папка» перенесён в блок файлового менеджера выше (рядом с «Новый файл»)

/* перетаскивание файлов с ПК прямо в окно — загрузка в ОТКРЫТУЮ папку (F8) */
/* старый обработчик убран — загрузкой занимается единый initFileDrop ниже,
   он умеет и текущую папку, и папку, на которую навели курсор. */

/* ---------- мини-плеер фоновой музыки в левой панели ----------
   Выбранный трек играет, пока вы ходите по другим разделам; громкость своя
   (связана с общей громкостью плеера), запоминается и восстанавливается. */
const rm = { el: null, full: null, name: '', vol: 5, playing: false, list: [], idx: -1, stream: null, busy: false, boundEl: null, seeking: false };
rm.vol = mediaVolLoad();
function rmVolSet(v, apply) { mediaVolSet(v, apply !== false); }
function rmFmtTime(t) {
  if (!isFinite(t) || t < 0) return '0:00';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}
function rmSeekUpdate() {
  const el = rm.el;
  const d = el && isFinite(el.duration) ? el.duration : 0;
  const t = el ? (el.currentTime || 0) : 0;
  const seek = $('#rm-seek');
  if (seek && !rm.seeking) seek.value = d ? Math.min(1000, Math.round(t / d * 1000)) : 0;
  const cur = $('#rm-cur'); if (cur) cur.textContent = rmFmtTime(t);
  const dur = $('#rm-dur'); if (dur) dur.textContent = rmFmtTime(d);
}
/* в мини-плеере — та же визуализация и те же аудиоданные, что в основном
   плеере: выбранный стиль VISLIB, реальный спектр с анализатора, синхронное время. */
let rmVisRaf = 0, rmVisLast = 0, rmVisT = 0;
let rmVisCtx = null, rmVisAnalyser = null, rmVisSrcEl = null, rmVisNode = null;
let rmVisFreq = null, rmVisWave = null;
function rmResumeVis() {
  if (rmVisCtx && rmVisCtx.state === 'suspended') { try { rmVisCtx.resume(); } catch (e) {} }
}
function rmEnsureAnalyser() {
  const el = rm.el;
  if (!el) return;
  if (rmVisAnalyser && rmVisSrcEl === el) { rmResumeVis(); return; }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!rmVisCtx || rmVisCtx.state === 'closed') rmVisCtx = new Ctx();
    rmResumeVis();
    const st = el.captureStream ? el.captureStream() : null;
    if (!st || !st.getAudioTracks().length) return;
    if (rmVisNode) { try { rmVisNode.disconnect(); } catch (e) {} }
    rmVisNode = rmVisCtx.createMediaStreamSource(st);
    const an = rmVisCtx.createAnalyser();
    an.fftSize = 512;
    an.smoothingTimeConstant = 0.82;
    rmVisNode.connect(an);
    rmVisAnalyser = an;
    rmVisSrcEl = el;
    rmVisFreq = new Uint8Array(an.frequencyBinCount);
    rmVisWave = new Uint8Array(an.frequencyBinCount);
  } catch (e) {
    rmVisAnalyser = null;
    rmVisSrcEl = null;
  }
}
function rmVisAudio() {
  const a = { bass: 0, mid: 0, treble: 0, energy: 0, spectrum: [], wave: [] };
  if (!rmVisAnalyser || !rmVisFreq || !rmVisWave) return a;
  try {
    rmVisAnalyser.getByteFrequencyData(rmVisFreq);
    rmVisAnalyser.getByteTimeDomainData(rmVisWave);
    const n = rmVisFreq.length;
    // Если анализатор молчит (поток без CORS/тишина), не подсовываем VISLIB
    // массив нулей — иначе анимация выглядит статичной картинкой. Пустые
    // spectrum/wave включают тот же time-based режим, что и у основного плеера.
    let sum = 0, wsum = 0;
    for (let i = 0; i < n; i++) { sum += rmVisFreq[i]; wsum += Math.abs(rmVisWave[i] - 128); }
    if (!sum && !wsum) return a;
    a.spectrum = rmVisFreq; a.wave = rmVisWave;
    let b = 0, m = 0, tr = 0;
    for (let i = 0; i < 8 && i < n; i++) b += rmVisFreq[i];
    for (let i = 8; i < 60 && i < n; i++) m += rmVisFreq[i];
    for (let i = 60; i < Math.min(n, 200); i++) tr += rmVisFreq[i];
    a.bass = b / (8 * 255);
    a.mid = m / (52 * 255);
    a.treble = tr / (Math.max(1, Math.min(n, 200) - 60) * 255);
    a.energy = a.bass * 0.5 + a.mid * 0.35 + a.treble * 0.15;
  } catch (e) {}
  return a;
}
function rmVisDraw(ts) {
  rmVisRaf = requestAnimationFrame(rmVisDraw);
  const cv = $('#rm-vis'); if (!cv) return;
  const ctx = cv.getContext('2d'); if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.max(1, Math.round(cv.clientWidth * dpr));
  const ch = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
  const W = cv.width, H = cv.height;
  const dt = rmVisLast ? Math.min(0.05, (ts - rmVisLast) / 1000) : 0.016;
  rmVisLast = ts;
  const zeros = { bass: 0, mid: 0, treble: 0, energy: 0, spectrum: [], wave: [] };
  const dlg = $('#dlg-media');
  const mainOpen = !!(dlg && !dlg.classList.contains('hidden'));
  const mainEl = mainOpen ? curMediaEl() : null;
  const mainPlaying = !!(mainEl && !mp.isVideo && !mainEl.paused && !mainEl.ended && mainEl.readyState >= 2);
  const rmActive = !!(rm.el && !rm.el.paused && !rm.el.ended);
  // Нет активного источника — не перерисовываем кадры. Иначе некоторые
  // визуализации (например, «Светлячки») продолжают жить после закрытия плеера.
  if (!(mainOpen ? mainPlaying : rmActive)) return;
  let audio, t;
  if (mainOpen) {
    // Основной плеер открыт — мини-окно рисует тот же стиль, время и спектр,
    // что и большой плеер: анимации совпадают кадр в кадр.
    audio = mainPlaying ? mpVisAudioData() : zeros;
    t = mp.visT || 0;
  } else {
    audio = rmActive ? rmVisAudio() : zeros;
    if (rmActive) rmVisT += dt + audio.energy * 0.02;
    t = rmVisT;
  }
  const vis = window.VISLIB && window.VISLIB[mp.visIdx];
  if (!vis) { ctx.clearRect(0, 0, W, H); return; }
  try { vis.draw(ctx, W, H, t, audio); }
  catch (e) { ctx.clearRect(0, 0, W, H); }
}
function rmVisStart() {
  if (!rmVisRaf) rmVisRaf = requestAnimationFrame(rmVisDraw);
}
function rmBindEl(el) {
  if (!el || rm.boundEl === el) return;
  rm.boundEl = el;
  const upd = () => rmSeekUpdate();
  el.addEventListener('timeupdate', upd);
  el.addEventListener('loadedmetadata', () => { upd(); rmEnsureAnalyser(); });
  el.addEventListener('durationchange', upd);
  el.addEventListener('play', () => { rm.playing = true; rmEnsureAnalyser(); rmResumeVis(); rmRender(); rmSeekUpdate(); });
  el.addEventListener('pause', () => { rm.playing = false; rmRender(); rmSeekUpdate(); });
  el.addEventListener('ended', () => { rm.playing = false; rmRender(); rmSeekUpdate(); });
}
// мини-плеер виден ВСЕГДА (неактивен без трека), как обычный плеер в приложении
function rmRender() {
  const box = $('#rail-mini'); if (!box) return;
  box.classList.toggle('idle', !rm.full);
  $('#rm-title').textContent = rm.full ? rm.name : 'Мини-плеер';
  $('#rm-sub').textContent = rm.busy ? 'Ищу музыку…' : (rm.full ? (rm.playing ? 'играет…' : 'на паузе') : 'Ничего не играет');
  $('#rm-play').textContent = rm.playing ? '❚❚' : '▶';
  rmSeekUpdate();
}
function rmSetList() {
  const dir = fsDir.replace(/\/+$/, '');
  rm.list = mediaList()
    .filter(it => AUD_RE.test(it.name))
    .map(it => it.path || (dir + '/' + it.name));
  if (!rm.list.length && rm.full) rm.list = [rm.full];
  rm.idx = rm.full ? rm.list.findIndex(p => p === rm.full) : -1;
}
async function rmPlayFull(full, startAt) {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  // если играет внешнее окно плеера — ставим его на паузу, чтобы не было двух звуков
  try { if (window.api.playerPause) window.api.playerPause(); } catch (e) {}
  const name = full.split('/').pop();
  try { $('#media-el').pause(); $('#media-el2').pause(); } catch (e) {}
  rm.full = full; rm.name = name;
  rmSetList();
  if (!rm.el) { rm.el = new Audio(); rm.el.loop = false; }
  rmBindEl(rm.el);
  rm.el.crossOrigin = 'anonymous';
  // музыка тоже ПОТОКОМ с телефона, без скачивания в кэш ПК
  let url = null;
  try {
    const su = await window.api.mediaUrl(s, full);
    if (su && su.ok) url = su.url;
  } catch (e) {}
  if (!url) {
    const r = await window.api.fsCat(s, full);
    if (!r.ok) { snack((r.error || 'Не удалось загрузить')); return; }
    if (rm.objUrl) { try { URL.revokeObjectURL(rm.objUrl); } catch (e) {} }
    const mime = /\.(ogg|opus|oga)$/i.test(name) ? 'audio/ogg' : /flac$/i.test(name) ? 'audio/flac' : /\.wav$/i.test(name) ? 'audio/wav' : /\.(m4a)$/i.test(name) ? 'audio/mp4' : /\.aac$/i.test(name) ? 'audio/aac' : /\.wma$/i.test(name) ? 'audio/x-ms-wma' : 'audio/mpeg';
    rm.objUrl = URL.createObjectURL(new Blob([r.buf], { type: mime }));
    url = rm.objUrl;
  }
  if (rm.objUrl && url !== rm.objUrl) { try { URL.revokeObjectURL(rm.objUrl); } catch (e) {} rm.objUrl = null; }
  rm.stream = url;
  rm.el.src = url;
  rm.el.volume = rm.vol / 100;
  if (startAt && startAt > 0) rm.el.addEventListener('loadedmetadata', () => { try { rm.el.currentTime = startAt; } catch (e) {} }, { once: true });
  try { await rm.el.play(); rm.playing = true; } catch (e) { rm.playing = false; }
  rmEnsureAnalyser();
  rmResumeVis();
  rmRender();
  rmSeekUpdate();
}
function rmNav(d) {
  if (!rm.list.length) return;
  if (rm.idx < 0) rm.idx = 0;
  rm.idx = (rm.idx + d + rm.list.length) % rm.list.length;
  rmPlayFull(rm.list[rm.idx]);
}
async function rmPlayFirst() {
  if (rm.busy) return;
  const s = currentSerial();
  if (!s) return snack('Сначала подключите устройство');
  if (!isOnline(s)) return snack('Устройство не подключено');
  if (mp.lastFull && mp.loadedUrl && !mp.isVideo) {
    const t = (curMediaEl() && curMediaEl().currentTime) || 0;
    await rmPlayFull(mp.lastFull, t);
    return;
  }
  rm.busy = true;
  rmRender();
  try {
    if (fsCatKind !== 'music' || !fsItems.some(it => !it.dir && AUD_RE.test(it.name))) {
      fsCatKind = 'music';
      goPage('files', { skipFsRender: true });
      await fsRender();
    } else {
      goPage('files', { skipFsRender: true });
    }
    const source = fsCatKind === 'music' ? (fsCatItems.length ? fsCatItems : fsItems) : fsItems;
    const songs = (source || [])
      .filter(it => !it.dir && AUD_RE.test(it.name))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    if (!songs.length) { snack('На устройстве не найдено музыки'); return; }
    await rmPlayFull(songs[0].path);
  } catch (e) {
    snack('Не удалось включить музыку');
  } finally {
    rm.busy = false;
    rmRender();
  }
}
function rmToggle() {
  if (rm.busy) return;
  if (!rm.full) { rmPlayFirst(); return; }
  if (!rm.el) { rmPlayFull(rm.full); return; }
  rmBindEl(rm.el);
  if (rm.el.paused) { rmEnsureAnalyser(); rmResumeVis(); rm.el.play().catch(() => {}); rm.playing = true; }
  else { rm.el.pause(); rm.playing = false; }
  rmRender();
  rmSeekUpdate();
}
function rmExpand() {
  if (!rm.full) return snack('Сначала включите музыку');
  const full = rm.full;
  const pos = (rm.el && rm.el.currentTime) || 0;
  rmStop();
  // раскрытие мини-плеера открывает внешнее окно и сразу ставит ту же позицию
  openMediaPlayer(full, pos).catch(() => {});
}
function rmStop() {
  rm.playing = false; rm.seeking = false; rm.full = null; rm.name = ''; rm.list = []; rm.idx = -1;
  if (rm.el) { try { rm.el.pause(); rm.el.removeAttribute('src'); rm.el.load(); } catch (e) {} }
  if (rm.objUrl) { try { URL.revokeObjectURL(rm.objUrl); } catch (e) {} rm.objUrl = null; }
  rm.stream = null;
  rmRender();
  rmSeekUpdate();
}
(function rmEvents() {
  const playBtn = $('#rm-play'); if (playBtn) playBtn.onclick = rmToggle;
  const prevBtn = $('#rm-prev'); if (prevBtn) prevBtn.onclick = () => rmNav(-1);
  const nextBtn = $('#rm-next'); if (nextBtn) nextBtn.onclick = () => rmNav(1);
  const expandBtn = $('#rm-expand'); if (expandBtn) expandBtn.onclick = rmExpand;
  const stopBtn = $('#rm-stop'); if (stopBtn) stopBtn.onclick = () => { rmStop(); snd.play('click'); };
  const visPrev = $('#rm-vis-prev'); if (visPrev) visPrev.onclick = () => mpVisNav(-1);
  const visNext = $('#rm-vis-next'); if (visNext) visNext.onclick = () => mpVisNav(1);
  const vol = $('#rm-vol'); if (vol) vol.oninput = () => rmVolSet(+vol.value);
  const volL = $('#rm-vol-lbl'); if (volL) volL.textContent = rm.vol + '%';
  if (vol) vol.value = rm.vol;
  const seek = $('#rm-seek');
  if (seek) {
    seek.addEventListener('input', () => {
      rm.seeking = true;
      const el = rm.el;
      if (el && isFinite(el.duration)) { try { el.currentTime = (+seek.value / 1000) * el.duration; } catch (e) {} }
      rmSeekUpdate();
    });
    seek.addEventListener('change', () => { rm.seeking = false; rmSeekUpdate(); });
    // колесо над перемоткой — перематывает трек, а не меняет громкость мини-плеера
    seek.addEventListener('wheel', e => {
      e.preventDefault();
      e.stopPropagation();
      const el = rm.el;
      if (!el || !isFinite(el.duration) || !el.duration) return;
      const step = (e.deltaMode === 1 ? 30 : 10) * (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 3 : 1);
      try { el.currentTime = Math.min(el.duration - 0.05, Math.max(0, el.currentTime + step)); } catch (err) {}
      rmSeekUpdate();
    }, { passive: false });
  }
  const mini = $('#rail-mini');
  if (mini) mini.addEventListener('wheel', e => {
    if (e.target && e.target.closest && e.target.closest('#rm-seek')) return;
    e.preventDefault();
    const step = e.shiftKey ? 5 : 1;
    rmVolSet(rm.vol + (e.deltaY < 0 ? step : -step), true);
  }, { passive: false });
  rmRender();   // мини-плеер всегда на виду
  rmVisStart();
})();

/* ---------- менеджер приложений ---------- */
let appsData = null, appsTab = 'all', appsSort = 'name';
let appsMetaMap = {};   // { pkg: {size, mtime} } для сортировки по размеру/дате
let installTimes = {};  // { pkg: ms } реальные даты установки (firstInstallTime)
let appLabels = {};   // { pkg: человеческое имя } — из кэша main + извлечение из APK (F11)
const DEBLOAT = [
  { p: 'com.facebook.katana', safe: true, name: 'Facebook', desc: 'Соцсеть Meta; часто предустановлена, нужна только для входа в Facebook.' },
  { p: 'com.facebook.orca', safe: true, name: 'Messenger', desc: 'Мессенджер Facebook; можно отключить, если не пользуетесь.' },
  { p: 'com.instagram.android', safe: true, name: 'Instagram', desc: 'Соцсеть Meta; встречается как предустановка на некоторых прошивках.' },
  { p: 'com.twitter.android', safe: true, name: 'X (Twitter)', desc: 'Соцсеть X/Twitter; как системное приложение обычно не нужна.' },
  { p: 'com.tiktok', safe: true, name: 'TikTok', desc: 'Клиент TikTok. Если приложение установлено вами, это сторонний пакет — его можно удалить.' },
  { p: 'com.zhiliaoapp.musically', safe: true, name: 'TikTok', desc: 'Клиент TikTok. Если приложение установлено вами, это сторонний пакет — его можно удалить.' },
  { p: 'com.zhiliaoapp.musically.go', safe: true, name: 'TikTok Lite', desc: 'Облегчённый клиент TikTok. Стороннее приложение, если установлено вами.' },
  { p: 'com.booking', safe: true, name: 'Booking.com', desc: 'Сервис бронирования отелей; обычно не нужен постоянно.' },
  { p: 'com.linkedin.android', safe: true, name: 'LinkedIn', desc: 'Профессиональная соцсеть; можно отключить.' },
  { p: 'com.microsoft.skydrive', safe: true, name: 'OneDrive', desc: 'Облако Microsoft для синхронизации файлов.' },
  { p: 'com.skype.raider', safe: true, name: 'Skype', desc: 'Мессенджер Microsoft; заменяется другими программами.' },
  { p: 'com.microsoft.office.officehub', safe: true, name: 'Microsoft Office', desc: 'Пакет Office; нужен, если редактируете документы на телефоне.' },
  { p: 'com.samsung.android.bixby.vision', safe: true, name: 'Bixby Vision', desc: 'Визуальный помощник Samsung; на других прошивках не встречается.' },
  { p: 'com.samsung.android.bixby.wakeup', safe: true, name: 'Bixby Wakeup', desc: 'Голосовой помощник Samsung; можно отключить.' },
  { p: 'com.samsung.android.aremoji', safe: true, name: 'AR Emoji', desc: 'AR-аватары Samsung; нужны только для этой функции.' },
  { p: 'com.amazon.avod.thirdpartyclient', safe: true, name: 'Amazon Prime Video', desc: 'Видеосервис Amazon; предустановка на некоторых устройствах.' },
  { p: 'com.google.android.youtube', safe: false, name: 'YouTube', desc: 'Клиент YouTube; отключение убирает предустановленное приложение.' },
  { p: 'com.google.android.apps.maps', safe: false, name: 'Google Карты', desc: 'Карты и навигация Google; можно заменить другим навигатором.' },
  { p: 'com.android.chrome', safe: false, name: 'Chrome', desc: 'Браузер Google; можно заменить другим браузером.' },
  { p: 'com.google.ar.core', safe: false, name: 'ARCore', desc: 'Служба дополненной реальности Google; нужна только AR-приложениям.' },
  { p: 'com.google.android.apps.photos', safe: false, name: 'Google Фото', desc: 'Галерея и облачная синхронизация Google; без неё снимки останутся в других галереях.' },
  { p: 'com.google.android.gm', safe: false, name: 'Gmail', desc: 'Почтовый клиент Google; нужен для почты и аккаунта.' },
  { p: 'com.google.android.apps.docs', safe: false, name: 'Google Диск', desc: 'Облачное хранилище Google; отключение остановит синхронизацию.' },
  { p: 'com.google.android.apps.docs.editors.docs', safe: false, name: 'Google Документы', desc: 'Редактор документов Google.' },
  { p: 'com.google.android.apps.docs.editors.sheets', safe: false, name: 'Google Таблицы', desc: 'Редактор таблиц Google.' },
  { p: 'com.google.android.apps.docs.editors.slides', safe: false, name: 'Google Презентации', desc: 'Редактор презентаций Google.' },
  { p: 'com.google.android.music', safe: true, name: 'Google Play Музыка', desc: 'Устаревший музыкальный сервис Google.' },
  { p: 'com.google.android.videos', safe: true, name: 'Google Play Видео', desc: 'Устаревший видеосервис Google.' },
  { p: 'com.google.android.apps.tachyon', safe: false, name: 'Google Meet', desc: 'Видеозвонки Google Duo/Meet.' },
  { p: 'com.google.android.projection.gearhead', safe: false, name: 'Android Auto', desc: 'Проекция интерфейса в автомобиль; нужна только для Android Auto.' },
  { p: 'com.google.android.apps.bard', safe: false, name: 'Google Gemini', desc: 'ИИ-помощник Google; можно отключить, если не пользуетесь.' },
  { p: 'com.huawei.browser', safe: true, name: 'Браузер Huawei', desc: 'Штатный браузер Huawei; можно заменить Яндексом или Chrome.' },
  { p: 'com.huawei.appmarket', safe: false, name: 'AppGallery', desc: 'Магазин приложений Huawei; отключение остановит обновления.' },
  { p: 'com.huawei.himovie.overseas', safe: true, name: 'Huawei Video', desc: 'Онлайн-кинотеатр Huawei.' },
  { p: 'com.huawei.health', safe: true, name: 'Huawei Health', desc: 'Здоровье и трекеры Huawei; нужен только для носимых устройств.' },
  { p: 'com.huawei.magazine', safe: true, name: 'Huawei Today', desc: 'Лента новостей и рекомендаций Huawei.' },
  { p: 'com.huawei.tips', safe: true, name: 'Подсказки Huawei', desc: 'Советы и обучающие карточки системы.' },
  { p: 'com.huawei.phoneservice', safe: true, name: 'Поддержка Huawei', desc: 'Сервис поддержки и диагностики Huawei.' },
  { p: 'com.huawei.android.totemweather', safe: true, name: 'Погода Huawei', desc: 'Штатное приложение погоды.' },
  { p: 'com.huawei.search', safe: false, name: 'Поиск Huawei', desc: 'Системный поиск по телефону и интернету.' },
  { p: 'com.huawei.intelligent', safe: true, name: 'HiBoard', desc: 'Умная лента и виджеты Huawei.' },
  { p: 'com.huawei.gameassistant', safe: true, name: 'Игровой помощник', desc: 'Игровой режим и оптимизация Huawei.' },
  { p: 'com.huawei.parentcontrol', safe: true, name: 'Родительский контроль', desc: 'Ограничения и контроль времени Huawei.' },
  { p: 'com.huawei.videoeditor', safe: true, name: 'Видеоредактор Huawei', desc: 'Штатный редактор видео.' },
  { p: 'com.huawei.honorclub.android', safe: true, name: 'Honor Club', desc: 'Клуб и новости Honor.' },
  { p: 'com.huawei.compass', safe: true, name: 'Компас', desc: 'Штатный компас Huawei.' },
  { p: 'com.huawei.android.FMRadio', safe: true, name: 'FM-радио', desc: 'Штатное FM-радио; нужно только для проводных наушников.' },
  { p: 'com.huawei.hifolder', safe: true, name: 'HiFolder', desc: 'Сортировка и папки Huawei.' },
  { p: 'com.huawei.airlink', safe: true, name: 'Airlink', desc: 'Беспроводная проекция экрана Huawei.' },
  { p: 'com.huawei.android.airsharing', safe: true, name: 'AirSharing', desc: 'Обмен файлами и экраном с другими устройствами.' },
  { p: 'com.huawei.hwvoipservice', safe: false, name: 'MeeTime', desc: 'Видеозвонки Huawei; отключайте, если не пользуетесь.' },
  { p: 'com.huawei.localBackup', safe: true, name: 'Локальная копия', desc: 'Локальное резервное копирование Huawei.' },
  { p: 'com.huawei.hicloud', safe: false, name: 'Облако Huawei', desc: 'Облачная синхронизация и резервные копии.' },
  { p: 'com.huawei.android.karaoke', safe: true, name: 'Караоке Huawei', desc: 'Штатное караоке; обычно не нужно.' }
];
const DEBLOAT_CRITICAL = new Set([
  'android', 'com.android.systemui', 'com.android.phone', 'com.android.settings',
  'com.android.packageinstaller', 'com.google.android.packageinstaller',
  'com.google.android.permissioncontroller', 'com.google.android.gms', 'com.google.android.gsf',
  'com.android.providers.settings', 'com.android.shell',
  'com.huawei.systemserver', 'com.huawei.securityserver', 'com.huawei.android.launcher',
  'com.huawei.systemmanager', 'com.huawei.hwid', 'com.huawei.devicemanager',
  'com.huawei.iaware', 'com.huawei.ims',
  'com.miui.home', 'com.mi.android.globallauncher', 'com.google.android.apps.nexuslauncher',
  'com.android.launcher3', 'com.sec.android.app.launcher', 'com.oppo.launcher',
  'com.vivo.launcher', 'com.transsion.XOSLauncher'
]);
let debloatTab = 'recommended';
let debloatQuery = '';
let debloatIconToken = 0;
let debloatRoles = null;
let debloatRolesToken = 0;
const DEBLOAT_ROLE_LABELS = {
  home: 'лаунчер', ime: 'клавиатура', dialer: 'звонки', sms: 'SMS',
  browser: 'браузер', assistant: 'помощник', accessibility: 'спец. возможности',
  vpn: 'постоянный VPN'
};
const DEBLOAT_CRITICAL_ROLES = new Set(['home', 'ime', 'dialer', 'sms']);
function debloatInfo(pkg) { return DEBLOAT.find(d => d.p === pkg) || null; }
function debloatName(pkg) { const d = debloatInfo(pkg); return (d && d.name) || appDisplay(pkg); }
function debloatVendor(pkg) {
  if (/^com\.huawei\.|^com\.honor\./i.test(pkg)) return 'Huawei/Honor';
  if (/^com\.google\./i.test(pkg)) return 'Google';
  if (/^com\.android\./i.test(pkg)) return 'Android';
  if (/^com\.miui\.|^com\.xiaomi\.|^com\.mi\./i.test(pkg)) return 'Xiaomi';
  if (/^com\.samsung\.|^com\.sec\./i.test(pkg)) return 'Samsung';
  if (/^com\.oneplus\.|^com\.oplus\.|^com\.coloros\./i.test(pkg)) return 'OPPO/OnePlus';
  if (/^com\.vivo\.|^com\.bbk\./i.test(pkg)) return 'vivo';
  if (/^com\.transsion\.|^com\.tecno\.|^com\.infinix\./i.test(pkg)) return 'Transsion';
  return '';
}
function roleFirstPkg(s) {
  const t = String(s || '').trim();
  if (!t || /^(null|unknown|no activity found|error|exception)/i.test(t)) return '';
  let m = t.match(/([a-zA-Z][\w.]*)\/[\w.$]+/);
  if (m) return m[1];
  m = t.match(/^\s*([a-zA-Z][\w.]*)\s*$/m);
  return m ? m[1] : '';
}
function roleAllPkgs(s) {
  const out = [];
  for (const m of String(s || '').matchAll(/([a-zA-Z][\w.]*)\/[\w.$]+/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  if (!out.length) { const p = roleFirstPkg(s); if (p) out.push(p); }
  return out;
}
async function loadDebloatRoles() {
  const s = currentSerial();
  if (!s || !window.api || !window.api.fsCmd) return;
  const token = ++debloatRolesToken;
  const ask = (args, ms = 7000) => {
    let call;
    try { call = window.api.fsCmd(s, args); } catch (e) { call = Promise.resolve({}); }
    const timeout = new Promise(resolve => setTimeout(() => resolve({}), ms));
    return Promise.race([call.catch(() => ({})), timeout]);
  };
  const [home, ime, dialer, sms, browser, browserRole, assistant, accessibility, vpn] = await Promise.all([
    ask(['cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME']),
    ask(['settings', 'get', 'secure', 'default_input_method']),
    ask(['cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.DIAL', '-d', 'tel:12345']),
    ask(['cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.SENDTO', '-d', 'sms:', '-c', 'android.intent.category.DEFAULT']),
    ask(['cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.VIEW', '-d', 'https://example.com']),
    ask(['cmd', 'role', 'get-role-holders', 'android.app.role.BROWSER']),
    ask(['settings', 'get', 'secure', 'assistant']),
    ask(['settings', 'get', 'secure', 'enabled_accessibility_services']),
    ask(['settings', 'get', 'secure', 'always_on_vpn_app'])
  ]);
  if (token !== debloatRolesToken) return;
  const text = x => ((x && x.stdout) || '') + '\n' + ((x && x.stderr) || '');
  const browserRolePkg = roleFirstPkg(text(browserRole));
  const browserResolved = roleFirstPkg(text(browser));
  const browserPkg = browserRolePkg && browserRolePkg !== 'com.android.intentresolver'
    ? browserRolePkg
    : (browserResolved && browserResolved !== 'com.android.intentresolver' ? browserResolved : '');
  debloatRoles = {
    home: roleFirstPkg(text(home)) ? [roleFirstPkg(text(home))] : [],
    ime: roleFirstPkg(text(ime)) ? [roleFirstPkg(text(ime))] : [],
    dialer: roleFirstPkg(text(dialer)) ? [roleFirstPkg(text(dialer))] : [],
    sms: roleFirstPkg(text(sms)) ? [roleFirstPkg(text(sms))] : [],
    browser: browserPkg ? [browserPkg] : [],
    assistant: roleFirstPkg(text(assistant)) ? [roleFirstPkg(text(assistant))] : [],
    accessibility: roleAllPkgs(text(accessibility)),
    vpn: roleFirstPkg(text(vpn)) ? [roleFirstPkg(text(vpn))] : []
  };
}
function debloatRoleKeys(pkg) {
  const r = debloatRoles || {};
  return Object.keys(DEBLOAT_ROLE_LABELS).filter(k => Array.isArray(r[k]) && r[k].includes(pkg));
}
function debloatAssessment(pkg, isSystem, isUser) {
  const info = debloatInfo(pkg);
  const roleKeys = debloatRoleKeys(pkg);
  const roles = roleKeys.map(k => DEBLOAT_ROLE_LABELS[k]);
  const roleText = roles.join(', ');
  const base = (info && info.desc) || '';
  const vendor = debloatVendor(pkg);
  if (isUser) {
    if (roleKeys.some(k => DEBLOAT_CRITICAL_ROLES.has(k))) {
      return { level: 'role', label: 'сначала смените роль', desc: (base ? base + ' ' : '') + 'Вы установили это приложение, но сейчас оно выполняет роль: ' + roleText + '. Сначала назначьте замену, иначе эта функция телефона перестанет работать.', disabled: true };
    }
    return { level: 'user', label: 'установлено вами — можно удалить', desc: (base ? base + ' ' : '') + 'Стороннее приложение, не входит в систему. Удаление обратимо: данные сохраняются.' + (roleText ? ' Сейчас выполняет роль: ' + roleText + '.' : ''), disabled: false };
  }
  if (DEBLOAT_CRITICAL.has(pkg)) {
    return { level: 'core', label: 'системный каркас — не отключать', desc: (base ? base + ' ' : '') + 'Критичный системный компонент Android/прошивки. Его отключение может нарушить работу телефона.', disabled: true };
  }
  if (roleKeys.some(k => DEBLOAT_CRITICAL_ROLES.has(k))) {
    return { level: 'role', label: 'сейчас: ' + roleText, desc: (base ? base + ' ' : '') + 'Системное приложение назначено Android на роль «' + roleText + '». Сначала назначьте замену в настройках, иначе телефон потеряет эту функцию.', disabled: true };
  }
  if (roleKeys.length) {
    return { level: 'role-soft', label: 'используется: ' + roleText, desc: (base ? base + ' ' : '') + 'Сейчас выполняет роль «' + roleText + '». Отключение не сломает загрузку, но эта функция перестанет работать.', disabled: false };
  }
  if (info) {
    if (info.safe) return { level: 'safe', label: 'можно отключить', desc: base || 'Системное приложение; отключение обратимо.', disabled: false };
    return { level: 'caution', label: 'лучше не трогать', desc: (base ? base + ' ' : '') + 'Системное приложение с важной функцией; отключайте, только если понимаете последствия.', disabled: false };
  }
  return { level: 'system', label: 'системное, роль не определена', desc: (vendor ? 'Системный пакет ' + vendor + '. ' : 'Системный пакет. ') + 'Назначение автоматически не определено — лучше не трогать.', disabled: false };
}
function debloatRows() {
  if (!appsData) return [];
  const all = [...new Set([...(appsData.user || []), ...(appsData.system || [])])];
  const system = new Set(appsData.system || []);
  const user = new Set(appsData.user || []);
  let rows = debloatTab === 'recommended'
    ? DEBLOAT.filter(d => system.has(d.p)).map(d => d.p)
    : all;
  const q = debloatQuery.trim().toLowerCase();
  if (q) rows = rows.filter(p => {
    const a = debloatAssessment(p, system.has(p), user.has(p));
    return (p + ' ' + debloatName(p) + ' ' + a.label + ' ' + a.desc).toLowerCase().includes(q);
  });
  return rows.sort((a, b) => debloatName(a).localeCompare(debloatName(b), 'ru'));
}
function renderDebloat() {
  if (!appsData) return;
  const rows = debloatRows();
  const box = $('#debloat-list');
  if (!box) return;
  const system = new Set(appsData.system || []);
  const user = new Set(appsData.user || []);
  box.innerHTML = rows.length ? rows.map(p => {
    const a = debloatAssessment(p, system.has(p), user.has(p));
    const name = debloatName(p);
    const size = appsMetaMap[p] && appsMetaMap[p].size ? fmtBytesLong(appsMetaMap[p].size) : '';
    const badge = a.level === 'core' ? '<span class="st-chip st-off">' + esc(a.label) + '</span>'
      : (a.level === 'safe' || a.level === 'user') ? '<span class="st-chip st-active">' + esc(a.label) + '</span>'
        : (a.level === 'role' || a.level === 'role-soft' || a.level === 'caution') ? '<span class="st-chip" style="color:var(--warn)">' + esc(a.label) + '</span>'
          : '<span class="st-chip">' + esc(a.label) + '</span>';
    const id = p.replace(/[^a-z0-9]/gi, '_');
    return `<label class="list-row" style="align-items:flex-start;gap:8px;${a.disabled ? 'opacity:.72' : ''}">
      <input type="checkbox" data-deb="${esc(p)}" ${a.disabled ? 'disabled' : ''}>
      <span class="avatar" id="debav-${id}" style="background:${avatarColor(p)};flex:0 0 auto">${esc(name.charAt(0).toUpperCase())}</span>
      <img id="debico-${id}" data-debico="${esc(p)}" data-debav="debav-${id}" src="" alt="" style="width:32px;height:32px;border-radius:8px;display:none;flex:0 0 auto">
      <span class="grow2" style="min-width:0">
        <span class="app-name">${esc(name)}</span> ${badge}
        <span class="app-pkg muted small">${esc(p)}</span>
        <span class="muted small" style="display:block">${esc(a.desc)}${size ? ' · APK ' + esc(size) : ''}</span>
      </span>
    </label>`;
  }).join('') : '<div class="empty">В этой категории ничего не найдено</div>';
  const cnt = $('#debloat-count');
  if (cnt) cnt.textContent = debloatTab === 'recommended'
    ? 'Рекомендаций: ' + rows.length
    : 'Приложений: ' + rows.length;
  debloatTabButtons();
  loadDebloatIcons();
}
function debloatTabButtons() {
  const rec = $('#debloat-tab-rec'), all = $('#debloat-tab-all');
  if (rec) rec.classList.toggle('active', debloatTab === 'recommended');
  if (all) all.classList.toggle('active', debloatTab === 'all');
}
async function loadDebloatIcons() {
  const s = currentSerial();
  if (!s) return;
  const token = ++debloatIconToken;
  const all = $$('#debloat-list [data-debico]');
  const max = debloatTab === 'all' ? 80 : all.length;
  const els = all.slice(0, max);
  let i = 0;
  const worker = async () => {
    while (i < els.length && token === debloatIconToken) {
      const el = els[i++];
      const pkg = el.dataset.debico;
      try {
        let r = await window.api.appsIconPeek(s, pkg).catch(() => null);
        if (!r || !r.ok || !r.dataUrl) r = await window.api.appsIcon(s, pkg).catch(() => null);
        if (r && r.ok && r.dataUrl && token === debloatIconToken && el.isConnected) {
          el.src = r.dataUrl;
          el.style.display = 'block';
          const av = document.getElementById(el.dataset.debav);
          if (av) av.style.display = 'none';
        }
      } catch (e) {}
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}
async function openDebloat() {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  if (!appsData) await appsLoad();
  if (!appsData) return;
  if (!(appsData.user || []).length && !(appsData.system || []).length) return snack('Список приложений пуст');
  debloatRoles = null;
  debloatTab = 'recommended';
  debloatQuery = '';
  const q = $('#debloat-search'); if (q) q.value = '';
  snack('Проверяю роли Android…');
  await loadDebloatRoles();
  renderDebloat();
  openDlg('dlg-debloat');
}
async function appsLoad() {
  const s = currentSerial(); if (!s) { $('#apps-list').innerHTML = '<div class="empty">Сначала подключите устройство на странице «Подключение».</div>'; return; }
  // имена приложений из кэша подгружаем мгновенно — рисуются сразу (F11)
  try { appLabels = await window.api.appsLabels(s) || {}; } catch (e) { appLabels = {}; }
  appsData = await window.api.appsList(s).catch(() => null) || { ok: false, user: [], system: [], disabled: [] };
  // пустой ответ — чаще всего pm list не успел по медленному Wi-Fi: одна повторная
  // попытка и ЧЕСТНОЕ сообщение, чтобы страница не выглядела «пустой без причины»
  if (appsData && !(appsData.user || []).length && !(appsData.system || []).length) {
    await new Promise(r => setTimeout(r, 1500));
    const again = await window.api.appsList(s).catch(() => null);
    if (again && ((again.user || []).length || (again.system || []).length)) appsData = again;
  }
  appsRender();
  if (!(appsData.user || []).length && !(appsData.system || []).length) {
    $('#apps-list').innerHTML = '<div class="empty">Телефон не вернул список приложений (медленная сеть или экран телефона заблокирован). Нажмите ↽ «Обновить» вверху страницы.</div>';
  }
  // размеры/даты для сортировки — тянем в фоне, потом перерисуем
  const all = Array.from(new Set([...(appsData.user || []), ...(appsData.system || [])]));
  try {
    const m = await window.api.appsMeta(s, all);
    if (m && m.ok) { appsMetaMap = m.meta || {}; if (appsSort !== 'name') appsRender(); }
  } catch (e) {}
  // реальные даты установки — нужны для «последние установленные»
  if (appsSort === 'inst_desc') loadInstallTimes();
}
let installTimesLoading = false;
async function loadInstallTimes() {
  const s = currentSerial(); if (!s || installTimesLoading) return;
  installTimesLoading = true;
  try {
    const r = await window.api.appsInstallTimes(s).catch(() => null);
    if (r && r.ok) { installTimes = r.times || {}; appsRender(); }
  } finally { installTimesLoading = false; }
}
function avatarColor(pkg) {
  let h = 0; for (const c of pkg) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return 'hsl(' + (h % 360) + ',55%,45%)';
}
// ПОИСК ПРИЛОЖЕНИЙ. Раньше искали по пакету и «красивому» имени, но метки
// большинства приложений не загружены (они приходят только с иконкой первых 80) —
// по запросу «Телефон», «ТикТок», «Сбер» ничего не находилось. Теперь: пакет + метка +
// русское имя из словаря + популярные написания, без учёта регистра, пробелов и знаков.
const APP_RU = Object.freeze({
  // системные
  'com.android.dialer': 'Телефон Звонки',
  'com.google.android.dialer': 'Телефон Звонки Google',
  'com.android.contacts': 'Контакты',
  'com.google.android.contacts': 'Контакты Google',
  'com.android.camera': 'Камера',
  'com.google.android.GoogleCamera': 'Камера Google',
  'com.miui.camera': 'Камера',
  'com.android.gallery3d': 'Галерея Фото',
  'com.miui.gallery': 'Галерея Фото',
  'com.google.android.apps.photos': 'Фото Google',
  'com.android.settings': 'Настройки',
  'com.google.android.apps.messaging': 'Сообщения',
  'com.android.mms': 'Сообщения СМС',
  'com.android.deskclock': 'Часы Будильник',
  'com.google.android.deskclock': 'Часы Будильник',
  'com.android.calculator2': 'Калькулятор',
  'com.google.android.calculator': 'Калькулятор',
  'com.miui.calculator': 'Калькулятор',
  'com.android.calendar': 'Календарь',
  'com.google.android.calendar': 'Календарь',
  'com.google.android.gm': 'Почта Gmail',
  'com.android.email': 'Почта',
  'com.android.documentsui': 'Файлы Проводник',
  'com.miui.fileexplorer': 'Файлы Проводник',
  'com.google.android.apps.nbu.files': 'Файлы',
  'com.android.chrome': 'Chrome Браузер',
  'com.google.android.youtube': 'YouTube Ютуб',
  'com.google.android.apps.youtube.music': 'YouTube Музыка',
  'com.google.android.music': 'Музыка',
  'com.miui.player': 'Музыка',
  'com.google.android.videos': 'Видео',
  'com.google.android.apps.maps': 'Карты',
  'com.android.vending': 'Play Маркет Магазин',
  'com.android.browser': 'Браузер',
  'com.android.notes': 'Заметки',
  'com.miui.notes': 'Заметки',
  'com.google.android.keep': 'Заметки Google',
  'com.android.soundrecorder': 'Диктофон',
  'com.miui.voicerecorder': 'Диктофон',
  'com.android.weather': 'Погода',
  'com.miui.weather2': 'Погода',
  'com.miui.home': 'Рабочий стол',
  'com.android.systemui': 'Системный интерфейс',
  'com.android.bluetooth': 'Bluetooth',
  'com.android.nfc': 'NFC',
  'com.miui.securitycenter': 'Безопасность',
  'com.android.printspooler': 'Печать',
  'com.android.vpndialogs': 'VPN',
  'com.google.android.apps.translate': 'Переводчик',
  'com.google.android.apps.docs': 'Google Документы',
  'com.google.android.apps.docs.editors.sheets': 'Google Таблицы',
  'com.google.android.apps.docs.editors.slides': 'Google Презентации',
  'com.android.stk': 'SIM-меню',
  'com.android.emergency': 'Экстренная помощь',
  'com.miui.videoplayer': 'Видео',
  'com.miui.mediaeditor': 'Редактор',
  // популярные
  'org.telegram.messenger': 'Telegram Телеграм Телеграмм',
  'org.telegram.messenger.web': 'Telegram Телеграм',
  'com.whatsapp': 'WhatsApp Ватсап Вотсап',
  'com.whatsapp.w4b': 'WhatsApp Business',
  'com.vkontakte.android': 'ВКонтакте ВК',
  'ru.ok.android': 'Одноклассники ОК',
  'com.instagram.android': 'Instagram Инстаграм',
  'com.facebook.katana': 'Facebook Фейсбук',
  'com.facebook.orca': 'Messenger',
  'com.zhiliaoapp.musically': 'TikTok ТикТок',
  'com.ss.android.ugc.trill': 'TikTok ТикТок',
  'com.zhiliaoapp.musically.go': 'TikTok Lite',
  'ru.sberbankmobile': 'Сбербанк Сбер',
  'com.idamob.tinkoff.android': 'Тинькофф Т-Банк',
  'ru.tinkoff.invest': 'Тинькофф Инвестиции',
  'ru.ozon.app.android': 'Ozon Озон',
  'com.wildberries.ru': 'Wildberries Вайлдберриз',
  'com.aliexpress.buyer': 'AliExpress Алиэкспресс',
  'com.yandex.browser': 'Яндекс Браузер',
  'com.yandex.searchapp': 'Яндекс Поиск',
  'ru.yandex.searchplugin': 'Яндекс Поиск',
  'ru.yandex.androidkeyboard': 'Яндекс Клавиатура',
  'ru.yandex.translate': 'Яндекс Переводчик',
  'ru.yandex.yandexmaps': 'Яндекс Карты',
  'ru.yandex.yandexnavi': 'Яндекс Навигатор',
  'ru.yandex.disk': 'Яндекс Диск',
  'com.yandex.aliceapp': 'Яндекс Алиса',
  'ru.yandex.weatherplugin': 'Яндекс Погода',
  'com.yandex.launcher': 'Яндекс Старт',
  'com.yandex.preinstallsatellite': 'Яндекс Предустановка',
  'com.yandex.shedevrus': 'Шедеврум',
  'com.yandex.toloka.androidapp': 'Яндекс Толока',
  'ru.yandex.mobile.gasstations': 'Яндекс Заправки',
  'ru.yandex.key': 'Яндекс Ключ',
  'com.yandex.music': 'Яндекс Музыка',
  'ru.yandex.taxi': 'Яндекс Go Такси',
  'com.yandex.maps': 'Яндекс Карты',
  'ru.yandex.market': 'Яндекс Маркет',
  'com.avito.android': 'Авито',
  'com.spotify.music': 'Spotify',
  'com.netflix.mediaclient': 'Netflix',
  'com.discord': 'Discord',
  'com.microsoft.teams': 'Teams',
  'com.viber.voip': 'Viber Вайбер',
  'com.imo.android.imoim': 'IMO',
  'com.shazam.android': 'Shazam',
  'ru.mail.mailapp': 'Mail.ru Почта',
  'ru.mail.cloud': 'Облако Mail.ru',
  'com.uma.musicvk': 'VK Музыка',
  'ru.dublgis.dgismobile': '2ГИС',
  'com.google.android.projection.gearhead': 'Android Auto',
  'com.google.android.apps.wellbeing': 'Цифровое благополучие',
  'com.google.android.apps.authenticator2': 'Authenticator',
  'com.google.android.apps.walletnfcrel': 'Google Кошелёк',
  'com.google.android.apps.podcasts': 'Подкасты'
});
// нормализация для поиска: Unicode NFKC, «ё»→«е», без регистра, пробелов, точек и дефисов
function normSearch(s) {
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[\s._\-()/]+/g, '');
}
// Транслитерация нужна, чтобы русский запрос находил латинский пакет:
// «яндекс» → yandex, «телеграм» → telegram, «сбер» → sber.
const RU_TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
};
function translitRu(s) {
  return String(s || '').toLowerCase().replace(/[а-яё]/g, ch => RU_TRANSLIT[ch] != null ? RU_TRANSLIT[ch] : ch).replace(/ks/g, 'x');
}
function appMatches(pkg, q) {
  const nq = normSearch(q);
  if (!nq) return true;
  const nqT = normSearch(translitRu(q));
  const hay = [pkg, appLabels[pkg] || '', APP_RU[pkg] || '', appDisplay(pkg)];
  for (const h of hay) {
    if (!h) continue;
    const nh = normSearch(h);
    if (nh.includes(nq)) return true;
    const ht = normSearch(translitRu(h));
    if (nqT && ht.includes(nqT)) return true;
  }
  return false;
}
// человеческое имя: из APK, иначе из словаря, иначе аккуратная beautification пакета (F11)
function appDisplay(pkg) {
  if (state.config.showPkgNames) return pkg;
  const l = appLabels[pkg] || APP_RU[pkg];
  if (l) return l;
  const short = pkg.replace(/^(com|org|net|ru|io|de|fr|it|pl|uk|cn)\./, '').replace(/[^\w.\-]+/g, '');
  const parts = short.split('.').filter(Boolean);
  const base = (parts[parts.length - 1] || short).replace(/[_\-]+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : pkg;
}
function appSub(pkg) {
  if (state.config.showPkgNames) return appLabels[pkg] || '';
  return pkg;
}
// вкладка процессов — по умолчанию ТОЛЬКО ПОЛЬЗОВАТЕЛЬСКИЕ приложения (жалоба:
// «почему не пользовательские приложения — должны отображаться только нестандартные»),
// список пользовательских пакетов берётся из `pm list packages -3` (флаг user из main).
// Иконки — из кэша (apps:icon-peek — без скачивания APK); если иконки нет — зелёный робот.
let procTab = 'user';
let procIconsRendered = new Set();
let procKillBusy = false; // во время остановки процессы не перерисовываем (гонка с автообновлением)
const PROC_LIMIT = 800;   // было 400 — половина процессов была недоступна кнопкой «Убить»
// иконки процессов — только в памяти. Если иконки нет в памяти, она читается
// напрямую из APK (main держит свою память сессии), на диск ничего не пишется.
const procIconUrl = new Map();   // pkg -> dataUrl
const procIconWait = new Set();  // пакеты, которые уже в очереди
let procIconQ = [], procIconWorkers = 0;
const PROC_ICON_CONC = 2;
function procIconApply(pkg) {
  const url = procIconUrl.get(pkg);
  if (!url) return;
  $$('#apps-list .proc-ico-wrap').forEach(el => {
    if (el.dataset.pkg === pkg) {
      el.innerHTML = '<img src="' + url + '" style="width:24px;height:24px;border-radius:7px;display:block;object-fit:contain" alt="">';
    }
  });
}
function procIconQueue(pkg) {
  if (procIconUrl.has(pkg) || procIconWait.has(pkg)) return;
  procIconWait.add(pkg);
  procIconQ.push(pkg);
  procIconPump();
}
function procIconPump() {
  while (procIconWorkers < PROC_ICON_CONC) {
    const pkg = procIconQ.shift();
    if (!pkg) return;
    const s = currentSerial(); if (!s) { procIconWait.delete(pkg); return; }
    procIconWorkers++;
    window.api.appsIconPeek(s, pkg).then(r => {
      if (r && r.ok && r.dataUrl) {
        procIconUrl.set(pkg, r.dataUrl); procIconWait.delete(pkg);
        procIconApply(pkg); procIconWorkers--; procIconPump(); return;
      }
      // в памяти нет — достаём иконку из APK (без дискового кэша)
      return window.api.appsIcon(s, pkg).then(r2 => {
        if (r2 && r2.ok && r2.dataUrl) { procIconUrl.set(pkg, r2.dataUrl); procIconApply(pkg); }
        procIconWait.delete(pkg); procIconWorkers--; procIconPump();
      });
    }).catch(() => { procIconWait.delete(pkg); procIconWorkers--; procIconPump(); });
  }
}
function app_kill_text(kn) {
  return kn.includes('.')
    ? 'Остановить приложение ' + kn + ' целиком (все его процессы)? Приложение исчезнет из списка и реально закроется.'
    : 'Убить процесс ' + kn + '? Системному процессу shell не имеет права — может не получиться.';
}
let procStatsBusy = false;
async function renderProcStats(serial) {
  const box = $('#proc-stats');
  if (!box) return;
  if (appsTab !== 'procs') { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  if (procStatsBusy) return;
  procStatsBusy = true;
  try {
    const st = await window.api.devStats(serial).catch(() => null);
    if (!st || !st.ok) { box.innerHTML = '<span class="count-chip">Нагрузка: нет данных</span>'; return; }
    const used = Math.max(0, st.total - st.available);
    const pct = st.total ? Math.round(used / st.total * 100) : 0;
    const cpuPct = Math.min(999, Math.round(st.load1 / Math.max(1, st.cpu) * 100));
    box.innerHTML =
      '<span class="count-chip" data-tip="Занято / всего оперативной памяти">ОЗУ: <b>' + fmtBytesLong(used) + '</b> из ' + fmtBytesLong(st.total) + ' · ' + pct + '%</span>' +
      '<span class="count-chip" data-tip="Свободно с учётом кэша (MemAvailable)">Свободно: <b>' + fmtBytesLong(st.available) + '</b></span>' +
      '<span class="count-chip" data-tip="Средняя нагрузка CPU за 1 / 5 / 15 минут">Нагрузка: <b>' + st.load1.toFixed(2) + '</b> / ' + st.load5.toFixed(2) + ' / ' + st.load15.toFixed(2) + '</span>' +
      '<span class="count-chip" data-tip="Загрузка CPU = нагрузка(1 мин) ÷ число ядер">CPU: <b>' + cpuPct + '%</b> · ' + st.cpu + ' яд.</span>';
  } finally { procStatsBusy = false; }
}
async function procsRender() {
  const s = currentSerial();
  if (!s) return;
  renderProcStats(s);
  const r = await window.api.procsList(s);
  const q = ($('#apps-search').value || '').toLowerCase();
  const isApp = x => (x.user != null) ? x.user : /^(com|org|net|ru|io)\./.test(x.name);
  let items = (r.items || []).slice();
  if (procTab === 'user') items = items.filter(x => isApp(x));
  // приложения — наверх; сортировка из селекта (имя/память)
  if (appsSort === 'mem_desc') items.sort((a, b) => (isApp(b) - isApp(a)) || (b.rss - a.rss));
  else items.sort((a, b) => (isApp(b) - isApp(a)) || a.name.localeCompare(b.name));
  // в процессах ищем и по имени пакета, и по метке/словарю (pkg:push → pkg)
  if (q) items = items.filter(x => normSearch(x.name).includes(normSearch(q)) || appMatches(x.name.split(':')[0], q));
  const D = window.PROCDESC || [], FB = window.PROC_FALLBACK || '';
  const descFor = (name) => {
    for (const rule of D) { try { if (new RegExp(rule.re).test(name)) return rule.d; } catch (e) {} }
    return FB;
  };
  const appCount = items.filter(isApp).length;
  // чипы фильтра — «Пользовательские приложения» (по умолчанию) и «Все процессы»
  $('#apps-counts').innerHTML = '<button class="chip' + (procTab === 'user' ? ' view-chip active' : '') + '" id="proc-tab-user" data-tip="Только УСТАНОВЛЕННЫЕ Вами приложения (pm list -3) — системные службы Android скрыты">Пользовательские приложения</button>' +
    '<button class="chip' + (procTab === 'all' ? ' view-chip active' : '') + '" id="proc-tab-all" data-tip="Показать все процессы — и приложения, и системные службы">Все процессы</button>' +
    '<span class="count-chip">Показано: <b>' + Math.min(items.length, PROC_LIMIT) + '</b>' + (items.length > PROC_LIMIT ? ' из ' + items.length : '') + '</span>' +
    '<span class="count-chip cc-user">Приложений: <b>' + appCount + '</b></span>';
  const tabAll = document.getElementById('proc-tab-all'), tabUser = document.getElementById('proc-tab-user');
  if (tabAll) tabAll.onclick = () => { procTab = 'all'; procsRender(); };
  if (tabUser) tabUser.onclick = () => { procTab = 'user'; procsRender(); };
  $('#btn-killall-procs').classList.remove('hidden');
  $('#apps-list').innerHTML = items.slice(0, PROC_LIMIT).map(x => {
    const app = isApp(x);
    const d = descFor(x.name);
    const safeId = 'pico-' + x.name.replace(/[^a-z0-9]/gi, '_') + '-' + x.pid;
    return `<div class="list-row proc-row">
      <span class="proc-ico-wrap" id="${safeId}" data-pkg="${esc(x.name.split(':')[0])}" data-tip="${app ? 'Иконка приложения' : 'Системная служба Android'}">${app
        ? '<img class="proc-android" src="' + window.FSICONS.ANDROID_BADGE + '" alt="">'
        : '<span class="proc-gear">⚙</span>'}</span>
      <span class="mono muted proc-pid">${x.pid}</span>
      <span class="proc-main grow2"><span class="proc-name">${esc(x.name)}</span><span class="proc-desc muted small">${esc(d)}</span></span>
      <span class="muted small proc-rss" data-tip="Память, занятая процессом">${x.rss ? fmtBytes(x.rss * 1024) : '—'}</span>
      ${app ? '<span class="st-chip st-online proc-kind" data-tip="Это процесс приложения">приложение</span>' : '<span class="st-chip st-off proc-kind" data-tip="Системная служба Android — трогать не стоит">система</span>'}
      <button class="btn btn-text btn-sm" data-kill="${x.pid}" data-kname="${esc(x.name)}" data-tip="${app ? 'Остановить приложение ЦЕЛИКОМ (am force-stop) — закроет все его процессы и исчезнет из списка' : 'Принудительно остановить процесс (kill -9)'}">Убить</button>
    </div>`;
  }).join('') || '<div class="empty">Нет процессов</div>';
  $$('#apps-list [data-kill]').forEach(b => b.onclick = async () => {
    if (procKillBusy) return; // двойной клик не должен слать два force-stop
    const kn = b.dataset.kname || ('PID ' + b.dataset.kill);
    // подтверждение с галочкой «Больше не спрашивать» — запоминается навсегда
    const yes = await confirmOnce('confirm.kill', 'Завершить', app_kill_text(kn) + ' (галочку можно поставить один раз — дальше будет останавливать сразу)');
    if (!yes || !yes.ok) return;
    procKillBusy = true;
    b.disabled = true; b.textContent = '…';
    try {
      const res = await window.api.procsKill(s, +b.dataset.kill, b.dataset.kname || '');
if (res.ok) {
        // строка уходит из списка СРАЗУ; список перечитываем ПОСЛЕ завершения, чтобы
        // автообновление не вернуло строку раньше времени
        const row = b.closest('.list-row');
        const rssEl = row && row.querySelector('.proc-rss');
        const rssTxt = rssEl ? rssEl.textContent.trim() : '';
        if (row) row.remove();
        snack('Остановлено: ' + kn + (rssTxt && rssTxt !== '—' ? ' · освобождено памяти: ' + rssTxt : ''));
      } else {
        snack('Не удалось остановить: ' + (res.message || res.error || 'ошибка'));
      }
    } finally {
      procKillBusy = false;
      if (b.isConnected) { b.disabled = false; b.textContent = 'Убить'; }
    }
    if (appsTab === 'procs') procsRender();
  });
  // иконки процессов — из памяти сессии; если там нет, читаем прямо из APK.
  // Не более 40 НОВЫХ пакетов за проход, чтобы автообновление каждые 3 с не забивало канал.
  const pkgSeen = new Set(); let newOnes = 0;
  for (const x of items.slice(0, PROC_LIMIT).filter(isApp)) {
    const pkg = x.name.split(':')[0];
    if (pkgSeen.has(pkg)) continue;
    pkgSeen.add(pkg);
    if (procIconUrl.has(pkg)) { procIconApply(pkg); continue; }
    if (newOnes < 40) { newOnes++; procIconQueue(pkg); }
  }
}
// АВТООБНОВЛЕНИЕ процессов каждые 3 секунды, пока вкладка открыта — запустил приложение
// на телефоне, и оно САМО появляется в списке (раньше надо было переключать вкладки)
let procAutoTimer = null;
let procAutoBusy = false;
function procAutoStart() {
  if (procAutoTimer) return;
  procAutoTimer = setInterval(async () => {
    if (procAutoBusy || document.hidden) return;
    if (appsTab !== 'procs' || !$('#page-apps').classList.contains('active')) return;
    procAutoBusy = true;
    try { await procsRender(); } catch (e) {}
    procAutoBusy = false;
  }, 3000);
}
function appsRender() {
  if (!appsData) return;
  if (appsTab === 'procs') { procsRender(); procAutoStart(); return; }
  $('#btn-killall-procs').classList.add('hidden');
  $('#proc-stats').classList.add('hidden');
  const q = ($('#apps-search').value || '').toLowerCase();
  let list;
  const searchAll = !!q;
  if (searchAll) {
    // запрос ищет по ВСЕМ установленным приложениям — пользовательским,
    // системным и отключённым, независимо от открытой вкладки. Раньше поиск
    // ограничивался текущей вкладкой, поэтому «Яндекс» находил только браузер.
    const seen = new Set(); list = [];
    for (const p of [...(appsData.user || []), ...(appsData.system || []), ...(appsData.disabled || [])]) {
      if (seen.has(p)) continue; seen.add(p); list.push(p);
    }
  } else if (appsTab === 'all') {
    // категория «ВСЕ» — пользовательские и системные в одном месте
    const seen = new Set(); list = [];
    for (const p of [...(appsData.user || []), ...(appsData.system || [])]) {
      if (seen.has(p)) continue; seen.add(p); list.push(p);
    }
  } else {
    list = appsData[appsTab] || [];
    if (appsTab === 'system') list = list.filter(p => !appsData.disabled.includes(p));
  }
  // поиск по пакету, метке, русскому словарю и популярным написаниям
  if (q) list = list.filter(p => appMatches(p, q));
  // сортировка — алфавит / размер / дата (мета подтягивается из apps:meta)
  const metaOf = p => appsMetaMap[p] || null;
  const cmpName = (a, b) => appDisplay(a).localeCompare(appDisplay(b), 'ru');
  // «последние установленные» — по реальной дате firstInstallTime,
  // если её ещё нет — по времени файла APK (mtime), чтобы сортировка не была пустой
  const instOf = p => installTimes[p] || (metaOf(p) || {}).mtime || 0;
  if (appsSort === 'inst_desc') list = list.slice().sort((a, b) => instOf(b) - instOf(a) || cmpName(a, b));
  else if (appsSort === 'size_desc') list = list.slice().sort((a, b) => ((metaOf(b) || {}).size || 0) - ((metaOf(a) || {}).size || 0) || cmpName(a, b));
  else if (appsSort === 'size_asc') list = list.slice().sort((a, b) => ((metaOf(a) || {}).size || 0) - ((metaOf(b) || {}).size || 0) || cmpName(a, b));
  else if (appsSort === 'date_desc') list = list.slice().sort((a, b) => ((metaOf(b) || {}).mtime || 0) - ((metaOf(a) || {}).mtime || 0) || cmpName(a, b));
  else if (appsSort === 'date_asc') list = list.slice().sort((a, b) => ((metaOf(a) || {}).mtime || 0) - ((metaOf(b) || {}).mtime || 0) || cmpName(a, b));
  else list = list.slice().sort(cmpName);
  // ОДИН компактный счётчик вместо четырёх дублирующих полей (F14 упрощён)
  const cnt = {
    all: new Set([...(appsData.user || []), ...(appsData.system || []), ...(appsData.disabled || [])]).size,
    user: (appsData.user || []).length,
    system: (appsData.system || []).length,
    disabled: (appsData.disabled || []).length
  };
  const tabLabel = q ? 'Найдено' : ({ all: 'Всего', user: 'Пользовательских', system: 'Системных', disabled: 'Отключённых' }[appsTab]);
  const countVal = q ? list.length : (cnt[appsTab] || 0);
  $('#apps-counts').innerHTML = '<span class="count-chip">' + tabLabel + ': <b>' + countVal + '</b></span>' +
    (q ? '<span class="muted small">поиск по всем приложениям</span>' : '') +
    (appsSort !== 'name' && !Object.keys(appsMetaMap).length ? '<span class="muted small">загружаю размеры…</span>' : '');
  $('#apps-list').innerHTML = list.slice(0, 2000).map(p => {
    const dis = appsData.disabled.includes(p);
    const shown = appDisplay(p);
    const sub = appSub(p);
    return `<div class="list-row">
      <input type="checkbox" data-bak="${esc(p)}" data-tip="Выбрать для резервной копии">
      <span class="avatar" data-appicon="${esc(p)}" style="background:${avatarColor(p)}" id="av-${esc(p).replace(/[^a-z0-9]/gi, '_')}">${esc(shown.charAt(0).toUpperCase())}</span>
      <span class="grow2 app-line"><span class="app-name">${esc(shown)}</span>${dis ? ' <span class="muted small">(отключено)</span>' : ''}${sub && sub !== shown ? '<span class="app-pkg muted small">' + esc(sub) + '</span>' : ''}</span>
      ${sortMetaInfo(p)}
      ${dis ? '<button class="btn btn-text btn-sm" data-appenable="' + esc(p) + '" data-tip="Включить приложение обратно">Включить</button>'
        : '<button class="btn btn-text btn-sm" data-apprun="' + esc(p) + '" data-tip="Запустить приложение на телефоне прямо сейчас">▶</button>'
          + '<button class="btn btn-text btn-sm" data-appstop="' + esc(p) + '" data-tip="Остановить приложение на телефоне (am force-stop) — закроет все его процессы">■</button>'}
      <button class="btn btn-tonal btn-sm" data-appinfo="${esc(p)}">Свойства</button>
    </div>`;
  }).join('') || '<div class="empty">Ничего не найдено</div>';
  $$('#apps-list [data-appinfo]').forEach(b => b.onclick = () => openAppInfo(b.dataset.appinfo));
  // «Запустить» прямо из списка — команда уходит на телефон, приложение открывается там
  $$('#apps-list [data-apprun]').forEach(b => b.onclick = async () => {
    const r = await window.api.appsRun(currentSerial(), b.dataset.apprun);
    snack(r.ok ? 'Запущено на телефоне: ' + appDisplay(b.dataset.apprun) : 'Не удалось запустить: ' + (r.message || r.error || ''));
  });
  // «Остановить» — принудительная остановка прямо из списка
  $$('#apps-list [data-appstop]').forEach(b => b.onclick = async () => {
    const pkg = b.dataset.appstop;
    const r = await window.api.appsAction(currentSerial(), 'forceStop', pkg);
    snack(r.ok ? 'Остановлено на телефоне: ' + appDisplay(pkg) : 'Не удалось остановить: ' + (r.message || r.error || ''));
  });
  // удалённые для пользователя приложения больше не выводятся — возврат не нужен
  $$('#apps-list [data-appenable]').forEach(b => b.onclick = async () => {
    const pkg = b.dataset.appenable;
    const r = await window.api.appsAction(currentSerial(), 'enable', pkg);
    snack(r.ok ? 'Включено: ' + appDisplay(pkg) : 'Не удалось: ' + (r.message || r.error || ''));
    appsLoad();
  });
  // правый клик по строке — контекстное меню действий с приложением
  $$('#apps-list .list-row').forEach(row => {
    row.addEventListener('contextmenu', (e) => {
      const btn = row.querySelector('[data-appinfo]');
      if (!btn) return;
      e.preventDefault();
      openAppCtx(btn.dataset.appinfo, e.clientX, e.clientY);
    });
  });
  observeAppIcons();             // иконки грузятся по мере прокрутки, а не только первые 120
  appsBatchUpdate();             // после перерисовки список галочек пуст — прячем пакетные кнопки
}
/* контекстное меню приложения (правый клик) — запуск, остановка, свойства,
   копирование пакета, отключение/включение, очистка кэша, удаление */
let appCtxEl = null;
function closeAppCtx() { if (appCtxEl) { appCtxEl.remove(); appCtxEl = null; } }
function openAppCtx(pkg, x, y) {
  closeAppCtx();
  const dis = !!(appsData && (appsData.disabled || []).includes(pkg));
  const el = document.createElement('div');
  el.className = 'fs-ctx app-ctx';
  el.innerHTML =
'<div class="app-ctx-title">' + esc(appDisplay(pkg)) + '</div>' +
    '<button class="fs-ctx-item" data-c="run">▶ Запустить</button>' +
    '<button class="fs-ctx-item" data-c="stop">■ Остановить</button>' +
    '<button class="fs-ctx-item" data-c="info">ⓘ Свойства (здесь)</button>' +
    '<button class="fs-ctx-item" data-c="crashes">⚠ Показать сбои (логи)</button>' +
    '<button class="fs-ctx-item" data-c="phoneInfo" data-tip="Открыть страницу приложения в настройках ТЕЛЕФОНА">📱 Свойства на телефоне</button>' +
    '<button class="fs-ctx-item" data-c="save">💾 Сохранить приложение…</button>' +
    '<button class="fs-ctx-item" data-c="copy">⧉ Копировать имя пакета</button>' +
    '<div class="fs-ctx-sep"></div>' +
    '<button class="fs-ctx-item" data-c="' + (dis ? 'enable' : 'disable') + '">' + (dis ? 'Включить' : 'Отключить') + '</button>' +
    '<button class="fs-ctx-item" data-c="clearCache">Очистить кэш</button>' +
    '<div class="fs-ctx-sep"></div>' +
    '<button class="fs-ctx-item danger" data-c="uninstall">Удалить приложение</button>';
  document.body.appendChild(el);
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
  el.querySelectorAll('[data-c]').forEach(b => b.onclick = async () => {
    const c = b.dataset.c;
    closeAppCtx();
    await appCtxRun(pkg, c);
  });
  appCtxEl = el;
}
async function appCtxRun(pkg, act) {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  if (act === 'copy') return copyText(pkg);
  if (act === 'info') return openAppInfo(pkg);
  if (act === 'crashes') return openCrashLog(pkg);
  if (act === 'phoneInfo') {
    const r = await window.api.appsAction(s, 'phoneInfo', pkg);
    return snack(r.ok ? 'Открыл страницу «' + appDisplay(pkg) + '» в настройках телефона' : 'Не удалось открыть на телефоне: ' + ((r.message || r.error || '').slice(0, 160) || 'ошибка'));
  }
  if (act === 'save') {
    const r = await window.api.appsSaveApk(s, pkg, appDisplay(pkg));
    if (r && r.ok) return snack('Сохранено: ' + r.path);
    if (r && r.canceled) return;
    return snack('Не удалось сохранить: ' + ((r && r.error) || 'ошибка'));
  }
  if (act === 'run') {
    const r = await window.api.appsRun(s, pkg);
    return snack(r.ok ? 'Запущено на телефоне: ' + appDisplay(pkg) : 'Не удалось запустить: ' + (r.message || r.error || ''));
  }
  if (act === 'stop') {
    const r = await window.api.appsAction(s, 'forceStop', pkg);
    snack(r.ok ? 'Остановлено: ' + appDisplay(pkg) : 'Не удалось остановить: ' + (r.message || r.error || ''));
    if (appsTab === 'procs') procsRender();
    return;
  }
  if (act === 'uninstall') {
    const yes = await uiConfirm('Удаление приложения', 'Удалить «' + appDisplay(pkg) + '» (' + pkg + ')? Действие необратимо.');
    if (!yes || !yes.ok) return;
  }
const r = await window.api.appsAction(s, act, pkg);
  const msg = (r.message || r.error || '').split('\n')[0].slice(0, 220);
  snack(r.ok ? 'Готово: ' + appDisplay(pkg) : 'Не удалось: ' + (msg || 'ошибка'), 7000);
  appsLoad();
}
document.addEventListener('click', closeAppCtx);
/* spotlight на карточках (эффект в духе ReactBits) — позиция курсора в CSS-переменных */
document.addEventListener('mousemove', (e) => {
  const card = e.target && e.target.closest ? e.target.closest('.card') : null;
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
  card.style.setProperty('--my', (e.clientY - r.top) + 'px');
}, { passive: true });
/* крестик очистки внутри любого текстового поля (delegated) */
function attachInputClear(input) {
  if (!input || input.dataset.icDone) return;
  const parent = input.parentElement;
  if (!parent || parent.querySelector('.ic-clear')) return;
  input.dataset.icDone = '1';
  parent.classList.add('ic-wrap');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ic-clear';
  btn.textContent = '\u2715';
  btn.setAttribute('data-tip', 'Очистить поле');
  btn.addEventListener('click', () => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    btn.classList.remove('show');
    input.focus();
  });
  parent.appendChild(btn);
  const upd = () => btn.classList.toggle('show', !!input.value);
  input.addEventListener('input', upd, { passive: true });
  input.addEventListener('keyup', upd, { passive: true });
  upd();
}
document.addEventListener('focusin', (e) => {
  const t = e.target;
  if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) return;
  if (t.type && !/text|search|url|tel/.test(t.type)) return;
  attachInputClear(t);
});
/* салют по клику на автора (фейерверк на весь экран) */
let saluteRAF = 0;
function runSalute() {
  const layer = $('#salute-layer'), cv = $('#salute-canvas');
  if (!layer || !cv) return;
  layer.classList.remove('hidden');
  const W = window.innerWidth, H = window.innerHeight;
  cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio;
  const ctx = cv.getContext('2d');
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const parts = [];
  const colors = ['#ff5a5a', '#ffd166', '#4be1c4', '#5a8bff', '#c58bff', '#ff9de2', '#fff'];
  function burst(x, y, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 5.5;
      parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5, life: 1, dec: 0.012 + Math.random() * 0.014, c: colors[(Math.random() * colors.length) | 0], sz: 1.6 + Math.random() * 2.4 });
    }
  }
  const START = (Math.random() * 0.6 + 0.5) * 1000;
  const t0 = performance.now();
  function frame(now) {
    const t = (now - t0) / 1000;
    if (t < 0.6) burst(W * 0.3 + Math.random() * W * 0.4, H * 0.2 + Math.random() * H * 0.35, 50);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.x += p.vx; p.y += p.vy; p.vy += 0.08; p.life -= p.dec;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.c;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.sz * p.life, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (t < 3.2 && parts.length) { saluteRAF = requestAnimationFrame(frame); }
    else { setTimeout(() => { layer.classList.add('hidden'); }, 600); saluteRAF = 0; }
  }
  cancelAnimationFrame(saluteRAF);
  saluteRAF = requestAnimationFrame(frame);
}
const _saluteEl = document.querySelector('.rail-author');
if (_saluteEl) _saluteEl.addEventListener('click', (e) => { e.stopPropagation(); runSalute(); });
window.addEventListener('resize', closeAppCtx);
document.addEventListener('scroll', closeAppCtx, true);
// при сортировке по размеру/дате показываем значение в строке
function sortMetaInfo(p) {
  const m = appsMetaMap[p];
  // для «последние установленные» показываем реальную дату установки
  if (appsSort === 'inst_desc') return '<span class="muted small" style="flex:0 0 110px;text-align:right">' + (installTimes[p] ? fmtTs(installTimes[p]) : '—') + '</span>';
  if (!m || appsSort === 'name') return '';
  if (appsSort.startsWith('size')) return '<span class="muted small" style="flex:0 0 84px;text-align:right">' + fmtBytes(m.size || 0) + '</span>';
  if (appsSort.startsWith('date')) return '<span class="muted small" style="flex:0 0 110px;text-align:right">' + (m.mtime ? fmtTs(m.mtime) : '—') + '</span>';
  return '';
}

/* очередь родных иконок + имён: параллельность 3, негативный кэш в main, фолбэк — буква-аватар (R12/F11).
   W5-ревизор: inFlight-множество — повторный рендер списка не запускает ВТОРОЙ pull того же APK */
const iconQueue = [];
let iconRunning = 0;
const iconInFlight = new Set();
const ICON_CONCURRENCY = 4; // 
function queueIcons(pkgs) {
  iconQueue.length = 0;
  iconQueue.push(...pkgs);
  for (let i = 0; i < ICON_CONCURRENCY; i++) iconPump();
}
function iconPump() {
  if (iconRunning >= ICON_CONCURRENCY) return;
  const pkg = iconQueue.shift();
  if (!pkg) return;
  if (iconInFlight.has(pkg)) { iconPump(); return; }
  iconRunning++;
  iconInFlight.add(pkg);
  const el = document.getElementById('av-' + pkg.replace(/[^a-z0-9]/gi, '_'));
  if (!el || el.dataset.loaded) { iconRunning--; iconInFlight.delete(pkg); iconPump(); return; }
  window.api.appsIcon(currentSerial(), pkg).then(r => {
    iconRunning--;
    iconInFlight.delete(pkg);
    if (r && r.label && appLabels[pkg] !== r.label) {
      appLabels[pkg] = r.label;
      // обновляем надпись строки, если ещё показываем старую beautification
      const line = document.querySelector('#apps-list [data-appinfo="' + (window.CSS && window.CSS.escape ? window.CSS.escape(pkg) : pkg) + '"]');
      if (line) { const row = line.closest('.list-row'); if (row) { const nm = row.querySelector('.app-name'); const pk = row.querySelector('.app-pkg'); if (nm && !state.config.showPkgNames) nm.textContent = r.label; if (pk) pk.textContent = state.config.showPkgNames ? (appLabels[pkg] || '') : pkg; } }
    }
    const el2 = document.getElementById('av-' + pkg.replace(/[^a-z0-9]/gi, '_'));
    if (r && r.ok && el2) {
      el2.dataset.loaded = '1';
      const img = document.createElement('img');
      img.src = r.dataUrl;
      img.alt = '';
      img.style.cssText = 'width:30px;height:30px;border-radius:8px;display:block';
      img.onerror = () => { el2.innerHTML = esc(appDisplay(pkg).charAt(0).toUpperCase()); el2.style.background = avatarColor(pkg); };
      el2.innerHTML = '';
      el2.appendChild(img);
      el2.style.background = 'transparent';
    }
    // неудача: остаётся аккуратная буква-аватар — «сломанной картинки» не бывает (R12)
    iconPump();
  }).catch(() => { iconRunning--; iconInFlight.delete(pkg); iconPump(); });
}
// иконки для ВСЕХ видимых строк, а не только первых 120. Раньше Яндекс Карты,
// Клавиатура и другие приложения в конце алфавита оставались с буквой вместо иконки.
let appIconObs = null;
function enqueueIcon(pkg) {
  if (!pkg || iconInFlight.has(pkg) || iconQueue.includes(pkg)) return;
  const el = document.getElementById('av-' + pkg.replace(/[^a-z0-9]/gi, '_'));
  if (el && el.dataset.loaded) return;
  iconQueue.push(pkg);
  for (let i = 0; i < ICON_CONCURRENCY; i++) iconPump();
}
function observeAppIcons() {
  if (appIconObs) { appIconObs.disconnect(); appIconObs = null; }
  const avatars = Array.from(document.querySelectorAll('#apps-list .avatar[data-appicon]'));
  if (!avatars.length) return;
  if (!('IntersectionObserver' in window)) {
    queueIcons(avatars.map(el => el.dataset.appicon));
    return;
  }
  const root = document.getElementById('content');
  appIconObs = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const el = en.target;
      if (appIconObs) appIconObs.unobserve(el);
      enqueueIcon(el.dataset.appicon);
    }
  }, { root: root || null, rootMargin: '300px' });
  avatars.forEach(el => appIconObs.observe(el));
}

$$('[data-apptab]').forEach(t => t.onclick = () => {
  $$('[data-apptab]').forEach(x => x.classList.toggle('active', x === t));
  appsTab = t.dataset.apptab; appsRender();
});
$('#apps-sort').onchange = () => {
  appsSort = $('#apps-sort').value;
  appsRender();
  // датам установки нужно время на сбор — подгружаем при выборе этого пункта
  if (appsSort === 'inst_desc') loadInstallTimes();
};
// «Завершить все приложения» — по АКТИВНОЙ вкладке:
//  «Пользовательские приложения» — мягкий am kill фоновых процессов ваших приложений;
//  «Все процессы» — принудительный am force-stop всех процессов-приложений (системные
//  службы Android вроде system_server/systemui не трогаем, иначе телефон «уедет»).
$('#btn-killall-procs').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  if (!appsData) await appsLoad();
  const userSet = new Set(appsData ? appsData.user || [] : []);
  const r1 = await window.api.procsList(s);
  const names = (r1.items || []).map(x => x.name);
  const CRIT = new Set(['android', 'com.android.systemui', 'com.android.phone', 'com.android.bluetooth', 'com.android.nfc']);
  let running, mode;
  if (procTab === 'all') {
    mode = 'all';
    running = [...new Set(names.filter(n => n.includes('.') && !CRIT.has(n.split(':')[0])))];
  } else {
    mode = 'user';
    running = [...new Set(names.filter(n => userSet.has(n) || userSet.has(n.split(':')[0])))];
  }
  if (!running.length) return snack(procTab === 'all' ? 'Процессов-приложений сейчас нет' : 'Процессов пользовательских приложений сейчас нет');
  const title = procTab === 'all' ? 'Завершить ВСЕ процессы-приложения' : 'Завершить все пользовательские приложения';
  const text = procTab === 'all'
    ? 'Принудительно остановить ' + running.length + ' процессов-приложений со вкладки «Все процессы»? Приложения закроются полностью, несохранённые данные могут пропасть. Системные службы Android не трогаем.'
    : 'Мягко завершить фоновые процессы ' + running.length + ' пользовательских приложений? (am kill — несохранённые данные не страдают, foreground-приложения не трогаем)';
  const yes = await uiConfirm(title, text);
  if (!yes || !yes.ok) return;
  snack('Завершаю ' + running.length + ' приложений…');
  const res = await window.api.procsKillApps(s, running, mode);
  snack(res.message || ('Готово: обработано ' + (res.killed || 0) + ' из ' + (res.total || 0)));
  procsRender();
};
$$('#apps-search').length; void 0;
$('#apps-search').oninput = appsRender;
$('#btn-apps-refresh').onclick = appsLoad;
// F11: переключатель «имена приложений ⟷ пакеты» (сохраняется в настройках)
$('#btn-apps-names').onclick = async () => {
  state.config.showPkgNames = !state.config.showPkgNames;
  await window.api.setSetting('showPkgNames', state.config.showPkgNames);
  appsRender();
  snack(state.config.showPkgNames ? 'Показываю имена пакетов' : 'Показываю имена приложений');
};
async function openAppInfo(pkg) {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  $('#appinfo-title').textContent = appDisplay(pkg);
  $('#appinfo-sub').textContent = pkg;
  $('#appinfo-body').innerHTML = '<div>Загрузка…</div>';
  openDlg('dlg-appinfo');
  const [raw, pathR, perms] = await Promise.all([
    window.api.fsCmd(s, ['dumpsys', 'package', pkg]),
    window.api.fsCmd(s, ['pm', 'path', pkg]),
    window.api.appsPerms(s, pkg)
  ]);
  const t = raw.stdout || '';
  const grab = re => (t.match(re) || [])[1] || '';
  const apk = (pathR.stdout.match(/package:(\S+)/) || [])[1] || '';
  let size = '';
  if (apk) { const st = await window.api.fsCmd(s, ['stat', '-c', '%s', apk]); size = (st.stdout || '').trim(); }
  const rows = [
    ['Версия', grab(/versionName=([\w.\-]+)/) + ' (' + grab(/versionCode=(\d+)/) + ')'],
    ['Путь APK', apk], ['Размер APK', size ? (size / 1048576).toFixed(1) + ' МБ' : '—'],
    ['Установлено', grab(/firstInstallTime=([^\r\n]+)/)],
    ['Обновлено', grab(/lastUpdateTime=([^\r\n]+)/)],
    ['Установщик', grab(/installerPackageName=([\w.]+)/) || '—'],
    ['Каталог данных', grab(/dataDir=([^\r\n]+)/)]
  ];
  $('#appinfo-body').innerHTML = rows.map(r => '<div><b>' + esc(r[0]) + ':</b> ' + esc(r[1] || '—') + '</div>').join('');
  const pb = $('#appinfo-perms');
  // F12: разрешения — СЕТКОЙ: имя переносится внутри своей колонки, кнопки стоят
  // ровно колонкой справа и никуда не «задвигаются»
  const permsHtml = (perms.perms || []).map((p, i) => `<div class="perm-row">
      <span class="perm-name mono small" data-tip="${esc(p.perm)}">${esc(p.perm)}</span>
      <span class="perm-state ${p.granted ? 'on' : 'off'}">${p.granted ? 'разрешено' : 'запрещено'}</span>
      <button class="btn btn-text btn-sm" data-perm="${i}" data-tip="${p.granted ? 'Отозвать разрешение у приложения (pm revoke)' : 'Выдать разрешение приложению (pm grant)'}">${p.granted ? 'Запретить' : 'Разрешить'}</button>
    </div>`).join('') || '<div class="empty">Разрешений не найдено</div>';
  pb.innerHTML = '<button class="btn btn-tonal btn-sm" id="perms-toggle" style="margin-bottom:8px">Показать разрешения (' + (perms.perms || []).length + ')</button><div id="perms-body" class="hidden"><div class="perm-head"><span>Разрешение</span><span>Состояние</span><span></span></div>' + permsHtml + '</div>';
  pb.querySelector('#perms-toggle').onclick = () => {
    const body = pb.querySelector('#perms-body');
    body.classList.toggle('hidden');
    pb.querySelector('#perms-toggle').textContent = (body.classList.contains('hidden') ? 'Показать' : 'Скрыть') + ' разрешения (' + (perms.perms || []).length + ')';
  };
  pb.querySelectorAll('[data-perm]').forEach(b => b.onclick = async () => {
    const p = perms.perms[+b.dataset.perm];
    const r = await window.api.appsPerm(s, p.granted ? 'revoke' : 'grant', pkg, p.perm);
    snack(r.ok ? 'Обновлено: ' + p.perm : ('Ошибка: ' + (r.message || '')));
    openAppInfo(pkg);
  });
  const dis = !!(appsData && (appsData.disabled || []).includes(pkg));
  // F12: понятные подписи + тултип у каждой кнопки; добавлены «Очистить кэш» и
  // «Удалить приложение» (полное удаление вместо прежнего загадочного «Удалить (юзер)»)
  $('#appinfo-title').textContent = appDisplay(pkg);
  $('#appinfo-sub').textContent = pkg;
  // + «Запустить» — приложение открывается на телефоне немедленно
  $('#appinfo-actions').innerHTML = `
    ${dis ? '' : '<button class="btn btn-filled btn-sm" data-act="run" data-tip="Запустить приложение на телефоне прямо сейчас">▶ Запустить</button>'}
    <button class="btn btn-tonal btn-sm" data-act="${dis ? 'enable' : 'disable'}" data-tip="${dis ? 'Включить отключённое приложение обратно' : 'Отключить приложение без удаления — его не будет в меню, данные останутся'}">${dis ? 'Включить' : 'Отключить'}</button>
    <button class="btn btn-tonal btn-sm" data-act="clearCache" data-tip="Очистить только кэш приложения, данные и настройки останутся (Android 13+)">Очистить кэш</button>
    <button class="btn btn-tonal btn-sm" data-act="clear" data-tip="Удалить ВСЕ данные приложения: настройки, входы в аккаунты, базы — приложение станет как после установки">Очистить данные</button>
    <button class="btn btn-tonal btn-sm" data-act="forceStop" data-tip="Принудительно закрыть все процессы приложения">Остановить</button>
    <button class="btn btn-tonal btn-sm" data-act="crashes" data-tip="Последние падения и ANR этого приложения: полный стек, время, PID и копирование отчёта">⚠ Сбои (логи)</button>
    <button class="btn btn-tonal btn-sm" data-act="audit" data-tip="Аудит доступов: опасные разрешения, AppOps, источник установки и предупреждения">🛡 Аудит доступов</button>
    ${dis ? '<button class="btn btn-tonal btn-sm" data-act="restore" data-tip="Вернуть отключённое приложение на место">Восстановить</button>' : ''}
    <button class="btn btn-tonal btn-sm btn-danger-tonal" data-act="uninstall" data-tip="Полностью УДАЛИТЬ приложение с телефона (для всех пользователей)">Удалить приложение</button>
    <button class="btn btn-text btn-sm" data-close="dlg-appinfo">Закрыть</button>`;
  $$('#appinfo-actions [data-act]').forEach(b => b.onclick = async () => {
    const act = b.dataset.act;
    if (act === 'crashes') { closeDlg('dlg-appinfo'); openCrashLog(pkg); return; }
    if (act === 'audit') { closeDlg('dlg-appinfo'); openAppAudit(pkg); return; }
    // владелец попросил БЕЗ внешних окон: «нажал очистить или удалить — значит сразу
    // выполняет». Единственное подтверждение, которое осталось — ПОЛНОЕ удаление, и то с
    // галочкой «Больше не спрашивать» (один раз — дальше сразу).
    const confirmMap = {
      uninstall: () => confirmOnce('confirm.uninstall', 'Удаление приложения', 'ПОЛНОСТЬЮ удалить приложение ' + pkg + ' с телефона?'),
      removeUser: () => confirmOnce('confirm.removeUser', 'Удаление приложения', 'Удалить приложение ' + pkg + ' для текущего пользователя? (данные останутся, можно восстановить)')
    };
    if (confirmMap[act]) {
      const yes = await confirmMap[act]();
      if (!yes || !yes.ok) return;
    }
    b.disabled = true; b.textContent = '…';
    let r;
    if (act === 'run') r = await window.api.appsRun(s, pkg);
    else r = await window.api.appsAction(s, act, pkg);
    b.disabled = false; b.textContent = act === 'run' ? '▶ Запустить' : ({ clear: 'Очистить данные', clearCache: 'Очистить кэш', disable: 'Отключить', enable: 'Включить', forceStop: 'Остановить', uninstall: 'Удалить приложение', restore: 'Восстановить', removeUser: 'Удалить (юзер)' }[act] || 'Выполнить');
    snack(r.ok ? (act === 'run' ? 'Запущено на телефоне' : 'Готово: ' + (act === 'uninstall' ? 'приложение удалено' : '')) : ('Ошибка: ' + (r.message || r.error || '')));
    if (r.ok && (act === 'uninstall' || act === 'removeUser')) { closeDlg('dlg-appinfo'); appsLoad(); return; }
    if (r.ok && act !== 'clearCache' && act !== 'run') { closeDlg('dlg-appinfo'); appsLoad(); return; }
    if (r.ok && act === 'clearCache') openAppInfo(pkg);
  });
  $$('#appinfo-actions [data-close]').forEach(b => b.onclick = () => closeDlg('dlg-appinfo'));
}

/* сбои конкретного приложения — Java-краши, ANR и native из logcat.
   Ничего не устанавливается: читаем crash/main буферы через adb. */
let crashCtx = { pkg: '', serial: '', items: [], sel: 0 };
const CRASH_LABELS = { java: 'Java-краш', anr: 'ANR', native: 'Native', error: 'Ошибки' };
async function openCrashLog(pkg) {
  const s = currentSerial();
  if (!s) return snack('Нет устройства');
  crashCtx = { pkg, serial: s, items: [], sel: 0 };
  $('#crashlog-title').textContent = 'Сбои: ' + appDisplay(pkg);
  $('#crashlog-sub').textContent = pkg;
  $('#crashlog-list').innerHTML = '<div class="muted small" style="padding:8px">Читаю logcat…</div>';
  $('#crashlog-view').textContent = '';
  $('#crashlog-count').textContent = '';
  openDlg('dlg-crashlog');
  await loadCrashLog();
}
async function loadCrashLog() {
  const { pkg, serial } = crashCtx;
  if (!pkg || !serial) return;
  const r = await window.api.appsCrashes(serial, pkg, { limit: 30 }).catch(() => null);
  if (crashCtx.pkg !== pkg) return;
  if (!r || !r.ok) {
    crashCtx.items = [];
    $('#crashlog-list').innerHTML = '<div class="empty">Не удалось прочитать: ' + esc((r && (r.error || r.message)) || 'ошибка') + '</div>';
    $('#crashlog-view').textContent = '';
    return;
  }
  crashCtx.items = r.items || [];
  renderCrashLog(r);
}
function renderCrashLog(r) {
  const items = crashCtx.items;
  $('#crashlog-count').textContent = items.length ? ('Найдено: ' + items.length) : '';
  const list = $('#crashlog-list');
  if (!items.length) {
    list.innerHTML = '<div class="empty">' + esc((r && r.note) || 'Сбоев не найдено. Запустите приложение и обновите.') + '</div>';
    $('#crashlog-view').textContent = '';
    return;
  }
  list.innerHTML = items.map((it, i) => `<button class="list-row crash-row" data-ci="${i}" style="width:100%;text-align:left;cursor:pointer">
    <span class="mono small" style="flex:0 0 auto">${esc(it.time || '')}</span>
    <span class="crash-badge crash-${esc(it.type || 'error')}">${esc(CRASH_LABELS[it.type] || it.type || '')}</span>
    <span class="grow2" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.title || '')}</span>
    <span class="muted small" style="flex:0 0 auto">PID ${esc(it.pid || '')}</span>
  </button>`).join('');
  list.querySelectorAll('[data-ci]').forEach(b => b.onclick = () => selectCrash(+b.dataset.ci, true));
  selectCrash(0);
}
function selectCrash(i, scroll) {
  const it = crashCtx.items[i]; if (!it) return;
  crashCtx.sel = i;
  $('#crashlog-list').querySelectorAll('[data-ci]').forEach(b => b.classList.toggle('active', +b.dataset.ci === i));
  $('#crashlog-view').textContent = it.text || '';
  if (scroll) $('#crashlog-view').scrollTop = 0;
}
function crashReportText() {
  const { pkg, serial, items } = crashCtx;
  const head = 'MultiTool — сбои приложения\nУстройство: ' + serial + '\nПакет: ' + pkg + '\nЗаписей: ' + items.length + '\n';
  return head + items.map((it, i) => `\n===== ${i + 1}. ${it.time || ''} · ${it.type || ''} · PID ${it.pid || ''} =====\n${it.title || ''}\n${it.text || ''}`).join('\n');
}
$('#btn-crash-refresh').onclick = () => loadCrashLog();
$('#btn-crash-copy').onclick = () => {
  if (!crashCtx.items.length) return snack('Нечего копировать');
  copyText(crashReportText().slice(0, 400000));
};
$('#btn-crash-clear').onclick = async () => {
  const s = crashCtx.serial || currentSerial();
  if (!s) return snack('Нет устройства');
  const yes = await uiConfirm('Очистка логов на телефоне',
    'Полностью очистить журналы logcat на телефоне? Будут удалены сбои и логи всех приложений, не только этого.');
  if (!yes || !yes.ok) return;
  const r = await window.api.appsClearCrashes(s).catch(() => null);
  if (!r || !r.ok) {
    return snack('Не удалось очистить логи: ' + ((r && (r.error || r.message)) || 'ошибка'));
  }
  crashCtx.items = [];
  $('#crashlog-count').textContent = '';
  $('#crashlog-view').textContent = '';
  renderCrashLog({ note: 'Журналы logcat на телефоне очищены. Запустите приложение и нажмите «Обновить».' });
  snack('Журналы logcat на телефоне очищены', 5000);
};

/* аудит разрешений и AppOps приложения */
let auditCtx = { pkg: '', serial: '', data: null };
const OP_MODE_LABEL = { allow: 'разрешено', deny: 'запрещено', ignore: 'игнорируется', default: 'по умолчанию', foreground: 'только в фоне' };
async function openAppAudit(pkg) {
  const s = currentSerial();
  if (!s) return snack('Нет устройства');
  auditCtx = { pkg, serial: s, data: null };
  $('#appaudit-title').textContent = 'Аудит: ' + appDisplay(pkg);
  $('#appaudit-sub').textContent = pkg;
  $('#appaudit-summary').innerHTML = '';
  $('#appaudit-warnings').textContent = 'Читаю разрешения и AppOps…';
  $('#appaudit-perms').innerHTML = '';
  $('#appaudit-ops').innerHTML = '';
  openDlg('dlg-appaudit');
  const r = await window.api.appsAudit(s, pkg).catch(() => null);
  if (auditCtx.pkg !== pkg) return;
  if (!r || !r.ok) { $('#appaudit-warnings').textContent = 'Не удалось прочитать: ' + ((r && (r.error || r.message)) || 'ошибка'); return; }
  auditCtx.data = r;
  renderAppAudit(r);
}
function renderAppAudit(r) {
  const info = r.info || {};
  const summ = r.summary || {};
  $('#appaudit-summary').innerHTML = [
    'targetSdk: ' + (info.targetSdk || '—'),
    'разрешений: ' + (summ.total || 0),
    'опасных: ' + (summ.dangerous || 0),
    'разрешено опасных: ' + (summ.grantedDanger || 0),
    'AppOps разрешено: ' + (summ.allowedOps || 0)
  ].map(t => '<span class="chip" style="padding:4px 10px;font-size:12px">' + esc(t) + '</span>').join('');
  $('#appaudit-warnings').innerHTML = (r.warnings || []).map(w => '<div class="audit-warn">• ' + esc(w) + '</div>').join('') || '<div class="muted">Предупреждений нет</div>';
  const perms = (r.permissions || []).filter(p => p.dangerous);
  $('#appaudit-perms').innerHTML = perms.length ? perms.map(p => `<div class="list-row audit-item">
      <span class="grow2 mono small" data-tip="${esc(p.name)}">${esc(p.label || p.name)}</span>
      <span class="crash-badge ${p.granted ? 'crash-java' : 'crash-error'}">${p.granted ? 'разрешено' : 'запрещено'}</span>
    </div>`).join('') : '<div class="empty">Опасных разрешений не найдено</div>';
  const ops = r.appops || [];
  $('#appaudit-ops').innerHTML = ops.length ? ops.map(o => `<div class="list-row audit-item">
      <span class="grow2 mono small" data-tip="${esc(o.op)}">${esc(o.label || o.op)}</span>
      <span class="crash-badge ${o.mode === 'allow' ? 'crash-anr' : 'crash-error'}">${esc(OP_MODE_LABEL[o.mode] || o.mode)}</span>
    </div>`).join('') : '<div class="empty">AppOps не найдены</div>';
}
function auditReportText() {
  const r = auditCtx.data; if (!r) return '';
  const lines = ['MultiTool — аудит приложения', 'Устройство: ' + auditCtx.serial, 'Пакет: ' + auditCtx.pkg,
    'targetSdk: ' + (r.info.targetSdk || '—'), 'Установщик: ' + (r.info.installer || '—'), 'Версия: ' + (r.info.versionName || '—'), '', 'Предупреждения:'];
  for (const w of r.warnings || []) lines.push('• ' + w);
  lines.push('', 'Разрешения:');
  for (const p of r.permissions || []) lines.push((p.granted ? '[+] ' : '[-] ') + (p.label || p.name) + ' — ' + p.name);
  lines.push('', 'AppOps:');
  for (const o of r.appops || []) lines.push(o.label + ' — ' + (OP_MODE_LABEL[o.mode] || o.mode) + ' (' + o.op + ')');
  return lines.join('\n');
}
$('#btn-audit-copy').onclick = () => {
  const t = auditReportText();
  if (!t) return snack('Нечего копировать');
  copyText(t.slice(0, 400000));
};

$('#btn-apps-backup').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  const sel = $$('#apps-list [data-bak]:checked').map(c => c.dataset.bak);
  if (!sel.length) return snack('Отметьте приложения галочками');
  snack('Копирую ' + sel.length + ' APK…');
  const r = await window.api.appsBackup(s, sel);
  if (r.ok) snack('Сохранено ' + r.done + ' из ' + r.total + ' в ' + r.dir);
};

/* ---------- пакетные действия с отмеченными приложениями ---------- */
function appsSelected() { return $$('#apps-list [data-bak]:checked').map(c => c.dataset.bak); }
function appsBatchUpdate() {
  const n = appsSelected().length;
  ['btn-batch-disable', 'btn-batch-enable', 'btn-batch-stop', 'btn-batch-clear', 'btn-apps-backup']
    .forEach(id => { const b = $('#' + id); if (b) b.classList.toggle('hidden', !n); });
  const cnt = $('#apps-counts');
  if (cnt && n) {
    const chip = cnt.querySelector('.batch-chip');
    if (chip) chip.innerHTML = 'Отмечено: <b>' + n + '</b>';
    else cnt.insertAdjacentHTML('beforeend', '<span class="count-chip batch-chip">Отмечено: <b>' + n + '</b></span>');
  } else {
    const chip = cnt && cnt.querySelector('.batch-chip');
    if (chip) chip.remove();
  }
}
document.addEventListener('change', e => {
  if (e.target && e.target.matches && e.target.matches('#apps-list [data-bak]')) appsBatchUpdate();
});
$('#btn-apps-selall').onclick = () => {
  const boxes = $$('#apps-list [data-bak]');
  if (!boxes.length) return;
  const allOn = boxes.every(b => b.checked);
  boxes.forEach(b => b.checked = !allOn);
  appsBatchUpdate();
};
async function appsBatchRun(action, label, confirmText) {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  const pkgs = appsSelected();
  if (!pkgs.length) return snack('Отметьте приложения галочками');
  if (confirmText) {
    const yes = await uiConfirm(label, confirmText.replace('{n}', pkgs.length));
    if (!yes || !yes.ok) return;
  }
  snack(label + ': ' + pkgs.length + '…');
  let okN = 0;
  for (const p of pkgs) {
    try {
      const r = await window.api.appsAction(s, action, p);
      if (r && r.ok) okN++;
    } catch (e) {}
  }
  snack(label + ' — готово: ' + okN + ' из ' + pkgs.length, 5000);
  appsLoad();
}
$('#btn-batch-disable').onclick = () => appsBatchRun('disable', 'Отключаю', 'Отключить {n} отмеченных приложений? Системные отключаются через «удаление для пользователя» — включить можно кнопкой «Включить».');
$('#btn-batch-enable').onclick = () => appsBatchRun('enable', 'Включаю', null);
$('#btn-batch-stop').onclick = () => appsBatchRun('forceStop', 'Останавливаю', 'Принудительно остановить {n} приложений? Их фоновые процессы закроются.');
$('#btn-batch-clear').onclick = () => appsBatchRun('clear', 'Очищаю данные', 'Очистить ДАННЫЕ {n} приложений? Это необратимо: аккаунты, настройки и кэш будут удалены.');

/* экспорт списка приложений в CSV (имя, пакет, версия, состояние, размер) */
$('#btn-apps-export').onclick = async () => {
  const s = currentSerial(); if (!s) return snack('Нет устройства');
  if (!appsData) return snack('Список приложений ещё не загружен');
  snack('Готовлю CSV…');
  const rows = [['Имя', 'Пакет', 'Версия', 'Состояние', 'Размер (байт)']];
  const all = [...new Set([...(appsData.user || []), ...(appsData.system || [])])];
  for (const p of all.sort((a, b) => appDisplay(a).localeCompare(appDisplay(b), 'ru'))) {
    const meta = appsMetaMap[p] || {};
    rows.push([
      appDisplay(p), p, meta.versionName || '',
      (appsData.disabled || []).includes(p) ? 'отключено' : ((appsData.user || []).includes(p) ? 'пользовательское' : 'системное'),
      meta.size || ''
    ]);
  }
  const csv = '\uFEFF' + rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(';')).join('\r\n');
  try {
    const r = await window.api.saveTextFile('apps-' + stampName() + '.csv', csv);
    if (r && r.ok) snack('Сохранено: ' + r.file); else snack('Экспорт отменён');
  } catch (e) { snack('Не удалось сохранить: ' + e.message); }
};
function stampName() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + '-' + p(d.getMinutes()); }


/* ---------- настройки ---------- */
// выбор путей adb/scrcpy удалён — поля убраны из настроек
$('#set-autostart').onchange = async e => {
  const r = await window.api.setSetting('autostart', e.target.checked);
  if (!r.ok) { snack(r.message || 'Не удалось изменить автостарт'); e.target.checked = !e.target.checked; }
};
$('#set-tray').onchange = e => window.api.setSetting('closeToTray', e.target.checked);
$('#set-autoreconnect').onchange = e => window.api.setSetting('autoreconnect', e.target.checked);
$('#set-sounds').onchange = e => { snd.on = e.target.checked; window.api.setSetting('sounds', e.target.checked); };
$('#set-autolast').onchange = e => window.api.setSetting('autolast', e.target.checked);
/* MCP-агент — тумблер и аварийная остановка */
$('#set-agent-enabled').onchange = async e => {
  const r = await window.api.agentSetEnabled(e.target.checked).catch(() => null);
  if (!r || !r.ok) { snack('Не удалось переключить агента'); e.target.checked = !e.target.checked; }
  else snack(e.target.checked ? 'Управление агентом включено (MCP-сервер на http://127.0.0.1:3939/mcp)' : 'Управление агентом выключено');
};
$('#btn-agent-stop').onclick = async () => {
  const r = await window.api.agentStop().catch(() => null);
  snack(r && r.ok ? 'Агент остановлен — текущая серия действий прервана' : 'Не удалось остановить');
};
$('#btn-agent-reset').onclick = async () => {
  const r = await window.api.agentReset().catch(() => null);
  snack(r && r.ok ? 'Флаг остановки сброшен — агент может работать снова' : 'Не удалось сбросить');
};
(async function agentInit() {
  const st = await window.api.agentGetState().catch(() => null);
  if (st && st.ok) {
    const box = $('#set-agent-enabled');
    if (box) box.checked = !!st.enabled;
    const logs = st.logs || [];
    if (logs.length && $('#agent-mcp-addr')) {
      $('#agent-mcp-addr').innerHTML = 'MCP-сервер: <span class="mono">http://127.0.0.1:3939/mcp</span> · последних действий: <b>' + logs.length + '</b>';
    }
  }
})();
$('#set-theme').onchange = e => { document.body.dataset.theme = e.target.value; window.api.setSetting('theme', e.target.value); };
/* ---------- ассоциации файлов APK (реестр Windows, HKCU) ---------- */
    const ASSOC_EXTS_UI = ['apk', 'aab', 'apks', 'xapk', 'apkm', 'obb', 'apup'];
async function assocRefresh() {
  const r = await window.api.assocGet().catch(() => null);
  const on = r && r.state && Object.values(r.state).some(Boolean);
  $('#set-assoc').checked = !!on;
  $('#assoc-exts').innerHTML = ASSOC_EXTS_UI.map(x => {
    const key = x.replace(/\./g, '.');
    const isOn = r && r.state && r.state[x];
    return `<span class="assoc-ext ${isOn ? 'on' : ''}">${esc(x)}</span>`;
  }).join('');
  $('#assoc-note').textContent = (r && r.note) || '';
}
    $('#set-assoc').onchange = async e => {
      const on = e.target.checked;
      const r = await window.api.assocSet(on);
      if (!r || !r.ok) { snack('Не удалось изменить ассоциации: ' + ((r && r.errors && r.errors[0]) || 'ошибка')); e.target.checked = !on; }
      else snack(on ? (r.warning || 'Ассоциации включены: файлы APK открываются двойным кликом') : 'Ассоциации отключены', r.warning ? 12000 : undefined);
      assocRefresh();
    };
      // кэш иконок WINDOWS (Проводника), без перезапуска Explorer
      /* ---------- иконки приложений в Проводнике ---------- */
async function shellextRefresh() {
  const st = await window.api.shellextStatus().catch(() => null);
  const on = !!(st && st.installed);
  const cb = $('#set-shellext');
  if (cb) cb.checked = on;
  const label = $('#shellext-status');
  if (label) {
    if (!st) label.textContent = 'Не удалось проверить состояние';
    else if (on) {
      const all = Object.values(st.exts || {}).every(Boolean);
      label.textContent = 'Установлено: ' + st.dir + (all ? '' : ' (часть форматов не зарегистрирована)');
    } else label.textContent = 'Не установлено — значки общие для всех файлов';
  }
  return st;
}
{
  const cb = $('#set-shellext');
  if (cb) cb.onchange = async () => {
    const on = cb.checked;
    if (on) {
      const ok = await confirmOnce('confirm.shellext', 'Иконки в Проводнике', 'Установка потребует подтверждения администратора Windows (UAC). После установки Проводник нужно перезапустить. Продолжить?');
      if (!ok.ok) { cb.checked = false; return; }
      snack('Устанавливаю расширение… подтвердите запрос администратора');
      const r = await window.api.shellextInstall().catch(() => null);
      if (!r || !r.ok) { cb.checked = false; snack('Не удалось установить: ' + ((r && r.error) || 'ошибка'), 12000); shellextRefresh(); return; }
      snack('Иконки установлены. Перезапустите Проводник, чтобы они появились.', 10000);
      const r2 = await confirmOnce('confirm.shellext.restart', 'Перезапуск Проводника', 'Перезапустить Проводник сейчас? Все окна Проводника закроются и откроются заново.');
      if (r2.ok) { await window.api.restartExplorer().catch(() => null); snack('Проводник перезапущен'); }
    } else {
      const ok = await confirmOnce('confirm.shellext.off', 'Иконки в Проводнике', 'Удалить расширение и вернуть общий значок для всех файлов?');
      if (!ok.ok) { cb.checked = true; return; }
      const r = await window.api.shellextUninstall().catch(() => null);
      if (!r || !r.ok) snack('Не удалось удалить: ' + ((r && r.error) || 'ошибка'), 12000);
      else snack('Расширение удалено. Перезапустите Проводник.');
    }
    shellextRefresh();
  };
  const btn = $('#btn-shellext-restart');
  if (btn) btn.onclick = async () => {
    const ok = await confirmOnce('confirm.shellext.restart', 'Перезапуск Проводника', 'Перезапустить Проводник сейчас? Все окна Проводника закроются и откроются заново.');
    if (!ok.ok) return;
    await window.api.restartExplorer().catch(() => null);
    snack('Проводник перезапущен');
  };
}
$('#btn-clear-icon-cache').onclick = async () => {
        const r = await window.api.winClearIconCache().catch(() => null);
        snack(r && r.ok
          ? 'Кэш иконок Windows очищен' + (r.removed ? ' (удалено файлов: ' + r.removed + ')' : '') + ' — значки в Проводнике обновятся сами'
          : 'Не удалось очистить кэш иконок Windows');
      };
  $('#btn-open-data').onclick = async () => {
    const r = await window.api.shellOpenPath(savesDir).catch(() => null);
    if (!r || !r.ok) snack('Не удалось открыть папку данных: ' + ((r && r.error) || 'ошибка'));
  };
$('#btn-about').onclick = () => openDlg('dlg-about');

/* ui-логирование: в журнал (только ошибки) пишут снэкбары с ошибками и необработанные
   исключения из preload.js — отладочный лог ВСЕХ кликов удалён: в app.log не должно быть
   ничего, кроме ошибок (F19) */

/* ---------- события из main ---------- */
window.api.onTask(async ev => {
  if (ev.kind === 'scan-progress') {
    const pct = Math.round(ev.done / ev.total * 100);
    $('#scan-card').classList.remove('scanning-done');
    $('#scan-progress').classList.remove('hidden');
    $('#scan-bar').style.width = pct + '%';
    $('#scan-progress-text').textContent = pct + '%';
  } else if (ev.kind === 'scan-done') {
    // F18: после завершения скана полоса прогресса больше не «висит в ожидании» —
    // сворачиваем её и показываем итог
    $('#scan-bar').style.width = '100%';
    $('#scan-progress-text').textContent = 'готово, найдено: ' + ev.count;
    $('#scan-card').classList.add('scanning-done');
    setTimeout(() => { if ($('#scan-progress')) $('#scan-progress').classList.add('hidden'); }, 900);
  } else if (ev.kind === 'scan-request') {
    goPage('devices');
    $('#btn-scan').click();
  } else if (ev.kind === 'pair-log') {
    $('#pair-log').textContent += ev.text;
    $('#pair-log').scrollTop = 99999;
  } else if (ev.kind === 'apk-progress') {
    // легаси-событие старой IPC — UI теперь на новой очереди (apk-queue)
  } else if (ev.kind === 'apk-queue') {
    // статусы очереди установки из main
    if (ev.index != null && apkQueue[ev.index]) {
      apkQueue[ev.index].status = ev.stage === 'done' ? 'ok' : ev.stage === 'fail' ? 'fail' : 'run';
      apkQueue[ev.index].msg = ev.message || apkQueue[ev.index].msg || '';
      if (ev.raw) apkQueue[ev.index].log = ev.raw;
      apkQRender();
    }
  } else if (ev.kind === 'fsload-progress') {
    // прогресс загрузки файла для просмотрщика/плеера
    const mb = ((ev.bytes || 0) / 1048576).toFixed(1);
    const msg = 'Загружено ' + mb + ' МБ…';
    if (!$('#dlg-imgview').classList.contains('hidden')) $('#imgview-msg').textContent = msg;
    if (!$('#dlg-media').classList.contains('hidden') && !mp.isVideo) $('#media-now-sub').textContent = msg;
  } else if (ev.kind === 'apk-meta-progress') {
    // уведомления «Изучаю приложение…» УБРАНЫ совсем — загрузка иконок идёт тихо
    // в фоне, иконка/имя просто появляются в строке файла (жалоба: «засыпало уведомлениями»)
  } else if (ev.kind === 'open-apk') {
    // файл открыт ассоциацией (двойной клик в Проводнике) или передан аргументом
    openApkMini(ev.path);
  } else if (ev.kind === 'open-settings') {
    // пункт «Настройки» в трей-меню
    goPage('settings');
  } else if (ev.kind === 'refresh-devices') {
    refreshDevices();
    renderApkTargets();
  } else if (ev.kind === 'connected') {
    setActive(ev.host + ':' + ev.port);
    state = await window.api.getState();
    renderHistory(); renderFavorites();
    refreshDevices();
  } else if (ev.kind === 'logcat-stopped') {
    logcatOn = false;
    logcatButtons();
  } else if (ev.kind === 'record-stopped') {
    // запись прервалась сама (лимит 3 мин или died-процесс) — синхронизируем UI и предлагаем сохранить
    clearInterval(recTimer); recTimer = null;
    recordUIReset();
    if (ev.auto && ev.serial && ev.remote) {
      snack('Запись автоматически остановлена (лимит 3 мин). Сохраняю видео с телефона…', 6000);
      const r = await window.api.fsPull(ev.serial, ev.remote);
      if (r.ok) snack('Видео сохранено: ' + r.file);
      window.api.fsCmd(ev.serial, ['rm', '-f', ev.remote]);
    }
  } else if (ev.kind === 'shell-stopped') {
    if (shellOn) {
      shellOn = false;
      $('#shell-view').textContent += '\n[сессия остановлена]\n';
    }
  } else if (ev.kind === 'qr-status') {
    if (ev.stage === 'listening') qrSetStatus(ev.message || 'Ожидание сканирования…', '');
    else if (ev.stage === 'found' || ev.stage === 'paired' || ev.stage === 'connecting') qrSetStatus(ev.message || '…', '');
    else if (ev.stage === 'connected') {
      qrSetStatus('✓ ' + (ev.message || 'Подключено'), 'ok');
      snd.play('connect');
      state = await window.api.getState();
      renderHistory(); renderFavorites();
      refreshDevices();
      setTimeout(qrHidePanel, 1600);
    }
    else if (ev.stage === 'error') { qrActive = false; qrSetStatus(ev.message || 'Ошибка', 'err'); }
    else if (ev.stage === 'cancelled') { qrActive = false; }
  } else if (ev.kind === 'fs-zip') {
    // прогресс сборки ZIP-архива
    if (ev.stage === 'run' || ev.stage === 'pack' || ev.stage === 'push') {
      const pct = ev.total ? Math.round((ev.done || 0) / ev.total * 100) : 0;
      snack('Архив: ' + (ev.msg || ev.stage) + (ev.total ? ' (' + (ev.done || 0) + '/' + ev.total + ')' : ''));
      void pct;
    } else if (ev.stage === 'err') snack(ev.msg || 'Часть файлов не вошла в архив', 6000);
  } else if (ev.kind === 'usb-faketest') {
    usbFakeEvent(ev);
  } else if (ev.kind === 'mirror-stopped') {
    // генерационная защита: стоп СТАРОЙ сессии не убивает новую (переключение режимов)
    if (mirrorOn && ev.gen === mirrorGen) {
      mirrorStopUI();
      if (ev.reason === 'device-lost') snack('Трансляция остановлена: устройство недоступно');
    }
  } else if (ev.kind === 'mirror-stalled') {
    scheduleFallback('нет данных 7 с');
  } else if (ev.kind === 'mirror-status') {
    $('#mirror-status').textContent = ev.text || '';
  }
});

/* ---------- терминал и логcat на «Инструментах» по умолчанию СВЁРНУТЫ ---------- */
(function initCollapsible() {
  const KEY = 'tools.open';
  let openSet = {};
  try { openSet = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) {}
  $$('.collapse-card').forEach(card => {
    card.classList.toggle('open', !!openSet[card.id]);
    const head = card.querySelector('.collapse-head');
    if (!head) return;
    head.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      card.classList.toggle('open');
      openSet[card.id] = card.classList.contains('open');
      try { localStorage.setItem(KEY, JSON.stringify(openSet)); } catch (err) {}
    });
  });
})();

/* ---------- навигация и старт ---------- */
function goPage(name, opts) {
  $$('.rail-item').forEach(x => x.classList.toggle('active', x.dataset.page === name));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  updateToolsState();
  if (name === 'files') {
    // R11: файлы телефона отображаются СРАЗУ, без кнопок «Открыть»/«Открыть память»
    if (!(opts && opts.skipFsRender)) fsRender();
    renderFsVolumes();
    const s = currentSerial();
    if (s && !infoCache[s]) devInfoText(s).then(() => {
      const i = infoCache[s] && infoCache[s].info;
      if (i && i.storage) $('#fs-storage').textContent = 'Внутренняя память /data: занято ' + i.storage.used + ' из ' + i.storage.total + ', свободно ' + i.storage.free;
    });
  }
  if (name === 'apps' && !appsData) appsLoad();
  if (name === 'apk') renderApkTargets();
    if (name === 'tools') setTimeout(() => { try { unlockRefresh(); } catch (e) {} }, 120);
}

(async function init() {
  // крестик очистки внутри полей поиска (не отдельной кнопкой «за интерфейсом»)
  ['apps-search', 'fs-filter', 'logcat-filter', 'arc-filter'].forEach(attachClear);

  renderFsQuick();
  await loadState();
  await renderSaved();
  await refreshDevices();
  initTerminalLib(); // после загрузки конфига: миграция favCmds + свои команды
  const h = location.hash.replace('#', '');
  if (['devices', 'tools', 'settings', 'files', 'apps', 'apk'].includes(h)) goPage(h);
  window.addEventListener('hashchange', () => {
    const p = location.hash.replace('#', '');
    if (['devices', 'tools', 'settings', 'files', 'apps', 'apk'].includes(p)) goPage(p);
  });
  // не опрашиваем adb, пока окно скрыто; при возврате видимости обновляем сразу
  // частый опрос (2,5 с) — USB-телефон, воткнутый в кабель, появляется почти сразу
  setInterval(() => { if (!document.hidden) refreshDevices(); }, 2500);
  setInterval(pingActive, 10000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDevices(); });
  assocRefresh();       // состояние ассоциаций в настройках
shellextRefresh();    // состояние иконок в Проводнике
  renderApkTargets();   // селектор устройств вкладки установки
})();

/* горячие клавиши (R14): F5 — обновить устройства, Ctrl+L — фокус в поле IP */
document.addEventListener('keydown', e => {
  if (e.key === 'F5') { e.preventDefault(); refreshDevices(); snack('Список устройств обновлён'); }
  else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); goPage('devices'); $('#in-ip').focus(); }
});

/* перетаскивание диалоговых окон за заголовок, как обычных окон Windows */
(function initDialogDrag() {
  const dialogs = Array.from(document.querySelectorAll('.overlay .dialog'));
  for (const dlg of dialogs) {
    const head = dlg.querySelector('.dialog-head');
    if (!head) continue;
    let dx = 0, dy = 0, startX = 0, startY = 0, baseDx = 0, baseDy = 0;
    let active = false;
    const apply = () => { dlg.style.transform = (dx || dy) ? `translate(${dx}px, ${dy}px)` : ''; };
    head.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('button, input, select, textarea, a, label, [contenteditable="true"], [data-no-drag]')) return;
      if (dlg.classList.contains('media-full') || dlg.classList.contains('imgview-full')) return;
      if (document.fullscreenElement || document.webkitFullscreenElement) return;
      // Окно могло ещё проигрывать анимацию появления с transform — она
      // перебивает inline-transform при перетаскивании. Отключаем её.
      dlg.style.animation = 'none';
      active = true;
      startX = e.clientX; startY = e.clientY; baseDx = dx; baseDy = dy;
      try { head.setPointerCapture(e.pointerId); } catch (err) {}
      dlg.classList.add('is-dragging');
      document.body.classList.add('dialog-dragging');
      e.preventDefault();
    });
    head.addEventListener('pointermove', e => {
      if (!active) return;
      // если тянуть плеер за пределы окна — «вынимаем» его в настоящее
      // окно Windows, которое можно двигать по всему экрану.
      if (dlg.closest('#dlg-media')) {
        const out = Math.max(-e.clientX, e.clientX - window.innerWidth, -e.clientY, e.clientY - window.innerHeight);
        if (out > 26) {
          const sx = e.screenX, sy = e.screenY;
          end(e);
          detachPlayer(sx, sy);
          return;
        }
      }
      const r = dlg.getBoundingClientRect();
      const baseLeft = r.left - dx, baseTop = r.top - dy;
      let nx = baseDx + (e.clientX - startX);
      let ny = baseDy + (e.clientY - startY);
      const keepX = Math.min(180, Math.max(80, r.width / 2));
      const minLeft = -r.width + keepX, maxLeft = window.innerWidth - keepX;
      const left = baseLeft + nx;
      if (left < minLeft) nx += minLeft - left;
      else if (left > maxLeft) nx -= left - maxLeft;
      const keepTop = Math.min(48, Math.max(28, r.height * 0.35));
      const maxTop = window.innerHeight - keepTop;
      const top = baseTop + ny;
      if (top < 0) ny -= top;
      else if (top > maxTop) ny -= top - maxTop;
      dx = nx; dy = ny; apply();
    });
    const end = e => {
      if (!active) return;
      active = false;
      dlg.classList.remove('is-dragging');
      document.body.classList.remove('dialog-dragging');
      try { head.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
    head.addEventListener('lostpointercapture', end);
  }
})();

// При клике мимо немодального плеера снимаем с него фокус,
// чтобы Space/стрелки не управляли музыкой во время работы с интерфейсом.
document.addEventListener('pointerdown', e => {
  const ov = document.getElementById('dlg-media');
  if (!ov || ov.classList.contains('hidden')) return;
  if (e.target && e.target.closest && e.target.closest('#dlg-media')) return;
  const a = document.activeElement;
  if (a && a.closest && a.closest('#dlg-media')) { try { a.blur(); } catch (err) {} }
}, true);

// перетаскивание из списка файлов в Проводник / на рабочий стол.
(function initFileDragOut() {
  const box = $('#fs-list');
  if (!box) return;
  let guard = 0;
  box.addEventListener('click', e => {
    if (Date.now() < guard) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  box.addEventListener('dragstart', async e => {
    const el = e.target.closest ? e.target.closest('.fs-row, .fs-cell') : null;
    if (!el) return;
    if (e.target.closest('input, button, .fs-sel, .fs-sel-cell, [data-fssel]')) { e.preventDefault(); return; }
    const p = el.dataset.fsfull || el.dataset.fspath;
    if (!p) { e.preventDefault(); return; }
    e.preventDefault();
    const s = currentSerial();
    if (!s) return snack('Сначала подключите телефон');
    const name = p.split('/').pop();
    snack('Готовлю «' + name + '» для перетаскивания…', 120000);
    const r = await window.api.dragPrepare(s, p).catch(() => null);
    if (!r || !r.ok) { snack('Не удалось подготовить файл: ' + ((r && r.error) || 'ошибка'), 7000); return; }
    guard = Date.now() + 1500;
    const st = await window.api.dragStart(r.path).catch(() => null);
    if (!st || !st.ok) snack('Файл подготовлен. Потяните его ещё раз — теперь перетаскивание начнётся сразу', 7000);
  });
})();

// перетаскивание файлов/папок из Проводника в окно программы.
(function initFileDrop() {
  const box = $('#fs-list');
  if (!box) return;
  const folderOf = t => (t && t.closest) ? t.closest('.fs-row[data-fsdir="1"], .fs-cell[data-isdir="1"]') : null;
  let over = null;
  const clear = () => {
    if (over) over.classList.remove('drop-target');
    over = null;
    box.classList.remove('drop-over');
  };
  window.addEventListener('dragover', e => {
    const dt = e.dataTransfer;
    if (!dt || !Array.from(dt.types || []).includes('Files')) return;
    e.preventDefault();
    dt.dropEffect = 'copy';
    if (!$('#page-files').classList.contains('active') || document.querySelector('.overlay:not(.hidden)')) { clear(); return; }
    box.classList.add('drop-over');
    const f = folderOf(e.target);
    if (f !== over) {
      if (over) over.classList.remove('drop-target');
      over = f;
      if (f) f.classList.add('drop-target');
    }
  });
  window.addEventListener('dragleave', e => { if (!e.relatedTarget) clear(); });
  window.addEventListener('drop', async e => {
    const dt = e.dataTransfer;
    if (!dt || !dt.files || !dt.files.length) return;
    e.preventDefault();
    const f = folderOf(e.target);
    clear();
    if (!$('#page-files').classList.contains('active')) return snack('Откройте страницу «Файлы», чтобы загрузить файлы');
    if (document.querySelector('.overlay:not(.hidden)')) return;
    const s = currentSerial();
    if (!s) return snack('Сначала подключите телефон');
    if (fsCatKind && !f) return snack('Откройте папку на телефоне, чтобы загрузить сюда файлы');
    const dir = f ? (f.dataset.fsfull || f.dataset.fspath) : fsDir;
    const paths = [];
    for (const file of Array.from(dt.files)) {
      try { const p = window.api.pathForFile(file); if (p) paths.push(p); } catch (err) {}
    }
    if (!paths.length) return snack('Не удалось получить путь файла');
    await fsUploadLocalPaths(paths, dir);
  });
})();

// Громкость, выставленная в отдельном окне, запоминается на время работы программы:
// следующее открытие плеера начнётся с неё. При новом запуске программы — снова
// маленькая (mp.vol инициализируется mediaVolLoad()).
try {
  window.api.onPlayerVolume(v => {
    const val = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    mp.vol = val;
    try { if (rm) rm.vol = val; } catch (e) {}
  });
} catch (e) {}

// внешнее окно плеера закрылось/свернулось — в приложении ничего не запускаем,
// второго плеера больше нет.
try {
  window.api.onPlayerClosed(() => {
    mp.detached = false;
    try { $('#media-el').pause(); $('#media-el2').pause(); } catch (e) {}
    $('#dlg-media').classList.add('hidden');
  });
} catch (e) {}




