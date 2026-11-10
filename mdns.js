// mdns.js — минимальный mDNS-клиент для поиска сервисов беспроводной отладки ADB
'use strict';
const dgram = require('dgram');
const os = require('os');

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

// --- сборка DNS-пакета (PTR-запрос) ---
function encodeName(name) {
  const parts = [];
  for (const label of name.split('.')) {
    const b = Buffer.from(label, 'utf8');
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function buildQuery(names, unicastResponse) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x0000, 0);   // id
  header.writeUInt16BE(0x0000, 2);   // flags: стандартный запрос
  header.writeUInt16BE(names.length, 4); // QDCOUNT
  // QU-бит (0x8000): просим отвечать unicast прямо на наш порт —
  // так работаем даже без привязки к 5353 и сквозь часть сетевых ограничений
  const cls = unicastResponse ? 0x8001 : 0x0001;
  const qs = names.map(n => Buffer.concat([
    encodeName(n),
    (() => { const b = Buffer.alloc(4); b.writeUInt16BE(12, 0); b.writeUInt16BE(cls, 2); return b; })() // TYPE PTR, CLASS IN[|QU]
  ]));
  return Buffer.concat([header, ...qs]);
}

// --- разбор DNS-ответа ---
function decodeName(buf, off, depth = 0) {
  let name = [];
  let jumped = false, jumpOff = 0;
  let i = off;
  for (;;) {
    if (i >= buf.length) break;
    const len = buf[i];
    if (len === 0) { i++; break; }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[i + 1];
      if (!jumped) { jumped = true; jumpOff = i + 2; }
      i = ptr;
      if (depth > 4) break;
      continue;
    }
    name.push(buf.slice(i + 1, i + 1 + len).toString('utf8'));
    i += 1 + len;
  }
  const end = jumped ? jumpOff : i;
  return { name: name.join('.'), end };
}

function parseResponse(buf) {
  const res = { ptr: [], srv: [], txt: [], a: [] };
  if (buf.length < 12) return res;
  const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6), ns = buf.readUInt16BE(8), ar = buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) { const n = decodeName(buf, off); off = n.end + 4; }
  const count = an + ns + ar;
  for (let i = 0; i < count && off < buf.length; i++) {
    const nameRec = decodeName(buf, off);
    off = nameRec.end;
    if (off + 10 > buf.length) break;
    const type = buf.readUInt16BE(off);
    const rdlen = buf.readUInt16BE(off + 8);
    const rdata = buf.slice(off + 10, off + 10 + rdlen);
    off += 10 + rdlen;
    const name = nameRec.name;
    if (type === 12) { // PTR
      res.ptr.push({ name, target: decodeName(rdata, 0).name });
    } else if (type === 33) { // SRV
      if (rdata.length > 6) {
        const port = rdata.readUInt16BE(4);
        res.srv.push({ name, port, target: decodeName(rdata, 6).name });
      }
    } else if (type === 16) { // TXT
      let s = '';
      let j = 0;
      while (j < rdata.length) { const l = rdata[j]; s += rdata.slice(j + 1, j + 1 + l).toString('utf8'); j += 1 + l; }
      res.txt.push({ name, text: s });
    } else if (type === 1) { // A
      if (rdata.length === 4) res.a.push({ name, ip: Array.from(rdata).join('.') });
    }
  }
  return res;
}

/**
 * Запрос mDNS-сервисов беспроводной отладки.
 * opts.ephemeral — сразу слушать эфемерный порт и спрашивать с QU-битом: Windows-фаервол
 * часто режет входящие на 5353, а ответы на непривилегированный порт проходят (RFC 6762 §6.7 —
 * legacy unicast query обязан получить unicast-ответ).
 * Возвращает [{ service, instance, host, port, sid }]
 */
function discover(timeoutMs = 2500, opts = {}) {
  const services = ['_adb-tls-connect._tcp.local', '_adb-tls-pairing._tcp.local'];
  const startPort = opts.ephemeral ? 0 : MDNS_PORT;
  return new Promise((resolve) => {
    const results = [];
    let sock = null;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { sock && sock.close(); } catch (e) {}
      resolve(results);
    };
    const timer = setTimeout(done, timeoutMs);

    const ingest = (msg) => {
      const p = parseResponse(msg);
      const srvByName = {};
      for (const s of p.srv) srvByName[s.name] = s;
      const ipByName = {};
      for (const a of p.a) ipByName[a.name] = a.ip;
      const sidByInstance = {};
      for (const t of p.txt) {
        const m = t.text.match(/sid=(?:android_id|serial|boot_serial):([^\s|/]+)/);
        if (m) sidByInstance[t.name] = m[1];
      }
      for (const ptr of p.ptr) {
        const inst = ptr.target;
        const srv = srvByName[inst];
        if (!srv) continue;
        const host = ipByName[srv.target] || srv.target;
        const rec = { service: ptr.name, instance: inst, host, port: srv.port, sid: sidByInstance[inst] || null };
        if (!results.some(r => r.instance === rec.instance && r.service === rec.service)) results.push(rec);
      }
    };

    const sendQueries = () => {
      // в эфемерном режиме только QU: multicast-ответ нам всё равно не дойдёт
      const q1 = buildQuery(services, true);  // unicast-ответ (QU)
      const q2 = buildQuery(services, false); // обычный multicast
      const qs = startPort === 0 ? [q1] : [q1, q2];
      for (const q of qs) {
        try { sock.send(q, 0, q.length, MDNS_PORT, MDNS_ADDR); } catch (e) {}
      }
      // повтор через секунду — на случай потери первого запроса
      setTimeout(() => {
        if (finished) return;
        for (const q of qs) { try { sock.send(q, 0, q.length, MDNS_PORT, MDNS_ADDR); } catch (e) {} }
      }, 1000);
    };

    const attach = (port) => {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', (err) => {
        if (port === MDNS_PORT && !finished) {
          // 5353 занят/недоступен — уходим на эфемерный порт (работает с QU-битом)
          try { sock.close(); } catch (e) {}
          attach(0);
        } else {
          done();
        }
      });
      sock.on('message', ingest);
      sock.bind(port, () => {
        try {
          if (port === MDNS_PORT) { sock.addMembership(MDNS_ADDR); }
          sock.setMulticastTTL(255);
          sock.setMulticastLoopback(true);
        } catch (e) {}
        sendQueries();
      });
    };
    attach(startPort);
  });
}

// Unicast-обход подсети: шлём mDNS-запрос напрямую каждому хосту в порт 5353.
// Работает даже когда роутер режет multicast (частая причина «телефон не находится»).
function discoverUnicast(timeoutMs = 3000, opts = {}) {
  const services = ['_adb-tls-connect._tcp.local', '_adb-tls-pairing._tcp.local'];
  return new Promise((resolve) => {
    const results = [];
    let finished = false;
    let sock;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { sock && sock.close(); } catch (e) {}
      resolve(results);
    };
    const timer = setTimeout(done, timeoutMs);
    const ingest = makeIngester(results);
    try { sock = dgram.createSocket({ type: 'udp4' }); } catch (e) { return resolve(results); }
    sock.on('error', done);
    sock.on('message', ingest);
    sock.bind(0, () => {
      const q = buildQuery(services, true); // QU: отвечать unicast нам
      const ifaces = os.networkInterfaces();
      const bases = new Set();
      for (const k of Object.keys(ifaces)) for (const a of ifaces[k] || []) {
        if (a.family === 'IPv4' && !a.internal) bases.add(a.address.split('.').slice(0, 3).join('.'));
      }
      let sent = 0;
      for (const base of bases) {
        for (let i = 1; i <= 254; i++) {
          try { sock.send(q, 0, q.length, 5353, `${base}.${i}`); sent++; } catch (e) {}
        }
      }
      if (!sent) done();
    });
  });
}

function makeIngester(results) {
  return (msg) => {
    const p = parseResponse(msg);
    const srvByName = {};
    for (const s of p.srv) srvByName[s.name] = s;
    const ipByName = {};
    for (const a of p.a) ipByName[a.name] = a.ip;
    const sidByInstance = {};
    for (const t of p.txt) {
      const m = t.text.match(/sid=(?:android_id|serial|boot_serial):([^\s|/]+)/);
      if (m) sidByInstance[t.name] = m[1];
    }
    for (const ptr of p.ptr) {
      const inst = ptr.target;
      const srv = srvByName[inst];
      if (!srv) continue;
      const host = ipByName[srv.target] || srv.target;
      const rec = { service: ptr.name, instance: inst, host, port: srv.port, sid: sidByInstance[inst] || null };
      if (!results.some(r => r.instance === rec.instance && r.service === rec.service)) results.push(rec);
    }
  };
}

module.exports = { discover, discoverUnicast };
