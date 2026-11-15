// 2D charts: horizon skyline, landing calendar, ice map.
// Colours come from CSS variables, so a theme change only needs a redraw.

import { horizonAt, toStereo } from '../core/horizon.js';

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Match the canvas to its CSS width at the screen's pixel ratio; draw in CSS pixels.
function fit(canvas, cssHeight) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  const h = cssHeight ?? w;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, W: w, H: h };
}

const font = size => `${size}px ${css('--font')}`;

// A canvas inside a hidden tab has no size; it is drawn when its tab opens.
const hidden = canvas => !canvas.getClientRects().length;

export function drawHorizonChart(canvas, hz, path, now) {
  if (hidden(canvas)) return;
  const narrow = (canvas.clientWidth || 600) < 560;
  const { ctx, W, H } = fit(canvas, narrow ? 240 : 300);
  const pad = { l: 44, r: 10, t: 12, b: 26 };

  const values = [...hz.el, ...path.map(p => p.sun.el), ...path.map(p => p.earth.el)];
  const lo = Math.floor(Math.min(...values) - 1);
  const hi = Math.ceil(Math.max(...values) + 1);
  const x = az => pad.l + (az / 360) * (W - pad.l - pad.r);
  const y = el => pad.t + ((hi - el) / (hi - lo)) * (H - pad.t - pad.b);

  ctx.clearRect(0, 0, W, H);
  ctx.font = font(11);
  ctx.strokeStyle = css('--line');
  ctx.fillStyle = css('--muted');
  ctx.lineWidth = 1;
  const stepEl = hi - lo > 24 ? 4 : hi - lo > 12 ? 2 : 1;
  for (let el = Math.ceil(lo / stepEl) * stepEl; el <= hi; el += stepEl) {
    ctx.beginPath(); ctx.moveTo(pad.l, y(el)); ctx.lineTo(W - pad.r, y(el)); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(`${el}°`, pad.l - 6, y(el) + 4);
  }
  ctx.textAlign = 'center';
  for (const [az, label] of [[0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'], [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'], [360, 'N']]) {
    if (narrow && label.length > 1) continue;
    ctx.fillText(label, x(az), H - 8);
  }

  ctx.strokeStyle = css('--muted');
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pad.l, y(0)); ctx.lineTo(W - pad.r, y(0)); ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = css('--ground');
  ctx.beginPath();
  ctx.moveTo(x(0), H - pad.b);
  for (let az = 0; az <= 360; az += hz.azStep) ctx.lineTo(x(az), y(horizonAt(hz, az)));
  ctx.lineTo(x(360), H - pad.b);
  ctx.closePath();
  ctx.fill();

  const drawTrack = (key, colour) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    let prev = null;
    for (const p of path) {
      const b = p[key];
      if (prev === null || Math.abs(b.az - prev) > 180) ctx.moveTo(x(b.az), y(b.el));
      else ctx.lineTo(x(b.az), y(b.el));
      prev = b.az;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    const b = now[key];
    ctx.fillStyle = colour;
    ctx.beginPath(); ctx.arc(x(b.az), y(b.el), 6, 0, 2 * Math.PI); ctx.fill();
    ctx.strokeStyle = css('--card'); ctx.lineWidth = 2; ctx.stroke();
  };
  drawTrack('sun', css('--sun'));
  drawTrack('earth', css('--earth'));
}

// Landing calendar: one row per month, one cell per day, coloured by the share of that day's
// hours with Sun and Earth together. Days where a landing window opens get a dot.
// Returns a function mapping a click (CSS px) to that day's start time, or null.
export function drawCalendar(canvas, days, chosenMs, windows, locale) {
  const months = [];
  for (const d of days) {
    const dt = new Date(d.t);
    const key = dt.getUTCFullYear() * 12 + dt.getUTCMonth();
    if (months.at(-1)?.key !== key) months.push({ key, t: Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1), cells: [] });
    months.at(-1).cells[dt.getUTCDate() - 1] = d;
  }
  const narrow = (canvas.clientWidth || 600) < 560;
  const pad = { l: narrow ? 58 : 76, t: 22, r: 4, b: 4 };
  const W = canvas.clientWidth || canvas.parentElement.clientWidth;
  const cw = (W - pad.l - pad.r) / 31;
  const ch = Math.max(10, Math.min(18, cw * 0.8));
  const { ctx } = fit(canvas, pad.t + months.length * ch + pad.b);

  const opens = new Set(windows.map(w => Math.floor(w.open / 86400e3)));
  const muted = css('--muted');
  // night -> amber -> green; the night shade follows the theme (--night)
  const stops = [css('--night').match(/\d+/g).map(Number), [120, 82, 30], [255, 181, 71], [125, 220, 154]];
  const ramp = v => {
    const f = Math.min(0.999, v) * (stops.length - 1), i = Math.floor(f), t = f - i;
    return `rgb(${stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * t)).join(',')})`;
  };

  ctx.font = font(10);
  ctx.fillStyle = muted;
  ctx.textAlign = 'center';
  for (const d of [1, 5, 10, 15, 20, 25, 30]) ctx.fillText(String(d), pad.l + (d - 0.5) * cw, 14);
  const fmt = new Intl.DateTimeFormat(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const chosenDay = Math.floor(chosenMs / 86400e3);

  months.forEach((m, r) => {
    const y = pad.t + r * ch;
    ctx.fillStyle = muted;
    ctx.textAlign = 'right';
    ctx.fillText(fmt.format(m.t), pad.l - 8, y + ch * 0.72);
    for (let c = 0; c < 31; c++) {
      const d = m.cells[c];
      if (!d) continue;
      const x = pad.l + c * cw;
      ctx.fillStyle = ramp(d.both);
      ctx.fillRect(x + 0.5, y + 0.5, cw - 1.5, ch - 1.5);
      const day = Math.floor(d.t / 86400e3);
      if (opens.has(day)) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(x + cw / 2, y + ch / 2, Math.min(cw, ch) * 0.16, 0, 2 * Math.PI); ctx.fill();
      }
      if (day === chosenDay) {
        ctx.strokeStyle = css('--text'); ctx.lineWidth = 2;
        ctx.strokeRect(x + 0.5, y + 0.5, cw - 1.5, ch - 1.5);
      }
    }
  });

  return (px, py) => {
    const c = Math.floor((px - pad.l) / cw), r = Math.floor((py - pad.t) / ch);
    const d = months[r]?.cells[c];
    return d ? d.t : null;
  };
}

// Shaded relief with permanent shadow in ice blue, plus spot markers.
// Height colours as in lunar topography maps (LOLA, LunaServ): violet and blue for the
// lowest ground through green and yellow to red for the highest. t from 0 to 1.
const HEIGHT_STOPS = [[0, [58, 30, 120]], [0.18, [40, 90, 200]], [0.36, [50, 175, 215]], [0.52, [90, 195, 110]], [0.68, [225, 215, 80]], [0.84, [235, 140, 50]], [1, [200, 50, 45]]];
export function heightRamp(t) {
  t = Math.min(1, Math.max(0, t));
  let i = 1;
  while (i < HEIGHT_STOPS.length - 1 && t > HEIGHT_STOPS[i][0]) i++;
  const [t0, a] = HEIGHT_STOPS[i - 1], [t1, b] = HEIGHT_STOPS[i];
  const f = (t - t0) / (t1 - t0);
  return a.map((v, k) => v + (b[k] - v) * f);
}

// mode 'ice': grey relief with permanent shadow in blue. 'height': relief coloured by height.
export function drawIceMap(canvas, g, markers, mode = 'ice') {
  if (hidden(canvas)) return;
  const { ctx, W } = fit(canvas);
  const n = g.cells;
  const img = new ImageData(n, n);
  const ice = [143, 227, 255];
  const d = g.cellKm * 1000;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const k = i * n + j;
    const hx = g.height[i * n + Math.min(j + 1, n - 1)] - g.height[i * n + Math.max(j - 1, 0)];
    const hy = g.height[Math.max(i - 1, 0) * n + j] - g.height[Math.min(i + 1, n - 1) * n + j];
    // light from the upper left, 45 deg up
    const nx = -hx / (2 * d), ny = -hy / (2 * d);
    const shade = Math.max(0, (nx * -0.5 + ny * 0.5 + 0.7071) / Math.sqrt(nx * nx + ny * ny + 1));
    if (mode === 'height') {
      const c = heightRamp((g.height[k] - g.minM) / Math.max(1, g.maxM - g.minM));
      const lit = 0.45 + shade * 0.75;
      img.data.set([c[0] * lit, c[1] * lit, c[2] * lit, 255], k * 4);
      continue;
    }
    const grey = 30 + shade * 170;
    const p = g.psr[k] / 250;
    img.data.set([grey * (1 - p) + ice[0] * p, grey * (1 - p) + ice[1] * p, grey * (1 - p) + ice[2] * p, 255], k * 4);
  }
  const off = document.createElement('canvas');
  off.width = off.height = n;
  off.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, W, W);

  // 2 km walking circle around the active spot and markers
  const px = (lat, lon) => {
    const [x, y] = toStereo(lat, lon);
    return [((x - g.x0) / (g.x1 - g.x0)) * W, ((g.y1 - y) / (g.y1 - g.y0)) * W];
  };
  for (const m of markers) {
    const [mx, my] = px(m.lat, m.lon);
    if (m.active) {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.setLineDash([5, 5]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(mx, my, (2 / (g.x1 - g.x0)) * W, 0, 2 * Math.PI); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (m.line) {
      const [lx, ly] = px(...m.line);
      ctx.strokeStyle = css('--ice'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(lx, ly); ctx.stroke();
    }
    ctx.fillStyle = m.colour;
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(mx, my, m.active ? 7 : 5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
  }
  // scale bar
  const km = (g.x1 - g.x0) > 40 ? 10 : 5;
  const len = (km / (g.x1 - g.x0)) * W;
  ctx.fillStyle = '#fff';
  ctx.fillRect(16, W - 22, len, 3);
  ctx.font = font(11);
  ctx.fillText(`${km} km`, 16, W - 28);
}

// Landing scatter: the grid around the aim point (rows north to south, columns west to east),
// coloured by one value in percent. Cells too steep to land on are crossed out, and the ring
// marks 100 m from the aim point.
export function drawScatter(canvas, doc, metric) {
  if (hidden(canvas)) return;
  const n = doc.size, half = (n - 1) / 2;
  const W = canvas.clientWidth || canvas.parentElement.clientWidth;
  const { ctx } = fit(canvas, W);
  const pad = 26, cell = (W - 2 * pad) / n;
  const values = doc.grid.cells[metric];
  ctx.clearRect(0, 0, W, W);
  const tint = { both: [125, 220, 154], sun: [255, 181, 71], earth: [90, 169, 255] }[metric];
  const base = [24, 27, 36];
  // stretch the colours over this grid's own range so small differences show; the key says so
  const lo = Math.min(...values), hi = Math.max(...values);
  const f = v => (hi > lo ? 0.15 + 0.85 * (v - lo) / (hi - lo) : 1);
  const colour = v => `rgb(${base.map((c, k) => Math.round(c + (tint[k] - c) * f(v))).join(',')})`;

  ctx.font = font(10);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let k = 0; k < values.length; k++) {
    const i = Math.floor(k / n), j = k % n;
    const x = pad + j * cell, y = pad + i * cell, v = values[k];
    ctx.fillStyle = colour(v);
    ctx.fillRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
    if (!(doc.grid.cells.slope[k] < 10)) {
      ctx.strokeStyle = 'rgba(255,107,94,0.9)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x + 4, y + 4); ctx.lineTo(x + cell - 4, y + cell - 4);
      ctx.moveTo(x + cell - 4, y + 4); ctx.lineTo(x + 4, y + cell - 4); ctx.stroke();
    }
    if (cell > 26) {
      ctx.fillStyle = v > 55 ? 'rgba(10,12,16,0.85)' : 'rgba(236,232,223,0.85)';
      ctx.fillText(String(Math.round(v)), x + cell / 2, y + cell / 2 + 0.5);
    }
  }

  // 100 m ring and aim point
  const cx = pad + (half + 0.5) * cell, cy = cx;
  const r = (100 / doc.stepM) * cell;
  ctx.strokeStyle = css('--text'); ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 2;
  ctx.strokeRect(pad + half * cell + 1, pad + half * cell + 1, cell - 2, cell - 2);

  // robust aim: a diamond on the chosen cell, and the circle its worst case was taken over
  const aim = doc.aim;
  if (aim && aim.offsetM >= 1) {
    const ax = pad + (aim.j + 0.5) * cell, ay = pad + (aim.i + 0.5) * cell, d = cell * 0.32;
    ctx.strokeStyle = css('--accent'); ctx.lineWidth = 1.5; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.arc(ax, ay, (aim.radiusM / doc.stepM) * cell, 0, 2 * Math.PI); ctx.stroke();
    ctx.setLineDash([]); ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(ax, ay - d); ctx.lineTo(ax + d, ay); ctx.lineTo(ax, ay + d); ctx.lineTo(ax - d, ay); ctx.closePath();
    ctx.stroke();
  }

  // map up is towards 0 deg longitude (the Earth-facing side); scale bar
  ctx.fillStyle = css('--muted');
  ctx.fillText('↑ 0°E', cx, pad / 2);
  ctx.textAlign = 'start';
  ctx.fillText(`${doc.stepM} m`, pad + cell + 6, W - pad / 2);
  ctx.fillRect(pad, W - pad / 2, cell, 1.5);

  // colour key, right-aligned under the grid
  const kw = Math.min(120, W * 0.3), kx = W - pad - kw, ky = W - pad / 2 - 3;
  const g = ctx.createLinearGradient(kx, 0, kx + kw, 0);
  g.addColorStop(0, colour(lo)); g.addColorStop(1, colour(hi));
  ctx.fillStyle = g; ctx.fillRect(kx, ky, kw, 6);
  ctx.fillStyle = css('--muted');
  ctx.textAlign = 'end'; ctx.fillText(`${Math.round(lo)}%`, kx - 6, ky + 3);
  ctx.textAlign = 'start'; ctx.fillText(`${Math.round(hi)}%`, kx + kw + 4, ky + 3);
}

// Radiation background through the solar cycle: monthly medians of the CRaTER surface dose
// (solid), the previous-cycle estimate for later dates (dashed), storm days as ticks along
// the top, and the chosen landing time.
export function drawRadiation(canvas, { months, estimate, storms, now, top = 2.5 }) {
  if (hidden(canvas)) return;
  const { ctx, W, H } = fit(canvas, canvas.clientWidth < 560 ? 200 : 240);
  const pad = { l: 44, r: 12, t: 18, b: 24 };
  const t0 = Date.UTC(2009, 0, 1), t1 = Date.UTC(2036, 0, 1);
  const x = t => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = v => H - pad.b - (Math.min(v, top) / top) * (H - pad.t - pad.b);

  ctx.font = font(10);
  ctx.fillStyle = css('--muted');
  ctx.strokeStyle = css('--line');
  ctx.lineWidth = 1;
  ctx.textAlign = 'end';
  for (let k = 0; k <= 5; k++) {
    const v = (top / 5) * k;
    ctx.beginPath(); ctx.moveTo(pad.l, y(v)); ctx.lineTo(W - pad.r, y(v)); ctx.stroke();
    ctx.fillText(v.toFixed(1), pad.l - 6, y(v) + 3);
  }
  ctx.textAlign = 'center';
  for (let yr = 2010; yr <= 2035; yr += W < 560 ? 5 : 2) ctx.fillText(String(yr), x(Date.UTC(yr, 0, 1)), H - 6);

  const line = (pts, colour, dash) => {
    ctx.strokeStyle = colour; ctx.lineWidth = 2; ctx.setLineDash(dash);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v))));
    ctx.stroke(); ctx.setLineDash([]);
  };
  line(months, css('--text'), []);
  line(estimate, css('--sun'), [5, 4]);

  ctx.fillStyle = css('--bad');
  for (const t of storms) ctx.fillRect(x(t) - 0.5, pad.t - 10, 1.5, 6);

  const nx = x(now);
  ctx.strokeStyle = css('--earth'); ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(nx, pad.t); ctx.lineTo(nx, H - pad.b); ctx.stroke();
}
