'use strict';
/* Отдельное окно плеера (). Это ТОТ ЖЕ плеер, что и в приложении: та же
   разметка, theme-v3.css и styles.css, те же кнопки и полноэкранный режим.
   Окно прозрачное — карточка остаётся полупрозрачной и со скруглениями. */
const $ = s => document.querySelector(s);
const VRE = /\.(mp4|mkv|webm|avi|mov|3gp|m4v|ts)$/i;
const MEDIA_VOL_DEFAULT = 5;
const FIT_MODES = ['contain', 'cover', 'fill'];
const FIT_LABELS = { contain: 'Вписать', cover: 'Заполнить', fill: 'Растянуть' };
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

const shell = $('#media-shell');
const el = $('#media-el'), el2 = $('#media-el2');
const stage = $('#media-stage');
const bar = $('#media-ytbar');

let st = {}, list = [], idx = 0;
let barT = 0;
let seeking = false;
const mp = {
  isVideo: false, eqOn: false, vol: MEDIA_VOL_DEFAULT, visIdx: 0,
  ctx: null, src: null, filters: [], out: null, analyser: null,
  directCtx: null, analyser2: null, raf: 0, visT: 0, loadSeq: 0, lastFull: ''
};

function snack(msg, ms = 3200) {
  const n = $('#player-snack'); if (!n) return;
  n.textContent = msg; n.classList.remove('hidden');
  clearTimeout(n._t); n._t = setTimeout(() => n.classList.add('hidden'), ms);
}
function fmt(t) {
  if (!isFinite(t)) return '0:00';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}
function curMediaEl() { return mp.eqOn ? el : el2; }
function otherMediaEl() { return mp.eqOn ? el2 : el; }
function isNativeFull() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
function fitMode() {
  try {
    const m = localStorage.getItem('media.fit') || 'contain';
    return FIT_MODES.includes(m) ? m : 'contain';
  } catch (e) { return 'contain'; }
}

/* ---------- громкость ---------- */
function mediaVolSet(v) {
  const val = Math.min(100, Math.max(0, Math.round(v)));
  mp.vol = val;
  try { localStorage.setItem('media.vol', String(val)); } catch (e) {}
  // сообщаем главному окну — оно запомнит громкость для следующего открытия
  try { if (window.api.playerVolume) window.api.playerVolume(val); } catch (e) {}
  [el, el2].forEach(m => { if (m) m.volume = val / 100; });
  const ms = $('#media-vol'); if (ms) ms.value = val;
  const lb = $('#yt-vol-lbl'); if (lb) lb.textContent = val + '%';
}
function mpRole(d) {
  const m = curMediaEl(); if (m) m.muted = false;
  mp.vol = Math.min(100, Math.max(0, mp.vol + d));
  mediaVolSet(mp.vol);
}
function mpResumeCtx() {
  if (mp.ctx && mp.ctx.state === 'suspended') { try { mp.ctx.resume(); } catch (e) {} }
  if (mp.directCtx && mp.directCtx.state === 'suspended') { try { mp.directCtx.resume(); } catch (e) {} }
}

/* ---------- звук: визуализация и эквалайзер ---------- */
function mpEnsureDirectAnalyser() {
  if (mp.analyser2 || !el2 || !el2.captureStream) return;
  try {
    const stream = el2.captureStream();
    if (!stream || !stream.getAudioTracks().length) return;
    mp.directCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (mp.directCtx.state === 'suspended') { try { mp.directCtx.resume(); } catch (e) {} }
    mp.analyser2 = mp.directCtx.createAnalyser();
    mp.analyser2.fftSize = 512;
    mp.analyser2.smoothingTimeConstant = 0.82;
    mp.directCtx.createMediaStreamSource(stream).connect(mp.analyser2);
  } catch (e) { mp.analyser2 = null; }
}
function mpEnsureAudio() {
  if (mp.ctx) return;
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
  prev.connect(mp.analyser);
  mp.analyser.connect(mp.out);
  mp.out.connect(mp.ctx.destination);
}
function mpApplyEq(gains) {
  if (!mp.filters.length) return;
  mp.filters.forEach((b, i) => {
    b.gain.value = gains[i] || 0;
    const sl = document.querySelector('#eq-bands [data-band="' + i + '"]');
    if (sl) {
      sl.value = gains[i] || 0;
      const v = sl.parentElement.querySelector('.eq-val');
      if (v) v.textContent = (gains[i] > 0 ? '+' : '') + (gains[i] || 0) + ' дБ';
    }
  });
}
function mpBuildEq() {
  const box = $('#eq-bands');
  if (!box || box.children.length) return;
  box.innerHTML = EQ_FREQS.map((f, i) => `<div class="eq-band">
      <span class="eq-val">0 дБ</span>
      <input type="range" min="-12" max="12" step="1" value="0" data-band="${i}" data-tip="Полоса ${f >= 1000 ? (f / 1000) + ' кГц' : f + ' Гц'}">
      <span class="eq-freq">${f >= 1000 ? (f / 1000) + 'k' : f}</span>
    </div>`).join('');
  box.querySelectorAll('input[type=range]').forEach(sl => sl.oninput = () => {
    if (mp.filters[+sl.dataset.band]) mp.filters[+sl.dataset.band].gain.value = +sl.value;
    const v = sl.parentElement.querySelector('.eq-val');
    if (v) v.textContent = (+sl.value > 0 ? '+' : '') + sl.value + ' дБ';
  });
  $('#eq-presets').innerHTML = Object.keys(EQ_PRESETS).map(p => `<button class="chip" data-eqp="${p}" data-tip="Пресет эквалайзера: ${p}" style="padding:4px 10px;font-size:12px">${p}</button>`).join('');
  $('#eq-presets').querySelectorAll('[data-eqp]').forEach(b => b.onclick = () => mpApplyEq(EQ_PRESETS[b.dataset.eqp]));
}

/* ---------- визуализации ---------- */
function mpVisLabel() {
  const name = (window.VISLIB[mp.visIdx] || {}).name || '';
  const label = (mp.visIdx + 1) + '. ' + name;
  const elName = $('#media-vis-name'); if (elName) elName.textContent = label;
  [['#media-vis-prev', 'Предыдущая визуализация'], ['#media-vis-next', 'Следующая визуализация']]
    .forEach(([sel, prefix]) => { const b = $(sel); if (b) b.dataset.tip = prefix + (name ? ': ' + name : ''); });
}
function mpVisNav(d) {
  mp.visIdx = (mp.visIdx + d + window.VISLIB.length) % window.VISLIB.length;
  try { localStorage.setItem('media.vis', String(mp.visIdx)); } catch (e) {}
  mpVisLabel();
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
  mp.raf = requestAnimationFrame(mpDraw);
  const cv = $('#media-vis'); if (!cv) return;
  const ctx = cv.getContext('2d');
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const cw = Math.max(64, Math.round(cv.clientWidth * dpr));
  const ch = Math.max(48, Math.round(cv.clientHeight * dpr));
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
  if (mp.isVideo) return;
  const m = curMediaEl();
  const playing = !!(m && !m.paused && !m.ended && m.readyState >= 2);
  const a = mpVisAudioData();
  mp.visT = (mp.visT || 0) + (playing ? 0.016 : 0) + (playing ? a.energy * 0.02 : 0);
  const vis = window.VISLIB[mp.visIdx];
  if (vis) {
    try { vis.draw(ctx, cv.width, cv.height, mp.visT, playing ? a : { bass: 0, mid: 0, treble: 0, energy: 0, spectrum: [], wave: [] }); } catch (e) {}
  }
}

/* ---------- панель поверх видео ---------- */
function mpShowBar(force) {
  if (!bar) return;
  const isFs = shell.classList.contains('media-full') || isNativeFull();
  bar.classList.remove('yt-hidden');
  clearTimeout(barT);
  if (isFs && !force) barT = setTimeout(() => bar.classList.add('yt-hidden'), 2600);
}
function mpHideBarSoon() {
  if (!bar) return;
  const isFs = shell.classList.contains('media-full') || isNativeFull();
  if (!isFs) { bar.classList.remove('yt-hidden'); return; }
  clearTimeout(barT);
  barT = setTimeout(() => bar.classList.add('yt-hidden'), 2600);
}

/* ---------- загрузка трека ---------- */
async function mpLoad(full, opt) {
  opt = opt || {};
  if (!full) return;
  const seq = ++mp.loadSeq;
  const name = full.split('/').pop();
  mp.isVideo = VRE.test(name);
  mp.lastFull = full;
  try { el.pause(); } catch (e) {}
  try { el2.pause(); } catch (e) {}
  $('#media-title').textContent = name;
  $('#media-now-name').textContent = name;
  $('#media-now-sub').textContent = 'Загрузка с устройства…';
  $('#media-status').textContent = full;
  $('#media-visual').classList.toggle('hidden-when-video', mp.isVideo);
  $('#media-stage').classList.toggle('is-video', mp.isVideo);
  shell.classList.toggle('is-video', mp.isVideo);
  document.title = name + ' — плеер';

  let r = null;
  try { r = await window.api.mediaUrl(st.serial, full); } catch (e) {}
  if (seq !== mp.loadSeq) return;
  if (!r || !r.ok) {
    $('#media-now-sub').textContent = 'Не удалось открыть файл';
    $('#media-status').textContent = 'Проверьте подключение к телефону';
    return;
  }
  if (mp.eqOn) {
    mpEnsureAudio();
    if (mp.ctx && mp.ctx.state === 'suspended') { try { await mp.ctx.resume(); } catch (e) {} }
  }
  const m = curMediaEl();
  const other = otherMediaEl();
  other.classList.add('hidden');
  el.classList.toggle('hidden', !mp.eqOn || !mp.isVideo);
  el2.classList.toggle('hidden', mp.eqOn || !mp.isVideo);
  [el, el2].forEach(x => { try { x.removeAttribute('crossorigin'); } catch (e) {} });
  if (String(r.url).startsWith('http')) { el.crossOrigin = 'anonymous'; el2.crossOrigin = 'anonymous'; }
  m.src = r.url;
  m.volume = mp.vol / 100;
  m.style.objectFit = fitMode();
  m.style.objectPosition = 'center';
  const at = Number(opt.at) || 0;
  const start = () => {
    if (seq !== mp.loadSeq) return;
    if (at > 0) { try { m.currentTime = at; } catch (e) {} }
    if (opt.autoplay !== false) {
      mpResumeCtx();
      const pr = m.play();
      if (pr && pr.catch) pr.catch(() => { if (seq === mp.loadSeq) $('#media-now-sub').textContent = 'Нажмите ▶, чтобы запустить'; });
    }
  };
  if (m.readyState >= 1) start();
  else m.addEventListener('loadedmetadata', start, { once: true });
  if (!mp.eqOn) mpEnsureDirectAnalyser();
  $('#media-now-sub').textContent = (mp.isVideo ? 'Видео' : 'Аудио') + ' · поток с телефона';
}

function mpNav(d) {
  if (!list.length) return;
  idx = (idx + d + list.length) % list.length;
  mpLoad(list[idx], { autoplay: true });
}

/* ---------- полноэкранный режим ---------- */
function syncFullUi() {
  const full = shell.classList.contains('media-full') || isNativeFull();
  const b = $('#media-full');
  if (b) b.textContent = full ? 'В окно' : 'Во весь экран';
  const barEl = $('#media-ytbar');
  if (barEl) barEl.classList.remove('yt-hidden');
  mpShowBar(true);
}
function exitFullscreen() {
  try {
    if (isNativeFull()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } catch (e) {}
  shell.classList.remove('media-full');
  syncFullUi();
}
async function enterNativeFullscreen() {
  try { await (shell.requestFullscreen || shell.webkitRequestFullscreen).call(shell); }
  catch (e) { snack('Полноэкранный режим не поддержался: ' + (e.message || e)); }
}

/* ---------- состояние для возврата в приложение ---------- */
function outState() {
  const m = curMediaEl();
  return {
    path: mp.lastFull, idx,
    time: m ? (m.currentTime || 0) : 0,
    playing: !!(m && !m.paused && !m.ended),
    vol: mp.vol, fit: fitMode(), list, visIdx: mp.visIdx,
    theme: document.body.dataset.theme || 'dark'
  };
}
function closeWindow() {
  try {
    if (isNativeFull()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    el.pause(); el2.pause();
  } catch (e) {}
  window.api.playerAction('close', outState());
}

/* ---------- элементы управления ---------- */
function bindMedia(m) {
  m.addEventListener('play', () => { $('#media-play').textContent = '\u23F8'; mpShowBar(true); mpResumeCtx(); });
  m.addEventListener('pause', () => { $('#media-play').textContent = '\u25B6'; });
  m.addEventListener('timeupdate', () => {
    if (m !== curMediaEl()) return;
    $('#media-time').textContent = fmt(m.currentTime) + ' / ' + fmt(m.duration);
    if (m.duration && !seeking) $('#media-seek').value = Math.round(m.currentTime / m.duration * 1000);
  });
  m.addEventListener('ended', () => { if (m === curMediaEl()) mpNav(1); });
  m.addEventListener('loadeddata', () => {
    if (m === curMediaEl()) $('#media-now-sub').textContent = (mp.isVideo ? 'Видео' : 'Аудио') + ' · готово';
  });
  m.addEventListener('error', () => {
    if (m !== curMediaEl()) return;
    $('#media-now-sub').textContent = 'Этот кодек браузер не играет — нажмите «На ПК»';
    $('#media-status').textContent = 'Формат не поддержан Chromium. Кнопки «Скачать» и «На ПК» работают.';
  });
}
bindMedia(el); bindMedia(el2);

$('#media-play').onclick = () => {
  const m = curMediaEl();
  if (!m || !m.src) return;
  mpResumeCtx();
  if (m.paused) { const pr = m.play(); if (pr && pr.catch) pr.catch(() => {}); }
  else m.pause();
};
$('#media-prev').onclick = () => mpNav(-1);
$('#media-next').onclick = () => mpNav(1);

$('#media-seek').oninput = () => {
  seeking = true;
  const m = curMediaEl();
  if (m && m.duration) m.currentTime = (+$('#media-seek').value / 1000) * m.duration;
};
$('#media-seek').addEventListener('change', () => { seeking = false; });
window.addEventListener('pointerup', () => { seeking = false; });
$('#media-seek').addEventListener('wheel', e => {
  e.preventDefault();
  const m = curMediaEl();
  if (!m || !m.duration) return;
  const step = (e.deltaMode === 1 ? 30 : 10) * (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 3 : 1);
  m.currentTime = Math.min(m.duration - 0.05, Math.max(0, m.currentTime + step));
}, { passive: false });
$('#media-vol').addEventListener('wheel', e => {
  e.preventDefault();
  mpRole((e.deltaMode === 1 ? 10 : 1) * (e.deltaY < 0 ? 1 : -1));
}, { passive: false });
$('#media-vol').oninput = () => { const m = curMediaEl(); if (m) m.muted = false; mediaVolSet(+$('#media-vol').value); };
$('#yt-volbtn').onclick = () => {
  const m = curMediaEl(); if (!m) return;
  if (m.muted || mp.vol === 0) { m.muted = false; mediaVolSet(mp.vol || MEDIA_VOL_DEFAULT); }
  else { m.muted = true; $('#yt-vol-lbl').textContent = '0%'; }
};

$('#media-fit').onclick = () => {
  const next = FIT_MODES[(FIT_MODES.indexOf(fitMode()) + 1) % FIT_MODES.length];
  try { localStorage.setItem('media.fit', next); } catch (e) {}
  applyFit();
  snack('Видео: ' + FIT_LABELS[next]);
};
function applyFit() {
  const mode = fitMode();
  FIT_MODES.forEach(m => shell.classList.toggle('fit-' + m, m === mode));
  [el, el2].forEach(x => { if (x) { x.style.objectFit = mode; x.style.objectPosition = 'center'; } });
  const b = $('#media-fit');
  if (b) {
    b.textContent = mode === 'cover' ? '\u2922' : mode === 'fill' ? '\u25A3' : '\u25A1';
    b.dataset.tip = 'Заполнение: ' + FIT_LABELS[mode] + ' (клик — сменить)';
  }
}

$('#media-eqbtn').onclick = async () => {
  const wasOn = mp.eqOn;
  mp.eqOn = !wasOn;
  try { localStorage.setItem('media.eq', mp.eqOn ? '1' : '0'); } catch (e) {}
  $('#media-eq').classList.toggle('hidden', !mp.eqOn);
  const m = curMediaEl();
  const t = (m && m.currentTime) || 0;
  if (mp.eqOn) mpEnsureAudio();
  if (mp.ctx && mp.ctx.state === 'suspended') { try { await mp.ctx.resume(); } catch (e) {} }
  if (mp.lastFull) await mpLoad(mp.lastFull, { at: t, autoplay: true });
  snack(mp.eqOn ? 'Эквалайзер включён (звук через аудио-движок)' : 'Прямое воспроизведение (эквалайзер выключен)');
};

$('#media-dl').onclick = async () => {
  if (!mp.lastFull) return;
  const r = await window.api.fsPull(st.serial, mp.lastFull);
  snack(r && r.ok ? 'Сохранено: ' + r.file : 'Не удалось скачать');
};
$('#media-openpc').onclick = async () => {
  if (!mp.lastFull) return;
  snack('Скачиваю и открываю системным плеером…');
  const r = await window.api.fsOpenOnPc(st.serial, mp.lastFull);
  snack(r && r.ok ? 'Открыто в системном плеере' : ((r && r.error) || 'Не удалось'));
};

$('#media-vis-prev').onclick = () => mpVisNav(-1);
$('#media-vis-next').onclick = () => mpVisNav(1);

$('#media-full').onclick = () => {
  if (isNativeFull()) { exitFullscreen(); return; }
  shell.classList.toggle('media-full');
  syncFullUi();
  mpShowBar(true);
};
$('#yt-full').onclick = () => enterNativeFullscreen();
$('#yt-window').onclick = () => exitFullscreen();
$('#yt-close').onclick = () => closeWindow();

$('#btn-media-min').onclick = () => window.api.playerAction('min', {});
$('#btn-media-fs').onclick = () => { if (isNativeFull()) exitFullscreen(); else enterNativeFullscreen(); };
$('#btn-media-close').onclick = () => closeWindow();

document.addEventListener('fullscreenchange', () => { shell.classList.remove('media-full'); syncFullUi(); });
document.addEventListener('webkitfullscreenchange', () => { shell.classList.remove('media-full'); syncFullUi(); });

stage.addEventListener('mousemove', () => mpShowBar());
stage.addEventListener('mouseleave', () => mpHideBarSoon());
stage.addEventListener('click', e => {
  if (e.target.closest('.media-ytbar')) return;
  if (e.target.tagName === 'VIDEO') {
    const m = curMediaEl();
    if (m) { m.paused ? m.play().catch(() => {}) : m.pause(); }
  }
});

document.addEventListener('keydown', e => {
  const t = e.target;
  if (t && t.closest && t.closest('input, textarea, select, button')) {
    if (e.key === 'Escape') { if (shell.classList.contains('media-full') || isNativeFull()) { exitFullscreen(); e.preventDefault(); } }
    return;
  }
  if (e.key === 'Escape') {
    if (isNativeFull() || shell.classList.contains('media-full')) { exitFullscreen(); e.preventDefault(); }
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); $('#media-play').click(); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); const m = curMediaEl(); if (m) m.currentTime = Math.max(0, m.currentTime - 10); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); const m = curMediaEl(); if (m) m.currentTime = Math.min(m.duration || 0, m.currentTime + 10); }
  else if (e.code === 'ArrowUp') { e.preventDefault(); mpRole(5); }
  else if (e.code === 'ArrowDown') { e.preventDefault(); mpRole(-5); }
});

/* ---------- запуск ---------- */
window.api.onPlayerInit(payload => {
  st = payload || {};
  list = Array.isArray(st.list) && st.list.length ? st.list.slice() : (st.path ? [st.path] : []);
  idx = Math.max(0, Math.min(list.length - 1, Number(st.idx) || 0));
  if (st.path) { const j = list.indexOf(st.path); if (j >= 0) idx = j; }
  if (st.theme) document.body.dataset.theme = st.theme;
  mp.vol = Number.isFinite(+st.vol) ? Math.max(0, Math.min(100, +st.vol)) : MEDIA_VOL_DEFAULT;
  mp.visIdx = Number.isFinite(+st.visIdx) ? Math.max(0, Math.min(window.VISLIB.length - 1, +st.visIdx)) : 0;
  mp.eqOn = !!st.eq;
  try { localStorage.setItem('media.fit', FIT_MODES.includes(st.fit) ? st.fit : 'contain'); } catch (e) {}
  mediaVolSet(mp.vol);
window.api.onPlayerCmd(cmd => {
  if (cmd === 'pause') { try { el.pause(); el2.pause(); } catch (e) {} }
});

/* подсказки при наведении — как в основном окне (data-tip) */
(function initTips() {
  const tip = $('#player-tip');
  if (!tip) return;
  let cur = null, timer = 0;
  const place = () => {
    if (!cur) return;
    const r = cur.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    let y = r.top - th - 8;
    if (y < 6) y = r.bottom + 8;
    x = Math.max(6, Math.min(x, window.innerWidth - tw - 6));
    y = Math.max(6, Math.min(y, window.innerHeight - th - 6));
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  };
  const hide = () => { clearTimeout(timer); cur = null; tip.classList.add('hidden'); };
  document.addEventListener('mouseover', e => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el || el === cur) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      cur = el;
      tip.textContent = el.getAttribute('data-tip') || '';
      tip.classList.remove('hidden');
      place();
    }, 320);
  });
  document.addEventListener('mouseout', e => {
    if (!cur) return;
    const to = e.relatedTarget;
    if (to && cur.contains(to)) return;
    hide();
  });
  window.addEventListener('mousemove', place);
  window.addEventListener('blur', hide);
  document.addEventListener('mouseleave', hide);
  document.addEventListener('pointerdown', hide, true);
})();

mpBuildEq();
  $('#media-eq').classList.toggle('hidden', !mp.eqOn);
  applyFit();
  mpVisLabel();
  syncFullUi();
  if (!mp.raf) mp.raf = requestAnimationFrame(mpDraw);
  mpLoad(st.path, { at: Number(st.time) || 0, autoplay: st.playing !== false });
});

mpBuildEq();
applyFit();
syncFullUi();
if (!mp.raf) mp.raf = requestAnimationFrame(mpDraw);
