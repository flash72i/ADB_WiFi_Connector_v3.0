// apkicon.js — извлечение родной иконки из APK без внешних зависимостей
'use strict';
const zlib = require('zlib');

function parseZip(buf) {
  // EOCD с конца
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const name = buf.slice(off + 46, off + 46 + nlen).toString('utf8');
    const lh = buf.readUInt32LE(off + 42); // local header offset
    entries[name] = { method, csize, lh };
    off += 46 + nlen + elen + clen;
  }
  return { entries, buf };
}
function zipRead(z, name) {
  const e = z.entries[name];
  if (!e) return null;
  const lh = e.lh;
  const nlen = z.buf.readUInt16LE(lh + 26);
  const elen = z.buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nlen + elen;
  const raw = z.buf.slice(start, start + e.csize);
  if (e.method === 0) return raw;
  if (e.method === 8) { try { return zlib.inflateRawSync(raw); } catch (e2) { return null; } }
  return null;
}

// --- бинарный AXML: строковый пул + атрибуты <application>: иконка И НАЗВАНИЕ (label) ---
const ICON = 0x01010002;
const LABEL = 0x01010001;
const ATTR_PACKAGE = 0x01010003;      // <manifest package=...>
const ATTR_VERSIONCODE = 0x0101021b;  // <manifest versionCode=...>
const ATTR_VERSIONNAME = 0x0101021c;  // <manifest versionName=...>
// правильное чтение длин UTF-8/UTF-16 в строковых пулах AXML — старый код
// читал длину строки с ошибкой на строках длиннее 127 байт (имена обрезались/ломались:
// «неполное имя приложения»), и TikTok (label через ресурс) не находился поиском.
function readVarLen(buf, o) {
  // длина в пуле AXML: 1 байт, либо 2 байта если у первого выставлен старший бит
  if (o >= buf.length) return { v: 0, n: 1 };
  const b = buf[o];
  if (b & 0x80) return { v: ((b & 0x7f) << 8) | (buf[o + 1] || 0), n: 2 };
  return { v: b, n: 1 };
}
function axmlAppAttrs(ax) {
  // возвращает { icon, label, labelStr, package, versionName, versionCode }
  const out = { icon: 0, label: 0, labelStr: null, package: null, versionName: null, versionCode: null };
  if (ax.readUInt32LE(0) !== 0x00080003) return out;
  let p = 8;
  if (ax.readUInt16LE(p) !== 0x0001) return out; // string pool chunk type 0x0001
  const spChunk = p;
  const strCount = ax.readUInt32LE(spChunk + 8);
  const flags = ax.readUInt32LE(spChunk + 16);
  const stringsOff = ax.readUInt32LE(spChunk + 20);
  const utf8 = (flags & (1 << 8)) !== 0;
  const strOffsets = [];
  for (let i = 0; i < strCount; i++) strOffsets.push(ax.readUInt32LE(spChunk + 28 + i * 4));
  const absStr = spChunk + stringsOff;
  const readStr = (i) => {
    if (i < 0 || i >= strCount) return '';
    const o = absStr + strOffsets[i];
    if (o >= ax.length) return '';
    if (utf8) {
      // формат UTF-8 пула: [u16 charLen][u16 byteLen][байты] — оба счётчика могут быть 2-байтными
      const c1 = readVarLen(ax, o);
      const c2 = readVarLen(ax, o + c1.n);
      const start = o + c1.n + c2.n;
      if (start + c2.v > ax.length) return '';
      return ax.slice(start, start + c2.v).toString('utf8');
    }
    // UTF-16: u16-единиц, старший бит = расширенная длина (15 бит << 16 | следующая)
    let len = ax.readUInt16LE(o);
    let dataOff = o + 2;
    if (len & 0x8000) { len = ((len & 0x7fff) << 16) | ax.readUInt16LE(o + 2); dataOff = o + 4; }
    if (dataOff + len * 2 > ax.length) return '';
    return ax.slice(dataOff, dataOff + len * 2).toString('utf16le');
  };
  // res id pool
  p = spChunk + ax.readUInt32LE(spChunk + 4);
  let resIds = [];
  if (ax.readUInt16LE(p) === 0x0180) {
    const cnt = (ax.readUInt32LE(p + 4) - 8) / 4;
    for (let i = 0; i < cnt; i++) resIds.push(ax.readUInt32LE(p + 8 + i * 4));
  }
  // обход элементов: собираем <manifest> (package/version) и <application> (иконка/имя)
  let gotManifest = false, gotApp = false;
  for (let i = p; i < ax.length - 20 && !(gotManifest && gotApp); i += 4) {
    if (ax.readUInt32LE(i) === 0x00100102) { // start_element type 0x0002, header 16
      if (i + 36 > ax.length) break;
      const attrCount = ax.readUInt16LE(i + 26);
      const A = i + 36;
      if (A + attrCount * 20 > ax.length) break;
      const elName = readStr(ax.readUInt32LE(i + 20));
      if (elName === 'manifest' && !gotManifest) {
        gotManifest = true;
        for (let k = 0; k < attrCount; k++) {
          const base = A + k * 20;
          if (base + 20 > ax.length) break;
          const nameIdx = ax.readUInt32LE(base + 4);
          const valType = ax[base + 15];
          const valData = ax.readUInt32LE(base + 16);
          const rid = nameIdx < resIds.length ? resIds[nameIdx] : nameIdx;
          let attrName = '';
          try { attrName = readStr(nameIdx); } catch (e) {}
          if ((attrName === 'package' || rid === ATTR_PACKAGE) && valType === 0x03) { try { out.package = readStr(valData) || out.package; } catch (e) {} }
          else if (rid === ATTR_VERSIONNAME && valType === 0x03) { try { out.versionName = readStr(valData) || null; } catch (e) {} }
          else if (rid === ATTR_VERSIONCODE && (valType === 0x10 || valType === 0x12)) out.versionCode = valData;
          else if (rid === ATTR_VERSIONCODE && valType === 0x03) { try { const v = readStr(valData); if (v) out.versionCode = parseInt(v, 10) || null; } catch (e) {} }
        }
      } else if (elName === 'application' && !gotApp) {
        gotApp = true;
        for (let k = 0; k < attrCount; k++) {
          const base = A + k * 20;
          if (base + 20 > ax.length) break;
          const nameIdx = ax.readUInt32LE(base + 4);
          const valType = ax[base + 15];
          const valData = ax.readUInt32LE(base + 16);
          const rid = nameIdx < resIds.length ? resIds[nameIdx] : nameIdx;
          if (rid === ICON && valType === 0x01) out.icon = valData;
          else if (rid === LABEL) {
            if (valType === 0x01) out.label = valData;          // ссылка на строковый ресурс
            else if (valType === 0x03) {                        // буквальная строка в пуле манифеста
              try { const s = readStr(valData); if (s) out.labelStr = s; } catch (e) {}
            }
          }
        }
      }
    }
  }
  return out;
}

// совместимость со старым API
function axmlIconResId(ax) { return axmlAppAttrs(ax).icon; }

// --- resources.arsc: resId -> путь файла (строки-значения из глобального пула) ---
function makePool(buf, base) {
  const cnt = buf.readUInt32LE(base + 8);
  const fl = buf.readUInt32LE(base + 16);
  const so = buf.readUInt32LE(base + 20);
  const offs = [];
  for (let i = 0; i < cnt; i++) offs.push(buf.readUInt32LE(base + 28 + i * 4));
  const abs = base + so;
  return (i) => {
    if (i < 0 || i >= cnt) return '';
    const o = abs + offs[i];
    if (fl & (1 << 8)) {
      let charLen = buf[o]; let off = o + 1;
      if (charLen & 0x80) { charLen = ((charLen & 0x7f) << 8) | buf[off]; off++; }
      let byteLen = buf[off]; off++;
      if (byteLen & 0x80) { byteLen = ((byteLen & 0x7f) << 8) | buf[off]; off++; }
      return buf.slice(off, off + byteLen).toString('utf8');
    }
    const len = buf.readUInt16LE(o);
    return buf.slice(o + 2, o + 2 + len * 2).toString('utf16le');
  };
}
function arscResolve(arsc, resId) {
  const wantedType = (resId >> 16) & 0xff, wantedEntry = resId & 0xffff;
  let globalStr = null;
  let p = arsc.readUInt16LE(2);
  if (arsc.readUInt16LE(p) === 0x0001) globalStr = makePool(arsc, p);
  // собираем ВСЕ кандидаты и отдаём первый НЕПУСТОЙ — раньше брали первую
  // попавшуюся конфигурацию, у части приложений она пустая («пустое имя»), а у TikTok
  // default-строка перекрывалась другой конфигурацией
  const found = [];
  while (p < arsc.length - 8) {
    const type = arsc.readUInt16LE(p), size = arsc.readUInt32LE(p + 4);
    if (size <= 0) break;
    if (type === 0x0200) {
      const pkgStart = p;
      let q = pkgStart + 288;
      while (q < pkgStart + size) {
        const st = arsc.readUInt16LE(q), sh = arsc.readUInt16LE(q + 2), ss = arsc.readUInt32LE(q + 4);
        if (ss <= 0) break;
        if (st === 0x0201) {
          const id = arsc[q + 8];
          const entryCount = arsc.readUInt32LE(q + 12);
          const entriesStart = arsc.readUInt32LE(q + 16);
          if (id === wantedType && wantedEntry < entryCount) {
            const off = arsc.readUInt32LE(q + sh + wantedEntry * 4);
            if (off !== 0xffffffff) {
              const er = q + entriesStart + off;
              const flags = arsc.readUInt16LE(er + 2);
              if (!(flags & 0x0001)) {
                const valType = arsc[er + 11];
                const valData = arsc.readUInt32LE(er + 12);
                if (valType === 0x03 && globalStr) {
                  try { const s = globalStr(valData); if (s && s.trim()) found.push(s.trim()); } catch (e) {}
                }
              }
            }
          }
        }
        q += ss;
      }
    }
    p += size;
  }
  return found.length ? found[0] : null;
}

function mimeOf(path) {
  if (/\.webp$/i.test(path)) return 'image/webp';
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg';
  if (/\.gif$/i.test(path)) return 'image/gif';
  if (/\.bmp$/i.test(path)) return 'image/bmp';
  return 'image/png';
}

// --- АДАПТИВНЫЕ ИКОНКИ (Android 8+, mipmap-anydpi-v26/*.xml) ---
// У массы приложений (в т.ч. из RuStore/наших локальных APK) растровой иконки нет вовсе —
// только adaptive-icon XML со ссылками <foreground>/<background>. Прежний код такие APK
// пропускал («иконки приложений не все показываются»). Разбираем бинарный AXML: находим
// элемент adaptive-icon, читаем атрибуты ПО ИМЕНИ (не по id — надёжно для любых сборок),
// ссылки-ресурсы резолвим через resources.arsc в путь растра (png/webp/jpg).
function adaptiveFromAxml(z, arsc, ax) {
  if (!ax || ax.readUInt32LE(0) !== 0x00080003) return null;
  let p = 8;
  if (ax.readUInt16LE(p) !== 0x0001) return null; // string pool
  const spChunk = p;
  const strCount = ax.readUInt32LE(spChunk + 8);
  const flags = ax.readUInt32LE(spChunk + 16);
  const stringsOff = ax.readUInt32LE(spChunk + 20);
  const utf8 = (flags & (1 << 8)) !== 0;
  const strOffsets = [];
  for (let i = 0; i < strCount; i++) strOffsets.push(ax.readUInt32LE(spChunk + 28 + i * 4));
  const absStr = spChunk + stringsOff;
  const readStr = (i) => {
    if (i < 0 || i >= strCount) return '';
    const o = absStr + strOffsets[i];
    if (o >= ax.length) return '';
    if (utf8) {
      const c1 = readVarLen(ax, o);
      const c2 = readVarLen(ax, o + c1.n);
      const start = o + c1.n + c2.n;
      if (start + c2.v > ax.length) return '';
      return ax.slice(start, start + c2.v).toString('utf8');
    }
    let len = ax.readUInt16LE(o);
    let dataOff = o + 2;
    if (len & 0x8000) { len = ((len & 0x7fff) << 16) | ax.readUInt16LE(o + 2); dataOff = o + 4; }
    if (dataOff + len * 2 > ax.length) return '';
    return ax.slice(dataOff, dataOff + len * 2).toString('utf16le');
  };
  // ищем <adaptive-icon> и его атрибуты foreground/background (по имени)
  const refs = {};
  let found = false;
  for (let i = spChunk + ax.readUInt32LE(spChunk + 4); i < ax.length - 20; i += 4) {
    if (ax.readUInt32LE(i) !== 0x00100102) continue; // START_ELEMENT
    const elName = readStr(ax.readUInt32LE(i + 20));
    if (elName !== 'adaptive-icon') continue;
    found = true;
    const attrCount = ax.readUInt16LE(i + 26);
    const A = i + 36;
    for (let k = 0; k < attrCount; k++) {
      const base = A + k * 20;
      const name = readStr(ax.readUInt32LE(base + 4));
      const valType = ax[base + 15];
      const valData = ax.readUInt32LE(base + 16);
      if (name === 'foreground' || name === 'background' || name === 'monochrome') {
        if (valType === 0x01) refs[name] = valData;           // ссылка на ресурс
        else if (valType === 0x03) { try { refs[name] = readStr(valData); } catch (e) {} }
      }
    }
    break;
  }
  if (!found) return null;
  for (const key of ['foreground', 'background']) {
    let path = refs[key];
    if (path == null) continue;
    if (typeof path === 'number') {
      if (!arsc) continue;
      path = arscResolve(arsc, path);
      if (!path) continue;
    }
    path = String(path).replace(/^@?/, '');
    if (!/^res\//.test(path)) path = 'res/' + path.replace(/^\//, '');
    if (/\.xml$/i.test(path)) continue; // вектор — отрисовать нечем
    const data = zipRead(z, path);
    if (data && data.length > 32) return { mime: mimeOf(path), data, name: path };
  }
  return null;
}
function adaptiveIconScan(z, arsc) {
  // кандидат: любой XML в mipmap/drawable с признаком adaptive (anydpi/v26/v33) или ic_launcher
  const names = Object.keys(z.entries)
    .filter(n => /^res\/(?:mipmap|drawable)[^/]*\/[^/]+\.xml$/i.test(n))
    .filter(n => /anydpi|v26|v33|ic_launcher/i.test(n));
  for (const n of names) {
    try {
      const ax = zipRead(z, n);
      const ic = ax && adaptiveFromAxml(z, arsc, ax);
      if (ic) return ic;
    } catch (e) {}
  }
  return null;
}

// мета APK: иконка + человеческое имя + пакет + версия — ОДНО чтение, четыре результата
// (package/versionName нужны новой вкладке «Установка APK» и мини-окну файлов)
function extractMeta(apkBuf) {
  const out = { icon: null, label: null, package: null, versionName: null, versionCode: null };
  const z = parseZip(apkBuf);
  if (!z) return null;
  const ax = zipRead(z, 'AndroidManifest.xml');
  if (!ax) return null;
  const attrs = axmlAppAttrs(ax);
  const arsc = zipRead(z, 'resources.arsc');
  out.package = attrs.package || null;
  out.versionName = attrs.versionName || null;
  out.versionCode = attrs.versionCode || null;
  if (attrs.labelStr) out.label = attrs.labelStr;
  else if (attrs.label && arsc) {
    const s = arscResolve(arsc, attrs.label);
    if (s && !/^@|^res\//.test(s)) out.label = s;
  }
  if (attrs.icon && arsc) {
    const path = arscResolve(arsc, attrs.icon);
    if (path && !/\.xml$/i.test(path)) {
      const data = zipRead(z, path);
      if (data && data.length > 32) out.icon = { mime: mimeOf(path), data };
    } else if (path && /\.xml$/i.test(path)) {
      // android:icon указывает на adaptive-icon XML — достаём foreground/background
      try {
        const ax2 = zipRead(z, path);
        const ic = ax2 && adaptiveFromAxml(z, arsc, ax2);
        if (ic) out.icon = ic;
      } catch (e) {}
    }
  }
  if (!out.icon) {
    // adaptive-иконки (anydpi-v26) до растрового фолбэка — иконки есть у тех APK,
    // где раньше был только робот/буква
    try {
      const ad = adaptiveIconScan(z, arsc);
      if (ad) out.icon = ad;
    } catch (e) {}
  }
  if (!out.icon) {
    const best = largestRasterIcon(z);
    if (best) out.icon = { mime: mimeOf(best.name), data: best.data };
  }
  // даже без иконки/имени мета полезна (пакет+версия для вкладки установки)
  if (!out.icon && !out.label && !out.package) return null;
  return out;
}

function extractIcon(apkBuf) {
  const m = extractMeta(apkBuf);
  return m && m.icon ? { mime: m.icon.mime, data: m.icon.data } : null;
}

function largestRasterIcon(z) {
  let best = null;
  for (const name of Object.keys(z.entries)) {
    const m = name.match(/^res\/(?:mipmap|drawable)[^/]*\/[^/]+\.(png|webp|jpe?g|gif|bmp)$/i);
    if (!m) continue;
    const e = z.entries[name];
    const launcher = /ic_launcher|app_icon|icon\.png|ic_logo/i.test(name);
    // приоритет: СНАЧАЛА размер среди ic_launcher-кандидатов (раньше любое имя с
    // ic_launcher побеждало даже крошечную ldpi-иконку — вылезали мыльные/пустые картинки),
    // затем просто крупнейший растр как фолбэк
    const score = (launcher ? 1e12 : 0) + (e.csize || 0);
    if (!best || score > best.score) {
      const d = zipRead(z, name);
      if (d && d.length > 64) best = { name, data: d, score };
    }
  }
  return best;
}

module.exports = { extractIcon, extractMeta, parseZip, zipRead, axmlAppAttrs, axmlIconResId, arscResolve };
