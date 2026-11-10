/* apkmini.js — ОТДЕЛЬНОЕ мини-окно установки APK (открывается по двойному клику
   на .apk/.xapk/… в Проводнике при включённых ассоциациях — БЕЗ открытия основной программы).
   Окно можно перетаскивать за заголовок; внутри: иконка/имя/версия APK, список устройств,
   подключение нового устройства прямо отсюда и установка с прогрессом. */
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmtBytesLong(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' ГБ';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' МБ';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' КБ';
  return n + ' Б';
}
let snackEl = null;
function snack(msg, ms = 3500) {
  snackEl = snackEl || $('#snackbar');
  snackEl.textContent = msg;
  snackEl.classList.remove('hidden');
  clearTimeout(snackEl._t);
  snackEl._t = setTimeout(() => snackEl.classList.add('hidden'), ms);
}

/* компактный блок ошибки — точная причина, полный лог по кнопке, копирование */
function miniErrClear() {
  const b = $('#mini-error');
  if (b) { b.classList.add('hidden'); b.innerHTML = ''; }
}
function miniErrShow(reason, log) {
  const box = $('#mini-error');
  if (!box) return;
  const msg = String(reason || 'ошибка установки');
  const short = msg.split('\n')[0].slice(0, 200);
  box.innerHTML =
    '<div class="mini-err-line"><b>Причина:</b> ' + esc(short) + '</div>' +
    '<div class="mini-err-act">' +
      '<button class="btn btn-text btn-xs" data-mcopy>Копировать</button>' +
      (log ? '<button class="btn btn-text btn-xs" data-mlog>Подробнее</button>' : '') +
    '</div>' +
    (log ? '<pre class="mini-err-log hidden">' + esc(String(log).slice(0, 6000)) + '</pre>' : '');
  box.classList.remove('hidden');
  const cp = box.querySelector('[data-mcopy]');
  if (cp) cp.onclick = () => {
    try { window.api.copyText(msg + (log ? '\n\n' + log : '')); snack('Скопировано'); } catch (e) {}
  };
  const lg = box.querySelector('[data-mlog]');
  if (lg) lg.onclick = () => {
    const pre = box.querySelector('.mini-err-log');
    if (!pre) return;
    const hid = pre.classList.toggle('hidden');
    lg.textContent = hid ? 'Подробнее' : 'Свернуть';
  };
}

let currentFile = null;
let meta = null;
let installing = false;
let devices = [];

/* окно: перетаскивание за заголовок + закрытие */
// window.close() из sandbox-renderer НЕ работает (жалоба: «кнопка закрыть не закрывает,
// а крестик вверху закрывает») — закрываем через IPC главного процесса
$('#mini-close').onclick = () => {
  try { window.api.miniClose(); }
  catch (e) { try { window.close(); } catch (e2) {} }
};
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#mini-close').click(); });
// «Открыть программу» — поднять главное окно (при старте по APK его вообще не было)
{
  const b = $('#mini-open-main');
  if (b) b.onclick = () => { try { window.api.miniOpenMain(); } catch (e) {} };
}
window.api.onMaximized(() => {});

/* текущий файл: из hash или от main (второй двойной клик по другому APK) */
function fileFromLocation() {
  try { return decodeURIComponent(location.hash.replace(/^#/, '')) || null; } catch (e) { return null; }
}
window.api.onApkMiniFile((p) => { loadFile(p); });

async function loadFile(filePath) {
  if (!filePath) return;
  currentFile = filePath;
  meta = null;
  installing = false;
  $('#mini-progress').classList.add('hidden');
  $('#mini-bar').style.width = '0';
  $('#mini-install').disabled = true;
  $('#mini-install').textContent = 'Установить';
  $('#mini-status').textContent = '';
  miniErrClear();
  $('#mini-file').textContent = filePath;
  $('#mini-title').textContent = 'Читаю файл…';
  $('#mini-icon').src = '';
  $('#mini-sub').textContent = '';
  $('#mini-meta').innerHTML = '<div class="muted">Разбираю APK: иконка, имя, версия…</div>';
  const m = await window.api.apkLocalMeta(filePath).catch(() => null);
  if (!m || !m.ok) {
    $('#mini-title').textContent = 'Файл не читается';
    $('#mini-meta').innerHTML = '<div class="muted">' + esc((m && m.error) || 'Не удалось прочитать файл') + '</div>';
    return;
  }
  meta = m;
  $('#mini-title').textContent = m.label || filePath.split(/[\\/]/).pop();
  $('#mini-sub').textContent = [m.package, m.versionName ? 'версия ' + m.versionName : null, m.size ? fmtBytesLong(m.size) : null].filter(Boolean).join(' · ');
  if (m.icon) $('#mini-icon').src = m.icon;
  $('#mini-meta').innerHTML = [
    ['Имя приложения', m.label],
    ['Пакет', m.package],
    ['Версия', m.versionName ? m.versionName + (m.versionCode ? ' (код ' + m.versionCode + ')' : '') : null],
    ['Размер', m.size ? fmtBytesLong(m.size) : null]
  ].filter(r => r[1]).map(r => '<div><b>' + esc(r[0]) + ':</b> ' + esc(r[1]) + '</div>').join('') +
    '<div class="muted" style="margin-top:6px">Выберите устройство — или подключите новое по IP прямо в этом окне.</div>';
  await refreshDevices();
  // автопроверка — установлено ли это приложение на подключённом телефоне,
  // какая версия там и какая новее (по versionCode)
  if (meta && meta.package) checkInstalledOn(meta.package);
}

// сравнение версии файла APK с установленной на телефоне
async function checkInstalledOn(pkg) {
  try {
    const sers = devices.length ? devices[0].serial : $('#mini-target').value;
    if (!sers) return;
    const info = await window.api.apkInstalledInfo(sers, pkg).catch(() => null);
    const old = $('#mini-inst-check');
    if (old) old.remove();
    if (!info || !info.ok) return;
    let html = '';
    if (info.versionName) {
      let cmp = '';
      if (info.versionCode != null && meta && meta.versionCode != null) {
        const a = parseInt(info.versionCode, 10), b = parseInt(meta.versionCode, 10);
        if (isFinite(a) && isFinite(b)) {
          cmp = a > b ? ' · на телефоне новее' : a < b ? ' · в файле новее' : ' · версии одинаковые';
        }
      }
      html = '<div class="inst-check inst-ok">Установлено: ' + esc(info.versionName) + cmp + '</div>';
    } else {
      html = '<div class="inst-check inst-none">На телефоне НЕ установлено</div>';
    }
    $('#mini-meta').insertAdjacentHTML('beforeend', html);
  } catch (e) {}
}

async function refreshDevices() {
  const r = await window.api.adbDevices().catch(() => null);
  devices = (r && r.ok && r.list) ? r.list.filter(d => d.state === 'device') : [];
  const sel = $('#mini-target');
  if (!devices.length) {
    sel.innerHTML = '<option value="">Нет подключённых — подключите по IP ниже</option>';
  } else {
    sel.innerHTML = devices.map(d => {
      const serial = d.serial;
      const label = (d.model || d.props && d.props.product || serial) + (serial.includes(':') ? '' : ' [USB]');
      return '<option value="' + esc(serial) + '">' + esc(label) + ' — ' + esc(serial) + '</option>';
    }).join('');
    if (sel.selectedIndex < 0 || sel.selectedIndex >= devices.length) sel.selectedIndex = 0;
  }
  // ЯВНЫЙ статус — сразу видно, подключено устройство или нет (раньше было непонятно:
  // «то ли в списке есть устройство, то ли подключено, то ли нет»)
  const st = $('#mini-devstatus'), tx = $('#mini-devtext');
  if (st && tx) {
    if (devices.length) {
      const d = devices[0];
      const net = String(d.serial).includes(':');
      tx.textContent = 'Подключено: ' + (d.model || d.serial) + (net ? ' (' + d.serial + ')' : ' [USB]') + (devices.length > 1 ? ' · всего ' + devices.length : '');
      st.classList.add('on');
      st.querySelector('.dot').classList.remove('off');
    } else {
      tx.textContent = 'Нет подключённых устройств';
      st.classList.remove('on');
      st.querySelector('.dot').classList.add('off');
    }
  }
  $('#mini-install').disabled = installing || !devices.length || !$('#mini-target').value;
}

$('#mini-refresh').onclick = refreshDevices;
$('#mini-target').onchange = () => {
  $('#mini-install').disabled = installing || !$('#mini-target').value;
  // сменили устройство — перепроверить «установлено ли» на нём
  if (meta && meta.package) setTimeout(() => checkInstalledOn(meta.package), 50);
};

/* автопроверка устройств, пока окно открыто — статус «Подключено» появляется сам */
setInterval(() => { if (!document.hidden && !installing) refreshDevices().catch(() => {}); }, 3000);

/* поиск телефона в сети (mDNS + сканирование подсети) прямо из мини-окна */
$('#mini-find').onclick = async () => {
  const box = $('#mini-find-results');
  box.innerHTML = '<div class="empty">Ищу телефоны в сети (mDNS + порты 5555 на подсети) — до минуты…</div>';
  let found = [];
  try { found = (await window.api.scanSubnet()) || []; } catch (e) {}
  try {
    const md = (await window.api.mdnsDiscover()) || [];
    for (const m of md) {
      if (!String(m.service || '').includes('connect')) continue;
      if (!found.some(f => f.host === m.host && f.port === m.port)) found.push({ host: m.host, port: m.port, label: 'mDNS' });
    }
  } catch (e) {}
  if (!found.length) {
    box.innerHTML = '<div class="empty">Телефон в сети не найден. Откройте на телефоне «Беспроводная отладка» и введите IP:порт в строке ниже.</div>';
    return;
  }
  box.innerHTML = found.map((f, i) => '<div class="list-row"><span class="mono grow2">' + esc(f.host + ':' + f.port) +
    ' <span class="muted">· ' + esc(f.label || 'порт 5555') + '</span></span><button class="btn btn-tonal btn-sm" data-mc="' + i + '">Подключить</button></div>').join('');
  box.querySelectorAll('[data-mc]').forEach(b => b.onclick = async () => {
    const f = found[+b.dataset.mc];
    snack('Подключаюсь к ' + f.host + ':' + f.port + '…');
    const r = await window.api.adbConnect(f.host, +f.port);
    snack(r.ok ? 'Подключено: ' + f.host + ':' + f.port : 'Не удалось: ' + ((r.message || r.error || '').slice(0, 140)));
    if (r.ok) await refreshDevices();
  });
};

/* подключение устройства прямо из мини-окна */
$('#mini-connect').onclick = () => { const r = $('#mini-conn-row'); r.style.display = r.style.display === 'none' ? 'flex' : 'none'; };
$('#mini-conn-go').onclick = async () => {
  const v = $('#mini-conn-ip').value.trim();
  const m = v.match(/^([\d.]+):(\d+)$/) || (v.match(/^([\d.]+)$/) ? [null, v, '5555'] : null);
  if (!m) return snack('Введите IP или IP:порт');
  const host = m[1], port = +m[2];
  snack('Подключаюсь к ' + host + ':' + port + '…');
  const r = await window.api.adbConnect(host, port);
  snack(r.ok ? 'Подключено: ' + host + ':' + port : 'Не удалось: ' + ((r.message || r.error || '').slice(0, 140)));
  if (r.ok) { $('#mini-conn-row').style.display = 'none'; await refreshDevices(); }
};
$('#mini-conn-ip').addEventListener('keydown', e => { if (e.key === 'Enter') $('#mini-conn-go').click(); });

/* установка с прогрессом */
$('#mini-install').onclick = async () => {
  if (installing || !meta) return;
  const serial = $('#mini-target').value;
  if (!serial) return snack('Сначала подключите устройство');
  installing = true;
  $('#mini-install').disabled = true;
  $('#mini-install').textContent = 'Устанавливаю…';
  $('#mini-progress').classList.remove('hidden');
  $('#mini-bar').style.width = '40%';
  miniErrClear();
  $('#mini-status').textContent = 'Передаю и устанавливаю APK — не отключайте телефон…';
  const r = await window.api.apkInstallBatch(serial, [{ path: currentFile, meta: { package: meta.package } }]);
  installing = false;
  $('#mini-bar').style.width = '100%';
  $('#mini-install').disabled = false;
  $('#mini-install').textContent = 'Установить';
  if (r && r.ok && r.installed) {
    $('#mini-status').textContent = '✓ Установлено: ' + (meta.label || currentFile.split(/[\\/]/).pop());
    snack('Установлено: ' + (meta.label || 'APK'));
    setTimeout(() => { $('#mini-progress').classList.add('hidden'); $('#mini-bar').style.width = '0'; }, 1500);
  } else {
    // точная причина + компактный блок с логом и копированием
    const first = (r && Array.isArray(r.results) && r.results.find(x => x && !x.ok)) || null;
    const reason = (r && (r.error || (r.canceled ? 'прервано' : ''))) || (first && first.message) || 'ошибка';
    $('#mini-status').textContent = '✗ Не удалось установить';
    miniErrShow(reason, first && first.raw);
    $('#mini-progress').classList.add('hidden');
    $('#mini-bar').style.width = '0';
  }
};

/* прогресс/статусы из main (apk-queue) */
window.api.onTask(async ev => {
  if (ev.kind === 'apk-queue' && ev.stage) {
    if (ev.stage === 'run') {
      miniErrClear();
      $('#mini-status').textContent = ev.message ? (ev.file + ': ' + String(ev.message).slice(0, 160)) : 'Устанавливаю…';
      $('#mini-bar').style.width = '55%';
    } else if (ev.stage === 'done') {
      miniErrClear();
      $('#mini-bar').style.width = '100%';
      $('#mini-status').textContent = '✓ ' + (ev.message || 'Готово');
    } else if (ev.stage === 'fail') {
      $('#mini-status').textContent = '✗ Ошибка установки';
      miniErrShow(ev.message || 'Ошибка', ev.raw);
      $('#mini-progress').classList.add('hidden');
    }
  } else if (ev.kind === 'refresh-devices' || ev.kind === 'connected') {
    // устройство подключили (в т.ч. в основном окне) — статус обновится сам
    await refreshDevices();
  }
});

/* старт */
(async function init() {
  $('#mini-conn-row').style.display = 'none';
  await refreshDevices();
  const f = fileFromLocation();
  if (f) loadFile(f);
  else $('#mini-title').textContent = 'Файл не передан';
})();
