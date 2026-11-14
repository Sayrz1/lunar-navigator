// Landing scatter: a lander aims at a spot but touches down somewhere near it. For each
// region's centre and best spot, rebuild the full horizon on a 9 x 9 grid, 25 m apart
// (100 m either way), and see how much the Sun / Earth numbers and the slope change.
//
// Same horizon model as the rest of the app (5 m tile + 80 m + 240 m, 2 m mast, 720 rays)
// and the same ephemeris, so the grid can be compared directly with the spot itself.
//
// Writes public/data/scatter.json.
// usage: node scripts/landing-scatter.mjs [region ...]

import fs from 'node:fs';
import path from 'node:path';
import { Ephemeris, siteFrame } from '../src/core/ephemeris.js';
import { computeHorizon, fromStereo, layered, toStereo } from '../src/core/horizon.js';
import { hourlyFlags, summary } from '../src/core/analysis.js';
import { ROOT, ldem80, ldem240, readJson, readTyped, tileSampler } from './rasters.mjs';

const STEP_KM = 0.025;
const HALF = 4; // 9 x 9 grid

const ldem = ldem80();
const ldem75 = ldem240();
const meta = readJson('public/data/ephemeris.json');
const eph = new Ephemeris(meta, readTyped(path.join(ROOT, 'public/data/ephemeris.bin'), Float32Array));

// Best-fit plane slope over 100 m, as in find-best-spots.mjs.
const OFFS = [-0.05, -0.025, 0, 0.025, 0.05];
const SUM_SQ = 5 * OFFS.reduce((a, d) => a + d * d, 0) * 1000;
function slope100(sample, x, y) {
  let gx = 0, gy = 0;
  for (const dy of OFFS) for (const dx of OFFS) {
    const h = sample(x + dx, y + dy);
    if (!(h === h)) return NaN;
    gx += dx * h; gy += dy * h;
  }
  return Math.atan(Math.hypot(gx, gy) / SUM_SQ) * 180 / Math.PI;
}

function grid(sample, fine, lat, lon) {
  const [cx, cy] = toStereo(lat, lon);
  const cells = { sun: [], earth: [], both: [], dark: [], slope: [] };
  // rows run north to south in map y, columns west to east in map x
  for (let i = HALF; i >= -HALF; i--) for (let j = -HALF; j <= HALF; j++) {
    const x = cx + j * STEP_KM, y = cy + i * STEP_KM;
    const [la, lo] = fromStereo(x, y);
    const hz = computeHorizon(sample, la, lo);
    const s = summary(hourlyFlags(eph, siteFrame(la, lo, hz.groundM + hz.observerM), hz), meta.stepHours);
    cells.sun.push(s.sunPct);
    cells.earth.push(s.earthPct);
    cells.both.push(s.bothPct);
    cells.dark.push(Math.round(s.longestDarkH));
    cells.slope.push(+slope100(fine, x, y).toFixed(1));
  }
  // spread over the points within 100 m of the aim point
  const near = [];
  for (let k = 0; k < cells.both.length; k++) {
    const i = Math.floor(k / (2 * HALF + 1)) - HALF, j = (k % (2 * HALF + 1)) - HALF;
    if (Math.hypot(i, j) * STEP_KM <= 0.1 + 1e-9) near.push(k);
  }
  const range = key => {
    const v = near.map(k => cells[key][k]);
    return [Math.min(...v), Math.max(...v)];
  };
  return {
    lat, lon, cells,
    within100m: {
      points: near.length,
      sun: range('sun'), earth: range('earth'), both: range('both'), dark: range('dark'),
      tooSteep: near.filter(k => !(cells.slope[k] < 10)).length,
    },
  };
}

const only = process.argv.slice(2);
const best = readJson('public/data/best_spots.json').regions;
const regions = readJson('public/data/regions.json').regions
  .filter(r => r.lat !== null && (!only.length || only.includes(r.id)));

const file = path.join(ROOT, 'public/data/scatter.json');
const out = only.length && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).regions : {};
for (const r of regions) {
  const t0 = Date.now();
  const tile = tileSampler(r.id);
  const sample = tile ? layered(tile, ldem, ldem75) : layered(ldem, ldem75);
  const fine = tile ?? ldem;
  const b = best.find(x => x.id === r.id);
  out[r.id] = {
    centre: grid(sample, fine, r.lat, r.lon),
    best: b?.best[0] ? grid(sample, fine, b.best[0].lat, b.best[0].lon) : null,
  };
  const w = s => s ? `both ${s.within100m.both[0]}-${s.within100m.both[1]}%, ${s.within100m.tooSteep} steep` : '-';
  console.log(`${r.id.padEnd(27)} centre ${w(out[r.id].centre).padEnd(26)} best ${w(out[r.id].best)}  [${((Date.now() - t0) / 1000).toFixed(0)} s]`);
}

fs.writeFileSync(file, JSON.stringify({
  about: 'Sun / Earth visibility and slope on a grid around each centre and best spot, for landing scatter',
  stepM: STEP_KM * 1000, size: 2 * HALF + 1, order: 'rows north to south (map y), columns west to east (map x)',
  period: { start: meta.start, rows: meta.rows, stepHours: meta.stepHours },
  regions: out,
}) + '\n');
