'use strict';
(() => {
  const $ = (id) => document.getElementById(id);

  function setDot(id, state) {
    const el = $(id);
    if (!el) return;
    el.classList.toggle('ok', state === 'ok');
    el.classList.toggle('err', state === 'err');
  }

  function note(text, kind) {
    const el = $('drv-audio-note');
    if (!el) return;
    el.textContent = text;
    el.style.color = kind === 'err' ? '#e05c5c' : kind === 'ok' ? '#7bd88f' : '';
  }

  async function refresh() {
    if (!window.api || !window.api.driversStatus) {
      note('Мост драйверов не загружен. Перезапустите приложение.', 'err');
      return;
    }
    try {
      const r = await window.api.driversStatus();
      if (!r || !r.ok) throw new Error((r && r.error) || 'Не удалось проверить драйверы');
      const video = r.video || {};
      const audio = r.audio || {};
      setDot('drv-video-dot', video.installed ? 'ok' : 'err');
      const videoText = $('drv-video-status');
      if (videoText) videoText.textContent = video.installed ? 'Встроена и готова' : 'Не найдена в комплекте';
      setDot('drv-audio-dot', audio.installed ? 'ok' : 'err');
      const audioText = $('drv-audio-status');
      if (audioText) audioText.textContent = audio.installed ? 'Драйвер установлен' : 'Драйвер не установлен';
      const install = $('drv-audio-install');
      if (install) install.textContent = audio.installed ? 'Переустановить VB-CABLE' : 'Установить VB-CABLE';
      if (!audio.setup) {
        note('Установщик драйвера не найден в комплекте.', 'err');
      } else if (audio.installed) {
        note('Драйвер готов. Звук телефона идёт в CABLE Output.', 'ok');
      } else {
        note('Нажмите «Установить VB-CABLE» и подтвердите запрос администратора. После установки может понадобиться перезагрузка.', '');
      }
    } catch (e) {
      note(String((e && e.message) || e), 'err');
    }
  }

  function bind() {
    const videoRefresh = $('drv-video-refresh');
    if (videoRefresh) videoRefresh.addEventListener('click', refresh);
    const audioRefresh = $('drv-audio-refresh');
    if (audioRefresh) audioRefresh.addEventListener('click', refresh);
    const install = $('drv-audio-install');
    if (install) install.addEventListener('click', async () => {
      install.disabled = true;
      note('Запускаю установщик VB-CABLE…', '');
      try {
        const r = await window.api.driversInstallAudio();
        if (!r || !r.ok) throw new Error((r && r.error) || 'Установщик завершился с ошибкой');
        note('Установщик завершил работу. Перезагрузите ПК, если звук ещё не появился.', 'ok');
      } catch (e) {
        note(String((e && e.message) || e), 'err');
      } finally {
        install.disabled = false;
        refresh();
      }
    });
    const uninstall = $('drv-audio-uninstall');
    if (uninstall) uninstall.addEventListener('click', async () => {
      uninstall.disabled = true;
      note('Запускаю удаление VB-CABLE…', '');
      try {
        const r = await window.api.driversUninstallAudio();
        if (!r || !r.ok) throw new Error((r && r.error) || 'Удаление завершилось с ошибкой');
        note('Драйвер удалён. Для возврата звука нажмите «Установить VB-CABLE».', 'ok');
      } catch (e) {
        note(String((e && e.message) || e), 'err');
      } finally {
        uninstall.disabled = false;
        refresh();
      }
    });
    const goMic = $('drv-go-mic');
    if (goMic) goMic.addEventListener('click', () => {
      document.querySelector('[data-page="mic"]')?.click();
    });
  }

  bind();
  refresh();
})();
