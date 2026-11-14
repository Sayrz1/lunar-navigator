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
