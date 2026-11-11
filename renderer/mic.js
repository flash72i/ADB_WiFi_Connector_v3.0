'use strict';
(() => {
  const ORIGIN = 'http://127.0.0.1:27191';
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isLight = () => document.body.dataset.theme === 'light';

  let serverReady = false;
  let pollTimer = null;
  let running = false;
  let recording = false;
  let targetWave = new Array(64).fill(0);
  let shownWave = new Array(64).fill(0);
  let levelL = 0;
  let levelR = 0;
  let devicesFilled = false;
  let startingMic = false;
  let autostart = false;
  try { autostart = localStorage.getItem('micAutostart') === '1'; } catch (e) {}

  async function request(path) {
    const res = await fetch(ORIGIN + path, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  function setStatus(text, kind) {
    const el = $('mic-status');
    if (!el) return;
    el.textContent = text;
    el.style.color = kind === 'err' ? '#ff7676' : kind === 'ok' ? '#7bd88f' : '';
  }

  function setLive(text, live) {
    const dot = $('mic-dot');
    if (dot) dot.classList.toggle('live', !!live);
    const label = $('mic-live-text');
    if (label) label.textContent = text;
  }

  function setButtons() {
    const start = $('mic-start');
    const stop = $('mic-stop');
    if (start) start.disabled = running;
    if (stop) stop.disabled = !running;
  }

  function fillDevices(st) {
    const select = $('mic-device');
    if (!select || !st || !Array.isArray(st.devices)) return;
    const list = st.devices.filter((d) => !d.cable);
    if (!list.length) return;
    const current = select.value;
    if (!devicesFilled || select.options.length !== list.length) {
      select.innerHTML = '';
      list.forEach((d) => {
        const option = document.createElement('option');
        option.value = String(d.id);
        option.textContent = d.name;
        select.appendChild(option);
      });
      devicesFilled = true;
    }
    if (current && [...select.options].some((o) => o.value === current)) {
      select.value = current;
    } else if (st.listen != null) {
      select.value = String(st.listen);
    }
  }

  async function ensureServer() {
    if (serverReady) return true;
    if (!window.api || !window.api.audioStart) {
      setStatus('Мост аудио не загружен. Перезапустите приложение.', 'err');
      return false;
    }
    try {
      const r = await window.api.audioStart();
      if (!r || !r.ok) throw new Error((r && r.error) || 'Не удалось запустить аудиосервер');
      for (let i = 0; i < 30; i += 1) {
        try {
          const st = await request('/status');
          if (st && st.ok) {
            serverReady = true;
            applyStatus(st);
            return true;
          }
        } catch (e) {}
        await sleep(200);
      }
      throw new Error('Аудиосервер не ответил');
    } catch (e) {
      setStatus(String((e && e.message) || e), 'err');
      return false;
    }
  }

  async function ensureDefaultMic() {
    if (!window.api || !window.api.systemMics || !window.api.systemMicSet) return;
    try {
      const r = await window.api.systemMics();
      if (!r || !r.ok) return;
      const device = (r.devices || []).find((d) => d.virtual);
      if (device && !device.default) await window.api.systemMicSet(device.id);
    } catch (e) {}
  }

  async function startStream() {
    if (startingMic) return;
    startingMic = true;
    if (!(await ensureServer())) {
      startingMic = false;
      return;
    }
    if (autostart) ensureDefaultMic();
    try {
      setStatus('Запускаю микрофон…');
      const listen = $('mic-listen')?.checked ? 1 : 0;
      const virtual = 1;
      const device = $('mic-device')?.value || '';
      await request('/start?listen=' + listen + '&virtual=' + virtual + '&device=' + encodeURIComponent(device));
      setStatus('Микрофон запускается…');
      startPolling();
    } catch (e) {
      setStatus(String((e && e.message) || e), 'err');
    }
    startingMic = false;
  }

  async function stopStream() {
    try { await request('/stop'); } catch (e) {}
    setStatus('Остановлено');
    setLive('не подключён', false);
    running = false;
    recording = false;
    setButtons();
    const waveIdle = $('mic-wave-idle');
    if (waveIdle) waveIdle.style.display = 'flex';
    const timer = $('mic-timer');
    if (timer) timer.textContent = '';
  }

  async function restartIfRunning() {
    if (running) await startStream();
  }

  function applyStatus(st) {
    if (!st) return;
    running = !!st.running;
    recording = !!st.recording;
    setButtons();
    fillDevices(st);
    const statusText = st.status || 'Готов';
    const isError = /Ошибка|не найден|не открылся|не запущен/i.test(statusText);
    setStatus(statusText, isError ? 'err' : (running ? 'ok' : ''));
    setLive(running ? 'в эфире' : 'не подключён', running);

    const levels = Array.isArray(st.level) ? st.level : [0, 0];
    levelL = Math.max(0, Math.min(1, Number(levels[0]) || 0));
    levelR = Math.max(0, Math.min(1, Number(levels[1]) || 0));
    const left = $('mic-level-l');
    const right = $('mic-level-r');
    if (left) left.style.transform = 'scaleX(' + levelL + ')';
    if (right) right.style.transform = 'scaleX(' + levelR + ')';

    if (Array.isArray(st.wave) && st.wave.length) {
      targetWave = st.wave.map((v) => Math.max(0, Math.min(1, Number(v) || 0)));
    } else if (!running) {
      targetWave = new Array(64).fill(0);
    }

    const rec = $('mic-record');
    if (rec) {
      rec.classList.toggle('recording', recording);
      rec.innerHTML = recording ? '<span>&#9632;</span> Остановить запись' : '<span>&#9679;</span> Записать';
    }
    const timer = $('mic-timer');
    if (timer) timer.textContent = recording ? Number(st.seconds || 0).toFixed(1) + ' с' : '';
    if (st.path) {
      const saved = $('mic-saved');
      if (saved) saved.textContent = String(st.path).split(/[\\/]/).pop();
    }
    const waveIdle = $('mic-wave-idle');
    if (waveIdle) waveIdle.style.display = running ? 'none' : 'flex';
  }

  async function poll() {
    if (!serverReady) return;
    try {
      const st = await request('/status');
      applyStatus(st);
    } catch (e) {
      setStatus('Нет связи с аудиосервером', 'err');
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(poll, 70);
  }

  async function toggleRecording() {
    try {
      if (recording) {
        await request('/record/stop');
        setStatus('Запись остановлена', 'ok');
      } else {
        const r = await request('/record/start');
        setStatus('Запись MP3: ' + String(r.path || '').split(/[\\/]/).pop(), 'ok');
      }
      await poll();
    } catch (e) {
      setStatus(String((e && e.message) || e), 'err');
    }
  }

  const canvas = $('mic-wave');
  const ctx = canvas ? canvas.getContext('2d') : null;
  const VIZ_KEY = 'micVisualizer';
  const VIZ_MODES = ['rings', 'pulse', 'space', 'bars'];
  const savedViz = (() => {
    try { return localStorage.getItem(VIZ_KEY); } catch (e) { return null; }
  })();
  let vizMode = VIZ_MODES.includes(savedViz) ? savedViz : 'rings';
  let W = 0;
  let H = 0;
  let DPR = 1;
  let vizTime = 0;
  let lastFrameAt = 0;
  let vizEnergy = 0;
  let vizRings = [];
  let vizParticles = [];
  let lastRingAt = 0;

  function resizeCanvas() {
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(280, Math.round(rect.width || 800));
    H = Math.max(120, Math.round(rect.height || 190));
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    vizParticles = Array.from({ length: 72 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      r: 0.6 + Math.random() * 1.8,
      a: 0.18 + Math.random() * 0.6,
      tw: 0.6 + Math.random() * 2.2,
      ph: Math.random() * Math.PI * 2,
      vx: (Math.random() - 0.5) * 7,
      vy: (Math.random() - 0.5) * 4
    }));
    vizRings = [];
  }

  function sampleWave(u) {
    if (!shownWave.length) return 0;
    const p = Math.max(0, Math.min(0.9999, u)) * (shownWave.length - 1);
    const i = Math.floor(p);
    const f = p - i;
    return (shownWave[i] || 0) * (1 - f) + (shownWave[Math.min(shownWave.length - 1, i + 1)] || 0) * f;
  }

  function drawBars() {
    const light = isLight();
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    if (light) {
      bg.addColorStop(0, 'rgba(22, 127, 196, 0.14)');
      bg.addColorStop(0.55, 'rgba(22, 127, 196, 0.04)');
      bg.addColorStop(1, 'rgba(255, 255, 255, 0)');
    } else {
      bg.addColorStop(0, 'rgba(29, 78, 216, 0.14)');
      bg.addColorStop(0.55, 'rgba(7, 12, 24, 0.02)');
      bg.addColorStop(1, 'rgba(0, 0, 0, 0)');
    }
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = light ? 'rgba(20, 80, 120, 0.24)' : 'rgba(120, 160, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();

    const count = shownWave.length;
    const gap = 4;
    const barW = Math.max(2, (W - gap * (count - 1)) / count);
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    if (light) {
      grad.addColorStop(0, '#0b6ea8');
      grad.addColorStop(0.5, '#0e5e9e');
      grad.addColorStop(1, '#3d3f94');
    } else {
      grad.addColorStop(0, '#66d9ff');
      grad.addColorStop(0.5, '#4c8dff');
      grad.addColorStop(1, '#7a5cff');
    }
    ctx.fillStyle = grad;
    ctx.shadowColor = light ? 'transparent' : 'rgba(76, 141, 255, 0.55)';
    ctx.shadowBlur = light ? 0 : 14;

    for (let i = 0; i < count; i += 1) {
      const minH = 3;
      const idle = 0.08 + 0.05 * (0.5 + 0.5 * Math.sin(vizTime * 1.5 + i * 0.55));
      const value = Math.max(shownWave[i] || 0, idle);
      const barH = Math.max(minH, value * H * 0.86);
      const x = i * (barW + gap);
      const y = (H - barH) / 2;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, Math.min(barW / 2, 4));
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  function drawWarmWave(amp, phase, alpha, width, mirror) {
    const light = isLight();
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    if (light) {
      grad.addColorStop(0, 'rgba(160, 64, 10, 0)');
      grad.addColorStop(0.18, 'rgba(160, 64, 10, ' + (alpha * 0.82) + ')');
      grad.addColorStop(0.5, 'rgba(190, 96, 10, ' + Math.min(1, alpha * 1.12) + ')');
      grad.addColorStop(0.82, 'rgba(160, 64, 10, ' + (alpha * 0.82) + ')');
      grad.addColorStop(1, 'rgba(160, 64, 10, 0)');
    } else {
      grad.addColorStop(0, 'rgba(190, 74, 29, 0)');
      grad.addColorStop(0.18, 'rgba(190, 74, 29, ' + (alpha * 0.7) + ')');
      grad.addColorStop(0.5, 'rgba(255, 191, 72, ' + alpha + ')');
      grad.addColorStop(0.82, 'rgba(190, 74, 29, ' + (alpha * 0.7) + ')');
      grad.addColorStop(1, 'rgba(190, 74, 29, 0)');
    }
    ctx.strokeStyle = grad;
    ctx.lineWidth = light ? width * 1.15 : width;
    ctx.shadowColor = light ? 'transparent' : 'rgba(255, 191, 72, 0.55)';
    ctx.shadowBlur = light ? 0 : 12;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 2) {
      const u = x / W;
      const env = Math.pow(Math.max(0, 1 - Math.abs(u - 0.5) * 2), 0.72);
      const v = sampleWave(u);
      const base = Math.sin(u * 17 + vizTime * 1.7 + phase) * 0.24
        + Math.sin(u * 7 - vizTime * 1.1 + phase * 1.7) * 0.16;
      const y = H / 2 + (v * 0.75 + base) * amp * env * (mirror ? -1 : 1);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function drawRings(dt) {
    const light = isLight();
    ctx.fillStyle = light ? '#e7eff5' : '#070402';
    ctx.fillRect(0, 0, W, H);
    const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    bg.addColorStop(0, light ? 'rgba(196, 120, 40, 0.24)' : 'rgba(84, 38, 10, 0.45)');
    bg.addColorStop(0.55, light ? 'rgba(150, 90, 30, 0.11)' : 'rgba(38, 17, 6, 0.25)');
    bg.addColorStop(1, light ? 'rgba(231, 239, 245, 0)' : 'rgba(7, 4, 2, 0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    const warm = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.5);
    warm.addColorStop(0, light ? 'rgba(170, 82, 18, 0.14)' : 'rgba(120, 60, 20, 0.22)');
    warm.addColorStop(0.55, light ? 'rgba(140, 70, 18, 0.06)' : 'rgba(84, 38, 10, 0.1)');
    warm.addColorStop(1, light ? 'rgba(231, 239, 245, 0)' : 'rgba(7, 4, 2, 0)');
    ctx.fillStyle = warm;
    ctx.fillRect(0, 0, W, H);

    const ringGap = vizEnergy > 0.06 ? 0.34 : 0.9;
    if (vizTime - lastRingAt > ringGap) {
      vizRings.push({
        r: 18,
        life: 1,
        speed: W * 0.18 + Math.random() * W * 0.12
      });
      if (vizRings.length > 7) vizRings.shift();
      lastRingAt = vizTime;
    }

    ctx.globalCompositeOperation = light ? 'source-over' : 'lighter';
    for (let i = vizRings.length - 1; i >= 0; i -= 1) {
      const ring = vizRings[i];
      ring.r += ring.speed * dt;
      ring.life -= dt * 0.55;
      if (ring.life <= 0) {
        vizRings.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(1, 0.36);
      ctx.beginPath();
      ctx.arc(0, 0, ring.r, 0, Math.PI * 2);
      ctx.strokeStyle = light
        ? 'rgba(157, 67, 10, ' + (0.55 * ring.life) + ')'
        : 'rgba(255, 191, 72, ' + (0.3 * ring.life) + ')';
      ctx.lineWidth = light ? 2.4 : 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, ring.r * 0.82, 0, Math.PI * 2);
      ctx.strokeStyle = light
        ? 'rgba(110, 45, 5, ' + (0.3 * ring.life) + ')'
        : 'rgba(190, 74, 29, ' + (0.18 * ring.life) + ')';
      ctx.lineWidth = light ? 1.5 : 1.2;
      ctx.stroke();
      ctx.restore();
    }

    for (const p of vizParticles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < -10 || p.x > W + 10 || p.y < -10 || p.y > H + 10) {
        p.x = W / 2 + (Math.random() - 0.5) * W;
        p.y = H / 2 + (Math.random() - 0.5) * H;
      }
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(vizTime * p.tw + p.ph));
      const particleColor = light ? '120, 55, 10' : '255, 191, 72';
      ctx.fillStyle = 'rgba(' + particleColor + ', ' + (p.a * tw * (light ? 0.8 : 0.55) + (light ? 0 : vizEnergy * 0.4)) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = 0; i < 12; i += 1) {
      const v = targetWave[Math.min(targetWave.length - 1, Math.floor(i * targetWave.length / 12))] || 0;
      const x = W * (0.08 + i * 0.076);
      const h = H * (0.05 + v * 0.4) * (0.5 + vizEnergy * 0.6);
      const grad = ctx.createLinearGradient(0, H / 2 - h, 0, H / 2 + h);
      if (light) {
        grad.addColorStop(0, 'rgba(150, 64, 8, 0)');
        grad.addColorStop(0.5, 'rgba(190, 96, 10, 0.48)');
        grad.addColorStop(1, 'rgba(150, 64, 8, 0)');
      } else {
        grad.addColorStop(0, 'rgba(190, 74, 29, 0)');
        grad.addColorStop(0.5, 'rgba(255, 191, 72, 0.32)');
        grad.addColorStop(1, 'rgba(190, 74, 29, 0)');
      }
      ctx.fillStyle = grad;
      ctx.fillRect(x, H / 2 - h, 1.2, h * 2);
    }

    const amp = H * 0.33 * (0.72 + vizEnergy * 1.05);
    drawWarmWave(amp * 0.6, 0.2, 0.55, 1.4, false);
    drawWarmWave(amp, 1.5, 1, 2.4, false);
    drawWarmWave(amp * 0.82, 3.1, 0.42, 1.6, true);
    drawWarmWave(amp * 1.18, 4.4, 0.32, 1.4, false);
    drawWarmWave(amp * 0.72, 5.4, 0.24, 1.2, true);

    const core = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, H * 0.28);
    if (light) {
      core.addColorStop(0, 'rgba(190, 92, 12, ' + (0.45 + vizEnergy * 0.3) + ')');
      core.addColorStop(0.35, 'rgba(210, 120, 30, ' + (0.28 + vizEnergy * 0.2) + ')');
      core.addColorStop(1, 'rgba(160, 70, 10, 0)');
    } else {
      core.addColorStop(0, 'rgba(255, 252, 244, ' + (0.55 + vizEnergy * 0.35) + ')');
      core.addColorStop(0.35, 'rgba(255, 220, 140, ' + (0.34 + vizEnergy * 0.22) + ')');
      core.addColorStop(1, 'rgba(255, 191, 72, 0)');
    }
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(1, 0.55);
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(0, 0, H * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawPulseWave(amp, phase, color, width, glow) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.shadowColor = color;
    ctx.shadowBlur = glow;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 2) {
      const u = x / W;
      const env = Math.pow(Math.max(0, 1 - Math.abs(u - 0.5) * 1.9), 0.7);
      const v = sampleWave(u);
      const wiggle = Math.sin(u * 19 + vizTime * 2 + phase) * 0.55
        + Math.sin(u * 8 - vizTime * 1.3 + phase) * 0.25;
      const y = H / 2 + (wiggle + v * 0.45) * amp * env;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function drawPulse() {
    const light = isLight();
    ctx.fillStyle = light ? '#e5eff7' : '#030711';
    ctx.fillRect(0, 0, W, H);
    const bg = ctx.createRadialGradient(W / 2, H / 2, 2, W / 2, H / 2, W * 0.52);
    bg.addColorStop(0, light
      ? 'rgba(10, 110, 170, ' + (0.16 + vizEnergy * 0.2) + ')'
      : 'rgba(0, 150, 255, ' + (0.1 + vizEnergy * 0.18) + ')');
    bg.addColorStop(0.5, light ? 'rgba(10, 100, 160, 0.1)' : 'rgba(0, 90, 200, 0.04)');
    bg.addColorStop(1, light ? 'rgba(229, 239, 247, 0)' : 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = light ? 'source-over' : 'lighter';

    for (let i = 0; i < 16; i += 1) {
      const p = i / 16;
      drawPulseWave(
        12 + vizEnergy * 44 + p * 10,
        p * Math.PI * 2,
        light
          ? 'rgba(10, 90, 150, ' + (0.12 + p * 0.12) + ')'
          : 'rgba(15, 125, 255, ' + (0.1 + p * 0.1) + ')',
        0.8,
        light ? 0 : 5
      );
    }

    const layers = light ? [
      { a: 15, p: 0.2, c: 'rgba(5, 95, 150, .48)' },
      { a: 23, p: 1.5, c: 'rgba(0, 120, 180, .55)' },
      { a: 31, p: 3.0, c: 'rgba(10, 100, 170, .68)' },
      { a: 40, p: 4.5, c: 'rgba(0, 140, 200, .6)' },
      { a: 50, p: 2.1, c: 'rgba(0, 80, 150, .45)' }
    ] : [
      { a: 15, p: 0.2, c: 'rgba(0, 130, 255, .55)' },
      { a: 23, p: 1.5, c: 'rgba(0, 180, 255, .62)' },
      { a: 31, p: 3.0, c: 'rgba(30, 160, 255, .8)' },
      { a: 40, p: 4.5, c: 'rgba(80, 205, 255, .7)' },
      { a: 50, p: 2.1, c: 'rgba(0, 110, 255, .5)' }
    ];
    layers.forEach((l, i) => {
      drawPulseWave(l.a + vizEnergy * (40 + i * 11), l.p, l.c, 1.4, light ? 0 : 9 + vizEnergy * 14);
    });
    drawPulseWave(10 + vizEnergy * 68, 0, light ? 'rgba(0, 85, 145, .95)' : 'rgba(170, 235, 255, .92)', light ? 2.2 : 2, light ? 0 : 18 + vizEnergy * 22);

    const axis = ctx.createLinearGradient(0, 0, W, 0);
    if (light) {
      axis.addColorStop(0, 'rgba(0, 100, 160, 0)');
      axis.addColorStop(0.3, 'rgba(0, 100, 160, .35)');
      axis.addColorStop(0.5, 'rgba(0, 70, 120, .65)');
      axis.addColorStop(0.7, 'rgba(0, 100, 160, .35)');
      axis.addColorStop(1, 'rgba(0, 100, 160, 0)');
    } else {
      axis.addColorStop(0, 'rgba(0, 120, 255, 0)');
      axis.addColorStop(0.3, 'rgba(40, 160, 255, .22)');
      axis.addColorStop(0.5, 'rgba(190, 240, 255, .8)');
      axis.addColorStop(0.7, 'rgba(40, 160, 255, .22)');
      axis.addColorStop(1, 'rgba(0, 120, 255, 0)');
    }
    ctx.strokeStyle = axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();

    for (let i = 0; i < 45; i += 1) {
      const x = ((i * 97 + vizTime * 35) % W + W) % W;
      const y = H / 2 + Math.sin(x * 0.025 + vizTime * 2 + i) * (12 + vizEnergy * 55);
      const alpha = 0.2 + Math.abs(Math.sin(vizTime * 2 + i)) * 0.5;
      ctx.beginPath();
      ctx.arc(x, y, 1 + vizEnergy * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = light
        ? 'rgba(0, 95, 150, ' + Math.min(0.9, alpha + 0.1) + ')'
        : 'rgba(120, 220, 255, ' + alpha + ')';
      if (!light) {
        ctx.shadowColor = '#009dff';
        ctx.shadowBlur = 8;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawNebulaBlob(x, y, rx, ry, color, alpha, rotation) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation || 0);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, color.replace('ALPHA', String(alpha)));
    g.addColorStop(0.3, color.replace('ALPHA', String(alpha * 0.55)));
    g.addColorStop(0.68, color.replace('ALPHA', String(alpha * 0.12)));
    g.addColorStop(1, color.replace('ALPHA', '0'));
    ctx.scale(1, ry / rx);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawSpaceRibbon(amp, phase, frequency, color, width, glow) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.shadowColor = glow;
    ctx.shadowBlur = isLight() ? 0 : 14 + vizEnergy * 18;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 2) {
      const u = x / W;
      const nx = (u - 0.5) * 2;
      const env = Math.pow(Math.max(0, 1 - nx * nx), 0.65);
      const v = sampleWave(u);
      const y = H * 0.52
        + (Math.sin(nx * frequency + vizTime + phase) * 0.8
          + Math.sin(nx * frequency * 0.53 - vizTime * 0.7 + phase) * 0.3
          + v * 0.6) * amp * (0.7 + vizEnergy * 1.3) * env;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function drawSpace(dt) {
    const light = isLight();
    ctx.fillStyle = light ? '#e5edf4' : '#03040b';
    ctx.fillRect(0, 0, W, H);
    const cy = H * 0.52;
    const spread = Math.min(W * 0.34, 340);

    ctx.globalCompositeOperation = light ? 'source-over' : 'lighter';
    for (const p of vizParticles) {
      p.x += p.vx * dt * 0.25;
      p.y += p.vy * dt * 0.12;
      if (p.x < 0) p.x = W;
      if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H;
      if (p.y > H) p.y = 0;
      const a = p.a * (0.5 + 0.5 * Math.sin(vizTime * p.tw + p.ph));
      ctx.fillStyle = light
        ? 'rgba(24, 72, 110, ' + Math.min(0.85, a * 1.25) + ')'
        : 'rgba(160, 205, 255, ' + a + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }

    if (light) {
      drawNebulaBlob(W * 0.5, cy, spread * 1.25, spread * 0.42, 'rgba(20,70,160,ALPHA)', 0.24 + vizEnergy * 0.14, 0);
      drawNebulaBlob(W * 0.43, cy - 14, spread * 0.8, spread * 0.36, 'rgba(80,30,150,ALPHA)', 0.27 + vizEnergy * 0.12, -0.2);
      drawNebulaBlob(W * 0.57, cy + 12, spread * 0.8, spread * 0.36, 'rgba(0,110,160,ALPHA)', 0.25 + vizEnergy * 0.14, 0.2);
      drawNebulaBlob(W * 0.5, cy, spread * 0.58, spread * 0.22, 'rgba(120,25,160,ALPHA)', 0.2 + vizEnergy * 0.14, 0);
    } else {
      drawNebulaBlob(W * 0.5, cy, spread * 1.25, spread * 0.42, 'rgba(30,100,255,ALPHA)', 0.16 + vizEnergy * 0.12, 0);
      drawNebulaBlob(W * 0.43, cy - 14, spread * 0.8, spread * 0.36, 'rgba(70,30,210,ALPHA)', 0.2 + vizEnergy * 0.1, -0.2);
      drawNebulaBlob(W * 0.57, cy + 12, spread * 0.8, spread * 0.36, 'rgba(0,170,255,ALPHA)', 0.18 + vizEnergy * 0.12, 0.2);
      drawNebulaBlob(W * 0.5, cy, spread * 0.58, spread * 0.22, 'rgba(150,40,210,ALPHA)', 0.14 + vizEnergy * 0.12, 0);
    }

    if (light) {
      drawSpaceRibbon(46, 0.2, 10, 'rgba(0,80,180,.55)', 2.2, '#004f9e');
      drawSpaceRibbon(34, 2.1, 14, 'rgba(60,40,170,.58)', 2, '#3a2a9e');
      drawSpaceRibbon(26, 4.0, 18, 'rgba(0,125,175,.62)', 1.8, '#006f9e');
      drawSpaceRibbon(18, 1.2, 22, 'rgba(120,25,180,.55)', 1.6, '#7a1a9e');
      drawSpaceRibbon(12, 3.4, 16, 'rgba(0,60,120,.68)', 1.4, '#003f7a');
    } else {
      drawSpaceRibbon(46, 0.2, 10, 'rgba(0,110,255,.28)', 1.8, '#087aff');
      drawSpaceRibbon(34, 2.1, 14, 'rgba(70,80,255,.42)', 1.6, '#514fff');
      drawSpaceRibbon(26, 4.0, 18, 'rgba(0,210,255,.5)', 1.4, '#00caff');
      drawSpaceRibbon(18, 1.2, 22, 'rgba(190,95,255,.42)', 1.2, '#a34bff');
      drawSpaceRibbon(12, 3.4, 16, 'rgba(220,245,255,.7)', 1, '#8beaff');
    }

    const orbR = H * (0.07 + vizEnergy * 0.1);
    const orb = ctx.createRadialGradient(W / 2, cy, 0, W / 2, cy, orbR);
    if (light) {
      orb.addColorStop(0, 'rgba(0, 85, 150, ' + (0.5 + vizEnergy * 0.3) + ')');
      orb.addColorStop(0.35, 'rgba(0, 130, 190, ' + (0.3 + vizEnergy * 0.22) + ')');
      orb.addColorStop(1, 'rgba(0, 95, 160, 0)');
    } else {
      orb.addColorStop(0, 'rgba(255, 255, 255, ' + (0.35 + vizEnergy * 0.4) + ')');
      orb.addColorStop(0.35, 'rgba(160, 225, 255, ' + (0.22 + vizEnergy * 0.25) + ')');
      orb.addColorStop(1, 'rgba(60, 130, 255, 0)');
    }
    ctx.save();
    ctx.translate(W / 2, cy);
    ctx.scale(1, 0.58);
    ctx.fillStyle = orb;
    ctx.beginPath();
    ctx.arc(0, 0, orbR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawFrame(ts) {
    requestAnimationFrame(drawFrame);
    if (!canvas || !ctx) return;
    const page = document.getElementById('page-mic');
    if (!page || !page.classList.contains('active')) {
      lastFrameAt = ts;
      return;
    }
    if (!W || !H) resizeCanvas();
    if (!lastFrameAt) lastFrameAt = ts;
    const dt = Math.min(0.05, (ts - lastFrameAt) / 1000);
    lastFrameAt = ts;
    vizTime += dt;

    for (let i = 0; i < shownWave.length; i += 1) {
      shownWave[i] += ((targetWave[i] || 0) - shownWave[i]) * 0.24;
    }
    const level = Math.max(0, Math.min(1, (levelL + levelR) / 2));
    vizEnergy += (level - vizEnergy) * 0.1;

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    if (vizMode === 'bars') drawBars();
    else if (vizMode === 'pulse') drawPulse();
    else if (vizMode === 'space') drawSpace(dt);
    else drawRings(dt);
  }

  function setVizMode(mode, persist) {
    vizMode = VIZ_MODES.includes(mode) ? mode : 'rings';
    if (persist !== false) {
      try { localStorage.setItem(VIZ_KEY, vizMode); } catch (e) {}
    }
    document.querySelectorAll('#mic-viz-switch [data-viz]').forEach((btn) => {
      const active = btn.dataset.viz === vizMode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    vizRings = [];
    lastRingAt = 0;
    resizeCanvas();
  }

  function bind() {
    document.querySelectorAll('#mic-viz-switch [data-viz]').forEach((btn) => {
      btn.addEventListener('click', () => setVizMode(btn.dataset.viz));
    });
    $('mic-start')?.addEventListener('click', startStream);
    $('mic-stop')?.addEventListener('click', stopStream);
    $('mic-record')?.addEventListener('click', toggleRecording);
    $('mic-open-rec')?.addEventListener('click', async () => {
      if (!window.api || !window.api.audioOpenRecordings) return;
      const r = await window.api.audioOpenRecordings();
      if (!r || !r.ok) setStatus((r && r.error) || 'Не удалось открыть папку', 'err');
    });
    $('mic-listen')?.addEventListener('change', restartIfRunning);
    $('mic-device')?.addEventListener('change', restartIfRunning);
    const autostartBox = $('mic-autostart');
    if (autostartBox) {
      autostartBox.checked = autostart;
      autostartBox.addEventListener('change', () => {
        autostart = !!autostartBox.checked;
        try { localStorage.setItem('micAutostart', autostart ? '1' : '0'); } catch (e) {}
        if (autostart) {
          if (running) ensureDefaultMic();
          else startStream();
        }
      });
    }
    window.addEventListener('resize', resizeCanvas);
  }

  window.micEnsureRunning = async () => {
    if (running) return true;
    await startStream();
    for (let i = 0; i < 25; i += 1) {
      if (running) return true;
      await sleep(200);
    }
    return running;
  };

  window.micPageEnter = async () => {
    requestAnimationFrame(() => {
      resizeCanvas();
      lastFrameAt = 0;
    });
    startPolling();
    if (!serverReady) await ensureServer();
    if (autostart && !running) startStream();
  };

  bind();
  setVizMode(vizMode, false);
  requestAnimationFrame(drawFrame);
  if (autostart) setTimeout(() => { if (!running) startStream(); }, 3000);
})();
