// Check our terrain horizons against NASA's published LOLA illumination maps
// (Mazarico et al. 2011, products updated 2016-08, https://pgda.gsfc.nasa.gov/products/69).
//
// Their maps give, for every 120 m pixel, the share of hourly timesteps over an 18.6-year
// lunar nutation cycle in which any part of the Sun's disc (AVGVISIB) or Earth's disc
// (AVGVISIB_EARTH) is above the terrain, for an observer on the surface, computed from
// LDEM_75S_120M.
//
// We rebuild the same number with our own code at every region:
//   like-for-like: horizon from LDEM_75S_120M only, observer at ground level
//   app setting:   the app's horizon (5 m tile + 80 m + 240 m, observer 2 m)
// using an 18.6-year, 6-hourly Horizons table (fetch-ephemeris.mjs ... data-raw/ephemeris-18y).
//
// Writes public/data/illumination_check.json.
// usage: node scripts/validate-illumination.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ephemeris, siteFrame, sunEarthAt } from '../src/core/ephemeris.js';
import { computeHorizon, fromStereo, gridSampler, horizonAt, toStereo } from '../src/core/horizon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data-raw');
const AU_KM = 149597870.7;
const SUN_R_KM = 695700;
const EARTH_R_KM = 6378.137;

function readTyped(file, Type) {
  const b = fs.readFileSync(file);
  return new Type(b.buffer, b.byteOffset, b.byteLength / Type.BYTES_PER_ELEMENT);
}

// All three grids share the LDEM_75S_120M layout: 7624 x 7624, 120 m, offset 3811.5 px.
const N = 7624, CELL = 0.12, OFF = 3811.5;
const dem120 = gridSampler({
  data: readTyped(path.join(RAW, 'ldem_75s_120m.img'), Int16Array),
  cols: N, rows: N, cellKm: CELL, xc0: -OFF * CELL, yc0: OFF * CELL, scale: 0.5,
});
const sunMap = readTyped(path.join(RAW, 'AVGVISIB_75S_120M_201608.IMG'), Int16Array);
const earthMap = readTyped(path.join(RAW, 'AVGVISIB_75S_120M_201608_EARTH.IMG'), Int16Array);
const MAP_SCALE = 0.00004; // from the labels: DN 25000 = 1

// Their value at the pixel containing (lat, lon), plus the spread over the 3 x 3
// neighbourhood (one pixel either way, about 120 m) to show how fast it changes there.
function mapValue(map, lat, lon) {
  const [x, y] = toStereo(lat, lon);
  const j = Math.round(x / CELL + OFF), i = Math.round(OFF - y / CELL);
  const near = [];
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) near.push(map[(i + di) * N + j + dj] * MAP_SCALE);
  return { value: map[i * N + j] * MAP_SCALE, min: Math.min(...near), max: Math.max(...near) };
}

const meta = JSON.parse(fs.readFileSync(path.join(RAW, 'ephemeris-18y.json'), 'utf8'));
const eph = new Ephemeris(meta, readTyped(path.join(RAW, 'ephemeris-18y.bin'), Float32Array));
const times = Array.from({ length: meta.rows }, (_, k) => eph.start + k * eph.stepMs);

function visibility(hz, frame) {
  let sun = 0, earth = 0;
  for (const t of times) {
    const s = sunEarthAt(eph, t, frame);
    if (s.sun.el - horizonAt(hz, s.sun.az) > -Math.asin(SUN_R_KM / s.sun.km) * 180 / Math.PI) sun++;
    if (s.earth.el - horizonAt(hz, s.earth.az) > -Math.asin(EARTH_R_KM / s.earth.km) * 180 / Math.PI) earth++;
  }
  return { sun: sun / times.length, earth: earth / times.length };
}

// Centre of the NASA pixel that contains (lat, lon), and that pixel's own height. Their
// value applies to the pixel centre, so on a steep ridge this matters a lot.
const demRaw = readTyped(path.join(RAW, 'ldem_75s_120m.img'), Int16Array);
function pixelCentre(lat, lon) {
  const [x, y] = toStereo(lat, lon);
  const j = Math.round(x / CELL + OFF), i = Math.round(OFF - y / CELL);
  const [plat, plon] = fromStereo((j - OFF) * CELL, (OFF - i) * CELL);
  return { lat: plat, lon: plon, groundM: demRaw[i * N + j] * 0.5 };
}

function compareAt(lat, lon) {
  const p = pixelCentre(lat, lon);
  const hz = computeHorizon(dem120, p.lat, p.lon, { observerM: 0, groundM: p.groundM });
  const v = visibility(hz, siteFrame(p.lat, p.lon, p.groundM));
  return { ...p, ours: v, nasaSun: mapValue(sunMap, p.lat, p.lon), nasaEarth: mapValue(earthMap, p.lat, p.lon) };
}

// Random pixels between 84 and 89.8 deg S, fixed seed so runs repeat.
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const randomPoints = Array.from({ length: Number(process.env.N_RANDOM ?? 200) }, () =>
  [-89.8 + rand() * 5.8, -180 + rand() * 360]);

const regions = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/regions.json'), 'utf8')).regions;
const rows = [];
console.log(`${meta.rows} timesteps, ${meta.start.slice(0, 10)} + 18.6 years\n`);
console.log('region                      Sun: NASA map (3x3 range)   ours   app  |  Earth: NASA map (3x3 range)   ours   app');
for (const r of regions.filter(r => r.lat !== null)) {
  const { ours: like, nasaSun, nasaEarth } = compareAt(r.lat, r.lon);
  const hzApp = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/horizons', `${r.id}.json`), 'utf8'));
  const app = visibility(hzApp, siteFrame(r.lat, r.lon, hzApp.groundM + hzApp.observerM));
  rows.push({ id: r.id, nasaSun, nasaEarth, ours: like, app });
  const pc = v => (v * 100).toFixed(1).padStart(5);
  console.log(`${r.id.padEnd(27)} ${pc(nasaSun.value)} (${pc(nasaSun.min)}-${pc(nasaSun.max)})  ${pc(like.sun)} ${pc(app.sun)}  |  ` +
    `${pc(nasaEarth.value)} (${pc(nasaEarth.min)}-${pc(nasaEarth.max)})  ${pc(like.earth)} ${pc(app.earth)}`);
}

process.stdout.write(`\nrandom points: `);
const random = randomPoints.map(([lat, lon], k) => {
  if (k % 20 === 0) process.stdout.write('.');
  return compareAt(lat, lon);
});
console.log();

// Pearson correlation between our shares and NASA's
function correlation(xs, ys) {
  const mx = xs.reduce((p, q) => p + q, 0) / xs.length, my = ys.reduce((p, q) => p + q, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; });
  return sxy / Math.sqrt(sxx * syy);
}

const stats = (set, k, m) => {
  const d = set.map(x => (x.ours[k] - x[m].value) * 100);
  const a = d.map(Math.abs).sort((p, q) => p - q);
  // "inside the neighbourhood" = our value lies within NASA's own 3 x 3 pixel range
  const inside = set.filter(x => x.ours[k] >= x[m].min - 0.005 && x.ours[k] <= x[m].max + 0.005).length;
  return {
    n: d.length,
    meanPts: +(d.reduce((p, q) => p + q, 0) / d.length).toFixed(2),
    meanAbsPts: +(a.reduce((p, q) => p + q, 0) / a.length).toFixed(2),
    medianAbsPts: +a[Math.floor(a.length / 2)].toFixed(2),
    p90AbsPts: +a[Math.floor(0.9 * (a.length - 1))].toFixed(2),
    maxAbsPts: +a.at(-1).toFixed(2),
    withinNeighbourhood: +(inside / set.length).toFixed(3),
    r: +correlation(set.map(x => x.ours[k]), set.map(x => x[m].value)).toFixed(4),
  };
};
const summary = {
  regions: { sun: stats(rows, 'sun', 'nasaSun'), earth: stats(rows, 'earth', 'nasaEarth') },
  random: { sun: stats(random, 'sun', 'nasaSun'), earth: stats(random, 'earth', 'nasaEarth') },
};
for (const [set, s] of Object.entries(summary)) {
  for (const k of ['sun', 'earth']) {
    const x = s[k];
    console.log(`${set.padEnd(8)} ${k.padEnd(6)} n=${x.n}  ours-NASA mean ${x.meanPts} pts, mean |d| ${x.meanAbsPts}, median |d| ${x.medianAbsPts}, r ${x.r}, ` +
      `90% within ${x.p90AbsPts}, max ${x.maxAbsPts}; inside NASA's 3x3 range: ${(x.withinNeighbourhood * 100).toFixed(0)}%`);
  }
}

fs.writeFileSync(path.join(ROOT, 'public/data/illumination_check.json'), JSON.stringify({
  about: 'Share of time the Sun / Earth is visible (any part of the disc), ours vs NASA LOLA illumination maps (Mazarico et al. 2011, 2016-08 products)',
  nasa: 'https://pgda.gsfc.nasa.gov/products/69',
  period: { start: meta.start, rows: meta.rows, stepHours: meta.stepHours },
  ours: 'horizon from LDEM_75S_120M, observer at ground level (same inputs as the NASA maps)',
  app: 'app horizon: 5 m tile + LDEM_80S_80M + LDEM_75S_240M, observer 2 m',
  summary, regions: rows, random,
}, null, 1) + '\n');
