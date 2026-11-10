// appaudit.js — аудит разрешений и AppOps приложения по ADB.
// Ничего не устанавливает; данные читаются из dumpsys package и appops.
'use strict';
const adb = require('./adb');

const DANGEROUS = {
  'android.permission.CAMERA': 'Камера',
  'android.permission.RECORD_AUDIO': 'Микрофон',
  'android.permission.ACCESS_FINE_LOCATION': 'Точная геолокация',
  'android.permission.ACCESS_COARSE_LOCATION': 'Примерная геолокация',
  'android.permission.ACCESS_BACKGROUND_LOCATION': 'Геолокация в фоне',
  'android.permission.READ_CONTACTS': 'Чтение контактов',
  'android.permission.WRITE_CONTACTS': 'Запись контактов',
  'android.permission.READ_SMS': 'Чтение SMS',
  'android.permission.SEND_SMS': 'Отправка SMS',
  'android.permission.READ_CALL_LOG': 'Журнал звонков',
  'android.permission.CALL_PHONE': 'Звонки',
  'android.permission.READ_PHONE_STATE': 'Состояние телефона',
  'android.permission.READ_EXTERNAL_STORAGE': 'Чтение файлов',
  'android.permission.WRITE_EXTERNAL_STORAGE': 'Запись файлов',
  'android.permission.MANAGE_EXTERNAL_STORAGE': 'Доступ ко всем файлам',
  'android.permission.READ_MEDIA_IMAGES': 'Доступ к фото',
  'android.permission.READ_MEDIA_VIDEO': 'Доступ к видео',
  'android.permission.READ_MEDIA_AUDIO': 'Доступ к аудио',
  'android.permission.BODY_SENSORS': 'Датчики тела',
  'android.permission.ACTIVITY_RECOGNITION': 'Распознавание активности',
  'android.permission.BLUETOOTH_CONNECT': 'Bluetooth',
  'android.permission.BLUETOOTH_SCAN': 'Поиск Bluetooth',
  'android.permission.POST_NOTIFICATIONS': 'Уведомления',
  'android.permission.SYSTEM_ALERT_WINDOW': 'Поверх других окон',
  'android.permission.PACKAGE_USAGE_STATS': 'Статистика использования',
  'android.permission.QUERY_ALL_PACKAGES': 'Список всех приложений',
  'android.permission.REQUEST_INSTALL_PACKAGES': 'Установка приложений',
  'android.permission.READ_CLIPBOARD': 'Чтение буфера обмена'
};

const OP_LABELS = {
  CAMERA: 'Камера', RECORD_AUDIO: 'Микрофон', FINE_LOCATION: 'Точная геолокация', COARSE_LOCATION: 'Примерная геолокация',
  READ_CONTACTS: 'Контакты', WRITE_CONTACTS: 'Запись контактов', READ_SMS: 'SMS', SEND_SMS: 'Отправка SMS',
  CALL_PHONE: 'Звонки', READ_CALL_LOG: 'Журнал звонков', READ_CLIPBOARD: 'Чтение буфера', WRITE_CLIPBOARD: 'Запись буфера',
  SYSTEM_ALERT_WINDOW: 'Поверх окон', GET_USAGE_STATS: 'Статистика использования', REQUEST_INSTALL_PACKAGES: 'Установка APK',
  MANAGE_EXTERNAL_STORAGE: 'Все файлы', RUN_IN_BACKGROUND: 'Работа в фоне', RUN_ANY_IN_BACKGROUND: 'Работа в фоне (любая)',
  POST_NOTIFICATION: 'Уведомления', READ_MEDIA_IMAGES: 'Фото', READ_MEDIA_VIDEO: 'Видео', READ_MEDIA_AUDIO: 'Аудио'
};
const SENSITIVE_OPS = new Set(['CAMERA', 'RECORD_AUDIO', 'FINE_LOCATION', 'COARSE_LOCATION', 'READ_CONTACTS', 'READ_SMS', 'SEND_SMS', 'CALL_PHONE', 'READ_CALL_LOG', 'READ_CLIPBOARD', 'WRITE_CLIPBOARD', 'SYSTEM_ALERT_WINDOW', 'GET_USAGE_STATS', 'REQUEST_INSTALL_PACKAGES', 'MANAGE_EXTERNAL_STORAGE']);

function grab(t, re) { return ((t || '').match(re) || [])[1] || ''; }

function parsePermissions(t) {
  const granted = new Map();
  for (const m of (t || '').matchAll(/^\s*([a-z][\w.]*\.permission[a-zA-Z0-9_.]*|[a-z][\w.]*\.[A-Z][\w.]*):\s*granted=(true|false)/gmi)) {
    granted.set(m[1], m[2] === 'true');
  }
  const requested = new Set();
  const lines = (t || '').replace(/\r/g, '').split('\n');
  let inReq = false;
  for (const line of lines) {
    if (/^\s*requested permissions:\s*$/.test(line)) { inReq = true; continue; }
    if (inReq) {
      if (/^\s{2,}\S/.test(line) && /permission|[A-Za-z0-9_.]+/.test(line)) {
        const name = line.trim();
        if (/^[a-z][\w.]*(\.[A-Za-z0-9_]+)+$/.test(name)) requested.add(name);
        else if (!/^[a-z]/.test(name)) inReq = false;
      } else if (!line.trim() || /^\s{0,2}\S/.test(line)) inReq = false;
    }
  }
  const names = new Set([...granted.keys(), ...requested]);
  return [...names].sort().map(name => ({
    name, granted: granted.get(name) === true,
    dangerous: !!DANGEROUS[name], label: DANGEROUS[name] || ''
  }));
}

function parseOps(t) {
  const out = [];
  for (const m of (t || '').matchAll(/^\s*([A-Z][A-Z0-9_]+):\s*([a-z]+)/gm)) {
    const op = m[1], mode = m[2];
    if (!OP_LABELS[op] && !SENSITIVE_OPS.has(op)) continue;
    out.push({ op, mode, label: OP_LABELS[op] || op, sensitive: SENSITIVE_OPS.has(op) });
  }
  const seen = new Set();
  return out.filter(o => { const k = o.op; if (seen.has(k)) return false; seen.add(k); return true; });
}

async function collect(serial, pkg) {
  if (!serial) return { ok: false, error: 'Не выбрано устройство' };
  if (!pkg) return { ok: false, error: 'Не указан пакет' };
  const [dump, ops] = await Promise.all([
    adb.run(['-s', serial, 'shell', 'dumpsys', 'package', pkg], { timeout: 25000 }).catch(() => null),
    adb.run(['-s', serial, 'shell', 'appops', 'get', pkg], { timeout: 15000 }).catch(() => null)
  ]);
  if (!dump || !dump.ok) return { ok: false, error: (dump && (dump.stderr || dump.error)) || 'Не удалось прочитать dumpsys package' };
  const t = dump.stdout || '';
  const permissions = parsePermissions(t);
  const appops = parseOps((ops && ops.stdout) || '');
  const info = {
    versionName: grab(t, /versionName=([\w.\-]+)/),
    versionCode: grab(t, /versionCode=(\d+)/),
    targetSdk: grab(t, /targetSdk=(\d+)/),
    minSdk: grab(t, /minSdk=(\d+)/),
    uid: grab(t, /userId=(\d+)/),
    installer: grab(t, /installerPackageName=([\w.]+)/) || '—',
    firstInstall: grab(t, /firstInstallTime=([^\r\n]+)/),
    lastUpdate: grab(t, /lastUpdateTime=([^\r\n]+)/)
  };
  const grantedDanger = permissions.filter(p => p.dangerous && p.granted);
  const allowedOps = appops.filter(o => o.mode === 'allow' && o.sensitive);
  const warnings = [];
  if (grantedDanger.length) warnings.push('Выданы опасные разрешения: ' + grantedDanger.map(p => p.label || p.name).join(', '));
  if (allowedOps.length) warnings.push('AppOps разрешают: ' + allowedOps.map(o => o.label).join(', '));
  if (info.targetSdk && +info.targetSdk < 30) warnings.push('Старый targetSdk (' + info.targetSdk + ') — Android может ограничивать работу');
  if (info.installer === '—' || /adb|unknown/i.test(info.installer)) warnings.push('Установлено не из магазина (sideload/ADB)');
  if (!warnings.length) warnings.push('Явных опасных доступов не найдено');
  return { ok: true, serial, pkg, info, permissions, appops, warnings, summary: { total: permissions.length, dangerous: permissions.filter(p => p.dangerous).length, grantedDanger: grantedDanger.length, allowedOps: allowedOps.length } };
}

module.exports = { collect };
