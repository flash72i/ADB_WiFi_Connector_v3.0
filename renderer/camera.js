'use strict';
(() => {
  const ORIGIN = 'http://127.0.0.1:27190';
  const ULTRA_CAMERA = 2;
  const ULTRA_FACTOR = 0.58;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let running = false;
  let starting = false;
  let currentCam = 0;
  let pollTimer = null;
  let zoomBusyUntil = 0;
  let zoomTimer = null;
  let zoomSwitching = false;
  let pendingZoom = null;
  let cameraWidth = 1280;
  let cameraHeight = 720;
  let cameraFps = 60;
  try {
    const parts = String(localStorage.getItem('cameraResolution') || '1280x720').split('x');
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (w >= 320 && h >= 240) {
      cameraWidth = w;
      cameraHeight = h;
    }
    const fps = Number(localStorage.getItem('cameraFps'));
    if (fps === 30 || fps === 60) cameraFps = fps;
    if (localStorage.getItem('cameraDefaultsV2') !== '1') {
      cameraWidth = 1280;
      cameraHeight = 720;
      cameraFps = 60;
      try {
        localStorage.setItem('cameraResolution', '1280x720');
        localStorage.setItem('cameraFps', '60');
        localStorage.setItem('cameraDefaultsV2', '1');
      } catch (e) {}
    }
  } catch (e) {}
  let recorder = null;
  let recordStream = null;
  let recordAudioStream = null;
  let recordCanvas = null;
  let recordCtx = null;
  let recordChunks = [];
  let recordFrame = 0;
  let recording = false;

  async function request(path) {
    const res = await fetch(ORIGIN + path, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function setStatus(text, kind) {
    const el = $('cam-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'camera-status' + (kind ? ' ' + kind : '');
  }

  function setCaptureNote(text, kind) {
    const el = $('cam-capture-note');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = kind === 'err' ? '#ff7676' : kind === 'ok' ? '#7bd88f' : '';
  }

  function fileName(path) {
    return String(path || '').split(/[\\/]/).pop();
  }

  function setCaptureEnabled(enabled) {
    const shot = $('cam-shot');
    const record = $('cam-record');
    if (shot) shot.disabled = !enabled;
    if (record) record.disabled = !enabled;
  }

  function updateRecordButton() {
    const btn = $('cam-record');
    if (!btn) return;
    btn.classList.toggle('recording', recording);
    btn.textContent = recording ? 'Остановить запись' : 'Запись MP4';
  }

  function setBadge(text, live) {
    const el = $('cam-badge');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('live', !!live);
  }

  function showPlaceholder(text) {
    const ph = $('cam-placeholder');
    if (ph) {
      ph.style.display = 'flex';
      const title = ph.querySelector('div:nth-child(2)');
      if (title) title.textContent = text;
    }
  }

  function hidePlaceholder() {
    const ph = $('cam-placeholder');
    if (ph) ph.style.display = 'none';
  }

  function setZoomLabel(percent) {
    const label = $('cam-zoom-value');
    if (label) label.textContent = (Number(percent) / 100).toFixed(1) + '×';
  }

  function cameraForZoom(value) {
    if (currentCam === 1) return 1;
    return value < 1 ? ULTRA_CAMERA : 0;
  }

  function phoneZoom(value, camera) {
    if (camera === ULTRA_CAMERA) {
      return Math.round((value / ULTRA_FACTOR) * 100);
    }
    return Math.round(value * 100);
  }

  function uiZoom(st) {
    const percent = Number(st.zoom) || 100;
    if (Number(st.camera) === ULTRA_CAMERA) {
      return Math.max(0.6, Math.min(1, (percent / 100) * ULTRA_FACTOR));
    }
    return percent / 100;
  }

  async function sendZoom(value) {
    if (!running) return;
    if (zoomSwitching) {
      pendingZoom = value;
      return;
    }
    const camera = cameraForZoom(value);
    if (camera === 1) value = Math.max(1, value);
    const percent = phoneZoom(value, camera);
    if (camera !== currentCam) {
      zoomSwitching = true;
      zoomBusyUntil = Date.now() + 1600;
      setStatus('Переключаю объектив…');
      try {
        const r = await request(
          '/camera/' + camera + '?zoom=' + encodeURIComponent(percent)
        );
        if (!r || !r.ok) throw new Error('camera');
        currentCam = camera;
        highlightCamera(camera);
        await sleep(900);
        const st = await request('/status');
        applyStatus(st);
      } catch (e) {
        setStatus('Не удалось переключить объектив', 'err');
      } finally {
        zoomSwitching = false;
        const next = pendingZoom;
        pendingZoom = null;
        if (next !== null && Math.abs(next - value) > 0.05) sendZoom(next);
      }
      return;
    }
    try {
      const r = await request('/zoom?value=' + encodeURIComponent(percent));
      if (r && r.zoom) {
        const shown = camera === ULTRA_CAMERA
          ? Math.max(0.6, Math.min(1, (Number(r.zoom) / 100) * ULTRA_FACTOR))
          : Number(r.zoom) / 100;
        setZoomLabel(shown * 100);
      }
    } catch (e) {
      setStatus('Зум недоступен', 'err');
    }
  }

  function highlightCamera(cam) {
    document.querySelectorAll('[data-cam]').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.cam) === Number(cam));
    });
  }

  function applyStatus(st) {
    if (!st) return;
    const cam = Number(st.camera);
    if (!Number.isNaN(cam)) {
      currentCam = cam;
      highlightCamera(cam);
    }
    const fps = Number(st.fps) || 0;
    setBadge('LIVE · ' + (fps ? fps + ' к/с' : 'поток'), true);
    const autoBtn = $('cam-auto');
    if (autoBtn) autoBtn.classList.toggle('active', !!st.auto);
    if (st.zoom && Date.now() > zoomBusyUntil) {
      const value = uiZoom(st);
      const zoom = $('cam-zoom');
      if (zoom) zoom.value = value.toFixed(1);
      setZoomLabel(value * 100);
    }
    if (st.status) setStatus(st.status + (fps ? ' · ' + fps + ' к/с' : ''), 'ok');
  }

  async function waitForServer() {
    for (let i = 0; i < 40; i += 1) {
      try {
        const st = await window.api.cameraStatus();
        if (st && st.ok) return st;
      } catch (e) {}
      await sleep(250);
    }
    return null;
  }

  async function start(cam) {
    if (starting) return;
    starting = true;
    const target = Math.max(0, Math.min(7, Number(cam) || 0));
    currentCam = target;
    highlightCamera(target);
    setStatus('Запускаю камеру…');
    setBadge('запуск', false);
    showPlaceholder('Запускаю камеру…');
    try {
      if (!window.api || !window.api.cameraStart) {
        throw new Error('Мост camera:* не загружен. Перезапустите приложение.');
      }
      const launched = await window.api.cameraStart(target, {
        width: cameraWidth,
        height: cameraHeight,
        fps: cameraFps
      });
      if (!launched || !launched.ok) {
        throw new Error((launched && launched.error) || 'Не удалось запустить сервер камеры');
      }
      const st = await waitForServer();
      if (!st) throw new Error('Сервер камеры не ответил. Проверьте Python, OpenCV и ADB.');
      running = true;
      setCaptureEnabled(false);
      setCaptureNote('Ждём кадр…');
      const img = $('cam-stream');
      if (img) {
        hidePlaceholder();
        img.style.display = 'block';
        img.src = ORIGIN + '/stream?t=' + Date.now();
        (async () => {
          for (let i = 0; i < 40; i += 1) {
            if (!running) return;
            if (img.naturalWidth) break;
            await sleep(150);
          }
          if (!running) return;
          if (img.naturalWidth) {
            setCaptureEnabled(true);
            setCaptureNote('');
          } else {
            setCaptureNote('Кадр не загрузился', 'err');
          }
        })();
      }
      applyStatus(st);
      startPolling();
    } catch (e) {
      running = false;
      setBadge('ошибка', false);
      setStatus(String((e && e.message) || e), 'err');
      showPlaceholder('Камера не запущена');
    } finally {
      starting = false;
    }
  }

  async function stop() {
    stopRecording();
    stopPolling();
    running = false;
    currentCam = 0;
    zoomSwitching = false;
    pendingZoom = null;
    highlightCamera(0);
    try { await window.api.cameraStop(); } catch (e) {}
    const img = $('cam-stream');
    if (img) {
      img.removeAttribute('src');
      img.style.display = 'none';
    }
    setBadge('выключено', false);
    setStatus('Остановлено');
    const zoom = $('cam-zoom');
    if (zoom) zoom.value = '1';
    setZoomLabel(100);
    setCaptureEnabled(false);
    setCaptureNote('');
    showPlaceholder('Камера выключена');
  }

  function pickVideoMime() {
    const variants = [
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4;codecs=avc1',
      'video/mp4'
    ];
    for (const type of variants) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  function pickMimeWithAudio() {
    const variants = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a.40.2'
    ];
    for (const type of variants) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) return type;
    }
    return pickVideoMime();
  }

  async function getCableAudioStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cable = devices.find((d) => d.kind === 'audioinput' && /CABLE Output|VB-Audio/i.test(d.label));
      if (!cable) return null;
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: cable.deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
    } catch (e) {
      return null;
    }
  }

  function stopRecording() {
    if (!recorder) return;
    recording = false;
    if (recordFrame) cancelAnimationFrame(recordFrame);
    recordFrame = 0;
    const rec = recorder;
    recorder = null;
    try {
      if (rec.state !== 'inactive') rec.stop();
    } catch (e) {}
    updateRecordButton();
  }

  async function startRecording() {
    if (!running || recording) return;
    const img = $('cam-stream');
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      setCaptureNote('Нет кадра для записи', 'err');
      return;
    }
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    recordCanvas = document.createElement('canvas');
    recordCanvas.width = width;
    recordCanvas.height = height;
    recordCtx = recordCanvas.getContext('2d');
    if (window.micEnsureRunning) {
      try { await window.micEnsureRunning(); } catch (e) {}
    }
    const audioStream = await getCableAudioStream();
    const mime = audioStream ? pickMimeWithAudio() : pickVideoMime();
    if (!mime) {
      if (audioStream) audioStream.getTracks().forEach((track) => track.stop());
      setCaptureNote('Запись MP4 недоступна в этой версии приложения', 'err');
      return;
    }
    const type = mime;
    try {
      recordStream = recordCanvas.captureStream(cameraFps);
      const tracks = [...recordStream.getVideoTracks()];
      if (audioStream) tracks.push(...audioStream.getAudioTracks());
      const combined = new MediaStream(tracks);
      const bitrate = Math.max(12000000, Math.min(50000000, Math.round(cameraWidth * cameraHeight * cameraFps * 0.12)));
      const options = { videoBitsPerSecond: bitrate, audioBitsPerSecond: 128000, mimeType: mime };
      recorder = new MediaRecorder(combined, options);
      recordAudioStream = audioStream;
    } catch (e) {
      if (recordStream) recordStream.getTracks().forEach((track) => track.stop());
      if (audioStream) audioStream.getTracks().forEach((track) => track.stop());
      recordStream = null;
      recordAudioStream = null;
      recordCanvas = null;
      recordCtx = null;
      recorder = null;
      setCaptureNote('Запись видео недоступна: ' + e.message, 'err');
      return;
    }

    recordChunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) recordChunks.push(event.data);
    };
    recorder.onerror = (event) => {
      const error = event && event.error ? event.error.message : 'неизвестная ошибка';
      setCaptureNote('Ошибка записи: ' + error, 'err');
      stopRecording();
    };
    recorder.onstop = async () => {
      const blob = new Blob(recordChunks, { type });
      recordChunks = [];
      if (recordStream) {
        recordStream.getTracks().forEach((track) => track.stop());
        recordStream = null;
      }
      if (recordAudioStream) {
        recordAudioStream.getTracks().forEach((track) => track.stop());
        recordAudioStream = null;
      }
      recordCanvas = null;
      recordCtx = null;
      if (!blob.size) {
        setCaptureNote('Запись пустая', 'err');
        return;
      }
      try {
        const buffer = await blob.arrayBuffer();
        const result = await window.api.cameraSaveVideo(buffer, type);
        if (!result || !result.ok) throw new Error((result && result.error) || 'Не удалось сохранить видео');
        setCaptureNote('Видео сохранено: ' + fileName(result.path), 'ok');
      } catch (e) {
        setCaptureNote(String((e && e.message) || e), 'err');
      }
    };

    try {
      recorder.start();
    } catch (e) {
      if (recordStream) recordStream.getTracks().forEach((track) => track.stop());
      recordStream = null;
      recordCanvas = null;
      recordCtx = null;
      recorder = null;
      setCaptureNote('Не удалось начать запись: ' + e.message, 'err');
      return;
    }
    recording = true;
    updateRecordButton();
    setCaptureNote('Идёт запись видео…');

    const draw = () => {
      if (!recording) return;
      if (recordCtx && img.complete) {
        try {
          recordCtx.drawImage(img, 0, 0, width, height);
        } catch (e) {
          setCaptureNote('Захват видео недоступен: ' + e.message, 'err');
          stopRecording();
          return;
        }
      }
      recordFrame = requestAnimationFrame(draw);
    };
    draw();
  }

  async function capturePhoto() {
    if (!running) return;
    const img = $('cam-stream');
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      setCaptureNote('Нет кадра для снимка', 'err');
      return;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/png');
      const result = await window.api.cameraSavePhoto(dataUrl);
      if (!result || !result.ok) throw new Error((result && result.error) || 'Не удалось сохранить снимок');
      setCaptureNote('Снимок сохранён: ' + fileName(result.path), 'ok');
    } catch (e) {
      setCaptureNote(String((e && e.message) || e), 'err');
    }
  }

  async function openCaptures() {
    if (!window.api || !window.api.cameraOpenCaptures) return;
    const result = await window.api.cameraOpenCaptures();
    if (!result || !result.ok) setCaptureNote((result && result.error) || 'Не удалось открыть папку', 'err');
  }

  async function switchCamera(cam) {
    const target = Math.max(0, Math.min(7, Number(cam) || 0));
    if (!running) {
      await start(target);
      return;
    }
    currentCam = target;
    highlightCamera(target);
    const zoom = $('cam-zoom');
    if (zoom) zoom.value = '1';
    setZoomLabel(100);
    setStatus('Переключаю камеру…');
    try {
      await request('/camera/' + target + '?zoom=100');
      await sleep(350);
      const st = await request('/status');
      applyStatus(st);
    } catch (e) {
      setStatus('Не удалось переключить камеру', 'err');
    }
  }

  async function change(path, okText) {
    if (!running) return;
    try {
      await request(path);
      setStatus(okText || 'Готово', 'ok');
      const st = await request('/status');
      applyStatus(st);
    } catch (e) {
      setStatus('Команда не выполнена', 'err');
    }
  }

  async function toggleAuto() {
    if (!running) return;
    try {
      const r = await request('/auto');
      const btn = $('cam-auto');
      if (btn) btn.classList.toggle('active', !!r.auto);
      setStatus(r.auto ? 'Авто-поворот включён' : 'Авто-поворот выключен', 'ok');
    } catch (e) {
      setStatus('Авто-поворот недоступен', 'err');
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (!running) return;
      try {
        const st = await request('/status');
        applyStatus(st);
      } catch (e) {
        setStatus('Нет связи с сервером камеры', 'err');
      }
    }, 1500);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function bind() {
    const startBtn = $('cam-start');
    const stopBtn = $('cam-stop');
    if (startBtn) startBtn.addEventListener('click', () => start(currentCam));
    if (stopBtn) stopBtn.addEventListener('click', stop);
    const installBtn = $('cam-install');
    if (installBtn) installBtn.addEventListener('click', async () => {
      if (!window.api || !window.api.cameraInstall) {
        setStatus('Установка APK недоступна', 'err');
        return;
      }
      const wasRunning = running;
      if (wasRunning) await stop();
      setStatus('Устанавливаю приложение на телефон…');
      try {
        const r = await window.api.cameraInstall();
        if (!r || !r.ok) throw new Error((r && r.error) || 'adb install завершился с ошибкой');
        setStatus('Приложение установлено', 'ok');
        if (wasRunning) await sleep(1200);
        if (wasRunning) await start(currentCam);
      } catch (e) {
        setStatus(String((e && e.message) || e), 'err');
      }
    });

    document.querySelectorAll('[data-cam]').forEach((btn) => {
      btn.addEventListener('click', () => switchCamera(Number(btn.dataset.cam)));
    });
    document.querySelectorAll('[data-cam-rotate]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const deg = Number(btn.dataset.camRotate);
        const path = deg === 180 ? '/rotate/180' : (deg < 0 ? '/rotate/left' : '/rotate/right');
        change(path, 'Поворот');
      });
    });
    const mirror = $('cam-mirror');
    if (mirror) mirror.addEventListener('click', () => change('/mirror', 'Зеркало'));
    const reset = $('cam-reset');
    if (reset) reset.addEventListener('click', () => change('/reset', 'Положение сброшено'));
    const auto = $('cam-auto');
    if (auto) {
      auto.classList.add('active');
      auto.addEventListener('click', toggleAuto);
    }
    const zoom = $('cam-zoom');
    if (zoom) {
      zoom.addEventListener('input', () => {
        let value = Number(zoom.value);
        if (currentCam === 1 && value < 1) {
          value = 1;
          zoom.value = '1.0';
        }
        setZoomLabel(value * 100);
        zoomBusyUntil = Date.now() + 500;
        clearTimeout(zoomTimer);
        zoomTimer = setTimeout(() => sendZoom(value), 120);
      });
      zoom.addEventListener('wheel', (event) => {
        if (!event.deltaY) return;
        event.preventDefault();
        const step = event.deltaY < 0 ? 0.1 : -0.1;
        let value = Math.round((Number(zoom.value) + step) * 10) / 10;
        value = Math.max(0.6, Math.min(8, value));
        if (currentCam === 1) value = Math.max(1, value);
        if (value === Number(zoom.value)) return;
        zoom.value = value.toFixed(1);
        zoom.dispatchEvent(new Event('input', { bubbles: true }));
      }, { passive: false });
    }

    const shot = $('cam-shot');
    if (shot) shot.addEventListener('click', capturePhoto);
    const record = $('cam-record');
    if (record) record.addEventListener('click', () => {
      if (recording) stopRecording();
      else startRecording();
    });
    const captures = $('cam-open-captures');
    if (captures) captures.addEventListener('click', openCaptures);

    const resolution = $('cam-resolution');
    if (resolution) {
      resolution.value = cameraWidth + 'x' + cameraHeight;
      resolution.addEventListener('change', async () => {
        const parts = String(resolution.value).split('x');
        cameraWidth = Number(parts[0]) || 1280;
        cameraHeight = Number(parts[1]) || 720;
        try { localStorage.setItem('cameraResolution', cameraWidth + 'x' + cameraHeight); } catch (e) {}
        if (cameraWidth > 1280 || cameraHeight > 720) {
          cameraFps = 30;
          if (fpsSelect) fpsSelect.value = '30';
          try { localStorage.setItem('cameraFps', '30'); } catch (e) {}
        }
        if (fpsSelect) {
          const high = [...fpsSelect.options].find((o) => o.value === '60');
          if (high) high.disabled = cameraWidth > 1280 || cameraHeight > 720;
        }
        if (running) {
          const cam = currentCam;
          await stop();
          await start(cam);
        }
      });
    }
    const fpsSelect = $('cam-fps');
    if (fpsSelect) {
      const syncFpsOptions = () => {
        const high = [...fpsSelect.options].find((o) => o.value === '60');
        const limited = cameraWidth > 1280 || cameraHeight > 720;
        if (high) high.disabled = limited;
        if (limited && cameraFps !== 30) {
          cameraFps = 30;
          fpsSelect.value = '30';
          try { localStorage.setItem('cameraFps', '30'); } catch (e) {}
        }
      };
      syncFpsOptions();
      fpsSelect.value = String(cameraFps);
      fpsSelect.addEventListener('change', async () => {
        cameraFps = Number(fpsSelect.value) === 30 ? 30 : 60;
        try { localStorage.setItem('cameraFps', String(cameraFps)); } catch (e) {}
        if (running) {
          const cam = currentCam;
          await stop();
          await start(cam);
        }
      });
    }

    setCaptureEnabled(false);
    updateRecordButton();
    highlightCamera(currentCam);
    const img = $('cam-stream');
    if (img) img.style.display = 'none';
  }

  window.cameraPageEnter = () => {
    if (!running && !starting) {
      setBadge('выключено', false);
      setStatus('Камера выключена');
      showPlaceholder('Камера выключена');
    }
  };

  bind();
})();
