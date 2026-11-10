/* fsicons.js — иконки типов файлов для вкладки «Файлы» (F4).
   Векторные SVG (data:URI) с цветной плашкой — стиль един с приложением.
   Подключается обычным <script>; exposes window.FSICONS.iconFor(name, isDir) → {svg, color}. */
'use strict';
(function () {
  // базовый геймерский глянец: скруглённая плашка + блик + глиф
  function badge(color, glyph, dark) {
    const g = dark ? 'rgba(255,255,255,.92)' : '#fff';
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + lighten(color, 26) + '"/><stop offset="1" stop-color="' + color + '"/></linearGradient></defs>' +
      '<rect x="1" y="1" width="30" height="30" rx="8" fill="url(#g)"/>' +
      '<rect x="1.5" y="1.5" width="29" height="14" rx="7" fill="rgba(255,255,255,.18)"/>' +
      glyph.replace(/#STROKE#/g, g) +
      '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function lighten(hex, add) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.min(255, (n >> 16) + add), g2 = Math.min(255, ((n >> 8) & 255) + add), b = Math.min(255, (n & 255) + add);
    return '#' + ((r << 16) | (g2 << 8) | b).toString(16).padStart(6, '0');
  }
  const G = {
    folder: '<path d="M4 11.5c0-1.7 1.2-3 2.8-3h5.4l2.4 2.6h10.6c1.6 0 2.8 1.3 2.8 3v9.4c0 1.7-1.2 3-2.8 3H6.8c-1.6 0-2.8-1.3-2.8-3z" fill="#STROKE" opacity=".95"/>',
    file: '<path d="M10 5h8l6 6v14.2c0 1-.8 1.8-1.8 1.8H11.8c-1 0-1.8-.8-1.8-1.8V6.8C10 5.8 10.8 5 11.8 5z" fill="#STROKE" opacity=".9"/>',
    music: '<path d="M23 7.5v11a3.5 3.5 0 1 1-2-3.16V11l-8 1.8v8.2a3.5 3.5 0 1 1-2-3.16V10.6L23 7.5z" fill="#STROKE"/>',
    video: '<path d="M9 10.2c0-1 .8-1.8 1.8-1.8h10.4c1 0 1.8.8 1.8 1.8v11.6c0 1-.8 1.8-1.8 1.8H10.8c-1 0-1.8-.8-1.8-1.8z" fill="#STROKE"/><path d="M14 12.5l6 3.5-6 3.5z" fill="#4a5b66"/>',
    image: '<path d="M7 10.5c0-1 .8-1.9 1.8-1.9h14.4c1 0 1.8.9 1.8 1.9v11c0 1-.8 1.9-1.8 1.9H8.8c-1 0-1.8-.9-1.8-1.9z" fill="#STROKE"/><circle cx="12.2" cy="13.4" r="1.9" fill="#4a5b66"/><path d="M8.5 21.5l5.2-5 3.4 3.2 3-2.6 3.4 4.4z" fill="#4a5b66"/>',
    // значок архива как у WinRAR — стопка книг с резинкой
    archive: '<g fill="#STROKE"><rect x="7" y="18.6" width="18" height="4.6" rx="1" transform="rotate(-4 16 21)"/><rect x="7.6" y="13.4" width="17.4" height="4.6" rx="1" fill="#e8eef4"/><rect x="7" y="8.2" width="18" height="4.6" rx="1"/></g><path d="M12.2 8.2v14.8" stroke="#4a5b66" stroke-width="2.2"/><path d="M17.8 8.2v14.8" stroke="#4a5b66" stroke-width="1.4" opacity=".75"/>',
    pdf: '<path d="M10 5h8l6 6v14.2c0 1-.8 1.8-1.8 1.8H11.8c-1 0-1.8-.8-1.8-1.8V6.8C10 5.8 10.8 5 11.8 5z" fill="#STROKE"/><text x="16" y="23" font-family="Segoe UI,Arial" font-size="8.2" font-weight="700" text-anchor="middle" fill="#4a5b66">PDF</text>',
    doc: '<path d="M10 5h8l6 6v14.2c0 1-.8 1.8-1.8 1.8H11.8c-1 0-1.8-.8-1.8-1.8V6.8C10 5.8 10.8 5 11.8 5z" fill="#STROKE"/><path d="M13 14h8M13 17h8M13 20h5.5" stroke="#4a5b66" stroke-width="1.7" stroke-linecap="round"/>',
    sheet: '<path d="M10 5h8l6 6v14.2c0 1-.8 1.8-1.8 1.8H11.8c-1 0-1.8-.8-1.8-1.8V6.8C10 5.8 10.8 5 11.8 5z" fill="#STROKE"/><path d="M13 14.5h8M13 17.5h8M13 20.5h8M16.5 14v9M19.5 14v9" stroke="#4a5b66" stroke-width="1.3"/>',
    code: '<path d="M13 11l-4.4 5L13 21M19 11l4.4 5L19 21" stroke="#STROKE" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M17.2 9.5l-2.4 13" stroke="#STROKE" stroke-width="2" fill="none" stroke-linecap="round"/>',
    contact: '<rect x="6.5" y="6.5" width="19" height="19" rx="3" fill="#STROKE"/><circle cx="16" cy="13.2" r="2.9" fill="#4a5b66"/><path d="M10.5 22.5c.8-3.2 3-4.9 5.5-4.9s4.7 1.7 5.5 4.9" fill="#4a5b66"/>',
    apk: '<path d="M16 6.5c3.6 0 6.4 2.7 6.5 6.3H9.5c.1-3.6 2.9-6.3 6.5-6.3z" fill="#STROKE"/><path d="M13 4.6l1.2 2.1M19 4.6l-1.2 2.1" stroke="#STROKE" stroke-width="1.6" stroke-linecap="round"/><rect x="9.5" y="14.2" width="13" height="10.5" rx="1.6" fill="#STROKE" opacity=".88"/><circle cx="13.4" cy="11.4" r="1" fill="#4a5b66"/><circle cx="18.6" cy="11.4" r="1" fill="#4a5b66"/>',
    torrent: '<path d="M6.5 18.5c0-4.1 4.3-7.4 9.5-7.4s9.5 3.3 9.5 7.4c0 2.4-1.5 4.5-3.9 5.8H10.4c-2.4-1.3-3.9-3.4-3.9-5.8z" fill="#STROKE"/><path d="M12 17.5h8M12.8 20.5h6.4" stroke="#4a5b66" stroke-width="1.6" stroke-linecap="round"/>',
    iso: '<circle cx="16" cy="16" r="9.5" fill="#STROKE"/><circle cx="16" cy="16" r="3.4" fill="#4a5b66"/><path d="M16 6.5a9.5 9.5 0 0 1 9.5 9.5" stroke="rgba(255,255,255,.55)" stroke-width="2" fill="none"/>',
    exe: '<path d="M9 8.5h14c1 0 1.8.8 1.8 1.8v11.4c0 1-.8 1.8-1.8 1.8H9c-1 0-1.8-.8-1.8-1.8V10.3c0-1 .8-1.8 1.8-1.8z" fill="#STROKE"/><path d="M11.5 12.5l3.4 3.5-3.4 3.5M17 19.5h4" stroke="#4a5b66" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    book: '<path d="M7.5 8.5c2.8-1.6 5.7-1.6 8.5 0 2.8-1.6 5.7-1.6 8.5 0v14c-2.8-1.6-5.7-1.6-8.5 0-2.8-1.6-5.7-1.6-8.5 0z" fill="#STROKE"/><path d="M16 8.5v14" stroke="#4a5b66" stroke-width="1.6"/>',
    audio2: '<path d="M6.5 13.5h4l5-4.5v14l-5-4.5h-4z" fill="#STROKE"/><path d="M20 12c1.4 2.2 1.4 5.8 0 8M23 9.5c2.5 3.6 2.5 9.4 0 13" stroke="#STROKE" stroke-width="1.9" fill="none" stroke-linecap="round"/>',
    txt: '<path d="M10 5h8l6 6v14.2c0 1-.8 1.8-1.8 1.8H11.8c-1 0-1.8-.8-1.8-1.8V6.8C10 5.8 10.8 5 11.8 5z" fill="#STROKE"/><text x="16" y="22.5" font-family="Segoe UI,Arial" font-size="8" font-weight="700" text-anchor="middle" fill="#4a5b66">TXT</text>',
    font: '<text x="16" y="23" font-family="Georgia,serif" font-size="17" font-weight="700" text-anchor="middle" fill="#STROKE">A</text>',
    db: '<ellipse cx="16" cy="10" rx="8.5" ry="3.4" fill="#STROKE"/><path d="M7.5 10v12c0 1.9 3.8 3.4 8.5 3.4s8.5-1.5 8.5-3.4V10" stroke="#STROKE" stroke-width="2.4" fill="none"/><path d="M7.5 16c0 1.9 3.8 3.4 8.5 3.4s8.5-1.5 8.5-3.4" stroke="#STROKE" stroke-width="2.4" fill="none"/>',
    generic: '<path d="M10 5h8l6 6v14.2c0 1-.8 1.8-1.8 1.8H11.8c-1 0-1.8-.8-1.8-1.8V6.8C10 5.8 10.8 5 11.8 5z" fill="#STROKE"/>'
  };
  // расширения → [цвет, глиф]
  const MAP = {
    folder: ['#f6c445', 'folder'],
    // аудио
    mp3: ['#7c4dff', 'music'], m4a: ['#7c4dff', 'music'], aac: ['#7c4dff', 'music'], ogg: ['#7c4dff', 'music'],
    oga: ['#7c4dff', 'music'], opus: ['#7c4dff', 'music'], wav: ['#5c6bc0', 'audio2'], flac: ['#5c6bc0', 'audio2'],
    wma: ['#5c6bc0', 'audio2'], amr: ['#5c6bc0', 'audio2'], mid: ['#5c6bc0', 'audio2'], midi: ['#5c6bc0', 'audio2'], m3u: ['#9575cd', 'music'],
    // видео
    mp4: ['#ec407a', 'video'], mkv: ['#ec407a', 'video'], avi: ['#ec407a', 'video'], mov: ['#ec407a', 'video'],
    wmv: ['#ec407a', 'video'], flv: ['#ec407a', 'video'], webm: ['#ec407a', 'video'], m4v: ['#ec407a', 'video'],
    '3gp': ['#ec407a', 'video'], mpg: ['#ec407a', 'video'], mpeg: ['#ec407a', 'video'], ts: ['#ec407a', 'video'],
    // изображения
    jpg: ['#26a69a', 'image'], jpeg: ['#26a69a', 'image'], png: ['#26a69a', 'image'], gif: ['#26a69a', 'image'],
    webp: ['#26a69a', 'image'], bmp: ['#26a69a', 'image'], heic: ['#26a69a', 'image'], heif: ['#26a69a', 'image'],
    svg: ['#26a69a', 'image'], ico: ['#26a69a', 'image'], tiff: ['#26a69a', 'image'], tif: ['#26a69a', 'image'],
    // архивы
    zip: ['#ffa726', 'archive'], rar: ['#ffa726', 'archive'], '7z': ['#ffa726', 'archive'], tar: ['#ffa726', 'archive'],
    gz: ['#ffa726', 'archive'], bz2: ['#ffa726', 'archive'], xz: ['#ffa726', 'archive'], apk: ['#8bc34a', 'apk'],
    apks: ['#8bc34a', 'apk'], xapk: ['#8bc34a', 'apk'], apkm: ['#8bc34a', 'apk'], 'apk.1': ['#8bc34a', 'apk'],
    'apk+': ['#8bc34a', 'apk'], apup: ['#8bc34a', 'apk'], jar: ['#8bc34a', 'archive'], iso: ['#78909c', 'iso'],
    torrent: ['#43a047', 'torrent'],
    // контакты
    vcf: ['#26c6da', 'contact'], vcard: ['#26c6da', 'contact'],
    // документы
    pdf: ['#ef5350', 'pdf'], doc: ['#42a5f5', 'doc'], docx: ['#42a5f5', 'doc'], odt: ['#42a5f5', 'doc'],
    rtf: ['#42a5f5', 'doc'], xls: ['#66bb6a', 'sheet'], xlsx: ['#66bb6a', 'sheet'], csv: ['#66bb6a', 'sheet'],
    ods: ['#66bb6a', 'sheet'], ppt: ['#ff7043', 'sheet'], pptx: ['#ff7043', 'sheet'], epub: ['#8d6e63', 'book'],
    mobi: ['#8d6e63', 'book'], fb2: ['#8d6e63', 'book'], txt: ['#90a4ae', 'txt'], log: ['#90a4ae', 'txt'],
    md: ['#90a4ae', 'txt'], xml: ['#7e57c2', 'code'], html: ['#7e57c2', 'code'], htm: ['#7e57c2', 'code'],
    css: ['#7e57c2', 'code'], js: ['#fdd835', 'code'], json: ['#fdd835', 'code'], py: ['#4fc3f7', 'code'],
    sh: ['#78909c', 'code'], java: ['#ef5350', 'code'], c: ['#5c6bc0', 'code'], cpp: ['#5c6bc0', 'code'],
    exe: ['#546e7a', 'exe'], msi: ['#546e7a', 'exe'], bat: ['#546e7a', 'exe'], ttf: ['#aab7c4', 'font'],
    otf: ['#aab7c4', 'font'], woff: ['#aab7c4', 'font'], db: ['#5d8aa8', 'db'], sqlite: ['#5d8aa8', 'db'],
    so: ['#607d8b', 'db'], bin: ['#607d8b', 'db'], dat: ['#607d8b', 'generic']
  };
  const cache = {};
  // маленький Android-бейдж (наложение в углу иконки APK) — как просил владелец:
  // «под иконкой углу, этот значок такой маленький». Зелёная голова робота на тёмной плашке.
  const ANDROID_BADGE = (function () {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<circle cx="16" cy="16" r="15" fill="#101418" opacity=".92"/>' +
      '<circle cx="16" cy="16" r="15" fill="none" stroke="#3ddc84" stroke-width="1.4"/>' +
      '<path d="M10.4 13.1a5.9 5.9 0 0 1 11.2 0z" fill="#3ddc84"/>' +
      '<circle cx="13.6" cy="11.4" r=".85" fill="#101418"/><circle cx="18.4" cy="11.4" r=".85" fill="#101418"/>' +
      '<path d="M9.6 8.2l1.5 2.2M22.4 8.2l-1.5 2.2" stroke="#3ddc84" stroke-width="1.5" stroke-linecap="round"/>' +
      '<rect x="10.1" y="14" width="11.8" height="6.6" rx="1.2" fill="#3ddc84"/>' +
      '<rect x="8.4" y="14.6" width="1.7" height="5.2" rx=".85" fill="#3ddc84"/>' +
      '<rect x="21.9" y="14.6" width="1.7" height="5.2" rx=".85" fill="#3ddc84"/>' +
      '<rect x="11.9" y="21" width="1.7" height="3.6" rx=".85" fill="#3ddc84"/>' +
      '<rect x="15.15" y="21" width="1.7" height="3.6" rx=".85" fill="#3ddc84"/>' +
      '<rect x="18.4" y="21" width="1.7" height="3.6" rx=".85" fill="#3ddc84"/>' +
      '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  })();
  window.FSICONS = {
    ANDROID_BADGE,
    // возвращает { src, letter, color } — src = data:URI SVG; letter — если иконки нет
    iconFor(name, isDir) {
      if (isDir) {
        if (!cache.folder) cache.folder = badge(MAP.folder[0], G.folder);
        return { src: cache.folder, color: MAP.folder[0], letter: '' };
      }
      // сначала пробуем ДВУХЧАСТНЫЕ расширения (apk.1, apk+, apks.zip, tar.gz) —
      // раньше «app.apk.1» получал иконку «1», а не APK
      const nm = String(name || '').toLowerCase();
      const two = nm.match(/\.([a-z0-9]+\.(?:apk|zip|gz|bz2|xz|1))$/);
      let e = '', def = null;
      if (two && MAP[two[1]]) { e = two[1]; def = MAP[e]; }
      if (!def) {
        const ext = nm.match(/\.([a-z0-9+]+)$/);
        e = ext ? ext[1] : '';
        def = MAP[e] || ['#8fa3b0', 'generic'];
      }
      const key = def[1] + def[0];
      if (!cache[key]) cache[key] = badge(def[0], G[def[1]] || G.generic);
      return { src: cache[key], color: def[0], letter: (e || '?').toUpperCase() };
    },
    colorFor(name, isDir) { return this.iconFor(name, isDir).color; }
  };
})();
