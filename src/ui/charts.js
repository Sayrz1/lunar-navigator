// 360 degree horizon chart: terrain skyline with Sun and Earth tracks.
// Colours come from CSS variables, so a theme change only needs a redraw.

import { horizonAt } from '../core/horizon.js';

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function drawHorizonChart(canvas, hz, path, now) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const pad = { l: 48, r: 12, t: 14, b: 30 };

  const values = [...hz.el, ...path.map(p => p.sun.el), ...path.map(p => p.earth.el)];
  const lo = Math.floor(Math.min(...values) - 1);
  const hi = Math.ceil(Math.max(...values) + 1);
  const x = az => pad.l + (az / 360) * (W - pad.l - pad.r);
  const y = el => pad.t + ((hi - el) / (hi - lo)) * (H - pad.t - pad.b);

  ctx.clearRect(0, 0, W, H);
  ctx.font = '12px ui-monospace, monospace';

  // grid
  ctx.strokeStyle = css('--line');
  ctx.fillStyle = css('--muted');
  ctx.lineWidth = 1;
  for (let el = Math.ceil(lo); el <= hi; el += hi - lo > 12 ? 2 : 1) {
    ctx.beginPath(); ctx.moveTo(pad.l, y(el)); ctx.lineTo(W - pad.r, y(el)); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(`${el}°`, pad.l - 6, y(el) + 4);
  }
  ctx.textAlign = 'center';
  for (const [az, label] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W'], [360, 'N']]) {
    ctx.fillText(label, x(az), H - 10);
  }

  // flat horizon
  ctx.strokeStyle = css('--muted');
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pad.l, y(0)); ctx.lineTo(W - pad.r, y(0)); ctx.stroke();
  ctx.setLineDash([]);

  // terrain
  ctx.fillStyle = css('--ground');
  ctx.beginPath();
  ctx.moveTo(x(0), H - pad.b);
  for (let az = 0; az <= 360; az += hz.azStep) ctx.lineTo(x(az), y(horizonAt(hz, az)));
  ctx.lineTo(x(360), H - pad.b);
  ctx.closePath();
  ctx.fill();

  // tracks, broken where the azimuth wraps past north
  const drawTrack = (key, colour) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.85;
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
  };
  drawTrack('sun', css('--sun'));
  drawTrack('earth', css('--earth'));
}
