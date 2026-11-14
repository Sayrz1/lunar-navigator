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
