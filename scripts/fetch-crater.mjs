// Radiation at the lunar surface from LRO CRaTER (Cosmic Ray Telescope for the Effects of
// Radiation). The CRaTER team publishes hourly dose rates for each detector pair, already
// converted from silicon to water and corrected from LRO's altitude to the lunar surface:
//   https://crater-web.sr.unh.edu/data/craterProducts/doserates/
// Two products: absorbed dose (cGy/day, in water) and dose equivalent (cSv/day, weighted by
// how much harm each kind of particle does, which is what crew limits use). We keep D1&2,
// the pair behind the least shielding, as the closest to a crew member on the surface.
//
// Downloads the 31-day "standard" and "equivalent" files from late 2009 to now into
// data-raw/crater/ and writes public/data/radiation.json with one row per day: the daily
// median, which follows the cosmic-ray background, and the daily maximum, which shows solar
// storms, for both products (mGy/day and mSv/day).
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

// The newest file is named after whatever day the team last processed, so look back from
// today for it. It is fetched fresh every run, as it grows until its 31 days are complete.
async function newest() {
  const y = now.getUTCFullYear();
  const today = Math.floor((now - Date.UTC(y, 0, 0)) / 86400e3);
  for (let doy = today; doy > today - 90 && doy > 0; doy--) {
    const tag = `${y}${String(doy).padStart(3, '0')}`;
    const res = await fetch(`${BASE}/${tag}/doserates_standard_${tag}_31days_allevents.txt`, { method: 'HEAD' });
    if (res.ok) return [y, doy];
  }
  return null;
}
const last = await newest();
if (last) {
  for (const kind of ['standard', 'equivalent']) {
    fs.rmSync(path.join(RAW, `doserates_${kind}_${last[0]}${String(last[1]).padStart(3, '0')}.txt`), { force: true });
  }
  wanted.push(last);
}

async function get([y, doy], kind) {
  const tag = `${y}${String(doy).padStart(3, '0')}`;
  const file = path.join(RAW, `doserates_${kind}_${tag}.txt`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const res = await fetch(`${BASE}/${tag}/doserates_${kind}_${tag}_31days_allevents.txt`);
  if (!res.ok) return null;
  const text = await res.text();
  fs.writeFileSync(file, text);
  return text;
}

// julian date -> D1&2 rate (cGy/day or cSv/day)
async function readAll(kind) {
  const hours = new Map();
  let files = 0;
  for (const w of wanted) {
    const text = await get(w, kind);
    if (!text) continue;
    files++;
    for (const line of text.split('\n')) {
      if (!line || line[0] === '#') continue;
      const p = line.split('\t');
      const jd = Number(p[0]), d12 = Number(p[7]);
      if (Number.isFinite(jd) && d12 > 0) hours.set(jd.toFixed(4), d12);
    }
  }
  return { hours, files };
}

// one median and one maximum per UTC day; x10 turns cGy into mGy and cSv into mSv
function daily(hours) {
  const byDay = new Map();
  for (const [jd, v] of hours) {
    const day = new Date((Number(jd) - 2440587.5) * 86400e3).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(v * 10);
  }
  const out = new Map();
  for (const [day, v] of byDay) {
    v.sort((a, b) => a - b);
    out.set(day, [+v[Math.floor(v.length / 2)].toFixed(4), +v.at(-1).toFixed(3), v.length]);
  }
  return out;
}

const absorbed = await readAll('standard');
const equivalent = await readAll('equivalent');
const gy = daily(absorbed.hours), sv = daily(equivalent.hours);
const days = [...gy.keys()].sort().map(day => {
  const [med, max, n] = gy.get(day);
  const e = sv.get(day);
  return [day, med, max, n, e ? e[0] : null, e ? e[1] : null];
});

fs.writeFileSync(path.join(ROOT, 'public/data/radiation.json'), JSON.stringify({
  source: 'LRO CRaTER dose rates (standard and equivalent products), University of New Hampshire / NASA: https://crater-web.sr.unh.edu/doserates.html (files: https://crater-web.sr.unh.edu/data/craterProducts/doserates/data/YYYYDDD/doserates_standard_YYYYDDD_31days_allevents.txt)',
  quantity: 'detector pair D1&2 at the lunar surface: absorbed dose in water (mGy/day) and dose equivalent (mSv/day)',
  note: 'Files give cGy/day and cSv/day with the silicon-to-water factor (1.333), the altitude correction to the surface and the good-event factor already applied.',
  columns: ['dateUtc', 'medianMGyPerDay', 'maxMGyPerDay', 'hours', 'medianMSvPerDay', 'maxMSvPerDay'],
  days,
}) + '\n');
console.log(`absorbed: ${absorbed.files} files, ${absorbed.hours.size} hours; equivalent: ${equivalent.files} files, ${equivalent.hours.size} hours`);
console.log(`${days.length} days: ${days[0][0]} to ${days.at(-1)[0]}`);
