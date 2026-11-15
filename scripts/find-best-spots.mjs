// Find the best landing spots inside each region, not just its centre.
//
// NASA's landing requirements (Artemis HLS update, NTRS 20240009596, slide 19) give the screen:
//   slope under 10 deg over the 100 m landing area, slope under 20 deg for EVA within 2 km,
//   direct line of sight to Earth, and sunlight. Slides 23-24 also drop places with
//   Earth visible under 25 % or the Sun under 5 % of the time.
//
// 1. Screen: every 100 m across the region box, fit a plane to the terrain over 100 m to get
//    the landing slope, and look up NASA's long-term Sun and Earth visibility maps
//    (Mazarico et al. 2011, 120 m). Keep the 40 best points that pass, at least 500 m apart.
// 2. Refine: for those points build the app's own horizon (5 m tile + 80 m + 240 m, 2 m mast)
//    and run it hour by hour over the app's ephemeris (Nov 2026 - Dec 2035).
// 3. Rank by the share of hours with the Sun on the panels and Earth in view at once.
//
// Writes public/data/best_spots.json and public/data/horizons/<region>--best.json.
// usage: node scripts/find-best-spots.mjs [region ...]

import fs from 'node:fs';
import path from 'node:path';
import { Ephemeris, siteFrame } from '../src/core/ephemeris.js';
import { computeHorizon, fromStereo, layered, toStereo } from '../src/core/horizon.js';
import { hourlyFlags, summary } from '../src/core/analysis.js';
import { RAW, ROOT, ldem80, ldem240, readJson, readTyped, tileIndex, tileSampler } from './rasters.mjs';

const GRID_KM = 0.1;          // screening step
const KEEP = 40;              // candidates per region that get a full horizon
const MIN_APART_KM = 0.5;
const LANDING_SLOPE = 10;     // deg, over 100 m
const EVA_SLOPE = 20;         // deg, within 2 km
const EVA_RADIUS_KM = 1;
const EVA_SHARE = 0.9;        // share of the 1 km circle that must be walkable
const DEFAULT_BOX_KM = 15;    // for regions without a NASA box size

const ldem = ldem80();
const ldem75 = ldem240();

// NASA LOLA average visibility maps: 7624 x 7624, 120 m, DN 25000 = 100 %
const N = 7624, CELL = 0.12, OFF = 3811.5;
const sunMap = readTyped(path.join(RAW, 'AVGVISIB_75S_120M_201608.IMG'), Int16Array);
const earthMap = readTyped(path.join(RAW, 'AVGVISIB_75S_120M_201608_EARTH.IMG'), Int16Array);
const mapAt = (map, x, y) => map[Math.round(OFF - y / CELL) * N + Math.round(x / CELL + OFF)] * 0.00004;

const meta = readJson('public/data/ephemeris.json');
const eph = new Ephemeris(meta, readTyped(path.join(ROOT, 'public/data/ephemeris.bin'), Float32Array));

// Slope of the best-fit plane over a 100 m square (5 x 5 samples, 25 m apart), in degrees.
const OFFS = [-0.05, -0.025, 0, 0.025, 0.05];
const SUM_SQ = 5 * OFFS.reduce((a, d) => a + d * d, 0) * 1000; // km * m, so gradients come out in m/m
function slope100(sample, x, y) {
  let gx = 0, gy = 0;
  for (const dy of OFFS) for (const dx of OFFS) {
    const h = sample(x + dx, y + dy);
    if (!(h === h)) return NaN;
    gx += dx * h; gy += dy * h;
  }
  return Math.atan(Math.hypot(gx, gy) / SUM_SQ) * 180 / Math.PI;
}

const score = (hz, frame) => summary(hourlyFlags(eph, frame, hz), meta.stepHours);

function horizonDoc(id, lat, lon, hz, dem) {
  return {
    id, lat: +lat.toFixed(5), lon: +lon.toFixed(5),
    groundM: +hz.groundM.toFixed(1), observerM: hz.observerM, azStep: hz.azStep,
    el: [...hz.el].map(v => +v.toFixed(4)), dem,
  };
}

function searchRegion(r) {
  const tile = tileSampler(r.id);
  const fine = tile ?? ldem;
  const sample = tile ? layered(tile, ldem, ldem75) : layered(ldem, ldem75);
  const dem = tile ? ['LOLA 5 m tile', 'LDEM_80S_80M', 'LDEM_75S_240M'] : ['LDEM_80S_80M', 'LDEM_75S_240M'];

  // search box: NASA's region size around the centre, kept inside the 5 m tile
  const [cx, cy] = toStereo(r.lat, r.lon);
  const [w, h] = r.size_km ?? [DEFAULT_BOX_KM, DEFAULT_BOX_KM];
  let x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  const t = tileIndex[r.id];
  if (t) {
    const m = 0.1; // room for the slope window
    x0 = Math.max(x0, t.x0 + m); x1 = Math.min(x1, t.x1 - m);
    y0 = Math.max(y0, t.y0 + m); y1 = Math.min(y1, t.y1 - m);
  }

  // 1. screen
  const cols = Math.floor((x1 - x0) / GRID_KM) + 1, rows = Math.floor((y1 - y0) / GRID_KM) + 1;
  const slopes = new Float32Array(cols * rows);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    slopes[i * cols + j] = slope100(fine, x0 + j * GRID_KM, y0 + i * GRID_KM);
  }
  const reach = Math.round(EVA_RADIUS_KM / GRID_KM);
  const walkable = (i, j) => {
    let ok = 0, all = 0;
    for (let di = -reach; di <= reach; di++) for (let dj = -reach; dj <= reach; dj++) {
      if (di * di + dj * dj > reach * reach) continue;
      const s = slopes[(i + di) * cols + j + dj];
      if (i + di < 0 || i + di >= rows || j + dj < 0 || j + dj >= cols || !(s === s)) continue;
      all++; if (s < EVA_SLOPE) ok++;
    }
    return all ? ok / all : 0;
  };

  const pass = [];
  let tested = 0;
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const s = slopes[i * cols + j];
    if (!(s < LANDING_SLOPE)) continue;
    tested++;
    const x = x0 + j * GRID_KM, y = y0 + i * GRID_KM;
    const nasaSun = mapAt(sunMap, x, y), nasaEarth = mapAt(earthMap, x, y);
    if (nasaSun < 0.05 || nasaEarth < 0.25) continue;
    pass.push({ x, y, i, j, slope: s, nasaSun, nasaEarth });
  }
  pass.sort((a, b) => (b.nasaSun + b.nasaEarth) - (a.nasaSun + a.nasaEarth));

  const picked = [];
  for (const p of pass) {
    if (picked.length === KEEP) break;
    if (picked.some(q => Math.hypot(q.x - p.x, q.y - p.y) < MIN_APART_KM)) continue;
    p.walkable = walkable(p.i, p.j);
    if (p.walkable < EVA_SHARE) continue;
    picked.push(p);
  }

  // 2. refine with the app's own horizon
  const spots = picked.map(p => {
    const [lat, lon] = fromStereo(p.x, p.y);
    const hz = computeHorizon(sample, lat, lon);
    return {
      lat: +lat.toFixed(5), lon: +lon.toFixed(5), groundM: +hz.groundM.toFixed(1),
      fromCentreKm: +Math.hypot(p.x - cx, p.y - cy).toFixed(2),
      slope100Deg: +p.slope.toFixed(1), walkable2km: +p.walkable.toFixed(2),
      nasaSunPct: +(p.nasaSun * 100).toFixed(1), nasaEarthPct: +(p.nasaEarth * 100).toFixed(1),
      ...score(hz, siteFrame(lat, lon, hz.groundM + hz.observerM)),
      hz,
    };
  });

  // 3. rank: Sun and Earth together, then the shorter worst night
  spots.sort((a, b) => b.bothPct - a.bothPct || a.longestDarkH - b.longestDarkH);

  const centreHz = readJson(`public/data/horizons/${r.id}.json`);
  const centre = {
    lat: r.lat, lon: r.lon, groundM: centreHz.groundM,
    slope100Deg: +slope100(fine, cx, cy).toFixed(1),
    ...score(centreHz, siteFrame(r.lat, r.lon, centreHz.groundM + centreHz.observerM)),
  };

  if (spots[0]) {
    const b = spots[0];
    fs.writeFileSync(path.join(ROOT, 'public/data/horizons', `${r.id}--best.json`),
      JSON.stringify(horizonDoc(`${r.id}--best`, b.lat, b.lon, b.hz, dem)) + '\n');
  }
  return {
    id: r.id, name: r.name, slopeFrom: tile ? 'LOLA 5 m tile' : 'LDEM_80S_80M',
    box: { widthKm: +(x1 - x0).toFixed(1), heightKm: +(y1 - y0).toFixed(1) },
    screened: { points: cols * rows, flatEnough: tested, passNasaMaps: pass.length, refined: spots.length },
    centre,
    best: spots.slice(0, 5).map(({ hz, ...s }) => s),
  };
}

const only = process.argv.slice(2);
const regions = readJson('public/data/regions.json').regions
  .filter(r => r.lat !== null && (!only.length || only.includes(r.id)));

const out = [];
for (const r of regions) {
  const t0 = Date.now();
  const res = searchRegion(r);
  out.push(res);
  const b = res.best[0], c = res.centre;
  const line = s => `Sun ${String(s.sunPct).padStart(5)}%  Earth ${String(s.earthPct).padStart(5)}%  both ${String(s.bothPct).padStart(5)}%  worst night ${String(Math.round(s.longestDarkH / 24)).padStart(3)} d`;
  console.log(`${r.id.padEnd(27)} centre: ${line(c)}`);
  console.log(`${''.padEnd(27)} ${b ? `best:   ${line(b)}  (${b.fromCentreKm} km out, slope ${b.slope100Deg} deg)` : 'no spot passes the screen'}` +
    `  [${res.screened.flatEnough}/${res.screened.points} flat, ${res.screened.passNasaMaps} pass maps, ${((Date.now() - t0) / 1000).toFixed(0)} s]`);
}

// Merge with an earlier run, so a single region can be redone on its own.
const file = path.join(ROOT, 'public/data/best_spots.json');
const previous = only.length && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).regions : [];
const merged = [...previous.filter(p => !out.some(o => o.id === p.id)), ...out];
fs.writeFileSync(file, JSON.stringify({
  about: 'Best landing spots inside each region: passes NASA landing and EVA slope limits and the Sun / Earth visibility floors, then ranked by hours with both Sun and Earth in view',
  requirements: 'NASA Artemis HLS update 2024 (NTRS 20240009596), slides 19 and 23-24',
  screen: { gridKm: GRID_KM, landingSlopeDeg: LANDING_SLOPE, evaSlopeDeg: EVA_SLOPE, evaRadiusKm: EVA_RADIUS_KM, evaShare: EVA_SHARE, nasaSunMin: 0.05, nasaEarthMin: 0.25, keep: KEEP, minApartKm: MIN_APART_KM },
  nasaMaps: 'LOLA AVGVISIB 2016-08, https://pgda.gsfc.nasa.gov/products/69',
  period: { start: meta.start, rows: meta.rows, stepHours: meta.stepHours },
  observerM: 2,
  regions: merged,
}, null, 1) + '\n');
