// Check src/core/ephemeris.js against JPL Horizons topocentric output.
//
//  1. The team's Horizons exports in DATA/*.txt (12 h steps, Nov 2026 - Dec 2027).
//     Site and body are read from each file's header, not from the file name, because
//     some file names are wrong (see the "file notes" printed at the end).
//  2. Fresh Horizons queries at each region in public/data/regions.json, at random
//     times between table rows, so the interpolation is tested too.
//
// Writes public/data/validation.json.
// usage: node scripts/validate-horizons.mjs [--offline]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ephemeris, siteFrame, sunEarthAt } from '../src/core/ephemeris.js';
import { horizons, tableHeader, tableRows, parseHorizonsTime } from './horizons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEAM_DIR = path.join(ROOT, 'DATA');
const offline = process.argv.includes('--offline');
const DEG = Math.PI / 180;

const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/ephemeris.json'), 'utf8'));
const bin = fs.readFileSync(path.join(ROOT, 'public/data/ephemeris.bin'));
const eph = new Ephemeris(meta, new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4));

// Angle between two az/el directions, in degrees.
function separation(a, b) {
  const v = p => [Math.cos(p.el * DEG) * Math.cos(p.az * DEG), Math.cos(p.el * DEG) * Math.sin(p.az * DEG), Math.sin(p.el * DEG)];
  const x = v(a), y = v(b);
  return Math.acos(Math.min(1, x[0] * y[0] + x[1] * y[1] + x[2] * y[2])) / DEG;
}

function summarise(diffs) {
  const sorted = [...diffs].sort((a, b) => a - b);
  return {
    n: diffs.length,
    maxDeg: +sorted.at(-1).toFixed(6),
    meanDeg: +(diffs.reduce((s, d) => s + d, 0) / diffs.length).toFixed(6),
    p95Deg: +sorted[Math.floor(0.95 * (sorted.length - 1))].toFixed(6),
  };
}

function compareTable(text, body, frame) {
  const head = tableHeader(text);
  const iAz = head.findIndex(h => /^Azi(muth)?_/.test(h));
  const iEl = head.findIndex(h => /^Elev(ation)?_/.test(h));
  const diffs = [];
  for (const r of tableRows(text)) {
    const t = parseHorizonsTime(r[0]);
    if (!eph.covers(t)) continue;
    diffs.push(separation({ az: +r[iAz], el: +r[iEl] }, sunEarthAt(eph, t, frame)[body]));
  }
  return diffs;
}

// 1. Team files -------------------------------------------------------------------------
const team = [];
const notes = [];
for (const file of fs.readdirSync(TEAM_DIR).filter(f => f.endsWith('.txt')).sort()) {
  const text = fs.readFileSync(path.join(TEAM_DIR, file), 'utf8');
  const target = text.match(/Target body name: (\w+)/)[1];
  const body = target === 'Sun' ? 'sun' : 'earth';
  const g = text.match(/Center geodetic : ([\d.\-]+), ([\d.\-]+), ([\d.\-]+)/);
  const lon = +g[1] > 180 ? +g[1] - 360 : +g[1];
  const lat = +g[2], altKm = +g[3];
  const nameSays = /,\s*(s|sun)\b/i.test(file) ? 'sun' : /,\s*(e|earth)\b/i.test(file) ? 'earth' : '?';
  if (nameSays !== body) notes.push(`${file}: file name says ${nameSays}, header says ${target}`);
  const diffs = compareTable(text, body, siteFrame(lat, lon, altKm * 1000));
  team.push({ file, body, lat, lon, altKm, ...summarise(diffs) });
}

// 2. Fresh queries at the corrected region positions ------------------------------------
const live = [];
if (!offline) {
  const regions = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/regions.json'), 'utf8')).regions;
  // fixed seed so the run is repeatable
  let seed = 20261114;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (const r of regions.filter(r => r.lat !== null)) {
    const heightM = (r.height_m?.centre ?? 0) + 2; // lander-height observer, same as the analysis
    const frame = siteFrame(r.lat, r.lon, heightM);
    const times = Array.from({ length: 12 }, () => eph.start + 24 * 3600e3 + rand() * (eph.end - eph.start - 48 * 3600e3));
    const jd = times.map(t => (t / 86400e3 + 2440587.5).toFixed(8)).join(' ');
    for (const [body, command] of [['sun', '10'], ['earth', '399']]) {
      const text = await horizons({
        COMMAND: command, CENTER: 'coord@301', COORD_TYPE: 'GEODETIC',
        SITE_COORD: `${r.lon.toFixed(5)},${r.lat.toFixed(5)},${(heightM / 1000).toFixed(5)}`,
        EPHEM_TYPE: 'OBSERVER', QUANTITIES: '4', ANG_FORMAT: 'DEG', EXTRA_PREC: 'YES',
        CSV_FORMAT: 'YES', TLIST_TYPE: 'JD', TLIST: jd, TIME_DIGITS: 'SECONDS',
      });
      const head = tableHeader(text);
      const iAz = head.findIndex(h => /^Azi(muth)?_/.test(h));
      const iEl = head.findIndex(h => /^Elev(ation)?_/.test(h));
      const diffs = tableRows(text).map(row =>
        separation({ az: +row[iAz], el: +row[iEl] }, sunEarthAt(eph, parseHorizonsTime(row[0]), frame)[body]));
      live.push({ region: r.id, body, lat: r.lat, lon: r.lon, heightM, ...summarise(diffs) });
      process.stdout.write('.');
    }
  }
  console.log();
}

// Report ---------------------------------------------------------------------------------
const all = [...team, ...live];
const worst = Math.max(...all.map(x => x.maxDeg));
console.log('\nsource      site / file               body     n    max (deg)   mean (deg)');
for (const x of team) console.log(`team file   ${x.file.padEnd(25)} ${x.body.padEnd(6)} ${String(x.n).padStart(4)}  ${x.maxDeg.toFixed(5).padStart(10)}  ${x.meanDeg.toFixed(5).padStart(10)}`);
for (const x of live) console.log(`live query  ${x.region.padEnd(25)} ${x.body.padEnd(6)} ${String(x.n).padStart(4)}  ${x.maxDeg.toFixed(5).padStart(10)}  ${x.meanDeg.toFixed(5).padStart(10)}`);
console.log(`\nworst difference: ${worst.toFixed(5)} deg = ${(worst * 3600).toFixed(2)} arcsec (Sun's disc is about 0.53 deg)`);
if (notes.length) console.log('\nfile notes:\n  ' + notes.join('\n  '));

fs.writeFileSync(path.join(ROOT, 'public/data/validation.json'), JSON.stringify({
  checked: new Date().toISOString(),
  ephemeris: { start: meta.start, rows: meta.rows, fetched: meta.fetched },
  worstDeg: +worst.toFixed(6),
  team, live, fileNotes: notes,
}, null, 1) + '\n');
