// Sun / Earth strip under the 3D view: one band each over the next few weeks, with a marker
// at the chosen time. Click or drag on it to move the time.

import { SUN, EARTH } from '../core/analysis.js';

const DAY = 86400e3;

export function drawTimeline(canvas, { eph, flags, from, days, now, locale }) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const to = from + days * DAY;
  const x = ms => ((ms - from) / (to - from)) * W;
  const band = (y, h, bit, on, off) => {
    ctx.fillStyle = off;
    ctx.fillRect(0, y, W, h);
    ctx.fillStyle = on;
    const k0 = Math.max(0, Math.floor((from - eph.start) / eph.stepMs));
    const k1 = Math.min(flags.length, Math.ceil((to - eph.start) / eph.stepMs));
    let run = -1;
    for (let k = k0; k <= k1; k++) {
      const lit = k < k1 && (flags[k] & bit) === bit;
      if (lit && run < 0) run = k;
      if (!lit && run >= 0) {
        const a = x(eph.start + run * eph.stepMs), b = x(eph.start + k * eph.stepMs);
        ctx.fillRect(a, y, Math.max(1, b - a), h);
        run = -1;
      }
    }
  };
  const bh = Math.round((H - 18) / 2) - 3;
  band(0, bh, SUN, '#ffb547', 'rgba(255,181,71,0.14)');
  band(bh + 5, bh, EARTH, '#5aa9ff', 'rgba(90,169,255,0.12)');

  // day ticks
  ctx.fillStyle = 'rgba(236,232,223,0.6)';
  ctx.font = "11px 'IBM Plex Mono', 'IBM Plex Sans Arabic', monospace";
  const fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const step = W < 600 ? 10 : 5;
  const first = Math.ceil(from / DAY) * DAY;
  for (let d = first, i = 0; d < to; d += DAY, i++) {
    ctx.fillRect(x(d), 2 * bh + 5, 1, 4);
    if (i % step === 0) ctx.fillText(fmt.format(d), x(d) + 3, H - 2);
  }

  // chosen time
  const cx = x(now);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(cx - 1, 0, 2, 2 * bh + 5);
  ctx.beginPath(); ctx.moveTo(cx - 5, 0); ctx.lineTo(cx + 5, 0); ctx.lineTo(cx, 6); ctx.fill();
  return px => from + (px / W) * (to - from);
}
