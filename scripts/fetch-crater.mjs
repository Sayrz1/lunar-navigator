// Radiation at the lunar surface from LRO CRaTER (Cosmic Ray Telescope for the Effects of
// Radiation). The CRaTER team publishes hourly dose rates for each detector pair, already
// converted from silicon to water and corrected from LRO's altitude to the lunar surface:
//   https://crater-web.sr.unh.edu/data/craterProducts/doserates/
// Units in the files: cGy/day (absorbed dose in water). We keep D1&2, the pair behind the
// least shielding, as the closest to a crew member on the surface.
//
// Downloads the 31-day "standard" files from late 2009 to now into data-raw/crater/ and
// writes public/data/radiation.json with one value per day (mGy/day): the daily median,
// which follows the cosmic-ray background, and the daily maximum, which shows solar storms.
//
// usage: node scripts/fetch-crater.mjs

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './rasters.mjs';

const BASE = 'https://crater-web.sr.unh.edu/data/craterProducts/doserates/data';
const RAW = path.join(ROOT, 'data-raw', 'crater');
fs.mkdirSync(RAW, { recursive: true });

// 31-day files are named by their last day of year; one every 30 days covers the year
const now = new Date();
const wanted = [];
for (let y = 2009; y <= now.getUTCFullYear(); y++) {
  for (let doy = 31; doy <= 366; doy += 30) wanted.push([y, doy]);
  wanted.push([y, y % 4 ? 365 : 366]);
}

async function get([y, doy]) {
  const tag = `${y}${String(doy).padStart(3, '0')}`;
  const file = path.join(RAW, `doserates_standard_${tag}.txt`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const res = await fetch(`${BASE}/${tag}/doserates_standard_${tag}_31days_allevents.txt`);
  if (!res.ok) return null;
  const text = await res.text();
  fs.writeFileSync(file, text);
  return text;
}

const hours = new Map(); // julian date -> D1&2 cGy/day
let files = 0;
for (const w of wanted) {
  const text = await get(w);
  if (!text) continue;
  files++;
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const p = line.split('\t');
    const jd = Number(p[0]), d12 = Number(p[7]);
    if (Number.isFinite(jd) && d12 > 0) hours.set(jd.toFixed(4), d12);
  }
}

// one value per UTC day
const byDay = new Map();
for (const [jd, v] of hours) {
  const day = new Date((Number(jd) - 2440587.5) * 86400e3).toISOString().slice(0, 10);
  if (!byDay.has(day)) byDay.set(day, []);
  byDay.get(day).push(v * 10); // cGy -> mGy
}
const days = [...byDay.keys()].sort().map(day => {
  const v = byDay.get(day).sort((a, b) => a - b);
  return [day, +v[Math.floor(v.length / 2)].toFixed(4), +v.at(-1).toFixed(3), v.length];
});

fs.writeFileSync(path.join(ROOT, 'public/data/radiation.json'), JSON.stringify({
  source: 'LRO CRaTER dose rates (standard product), University of New Hampshire / NASA: https://crater-web.sr.unh.edu/data/craterProducts/doserates/',
  quantity: 'absorbed dose in water at the lunar surface, detector pair D1&2, mGy/day',
  note: 'Files give cGy/day with the silicon-to-water factor (1.333) and the altitude correction to the surface already applied.',
  columns: ['dateUtc', 'medianMGyPerDay', 'maxMGyPerDay', 'hours'],
  days,
}) + '\n');
console.log(`${files} files, ${hours.size} hours, ${days.length} days: ${days[0][0]} to ${days.at(-1)[0]}`);
