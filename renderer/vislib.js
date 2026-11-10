/* vislib.js — библиотека визуализаций медиаплеера.
   Реализации по мотивам анимаций владельца (cube.html, neural_network.html, sa.html,
   unicorn.html, Fybvfwbz.html, «3D Космическая», «Кружки») + классические столбики/волна/круг.
   Все эффекты: чистый canvas 2D (без CDN — CSP и офлайн не мешают), работают ВСЕГДА,
   пока открыт плеер, а когда играет музыка — реагируют на спектр через audio = {bass, mid, treble, energy}.
   window.VISLIB — массив { name, init(w,h), draw(ctx, w, h, t, audio) }. */
'use strict';
(function () {
  const TAU = Math.PI * 2;
  function rnd(seed) { // детерминированный PRNG (sieper), чтобы рой был стабильным между кадрами
    let s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  function glow(ctx, color, blur) { ctx.shadowColor = color; ctx.shadowBlur = blur; }
  function noGlow(ctx) { ctx.shadowBlur = 0; }

  /* ---- 4. Куб-рой (по мотивам cube.html): решётка частиц, дышащая и вращающаяся ---- */
  function cubeSwarm() {
    const N = 1800, pos = new Float32Array(N * 3);
    const side = Math.ceil(Math.pow(N, 1 / 3)), sep = 3.2, off = (side * sep) / 2;
    let i = 0;
    for (let z = 0; z < side; z++) for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      if (i >= N) break;
      pos[i * 3] = x * sep - off; pos[i * 3 + 1] = y * sep - off; pos[i * 3 + 2] = z * sep - off; i++;
    }
    const rndL = rnd(42);
    const jitter = new Float32Array(N * 3);
    for (let k = 0; k < jitter.length; k++) jitter[k] = (rndL() - 0.5) * 2.2;
    return {
      name: 'Куб-рой',
      draw(ctx, w, h, t, a) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        const cx = w / 2, cy = h / 2;
        const sc = Math.min(w, h) / (side * sep) * (2.6 + a.bass * 0.9);
        const ry = t * 0.5, rx = Math.sin(t * 0.23) * 0.5 + 0.4;
        const cosY = Math.cos(ry), sinY = Math.sin(ry), cosX = Math.cos(rx), sinX = Math.sin(rx);
        const breath = 1 + 0.06 * Math.sin(t * 1.4) + a.bass * 0.22;
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < N; i++) {
          let x = (pos[i * 3] + jitter[i * 3] * (0.4 + a.treble * 1.6)) * breath;
          let y = (pos[i * 3 + 1] + jitter[i * 3 + 1] * (0.4 + a.treble * 1.6)) * breath;
          let z = (pos[i * 3 + 2] + jitter[i * 3 + 2] * (0.4 + a.treble * 1.6)) * breath;
          let x1 = x * cosY + z * sinY, z1 = -x * sinY + z * cosY;
          let y1 = y * cosX - z1 * sinX, z2 = y * sinX + z1 * cosX;
          const d = 1 + z2 / 160;
          const px = cx + x1 * sc * d, py = cy + y1 * sc * d;
          const hue = 200 + (z2 / off) * 40 + a.bass * 60;
          const sz = Math.max(0.6, 1.9 * d * (0.7 + a.mid * 0.9));
          ctx.fillStyle = `hsla(${hue},95%,${52 + a.mid * 22}%,${Math.min(0.9, 0.35 + d * 0.3)})`;
          ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
        }
        ctx.globalCompositeOperation = 'source-over';
      }
    };
  }

  /* ---- 5. Нейросеть (по мотивам neural_network.html): пульсирующая сфера-мозг ---- */
  function neuralNet() {
    const N = 1400;
    const base = new Float32Array(N * 3), hue0 = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const phi = Math.acos(1 - 2 * (i + 0.5) / N);
      const th = Math.PI * (1 + Math.sqrt(5)) * i;
      base[i * 3] = Math.sin(phi) * Math.cos(th);
      base[i * 3 + 1] = Math.sin(phi) * Math.sin(th);
      base[i * 3 + 2] = Math.cos(phi);
      hue0[i] = (i / N);
    }
    return {
      name: 'Нейросеть',
      draw(ctx, w, h, t, a) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        const cx = w / 2, cy = h / 2;
        const R = Math.min(w, h) * 0.36 * (1 + 0.05 * Math.sin(t * 2) + a.bass * 0.28);
        const rot = t * 0.25;
        const cosR = Math.cos(rot), sinR = Math.sin(rot);
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < N; i++) {
          const th = Math.atan2(base[i * 3 + 1], base[i * 3]);
          const phi = Math.acos(Math.max(-1, Math.min(1, base[i * 3 + 2])));
          const wave = Math.sin(t * 1.6 + th * 2.0) * (0.18 + a.treble * 0.55);
          let x = (1 + wave) * base[i * 3], y = (1 + wave) * base[i * 3 + 1], z = (1 + wave) * base[i * 3 + 2];
          const x1 = x * cosR - z * sinR, z1 = x * sinR + z * cosR;
          const d = 1.6 + (z1 + 1) * 0.7;
          const px = cx + x1 * R, py = cy + y * R;
          const hue = 210 + hue0[i] * 60 + Math.sin(t + phi * 3) * 20 + a.bass * 50;
          const li = 50 + 25 * Math.sin(t * 2 + hue0[i] * 8) + a.mid * 25;
          ctx.fillStyle = `hsla(${hue},100%,${li}%,0.85)`;
          const sz = 1.4 + (z1 + 1) * 1.1 + a.mid * 1.2;
          ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
        }
        ctx.globalCompositeOperation = 'source-over';
        glow(ctx, 'rgba(90,170,255,.8)', 24 + a.bass * 40);
        ctx.strokeStyle = `hsla(205,100%,70%,${0.25 + a.bass * 0.5})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, R * 1.02, 0, TAU); ctx.stroke();
        noGlow(ctx);
      }
    };
  }

  /* ---- 6. Квантовая сфера (по мотивам sa.html): волны-закрутки на шаре ---- */
  function quantumSphere() {
    const N = 1500;
    const seedR = rnd(7);
    const seedArr = new Float32Array(N);
    for (let i = 0; i < N; i++) seedArr[i] = seedR();
    return {
      name: 'Квантовая сфера',
      draw(ctx, w, h, t, a) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        const cx = w / 2, cy = h / 2;
        const S = Math.min(w, h) * 0.34 * (1 + a.bass * 0.25);
        const twist = 3, chaos = 0.5 + a.treble * 1.2;
        const rot = t * 0.4;
        const cosR = Math.cos(rot), sinR = Math.sin(rot);
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < N; i++) {
          const p = i / N, s = seedArr[i];
          const phi = Math.acos(1 - 2 * p);
          const th = TAU * p * 40;
          const wave = Math.sin(th * twist + t * 1.6 + s * 6) * 0.5 + Math.cos(phi * twist - t) * 0.5;
          const r = 1 + wave * (0.22 + a.bass * 0.35);
          const cxo = Math.sin(phi * 6 + t * 1.3) * chaos * 0.12;
          const cyo = Math.cos(th * 4 - t * 1.1) * chaos * 0.12;
          let x = Math.sin(phi) * Math.cos(th) * r + cxo;
          let y = Math.sin(phi) * Math.sin(th) * r + cyo;
          let z = Math.cos(phi) * r;
          const x1 = x * cosR - z * sinR, z1 = x * sinR + z * cosR;
          const d = 1.6 + (z1 + 1) * 0.7;
          const px = cx + x1 * S, py = cy + y * S;
          const hue = ((p + t * 0.06 + wave * 0.08) % 1) * 360;
          ctx.fillStyle = `hsla(${hue},85%,${48 + wave * 14 + a.mid * 20}%,0.85)`;
          const sz = 1.3 + (z1 + 1) * 1.2 + a.mid;
          ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
        }
        ctx.globalCompositeOperation = 'source-over';
      }
    };
  }

  /* ---- 7. Тессеракт (по мотивам unicorn.html): 4D-гиперкуб с изоклиническими поворотами ---- */
  function tesseract() {
    const N = 900;
    const rndL = rnd(1337);
    const pts = new Float32Array(N * 4);
    for (let i = 0; i < N * 4; i++) pts[i] = rndL() * 2 - 1;
    const fract = (v) => Math.abs(v - Math.trunc(v));
    return {
      name: 'Тессеракт 4D',
      draw(ctx, w, h, t, a) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        const cx = w / 2, cy = h / 2;
        const S = Math.min(w, h) * 0.4 * (1 + a.bass * 0.3);
        const morph = 0.6 + 0.35 * Math.sin(t * 1.2) + a.bass * 0.3;
        const t1 = t * 0.5, t2 = t * 0.707, t3 = t * 0.318;
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < N; i++) {
          let x4 = Math.sign(pts[i * 4]) * Math.pow(Math.abs(pts[i * 4]), morph);
          let y4 = Math.sign(pts[i * 4 + 1]) * Math.pow(Math.abs(pts[i * 4 + 1]), morph);
          let z4 = Math.sign(pts[i * 4 + 2]) * Math.pow(Math.abs(pts[i * 4 + 2]), morph);
          let w4 = Math.sign(pts[i * 4 + 3]) * Math.pow(Math.abs(pts[i * 4 + 3]), morph);
          let nx = x4 * Math.cos(t1) - w4 * Math.sin(t1); w4 = x4 * Math.sin(t1) + w4 * Math.cos(t1); x4 = nx;
          let ny = y4 * Math.cos(t2) - z4 * Math.sin(t2); let nz = y4 * Math.sin(t2) + z4 * Math.cos(t2); y4 = ny; z4 = nz;
          nx = x4 * Math.cos(t3) - y4 * Math.sin(t3); ny = x4 * Math.sin(t3) + y4 * Math.cos(t3); x4 = nx; y4 = ny;
          const cam = 2.2 + Math.cos(t * 1.5) * 0.2;
          const proj = 1 / Math.max(0.05, cam - w4);
          const px = cx + x4 * proj * S, py = cy + y4 * proj * S;
          const hue = Math.abs(w4 * 0.35 + t * 0.1) % 1 * 360;
          const li = 25 + proj * 45;
          ctx.fillStyle = `hsla(${hue},90%,${Math.min(85, Math.max(10, li + a.mid * 20))}%,${Math.min(0.95, proj * 1.1)})`;
          const sz = Math.max(1, proj * 3.2 + a.mid * 1.4);
          ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
        }
        ctx.globalCompositeOperation = 'source-over';
      }
    };
  }

  /* ---- 8. Гиперпрыжок (по мотивам Fybvfwbz.html): проводной туннель, летящий на камеру ---- */
  function hyperTunnel() {
    const RINGS = 26, SEG = 22, DEPTH = 220;
    const stars = [];
    const rndL = rnd(99);
    for (let i = 0; i < 160; i++) stars.push({ x: (rndL() - 0.5) * 90, y: (rndL() - 0.5) * 90, z: rndL() * 90 + 5 });
    return {
      name: 'Гиперпрыжок',
      draw(ctx, w, h, t, a) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        const cx = w / 2, cy = h / 2;
        const speed = 14 + a.energy * 44;
        const hueBase = (t * 24) % 360;
        const proj = (x, y, z) => {
          const k = Math.min(w, h) * 0.9 / Math.max(1, z);
          return [cx + x * k, cy + y * k, k];
        };
        // туннель: кольца уходят вдаль, z «бежит»
        ctx.lineWidth = 1.4;
        const zoff = (t * speed) % (DEPTH / RINGS);
        for (let r = 0; r < RINGS; r++) {
          const z = 8 + r * (DEPTH / RINGS) - zoff * (DEPTH / RINGS);
          if (z <= 2) continue;
          const [, , k] = proj(0, 0, z);
          const rr = 8 * k;
          const hue = (hueBase + r * 14) % 360;
          ctx.strokeStyle = `hsla(${hue},100%,${45 + a.bass * 25}%,${Math.min(0.9, 1 - r / RINGS + 0.15)})`;
          glow(ctx, `hsla(${hue},100%,60%,.8)`, 8 + a.bass * 18);
          ctx.beginPath();
          for (let s = 0; s <= SEG; s++) {
            const ang = (s / SEG) * TAU + t * 0.4;
            const px = cx + Math.cos(ang) * rr, py = cy + Math.sin(ang) * rr * 0.92;
            s ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
          }
          ctx.stroke(); noGlow(ctx);
        }
        // частицы-искры внутри туннеля
        ctx.globalCompositeOperation = 'lighter';
        for (const st of stars) {
          st.z -= speed * 0.035;
          if (st.z < 3) { st.x = (Math.random() - 0.5) * 90; st.y = (Math.random() - 0.5) * 90; st.z = 95; }
          const [px, py, k] = proj(st.x, st.y, st.z);
          const sz = Math.max(0.5, 2.6 * k);
          ctx.fillStyle = `hsla(${(hueBase + 160) % 360},100%,70%,.9)`;
          ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
        }
        ctx.globalCompositeOperation = 'source-over';
      }
    };
  }

  /* ---- 9. Космос (по мотивам «3D Космическая Анимация»): цветные звёзды, полёт сквозь поле ---- */
  function cosmos() {
    const N = 700;
    const rndL = rnd(2024);
    const stars = [];
    for (let i = 0; i < N; i++) stars.push({
      x: (rndL() - 0.5) * 160, y: (rndL() - 0.5) * 160, z: rndL() * 160 + 1,
      hue: rndL() * 360
    });
    return {
      name: 'Космос',
      draw(ctx, w, h, t, a) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        const cx = w / 2, cy = h / 2;
        const spd = 26 + a.energy * 90;
        ctx.globalCompositeOperation = 'lighter';
        for (const s of stars) {
          const z0 = s.z;
          s.z -= spd * 0.05;
          if (s.z < 2) { s.x = (Math.random() - 0.5) * 160; s.y = (Math.random() - 0.5) * 160; s.z = 160; }
          const k1 = Math.min(w, h) / z0, k2 = Math.min(w, h) / s.z;
          const px = cx + s.x * k2, py = cy + s.y * k2;
          // «хвост» от предыдущего положения — эффект скорости
          const tx = cx + s.x * k1, ty = cy + s.y * k1;
          const hue = s.hue;
          ctx.strokeStyle = `hsla(${hue},90%,68%,.85)`;
          ctx.lineWidth = Math.max(0.5, 2.2 * k2);
          ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(px, py); ctx.stroke();
        }
        // туманность: два мягких пятна, пульсируют басом
        noGlow(ctx);
        const g1 = ctx.createRadialGradient(cx - w * 0.18, cy - h * 0.12, 0, cx - w * 0.18, cy - h * 0.12, w * 0.4);
        g1.addColorStop(0, `hsla(${(t * 20) % 360},80%,55%,${0.10 + a.bass * 0.14})`);
        g1.addColorStop(1, 'transparent');
        ctx.fillStyle = g1; ctx.fillRect(0, 0, w, h);
        const g2 = ctx.createRadialGradient(cx + w * 0.2, cy + h * 0.16, 0, cx + w * 0.2, cy + h * 0.16, w * 0.35);
        g2.addColorStop(0, `hsla(${(t * 20 + 140) % 360},80%,55%,${0.08 + a.mid * 0.12})`);
        g2.addColorStop(1, 'transparent');
        ctx.fillStyle = g2; ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'source-over';
      }
    };
  }

  /* ---- 10. Светлячки (по мотивам «Кружки Анимация»): мягкие цветные круги, дышат басом ---- */
  function fireflies() {
    const N = 42;
    const rndL = rnd(5150);
    const items = [];
    for (let i = 0; i < N; i++) items.push({
      x: rndL(), y: rndL(), size: 26 + rndL() * 90, hue: rndL() * 360,
      phase: rndL() * TAU, sp: 0.4 + rndL() * 0.8, dx: (rndL() - 0.5), dy: (rndL() - 0.5)
    });
    return {
      name: 'Светлячки',
      draw(ctx, w, h, t, a) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'lighter';
        for (const f of items) {
          f.x += f.dx * 0.0006 * f.sp; f.y += f.dy * 0.0006 * f.sp;
          if (f.x < -0.1) f.x = 1.1; if (f.x > 1.1) f.x = -0.1;
          if (f.y < -0.1) f.y = 1.1; if (f.y > 1.1) f.y = -0.1;
          const blink = Math.max(0, Math.sin(t * f.sp * 1.4 + f.phase));
          const alpha = (0.05 + blink * (0.35 + a.energy * 0.5));
          const r = f.size * (0.75 + blink * 0.35 + a.bass * 0.5);
          const px = f.x * w, py = f.y * h;
          const g = ctx.createRadialGradient(px, py, 0, px, py, r);
          g.addColorStop(0, `hsla(${f.hue},100%,65%,${alpha})`);
          g.addColorStop(0.4, `hsla(${f.hue},100%,55%,${alpha * 0.45})`);
          g.addColorStop(1, 'transparent');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(px, py, r, 0, TAU); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      }
    };
  }

  /* ---- 1. Столбики  2. Волна  3. Круг (классика, перенесены из плеера ) ---- */
  function barsVis() {
    return {
      name: 'Столбики',
      draw(ctx, w, h, t, a) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        const bars = 48;
        const bw = w / bars;
        for (let i = 0; i < bars; i++) {
          // без анализа спектра рисуем «дышащую» волну по синусам
          const v = a.spectrum.length ? a.spectrum[Math.floor(i / bars * a.spectrum.length)] / 255
            : (0.18 + 0.16 * Math.sin(t * 2 + i * 0.5) + 0.1 * Math.sin(t * 3.1 + i * 0.23));
          const bh = Math.max(2, v * (h - 14));
          const g = ctx.createLinearGradient(0, h, 0, h - bh);
          g.addColorStop(0, '#1976d2'); g.addColorStop(0.6, '#4fc3f7'); g.addColorStop(1, '#b388ff');
          ctx.fillStyle = g;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(i * bw + 2, h - bh, bw - 3, bh, 3); else ctx.rect(i * bw + 2, h - bh, bw - 3, bh);
          ctx.fill();
        }
      }
    };
  }
  function waveVis() {
    return {
      name: 'Волна',
      draw(ctx, w, h, t, a) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        ctx.lineWidth = 2.4; ctx.strokeStyle = '#4fc3f7';
        glow(ctx, 'rgba(79,195,247,.8)', 12);
        ctx.beginPath();
        const n = 160;
        for (let i = 0; i <= n; i++) {
          const x = i / n * w;
          const base = a.wave && a.wave.length ? (a.wave[Math.floor(i / n * (a.wave.length - 1))] - 128) / 128 : 0;
          const idle = Math.sin(i / n * TAU * 3 + t * 2.4) * 0.22 + Math.sin(i / n * TAU * 7 - t * 1.7) * 0.1;
          const y = h / 2 + (base + (base ? 0 : idle)) * (h / 2 - 10) * (0.7 + a.energy * 0.6);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke(); noGlow(ctx);
      }
    };
  }
  function circleVis() {
    return {
      name: 'Круг',
      draw(ctx, w, h, t, a) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        const cx = w / 2, cy = h / 2;
        const R = Math.min(w, h) * 0.22 + a.bass * Math.min(w, h) * 0.12;
        ctx.lineWidth = 2;
        for (let i = 0; i < 72; i++) {
          const v = a.spectrum.length ? a.spectrum[Math.floor(i / 72 * a.spectrum.length)] / 255
            : (0.2 + 0.2 * Math.sin(t * 2 + i * 0.6));
          const ang = (i / 72) * TAU - Math.PI / 2 + t * 0.25;
          const r1 = R + 6, r2 = R + 6 + v * (Math.min(w, h) * 0.26);
          ctx.strokeStyle = `hsl(${200 + v * 90}, 80%, ${45 + v * 25}%)`;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
          ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
          ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU);
        ctx.strokeStyle = 'rgba(79,195,247,.55)'; ctx.stroke();
      }
    };
  }

  window.VISLIB = [
    barsVis(),      // 1
    waveVis(),      // 2
    circleVis(),    // 3
    cubeSwarm(),    // 4
    neuralNet(),    // 5
    quantumSphere(),// 6
    tesseract(),    // 7
    hyperTunnel(),  // 8
    cosmos(),       // 9
    fireflies()     // 10
  ];
})();
