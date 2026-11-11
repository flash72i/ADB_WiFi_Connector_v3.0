'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  let devices = [];
  let busy = false;

  function setStatus(text, kind) {
    const el = $('mic-system-status');
    if (!el) return;
    el.textContent = text;
    el.style.color = kind === 'err' ? '#ff7676' : kind === 'ok' ? '#7bd88f' : '';
  }

  function setBadge(text, kind) {
    const el = $('mic-system-badge');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('ok', kind === 'ok');
    el.classList.toggle('err', kind === 'err');
  }

  function friendlyName(device) {
    return device ? device.name : '';
  }

  function setCurrent(device) {
    const el = $('mic-system-current');
    if (!el) return;
    el.textContent = device ? friendlyName(device) : 'не определён';
    el.title = device ? device.name : '';
    el.classList.toggle('missing', !device);
  }

  function setBusy(value) {
    busy = value;
    const apply = $('mic-system-apply');
    const refresh = $('mic-system-refresh');
    const select = $('mic-system-select');
    if (apply) apply.disabled = value || !devices.length;
    if (refresh) refresh.disabled = value;
    if (select) select.disabled = value;
  }

  function fillSelect() {
    const select = $('mic-system-select');
    if (!select) return;
    const previous = select.value;
    select.innerHTML = '';
    devices.forEach((d) => {
      const option = document.createElement('option');
      option.value = d.id;
      option.textContent = friendlyName(d) + (d.default ? ' (по умолчанию)' : '');
      option.title = d.name;
      select.appendChild(option);
    });
    const keep = devices.some((d) => d.id === previous);
    const chosen = keep ? previous : (devices.find((d) => d.default) || devices[0] || {}).id;
    if (chosen) select.value = chosen;
  }

  async function refresh() {
    if (!window.api || !window.api.systemMics) {
      setStatus('Мост к системным микрофонам не загружен. Перезапустите приложение.', 'err');
      setBadge('нет связи', 'err');
      return;
    }
    setStatus('Читаю микрофоны Windows…');
    setBadge('проверка…');
    try {
      const r = await window.api.systemMics();
      if (!r || !r.ok) throw new Error((r && r.error) || 'Не удалось получить список микрофонов');
      devices = Array.isArray(r.devices) ? r.devices : [];
      fillSelect();
      const def = devices.find((d) => d.default);
      setCurrent(def);
      setBadge(def ? 'по умолчанию выбран' : 'default не найден', def ? 'ok' : 'err');
      setStatus(def
        ? 'Windows будет предлагать это устройство программам первым.'
        : 'В списке нет устройства, отмеченного как default.');
      setBusy(false);
    } catch (e) {
      devices = [];
      fillSelect();
      setBadge('ошибка', 'err');
      setStatus(String((e && e.message) || e), 'err');
      setBusy(false);
    }
  }

  async function apply() {
    if (busy) return;
    const select = $('mic-system-select');
    const id = select && select.value;
    if (!id) {
      setStatus('Сначала выберите микрофон.', 'err');
      return;
    }
    const device = devices.find((d) => d.id === id);
    const name = device ? friendlyName(device) : 'выбранный микрофон';
    setBusy(true);
    setStatus('Переключаю микрофон по умолчанию…');
    try {
      const r = await window.api.systemMicSet(id);
      if (!r || !r.ok) throw new Error((r && r.error) || 'Windows не принял смену устройства');
      setStatus('Готово: «' + name + '» теперь микрофон по умолчанию.', 'ok');
      await refresh();
      setStatus('Готово: «' + name + '» теперь микрофон по умолчанию.', 'ok');
    } catch (e) {
      setStatus(String((e && e.message) || e), 'err');
      setBusy(false);
    }
  }

  async function openSound() {
    if (!window.api || !window.api.openSoundSettings) {
      setStatus('Кнопка звуковых настроек недоступна.', 'err');
      return;
    }
    const r = await window.api.openSoundSettings();
    if (!r || !r.ok) setStatus((r && r.error) || 'Не удалось открыть настройки звука', 'err');
  }

  function bind() {
    $('mic-system-refresh')?.addEventListener('click', refresh);
    $('mic-system-apply')?.addEventListener('click', apply);
    $('mic-system-sound')?.addEventListener('click', openSound);
    $('mic-system-select')?.addEventListener('change', () => {
      const d = devices.find((x) => x.id === $('mic-system-select').value);
      if (d) setStatus('Выбран: ' + d.name + '. Нажмите «Сделать по умолчанию».');
    });
    window.addEventListener('focus', () => {
      if (!busy && devices.length) refresh();
    });
  }

  bind();
  refresh();
})();

