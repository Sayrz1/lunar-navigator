// Site state at a given time, and the next time it changes.

import { sunEarthAt } from './ephemeris.js';
import { horizonAt, discFraction } from './horizon.js';

const HOUR = 3600e3;
const SUN_RADIUS_DEG = 0.2666; // mean angular radius seen from the Moon (~1 au)

// What a lander at the site sees at time ms. frame must be built at ground + observer
// height, the same height the horizon was computed for.
export function stateAt(eph, ms, frame, hz) {
  const { sun, earth } = sunEarthAt(eph, ms, frame);
  const sunClear = sun.el - horizonAt(hz, sun.az);
  const earthClear = earth.el - horizonAt(hz, earth.az);
  const sunR = SUN_RADIUS_DEG * (149597870.7 / sun.km);
  return {
    sun: { ...sun, horizon: sun.el - sunClear, clear: sunClear, disc: discFraction(sunClear, sunR) },
    earth: { ...earth, horizon: earth.el - earthClear, clear: earthClear },
    sunlit: sunClear > -sunR,        // any part of the disc above the terrain
    earthInView: earthClear > 0,     // Earth's centre above the terrain: line of sight for radio
  };
}

// Next time test(state) flips, searching hourly then narrowing to one minute.
// Returns null if nothing changes within maxDays (or the ephemeris runs out).
export function nextChange(eph, startMs, frame, hz, test, maxDays = 60) {
  const now = test(stateAt(eph, startMs, frame, hz));
  const end = Math.min(startMs + maxDays * 24 * HOUR, eph.end);
  let a = startMs;
  for (let t = startMs + HOUR; t <= end; t += HOUR) {
    if (test(stateAt(eph, t, frame, hz)) !== now) {
      let lo = a, hi = t;
      while (hi - lo > 60e3) {
        const mid = (lo + hi) / 2;
        if (test(stateAt(eph, mid, frame, hz)) === now) lo = mid; else hi = mid;
      }
      return { at: hi, from: now };
    }
    a = t;
  }
  return null;
}

// Hourly track of Sun and Earth over a span, for charts.
export function track(eph, startMs, hours, frame, hz) {
  const out = [];
  for (let k = 0; k <= hours; k++) {
    const t = startMs + k * HOUR;
    if (!eph.covers(t)) break;
    out.push({ t, ...stateAt(eph, t, frame, hz) });
  }
  return out;
}

// One flag byte per ephemeris row for the whole table: bit 1 = sunlit, bit 2 = Earth in view.
export const SUN = 1, EARTH = 2, BOTH = 3;
export function hourlyFlags(eph, frame, hz) {
  const flags = new Uint8Array(eph.rows);
  for (let k = 0; k < eph.rows; k++) {
    const s = stateAt(eph, eph.start + k * eph.stepMs, frame, hz);
    flags[k] = (s.sunlit ? SUN : 0) | (s.earthInView ? EARTH : 0);
  }
  return flags;
}

// Longest run of rows where (flag & bit) is missing, and the share of rows where it is set.
function runs(flags, bit) {
  let on = 0, gap = 0, longest = 0;
  for (const f of flags) {
    if ((f & bit) === bit) { on++; gap = 0; } else longest = Math.max(longest, ++gap);
  }
  return { share: on / flags.length, longestGap: longest };
}

export function summary(flags, stepHours) {
  const sun = runs(flags, SUN), earth = runs(flags, EARTH), both = runs(flags, BOTH);
  const pct = v => +(100 * v).toFixed(1);
  return {
    sunPct: pct(sun.share), earthPct: pct(earth.share), bothPct: pct(both.share),
    longestDarkH: sun.longestGap * stepHours, longestNoEarthH: earth.longestGap * stepHours,
  };
}

// Landing windows: times you can land and keep Sun and Earth for the whole stay.
// Returns [{ open, close }] in ms: landing anywhere from open to close works.
export function landingWindows(eph, flags, stayHours) {
  const need = Math.ceil(stayHours / (eph.stepMs / HOUR));
  const run = new Int32Array(flags.length + 1);
  for (let k = flags.length - 1; k >= 0; k--) run[k] = (flags[k] & BOTH) === BOTH ? run[k + 1] + 1 : 0;
  const out = [];
  let open = -1;
  for (let k = 0; k <= flags.length - need; k++) {
    const ok = run[k] >= need;
    if (ok && open < 0) open = k;
    if (!ok && open >= 0) { out.push({ open: eph.start + open * eph.stepMs, close: eph.start + (k - 1) * eph.stepMs }); open = -1; }
  }
  if (open >= 0) out.push({ open: eph.start + open * eph.stepMs, close: eph.start + (flags.length - need) * eph.stepMs });
  return out;
}

// Share of rows in [fromMs, fromMs + hours) with every bit of `bit` set.
export function shareBetween(eph, flags, fromMs, hours, bit = BOTH) {
  const a = Math.max(0, Math.round((fromMs - eph.start) / eph.stepMs));
  const b = Math.min(flags.length, a + Math.round(hours / (eph.stepMs / HOUR)));
  let n = 0;
  for (let k = a; k < b; k++) if ((flags[k] & bit) === bit) n++;
  return b > a ? n / (b - a) : 0;
}

// Per-day share of hours with Sun and Earth together, for the calendar.
export function dailyShare(eph, flags) {
  const perDay = Math.round(24 * HOUR / eph.stepMs);
  const days = [];
  for (let k = 0; k < flags.length; k += perDay) {
    let n = 0, m = 0;
    for (let j = k; j < Math.min(k + perDay, flags.length); j++) { m++; if ((flags[j] & BOTH) === BOTH) n++; }
    days.push({ t: eph.start + k * eph.stepMs, both: n / m });
  }
  return days;
}

// Lunar eclipses, seen from the Moon: Earth passes in front of the Sun. Our horizon model
// counts the Sun as up whenever it clears the terrain, so these hours are listed apart.
// Uses the Moon's centre; a polar site sees the same event within a minute or two.
const EARTH_RADIUS_KM = 6378.137, SUN_RADIUS_KM = 695700;

function separation(eph, ms) {
  const r = eph.sample(ms);
  const s = toVec(r.sunLat, r.sunLon), e = toVec(r.earthLat, r.earthLon);
  const cos = Math.min(1, s[0] * e[0] + s[1] * e[1] + s[2] * e[2]);
  return {
    sep: Math.acos(cos) / DEG_R,
    earthR: Math.asin(EARTH_RADIUS_KM / r.earthKm) / DEG_R,
    sunR: Math.asin(SUN_RADIUS_KM / r.sunKm) / DEG_R,
  };
}
const DEG_R = Math.PI / 180;
function toVec(lat, lon) {
  const la = lat * DEG_R, lo = lon * DEG_R;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

// [{ peak, start, end, totalStart, totalEnd, covered }] where covered is the share of the
// Sun's disc hidden at the peak (1 = the Sun is fully behind Earth).
export function eclipses(eph) {
  const out = [];
  const gap = ms => { const g = separation(eph, ms); return g.sep - (g.earthR + g.sunR); };
  const full = ms => { const g = separation(eph, ms); return g.sep - (g.earthR - g.sunR); };
  const cross = (f, a, b) => { // f(a) and f(b) have opposite signs
    for (let i = 0; i < 30; i++) { const m = (a + b) / 2; if (Math.sign(f(m)) === Math.sign(f(a))) a = m; else b = m; }
    return Math.round((a + b) / 2 / 1000) * 1000;
  };
  for (let k = 1; k < eph.rows - 1; k++) {
    const t = eph.start + k * eph.stepMs;
    const here = separation(eph, t);
    if (here.sep > here.earthR + here.sunR + 1) continue;
    const before = separation(eph, t - eph.stepMs).sep, after = separation(eph, t + eph.stepMs).sep;
    if (!(here.sep <= before && here.sep < after)) continue;
    // golden-section search for the closest approach within the hour either side
    let a = t - eph.stepMs, b = t + eph.stepMs;
    for (let i = 0; i < 40; i++) {
      const m1 = a + (b - a) * 0.382, m2 = a + (b - a) * 0.618;
      if (separation(eph, m1).sep < separation(eph, m2).sep) b = m2; else a = m1;
    }
    const peak = Math.round((a + b) / 2 / 1000) * 1000;
    if (gap(peak) >= 0) continue;
    const span = 6 * HOUR;
    const lo = Math.max(eph.start, peak - span), hi = Math.min(eph.end, peak + span);
    const e = {
      peak,
      start: gap(lo) > 0 ? cross(gap, lo, peak) : lo,
      end: gap(hi) > 0 ? cross(gap, peak, hi) : hi,
    };
    if (full(peak) < 0) { e.totalStart = cross(full, e.start, peak); e.totalEnd = cross(full, peak, e.end); }
    const g = separation(eph, peak);
    e.covered = Math.min(1, discCovered(g.sep, g.earthR, g.sunR));
    out.push(e);
  }
  return out;
}

// share of a disc of radius r hidden by a disc of radius R whose centre is d away
function discCovered(d, R, r) {
  if (d >= R + r) return 0;
  if (d <= R - r) return 1;
  const a = Math.acos((d * d + r * r - R * R) / (2 * d * r)), b = Math.acos((d * d + R * R - r * r) / (2 * d * R));
  const area = r * r * (a - Math.sin(2 * a) / 2) + R * R * (b - Math.sin(2 * b) / 2);
  return area / (Math.PI * r * r);
}
